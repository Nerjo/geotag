import { readFile, stat } from "node:fs/promises";

const read = path => readFile(new URL("../" + path, import.meta.url), "utf8");
const html = await read("index.html");
const config = await read("app/config.js");
const sw = await read("sw.js");
const styles = await read("app/styles.css");
const main = await read("app/main.js");
const manifestText = await read("manifest.webmanifest");
JSON.parse(manifestText);

if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) throw new Error("Inline script found; strict script-src would block it");
if (/<style\b/i.test(html)) throw new Error("Inline style block found");
if (!config.includes("https://tile.openstreetmap.org/{z}/{x}/{y}.png")) throw new Error("Canonical OSM endpoint missing");
if (config.includes("nominatim.openstreetmap.org")) throw new Error("Public Nominatim must not be built into the client");
if (/TILE_CACHE|cache\.put\([^\n]*tile/i.test(sw)) throw new Error("Service worker must not archive public map tiles");
if (/attributionControl\s*:\s*false/.test(main)) throw new Error("Report maps must not disable Leaflet attribution");
if (!main.includes("drawNavigationQr")) throw new Error("Report navigation QR code missing");

function luminance(hex) {
  const rgb = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
}
function contrast(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
}
const token = name => styles.match(new RegExp("--" + name + ":#([a-fA-F0-9]{6})"))[1];
if (contrast(token("accent"), "ffffff") < 4.5) throw new Error("Accent/white contrast is below 4.5:1");
if (contrast(token("ink-faint"), token("card")) < 4.5) throw new Error("Faint/card contrast is below 4.5:1");

globalThis.self = globalThis;
await import(new URL("../sw-assets.js", import.meta.url));
for (const asset of globalThis.GEOTAG_SHELL_ASSETS) await stat(new URL("../" + asset, import.meta.url));
console.log("Static trust checks passed");
