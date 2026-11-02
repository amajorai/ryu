import { expect, test } from "@playwright/test";
import {
	appFrame,
	captureProduct,
	createPdfFixture,
	FRAME_SELECTOR,
	fixtureState,
	jpegDimensions,
	observeDownloads,
	openCompanion,
	openPreview,
	PREVIEW_SELECTOR,
	pdfPageCount,
	pdfRotation,
	pdfText,
	previewFrame,
	SVG_FIXTURE,
	takeDownload,
	zipEntries,
} from "./convert-companion-proof.helpers.ts";

test("converts and downloads a resized image, then persists output history in ExtensionHost storage", async ({
	page,
}) => {
	await observeDownloads(page);
	await openCompanion(page);
	const app = appFrame(page);
	await expect(page.locator(FRAME_SELECTOR)).toHaveAttribute(
		"sandbox",
		/allow-downloads/
	);
	await page.locator(FRAME_SELECTOR).evaluate((iframe) => {
		const tokens = new Set(iframe.getAttribute("sandbox")?.split(/\s+/u));
		if (tokens.has("allow-same-origin") || tokens.has("allow-top-navigation")) {
			throw new Error("Convert's sandbox allows an ungranted host escape.");
		}
	});
	await app.locator('input[type="file"]').setInputFiles({
		buffer: SVG_FIXTURE,
		mimeType: "image/svg+xml",
		name: "tiny.svg",
	});

	const row = app.getByRole("listitem").filter({ hasText: "tiny.svg" });
	await expect(row).toContainText("Queued");
	const queueSection = app
		.getByRole("list", { name: "Files to convert" })
		.locator("..");
	await expect(queueSection.getByText("1 file", { exact: true })).toBeVisible();
	const settingsSummary = app.getByText("Ready to process").locator("..");
	await expect(
		settingsSummary.getByText("1 file", { exact: true })
	).toBeVisible();
	const outputFormat = app.getByLabel("Output format for tiny.svg");
	await outputFormat.selectOption("jpeg");
	await expect(outputFormat).toHaveValue("jpeg");

	const quality = app.getByRole("slider", { name: "Image quality" });
	await quality.focus();
	for (let step = 0; step < 20; step += 1) {
		await quality.press("ArrowLeft");
	}
	await expect(app.getByText("72%", { exact: true })).toBeVisible();
	await app.getByPlaceholder("Original width").fill("1");
	await expect(app.getByPlaceholder("Original width")).toHaveValue("1");
	await captureProduct(page, "convert-image-jpeg-output-ready.png");

	await app.getByRole("button", { name: "Convert batch" }).click();
	await expect(app.getByRole("status")).toContainText(
		"1 file converted locally. Download the result below."
	);
	await expect(row).toContainText("Ready");

	const downloaded = await takeDownload(page, row, "Download");
	expect(downloaded.filename).toBe("tiny.jpg");
	expect(downloaded.bytes.subarray(0, 3)).toEqual(
		Buffer.from([0xff, 0xd8, 0xff])
	);
	expect(jpegDimensions(downloaded.bytes)).toEqual({ height: 1, width: 1 });

	const state = await fixtureState(page);
	expect(state.downloads.at(-1)).toMatchObject({
		filename: "tiny.jpg",
		href: expect.stringMatching(/^blob:/u),
	});
	expect(state.calls).toContainEqual({
		input: { key: "history", namespace: "convert" },
		method: "storage.get",
	});
	expect(state.calls.some((call) => call.method === "storage.set")).toBe(true);
	expect(state.toasts).toContainEqual({
		input: { title: "1 local conversion complete.", variant: "success" },
		method: "ui.toast.show",
	});
	// SAFETY: Native Convert loads old rows through historyRowsSchema and appends conversion/merge rows with string name/source/target and Blob.size; saveHistory JSON.stringify and the controlled storageSet preserve that same history string.
	const history = JSON.parse(state.history ?? "[]") as Array<{
		name: string;
		size: number;
		source: string;
		target: string;
	}>;
	expect(history).toHaveLength(1);
	expect(history[0]).toMatchObject({
		name: "tiny.jpg",
		size: downloaded.bytes.byteLength,
		source: "tiny.svg",
		target: "jpeg",
	});

	await page.goto("/?view=history");
	await expect(
		appFrame(page).getByRole("heading", { name: "Conversion history" })
	).toBeVisible();
	const historyList = appFrame(page).getByRole("list", {
		name: "Conversion history",
	});
	await expect(historyList.getByRole("listitem")).toContainText("tiny.jpg");
	await expect(
		appFrame(page).getByText("tiny.svg → JPEG", { exact: true })
	).toBeVisible();
	await captureProduct(page, "convert-image-history-after-reload.png");
});

