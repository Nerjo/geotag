import test from "node:test";
import assert from "node:assert/strict";

await import("../../app/runtime.js");
const RT = globalThis.GeoTagRuntime;

test("coordinate precision reflects recorded uncertainty", () => {
  assert.equal(RT.coordinateDecimals(null), 5);
  assert.equal(RT.coordinateDecimals(15), 4);
  assert.equal(RT.coordinateDecimals(.1), 6);
});

test("haversine distance is suitable for pin displacement", () => {
  const meters = RT.haversineMeters(53.5461, -113.4938, 53.5462, -113.4938);
  assert.ok(meters > 10 && meters < 12);
});

test("structured exports preserve records", () => {
  const record = { recordId: "GT-1", latitude: 53.5, longitude: -113.5, caption: "comma, quote \"" };
  assert.match(RT.recordsToCsv([record]), /"comma, quote """/);
  const geo = RT.recordsToGeoJson([record]);
  assert.deepEqual(geo.features[0].geometry.coordinates, [-113.5, 53.5]);
});

test("ZIP and PDF builders emit their canonical signatures", async () => {
  const zip = new Uint8Array(await (await RT.createZip([{ name: "a.txt", data: new Blob(["a"]) }])).arrayBuffer());
  assert.deepEqual([...zip.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const pdf = new Uint8Array(await (await RT.createPdf([{ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 1, height: 1 }])).arrayBuffer());
  assert.equal(new TextDecoder().decode(pdf.slice(0, 8)), "%PDF-1.4");
});

test("task queue enforces concurrency", async () => {
  let active = 0, peak = 0;
  const queue = new RT.TaskQueue({ concurrency: 2 });
  const jobs = Array.from({ length: 5 }, () => queue.enqueue(async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
  }));
  await Promise.all(jobs);
  assert.equal(peak, 2);
});
