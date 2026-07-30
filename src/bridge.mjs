import crypto from "node:crypto";

import { CodexAppServer } from "./codex-client.mjs";
import {
  APPROVAL_TTL_MS,
  approvalPrompt,
  assessApprovalRequest,
  createApprovalCode,
  parseControlMessage,
} from "./approval-policy.mjs";
import {
  TASK_SNAPSHOT_TTL_MS,
  assertProjectRegistry,
  enabledProjects,
  formatCurrentBinding,
  formatProjectList,
  formatTaskList,
  parseRoutingMessage,
  projectForBinding,
  routingHelp,
} from "./routing.mjs";
import {
  acquireProcessLock,
  appendAuditPrivate,
  assertBinding,
  readJson,
  writeJsonPrivate,
} from "./state.mjs";
import {
  extractText,
  getUpdates,
  sendText,
  splitMessage,
} from "./weixin-api.mjs";

function messageKey(message) {
  return String(message?.message_id || message?.client_id || "");
}

function auditMessageKey(key) {
  return key
    ? crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)
    : null;
}

function loadRuntimeState() {
  return readJson("runtime.json") || {
    cursor: "",
    recentMessageIds: [],
    contextTokens: {},
  };
}

function saveRuntimeState(state) {
  state.recentMessageIds = state.recentMessageIds.slice(-500);
  writeJsonPrivate("runtime.json", state);
}

async function sendChunks(credentials, target, contextToken, text) {
  for (const chunk of splitMessage(text)) {
    await sendText(credentials, { to: target, contextToken, text: chunk });
  }
}

