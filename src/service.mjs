import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCodexBinary } from "./codex-client.mjs";
import { hardenPrivatePath, resolveStateDir } from "./state.mjs";

export const DEFAULT_SERVICE_LABEL = "com.codex.weixin.bridge";
export const DEFAULT_WINDOWS_TASK_NAME = "CodexWeixinBridge";

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function assertMacOS() {
  if (process.platform !== "darwin") {
    throw new Error("团队内测版的常驻服务安装目前仅支持 macOS。");
  }
}

function runLaunchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync("launchctl", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`launchctl ${args.join(" ")} 失败${detail ? `：${detail}` : ""}`);
  }
  return result;
}

export function resolveServiceConfig(overrides = {}) {
  const platform = overrides.platform || process.platform;
  const homeDir = path.resolve(overrides.homeDir || os.homedir());
  const stateDir = path.resolve(overrides.stateDir || resolveStateDir());
  const cliPath = path.resolve(
    overrides.cliPath || fileURLToPath(new URL("./cli.mjs", import.meta.url)),
  );
  const nodePath = path.resolve(overrides.nodePath || process.execPath);
  const codexBin = path.resolve(overrides.codexBin || resolveCodexBinary());
  const label = overrides.label
    || process.env.CODEX_WEIXIN_SERVICE_LABEL
    || DEFAULT_SERVICE_LABEL;
  if (!/^[A-Za-z0-9.-]+$/.test(label)) {
    throw new Error(`无效的 LaunchAgent 服务名称：${label}`);
  }

  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
  return {
    platform,
    label,
    homeDir,
    stateDir,
    cliPath,
    nodePath,
    codexBin,
    workingDirectory: path.dirname(path.dirname(cliPath)),
    launchDomain: `gui/${process.getuid?.() ?? 0}`,
    plistPath: path.join(launchAgentsDir, `${label}.plist`),
    serviceLog: path.join(stateDir, "service.log"),
    serviceErrorLog: path.join(stateDir, "service.error.log"),
    windowsTaskName: overrides.windowsTaskName
      || process.env.CODEX_WEIXIN_WINDOWS_TASK_NAME
      || DEFAULT_WINDOWS_TASK_NAME,
    windowsRunnerPath: path.join(stateDir, "run-bridge.cmd"),
    pathValue: unique([
      path.dirname(nodePath),
      path.join(homeDir, ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]).join(":"),
  };
}

export function renderLaunchAgentPlist(config = resolveServiceConfig()) {
  const value = Object.fromEntries(
    Object.entries(config).map(([key, item]) => [key, xmlEscape(item)]),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${value.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${value.nodePath}</string>
    <string>${value.cliPath}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${value.workingDirectory}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${value.homeDir}</string>
    <key>PATH</key>
    <string>${value.pathValue}</string>
    <key>CODEX_WEIXIN_CODEX_BIN</key>
    <string>${value.codexBin}</string>
    <key>CODEX_WEIXIN_STATE_DIR</key>
    <string>${value.stateDir}</string>
    <key>NO_COLOR</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${value.serviceLog}</string>
  <key>StandardErrorPath</key>
  <string>${value.serviceErrorLog}</string>
</dict>
</plist>
`;
}

function cmdValue(value) {
  const text = String(value);
  if (/[\r\n"]/.test(text)) {
    throw new Error("Windows 服务路径包含不支持的字符。");
  }
  return text;
}

export function renderWindowsRunnerCmd(config = resolveServiceConfig()) {
  return [
    "@echo off",
    "setlocal",
    `set "HOME=${cmdValue(config.homeDir)}"`,
    `set "CODEX_WEIXIN_CODEX_BIN=${cmdValue(config.codexBin)}"`,
    `set "CODEX_WEIXIN_STATE_DIR=${cmdValue(config.stateDir)}"`,
    "set \"NO_COLOR=1\"",
    `cd /d "${cmdValue(config.workingDirectory)}"`,
    `"${cmdValue(config.nodePath)}" "${cmdValue(config.cliPath)}" serve >>"${cmdValue(config.serviceLog)}" 2>>"${cmdValue(config.serviceErrorLog)}"`,
    "",
  ].join("\r\n");
}

export function installLaunchAgent(config = resolveServiceConfig()) {
  assertMacOS();
  fs.mkdirSync(path.dirname(config.plistPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.stateDir, 0o700);
  fs.writeFileSync(config.plistPath, renderLaunchAgentPlist(config), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(config.plistPath, 0o600);
  for (const logPath of [config.serviceLog, config.serviceErrorLog]) {
    fs.closeSync(fs.openSync(logPath, "a", 0o600));
    fs.chmodSync(logPath, 0o600);
  }

  runLaunchctl(["bootout", `${config.launchDomain}/${config.label}`], {
    allowFailure: true,
  });
  runLaunchctl(["enable", `${config.launchDomain}/${config.label}`]);
  runLaunchctl(["bootstrap", config.launchDomain, config.plistPath]);
  runLaunchctl(["kickstart", "-k", `${config.launchDomain}/${config.label}`]);
  return config;
}

export function serviceStatus(config = resolveServiceConfig()) {
  assertMacOS();
  const result = runLaunchctl(
    ["print", `${config.launchDomain}/${config.label}`],
    { allowFailure: true },
  );
  return {
    installed: fs.existsSync(config.plistPath),
    running: result.status === 0,
    output: (result.stdout || result.stderr || "").trim(),
    config,
  };
}

export function uninstallLaunchAgent(config = resolveServiceConfig()) {
  assertMacOS();
  runLaunchctl(["bootout", `${config.launchDomain}/${config.label}`], {
    allowFailure: true,
  });
  let removed = false;
  if (fs.existsSync(config.plistPath)) {
    fs.unlinkSync(config.plistPath);
    removed = true;
  }
  return { removed, config };
}

function assertWindows() {
  if (process.platform !== "win32") {
    throw new Error("Windows 计划任务只能在 Windows 上安装。");
  }
}

function runSchtasks(args, { allowFailure = false } = {}) {
  const result = spawnSync("schtasks.exe", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`schtasks ${args.join(" ")} 失败${detail ? `：${detail}` : ""}`);
  }
  return result;
}

export function installWindowsTask(config = resolveServiceConfig()) {
  assertWindows();
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  hardenPrivatePath(config.stateDir, { directory: true });
  fs.writeFileSync(config.windowsRunnerPath, renderWindowsRunnerCmd(config), {
    encoding: "utf8",
    mode: 0o600,
  });
  hardenPrivatePath(config.windowsRunnerPath);
  const taskCommand = `cmd.exe /d /c \\"${config.windowsRunnerPath}\\"`;
  runSchtasks([
    "/Create",
    "/F",
    "/SC", "ONLOGON",
    "/RL", "LIMITED",
    "/TN", config.windowsTaskName,
    "/TR", taskCommand,
  ]);
  runSchtasks(["/Run", "/TN", config.windowsTaskName]);
  return config;
}

export function windowsTaskStatus(config = resolveServiceConfig()) {
  assertWindows();
  const result = runSchtasks([
    "/Query",
    "/TN", config.windowsTaskName,
    "/FO", "LIST",
    "/V",
  ], { allowFailure: true });
  const output = (result.stdout || result.stderr || "").trim();
  return {
    installed: result.status === 0,
    running: result.status === 0 && /Running|正在运行/i.test(output),
    output,
    config,
  };
}

export function uninstallWindowsTask(config = resolveServiceConfig()) {
  assertWindows();
  runSchtasks([
    "/End",
    "/TN", config.windowsTaskName,
  ], { allowFailure: true });
  const result = runSchtasks([
    "/Delete",
    "/F",
    "/TN", config.windowsTaskName,
  ], { allowFailure: true });
  let removed = result.status === 0;
  if (fs.existsSync(config.windowsRunnerPath)) {
    fs.unlinkSync(config.windowsRunnerPath);
    removed = true;
  }
  return { removed, config };
}

export function renderServiceDefinition(config = resolveServiceConfig()) {
  if (config.platform === "darwin") return renderLaunchAgentPlist(config);
  if (config.platform === "win32") return renderWindowsRunnerCmd(config);
  throw new Error("常驻服务目前支持 macOS 和 Windows。");
}

export function installBackgroundService(config = resolveServiceConfig()) {
  if (process.platform === "darwin") return installLaunchAgent(config);
  if (process.platform === "win32") return installWindowsTask(config);
  throw new Error("常驻服务目前支持 macOS 和 Windows。");
}

export function backgroundServiceStatus(config = resolveServiceConfig()) {
  if (process.platform === "darwin") return serviceStatus(config);
  if (process.platform === "win32") return windowsTaskStatus(config);
  throw new Error("常驻服务目前支持 macOS 和 Windows。");
}

export function uninstallBackgroundService(config = resolveServiceConfig()) {
  if (process.platform === "darwin") return uninstallLaunchAgent(config);
  if (process.platform === "win32") return uninstallWindowsTask(config);
  throw new Error("常驻服务目前支持 macOS 和 Windows。");
}
