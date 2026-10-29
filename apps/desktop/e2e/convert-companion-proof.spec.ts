import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import {
	expect,
	type FrameLocator,
	type Locator,
	type Page,
	test,
} from "@playwright/test";

const EVIDENCE = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);
const FRAME_SELECTOR = 'iframe[title="Convert"]';
const PREVIEW_SELECTOR = 'iframe[title="Convert preview"]';
const SVG_FIXTURE = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1" viewBox="0 0 2 1"><rect width="1" height="1" fill="#f00"/><rect x="1" width="1" height="1" fill="#00f"/></svg>'
);
const IMAGE_TOOL_FIXTURE = Buffer.from(makeImageToolSvg());
const requireConvert = createRequire(
	fileURLToPath(
		new URL("../../../apps-store/convert/ui/package.json", import.meta.url)
	)
);

interface PdfPage {
	drawText(text: string): void;
	getRotation(): { angle: number };
}

interface PdfDocument {
	addPage(): PdfPage;
	getPage(index: number): PdfPage;
	getPageCount(): number;
	save(options?: { useObjectStreams?: boolean }): Promise<Uint8Array>;
}

interface PdfDocumentRuntime {
	create(): Promise<PdfDocument>;
	load(bytes: ArrayBuffer | Uint8Array): Promise<PdfDocument>;
}

interface PdfJsDocument {
	getPage(pageNumber: number): Promise<{
		getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
	}>;
	numPages: number;
}

interface PdfJsLoadingTask {
	destroy(): Promise<void>;
	promise: Promise<PdfJsDocument>;
}

interface PdfJsRuntime {
	getDocument(options: {
		data: Uint8Array;
		disableWorker: boolean;
		verbosity: number;
	}): PdfJsLoadingTask;
}

interface HostCall {
	input: unknown;
	method: string;
}

interface DownloadAttempt {
	body: number[];
	filename: string;
	href: string;
}

interface FixtureState {
	calls: HostCall[];
	downloads: DownloadAttempt[];
	history: string | null;
	toasts: Array<{ input: unknown; method: string }>;
}

declare global {
	interface Window {
		__convertFixture?: {
			calls: HostCall[];
			downloads: DownloadAttempt[];
			getStored(namespace: string, key: string): string | null;
			toasts: Array<{ input: unknown; method: string }>;
		};
	}
}

// SAFETY: This require is rooted at the Convert package and resolves its installed pdf-lib; the native export supplies PDFDocument create/load, document/page methods and Uint8Array save results used by this reader.
const PDFDocument = (
	requireConvert("pdf-lib") as { PDFDocument: PdfDocumentRuntime }
).PDFDocument;

function makeImageToolSvg(): string {
	const tiles = Array.from({ length: 32 * 16 }, (_unused, index) => {
		const x = (index % 32) * 5;
		const y = Math.floor(index / 32) * 5;
		const red = ((index * 71) % 256).toString(16).padStart(2, "0");
		const green = ((index * 37 + 83) % 256).toString(16).padStart(2, "0");
		const blue = ((index * 19 + 151) % 256).toString(16).padStart(2, "0");
		return `<rect x="${x}" y="${y}" width="5" height="5" fill="#${red}${green}${blue}"/>`;
	}).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80">${tiles}</svg>`;
}

function makePcmWavFixture(): Buffer {
	const sampleRate = 8000;
	const sampleCount = 800;
	const pcmBytes = sampleCount * 2;
	const bytes = Buffer.alloc(44 + pcmBytes);
	bytes.write("RIFF", 0, "ascii");
	bytes.writeUInt32LE(36 + pcmBytes, 4);
	bytes.write("WAVE", 8, "ascii");
	bytes.write("fmt ", 12, "ascii");
	bytes.writeUInt32LE(16, 16);
	bytes.writeUInt16LE(1, 20);
	bytes.writeUInt16LE(1, 22);
	bytes.writeUInt32LE(sampleRate, 24);
	bytes.writeUInt32LE(sampleRate * 2, 28);
	bytes.writeUInt16LE(2, 32);
	bytes.writeUInt16LE(16, 34);
	bytes.write("data", 36, "ascii");
	bytes.writeUInt32LE(pcmBytes, 40);
	for (let sample = 0; sample < sampleCount; sample += 1) {
		const value = Math.round(
			Math.sin((2 * Math.PI * 440 * sample) / sampleRate) * 12_000
		);
		bytes.writeInt16LE(value, 44 + sample * 2);
	}
	return bytes;
}

