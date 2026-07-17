import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const components = [
  { id: "Leaflet", name: "Leaflet", version: "1.9.4", license: "BSD-2-Clause", source: "https://github.com/Leaflet/Leaflet", paths: ["vendor/leaflet"] },
  { id: "exifr", name: "exifr", version: "NOASSERTION", license: "MIT", source: "https://github.com/MikeKovarik/exifr", paths: ["vendor/exifr"] },
  { id: "html2canvas", name: "html2canvas", version: "1.4.1", license: "MIT", source: "https://github.com/niklasvh/html2canvas", paths: ["vendor/html2canvas"] },
  { id: "heic-to", name: "heic-to", version: "1.5.2", license: "LGPL-3.0-only", source: "https://github.com/hoppergee/heic-to", paths: ["vendor/heic-to"] },
  { id: "docx", name: "docx", version: "NOASSERTION", license: "MIT", source: "https://github.com/dolanmiu/docx", paths: ["vendor/docx"] },
  { id: "QRCodeGenerator", name: "qrcode-generator", version: "2.0.4", license: "MIT", source: "https://github.com/kazuhikoarase/qrcode-generator", paths: ["vendor/qrcode"] },
  { id: "IBMPlex", name: "IBM Plex fonts", version: "NOASSERTION", license: "OFL-1.1", source: "https://github.com/IBM/plex", paths: ["vendor/fonts"] }
];

async function files(path) {
  const absolute = resolve(root, path), entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? files(relative(root, resolve(absolute, entry.name))) : [relative(root, resolve(absolute, entry.name)).replace(/\\/g, "/")]));
  return nested.flat();
}

const packages = [], fileEntries = [], relationships = [];
for (const component of components) {
  const packageId = "SPDXRef-Package-" + component.id;
  packages.push({
    name: component.name, SPDXID: packageId, versionInfo: component.version,
    downloadLocation: component.source, filesAnalyzed: true,
    licenseConcluded: component.license, licenseDeclared: component.license,
    copyrightText: "NOASSERTION"
  });
  for (const path of (await Promise.all(component.paths.map(files))).flat().sort()) {
    const data = await readFile(resolve(root, path));
    const fileId = "SPDXRef-File-" + createHash("sha256").update(path).digest("hex").slice(0, 16);
    fileEntries.push({ fileName: "./" + path, SPDXID: fileId, checksums: [{ algorithm: "SHA256", checksumValue: createHash("sha256").update(data).digest("hex") }], licenseConcluded: component.license, copyrightText: "NOASSERTION" });
    relationships.push({ spdxElementId: packageId, relationshipType: "CONTAINS", relatedSpdxElement: fileId });
  }
}

const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
for (const [path, entry] of Object.entries(lock.packages || {})) {
  if (!path.startsWith("node_modules/") || !entry.version) continue;
  const name = path.slice("node_modules/".length);
  const purlName = name.startsWith("@")
    ? "%40" + name.slice(1).split("/").map(encodeURIComponent).join("/")
    : encodeURIComponent(name);
  const id = "SPDXRef-Npm-" + createHash("sha256").update(name + "@" + entry.version).digest("hex").slice(0, 16);
  const pkg = {
    name, SPDXID: id, versionInfo: entry.version,
    downloadLocation: entry.resolved || "NOASSERTION", filesAnalyzed: false,
    licenseConcluded: entry.license || "NOASSERTION", licenseDeclared: entry.license || "NOASSERTION",
    copyrightText: "NOASSERTION",
    externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:npm/${purlName}@${entry.version}` }]
  };
  if (entry.integrity && entry.integrity.startsWith("sha512-")) {
    pkg.checksums = [{ algorithm: "SHA512", checksumValue: Buffer.from(entry.integrity.slice(7), "base64").toString("hex") }];
  }
  packages.push(pkg);
}

const document = {
  spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT",
  name: "GeoTag-v0.2.0-SBOM",
  documentNamespace: "https://github.com/Nerjo/geotag/sbom/v0.2.0",
  creationInfo: { created: "2026-07-11T00:00:00Z", creators: ["Tool: scripts/generate-sbom.mjs"] },
  packages, files: fileEntries,
  relationships: [
    ...packages.map(pkg => ({ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: pkg.SPDXID })),
    ...relationships
  ]
};
await writeFile(resolve(root, "sbom.spdx.json"), JSON.stringify(document, null, 2) + "\n");
console.log(`Generated sbom.spdx.json (${packages.length} packages, ${fileEntries.length} files)`);
