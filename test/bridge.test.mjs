import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertBinding } from "../src/state.mjs";
import {
  extractText,
  isSessionExpiredResponse,
  splitMessage,
} from "../src/weixin-api.mjs";
import {
  assessApprovalRequest,
  isWithinRoot,
  parseControlMessage,
} from "../src/approval-policy.mjs";
import {
  assertProjectRegistry,
  formatTaskList,
  parseRoutingMessage,
  projectForBinding,
} from "../src/routing.mjs";
import {
  formatDuration,
  MessageBatchQueue,
  retryDelayMs,
  runtimeSettings,
} from "../src/runtime-control.mjs";

const testRoot = path.resolve("test-runtime");
const projectRoot = path.join(testRoot, "project");
const otherRoot = path.join(testRoot, "other");
const project7Root = path.join(testRoot, "project-7");

test("extractText accepts only inbound user text", () => {
  assert.equal(
    extractText({
      message_type: 1,
      item_list: [
        { type: 1, text_item: { text: "第一段" } },
        { type: 2, image_item: {} },
        { type: 1, text_item: { text: "第二段" } },
      ],
    }),
    "第一段\n第二段",
  );
  assert.equal(extractText({ message_type: 2, item_list: [] }), "");
});

test("splitMessage preserves all text across chunks", () => {
  const text = `${"甲".repeat(12)}\n${"乙".repeat(12)}`;
  const chunks = splitMessage(text, 15);
  assert.deepEqual(chunks, ["甲".repeat(12), "乙".repeat(12)]);
});

test("assertBinding requires an absolute cwd and thread id", () => {
  assert.deepEqual(
    assertBinding({ cwd: projectRoot, threadId: "thread-1" }),
    { cwd: projectRoot, threadId: "thread-1" },
  );
  assert.throws(
    () => assertBinding({ cwd: "relative", threadId: "thread-1" }),
    /绝对路径/,
  );
});

test("approval control messages are explicit and code-scoped", () => {
  assert.deepEqual(parseControlMessage("同意 4821"), {
    action: "accept",
    code: "4821",
  });
  assert.deepEqual(parseControlMessage("拒绝4821"), {
    action: "decline",
    code: "4821",
  });
  assert.deepEqual(parseControlMessage("取消任务"), { action: "cancel" });
  assert.deepEqual(parseControlMessage("清空队列"), { action: "clearQueue" });
  assert.deepEqual(parseControlMessage("重连"), { action: "reconnect" });
  assert.equal(parseControlMessage("同意"), null);
});

test("message queue batches nearby text and preserves later requests", () => {
  const queue = new MessageBatchQueue({ batchWindowMs: 2_500 });
  const destination = {
    from: "user-1",
    contextToken: "context-1",
    projectId: "project-1",
    threadId: "thread-1",
  };
  assert.equal(queue.enqueue({ ...destination, text: "第一句" }, 1_000).merged, false);
  assert.equal(queue.enqueue({ ...destination, text: "第二句" }, 2_000).merged, true);
  assert.equal(queue.enqueue({ ...destination, text: "第三句" }, 5_000).merged, false);
  assert.equal(queue.length, 3);
  assert.equal(queue.batchCount, 2);
  assert.equal(queue.shift().text, "第一句\n第二句");
  assert.equal(queue.clear(), 1);
  assert.equal(queue.length, 0);
});

test("retry backoff is capped and jittered within the safe range", () => {
  assert.equal(retryDelayMs(1, {
    baseMs: 1_000,
    maxMs: 60_000,
    random: () => 0,
  }), 1_000);
  assert.equal(retryDelayMs(3, {
    baseMs: 1_000,
    maxMs: 60_000,
    random: () => 0.5,
  }), 4_000);
  assert.equal(retryDelayMs(20, {
    baseMs: 1_000,
    maxMs: 60_000,
    random: () => 1,
  }), 60_000);
});

test("runtime settings reject invalid overrides and format durations", () => {
  const settings = runtimeSettings({
    CODEX_WEIXIN_BATCH_WINDOW_MS: "1500",
    CODEX_WEIXIN_TURN_IDLE_TIMEOUT_MS: "bad",
    CODEX_WEIXIN_RETRY_BASE_MS: "2000",
    CODEX_WEIXIN_RETRY_MAX_MS: "-1",
  });
  assert.equal(settings.batchWindowMs, 1_500);
  assert.equal(settings.turnIdleTimeoutMs, 10 * 60_000);
  assert.equal(settings.retryBaseMs, 2_000);
  assert.equal(settings.retryMaxMs, 60_000);
  assert.equal(formatDuration(125_000), "2 分 5 秒");
});

