#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

import { runBridge } from "./bridge.mjs";
import { CodexAppServer, resolveCodexBinary } from "./codex-client.mjs";
import { writeQrPng } from "./qr-png.mjs";
import {
  assertBinding,
  readJson,
  resolveStateDir,
  statePath,
  writeJsonPrivate,
} from "./state.mjs";
import {
  assertProjectRegistry,
} from "./routing.mjs";
import {
  startQrLogin,
  waitForQrLogin,
  WEIXIN_PROTOCOL,
} from "./weixin-api.mjs";
import {
  backgroundServiceStatus,
  installBackgroundService,
  renderServiceDefinition,
  resolveServiceConfig,
  restartBackgroundService,
  uninstallBackgroundService,
} from "./service.mjs";
import {
  createSafeBackup,
  defaultBackupPath,
  inspectSafeBackup,
  logoutLocalState,
  restoreSafeBackup,
} from "./lifecycle.mjs";
import {
  checkForUpdate,
  upgradeToLatest,
} from "./update.mjs";
import { BRIDGE_VERSION } from "./version.mjs";
import { INBOUND_MEDIA_LIMITS } from "./inbound-media.mjs";
import { WEIXIN_ARTICLE_LIMITS } from "./weixin-article.mjs";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { command, options };
}

function printHelp() {
  console.log(`Codex 微信直连桥接器

用法：
  codex-weixin-bridge doctor
  codex-weixin-bridge --version
  codex-weixin-bridge setup
  codex-weixin-bridge threads --cwd "/绝对/项目路径"
  codex-weixin-bridge projects
  codex-weixin-bridge project-add --id "project-id" --name "项目名" --cwd "/绝对/项目路径"
  codex-weixin-bridge create-test --cwd "/绝对/项目路径"
  codex-weixin-bridge login
  codex-weixin-bridge bind --cwd "/绝对/项目路径" --thread-id "任务ID"
  codex-weixin-bridge simulate --text "测试消息"
  codex-weixin-bridge service-render
  codex-weixin-bridge service-install
  codex-weixin-bridge service-status
  codex-weixin-bridge service-restart
  codex-weixin-bridge service-uninstall
  codex-weixin-bridge check-update
  codex-weixin-bridge upgrade
  codex-weixin-bridge logout
  codex-weixin-bridge backup --output "/备份文件.json"
  codex-weixin-bridge restore --input "/备份文件.json"
  codex-weixin-bridge serve

说明：
  - 当前版本 ${BRIDGE_VERSION}，常驻服务支持 macOS LaunchAgent 和 Windows 用户级计划任务。
  - 运行时不启动或调用 OpenClaw Gateway。
  - 微信凭证默认保存在 ${resolveStateDir()}，${
    process.platform === "win32"
      ? "使用 ACL 仅授权当前 Windows 用户。"
      : "目录权限 0700，文件权限 0600。"
  }
  - 默认只读；项目内文件修改需在微信回复一次性审批码，传统命令提权禁用。
  - 支持只读图片、PDF 和 UTF-8 文本附件；语音、视频和可执行文件不接收。
  - 支持无登录读取 https://mp.weixin.qq.com 的单篇公开文章；不读取文章图片，不执行 OCR。
  - 读取被限制在当前绑定项目；网络、连接器、MCP、删除、外部发送和发布会被拒绝。`);
}

function isYes(value) {
  return /^(y|yes|是|好|确认|同意)$/i.test(String(value || "").trim());
}

function projectIdFromName(value) {
  const normalized = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return normalized || `project-${Date.now().toString(36)}`;
}

async function ask(rl, question, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const value = (await rl.question(`${question}${suffix}：`)).trim();
  return value || defaultValue;
}

async function confirm(rl, question, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const value = (await rl.question(`${question} [${hint}]：`)).trim();
  if (!value) return defaultYes;
  return isYes(value);
}

