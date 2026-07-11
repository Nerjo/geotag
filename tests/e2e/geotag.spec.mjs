import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../fixtures/no-gps.png", import.meta.url));

test("defaults to local mode and completes a manual field handoff", async ({ page }) => {
  const external = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.hostname !== "127.0.0.1") external.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByText("LOCAL COORDINATES DEFAULT")).toBeVisible();
  await expect(page.locator("#mapTypes")).toBeHidden();
  await page.locator("#fileInput").setInputFiles(fixture);
  await expect(page.locator(".card-num")).toHaveText(/^GT-\d{8}-0001-[A-F0-9]{6}$/);
  await expect(page.getByRole("heading", { name: "Add a location" })).toBeVisible();
  await page.locator(".manualLat").fill("53.5461");
  await page.locator(".manualLon").fill("-113.4938");
  await page.getByRole("button", { name: "Use coordinates" }).click();
  await expect(page.locator("#mapTypes")).toBeHidden();
  await expect(page.getByText("No automatic map or address request has been sent.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Build report image" })).toBeEnabled();
  await page.getByRole("button", { name: "Build report image" }).click();
  await expect(page.getByRole("dialog", { name: "Report image ready" })).toBeVisible();
  await expect(page.locator("#shareDetails")).toHaveValue(/geo:53\.5461,-113\.4938/);
  expect(external).toEqual([]);
  expect(await page.pageErrors()).toEqual([]);
});

test("online mode requires an explicit provider disclosure", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Online map & address", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Enable online map and address?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("tile.openstreetmap.org");
  await dialog.getByRole("button", { name: "Stay local" }).click();
  await expect(page.getByText("GeoTag makes no automatic map or address request.")).toBeVisible();
  expect(await page.pageErrors()).toEqual([]);
});

test("online report waits for tiles and embeds offline-generated navigation data", async ({ page }) => {
  const tile = await import("node:fs/promises").then(fs => fs.readFile(fixture));
  await page.route("https://tile.openstreetmap.org/**", route => route.fulfill({
    status: 200,
    contentType: "image/png",
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "max-age=60" },
    body: tile
  }));
  await page.goto("/");
  await page.getByText("Online map & address", { exact: true }).click();
  await page.getByRole("dialog", { name: "Enable online map and address?" })
    .getByRole("button", { name: "Enable for this session" }).click();
  await page.locator("#fileInput").setInputFiles(fixture);
  await expect(page.getByRole("heading", { name: "Add a location" })).toBeVisible();
  await page.locator(".manualLat").fill("53.5461");
  await page.locator(".manualLon").fill("-113.4938");
  await page.getByRole("button", { name: "Use coordinates" }).click();
  await page.getByRole("button", { name: "Build report image" }).click();
  await expect(page.getByRole("dialog", { name: "Report image ready" })).toBeVisible();
  await expect(page.locator(".card-status")).not.toContainText("incomplete");
  const darkPixels = await page.locator("#exportCanvas").evaluate(canvas => {
    const context = canvas.getContext("2d");
    const x = Math.max(0, canvas.width - 320), y = Math.max(0, canvas.height - 360);
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