test("adds files, downloads a real batch archive, removes one row, and clears the queue", async ({
	page,
}) => {
	await observeDownloads(page);
	await openCompanion(page);
	const app = appFrame(page);
	await app.locator('input[type="file"]').setInputFiles({
		buffer: Buffer.from('[{"name":"Ada","role":"Builder"}]'),
		mimeType: "application/json",
		name: "people.json",
	});

	const chooserEvent = page.waitForEvent("filechooser");
	await app.getByRole("button", { name: "Add files" }).click();
	const chooser = await chooserEvent;
	await chooser.setFiles({
		buffer: Buffer.from("Local first, private by default."),
		mimeType: "text/markdown",
		name: "notes.md",
	});

	const peopleRow = app
		.getByRole("listitem")
		.filter({ hasText: "people.json" });
	const notesRow = app.getByRole("listitem").filter({ hasText: "notes.md" });
	await expect(app.getByRole("listitem")).toHaveCount(2);
	const queueSection = app
		.getByRole("list", { name: "Files to convert" })
		.locator("..");
	await expect(
		queueSection.getByText("2 files", { exact: true })
	).toBeVisible();
	const settingsSummary = app.getByText("Ready to process").locator("..");
	await expect(
		settingsSummary.getByText("2 files", { exact: true })
	).toBeVisible();
	await peopleRow
		.getByLabel("Output format for people.json")
		.selectOption("csv");
	await notesRow.getByLabel("Output format for notes.md").selectOption("txt");
	await app.getByRole("button", { name: "Convert batch" }).click();
	await expect(app.getByRole("status")).toContainText(
		"2 files converted locally. Download the results below."
	);
	await expect(app.getByRole("button", { name: "Download all" })).toBeVisible();
	await captureProduct(page, "convert-batch-results-ready.png");

	const archive = await takeDownload(page, app, "Download all");
	expect(archive.filename).toBe("convert-results.zip");
	const entries = zipEntries(archive.bytes);
	expect(entries.map((entry) => entry.name).sort()).toEqual([
		"notes.txt",
		"people.csv",
	]);
	expect(
		entries.find((entry) => entry.name === "people.csv")?.bytes.toString()
	).toBe("name,role\nAda,Builder");
	expect(
		entries.find((entry) => entry.name === "notes.txt")?.bytes.toString()
	).toBe("Local first, private by default.");

	await notesRow.getByRole("button", { name: "Remove notes.md" }).click();
	await expect(app.getByRole("listitem")).toHaveCount(1);
	await expect(notesRow).toHaveCount(0);
	await app.getByRole("button", { name: "Clear batch" }).click();
	await expect(
		app.getByRole("heading", { name: "No files queued." })
	).toBeVisible();
	await expect(app.getByRole("status")).toContainText(
		"Batch cleared. Your source files were not changed."
	);
});

test("preview tabs navigate Convert, History, Formats, and Tools, including the empty-history action", async ({
	page,
}) => {
	await openPreview(page);
	const app = previewFrame(page);
	const tabs = app.getByRole("tablist", { name: "Convert preview views" });
	await expect(tabs.getByRole("tab", { name: "Convert" })).toHaveAttribute(
		"aria-selected",
		"true"
	);

	await tabs.getByRole("tab", { name: "History" }).click();
	await expect(
		app.getByRole("heading", { name: "Conversion history" })
	).toBeVisible();
	await expect(
		app.getByText("Your completed local runs will appear here.", {
			exact: true,
		})
	).toBeVisible();
	await app.getByRole("button", { name: "Start with a file above" }).click();
	await expect(
		app.getByRole("heading", { name: "No files queued." })
	).toBeVisible();
	await expect(tabs.getByRole("tab", { name: "Convert" })).toHaveAttribute(
		"aria-selected",
		"true"
	);

	await tabs.getByRole("tab", { name: "Formats" }).click();
	await expect(
		app.getByRole("heading", { name: "Formats that work here" })
	).toBeVisible();
	await expect(app.getByRole("heading", { name: "Data" })).toBeVisible();
	await tabs.getByRole("tab", { name: "Tools" }).click();
	await expect(app.getByRole("heading", { name: "Local tools" })).toBeVisible();
	await expect(app.getByRole("heading", { name: "PDF toolkit" })).toBeVisible();
	await tabs.getByRole("tab", { name: "Convert" }).click();
	await expect(
		app.getByRole("heading", { name: "No files queued." })
	).toBeVisible();
	await captureProduct(
		page,
		"convert-preview-tabs-and-workspace.png",
		PREVIEW_SELECTOR
	);
});

