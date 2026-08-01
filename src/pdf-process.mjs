import { PDFParse } from "pdf-parse";

process.once("message", async ({ bytes, maxPages }) => {
  let parser;
  let response;
  try {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    parser = new PDFParse({ data: new Uint8Array(data) });
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
    await parser?.destroy().catch(() => {});
  }

  if (!process.send || !process.connected) {
    process.exitCode = 1;
    return;
  }
  process.send(response, (error) => {
    if (error) process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
});
