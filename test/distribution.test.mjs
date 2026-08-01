import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  renderLaunchAgentPlist,
  renderWindowsRunnerCmd,
  resolveServiceConfig,
} from "../src/service.mjs";
import { buildSafeBackup } from "../src/lifecycle.mjs";
import {
  compareVersions,
  parseLatestRelease,
} from "../src/update.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

test("distribution package exposes a global CLI and direct QR dependency", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.version, "0.7.1");
  assert.equal(pkg.private, true);
  assert.equal(pkg.bin["codex-weixin-bridge"], "./src/cli.mjs");
  assert.equal(pkg.dependencies["qrcode-terminal"], "0.12.0");
  assert.equal(pkg.dependencies["pdf-parse"], "2.4.5");
  assert.equal(pkg.dependencies.cheerio, "1.2.0");
});

test("LaunchAgent rendering uses the installing user's paths", () => {
  const config = resolveServiceConfig({
    homeDir: "/Users/example",
    stateDir: "/Users/example/.codex-weixin-direct",
    cliPath: "/opt/team/codex-weixin-bridge/src/cli.mjs",
    nodePath: "/opt/node/bin/node",
    codexBin: "/Applications/Codex.app/Contents/Resources/codex",
    label: "com.example.codex-weixin",
  });
  const plist = renderLaunchAgentPlist(config);

  assert.match(plist, /com\.example\.codex-weixin/);
  assert.match(plist, /example/);
  assert.match(plist, /codex-weixin-bridge/);
  assert.match(plist, /CODEX_WEIXIN_TURN_IDLE_TIMEOUT_MS/);
  assert.match(plist, />600000</);
  assert.doesNotMatch(plist, /jay\.bao/);
});

test("Windows runner uses a per-user state directory and no developer path", () => {
  const config = resolveServiceConfig({
    platform: "win32",
    homeDir: "/example-home",
    stateDir: "/example-home/.codex-weixin-direct",
    cliPath: "/team/codex-weixin-bridge/src/cli.mjs",
    nodePath: "/runtime/node.exe",
    codexBin: "/runtime/codex.exe",
  });
  const runner = renderWindowsRunnerCmd(config);
  assert.match(runner, /CODEX_WEIXIN_STATE_DIR/);
  assert.match(runner, /CODEX_WEIXIN_BATCH_WINDOW_MS=2500/);
  assert.match(runner, /cli\.mjs" serve/);
  assert.doesNotMatch(runner, /jay\.bao/);
});

test("safe backup excludes credentials and full task ids", () => {
  const backup = buildSafeBackup({
    projects: {
      version: 1,
      projects: [{
        id: "project-7",
        name: "项目 7",
        cwd: path.resolve("/tmp/project-7"),
        enabled: true,
      }],
    },
    binding: {
      projectId: "project-7",
      projectName: "项目 7",
      cwd: path.resolve("/tmp/project-7"),
      threadId: "019-secret-thread-id",
      threadName: "测试任务",
      token: "secret-token",
    },
  });
  const serialized = JSON.stringify(backup);
  assert.equal(backup.includesCredentials, false);
  assert.doesNotMatch(serialized, /019-secret-thread-id/);
  assert.doesNotMatch(serialized, /secret-token/);
  assert.equal(backup.bindingHint.threadName, "测试任务");
});

test("release checks compare semantic versions without trusting tag prefixes", () => {
  assert.equal(compareVersions("0.5.0", "0.4.9"), 1);
  assert.equal(compareVersions("v0.5.0-team-beta", "0.5.0"), 0);
  const release = parseLatestRelease({
    tag_name: "v0.6.0",
    html_url: "https://example.invalid/release",
    assets: [{ name: "bridge.tgz", size: 123 }],
  }, "0.5.0");
  assert.equal(release.updateAvailable, true);
  assert.equal(release.latestVersion, "0.6.0");
});

test("repo marketplace points to the self-hosted management plugin", () => {
  const marketplace = readJson(".agents/plugins/marketplace.json");
  assert.equal(marketplace.name, "codex-weixin-team");
  assert.deepEqual(marketplace.plugins[0].source, {
    source: "local",
    path: "./plugins/codex-weixin-bridge",
  });

  const manifest = readJson(
    "plugins/codex-weixin-bridge/.codex-plugin/plugin.json",
  );
  assert.equal(manifest.name, "codex-weixin-bridge");
  assert.equal(manifest.version, "0.7.1");
  assert.equal(manifest.skills, "./skills/");
});

test("publishable runtime files contain no developer home path", () => {
  const relativePaths = [
    "README.md",
    "package.json",
    "src/cli.mjs",
    "src/service.mjs",
    "scripts/install-launch-agent.sh",
    "scripts/status-launch-agent.sh",
    "scripts/install-local.sh",
    "scripts/install-windows.ps1",
  ];
  for (const relativePath of relativePaths) {
    const text = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(text, /\/Users\/jay\.bao/, relativePath);
  }
});

test("release checksum is portable and does not embed the runner path", () => {
  const script = fs.readFileSync(
    path.join(repoRoot, "scripts/build-release-assets.sh"),
    "utf8",
  );
  assert.match(script, /cd "\$\{dist_dir\}"/);
  assert.match(script, /shasum -a 256 "\$\{package_name\}"/);
  assert.doesNotMatch(script, /shasum -a 256 "\$\{archive\}"/);
});