async function withCodex(fn) {
  const client = await new CodexAppServer({ stderr: process.stderr }).start();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function doctor(options = {}) {
  const codexBin = resolveCodexBinary();
  const report = {
    version: BRIDGE_VERSION,
    node: process.version,
    platform: process.platform,
    codexBin,
    codexExecutable: fs.existsSync(codexBin),
    weixinProtocol: WEIXIN_PROTOCOL,
    stateDir: resolveStateDir(),
    credentials: Boolean(readJson("credentials.json")),
    binding: Boolean(readJson("binding.json")),
    connection: readJson("runtime.json")?.connection || null,
    inboundMedia: {
      supported: ["PNG", "JPEG", "GIF", "WebP", "PDF", "UTF-8 text"],
      imageBytes: INBOUND_MEDIA_LIMITS.imageBytes,
      imagePixels: INBOUND_MEDIA_LIMITS.imagePixels,
      pdfBytes: INBOUND_MEDIA_LIMITS.documentBytes,
      textBytes: INBOUND_MEDIA_LIMITS.textBytes,
      extractedCharacters: INBOUND_MEDIA_LIMITS.extractedCharacters,
      voiceEnabled: false,
      videoEnabled: false,
    },
    publicLinks: {
      supportedHosts: ["mp.weixin.qq.com"],
      loginCookies: false,
      htmlBytes: WEIXIN_ARTICLE_LIMITS.htmlBytes,
      extractedCharacters: WEIXIN_ARTICLE_LIMITS.extractedCharacters,
      articleImagesFetched: false,
      articleImageOcr: false,
    },
  };

  await withCodex(async (client) => {
    const result = await client.listThreads({ limit: 1 });
    report.codexAppServer = {
      ok: true,
      visibleThreadSampleCount: result.data?.length ?? 0,
    };
    const binding = readJson("binding.json");
    if (binding?.cwd) {
      const isolation = await client.verifyIsolation({ cwd: binding.cwd });
      report.isolation = { ok: true, ...isolation };
    }
  });
  if (["darwin", "win32"].includes(process.platform)) {
    const status = backgroundServiceStatus();
    report.backgroundService = {
      installed: status.installed,
      running: status.running,
      definitionPath: process.platform === "win32"
        ? status.config.windowsRunnerPath
        : status.config.plistPath,
    };
  }
  console.log(JSON.stringify(report, null, 2));
  if (!options.json) {
    console.log(
      `Codex App Server: OK（可见任务 ${report.codexAppServer.visibleThreadSampleCount} 条，抽样上限 1）`,
    );
    if (report.isolation) {
      console.log(
        `项目隔离: OK（${report.isolation.permissionProfile}，MCP ${report.isolation.mcpServerCount}）`,
      );
    }
  }
}

async function threads(options) {
  const cwd = options.cwd ? path.resolve(options.cwd) : undefined;
  await withCodex(async (client) => {
    const result = await client.listThreads({ cwd, limit: 100 });
    const rows = (result.data || []).map((thread) => ({
      id: thread.id,
      name: thread.name || null,
      cwd: thread.cwd || null,
      updatedAt: thread.updatedAt || null,
      status: thread.status?.type || thread.status || null,
    }));
    console.log(JSON.stringify(rows, null, 2));
  });
}

function listProjects() {
  const registry = assertProjectRegistry(
    readJson("projects.json", { required: true }),
  );
  console.log(JSON.stringify(registry, null, 2));
}

function addProject(options) {
  if (!options.id || !options.name || !options.cwd) {
    throw new Error("project-add 需要 --id、--name 和 --cwd。");
  }
  const cwd = fs.realpathSync(path.resolve(options.cwd));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`项目目录不存在：${cwd}`);
  }
  const current = readJson("projects.json") || { version: 1, projects: [] };
  const projects = (current.projects || []).filter(
    (project) => project.id !== options.id && path.resolve(project.cwd) !== cwd,
  );
  projects.push({
    id: options.id,
    name: options.name,
    cwd,
    permissionPolicy: "approvalV1",
    enabled: true,
  });
  const registry = assertProjectRegistry({
    version: 1,
    projects,
    updatedAt: new Date().toISOString(),
  });
  const saved = writeJsonPrivate("projects.json", registry);

  const existingBinding = readJson("binding.json");
  if (existingBinding?.cwd && path.resolve(existingBinding.cwd) === cwd) {
    const project = registry.projects.find((candidate) => candidate.cwd === cwd);
    writeJsonPrivate("binding.json", {
      ...existingBinding,
      projectId: project.id,
      projectName: project.name,
      mode: "approvalV1",
      updatedAt: new Date().toISOString(),
    });
  }

  console.log(`项目白名单已保存到 ${saved}`);
  console.log(JSON.stringify(registry, null, 2));
}

