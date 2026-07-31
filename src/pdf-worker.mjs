import { parentPort } from "node:worker_threads";

import { PDFParse } from "pdf-parse";

parentPort.on("message", async ({ bytes, maxPages }) => {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  let response;
  try {
    const info = await parser.getInfo();
    if (info.total > maxPages) {
      throw new Error(`PDF 页数超过上限（${info.total} > ${maxPages}）`);
    }
    const result = await parser.getText();
    response = {
      ok: true,
      pages: result.total,
      text: result.text,
    };
  } catch (error) {
    response = {
      ok: false,
      error: String(error?.message || error).slice(0, 500),
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
  // The parent terminates this worker after receiving a result. On Windows,
  // posting before native PDF cleanup finished could race with termination.
  parentPort.postMessage(response);
});
