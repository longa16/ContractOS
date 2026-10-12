// Runs in a memory/time-bounded child process, without application credentials.
import { extractText, getDocumentProxy } from "unpdf";
let length = 0;
const parts = [];
for await (const part of process.stdin) {
  length += part.length;
  if (length > 10485760) process.exit(2);
  parts.push(part);
}
try {
  const pdf = await getDocumentProxy(new Uint8Array(Buffer.concat(parts)), {
    verbosity: 0,
    isEvalSupported: false,
    disableFontFace: true,
    disableAutoFetch: true,
    disableStream: true,
    useSystemFonts: false,
  });
  if (pdf.numPages > 100) throw new Error("Too many pages");
  const { text } = await extractText(pdf, { mergePages: false });
  if (text.join("").length > 80000 || text.every((p) => !p.trim()))
    throw new Error("OCR or smaller PDF required");
  await pdf.loadingTask.destroy();
  process.stdout.write(JSON.stringify(text));
} catch (error) {
  // Diagnostic codes only; never echo document text or arbitrary parser messages.
  process.stderr.write(
    JSON.stringify({
      code: typeof error?.code === "string" ? error.code : "PDF_REJECTED",
      type: error?.name,
      ...(error?.code === "ERR_ACCESS_DENIED"
        ? { permission: error.permission, resource: error.resource }
        : {}),
    }),
  );
  process.exitCode = 2;
}
