import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertBinding } from "../src/state.mjs";
import { extractText, splitMessage } from "../src/weixin-api.mjs";
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
  assert.equal(parseControlMessage("同意"), null);
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
