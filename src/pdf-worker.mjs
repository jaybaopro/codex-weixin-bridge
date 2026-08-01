import { parentPort } from "node:worker_threads";

import { PDFParse } from "pdf-parse";

parentPort.once("message", async ({ bytes, maxPages }) => {
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
  // This worker handles exactly one PDF. Closing the port lets the worker exit
  // naturally after native PDF cleanup instead of racing a forced termination.
  parentPort.postMessage(response);
  parentPort.close();
});
