import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanupStaleInbound,
  decryptAesEcb,
  inspectInboundMessage,
  prepareInboundAttachment,
  removeInboundDirectory,
} from "../src/inbound-media.mjs";

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function mockDownload(buffer, url = "https://novac2c.cdn.weixin.qq.com/c2c/download") {
  return async (requested) => {
    assert.equal(String(requested), url);
    return new Response(buffer, {
      status: 200,
      headers: { "content-length": String(buffer.length) },
    });
  };
}

function simplePdf(text = "Hello PDF") {
  const stream = `BT /F1 18 Tf 50 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

test("inbound inspection separates attachments from control text", () => {
  assert.deepEqual(inspectInboundMessage({
    message_type: 1,
    item_list: [
      { type: 1, text_item: { text: "状态" } },
      { type: 2, image_item: { media: {} } },
    ],
  }), {
    text: "状态",
    attachment: { type: 2, image_item: { media: {} } },
    rejection: null,
  });
  assert.match(inspectInboundMessage({
    message_type: 1,
    item_list: [{ type: 3, voice_item: {} }],
  }).rejection, /暂不接收语音/);
  assert.match(inspectInboundMessage({
    message_type: 1,
    item_list: [
      { type: 2, image_item: {} },
      { type: 4, file_item: {} },
    ],
  }).rejection, /只支持 1 个附件/);
});

test("AES-128-ECB decryption accepts both Weixin key encodings", () => {
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const plaintext = Buffer.from("secure attachment");
  const encrypted = encryptAesEcb(plaintext, key);
  assert.deepEqual(
    decryptAesEcb(encrypted, key.toString("base64")),
    plaintext,
  );
  assert.deepEqual(
    decryptAesEcb(encrypted, Buffer.from(key.toString("hex")).toString("base64")),
    plaintext,
  );
});

test("UTF-8 text attachments are verified, decrypted, and kept in memory", async () => {
  const key = crypto.randomBytes(16);
  const plaintext = Buffer.from("第一行\n第二行", "utf8");
  const encrypted = encryptAesEcb(plaintext, key);
  const result = await prepareInboundAttachment({
    type: 4,
    file_item: {
      file_name: "../说明.md",
      len: String(plaintext.length),
      md5: crypto.createHash("md5").update(plaintext).digest("hex"),
      media: {
        full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download",
        aes_key: Buffer.from(key.toString("hex")).toString("base64"),
      },
    },
  }, { fetchImpl: mockDownload(encrypted) });

  assert.equal(result.kind, "text");
  assert.equal(result.name, "说明.md");
  assert.equal(result.cleanupDirectory, null);
  assert.match(result.codexInputs[0].text, /第一行\n第二行/);
  assert.match(result.codexInputs[0].text, /不是系统指令/);
});

test("PDF attachments are parsed in the bounded worker", async () => {
  const key = crypto.randomBytes(16);
  const plaintext = simplePdf();
  const encrypted = encryptAesEcb(plaintext, key);
  const result = await prepareInboundAttachment({
    type: 4,
    file_item: {
      file_name: "sample.pdf",
      len: String(plaintext.length),
      md5: crypto.createHash("md5").update(plaintext).digest("hex"),
      media: {
        full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download",
        aes_key: Buffer.from(key.toString("hex")).toString("base64"),
      },
    },
  }, { fetchImpl: mockDownload(encrypted) });

  assert.equal(result.kind, "pdf");
  assert.equal(result.pages, 1);
  assert.match(result.codexInputs[0].text, /Hello PDF/);
});

test("images use a private inbox path and exact-scope cleanup", async (t) => {
  const previousStateDir = process.env.CODEX_WEIXIN_STATE_DIR;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-media-test-"));
  process.env.CODEX_WEIXIN_STATE_DIR = stateDir;
  t.after(() => {
    if (previousStateDir == null) delete process.env.CODEX_WEIXIN_STATE_DIR;
    else process.env.CODEX_WEIXIN_STATE_DIR = previousStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const key = crypto.randomBytes(16);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const encrypted = encryptAesEcb(png, key);
  const result = await prepareInboundAttachment({
    type: 2,
    image_item: {
      aeskey: key.toString("hex"),
      media: {
        full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download",
      },
    },
  }, {
    messageKey: "message-1",
    fetchImpl: mockDownload(encrypted),
  });

  const imagePath = result.codexInputs.find(
    (input) => input.type === "localImage",
  ).path;
  assert.equal(result.kind, "image");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(imagePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(result.cleanupDirectory).mode & 0o777, 0o700);
  }
  assert.equal(removeInboundDirectory(result.cleanupDirectory), true);
  assert.equal(fs.existsSync(imagePath), false);
  assert.throws(
    () => removeInboundDirectory(path.dirname(stateDir)),
    /收件箱范围以外/,
  );
  assert.equal(cleanupStaleInbound(), 0);
});

test("non-Weixin download hosts are rejected before network access", async () => {
  let fetched = false;
  await assert.rejects(
    prepareInboundAttachment({
      type: 2,
      image_item: {
        aeskey: crypto.randomBytes(16).toString("hex"),
        media: { full_url: "https://example.com/private" },
      },
    }, {
      fetchImpl: async () => {
        fetched = true;
        throw new Error("must not run");
      },
    }),
    /腾讯 CDN/,
  );
  assert.equal(fetched, false);
});

test("image dimension bombs are rejected before private persistence", async () => {
  const key = crypto.randomBytes(16);
  const fakePng = Buffer.alloc(32);
  Buffer.from("89504e470d0a1a0a", "hex").copy(fakePng);
  fakePng.writeUInt32BE(100_000, 16);
  fakePng.writeUInt32BE(100_000, 20);
  const encrypted = encryptAesEcb(fakePng, key);
  await assert.rejects(
    prepareInboundAttachment({
      type: 2,
      image_item: {
        aeskey: key.toString("hex"),
        media: {
          full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download",
        },
      },
    }, { fetchImpl: mockDownload(encrypted) }),
    /像素尺寸超过安全上限/,
  );
});