function appFrame(page: Page): FrameLocator {
	return page.frameLocator(FRAME_SELECTOR);
}

function previewFrame(page: Page): FrameLocator {
	return page.frameLocator(PREVIEW_SELECTOR);
}

async function openCompanion(page: Page, view = "convert"): Promise<void> {
	await page.goto(`/?view=${encodeURIComponent(view)}`);
	await expect(
		appFrame(page).getByRole("heading", {
			name: "Convert files locally.",
			exact: true,
		})
	).toBeVisible();
}

async function openPreview(page: Page): Promise<void> {
	await page.goto("/?surface=preview");
	await expect(
		previewFrame(page).getByRole("heading", {
			name: "Convert files locally.",
			exact: true,
		})
	).toBeVisible();
}

async function fixtureState(page: Page): Promise<FixtureState> {
	return page.evaluate(() => {
		const fixture = window.__convertFixture;
		if (!fixture) {
			throw new Error("The local Convert ExtensionHost fixture is missing.");
		}
		return {
			calls: [...fixture.calls],
			downloads: [...fixture.downloads],
			history: fixture.getStored("convert", "history"),
			toasts: [...fixture.toasts],
		};
	});
}

async function captureProduct(
	page: Page,
	filename: string,
	selector = FRAME_SELECTOR
): Promise<void> {
	await mkdir(EVIDENCE, { recursive: true });
	await page.locator(selector).screenshot({
		animations: "disabled",
		path: path.join(EVIDENCE, filename),
	});
}

async function observeDownloads(page: Page): Promise<void> {
	await page.addInitScript(() => {
		if (window.parent === window) {
			return;
		}
		const createObjectURL = URL.createObjectURL.bind(URL);
		const clickAnchor = HTMLAnchorElement.prototype.click;
		let mostRecentBlob: { blob: Blob; href: string } | null = null;
		URL.createObjectURL = (value) => {
			const href = createObjectURL(value);
			if (value instanceof Blob) {
				mostRecentBlob = { blob: value, href };
			}
			return href;
		};
		HTMLAnchorElement.prototype.click = function click() {
			const current = mostRecentBlob;
			if (current && this.href === current.href && this.download) {
				const filename = this.download;
				const href = this.href;
				void current.blob.arrayBuffer().then((arrayBuffer) => {
					window.parent.postMessage(
						{
							body: Array.from(new Uint8Array(arrayBuffer)),
							filename,
							href,
							type: "convert-download",
						},
						"*"
					);
				});
			}
			return clickAnchor.call(this);
		};
	});
}

async function takeDownload(
	page: Page,
	frame: FrameLocator | Locator,
	buttonName: string
): Promise<{ bytes: Buffer; filename: string }> {
	const downloadEvent = page.waitForEvent("download");
	await frame.getByRole("button", { name: buttonName, exact: true }).click();
	const download = await downloadEvent;
	const downloadPath = await download.path();
	if (!downloadPath) {
		throw new Error(`${buttonName} did not produce a readable download file.`);
	}
	return {
		bytes: await readFile(downloadPath),
		filename: download.suggestedFilename(),
	};
}

async function createPdfFixture(pageCount: number): Promise<Buffer> {
	const document = await PDFDocument.create();
	for (let index = 0; index < pageCount; index += 1) {
		document.addPage().drawText(`Fixture page ${index + 1}`);
	}
	return Buffer.from(await document.save({ useObjectStreams: true }));
}

async function pdfPageCount(bytes: Buffer): Promise<number> {
	const document = await PDFDocument.load(bytes);
	return document.getPageCount();
}

async function pdfRotation(bytes: Buffer, pageIndex = 0): Promise<number> {
	const document = await PDFDocument.load(bytes);
	return document.getPage(pageIndex).getRotation().angle;
}

