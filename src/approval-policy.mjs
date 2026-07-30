import crypto from "node:crypto";
import path from "node:path";

export const APPROVAL_TTL_MS = 5 * 60 * 1000;

const RISKY_COMMAND_PATTERNS = [
  { pattern: /(^|[\s;&|])rm(\s|$)/i, reason: "删除命令" },
  { pattern: /(^|[\s;&|])(rmdir|unlink|shred)(\s|$)/i, reason: "删除命令" },
  { pattern: /\bgit\s+(clean|reset\s+--hard|push)\b/i, reason: "删除或对外发布" },
  { pattern: /\b(gh\s+pr|npm\s+publish|docker\s+push)\b/i, reason: "对外发布" },
  { pattern: /\b(lark-cli|sendmail|mailx?|osascript|open|launchctl)\b/i, reason: "外部发送或系统操作" },
  { pattern: /\b(curl|wget|ssh|scp|sftp|nc|ncat|telnet)\b/i, reason: "网络访问" },
  { pattern: /\b(DELETE|POST|PUT|PATCH)\b.*\bhttps?:\/\//i, reason: "网络写入" },
  { pattern: /(^|[\s"'`])\.\.(?:\/|\\)/, reason: "越出项目目录" },
];

function cleanText(value, limit = 1200) {
  const text = String(value ?? "")
    .replace(/(authorization\s*:\s*(?:bearer\s+)?)[^\s"'`]+/gi, "$1[已隐藏]")
    .replace(/((?:access_?token|refresh_?token|api_?key|secret|password)\s*[=:]\s*)[^\s"'`]+/gi, "$1[已隐藏]")
    .replace(/[A-Za-z0-9_-]{80,}/g, "[长凭证已隐藏]");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function isWithinRoot(root, candidate) {
  if (!root || !candidate) return false;
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function createApprovalCode(existing = new Set()) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = String(crypto.randomInt(1000, 10000));
    if (!existing.has(code)) return code;
  }
  throw new Error("无法生成唯一审批码。");
}

export function parseControlMessage(text) {
  const normalized = String(text || "").trim();
  if (/^取消任务$/.test(normalized)) return { action: "cancel" };
  if (/^(状态|\/状态|\/status)$/i.test(normalized)) return { action: "status" };
  const match = normalized.match(/^(同意|批准|拒绝)\s*(\d{4})$/);
  if (!match) return null;
  return {
    action: match[1] === "拒绝" ? "decline" : "accept",
    code: match[2],
  };
}

function summarizeChanges(changes = []) {
  if (!changes.length) return "";
  return changes.slice(0, 8).map((change) => {
    const kind = change?.kind?.type || change?.kind || "update";
    const labels = { add: "新增", update: "修改", delete: "删除" };
    return `- ${labels[kind] || kind}：${cleanText(change.path, 260)}`;
  }).join("\n");
}

function assessRequestedPermissions(params, binding) {
  if (params.cwd && !isWithinRoot(binding.cwd, params.cwd)) {
    return { allowed: false, reason: "权限请求的工作目录超出当前项目" };
  }
  const requested = params.permissions || {};
  if (requested.network?.enabled) {
    return { allowed: false, reason: "第一版禁止网络访问" };
  }
  const fileSystem = requested.fileSystem || {};
  if ((fileSystem.read || []).length) {
    return { allowed: false, reason: "不允许临时扩大读取范围" };
  }
  for (const candidate of fileSystem.write || []) {
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(binding.cwd, candidate);
    if (!isWithinRoot(binding.cwd, resolved)) {
      return { allowed: false, reason: "写入权限超出当前项目" };
    }
  }
  for (const entry of fileSystem.entries || []) {
    if (entry?.access === "read") {
      return { allowed: false, reason: "不允许临时扩大读取范围" };
    }
    const target = entry?.path || {};
    if (target.type === "path") {
      const resolved = path.isAbsolute(target.path)
        ? target.path
        : path.resolve(binding.cwd, target.path);
      if (!isWithinRoot(binding.cwd, resolved)) {
        return { allowed: false, reason: "文件权限超出当前项目" };
      }
      continue;
    }
    if (
      target.type === "special"
      && target.value?.kind === "project_roots"
      && !String(target.value?.subpath || "").includes("..")
    ) {
      continue;
    }
    return { allowed: false, reason: "不支持该类临时文件权限" };
  }
  return {
    allowed: true,
    type: "permissions",
    summary: [
      "Codex 请求本回合临时扩大项目内写入权限",
      params.reason ? `原因：${cleanText(params.reason, 500)}` : "",
      "范围仍受当前项目硬边界限制；不会开放其他项目或网络。",
    ].filter(Boolean).join("\n"),
    acceptResult: {
      permissions: requested,
      scope: "turn",
    },
    declineResult: {
      permissions: {},
      scope: "turn",
    },
  };
}

export function assessApprovalRequest({ request, binding, changes = [] }) {
  const method = request?.method;
  const params = request?.params || {};
  if (params.threadId !== binding.threadId) {
    return { allowed: false, reason: "审批请求不属于当前绑定任务" };
  }

  if (method === "item/fileChange/requestApproval") {
    if (params.grantRoot && !isWithinRoot(binding.cwd, params.grantRoot)) {
      return { allowed: false, reason: "写入范围超出当前项目" };
    }
    const outside = changes.find((change) => {
      const candidate = path.isAbsolute(change.path)
        ? change.path
        : path.resolve(binding.cwd, change.path);
      return !isWithinRoot(binding.cwd, candidate);
    });
    if (outside) return { allowed: false, reason: "文件变更超出当前项目" };
    if (changes.some((change) => (change?.kind?.type || change?.kind) === "delete")) {
      return { allowed: false, reason: "第一版禁止删除文件" };
    }

    const summary = [
      "Codex 请求修改项目文件",
      summarizeChanges(changes) || `- 范围：${cleanText(params.grantRoot || binding.cwd, 300)}`,
      params.reason ? `原因：${cleanText(params.reason, 500)}` : "",
    ].filter(Boolean).join("\n");
    return { allowed: true, type: "file", summary };
  }

  if (method === "item/commandExecution/requestApproval") {
    const command = String(params.command || "");
    const risky = RISKY_COMMAND_PATTERNS.find(({ pattern }) => pattern.test(command));
    if (risky) return { allowed: false, reason: `第一版禁止${risky.reason}` };
    return {
      allowed: false,
      reason: "为防止命令提权绕过项目读取边界，微信版禁止传统命令提权",
    };
  }

  if (method === "item/permissions/requestApproval") {
    return assessRequestedPermissions(params, binding);
  }

  return { allowed: false, reason: "第一版不支持此类交互请求" };
}

export function approvalPrompt({ code, summary, expiresAt }) {
  const minutes = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60000));
  return [
    "【需要你确认】",
    summary,
    "",
    `若同意，请回复：同意 ${code}`,
    `若拒绝，请回复：拒绝 ${code}`,
    `审批码约 ${minutes} 分钟后失效，且只能使用一次。`,
  ].join("\n");
}