async function createTest(options) {
  if (!options.cwd) throw new Error("create-test 需要 --cwd。");
  const cwd = path.resolve(options.cwd);
  await withCodex(async (client) => {
    const listed = await client.listThreads({ cwd, limit: 100 });
    const existing = (listed.data || []).find((thread) => thread.name === "微信直连测试");
    const created = existing
      ? { threadId: existing.id }
      : await client.startThread({ cwd, name: "微信直连测试" });
    const reply = await client.runReadOnlyTurn({
      threadId: created.threadId,
      cwd,
      text: "这是微信直连桥接器的本地测试。请只回复：Codex 直连测试成功",
      resume: Boolean(existing),
    });
    console.log(JSON.stringify({ threadId: created.threadId, reply }, null, 2));
  });
}

async function login() {
  console.log("正在直接请求微信 iLink 登录二维码（不会启动 OpenClaw）...");
  const loginState = await startQrLogin();
  const qrPath = statePath("wechat-login-qr.png");
  const written = writeQrPng(loginState.payload, qrPath);
  if (written) console.log(`QR_PATH=${written}`);
  console.log(`QR_PAYLOAD=${loginState.payload}`);
  console.log("请使用微信扫码，并在手机上确认授权。");

  const credentials = await waitForQrLogin(loginState, {
    onStatus(status) {
      if (status === "scaned") console.log("已扫码，请在微信中继续确认...");
      if (status === "wait") console.log("等待扫码...");
      if (status === "scaned_but_redirect") console.log("扫码后已切换到微信分区节点...");
    },
  });
  const saved = writeJsonPrivate("credentials.json", credentials);
  console.log(`微信授权成功，凭证已保存到 ${saved}`);
  console.log("授权身份已记录（敏感 ID 不在终端回显）。");
  return credentials;
}

async function bind(options) {
  if (!options.cwd || !options["thread-id"]) {
    throw new Error("bind 需要 --cwd 和 --thread-id。");
  }
  const credentials = readJson("credentials.json", { required: true });
  const registry = assertProjectRegistry(
    readJson("projects.json", { required: true }),
  );
  const project = registry.projects.find(
    (candidate) => candidate.enabled && candidate.cwd === path.resolve(options.cwd),
  );
  if (!project) throw new Error("bind 的 cwd 不在已启用的项目白名单中。");
  const thread = await withCodex(async (client) => {
    const result = await client.listThreads({ cwd: project.cwd, limit: 100 });
    return (result.data || []).find(
      (candidate) => candidate.id === options["thread-id"]
        && path.resolve(candidate.cwd) === project.cwd,
    );
  });
  if (!thread) {
    throw new Error("bind 的任务不存在，或不属于指定项目。");
  }
  const binding = {
    cwd: path.resolve(options.cwd),
    threadId: options["thread-id"],
    projectId: project.id,
    projectName: project.name,
    threadName: thread.name || "未命名任务",
    accountId: credentials.accountId,
    allowedUserId: credentials.allowedUserId,
    mode: "approvalV1",
    updatedAt: new Date().toISOString(),
  };
  const saved = writeJsonPrivate("binding.json", binding);
  console.log(`绑定已保存到 ${saved}`);
  console.log(JSON.stringify({
    projectName: binding.projectName,
    threadName: binding.threadName,
    cwd: binding.cwd,
    mode: binding.mode,
  }, null, 2));
  return binding;
}

async function simulate(options) {
  if (!options.text) throw new Error("simulate 需要 --text。");
  const binding = assertBinding(readJson("binding.json", { required: true }));
  await withCodex(async (client) => {
    const reply = await client.runApprovalTurn({
      threadId: binding.threadId,
      cwd: binding.cwd,
      text: options.text,
    });
    console.log(reply);
  });
}

async function serve() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await runBridge({ signal: controller.signal });
}

function renderService() {
  console.log(renderServiceDefinition(resolveServiceConfig()));
}

function installService() {
  const config = installBackgroundService();
  console.log(`常驻服务已安装：${
    process.platform === "win32" ? config.windowsTaskName : config.label
  }`);
  console.log(process.platform === "win32"
    ? `Windows 启动脚本：${config.windowsRunnerPath}`
    : `LaunchAgent：${config.plistPath}`);
  console.log(`日志目录：${config.stateDir}`);
}

function printServiceStatus() {
  const status = backgroundServiceStatus();
  console.log(JSON.stringify({
    service: process.platform === "win32"
      ? status.config.windowsTaskName
      : status.config.label,
    installed: status.installed,
    running: status.running,
      definitionPath: process.platform === "win32"
        ? status.config.windowsRunnerPath
        : status.config.plistPath,
    stateDir: status.config.stateDir,
  }, null, 2));
  if (status.output) console.log(status.output);
  if (!status.running) process.exitCode = 1;
}

