export const DEFAULT_BATCH_WINDOW_MS = 2_500;
export const DEFAULT_TURN_IDLE_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_RETRY_BASE_MS = 1_000;
export const DEFAULT_RETRY_MAX_MS = 60_000;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function runtimeSettings(env = process.env) {
  return {
    batchWindowMs: positiveInteger(
      env.CODEX_WEIXIN_BATCH_WINDOW_MS,
      DEFAULT_BATCH_WINDOW_MS,
    ),
    turnIdleTimeoutMs: positiveInteger(
      env.CODEX_WEIXIN_TURN_IDLE_TIMEOUT_MS,
      DEFAULT_TURN_IDLE_TIMEOUT_MS,
    ),
    retryBaseMs: positiveInteger(
      env.CODEX_WEIXIN_RETRY_BASE_MS,
      DEFAULT_RETRY_BASE_MS,
    ),
    retryMaxMs: positiveInteger(
      env.CODEX_WEIXIN_RETRY_MAX_MS,
      DEFAULT_RETRY_MAX_MS,
    ),
  };
}

export function retryDelayMs(
  attempt,
  {
    baseMs = DEFAULT_RETRY_BASE_MS,
    maxMs = DEFAULT_RETRY_MAX_MS,
    random = Math.random,
  } = {},
) {
  const exponent = Math.max(0, Number(attempt || 1) - 1);
  const capped = Math.min(maxMs, baseMs * (2 ** exponent));
  const jitter = 0.8 + (Math.max(0, Math.min(1, random())) * 0.4);
  return Math.min(maxMs, Math.max(baseMs, Math.round(capped * jitter)));
}

export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`;
}

export function formatLocalTime(value) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  return date.toLocaleString("zh-CN", { hour12: false });
}

export class MessageBatchQueue {
  constructor({ batchWindowMs = DEFAULT_BATCH_WINDOW_MS } = {}) {
    this.batchWindowMs = batchWindowMs;
    this.items = [];
  }

  get length() {
    return this.items.reduce((total, item) => total + item.messageCount, 0);
  }

  get batchCount() {
    return this.items.length;
  }

  enqueue(message, now = Date.now()) {
    const item = {
      ...message,
      receivedAt: now,
      messageCount: 1,
    };
    const previous = this.items.at(-1);
    const sameDestination = previous
      && previous.from === item.from
      && previous.projectId === item.projectId
      && previous.threadId === item.threadId;
    if (
      sameDestination
      && now - previous.receivedAt <= this.batchWindowMs
    ) {
      previous.text = `${previous.text}\n${item.text}`;
      previous.contextToken = item.contextToken || previous.contextToken;
      previous.receivedAt = now;
      previous.messageCount += 1;
      return { merged: true, item: previous };
    }
    this.items.push(item);
    return { merged: false, item };
  }

  readyInMs(now = Date.now()) {
    const first = this.items[0];
    if (!first) return null;
    return Math.max(0, this.batchWindowMs - (now - first.receivedAt));
  }

  shift() {
    return this.items.shift() || null;
  }

  clear() {
    const count = this.length;
    this.items = [];
    return count;
  }
}
