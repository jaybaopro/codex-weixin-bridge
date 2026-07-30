import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";

const require = createRequire(import.meta.url);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function encodeGrayPng(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const scanlines = [];
  for (const row of rows) {
    scanlines.push(Buffer.from([0]), Buffer.from(row));
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(scanlines))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function resolveQrVendor() {
  let packagedVendor = null;
  try {
    const packageRoot = path.dirname(require.resolve("qrcode-terminal/package.json"));
    packagedVendor = path.join(packageRoot, "vendor", "QRCode");
  } catch {
    // The caller will receive a null result if no compatible encoder is available.
  }

  const candidates = [
    process.env.CODEX_WEIXIN_QR_VENDOR,
    packagedVendor,
    path.join(
      os.homedir(),
      ".openclaw/extensions/openclaw-weixin/node_modules/qrcode-terminal/vendor/QRCode",
    ),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const qrCode = require(candidate);
      const level = require(path.join(candidate, "QRErrorCorrectLevel"));
      return { qrCode, level };
    } catch {
      // Try the next local vendor path.
    }
  }
  return null;
}

export function writeQrPng(payload, filePath, { scale = 8, border = 4 } = {}) {
  const vendor = resolveQrVendor();
  if (!vendor) {
    return null;
  }

  const qr = new vendor.qrCode(-1, vendor.level.M);
  qr.addData(payload);
  qr.make();

  const count = qr.getModuleCount();
  const size = (count + border * 2) * scale;
  const rows = Array.from({ length: size }, () => new Uint8Array(size).fill(255));

  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (!qr.modules[row][column]) continue;
      const y0 = (row + border) * scale;
      const x0 = (column + border) * scale;
      for (let y = y0; y < y0 + scale; y += 1) {
        rows[y].fill(0, x0, x0 + scale);
      }
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, encodeGrayPng(rows), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}