test("merges selected PDF inputs and downloads a valid combined document", async ({
	page,
}) => {
	await observeDownloads(page);
	await openCompanion(page);
	const app = appFrame(page);
	const firstPdf = await createPdfFixture(1);
	const secondPdf = await createPdfFixture(1);
	await app.locator('input[type="file"]').setInputFiles([
		{
			buffer: firstPdf,
			mimeType: "application/pdf",
			name: "first.pdf",
		},
		{
			buffer: secondPdf,
			mimeType: "application/pdf",
			name: "second.pdf",
		},
	]);
	await expect(app.getByRole("button", { name: "Merge PDFs" })).toBeVisible();
	await app.getByRole("button", { name: "Merge PDFs" }).click();
	await expect(app.getByRole("status")).toContainText(
		"2 PDFs merged locally. Download the combined file when ready."
	);

	const merged = await takeDownload(page, app, "Download combined.pdf");
	expect(merged.filename).toBe("combined.pdf");
	expect(await pdfPageCount(merged.bytes)).toBe(2);
	const state = await fixtureState(page);
	// SAFETY: Native Convert loads old rows through historyRowsSchema and appends conversion/merge rows with string name/source/target and Blob.size; saveHistory JSON.stringify and the controlled storageSet preserve that same history string.
	const history = JSON.parse(state.history ?? "[]") as Array<{
		name: string;
		source: string;
		target: string;
	}>;
	expect(history[0]).toMatchObject({
		name: "combined.pdf",
		source: "2 PDFs",
		target: "pdf",
	});
	await expect(app.getByRole("listitem")).toHaveCount(2);
});

test("PDF tools apply operations, validate page ranges, and recover on retry", async ({
	page,
}) => {
	await observeDownloads(page);
	await openCompanion(page, "tools");
	const app = appFrame(page);
	const sourcePdf = await createPdfFixture(3);
	const pickerEvent = page.waitForEvent("filechooser");
	await app.getByRole("button", { name: "Choose PDF" }).click();
	await (await pickerEvent).setFiles({
		buffer: sourcePdf,
		mimeType: "application/pdf",
		name: "fixture.pdf",
	});
	await expect(app.getByText("fixture.pdf", { exact: true })).toBeVisible();
	const operation = app.getByLabel("PDF operation");
	const run = app.getByRole("button", { name: "Run PDF tool" });

	await operation.selectOption("extract");
	const pages = app.getByPlaceholder("1, 3-5");
	await pages.fill("9");
	await run.click();
	await expect(app.getByRole("status")).toContainText(
		"Page 9 is outside this PDF."
	);
	await expect(
		app.getByRole("button", { name: "Download fixture-pages.zip" })
	).toHaveCount(0);

	await pages.fill("1, 3");
	await run.click();
	await expect(app.getByRole("status")).toContainText(
		"ZIP PDF tool result is ready locally."
	);
	const extracted = await takeDownload(page, app, "Download fixture-pages.zip");
	const extractedPages = zipEntries(extracted.bytes);
	expect(extractedPages.map((entry) => entry.name).sort()).toEqual([
		"fixture-01.pdf",
		"fixture-02.pdf",
	]);
	for (const entry of extractedPages) {
		expect(await pdfPageCount(entry.bytes)).toBe(1);
	}

	await operation.selectOption("compress");
	await run.click();
	await expect(app.getByRole("status")).toContainText(
		"PDF PDF tool result is ready locally."
	);
	const compressed = await takeDownload(
		page,
		app,
		"Download fixture-compress.pdf"
	);
	expect(await pdfPageCount(compressed.bytes)).toBe(3);

	await operation.selectOption("split");
	await run.click();
	await expect(app.getByRole("status")).toContainText(
		"ZIP PDF tool result is ready locally."
	);
	const split = await takeDownload(page, app, "Download fixture-split.zip");
	const splitPages = zipEntries(split.bytes);
	expect(splitPages).toHaveLength(3);
	for (const entry of splitPages) {
		expect(await pdfPageCount(entry.bytes)).toBe(1);
	}

	await operation.selectOption("rotate");
	const pdfRotationSelect = app.getByLabel("PDF rotation");
	for (const angle of ["90", "180", "270"]) {
		await pdfRotationSelect.selectOption(angle);
		await run.click();
		const rotated = await takeDownload(
			page,
			app,
			"Download fixture-rotate.pdf"
		);
		expect(await pdfRotation(rotated.bytes)).toBe(Number(angle));
	}

	await operation.selectOption("page-numbers");
	await run.click();
	const numbered = await takeDownload(
		page,
		app,
		"Download fixture-page-numbers.pdf"
	);
	expect(await pdfPageCount(numbered.bytes)).toBe(3);
	expect(await pdfText(numbered.bytes)).toContain("1 / 3");

	await operation.selectOption("watermark");
	await app.getByPlaceholder("Private copy").fill("Local proof watermark");
	await run.click();
	const watermarked = await takeDownload(
		page,
		app,
		"Download fixture-watermark.pdf"
	);
	expect(await pdfPageCount(watermarked.bytes)).toBe(3);
	expect(await pdfText(watermarked.bytes)).toContain("Local proof watermark");
	await captureProduct(page, "convert-pdf-tools-watermark-result.png");
});
