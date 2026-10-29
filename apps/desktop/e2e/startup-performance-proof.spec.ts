import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const proofDir =
	process.env.RYU_PROOF_EVIDENCE_DIR ??
	path.resolve(import.meta.dirname, "../../../docs/proof/performance-sweep");
test.setTimeout(120_000);

test("settings implementations stay deferred, open from actions, and reopen normally", async ({
	page,
}) => {
	const loaded = new Set<string>();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("request", (request) => {
		const match = request
			.url()
			.match(
				/\/(SettingsDialog|GatewayDialog|MarkdownEditorContent|MapWidget)\.tsx/
			);
		if (match) {
			loaded.add(match[1]);
		}
	});
	await page.goto("/startup-performance-proof.html");
	await expect(page.getByTestId("open-settings")).toBeVisible();
	expect([...loaded]).toEqual([]);
	await page.getByTestId("open-settings").click();
	await expect(
		page.getByRole("heading", { name: "General", exact: true })
	).toBeVisible({ timeout: 30_000 });
	expect(loaded.has("SettingsDialog")).toBe(true);
	expect(loaded.has("GatewayDialog")).toBe(false);
	await page.keyboard.press("Escape");
	await expect(page.locator("[data-slot=dialog-content]")).not.toBeVisible();
	await expect(page.getByTestId("open-settings")).toBeFocused();
	await page.getByTestId("open-gateway").click();
	await expect(
		page.getByRole("heading", { name: "Overview", exact: true })
	).toBeVisible({ timeout: 30_000 });
	expect(loaded.has("GatewayDialog")).toBe(true);
	await page.keyboard.press("Escape");
	await page.getByTestId("open-settings").click();
	await expect(
		page.getByRole("heading", { name: "General", exact: true })
	).toBeVisible();
	expect(errors).toEqual([]);
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "settings-loaded.png"),
		animations: "disabled",
		fullPage: true,
	});
});

test("closing during a slow initial settings import stays closed after it resolves", async ({
	page,
}) => {
	let release: (() => Promise<void>) | undefined;
	await page.route("**/settings/SettingsDialog.tsx*", async (route) => {
		await new Promise<void>((resolve) => {
			release = async () => {
				await route.continue();
				resolve();
			};
		});
	});
	await page.goto("/startup-performance-proof.html");
	await page.getByTestId("open-settings").click();
	await expect(page.locator("[data-slot=dialog-content]")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.locator("[data-slot=dialog-content]")).not.toBeVisible();
	await expect.poll(() => Boolean(release)).toBe(true);
	await release?.();
	await page.waitForLoadState("networkidle");
	await expect(page.locator("[data-slot=dialog-content]")).not.toBeVisible();
	await expect(page.getByTestId("open-settings")).toBeFocused();
	await page.getByTestId("open-settings").click();
	await expect(
		page.getByRole("heading", { name: "General", exact: true })
	).toBeVisible({ timeout: 30_000 });
});

test("the full Markdown editor and map load only when requested", async ({
	page,
}) => {
	const loaded = new Set<string>();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("request", (request) => {
		const match = request
			.url()
			.match(/\/(MarkdownEditorContent|MapWidget)\.tsx/);
		if (match) {
			loaded.add(match[1]);
		}
	});
	await page.route("https://tiles.openfreemap.org/styles/liberty", (route) =>
		route.fulfill({
			json: {
				version: 8,
				sources: {
					reference: {
						type: "geojson",
						data: {
							type: "FeatureCollection",
							features: [
								{
									type: "Feature",
									properties: {},
									geometry: {
										type: "Polygon",
										coordinates: [
											[
												[-20, -10],
												[20, -10],
												[20, 30],
												[-20, 30],
												[-20, -10],
											],
										],
									},
								},
							],
						},
					},
				},
				layers: [
					{
						id: "background",
						type: "background",
						paint: { "background-color": "#eef2f5" },
					},
					{
						id: "reference",
						type: "fill",
						source: "reference",
						paint: { "fill-color": "#dbe5d4" },
					},
				],
			},
		})
	);
	await page.goto("/startup-performance-proof.html");
	await expect(page.getByTestId("open-editor")).toBeVisible();
	expect([...loaded]).toEqual([]);
	await page.getByTestId("open-editor").click();
	const editor = page.locator("[data-slate-editor=true]");
	await expect(editor).toBeVisible({ timeout: 30_000 });
	await editor.fill("Edited after loading the editor");
	await expect(page.getByTestId("markdown-value")).toContainText(
		"Edited after loading the editor"
	);
	expect(loaded.has("MarkdownEditorContent")).toBe(true);
	expect(loaded.has("MapWidget")).toBe(false);
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "markdown-loaded.png"),
		fullPage: true,
	});
	await page.getByTestId("open-map").click();
	await expect(page.locator(".maplibregl-marker")).toBeVisible({
		timeout: 30_000,
	});
	await page.locator(".maplibregl-marker").click();
	const popup = page.locator(".maplibregl-popup-content");
	await expect(popup).toBeVisible();
	await expect(popup).toContainText("Reference point");
	expect(loaded.has("MapWidget")).toBe(true);
	expect(errors).toEqual([]);
});
