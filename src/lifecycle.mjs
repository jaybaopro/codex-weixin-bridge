import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  hardenPrivatePath,
  readJson,
  removeStateFile,
  writeJsonPrivate,
} from "./state.mjs";
import { assertProjectRegistry } from "./routing.mjs";
import { BRIDGE_VERSION } from "./version.mjs";

export const BACKUP_FORMAT = "codex-weixin-safe-backup";
export const BACKUP_VERSION = 1;

function timestampForName(date = new Date()) {
  return date.toISOString().replaceAll(":", "-").replace(".", "-");
}

export function defaultBackupPath(date = new Date()) {
  return path.join(
    os.homedir(),
    `codex-weixin-backup-${timestampForName(date)}.json`,
  );
}

export function buildSafeBackup({
  projects = readJson("projects.json"),
  binding = readJson("binding.json"),
  createdAt = new Date().toISOString(),
} = {}) {
  const safeProjects = projects ? assertProjectRegistry(projects) : null;
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_VERSION,
    createdAt,
    bridgeVersion: BRIDGE_VERSION,
    includesCredentials: false,
    includesMessageContent: false,
    projects: safeProjects,
    bindingHint: binding ? {
      projectId: binding.projectId || null,
      projectName: binding.projectName || null,
      projectPath: binding.cwd || null,
      threadName: binding.threadName || null,
    } : null,
    migrationNote: "微信凭证和完整任务 ID 未包含；新设备必须重新扫码并重新绑定任务。",
  };
}

export function createSafeBackup(outputPath = defaultBackupPath()) {
  const target = path.resolve(outputPath);
  if (fs.existsSync(target)) {
    throw new Error(`备份文件已存在，拒绝覆盖：${target}`);
  }
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const tempPath = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(buildSafeBackup(), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  hardenPrivatePath(tempPath);
  fs.renameSync(tempPath, target);
  hardenPrivatePath(target);
  return target;
}

function assertBackup(bundle) {
  if (bundle?.format !== BACKUP_FORMAT || bundle?.formatVersion !== BACKUP_VERSION) {
    throw new Error("备份文件格式或版本不受支持。");
  }
  if (bundle.includesCredentials !== false) {
    throw new Error("拒绝恢复包含微信凭证的备份。");
  }
  if (bundle.projects) {
    if (!Array.isArray(bundle.projects.projects)
      || bundle.projects.projects.length > 20) {
      throw new Error("备份中的项目列表无效。");
    }
    for (const project of bundle.projects.projects) {
      if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(project?.id || "")
        || typeof project?.name !== "string"
        || typeof project?.cwd !== "string") {
        throw new Error("备份中包含无效项目记录。");
      }
    }
  }
  return bundle;
}

export function inspectSafeBackup(inputPath) {
  const source = path.resolve(inputPath);
  const bundle = assertBackup(JSON.parse(fs.readFileSync(source, "utf8")));
  return {
    source,
    createdAt: bundle.createdAt || null,
    bridgeVersion: bundle.bridgeVersion || null,
    projectCount: bundle.projects?.projects?.length || 0,
    projects: (bundle.projects?.projects || []).map((project) => ({
      id: project.id,
      name: project.name,
      previousPath: project.cwd,
    })),
    bindingHint: bundle.bindingHint || null,
    includesCredentials: false,
    requiresLogin: true,
    requiresRebind: true,
  };
}

export function restoreSafeBackup(inputPath) {
  const source = path.resolve(inputPath);
  const bundle = assertBackup(JSON.parse(fs.readFileSync(source, "utf8")));
  const existing = readJson("projects.json");
  const existingProjects = existing?.projects || [];
  const restored = [];
  const skipped = [];

  for (const project of bundle.projects?.projects || []) {
    if (!fs.existsSync(project.cwd) || !fs.statSync(project.cwd).isDirectory()) {
      skipped.push({ ...project, reason: "原路径在本机不存在，需要在 setup 中重新选择路径" });
      continue;
    }
    const duplicate = existingProjects.some(
      (candidate) => candidate.id === project.id
        || path.resolve(candidate.cwd) === path.resolve(project.cwd),
    );
    if (duplicate) {
      skipped.push({ ...project, reason: "本机已有同 ID 或同路径项目" });
    } else {
      restored.push(project);
    }
  }

  const merged = [...existingProjects, ...restored];
  if (merged.length > 0) {
    writeJsonPrivate("projects.json", assertProjectRegistry({
      version: 1,
      projects: merged,
      updatedAt: new Date().toISOString(),
    }));
  }
  writeJsonPrivate("migration.json", {
    restoredAt: new Date().toISOString(),
    sourceCreatedAt: bundle.createdAt || null,
    projectHints: bundle.projects?.projects || [],
    bindingHint: bundle.bindingHint || null,
    skipped,
  });
  return { source, restored, skipped, requiresLogin: true, requiresRebind: true };
}

export function logoutLocalState() {
  const removed = [];
  for (const name of [
    "credentials.json",
    "binding.json",
    "runtime.json",
    "wechat-login-qr.png",
    "bridge.lock",
  ]) {
    if (removeStateFile(name)) removed.push(name);
  }
  return {
    removed,
    preserved: ["projects.json", "audit.jsonl"],
    serverTokenRevoked: false,
  };
}
