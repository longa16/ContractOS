import path from "node:path";
export function pdfWorkerArgs(root: string) {
  return [
    "--max-old-space-size=192",
    "--permission",
    `--allow-fs-read=${path.join(root, "scripts/extract-pdf.mjs")}`,
    `--allow-fs-read=${path.join(root, "node_modules")}`,
    `--allow-fs-read=${path.join(root, "package.json")}`,
    path.join(root, "scripts/extract-pdf.mjs"),
  ];
}