async function runBridgeLocked({
  signal,
  log = console.log,
  errorLog = console.error,
} = {}) {
  const credentials = readJson("credentials.json", { required: true });
  let binding = assertBinding(readJson("binding.json", { required: true }));
  const registry = assertProjectRegistry(
    readJson("projects.json", { required: true }),
  );
  const projects = enabledProjects(registry);
  let selectedProject = projectForBinding(registry, binding);
  const runtime = loadRuntimeState();
  const seen = new Set(runtime.recentMessageIds);
  const codex = await new CodexAppServer({ stderr: process.stderr }).start();
  const isolation = await codex.verifyIsolation({ cwd: binding.cwd });
  const pendingApprovals = new Map();
  const pendingSwitches = new Map();
  const itemChanges = new Map();
  let taskSnapshot = null;
  let activeTurn = null;

  log(`微信直连已启动：${binding.cwd}`);
  log(`Codex task: ${binding.threadId}`);
  log(`隔离配置：${isolation.permissionProfile}；MCP=${isolation.mcpServerCount}`);
  log("当前权限：仅当前项目可读；项目内文件写入需要微信单次确认；命令提权禁用。");
  appendAuditPrivate("service_start", {
    projectId: selectedProject.id,
    threadId: binding.threadId,
    permissionProfile: isolation.permissionProfile,
  });

  const sendToActive = async (text) => {
    if (!activeTurn) return;
    await sendChunks(
      credentials,
      activeTurn.from,
      activeTurn.contextToken,
      text,
    );
  };

  const finishApproval = (code, decision) => {
    const pending = pendingApprovals.get(code);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingApprovals.delete(code);
    const result = decision === "accept"
      ? pending.acceptResult || { decision: "accept" }
      : pending.declineResult || { decision };
    codex.respondToServerRequest(pending.request.id, result);
    appendAuditPrivate("approval_decision", {
      projectId: binding.projectId,
      threadId: binding.threadId,
      type: pending.type,
      decision,
    });
    return true;
  };

  const finishSwitch = (code) => {
    const pending = pendingSwitches.get(code);
    if (!pending) return null;
    clearTimeout(pending.timer);
    pendingSwitches.delete(code);
    return pending;
  };

  const allPendingCodes = () => new Set([
    ...pendingApprovals.keys(),
    ...pendingSwitches.keys(),
  ]);

  const declineTurnApprovals = (turnId, decision = "decline") => {
    for (const [code, pending] of pendingApprovals) {
      if (!turnId || pending.request.params?.turnId === turnId) {
        finishApproval(code, decision);
      }
    }
  };

  const listProjectThreads = async (project, limit = 10) => {
    const result = await codex.listThreads({
      cwd: project.cwd,
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    return (result.data || []).filter(
      (thread) => thread.cwd === project.cwd && !thread.ephemeral,
    );
  };

  const showTaskList = async (from, contextToken, project) => {
    const threads = await listProjectThreads(project);
    taskSnapshot = {
      projectId: project.id,
      threads,
      expiresAt: Date.now() + TASK_SNAPSHOT_TTL_MS,
    };
    await sendChunks(
      credentials,
      from,
      contextToken,
      formatTaskList(project, threads, binding.threadId),
    );
  };

  const resolveCurrentThread = async () => {
    const threads = await listProjectThreads(
      projectForBinding(registry, binding),
      100,
    );
    return threads.find((thread) => thread.id === binding.threadId) || null;
  };

  codex.on("item/fileChange/patchUpdated", (params) => {
    if (params?.itemId) itemChanges.set(params.itemId, params.changes || []);
  });
  codex.on("item/started", (params) => {
    if (params?.item?.type === "fileChange" && params.item.id) {
      itemChanges.set(params.item.id, params.item.changes || []);
    }
  });
  codex.on("turn/started", (params) => {
    if (activeTurn && params?.threadId === binding.threadId) {
      activeTurn.turnId = params.turn?.id || params.turnId || activeTurn.turnId;
      if (activeTurn.cancelled && activeTurn.turnId) {
        void codex.interruptTurn({
          threadId: binding.threadId,
          turnId: activeTurn.turnId,
        }).catch(errorLog);
      }
    }
  });
  codex.on("serverRequest", (request) => {
    void (async () => {
      if (!activeTurn) {
        if ([
          "item/fileChange/requestApproval",
          "item/commandExecution/requestApproval",
          "item/permissions/requestApproval",
        ].includes(request.method)) {
          const result = request.method === "item/permissions/requestApproval"
            ? { permissions: {}, scope: "turn" }
            : { decision: "decline" };
          codex.respondToServerRequest(request.id, result);
        } else {
          codex.rejectServerRequest(request.id, "当前没有正在运行的微信任务。");
        }
        return;
      }
      if (activeTurn && request.params?.turnId) {
        activeTurn.turnId = request.params.turnId;
      }
      const changes = itemChanges.get(request.params?.itemId) || [];
      const assessment = assessApprovalRequest({ request, binding, changes });
      if (!assessment.allowed) {
        const decision = [
          "item/fileChange/requestApproval",
          "item/commandExecution/requestApproval",
          "item/permissions/requestApproval",
        ].includes(request.method) ? { decision: "decline" } : null;
        if (decision) {
          const result = request.method === "item/permissions/requestApproval"
            ? { permissions: {}, scope: "turn" }
            : decision;
          codex.respondToServerRequest(request.id, result);
        }
        else codex.rejectServerRequest(request.id, assessment.reason);
        await sendToActive(`已自动拦截一项请求：${assessment.reason}。`);
        errorLog(`审批请求已自动拒绝：${assessment.reason}`);
        return;
      }

      const code = createApprovalCode(allPendingCodes());
      const expiresAt = Date.now() + APPROVAL_TTL_MS;
      const timer = setTimeout(() => {
        if (!finishApproval(code, "decline")) return;
        void sendToActive(`审批码 ${code} 已过期，该请求已自动拒绝。`)
          .catch(errorLog);
      }, APPROVAL_TTL_MS);
      timer.unref?.();
      pendingApprovals.set(code, {
        request,
        type: assessment.type,
        acceptResult: assessment.acceptResult,
        declineResult: assessment.declineResult,
        expiresAt,
        timer,
      });
      appendAuditPrivate("approval_requested", {
        projectId: binding.projectId,
        threadId: binding.threadId,
        type: assessment.type,
      });
      try {
        await sendToActive(approvalPrompt({
          code,
          summary: assessment.summary,
          expiresAt,
        }));
      } catch (error) {
        finishApproval(code, "decline");
        throw error;
      }
      log(`已发送一次性审批请求：type=${assessment.type}`);
    })().catch((error) => {
      errorLog(error);
    });
  });

  const startTurn = ({ from, contextToken, text }) => {
    const turn = {
      from,
      contextToken,
      turnId: null,
      cancelled: false,
    };
    activeTurn = turn;
    appendAuditPrivate("turn_start", {
      projectId: binding.projectId,
      threadId: binding.threadId,
    });
    void codex.runApprovalTurn({
      threadId: binding.threadId,
      cwd: binding.cwd,
      text,
    }).then(async (reply) => {
      if (!turn.cancelled) {
        await sendChunks(credentials, from, contextToken, reply);
        log("Codex 回复已发送到微信。");
        appendAuditPrivate("turn_completed", {
          projectId: binding.projectId,
          threadId: binding.threadId,
        });
      }
    }).catch(async (error) => {
      errorLog(error);
      appendAuditPrivate("turn_failed", {
        projectId: binding.projectId,
        threadId: binding.threadId,
        error: error.message.slice(0, 300),
      });
      if (!turn.cancelled) {
        await sendChunks(
          credentials,
          from,
          contextToken,
          `Codex 处理失败：${error.message}`,
        );
      }
    }).finally(() => {
      declineTurnApprovals(turn.turnId);
      if (activeTurn === turn) activeTurn = null;
    });
  };

  try {
    const currentThread = await resolveCurrentThread();
    if (!currentThread) {
      throw new Error("当前绑定任务不存在，或任务不属于当前项目。");
    }
    if (binding.threadName !== (currentThread.name || "未命名任务")) {
      binding = {
        ...binding,
        threadName: currentThread.name || "未命名任务",
        updatedAt: new Date().toISOString(),
      };
      writeJsonPrivate("binding.json", binding);
    }

    while (!signal?.aborted) {
      try {
        const response = await getUpdates(credentials, runtime.cursor);
        if (response.get_updates_buf) {
          runtime.cursor = response.get_updates_buf;
          saveRuntimeState(runtime);
        }
        if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
          throw new Error(
            `微信 getUpdates 失败: ret=${response.ret} errcode=${response.errcode} ${response.errmsg || ""}`,
          );
        }

        for (const message of response.msgs || []) {
          const key = messageKey(message);
          if (key && seen.has(key)) continue;
          if (key) {
            seen.add(key);
            runtime.recentMessageIds.push(key);
          }

          const from = message.from_user_id || "";
          const contextToken = message.context_token || runtime.contextTokens[from];
          if (from && contextToken) runtime.contextTokens[from] = contextToken;
          saveRuntimeState(runtime);

          if (from !== credentials.allowedUserId) {
            errorLog(`已忽略未授权微信用户: ${from || "(unknown)"}`);
            continue;
          }
          const text = extractText(message);
          if (!text) continue;

          log(`收到微信消息：id=${key || "(unknown)"} length=${text.length}`);
          appendAuditPrivate("message_received", {
            messageKey: auditMessageKey(key),
            projectId: binding.projectId,
            threadId: binding.threadId,
            length: text.length,
          });
          const control = parseControlMessage(text);
          if (control?.action === "accept" || control?.action === "decline") {
            const pending = pendingApprovals.get(control.code);
            const pendingSwitch = pendingSwitches.get(control.code);
            if (!pending && !pendingSwitch) {
              await sendChunks(credentials, from, contextToken, "审批码不存在、已使用或已过期。");
              continue;
            }
            if (pending && pending.expiresAt <= Date.now()) {
              finishApproval(control.code, "decline");
              await sendChunks(credentials, from, contextToken, "审批码已过期，请等待新的请求。");
              continue;
            }
            if (pending) {
              finishApproval(
                control.code,
                control.action === "accept" ? "accept" : "decline",
              );
              await sendChunks(
                credentials,
                from,
                contextToken,
                control.action === "accept"
                  ? "已同意这一次请求，Codex 正在继续处理。"
                  : "已拒绝这一次请求，Codex 会继续寻找不需要该操作的方案。",
              );
              continue;
            }

            if (pendingSwitch.expiresAt <= Date.now()) {
              finishSwitch(control.code);
              await sendChunks(credentials, from, contextToken, "切换确认码已过期，请重新查看任务列表。");
              continue;
            }
            const switchRequest = finishSwitch(control.code);
            if (control.action === "decline") {
              await sendChunks(credentials, from, contextToken, "已取消任务切换。");
              continue;
            }
            if (activeTurn || pendingApprovals.size) {
              await sendChunks(credentials, from, contextToken, "当前任务正在运行或等待审批，不能切换。");
              continue;
            }
            const project = projects.find(
              (candidate) => candidate.id === switchRequest.projectId,
            );
            if (!project) {
              await sendChunks(credentials, from, contextToken, "目标项目已不在白名单中，切换已取消。");
              continue;
            }
            const freshThreads = await listProjectThreads(project, 100);
            const thread = freshThreads.find(
              (candidate) => candidate.id === switchRequest.threadId,
            );
            if (!thread) {
              await sendChunks(credentials, from, contextToken, "目标任务已不存在或不属于该项目，切换已取消。");
              continue;
            }
            const nextBinding = {
              ...binding,
              cwd: project.cwd,
              threadId: thread.id,
              projectId: project.id,
              projectName: project.name,
              threadName: thread.name || "未命名任务",
              mode: "approvalV1",
              updatedAt: new Date().toISOString(),
            };
            projectForBinding(registry, nextBinding);
            writeJsonPrivate("binding.json", nextBinding);
            binding = nextBinding;
            selectedProject = project;
            taskSnapshot = null;
            log(`微信绑定已切换：project=${project.id}`);
            appendAuditPrivate("binding_switched", {
              projectId: project.id,
              threadId: thread.id,
            });
            await sendChunks(
              credentials,
              from,
              contextToken,
              `已切换。\n项目：${project.name}\n任务：${thread.name || "未命名任务"}\n下一条普通消息将进入这个任务。`,
            );
            continue;
          }
          if (control?.action === "cancel") {
            if (!activeTurn) {
              await sendChunks(credentials, from, contextToken, "当前没有正在运行的任务。");
              continue;
            }
            activeTurn.cancelled = true;
            declineTurnApprovals(activeTurn.turnId, "cancel");
            if (activeTurn.turnId) {
              await codex.interruptTurn({
                threadId: binding.threadId,
                turnId: activeTurn.turnId,
              });
            }
            await sendChunks(credentials, from, contextToken, "已取消当前 Codex 任务。");
            continue;
          }
          if (control?.action === "status") {
            const status = activeTurn
              ? `任务正在运行；待确认请求 ${pendingApprovals.size} 项。`
              : "当前空闲，没有正在运行的任务。";
            await sendChunks(
              credentials,
              from,
              contextToken,
              [
                status,
                `项目：${binding.projectName || selectedProject.name}`,
                `任务：${binding.threadName || "未命名任务"}`,
                "读取边界：仅当前绑定项目",
              ].join("\n"),
            );
            continue;
          }
          const routing = parseRoutingMessage(text);
          if (routing?.action === "current") {
            const project = projectForBinding(registry, binding);
            const thread = await resolveCurrentThread();
            await sendChunks(
              credentials,
              from,
              contextToken,
              formatCurrentBinding({
                project,
                thread,
                active: Boolean(activeTurn),
                pendingCount: pendingApprovals.size,
              }),
            );
            continue;
          }
          if (routing?.action === "help") {
            await sendChunks(credentials, from, contextToken, routingHelp());
            continue;
          }
          if (routing && activeTurn) {
            await sendChunks(
              credentials,
              from,
              contextToken,
              "当前任务正在运行，暂不能浏览或切换其他任务。可发送“当前任务”或“取消任务”。",
            );
            continue;
          }
          if (routing?.action === "projects") {
            const currentProject = projectForBinding(registry, binding);
            await sendChunks(
              credentials,
              from,
              contextToken,
              formatProjectList(projects, currentProject.id),
            );
            continue;
          }
          if (routing?.action === "selectProject") {
            const project = projects[routing.index - 1];
            if (!project) {
              await sendChunks(credentials, from, contextToken, "项目编号无效，请先发送“项目列表”。");
              continue;
            }
            selectedProject = project;
            await showTaskList(from, contextToken, project);
            continue;
          }
          if (routing?.action === "tasks") {
            await showTaskList(from, contextToken, selectedProject);
            continue;
          }
          if (routing?.action === "requestSwitch") {
            if (!taskSnapshot || taskSnapshot.expiresAt <= Date.now()) {
              taskSnapshot = null;
              await sendChunks(credentials, from, contextToken, "任务编号已失效，请重新发送“任务列表”。");
              continue;
            }
            const thread = taskSnapshot.threads[routing.index - 1];
            const project = projects.find(
              (candidate) => candidate.id === taskSnapshot.projectId,
            );
            if (!thread || !project) {
              await sendChunks(credentials, from, contextToken, "任务编号无效，请重新发送“任务列表”。");
              continue;
            }
            if (thread.id === binding.threadId && project.cwd === binding.cwd) {
              await sendChunks(credentials, from, contextToken, "这已经是当前绑定任务。");
              continue;
            }
            for (const code of [...pendingSwitches.keys()]) finishSwitch(code);
            const code = createApprovalCode(allPendingCodes());
            const expiresAt = Date.now() + APPROVAL_TTL_MS;
            const timer = setTimeout(() => {
              const expired = finishSwitch(code);
              if (!expired) return;
              void sendChunks(
                credentials,
                from,
                contextToken,
                "任务切换确认码已过期，未发生切换。",
              ).catch(errorLog);
            }, APPROVAL_TTL_MS);
            timer.unref?.();
            pendingSwitches.set(code, {
              projectId: project.id,
              threadId: thread.id,
              expiresAt,
              timer,
            });
            await sendChunks(
              credentials,
              from,
              contextToken,
              [
                "【确认切换任务】",
                `项目：${project.name}`,
                `任务：${thread.name || "未命名任务"}`,
                "",
                `确认请回复：同意 ${code}`,
                `取消请回复：拒绝 ${code}`,
                "确认码约 5 分钟后失效。",
              ].join("\n"),
            );
            continue;
          }
          if (activeTurn) {
            await sendChunks(
              credentials,
              from,
              contextToken,
              `上一项任务仍在运行（待确认 ${pendingApprovals.size} 项）。可回复“状态”查看，或回复“取消任务”。`,
            );
            continue;
          }
          await sendChunks(
            credentials,
            from,
            contextToken,
            [
              "已收到，正在交给绑定的 Codex 任务处理。",
              `项目：${binding.projectName || selectedProject.name}`,
              `任务：${binding.threadName || "未命名任务"}`,
            ].join("\n"),
          );
          startTurn({ from, contextToken, text });
        }
      } catch (error) {
        if (signal?.aborted) break;
        errorLog(error);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  } finally {
    declineTurnApprovals(null, "cancel");
    for (const code of [...pendingSwitches.keys()]) finishSwitch(code);
    if (activeTurn?.turnId) {
      await codex.interruptTurn({
        threadId: binding.threadId,
        turnId: activeTurn.turnId,
      }).catch(errorLog);
    }
    await codex.close();
    appendAuditPrivate("service_stop", {
      projectId: binding.projectId,
      threadId: binding.threadId,
    });
  }
}

export async function runBridge(options = {}) {
  const releaseLock = acquireProcessLock();
  try {
    return await runBridgeLocked(options);
  } finally {
    releaseLock();
  }
}
