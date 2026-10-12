import "server-only";
import { spawn } from "node:child_process";
import { pdfWorkerArgs } from "./pdf-runtime";
import { z } from "zod";

export function extractPdf(bytes: Uint8Array): Promise<string[]> {
  if (bytes.length > 10485760) throw new Error("File too large");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, pdfWorkerArgs(process.cwd()), {
      env: { NODE_ENV: "production" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("PDF extraction timed out"));
    }, 15000);
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 500000) {
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stdin.on("error", () => {
      /* A rejected PDF may close stdin early. */
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("PDF worker unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0 || size > 500000) throw new Error("PDF rejected");
        resolve(
          z
            .array(z.string())
            .min(1)
            .max(100)
            .parse(JSON.parse(Buffer.concat(chunks).toString())),
        );
      } catch {
        reject(
          new Error(
            "PDF rejected; scanned PDFs require a reviewed OCR process",
          ),
        );
      }
    });
    child.stdin.end(bytes);
  });
}
