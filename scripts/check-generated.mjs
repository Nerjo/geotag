import { readFile } from "node:fs/promises";

const target = process.argv[2];
const generator = process.argv[3];
if (!target || !generator) throw new Error("Usage: check-generated.mjs <target> <generator>");

let before = null;
try { before = await readFile(new URL("../" + target, import.meta.url), "utf8"); }
catch (_) {}
await import(new URL("../" + generator, import.meta.url));
const after = await readFile(new URL("../" + target, import.meta.url), "utf8");
if (before !== after) throw new Error(`${target} was stale or missing; regenerate and commit it`);
console.log(`${target} is current`);
