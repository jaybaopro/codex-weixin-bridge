import { parentPort } from "node:worker_threads";

import { PDFParse } from "pdf-parse";

parentPort.on("message", async ({ bytes, maxPages }) => {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const info = await parser.getInfo();
    if (info.total > maxPages) {
      throw new Error(`PDF 页数超过上限（${info.total} > ${maxPages}）`);
    }
    const result = await parser.getText();
    parentPort.postMessage({
      ok: true,
      pages: result.total,
      text: result.text,
    });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: String(error?.message || error).slice(0, 500),
    });
  } finally {
    await parser.destroy().catch(() => {});
  }
});
