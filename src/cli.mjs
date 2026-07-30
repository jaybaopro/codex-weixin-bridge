#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

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
  installLaunchAgent,
  renderLaunchAgentPlist,
  resolveServiceConfig,
  serviceStatus,
  uninstallLaunchAgent,
} from "./service.mjs";
import { BRIDGE_VERSION } from "./version.mjs";

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
  codex-weixin-bridge service-uninstall
  codex-weixin-bridge serve

说明：
  - 当前版本 ${BRIDGE_VERSION}，团队内测的常驻服务安装仅支持 macOS。
  - 运行时不启动或调用 OpenClaw Gateway。
  - 微信凭证默认保存在 ${resolveStateDir()}，目录权限 0700，文件权限 0600。
  - 默认只读；项目内文件修改需在微信回复一次性审批码，传统命令提权禁用。
  - 读取被限制在当前绑定项目；网络、连接器、MCP、删除、外部发送和发布会被拒绝。`);
}

async function withCodex(fn) {
  const client = await new CodexAppServer({ stderr: process.stderr }).start();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function doctor() {
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
  };
  console.log(JSON.stringify(report, null, 2));

  await withCodex(async (client) => {
    const result = await client.listThreads({ limit: 1 });
    console.log(`Codex App Server: OK（可见任务 ${result.data?.length ?? 0} 条，抽样上限 1）`);
    const binding = readJson("binding.json");
    if (binding?.cwd) {
      const isolation = await client.verifyIsolation({ cwd: binding.cwd });
      console.log(`项目隔离: OK（${isolation.permissionProfile}，MCP ${isolation.mcpServerCount}）`);
    }
  });
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
  console.log(`授权用户：${credentials.allowedUserId}`);
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
  console.log(JSON.stringify(binding, null, 2));
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
  console.log(renderLaunchAgentPlist(resolveServiceConfig()));
}

function installService() {
  const config = installLaunchAgent();
  console.log(`常驻服务已安装：${config.label}`);
  console.log(`LaunchAgent：${config.plistPath}`);
  console.log(`日志目录：${config.stateDir}`);
}

function printServiceStatus() {
  const status = serviceStatus();
  console.log(JSON.stringify({
    label: status.config.label,
    installed: status.installed,
    running: status.running,
    plistPath: status.config.plistPath,
    stateDir: status.config.stateDir,
  }, null, 2));
  if (status.output) console.log(status.output);
  if (!status.running) process.exitCode = 1;
}

function uninstallService() {
  const result = uninstallLaunchAgent();
  console.log(result.removed
    ? `常驻服务已停止并移除：${result.config.plistPath}`
    : "常驻服务未安装，未删除任何文件。");
}

const { command, options } = parseArgs(process.argv.slice(2));

try {
  switch (command) {
    case "doctor":
      await doctor();
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
    case "service-uninstall":
      uninstallService();
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
