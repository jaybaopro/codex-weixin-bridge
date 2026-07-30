import path from "node:path";

export const TASK_SNAPSHOT_TTL_MS = 5 * 60 * 1000;

export function assertProjectRegistry(registry) {
  if (!registry || typeof registry !== "object" || !Array.isArray(registry.projects)) {
    throw new Error("项目白名单配置无效，请先运行 project-add。");
  }
  if (registry.projects.length === 0) {
    throw new Error("项目白名单不能为空。");
  }
  if (registry.projects.length > 20) {
    throw new Error("项目白名单最多允许 20 个项目。");
  }

  const ids = new Set();
  const roots = [];
  const projects = registry.projects.map((project) => {
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(project?.id || "")) {
      throw new Error(`项目 id 无效：${project?.id || "(empty)"}`);
    }
    if (!project?.name || typeof project.name !== "string") {
      throw new Error(`项目 ${project.id} 缺少名称。`);
    }
    if (!path.isAbsolute(project?.cwd || "")) {
      throw new Error(`项目 ${project.id} 的 cwd 必须是绝对路径。`);
    }
    const cwd = path.resolve(project.cwd);
    if (ids.has(project.id)) throw new Error(`项目 id 重复：${project.id}`);
    const overlap = roots.find(
      (root) => isPathInside(root, cwd) || isPathInside(cwd, root),
    );
    if (overlap) throw new Error(`项目路径不能重叠：${overlap} 与 ${cwd}`);
    ids.add(project.id);
    roots.push(cwd);
    return {
      id: project.id,
      name: project.name.trim().slice(0, 80),
      cwd,
      permissionPolicy: "approvalV1",
      enabled: project.enabled !== false,
    };
  });

  return {
    version: 1,
    projects,
    updatedAt: registry.updatedAt || null,
  };
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function enabledProjects(registry) {
  return assertProjectRegistry(registry).projects.filter((project) => project.enabled);
}

export function projectForBinding(registry, binding) {
  const projects = enabledProjects(registry);
  const byId = binding.projectId
    ? projects.find((project) => project.id === binding.projectId)
    : null;
  const project = byId || projects.find(
    (candidate) => path.resolve(candidate.cwd) === path.resolve(binding.cwd),
  );
  if (!project || project.cwd !== path.resolve(binding.cwd)) {
    throw new Error("当前绑定不属于已启用的项目白名单。");
  }
  return project;
}

export function parseRoutingMessage(text) {
  const normalized = String(text || "").trim();
  if (/^当前任务$/.test(normalized)) return { action: "current" };
  if (/^项目列表$/.test(normalized)) return { action: "projects" };
  if (/^任务列表$/.test(normalized)) return { action: "tasks" };
  if (/^(帮助|\/帮助|\/help)$/i.test(normalized)) return { action: "help" };

  let match = normalized.match(/^项目\s+(\d{1,2})$/);
  if (match) return { action: "selectProject", index: Number(match[1]) };
  match = normalized.match(/^切换\s+(\d{1,2})$/);
  if (match) return { action: "requestSwitch", index: Number(match[1]) };
  return null;
}

export function formatProjectList(projects, currentProjectId) {
  const lines = projects.map((project, index) => {
    const marker = project.id === currentProjectId ? "（当前）" : "";
    return `${index + 1}. ${project.name}${marker}`;
  });
  return [
    "【项目白名单】",
    ...lines,
    "",
    "查看某个项目：项目 1",
  ].join("\n");
}

function formatUpdatedAt(seconds) {
  if (!Number.isFinite(seconds)) return "";
  return new Date(seconds * 1000).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatTaskList(project, threads, currentThreadId) {
  const lines = threads.map((thread, index) => {
    const marker = thread.id === currentThreadId ? "（当前）" : "";
    const updated = formatUpdatedAt(thread.updatedAt);
    return `${index + 1}. ${thread.name || "未命名任务"}${marker}${updated ? ` · ${updated}` : ""}`;
  });
  return [
    `【${project.name}｜最近任务】`,
    ...(lines.length ? lines : ["暂无可用任务"]),
    "",
    "切换任务：切换 3",
    "列表和编号约 5 分钟后失效。",
  ].join("\n");
}

export function formatCurrentBinding({ project, thread, active, pendingCount = 0 }) {
  return [
    "【当前连接】",
    `项目：${project.name}`,
    `任务：${thread?.name || "未命名任务"}`,
    `状态：${active ? `运行中（待确认 ${pendingCount} 项）` : "空闲"}`,
    "读取：仅当前绑定项目",
    "权限：项目内文件写入逐次确认；命令提权禁用",
    "协作：同一任务请勿同时在桌面端与微信发起操作",
  ].join("\n");
}

export function routingHelp() {
  return [
    "【微信直连命令】",
    "当前任务",
    "项目列表",
    "项目 1",
    "任务列表",
    "切换 3",
    "状态",
    "取消任务",
    "清空队列",
    "重连",
  ].join("\n");
}