function uninstallService() {
  const result = uninstallBackgroundService();
  console.log(result.removed
    ? `常驻服务已停止并移除：${
      process.platform === "win32"
        ? result.config.windowsTaskName
        : result.config.plistPath
    }`
    : "常驻服务未安装，未删除任何文件。");
}

function restartService() {
  const config = restartBackgroundService();
  console.log(`常驻服务已重启：${
    process.platform === "win32" ? config.windowsTaskName : config.label
  }`);
}

async function setup(options) {
  console.log(`\nCodex 微信直连一键配置向导 ${BRIDGE_VERSION}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (options.yes && !options.cwd && !readJson("migration.json")) {
      throw new Error("setup --yes 需要显式提供 --cwd，避免误选项目目录。");
    }
    console.log("1/5 检查 Codex 本机运行时...");
    await withCodex(async (client) => client.listThreads({ limit: 1 }));
    console.log("Codex App Server：正常");

    let credentials = readJson("credentials.json");
    if (!credentials) {
      const approved = options.yes
        || await confirm(rl, "2/5 现在扫码授权微信吗？");
      if (!approved) throw new Error("配置已暂停：微信尚未授权。");
      credentials = await login();
    } else {
      console.log("2/5 已存在微信授权，本次不重复扫码。");
    }

    const migration = readJson("migration.json");
    const defaultHint = migration?.bindingHint || migration?.projectHints?.[0] || {};
    const cwdInput = options.cwd || await ask(
      rl,
      "3/5 请输入允许微信访问的项目绝对路径",
      fs.existsSync(defaultHint.projectPath || defaultHint.cwd || "")
        ? (defaultHint.projectPath || defaultHint.cwd)
        : process.cwd(),
    );
    const cwd = fs.realpathSync(path.resolve(cwdInput));
    if (!fs.statSync(cwd).isDirectory()) throw new Error(`项目目录不存在：${cwd}`);
    const projectName = options["project-name"] || await ask(
      rl,
      "项目显示名称",
      defaultHint.projectName || defaultHint.name || path.basename(cwd),
    );
    const projectId = options["project-id"] || await ask(
      rl,
      "项目短 ID（英文、数字、横线）",
      defaultHint.projectId || defaultHint.id || projectIdFromName(projectName),
    );
    addProject({ id: projectId, name: projectName, cwd });

    console.log("4/5 读取该项目最近的 Codex 任务...");
    const listed = await withCodex(async (client) => {
      const result = await client.listThreads({ cwd, limit: 20 });
      if ((result.data || []).length > 0) return result.data;
      const shouldCreate = options.yes
        || await confirm(rl, "该项目还没有任务，是否创建“微信直连”任务？");
      if (!shouldCreate) throw new Error("配置已暂停：没有可绑定的 Codex 任务。");
      const created = await client.startThread({ cwd, name: "微信直连" });
      return [{
        id: created.threadId,
        name: "微信直连",
        cwd,
        updatedAt: Math.floor(Date.now() / 1000),
      }];
    });
    listed.slice(0, 10).forEach((thread, index) => {
      console.log(`${index + 1}. ${thread.name || "未命名任务"}`);
    });
    let selected;
    if (options["thread-id"]) {
      selected = listed.find((thread) => thread.id === options["thread-id"]);
    } else {
      if (options.yes && !options["thread-index"]) {
        throw new Error(
          "setup --yes 在存在任务时需要显式提供 --thread-index 或 --thread-id，避免误绑定。",
        );
      }
      const defaultIndex = Number(options["thread-index"] || 1);
      const choice = options.yes
        ? defaultIndex
        : Number(await ask(rl, "选择要绑定的任务编号", String(defaultIndex)));
      selected = listed[choice - 1];
    }
    if (!selected) throw new Error("选择的任务无效。");
    await bind({ cwd, "thread-id": selected.id });

    const supportsService = ["darwin", "win32"].includes(process.platform);
    const install = supportsService && !options["skip-service"] && (
      options.yes || await confirm(rl, "5/5 安装并启动本机常驻服务吗？")
    );
    if (install) installService();
    else console.log("5/5 已跳过常驻服务安装，可稍后运行 service-install。");

    console.log("\n配置完成。微信只连接到刚才选择的项目和任务。");
    console.log("建议在微信发送“当前任务”做最后确认。");
  } finally {
    rl.close();
  }
}

async function logout(options) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const approved = options.yes || await confirm(
      rl,
      "退出会停止服务并删除本机微信凭证与当前任务绑定，继续吗？",
      false,
    );
    if (!approved) {
      console.log("已取消，未修改任何状态。");
      return;
    }
    let backupPath = null;
    if (!options["no-backup"]) {
      backupPath = createSafeBackup(options.output || defaultBackupPath());
    }
    if (["darwin", "win32"].includes(process.platform)) {
      uninstallBackgroundService();
    }
    const result = logoutLocalState();
    console.log(JSON.stringify({ ...result, backupPath }, null, 2));
    console.log("本机授权已退出；项目白名单与审计记录仍保留。");
    console.log("腾讯公开协议未提供可验证的服务端撤销接口，因此这里不声称已远程吊销 token。");
  } finally {
    rl.close();
  }
}

function backup(options) {
  const target = createSafeBackup(options.output || defaultBackupPath());
  console.log(`安全备份已创建：${target}`);
  console.log("备份不含微信凭证、消息正文、完整任务 ID 或日志。");
}

async function restore(options) {
  if (!options.input) throw new Error("restore 需要 --input。");
  const preview = inspectSafeBackup(options.input);
  console.log("即将恢复以下安全备份：");
  console.log(JSON.stringify(preview, null, 2));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const approved = options.yes || await confirm(
      rl,
      "恢复会合并本机已有项目登记，并写入迁移提示，继续吗？",
      false,
    );
    if (!approved) {
      console.log("已取消恢复，未修改任何状态。");
      return;
    }
    const result = restoreSafeBackup(options.input);
    console.log(JSON.stringify(result, null, 2));
    console.log("恢复完成后请运行 setup，重新扫码并选择本机项目路径与任务。");
  } finally {
    rl.close();
  }
}

async function checkUpdate() {
  const result = await checkForUpdate();
  console.log(JSON.stringify(result, null, 2));
  console.log(result.updateAvailable
    ? `发现新版本 ${result.latestVersion}，可运行 upgrade。`
    : `当前已是最新版本 ${result.currentVersion}。`);
}

async function upgrade(options) {
  const release = await checkForUpdate();
  if (!release.updateAvailable) {
    console.log(`当前已是最新版本 ${release.currentVersion}。`);
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const approved = options.yes || await confirm(
      rl,
      `将从 ${release.currentVersion} 升级到 ${release.latestVersion}，继续吗？`,
      false,
    );
    if (!approved) {
      console.log("已取消升级。");
      return;
    }
    const backupPath = createSafeBackup(options.output || defaultBackupPath());
    let serviceWasInstalled = false;
    const result = await upgradeToLatest({
      release,
      packageRoot,
      beforeInstall() {
        if (!["darwin", "win32"].includes(process.platform)) return;
        serviceWasInstalled = backgroundServiceStatus().installed;
        if (serviceWasInstalled) uninstallBackgroundService();
      },
      afterInstall() {
        if (serviceWasInstalled) installBackgroundService();
      },
    });
    console.log(JSON.stringify({ ...result, backupPath }, null, 2));
  } finally {
    rl.close();
  }
}

const { command, options } = parseArgs(process.argv.slice(2));

try {
  switch (command) {
    case "doctor":
      await doctor(options);
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(BRIDGE_VERSION);
      break;
    case "setup":
      await setup(options);
      break;
    case "threads":
      await threads(options);
      break;
    case "projects":
      listProjects();
      break;
    case "project-add":
      addProject(options);
      break;
    case "create-test":
      await createTest(options);
      break;
    case "login":
      await login();
      break;
    case "bind":
      await bind(options);
      break;
    case "simulate":
      await simulate(options);
      break;
    case "serve":
      await serve();
      break;
    case "service-render":
      renderService();
      break;
    case "service-install":
      installService();
      break;
    case "service-status":
      printServiceStatus();
      break;
    case "service-restart":
      restartService();
      break;
    case "service-uninstall":
      uninstallService();
      break;
    case "check-update":
      await checkUpdate();
      break;
    case "upgrade":
      await upgrade(options);
      break;
    case "logout":
      await logout(options);
      break;
    case "backup":
      backup(options);
      break;
    case "restore":
      await restore(options);
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      throw new Error(`未知命令：${command}`);
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