test("Weixin session timeout response is recognized explicitly", () => {
  assert.equal(isSessionExpiredResponse({ errcode: -14 }), true);
  assert.equal(isSessionExpiredResponse({ errcode: 0 }), false);
});

test("project boundary rejects sibling and parent paths", () => {
  assert.equal(isWithinRoot(projectRoot, path.join(projectRoot, "a.txt")), true);
  assert.equal(isWithinRoot(projectRoot, `${projectRoot}-2${path.sep}a.txt`), false);
  assert.equal(isWithinRoot(projectRoot, path.join(testRoot, "a.txt")), false);
});

test("approval policy allows project file edits but blocks deletion and command escalation", () => {
  const binding = { cwd: projectRoot, threadId: "thread-1" };
  const fileRequest = {
    method: "item/fileChange/requestApproval",
    params: { threadId: "thread-1", itemId: "item-1" },
  };
  assert.equal(assessApprovalRequest({
    request: fileRequest,
    binding,
    changes: [{ path: "notes.txt", kind: { type: "add" }, diff: "+ok" }],
  }).allowed, true);
  assert.match(assessApprovalRequest({
    request: fileRequest,
    binding,
    changes: [{ path: "notes.txt", kind: { type: "delete" }, diff: "-old" }],
  }).reason, /禁止删除/);

  const commandRequest = {
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      cwd: projectRoot,
      command: "curl https://example.com",
    },
  };
  assert.match(assessApprovalRequest({
    request: commandRequest,
    binding,
  }).reason, /网络/);

  commandRequest.params.command = "npm test";
  assert.match(assessApprovalRequest({
    request: commandRequest,
    binding,
  }).reason, /禁止传统命令提权/);
});

test("routing commands use short indexes instead of arbitrary ids", () => {
  assert.deepEqual(parseRoutingMessage("当前任务"), { action: "current" });
  assert.deepEqual(parseRoutingMessage("项目 2"), {
    action: "selectProject",
    index: 2,
  });
  assert.deepEqual(parseRoutingMessage("切换 3"), {
    action: "requestSwitch",
    index: 3,
  });
  assert.equal(parseRoutingMessage("切换 thread-secret"), null);
});

test("project registry is explicit and binding must match its cwd", () => {
  const registry = assertProjectRegistry({
    version: 1,
    projects: [{
      id: "project-7",
      name: "项目 7",
      cwd: project7Root,
      enabled: true,
    }],
  });
  assert.equal(projectForBinding(registry, {
    projectId: "project-7",
    cwd: project7Root,
    threadId: "thread-1",
  }).name, "项目 7");
  assert.throws(() => projectForBinding(registry, {
    projectId: "project-7",
    cwd: otherRoot,
    threadId: "thread-1",
  }), /白名单/);
});

test("project registry rejects nested or overlapping project roots", () => {
  assert.throws(() => assertProjectRegistry({
    version: 1,
    projects: [
      {
        id: "parent",
        name: "父项目",
        cwd: path.join(testRoot, "projects"),
        enabled: true,
      },
      {
        id: "child",
        name: "子项目",
        cwd: path.join(testRoot, "projects", "child"),
        enabled: true,
      },
    ],
  }), /不能重叠/);
});

test("permission escalation can grant only project-local writes", () => {
  const binding = { cwd: projectRoot, threadId: "thread-1" };
  const base = {
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread-1",
      cwd: projectRoot,
      permissions: {
        fileSystem: {
          entries: [{
            access: "write",
            path: { type: "path", path: path.join(projectRoot, "notes.txt") },
          }],
        },
      },
    },
  };
  const allowed = assessApprovalRequest({ request: base, binding });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.acceptResult.scope, "turn");

  const outside = structuredClone(base);
  outside.params.permissions.fileSystem.entries[0].path.path = path.join(otherRoot, "data.txt");
  assert.match(
    assessApprovalRequest({ request: outside, binding }).reason,
    /超出当前项目/,
  );

  const network = structuredClone(base);
  network.params.permissions.network = { enabled: true };
  assert.match(
    assessApprovalRequest({ request: network, binding }).reason,
    /禁止网络/,
  );
});

test("task list reveals titles and indexes but not full thread ids", () => {
  const text = formatTaskList(
    { name: "项目 7" },
    [{
      id: "019fa97e-secret-thread-id",
      name: "微信接入",
      updatedAt: 1785284850,
    }],
    "other-thread",
  );
  assert.match(text, /1\. 微信接入/);
  assert.doesNotMatch(text, /019fa97e/);
});
