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
  formatDuration,
  formatLocalTime,
  MessageBatchQueue,
  retryDelayMs,
  runtimeSettings,
} from "./runtime-control.mjs";
import {
  extractText,
  getUpdates,
  isSessionExpiredResponse,
  sendText,
  setTyping,
  splitMessage,
} from "./weixin-api.mjs";
import { BRIDGE_VERSION } from "./version.mjs";

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

function waitForDelay(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
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
  const settings = runtimeSettings();
  const messageQueue = new MessageBatchQueue({
    batchWindowMs: settings.batchWindowMs,
  });
  const codex = await new CodexAppServer({ stderr: process.stderr }).start();
  const isolation = await codex.verifyIsolation({ cwd: binding.cwd });
  const pendingApprovals = new Map();
  const pendingSwitches = new Map();
  const itemChanges = new Map();
  let taskSnapshot = null;
  let activeTurn = null;
  let drainTimer = null;
  let connectionFailures = 0;
  let longPollTimeoutMs = 40_000;
  const serviceStartedAt = Date.now();

  log(`微信直连已启动：${binding.cwd}`);
  log(`Codex task: ${binding.threadId}`);
  log(`隔离配置：${isolation.permissionProfile}；MCP=${isolation.mcpServerCount}`);
  log("当前权限：仅当前项目可读；项目内文件写入需要微信单次确认；命令提权禁用。");
  appendAuditPrivate("service_start", {
    projectId: selectedProject.id,
    threadId: binding.threadId,
    permissionProfile: isolation.permissionProfile,
  });

  const deliver = async (target, contextToken, text) => {
    await sendChunks(credentials, target, contextToken, text);
    runtime.lastReplyAt = new Date().toISOString();
    saveRuntimeState(runtime);
  };

  const sendToActive = async (text) => {
    if (!activeTurn) return;
    await deliver(
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
    await deliver(
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
      if (!activeTurn || activeTurn.cancelled) {
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
        activeTurn.lastActivityAt = Date.now();
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

  const setTurnTyping = async (turn, active) => {
    try {
      turn.typingTicket = await setTyping(credentials, {
        userId: turn.from,
        contextToken: turn.contextToken,
        typingTicket: turn.typingTicket,
        active,
      });
    } catch (error) {
      errorLog(`微信输入状态更新失败（不影响任务）：${error.message}`);
    }
  };

  const beginTurnTyping = async (turn) => {
    await setTurnTyping(turn, true);
    if (activeTurn !== turn || turn.cancelled || !turn.typingTicket) return;
    turn.typingKeepalive = setInterval(() => {
      void setTurnTyping(turn, true);
    }, 5_000);
    turn.typingKeepalive.unref?.();
  };

  const clearDrainTimer = () => {
    if (!drainTimer) return;
    clearTimeout(drainTimer);
    drainTimer = null;
  };

  let startTurn;
  const scheduleDrain = () => {
    if (activeTurn || drainTimer || messageQueue.batchCount === 0) return;
    const delay = messageQueue.readyInMs() ?? 0;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      const next = messageQueue.shift();
      if (!next) return;
      startTurn(next);
    }, delay);
    drainTimer.unref?.();
  };

  startTurn = ({ from, contextToken, text, messageCount = 1 }) => {
    const turn = {
      from,
      contextToken,
      turnId: null,
      cancelled: false,
      timedOut: false,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      typingTicket: null,
      messageCount,
    };
    activeTurn = turn;
    void beginTurnTyping(turn);
    appendAuditPrivate("turn_start", {
      projectId: binding.projectId,
      threadId: binding.threadId,
      messageCount,
    });
    const watchdogIntervalMs = Math.min(
      15_000,
      Math.max(1_000, Math.floor(settings.turnIdleTimeoutMs / 4)),
    );
    turn.watchdog = setInterval(() => {
      if (
        activeTurn !== turn
        || turn.cancelled
        || Date.now() - turn.lastActivityAt < settings.turnIdleTimeoutMs
      ) {
        return;
      }
      turn.cancelled = true;
      turn.timedOut = true;
      declineTurnApprovals(turn.turnId, "cancel");
      appendAuditPrivate("turn_watchdog_timeout", {
        projectId: binding.projectId,
        threadId: binding.threadId,
        idleTimeoutMs: settings.turnIdleTimeoutMs,
      });
      if (turn.turnId) {
        void codex.interruptTurn({
          threadId: binding.threadId,
          turnId: turn.turnId,
        }).catch(errorLog);
      }
      void deliver(
        from,
        contextToken,
        `Codex 已连续 ${formatDuration(settings.turnIdleTimeoutMs)}没有进展，任务已自动中断。后续排队消息仍会继续处理。`,
      ).catch(errorLog);
    }, watchdogIntervalMs);
    turn.watchdog.unref?.();
    void codex.runApprovalTurn({
      threadId: binding.threadId,
      cwd: binding.cwd,
      text,
      onStarted(started) {
        turn.turnId = started?.id || turn.turnId;
        turn.lastActivityAt = Date.now();
      },
      onActivity() {
        turn.lastActivityAt = Date.now();
      },
    }).then(async (reply) => {
      if (!turn.cancelled) {
        await deliver(from, contextToken, reply);
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
        await deliver(
          from,
          contextToken,
          `Codex 处理失败：${error.message}`,
        );
      }
    }).finally(async () => {
      clearInterval(turn.watchdog);
      clearInterval(turn.typingKeepalive);
      declineTurnApprovals(turn.turnId);
      await setTurnTyping(turn, false);
      if (activeTurn === turn) activeTurn = null;
      scheduleDrain();
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
        const response = await getUpdates(
          credentials,
          runtime.cursor,
          longPollTimeoutMs,
        );
        if (isSessionExpiredResponse(response)) {
          runtime.connection = {
            state: "authorization-expired",
            failureCount: connectionFailures,
            lastErrorAt: new Date().toISOString(),
            lastError: "微信授权已失效，需要重新扫码",
          };
          saveRuntimeState(runtime);
          throw new Error("微信授权已失效（errcode=-14），请在电脑运行 login 后再运行 service-restart。");
        }
        if (response.get_updates_buf) {
          runtime.cursor = response.get_updates_buf;
          saveRuntimeState(runtime);
        }
        if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
          throw new Error(
            `微信 getUpdates 失败: ret=${response.ret} errcode=${response.errcode} ${response.errmsg || ""}`,
          );
        }
        connectionFailures = 0;
        const suggestedTimeout = Number(response.longpolling_timeout_ms);
        if (Number.isFinite(suggestedTimeout) && suggestedTimeout >= 5_000) {
          longPollTimeoutMs = Math.min(120_000, suggestedTimeout + 5_000);
        }
        runtime.lastPollAt = new Date().toISOString();
        runtime.connection = {
          state: "connected",
          failureCount: 0,
          lastSuccessAt: runtime.lastPollAt,
        };
        saveRuntimeState(runtime);

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
          runtime.lastMessageAt = new Date().toISOString();
          saveRuntimeState(runtime);
          const control = parseControlMessage(text);
          if (control?.action === "accept" || control?.action === "decline") {
            const pending = pendingApprovals.get(control.code);
            const pendingSwitch = pendingSwitches.get(control.code);
            if (!pending && !pendingSwitch) {
              await deliver(from, contextToken, "审批码不存在、已使用或已过期。");
              continue;
            }
            if (pending && pending.expiresAt <= Date.now()) {
              finishApproval(control.code, "decline");
              await deliver(from, contextToken, "审批码已过期，请等待新的请求。");
              continue;
            }
            if (pending) {
              finishApproval(
                control.code,
                control.action === "accept" ? "accept" : "decline",
              );
              await deliver(
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
              await deliver(from, contextToken, "切换确认码已过期，请重新查看任务列表。");
              continue;
            }
            const switchRequest = finishSwitch(control.code);
            if (control.action === "decline") {
              await deliver(from, contextToken, "已取消任务切换。");
              continue;
            }
            if (activeTurn || messageQueue.length || pendingApprovals.size) {
              await deliver(from, contextToken, "当前任务正在运行、排队或等待审批，不能切换。");
              continue;
            }
            const project = projects.find(
              (candidate) => candidate.id === switchRequest.projectId,
            );
            if (!project) {
              await deliver(from, contextToken, "目标项目已不在白名单中，切换已取消。");
              continue;
            }
            const freshThreads = await listProjectThreads(project, 100);
            const thread = freshThreads.find(
              (candidate) => candidate.id === switchRequest.threadId,
            );
            if (!thread) {
              await deliver(from, contextToken, "目标任务已不存在或不属于该项目，切换已取消。");
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
            await deliver(
              from,
              contextToken,
              `已切换。\n项目：${project.name}\n任务：${thread.name || "未命名任务"}\n下一条普通消息将进入这个任务。`,
            );
            continue;
          }
          if (control?.action === "cancel") {
            if (!activeTurn) {
              await deliver(
                from,
                contextToken,
                messageQueue.length
                  ? `当前没有正在运行的任务，但队列中还有 ${messageQueue.length} 条消息。若不再需要，请发送“清空队列”。`
                  : "当前没有正在运行的任务。",
              );
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
            await deliver(from, contextToken, "已取消当前 Codex 任务；排队消息不受影响。");
            continue;
          }
          if (control?.action === "clearQueue") {
            clearDrainTimer();
            const cleared = messageQueue.clear();
            await deliver(
              from,
              contextToken,
              cleared
                ? `已清空 ${cleared} 条排队消息；当前正在运行的任务不受影响。`
                : "队列本来就是空的。",
            );
            continue;
          }
          if (control?.action === "reconnect") {
            connectionFailures = 0;
            runtime.connection = {
              state: "connected",
              failureCount: 0,
              lastSuccessAt: runtime.lastPollAt || new Date().toISOString(),
            };
            saveRuntimeState(runtime);
            await deliver(
              from,
              contextToken,
              "已刷新微信连接状态。当前消息通道可用；若电脑端服务异常，请运行 service-restart。",
            );
            continue;
          }
          if (control?.action === "status") {
            const status = activeTurn
              ? `任务正在运行 ${formatDuration(Date.now() - activeTurn.startedAt)}。`
              : "当前空闲，没有正在运行的任务。";
            const connectionLabels = {
              connected: "正常",
              retrying: `正在重连（连续失败 ${runtime.connection?.failureCount || 0} 次）`,
              "authorization-expired": "微信授权已失效，需要在电脑重新扫码",
            };
            await deliver(
              from,
              contextToken,
              [
                status,
                `队列：${messageQueue.length} 条消息（${messageQueue.batchCount} 批）`,
                `待确认：${pendingApprovals.size} 项`,
                `项目：${binding.projectName || selectedProject.name}`,
                `任务：${binding.threadName || "未命名任务"}`,
                "读取边界：仅当前绑定项目",
                `连接：${connectionLabels[runtime.connection?.state] || "初始化中"}`,
                `最近收取：${formatLocalTime(runtime.lastPollAt)}`,
                `最近回复：${formatLocalTime(runtime.lastReplyAt)}`,
                `服务运行：${formatDuration(Date.now() - serviceStartedAt)}`,
                `版本：${BRIDGE_VERSION}`,
              ].join("\n"),
            );
            continue;
          }
          const routing = parseRoutingMessage(text);
          if (routing?.action === "current") {
            const project = projectForBinding(registry, binding);
            const thread = await resolveCurrentThread();
            await deliver(
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
            await deliver(from, contextToken, routingHelp());
            continue;
          }
          if (routing && (activeTurn || messageQueue.length)) {
            await deliver(
              from,
              contextToken,
              `当前任务正在运行或排队（队列 ${messageQueue.length} 条），暂不能浏览或切换其他任务。可发送“状态”“取消任务”或“清空队列”。`,
            );
            continue;
          }
          if (routing?.action === "projects") {
            const currentProject = projectForBinding(registry, binding);
            await deliver(
              from,
              contextToken,
              formatProjectList(projects, currentProject.id),
            );
            continue;
          }
          if (routing?.action === "selectProject") {
            const project = projects[routing.index - 1];
            if (!project) {
              await deliver(from, contextToken, "项目编号无效，请先发送“项目列表”。");
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
              await deliver(from, contextToken, "任务编号已失效，请重新发送“任务列表”。");
              continue;
            }
            const thread = taskSnapshot.threads[routing.index - 1];
            const project = projects.find(
              (candidate) => candidate.id === taskSnapshot.projectId,
            );
            if (!thread || !project) {
              await deliver(from, contextToken, "任务编号无效，请重新发送“任务列表”。");
              continue;
            }
            if (thread.id === binding.threadId && project.cwd === binding.cwd) {
              await deliver(from, contextToken, "这已经是当前绑定任务。");
              continue;
            }
            for (const code of [...pendingSwitches.keys()]) finishSwitch(code);
            const code = createApprovalCode(allPendingCodes());
            const expiresAt = Date.now() + APPROVAL_TTL_MS;
            const timer = setTimeout(() => {
              const expired = finishSwitch(code);
              if (!expired) return;
              void deliver(
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
            await deliver(
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
          const queued = messageQueue.enqueue({
            from,
            contextToken,
            text,
            projectId: binding.projectId,
            threadId: binding.threadId,
          });
          if (!activeTurn && queued.merged) clearDrainTimer();
          await deliver(
            from,
            contextToken,
            activeTurn
              ? `已加入队列：前方还有 ${Math.max(0, messageQueue.batchCount - 1)} 批，当前队列共 ${messageQueue.length} 条消息。`
              : queued.merged
                ? `已与刚才的消息合并，约 ${formatDuration(settings.batchWindowMs)}后开始处理。`
                : [
                    "已收到，正在等待短消息合并后交给 Codex。",
                    `项目：${binding.projectName || selectedProject.name}`,
                    `任务：${binding.threadName || "未命名任务"}`,
                  ].join("\n"),
          );
          scheduleDrain();
        }
      } catch (error) {
        if (signal?.aborted) break;
        connectionFailures += 1;
        const authorizationExpired = /errcode=-14|授权已失效/.test(error.message);
        const delay = authorizationExpired
          ? Math.max(settings.retryMaxMs, 5 * 60_000)
          : retryDelayMs(connectionFailures, {
            baseMs: settings.retryBaseMs,
            maxMs: settings.retryMaxMs,
          });
        runtime.connection = {
          state: authorizationExpired ? "authorization-expired" : "retrying",
          failureCount: connectionFailures,
          lastErrorAt: new Date().toISOString(),
          lastError: String(error.message || error).slice(0, 300),
          nextRetryAt: new Date(Date.now() + delay).toISOString(),
        };
        saveRuntimeState(runtime);
        errorLog(`${error.message}；${formatDuration(delay)}后重试。`);
        await waitForDelay(delay, signal);
      }
    }
  } finally {
    clearDrainTimer();
    messageQueue.clear();
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
