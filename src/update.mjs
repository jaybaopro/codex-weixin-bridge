import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BRIDGE_VERSION } from "./version.mjs";

export const DEFAULT_GITHUB_REPO = "jaybaopro/codex-weixin-bridge";

function run(command, args, { allowFailure = false, cwd } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
  });
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} 失败${detail ? `：${detail}` : ""}`);
  }
  return result;
}

export function normalizeVersion(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`无法识别版本号：${value}`);
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

export function compareVersions(left, right) {
  const a = normalizeVersion(left).split(".").map(Number);
  const b = normalizeVersion(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function parseLatestRelease(payload, currentVersion = BRIDGE_VERSION) {
  const latestVersion = normalizeVersion(payload.tag_name);
  return {
    currentVersion: normalizeVersion(currentVersion),
    latestVersion,
    tag: payload.tag_name,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    url: payload.html_url || null,
    publishedAt: payload.published_at || null,
    prerelease: Boolean(payload.prerelease),
    assets: (payload.assets || []).map((asset) => ({
      name: asset.name,
      size: asset.size,
      downloadUrl: asset.browser_download_url || asset.downloadUrl || null,
    })),
  };
}

function githubHeaders() {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": `codex-weixin-bridge/${BRIDGE_VERSION}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(process.env.GITHUB_TOKEN
      ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {}),
  };
}

export async function checkForUpdate({
  repo = process.env.CODEX_WEIXIN_GITHUB_REPO || DEFAULT_GITHUB_REPO,
  currentVersion = BRIDGE_VERSION,
} = {}) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: githubHeaders(),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `无法查询公开 GitHub Release（HTTP ${response.status}）。请检查网络、仓库可见性和 Release 是否存在。${detail ? `\n${detail}` : ""}`,
    );
  }
  return parseLatestRelease(await response.json(), currentVersion);
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function verifyChecksum(archivePath, checksumPath) {
  const expected = fs.readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(expected)) {
    throw new Error("发布包校验文件无效。");
  }
  const actual = sha256(archivePath);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("发布包 SHA-256 校验失败，已停止升级。");
  }
}

function findSingle(files, predicate, label) {
  const matched = files.filter(predicate);
  if (matched.length !== 1) {
    throw new Error(`Release 中应有且仅有一个${label}，实际找到 ${matched.length} 个。`);
  }
  return matched[0];
}

async function downloadAsset(asset, outputDir) {
  if (!asset?.downloadUrl) throw new Error(`Release 资产缺少下载地址：${asset?.name}`);
  const response = await fetch(asset.downloadUrl, {
    headers: githubHeaders(),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`下载 ${asset.name} 失败（HTTP ${response.status}）。`);
  }
  const target = path.join(outputDir, asset.name);
  fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()), {
    mode: 0o600,
  });
  return target;
}

export async function downloadRelease({
  release,
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-upgrade-")),
} = {}) {
  if (!release?.tag) throw new Error("升级缺少 Release 信息。");
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const archiveAsset = findSingle(
    release.assets || [],
    (asset) => asset.name.endsWith(".tgz"),
    " npm 安装包",
  );
  const checksumAsset = findSingle(
    release.assets || [],
    (asset) => asset.name.endsWith(".tgz.sha256"),
    " SHA-256 校验文件",
  );
  const [archivePath, checksumPath] = await Promise.all([
    downloadAsset(archiveAsset, outputDir),
    downloadAsset(checksumAsset, outputDir),
  ]);
  verifyChecksum(archivePath, checksumPath);
  return { outputDir, archivePath, checksumPath };
}

export function installReleaseArchive(archivePath) {
  const cacheDir = path.join(os.tmpdir(), "codex-weixin-npm-cache");
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  run("npm", ["install", "--global", "--cache", cacheDir, archivePath]);
  return archivePath;
}

function globalCliPath() {
  const prefix = run("npm", ["prefix", "--global"]).stdout.trim();
  return process.platform === "win32"
    ? path.join(prefix, "codex-weixin-bridge.cmd")
    : path.join(prefix, "bin", "codex-weixin-bridge");
}

function packRollback(packageRoot, outputDir) {
  const cacheDir = path.join(outputDir, "npm-cache");
  const result = run("npm", [
    "pack",
    packageRoot,
    "--pack-destination", outputDir,
    "--cache", cacheDir,
    "--silent",
  ]);
  const filename = result.stdout.trim().split(/\r?\n/).at(-1);
  const archivePath = path.join(outputDir, filename);
  if (!filename || !fs.existsSync(archivePath)) {
    throw new Error("无法生成当前版本的回滚包。");
  }
  return archivePath;
}

export async function upgradeToLatest({
  repo = process.env.CODEX_WEIXIN_GITHUB_REPO || DEFAULT_GITHUB_REPO,
  release: providedRelease = null,
  packageRoot,
  beforeInstall = () => {},
  afterInstall = () => {},
} = {}) {
  if (!packageRoot) throw new Error("升级缺少当前安装包路径。");
  const release = providedRelease || await checkForUpdate({ repo });
  if (!release.updateAvailable) {
    return { ...release, upgraded: false, reason: "already-latest" };
  }

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-upgrade-"));
  const rollbackArchive = packRollback(packageRoot, outputDir);
  const releaseDir = path.join(outputDir, "release");
  const downloaded = await downloadRelease({
    release,
    outputDir: releaseDir,
  });
  let stopped = false;
  try {
    beforeInstall();
    stopped = true;
    installReleaseArchive(downloaded.archivePath);
    run(globalCliPath(), ["doctor"]);
    afterInstall();
    return {
      ...release,
      upgraded: true,
      rollbackArchive,
    };
  } catch (error) {
    try {
      installReleaseArchive(rollbackArchive);
      if (stopped) afterInstall();
    } catch (rollbackError) {
      throw new Error(
        `升级失败且自动回滚失败。升级错误：${error.message}；回滚错误：${rollbackError.message}；回滚包：${rollbackArchive}`,
        { cause: error },
      );
    }
    throw new Error(`升级失败，已自动恢复 ${BRIDGE_VERSION}：${error.message}`, {
      cause: error,
    });
  }
}