async function pdfText(bytes: Buffer): Promise<string> {
	const pdfJsPath = requireConvert.resolve("pdfjs-dist/legacy/build/pdf.mjs");
	// SAFETY: This exact Convert-resolved pdfjs-dist legacy ESM publishes native getDocument, its loading task promise/destroy and document/page text APIs; text items expose string str when present, with marked-content items safely lacking it.
	const { getDocument }: PdfJsRuntime = await import(
		pathToFileURL(pdfJsPath).href
	);
	const loadingTask = getDocument({
		data: new Uint8Array(bytes),
		disableWorker: true,
		verbosity: 0,
	});
	const document = await loadingTask.promise;
	try {
		const pageText: string[] = [];
		for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
			const page = await document.getPage(pageNumber);
			const content = await page.getTextContent();
			pageText.push(content.items.map((item) => item.str ?? "").join(" "));
		}
		return pageText.join("\n");
	} finally {
		await loadingTask.destroy();
	}
}

function zipEntries(bytes: Buffer): Array<{ bytes: Buffer; name: string }> {
	const endRecord = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (endRecord < 0) {
		throw new Error("The downloaded batch archive has no ZIP directory.");
	}
	const entryCount = bytes.readUInt16LE(endRecord + 10);
	let directoryOffset = bytes.readUInt32LE(endRecord + 16);
	const entries: Array<{ bytes: Buffer; name: string }> = [];
	for (let index = 0; index < entryCount; index += 1) {
		if (bytes.readUInt32LE(directoryOffset) !== 0x02_01_4b_50) {
			throw new Error("The downloaded batch archive has a malformed entry.");
		}
		const method = bytes.readUInt16LE(directoryOffset + 10);
		const compressedSize = bytes.readUInt32LE(directoryOffset + 20);
		const expectedSize = bytes.readUInt32LE(directoryOffset + 24);
		const nameLength = bytes.readUInt16LE(directoryOffset + 28);
		const extraLength = bytes.readUInt16LE(directoryOffset + 30);
		const commentLength = bytes.readUInt16LE(directoryOffset + 32);
		const localOffset = bytes.readUInt32LE(directoryOffset + 42);
		const nameStart = directoryOffset + 46;
		const name = bytes.toString("utf8", nameStart, nameStart + nameLength);
		const localNameLength = bytes.readUInt16LE(localOffset + 26);
		const localExtraLength = bytes.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
		const body =
			method === 0
				? Buffer.from(compressed)
				: method === 8
					? inflateRawSync(compressed)
					: null;
		if (!body || body.byteLength !== expectedSize) {
			throw new Error(`Unsupported or corrupt ZIP entry: ${name}`);
		}
		entries.push({ bytes: body, name });
		directoryOffset += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

function pngDimensions(bytes: Buffer) {
	if (
		!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	) {
		throw new Error("The downloaded image is not a PNG file.");
	}
	return {
		height: bytes.readUInt32BE(20),
		width: bytes.readUInt32BE(16),
	};
}

function jpegDimensions(bytes: Buffer) {
	const frameMarkers = new Set([
		0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
		0xcf,
	]);
	let offset = 2;
	while (offset + 8 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		while (bytes[offset] === 0xff) {
			offset += 1;
		}
		const marker = bytes[offset];
		offset += 1;
		if (
			marker === undefined ||
			marker === 0xd8 ||
			marker === 0xd9 ||
			marker === 0x01 ||
			(marker >= 0xd0 && marker <= 0xd7)
		) {
			continue;
		}
		const segmentLength = bytes.readUInt16BE(offset);
		if (marker !== undefined && frameMarkers.has(marker)) {
			return {
				height: bytes.readUInt16BE(offset + 3),
				width: bytes.readUInt16BE(offset + 5),
			};
		}
		offset += segmentLength;
	}
	throw new Error("The downloaded JPEG has no start-of-frame segment.");
}

async function imageFingerprint(
	page: Page,
	bytes: Buffer,
	type: "image/jpeg" | "image/png"
): Promise<{ height: number; hash: number; width: number }> {
	return appFrame(page)
		.locator("body")
		.evaluate(
			async (_body, payload) => {
				const source = new Blob([Uint8Array.from(payload.bytes)], {
					type: payload.type,
				});
				const image = await createImageBitmap(source);
				const canvas = document.createElement("canvas");
				canvas.width = image.width;
				canvas.height = image.height;
				const context = canvas.getContext("2d", { willReadFrequently: true });
				if (!context) {
					throw new Error("The browser could not inspect the converted image.");
				}
				context.drawImage(image, 0, 0);
				const pixels = context.getImageData(
					0,
					0,
					image.width,
					image.height
				).data;
				let hash = 2_166_136_261;
				for (const value of pixels) {
					hash = Math.imul(hash ^ value, 16_777_619);
				}
				image.close();
				return { height: canvas.height, hash: hash >>> 0, width: canvas.width };
			},
			{ bytes: Array.from(bytes), type }
		);
}

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

test("image tools apply crop, rotation, width, watermark, output, and quality settings", async ({
	page,
}) => {
	await observeDownloads(page);
	await openCompanion(page, "tools");
	const app = appFrame(page);
	const pickerEvent = page.waitForEvent("filechooser");
	await app.getByRole("button", { name: "Choose image" }).click();
	await (await pickerEvent).setFiles({
		buffer: IMAGE_TOOL_FIXTURE,
		mimeType: "image/svg+xml",
		name: "image-lab.svg",
	});
	await expect(app.getByText("image-lab.svg", { exact: true })).toBeVisible();
	const output = app.getByLabel("Image output format");
	const rotation = app.getByLabel("Image rotation");
	const maxWidth = app.getByPlaceholder("Original");
	const quality = app.getByLabel("Image quality");
	const run = app.getByRole("button", { name: "Run image tool" });

	await output.selectOption("png");
	await rotation.selectOption("90");
	await maxWidth.fill("20");
	await app.getByPlaceholder("x", { exact: true }).fill("10");
	await app.getByPlaceholder("y", { exact: true }).fill("5");
	await app.getByPlaceholder("width", { exact: true }).fill("80");
	await app.getByPlaceholder("height", { exact: true }).fill("40");
	await quality.fill("0.42");
	await expect(quality).toHaveValue("0.42");
	await run.click();
	const cropped = await takeDownload(page, app, "Download image-lab.png");
	expect(cropped.filename).toBe("image-lab.png");
	expect(pngDimensions(cropped.bytes)).toEqual({ height: 40, width: 20 });
	await captureProduct(page, "convert-image-tool-settings-result.png");

	await rotation.selectOption("0");
	await maxWidth.fill("");
	await app.getByPlaceholder("x", { exact: true }).fill("");
	await app.getByPlaceholder("y", { exact: true }).fill("");
	await app.getByPlaceholder("width", { exact: true }).fill("");
	await app.getByPlaceholder("height", { exact: true }).fill("");
	await app.getByPlaceholder("Optional text").fill("");
	await run.click();
	const plain = await takeDownload(page, app, "Download image-lab.png");
	const plainPixels = await imageFingerprint(page, plain.bytes, "image/png");
	expect(plainPixels).toMatchObject({ height: 80, width: 160 });

	await app.getByPlaceholder("Optional text").fill("Local proof");
	await run.click();
	const watermarked = await takeDownload(page, app, "Download image-lab.png");
	const watermarkedPixels = await imageFingerprint(
		page,
		watermarked.bytes,
		"image/png"
	);
	expect(watermarkedPixels.width).toBe(160);
	expect(watermarkedPixels.height).toBe(80);
	expect(watermarkedPixels.hash).not.toBe(plainPixels.hash);

	await app.getByPlaceholder("Optional text").fill("");
	for (const angle of ["180", "270"]) {
		await rotation.selectOption(angle);
		await run.click();
		const rotated = await takeDownload(page, app, "Download image-lab.png");
		expect(pngDimensions(rotated.bytes)).toEqual(
			angle === "180" ? { height: 80, width: 160 } : { height: 160, width: 80 }
		);
	}

	await rotation.selectOption("0");
	await output.selectOption("webp");
	await run.click();
	const webp = await takeDownload(page, app, "Download image-lab.webp");
	expect(webp.filename).toBe("image-lab.webp");
	expect(webp.bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
	expect(webp.bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");

	await output.selectOption("pdf");
	await run.click();
	const imagePdf = await takeDownload(page, app, "Download image-lab.pdf");
	expect(await pdfPageCount(imagePdf.bytes)).toBe(1);

	const avifSupported = await app.locator("body").evaluate(
		() =>
			new Promise<boolean>((resolve) => {
				const canvas = document.createElement("canvas");
				canvas.width = 1;
				canvas.height = 1;
				canvas.toBlob(
					(blob) => resolve(blob?.type === "image/avif"),
					"image/avif"
				);
			})
	);
	await output.selectOption("avif");
	await run.click();
	if (avifSupported) {
		const avif = await takeDownload(page, app, "Download image-lab.avif");
		expect(avif.filename).toBe("image-lab.avif");
		expect(avif.bytes.byteLength).toBeGreaterThan(16);
	} else {
		await expect(app.getByRole("status")).toContainText(
			"AVIF output is not supported by this browser."
		);
	}

	await output.selectOption("jpeg");
	await quality.fill("0.15");
	await run.click();
	const lowQuality = await takeDownload(page, app, "Download image-lab.jpg");
	const lowQualityDimensions = jpegDimensions(lowQuality.bytes);
	await quality.fill("0.95");
	await run.click();
	const highQuality = await takeDownload(page, app, "Download image-lab.jpg");
	expect(jpegDimensions(highQuality.bytes)).toEqual(lowQualityDimensions);
	expect(highQuality.bytes.byteLength).toBeGreaterThan(
		lowQuality.bytes.byteLength
	);
});

test("converts and downloads a local WAV through the rendered batch workflow", async ({
	page,
}) => {
	await observeDownloads(page);
	await openCompanion(page);
	const app = appFrame(page);
	await app.locator('input[type="file"]').setInputFiles({
		buffer: makePcmWavFixture(),
		mimeType: "audio/wav",
		name: "tone.wav",
	});
	const row = app.getByRole("listitem").filter({ hasText: "tone.wav" });
	const target = row.getByLabel("Output format for tone.wav");
	await target.selectOption("wav");
	await expect(target).toHaveValue("wav");
	await app.getByRole("button", { name: "Convert batch" }).click();
	await expect(app.getByRole("status")).toContainText(
		"1 file converted locally. Download the result below."
	);
	const downloaded = await takeDownload(page, row, "Download");
	expect(downloaded.filename).toBe("tone.wav");
	expect(downloaded.bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
	expect(downloaded.bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
	expect(downloaded.bytes.byteLength).toBeGreaterThan(44);
	await captureProduct(page, "convert-media-wav-output-ready.png");
});

test("a failed structured conversion stays visible and succeeds after choosing a valid output", async ({
	page,
}) => {
	await observeDownloads(page);
	await openCompanion(page);
	const app = appFrame(page);
	await app.locator('input[type="file"]').setInputFiles({
		buffer: Buffer.from("{broken json"),
		mimeType: "application/json",
		name: "broken.json",
	});
	const row = app.getByRole("listitem").filter({ hasText: "broken.json" });
	await expect(row.getByLabel("Output format for broken.json")).toHaveValue(
		"csv"
	);
	await app.getByRole("button", { name: "Convert batch" }).click();
	await expect(row).toContainText("Needs review");
	await expect(row.locator("small")).not.toBeEmpty();
	await expect(app.getByRole("status")).toContainText(
		"0 of 1 files converted. Review the errors and try again."
	);

	await row.getByLabel("Output format for broken.json").selectOption("json");
	await expect(row).toContainText("Queued");
	await app.getByRole("button", { name: "Convert batch" }).click();
	await expect(app.getByRole("status")).toContainText(
		"1 file converted locally. Download the result below."
	);
	const downloaded = await takeDownload(page, row, "Download");
	expect(downloaded.filename).toBe("broken.json");
	expect(JSON.parse(downloaded.bytes.toString())).toEqual({
		text: "{broken json",
	});
});
