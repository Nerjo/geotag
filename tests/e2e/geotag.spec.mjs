import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../fixtures/no-gps.png", import.meta.url));

async function routeTiles(page) {
  const tile = await import("node:fs/promises").then(fs => fs.readFile(fixture));
  const fulfill = route => route.fulfill({
    status: 200,
    contentType: "image/png",
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "max-age=60" },
    body: tile
  });
  await page.route("https://tile.openstreetmap.org/**", fulfill);
  await page.route("https://server.arcgisonline.com/**", fulfill);
}

test("completes a manual field handoff", async ({ page }) => {
  await routeTiles(page);
  await page.goto("/");
  await expect(page.getByText("PHOTOS STAY IN THIS BROWSER")).toBeVisible();
  await page.locator("#fileInput").setInputFiles(fixture);
  await expect(page.locator(".card-num")).toHaveText(/^GT-\d{8}-0001-[A-F0-9]{6}$/);
  await expect(page.getByRole("heading", { name: "Add a location" })).toBeVisible();
  await page.locator(".manualLat").fill("53.5461");
  await page.locator(".manualLon").fill("-113.4938");
  await page.getByRole("button", { name: "Use coordinates" }).click();
  await expect(page.locator("#mapTypes")).toBeVisible();
  await expect(page.getByRole("button", { name: "Build report image" })).toBeEnabled();
  await page.getByRole("button", { name: "Build report image" }).click();
  await expect(page.getByRole("dialog", { name: "Report image ready" })).toBeVisible();
  await expect(page.locator("#shareDetails")).toHaveValue(/geo:53\.5461,-113\.4938/);
  expect(await page.pageErrors()).toEqual([]);
});

test("converts HEIC uploads under the production CSP", async ({ page }) => {
  const heic = fileURLToPath(new URL("../fixtures/no-gps.heic", import.meta.url));
  await routeTiles(page);
  await page.goto("/");
  await page.locator("#fileInput").setInputFiles(heic);
  // Conversion succeeded when the preview renders and the card moves on to
  // asking for a location (the fixture has no EXIF GPS).
  await expect(page.getByRole("heading", { name: "Add a location" })).toBeVisible({ timeout: 20000 });
  await expect(page.locator(".cphoto")).toHaveJSProperty("complete", true);
  await expect(page.locator("#batchProgressWrap")).toBeHidden();
  expect(await page.pageErrors()).toEqual([]);
});

test("offers street and satellite map styles", async ({ page }) => {
  await routeTiles(page);
  await page.goto("/");
  await page.locator("#fileInput").setInputFiles(fixture);
  await expect(page.getByRole("heading", { name: "Add a location" })).toBeVisible();
  await page.locator(".manualLat").fill("53.5461");
  await page.locator(".manualLon").fill("-113.4938");
  await page.getByRole("button", { name: "Use coordinates" }).click();
  await expect(page.locator('#mapTypes label[data-type="osm"]')).toBeVisible();
  const satellite = page.locator('#mapTypes label[data-type="satellite"]');
  await expect(satellite).toBeVisible();
  // Maps render lazily; wait for the street map to be on screen and live
  // before switching styles.
  await page.locator(".map-pane").scrollIntoViewIfNeeded();
  await expect(page.locator(".cmap.leaflet-container")).toBeVisible();
  const esriTile = page.waitForRequest("https://server.arcgisonline.com/**");
  await satellite.click();
  await esriTile;
  await expect(satellite).toHaveClass(/active/);
  expect(await page.pageErrors()).toEqual([]);
});

test("report waits for tiles and embeds offline-generated navigation data", async ({ page }) => {
  await routeTiles(page);
  await page.goto("/");
  await page.locator("#fileInput").setInputFiles(fixture);
  await expect(page.getByRole("heading", { name: "Add a location" })).toBeVisible();
  await page.locator(".manualLat").fill("53.5461");
  await page.locator(".manualLon").fill("-113.4938");
  await page.getByRole("button", { name: "Use coordinates" }).click();
  await page.getByRole("button", { name: "Build report image" }).click();
  await expect(page.getByRole("dialog", { name: "Report image ready" })).toBeVisible();
  await expect(page.locator(".card-status")).not.toContainText("incomplete");
  // The navigation QR is drawn in the bottom-right corner of the map panel.
  const darkPixels = await page.locator("#exportCanvas").evaluate(canvas => {
    const context = canvas.getContext("2d");
    const x = Math.max(0, canvas.width - 320), y = Math.max(0, canvas.height - 420);
    const data = context.getImageData(x, y, canvas.width - x, canvas.height - y).data;
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] < 35 && data[index + 1] < 35 && data[index + 2] < 35 && data[index + 3] > 200) count += 1;
    }
    return count;
  });
  expect(darkPixels).toBeGreaterThan(500);
  expect(await page.pageErrors()).toEqual([]);
});
