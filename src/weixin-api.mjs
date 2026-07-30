import crypto from "node:crypto";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const CHANNEL_VERSION = "2.1.7";
const ILINK_APP_ID = "bot";

function clientVersion(version = CHANNEL_VERSION) {
  const [major = 0, minor = 0, patch = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

function normalizeBaseUrl(value) {
  if (!value) return DEFAULT_BASE_URL;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withScheme.endsWith("/") ? withScheme.slice(0, -1) : withScheme;
}

function randomWechatUin() {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

function commonHeaders() {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(clientVersion()),
  };
}

async function requestText(url, {
  method = "GET",
  token,
  body,
  timeoutMs = 15_000,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const bodyText = body == null ? undefined : JSON.stringify(body);
  const headers = {
    ...commonHeaders(),
    ...(bodyText == null
      ? {}
      : {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(bodyText, "utf8")),
          AuthorizationType: "ilink_bot_token",
          "X-WECHAT-UIN": randomWechatUin(),
        }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: bodyText,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${url} 返回 ${response.status}: ${text.slice(0, 300)}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(url, options) {
  const text = await requestText(url, options);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`微信接口返回了非 JSON 内容: ${text.slice(0, 300)}`, { cause: error });
  }
}

export async function startQrLogin() {
  const url = new URL("/ilink/bot/get_bot_qrcode", DEFAULT_BASE_URL);
  url.searchParams.set("bot_type", BOT_TYPE);
  const response = await requestJson(url.toString(), { timeoutMs: 10_000 });
  if (!response.qrcode || !response.qrcode_img_content) {
    throw new Error("微信接口没有返回有效二维码。");
  }
  return {
    qrcode: response.qrcode,
    payload: response.qrcode_img_content,
    baseUrl: DEFAULT_BASE_URL,
  };
}

async function pollQrStatus(qrcode, baseUrl) {
  const url = new URL("/ilink/bot/get_qrcode_status", normalizeBaseUrl(baseUrl));
  url.searchParams.set("qrcode", qrcode);
  try {
    return await requestJson(url.toString(), { timeoutMs: 40_000 });
  } catch (error) {
    if (error?.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  }
}

export async function waitForQrLogin(login, {
  timeoutMs = 8 * 60_000,
  onStatus = () => {},
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let pollingBaseUrl = login.baseUrl;
  let lastStatus = "";

  while (Date.now() < deadline) {
    const response = await pollQrStatus(login.qrcode, pollingBaseUrl);
    if (response.status !== lastStatus) {
      lastStatus = response.status;
      onStatus(response.status);
    }

    if (response.status === "scaned_but_redirect" && response.redirect_host) {
      pollingBaseUrl = normalizeBaseUrl(response.redirect_host);
      continue;
    }
    if (response.status === "confirmed") {
      if (!response.bot_token || !response.ilink_bot_id || !response.ilink_user_id) {
        throw new Error("微信已确认授权，但返回的账号信息不完整。");
      }
      return {
        token: response.bot_token,
        accountId: response.ilink_bot_id,
        allowedUserId: response.ilink_user_id,
        baseUrl: normalizeBaseUrl(response.baseurl || pollingBaseUrl),
        channelVersion: CHANNEL_VERSION,
        createdAt: new Date().toISOString(),
      };
    }
    if (response.status === "expired") {
      throw new Error("二维码已过期，请重新运行 login。");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error("等待扫码超时，请重新运行 login。");
}

export async function getUpdates(credentials, cursor = "", timeoutMs = 40_000) {
  const baseUrl = normalizeBaseUrl(credentials.baseUrl);
  try {
    return await requestJson(`${baseUrl}/ilink/bot/getupdates`, {
      method: "POST",
      token: credentials.token,
      timeoutMs,
      body: {
        get_updates_buf: cursor,
        base_info: baseInfo(),
      },
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: cursor };
    }
    throw error;
  }
}

export async function sendText(credentials, {
  to,
  text,
  contextToken,
}) {
  const baseUrl = normalizeBaseUrl(credentials.baseUrl);
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: `codex-weixin-${crypto.randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
      context_token: contextToken,
    },
    base_info: baseInfo(),
  };
  const response = await requestJson(`${baseUrl}/ilink/bot/sendmessage`, {
    method: "POST",
    token: credentials.token,
    timeoutMs: 20_000,
    body,
  });
  if ((response.ret ?? 0) !== 0) {
    throw new Error(
      `微信 sendMessage 失败: ret=${response.ret} ${response.errmsg || ""}`,
    );
  }
  return response;
}

export async function getTypingTicket(credentials, {
  userId,
  contextToken,
}) {
  const baseUrl = normalizeBaseUrl(credentials.baseUrl);
  const response = await requestJson(`${baseUrl}/ilink/bot/getconfig`, {
    method: "POST",
    token: credentials.token,
    timeoutMs: 10_000,
    body: {
      ilink_user_id: userId,
      context_token: contextToken,
      base_info: baseInfo(),
    },
  });
  if ((response.ret ?? 0) !== 0 || !response.typing_ticket) {
    throw new Error(
      `微信 getConfig 未返回 typing ticket: ret=${response.ret} ${response.errmsg || ""}`,
    );
  }
  return response.typing_ticket;
}

export async function sendTyping(credentials, {
  userId,
  typingTicket,
  status,
}) {
  const baseUrl = normalizeBaseUrl(credentials.baseUrl);
  const response = await requestJson(`${baseUrl}/ilink/bot/sendtyping`, {
    method: "POST",
    token: credentials.token,
    timeoutMs: 10_000,
    body: {
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status,
      base_info: baseInfo(),
    },
  });
  if ((response.ret ?? 0) !== 0) {
    throw new Error(
      `微信 sendTyping 失败: ret=${response.ret} ${response.errmsg || ""}`,
    );
  }
  return response;
}

export async function setTyping(credentials, {
  userId,
  contextToken,
  typingTicket,
  active,
}) {
  const ticket = typingTicket || await getTypingTicket(credentials, {
    userId,
    contextToken,
  });
  await sendTyping(credentials, {
    userId,
    typingTicket: ticket,
    status: active ? 1 : 2,
  });
  return ticket;
}

export function isSessionExpiredResponse(response) {
  return Number(response?.errcode) === -14;
}

export function extractText(message) {
  if (message?.message_type !== 1) return "";
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  return items
    .filter((item) => item?.type === 1 && item?.text_item?.text != null)
    .map((item) => String(item.text_item.text))
    .join("\n")
    .trim();
}

export function splitMessage(text, maxLength = 3000) {
  const normalized = String(text || "").trim();
  if (!normalized) return [];
  const chunks = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < Math.floor(maxLength * 0.6)) {
      cut = maxLength;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export const WEIXIN_PROTOCOL = Object.freeze({
  baseUrl: DEFAULT_BASE_URL,
  botType: BOT_TYPE,
  channelVersion: CHANNEL_VERSION,
});
