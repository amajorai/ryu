import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const proofDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/performance-sweep"
);
test.setTimeout(90_000);
test("shares catalog requests, propagates changes, isolates nodes, and pauses background polling", async ({
	page,
	request,
}) => {
	await request.get("/proof-reset");
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/catalog-performance-proof.html");
	await expect(page.getByTestId("agent-name")).toHaveText(
		Array.from({ length: 8 }, () => "alpha researcher")
	);
	await expect(page.getByTestId("app-state")).toHaveText(
		Array.from({ length: 8 }, () => "alpha Notes: Disabled")
	);
	const metrics = async () =>
		await (await request.get("/proof-metrics")).json();
	expect((await metrics()).catalogReads).toBe(4);
	await page
		.getByRole("button", { name: "Add workspace", exact: true })
		.click();
	await expect(page.getByTestId("agent-name")).toHaveText(
		Array.from({ length: 9 }, () => "alpha researcher")
	);
	expect((await metrics()).catalogReads).toBe(4);
	await page.getByRole("button", { name: "Rename agent", exact: true }).click();
	await expect(page.getByTestId("agent-name")).toHaveText(
		Array.from({ length: 9 }, () => "Updated researcher")
	);
	await page.getByRole("button", { name: "Toggle app", exact: true }).click();
	await expect(page.getByTestId("app-state")).toHaveText(
		Array.from({ length: 9 }, () => "alpha Notes: Enabled")
	);
	await page.getByRole("button", { name: "Node beta", exact: true }).click();
	await expect(page.getByTestId("agent-name")).toHaveText(
		Array.from({ length: 9 }, () => "beta researcher")
	);
	await expect(page.getByTestId("app-state")).toHaveText(
		Array.from({ length: 9 }, () => "beta Notes: Disabled")
	);
	await page.getByRole("button", { name: "Node alpha", exact: true }).click();
	await expect(page.getByTestId("agent-name")).toHaveText(
		Array.from({ length: 9 }, () => "Updated researcher")
	);
	await expect(page.getByTestId("app-state")).toHaveText(
		Array.from({ length: 9 }, () => "alpha Notes: Enabled")
	);
	const readsBefore = (await metrics()).catalogReads;
	await page.getByRole("button", { name: "Refresh all", exact: true }).click();
	await expect
		.poll(async () => (await metrics()).catalogReads)
		.toBe(readsBefore + 4);
	await page.evaluate(() => window.dispatchEvent(new Event("blur")));
	await page.waitForTimeout(300);
	const paused = (await metrics()).polls;
	await page.waitForTimeout(650);
	expect((await metrics()).polls).toBe(paused);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect
		.poll(async () => (await metrics()).polls)
		.toBeGreaterThan(paused);
	expect(errors).toEqual([]);
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "catalogs-completed.png"),
		fullPage: true,
	});
});

test("loads only the requested file editor and edits and saves Office files", async ({
	page,
	request,
}) => {
	await request.get("/proof-reset");
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const editors = new Set<string>();
	page.on("request", (request) => {
		const match = request
			.url()
			.match(/\/(DocxEditor|PdfViewer|SlidesEditor|SpreadsheetEditor)\.tsx/);
		if (match) {
			editors.add(match[1]);
		}
	});
	await page.goto("/catalog-performance-proof.html");
	await expect(page.getByTestId("agent-name")).toHaveCount(8);
	expect([...editors]).toEqual([]);
	await page.getByRole("button", { name: "Open slides", exact: true }).click();
	const slide = page.locator("textarea").first();
	await expect(slide).toHaveValue("Quarterly product review");
	expect([...editors]).toEqual(["SlidesEditor"]);
	await slide.fill("Quarterly review — performance verified");
	await slide.blur();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeDisabled();
	expect((await (await request.get("/proof-metrics")).json()).saves).toBe(1);
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "slides-completed.png"),
		fullPage: true,
	});
	await page
		.getByRole("button", { name: "Open spreadsheet", exact: true })
		.click();
	const cell = page.getByRole("textbox", { name: "B2", exact: true });
	await expect(cell).toHaveValue("420000");
	expect([...editors].sort()).toEqual(["SlidesEditor", "SpreadsheetEditor"]);
	await cell.fill("450000");
	await cell.blur();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeDisabled();
	expect((await (await request.get("/proof-metrics")).json()).saves).toBe(2);
	await page
		.getByRole("button", { name: "Open document", exact: true })
		.click();
	await expect(page.getByText("Project proposal", { exact: true })).toBeVisible(
		{ timeout: 30_000 }
	);
	await page.getByRole("button", { name: "Open pdf", exact: true }).click();
	await expect(page.getByText("/ 1", { exact: true })).toBeVisible({
		timeout: 30_000,
	});
	const pdfCanvas = page.locator("canvas");
	await expect(pdfCanvas).toBeVisible();
	// A mounted canvas can still be blank while the PDF worker is loading.
	// Wait for the fixture's black text to actually reach the rendered page.
	await expect
		.poll(
			async () =>
				pdfCanvas.evaluate((canvas) => {
					const context = canvas.getContext("2d");
					if (!context || canvas.width < 600) {
						return 0;
					}
					const pixels = context.getImageData(
						0,
						0,
						canvas.width,
						canvas.height
					).data;
					let darkPixels = 0;
					for (let index = 0; index < pixels.length; index += 4) {
						if (
							pixels[index] < 100 &&
							pixels[index + 1] < 100 &&
							pixels[index + 2] < 100 &&
							pixels[index + 3] > 0
						) {
							darkPixels++;
						}
					}
					return darkPixels;
				}),
			{ timeout: 30_000 }
		)
		.toBeGreaterThan(100);
	await expect(pdfCanvas).not.toHaveClass(/opacity-60/);
	expect([...editors].sort()).toEqual([
		"DocxEditor",
		"PdfViewer",
		"SlidesEditor",
		"SpreadsheetEditor",
	]);
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.join(proofDir, "pdf-completed.png"),
		fullPage: true,
	});
	const pdfWorkers = page
		.workers()
		.filter((worker) => worker.url().includes("pdf.worker"));
	expect(pdfWorkers).toHaveLength(1);
	await page.getByRole("button", { name: "Catalogs", exact: true }).click();
	await expect.poll(() => page.workers().includes(pdfWorkers[0])).toBe(false);
});
