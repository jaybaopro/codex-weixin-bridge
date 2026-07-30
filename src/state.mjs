import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function windowsPrincipal() {
  const username = os.userInfo().username;
  return process.env.USERDOMAIN
    ? `${process.env.USERDOMAIN}\\${username}`
    : username;
}

function hardenWindowsPath(filePath, { directory = false } = {}) {
  const permission = directory ? "(OI)(CI)F" : "F";
  const result = spawnSync("icacls", [
    filePath,
    "/inheritance:r",
    "/grant:r",
    `${windowsPrincipal()}:${permission}`,
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`无法收紧 Windows 状态权限：${detail || filePath}`);
  }
}

export function hardenPrivatePath(filePath, { directory = false } = {}) {
  if (process.platform === "win32") {
    hardenWindowsPath(filePath, { directory });
  } else {
    fs.chmodSync(filePath, directory ? 0o700 : 0o600);
  }
}

export function ensureStateDir() {
  const dir = resolveStateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  hardenPrivatePath(dir, { directory: true });
  return dir;
}

export function resolveStateDir() {
  return path.resolve(
    process.env.CODEX_WEIXIN_STATE_DIR
      || path.join(os.homedir(), ".codex-weixin-direct"),
  );
}

export function statePath(name) {
  return path.join(resolveStateDir(), name);
}

export function readJson(name, { required = false } = {}) {
  const filePath = statePath(name);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (!required && error?.code === "ENOENT") {
      return null;
    }
    throw new Error(`无法读取 ${filePath}: ${error.message}`, { cause: error });
  }
}

export function writeJsonPrivate(name, value) {
  const dir = ensureStateDir();

  const filePath = statePath(name);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  hardenPrivatePath(tempPath);
  fs.renameSync(tempPath, filePath);
  hardenPrivatePath(filePath);
  return filePath;
}

export function appendAuditPrivate(event, fields = {}) {
  ensureStateDir();
  const filePath = statePath("audit.jsonl");
  const allowed = {};
  for (const [key, value] of Object.entries(fields)) {
    if (["string", "number", "boolean"].includes(typeof value) || value == null) {
      allowed[key] = value;
    }
  }
  fs.appendFileSync(filePath, `${JSON.stringify({
    at: new Date().toISOString(),
    event,
    ...allowed,
  })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  hardenPrivatePath(filePath);
  return filePath;
}

export function removeStateFile(name) {
  const filePath = statePath(name);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function acquireProcessLock() {
  ensureStateDir();
  const filePath = statePath("bridge.lock");

  const create = () => {
    const fd = fs.openSync(filePath, "wx", 0o600);
    fs.writeFileSync(fd, `${process.pid}\n`, "utf8");
    return fd;
  };

  let fd;
  try {
    fd = create();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const stalePid = Number.parseInt(fs.readFileSync(filePath, "utf8").trim(), 10);
    let running = Number.isInteger(stalePid) && stalePid > 0;
    if (running) {
      try {
        process.kill(stalePid, 0);
      } catch (probeError) {
        if (probeError?.code === "ESRCH") running = false;
      }
    }
    if (running) {
      throw new Error(`微信桥接器已在运行（PID ${stalePid}）。`);
    }
    fs.unlinkSync(filePath);
    fd = create();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.closeSync(fd);
    try {
      const owner = Number.parseInt(fs.readFileSync(filePath, "utf8").trim(), 10);
      if (owner === process.pid) fs.unlinkSync(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
}

export function assertBinding(binding) {
  if (!binding || typeof binding !== "object") {
    throw new Error("尚未绑定 Codex 任务，请先运行 bind 命令。");
  }
  for (const key of ["cwd", "threadId"]) {
    if (!binding[key] || typeof binding[key] !== "string") {
      throw new Error(`绑定配置缺少 ${key}。`);
    }
  }
  if (!path.isAbsolute(binding.cwd)) {
    throw new Error("绑定的 cwd 必须是绝对路径。");
  }
  return binding;
}
