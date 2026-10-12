import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pdfWorkerArgs } from "../src/lib/pdf-runtime";
function fixture() {
  const stream = "BT /F1 12 Tf 72 720 Td (Insurance required.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
async function worker(input: Buffer) {
  return new Promise<{ code: number | null; text: string; diagnostic: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, pdfWorkerArgs(process.cwd()), {
        env: { NODE_ENV: "production" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Worker timed out"));
      }, 15000);
      const chunks: Buffer[] = [];
      let diagnostic = "";
      child.stderr.on("data", (c) => (diagnostic += c.toString()));
      child.stdout.on("data", (c) => chunks.push(c));
      child.stdin.on("error", () => {});
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, text: Buffer.concat(chunks).toString(), diagnostic });
      });
      child.stdin.end(input);
    },
  );
}
test("Real PDF extraction preserves page attribution under the restricted worker", async () => {
  const result = await worker(fixture());
  assert.equal(result.code, 0, result.diagnostic);
  assert.deepEqual(JSON.parse(result.text), ["Insurance required."]);
});
test("Malformed documents cannot yield a fabricated successful extraction", async () => {
  const result = await worker(Buffer.from("%PDF-1.7\nnot a valid PDF"));
  assert.notEqual(result.code, 0);
});
