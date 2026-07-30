import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";

import {
  EXPECTED_PERMISSION_PROFILE,
  isolationConfigArgs,
} from "./isolation-config.mjs";
import { BRIDGE_VERSION } from "./version.mjs";

function executable(pathname) {
  try {
    fs.accessSync(pathname, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveCodexBinary() {
  const lookups = process.platform === "win32"
    ? [
      spawnSync("where.exe", ["codex.exe"], {
        encoding: "utf8",
        windowsHide: true,
      }),
      spawnSync("where.exe", ["codex.cmd"], {
        encoding: "utf8",
        windowsHide: true,
      }),
    ]
    : [spawnSync("which", ["codex"], { encoding: "utf8" })];
  const discovered = lookups.flatMap((lookup) => (
    lookup.status === 0
      ? lookup.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      : []
  ));
  const candidates = [
    process.env.CODEX_WEIXIN_CODEX_BIN,
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    path.join(os.homedir(), ".local/bin/codex"),
    path.join(os.homedir(), "AppData", "Roaming", "npm", "codex.cmd"),
    ...discovered,
  ].filter(Boolean);
  const match = candidates.find(executable);
  if (!match) {
    throw new Error("找不到可用的 Codex CLI 运行时。");
  }
  return match;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class CodexAppServer extends EventEmitter {
  constructor({
    codexBin = resolveCodexBinary(),
    stderr = null,
  } = {}) {
    super();
    this.codexBin = codexBin;
    this.stderr = stderr;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    if (this.child) return this;
    this.child = spawn(
      this.codexBin,
      [...isolationConfigArgs(), "app-server"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        windowsHide: true,
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(this.codexBin),
      },
    );
    this.child.stderr.on("data", (chunk) => {
      if (this.stderr) this.stderr.write(chunk);
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(`Codex App Server 已退出（code=${code}, signal=${signal}）。`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.emit("exit", error);
    });

    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.#handleLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "codex_weixin_direct",
        title: "Codex Weixin Direct Bridge",
        version: BRIDGE_VERSION,
      },
    });
    this.notify("initialized", {});
    return this;
  }

  #send(message) {
    if (!this.child?.stdin?.writable) {
      throw new Error("Codex App Server 尚未启动。");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("warning", `忽略无法解析的 App Server 输出: ${line.slice(0, 300)}`);
      return;
    }

    if (message.id != null && ("result" in message || "error" in message)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(new Error(
          `App Server ${pending.method} 失败: ${message.error.message || JSON.stringify(message.error)}`,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id != null && message.method) {
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) {
      this.emit("notification", message);
      this.emit(message.method, message.params);
    }
  }

  request(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const wait = deferred();
    this.pending.set(String(id), { ...wait, method });
    this.#send({ method, id, params });
    return wait.promise;
  }

  notify(method, params = {}) {
    this.#send({ method, params });
  }

  respondToServerRequest(id, result) {
    this.#send({ id, result });
  }

  rejectServerRequest(id, message, code = -32601) {
    this.#send({ id, error: { code, message } });
  }

  async listThreads({
    cwd,
    limit = 50,
    cursor = null,
    sortKey = "updated_at",
    sortDirection = "desc",
    useStateDbOnly = false,
  } = {}) {
    const result = await this.request("thread/list", {
      limit,
      ...(cursor ? { cursor } : {}),
      ...(cwd ? { cwd } : {}),
      archived: false,
      sortKey,
      sortDirection,
      useStateDbOnly,
    });
    return result;
  }

  async startThread({ cwd, name, ephemeral = false }) {
    const result = await this.request("thread/start", {
      cwd,
      approvalPolicy: "never",
      serviceName: "codex_weixin_direct",
      ephemeral,
    });
    const threadId = result?.thread?.id;
    if (!threadId) throw new Error("App Server 没有返回 thread id。");
    if (name) {
      await this.request("thread/name/set", { threadId, name });
    }
    return { ...result, threadId };
  }

  async resumeThread({ threadId, cwd, approvalPolicy = "never" }) {
    return this.request("thread/resume", {
      threadId,
      cwd,
      approvalPolicy,
      serviceName: "codex_weixin_direct",
    });
  }

  async verifyIsolation({ cwd }) {
    const [profiles, config, mcp] = await Promise.all([
      this.request("permissionProfile/list", { cwd }),
      this.request("config/read", { cwd, includeLayers: false }),
      this.request("mcpServerStatus/list", {
        detail: "full",
        limit: 100,
      }),
    ]);
    const profile = (profiles.data || []).find(
      (candidate) => candidate.id === EXPECTED_PERMISSION_PROFILE,
    );
    const effective = config?.config || {};
    const problems = [];
    if (!profile?.allowed) problems.push("缺少允许使用的 weixin-project 权限配置");
    if (effective.default_permissions !== EXPECTED_PERMISSION_PROFILE) {
      problems.push(`默认权限不是 ${EXPECTED_PERMISSION_PROFILE}`);
    }
    if (effective.web_search !== "disabled") {
      problems.push("Web 搜索未关闭");
    }
    if (effective.features?.apps !== false) {
      problems.push("应用/连接器入口未关闭");
    }
    if (effective.features?.remote_plugin !== false) {
      problems.push("远程插件入口未关闭");
    }
    if (effective.features?.plugins !== false) {
      problems.push("插件运行时未关闭");
    }
    if (effective.apps?._default?.enabled !== false) {
      problems.push("应用默认开关未关闭");
    }
    const activeMcp = (mcp.data || []).filter(
      (server) => Object.keys(server.tools || {}).length
        || (server.resources || []).length
        || (server.resourceTemplates || []).length,
    );
    if (activeMcp.length > 0) {
      problems.push(`仍有 ${activeMcp.length} 个 MCP 服务暴露工具或资源`);
    }
    if (problems.length) {
      throw new Error(`微信专用隔离配置自检失败：${problems.join("；")}`);
    }
    return {
      permissionProfile: profile.id,
      webSearch: effective.web_search,
      appsEnabled: false,
      mcpServerCount: activeMcp.length,
    };
  }

  async runTurn({
    threadId,
    cwd,
    text,
    approvalPolicy = "never",
    resume = true,
  }) {
    if (resume) {
      await this.resumeThread({ threadId, cwd, approvalPolicy });
    }

    const completion = deferred();
    const deltas = [];
    const onDelta = (params) => {
      if (params?.threadId === threadId && typeof params.delta === "string") {
        deltas.push(params.delta);
      }
    };
    const onCompleted = (params) => {
      if (params?.threadId === threadId) completion.resolve(params.turn);
    };
    const onExit = (error) => completion.reject(error);
    this.on("item/agentMessage/delta", onDelta);
    this.on("turn/completed", onCompleted);
    this.once("exit", onExit);

    try {
      const started = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text }],
        cwd,
        approvalPolicy,
        approvalsReviewer: "user",
      });
      const turn = await completion.promise;
      if (turn?.id && started?.turn?.id && turn.id !== started.turn.id) {
        throw new Error(`收到不匹配的 turn/completed: ${turn.id}`);
      }
      if (turn?.status && !["completed", "Completed"].includes(turn.status)) {
        throw new Error(`Codex turn 未正常完成: ${turn.status}`);
      }

      const streamed = deltas.join("").trim();
      if (streamed) return streamed;

      const fallback = (turn?.items || [])
        .filter((item) => item?.type === "agentMessage")
        .map((item) => item.text || item.message || "")
        .filter(Boolean)
        .join("\n")
        .trim();
      return fallback || "Codex 已完成处理，但没有返回可发送的文本。";
    } finally {
      this.off("item/agentMessage/delta", onDelta);
      this.off("turn/completed", onCompleted);
      this.off("exit", onExit);
    }
  }

  runReadOnlyTurn(params) {
    return this.runTurn({ ...params, approvalPolicy: "never" });
  }

  runApprovalTurn(params) {
    return this.runTurn({ ...params, approvalPolicy: "on-request" });
  }

  interruptTurn({ threadId, turnId }) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  async close() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    child.stdin.end();
    if (!child.killed) child.kill("SIGTERM");
  }
}
