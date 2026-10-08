import { copyFile, mkdir } from "node:fs/promises";

const source = new URL(
  "../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
  import.meta.url,
);
const publicDirectory = new URL("../public/", import.meta.url);
await mkdir(publicDirectory, { recursive: true });
await copyFile(source, new URL("pdf.worker.min.mjs", publicDirectory));
