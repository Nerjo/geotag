import { cp, mkdir, rm } from "node:fs/promises";

await import("./generate-sw-manifest.mjs");

const root = new URL("../", import.meta.url);
const output = new URL("../dist/site/", import.meta.url);
const entries = [
  "index.html",
  "manifest.webmanifest",
  "sw.js",
  "sw-assets.js",
  "_headers",
  "app",
  "icons",
  "vendor",
  ".well-known"
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of entries) {
  await cp(new URL(entry, root), new URL(entry, output), { recursive: true });
}

console.log(`Built static site in ${output.pathname}`);
