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
} from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for convert-companion-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const EVIDENCE = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);
export const FRAME_SELECTOR = 'iframe[title="Convert"]';
export const PREVIEW_SELECTOR = 'iframe[title="Convert preview"]';
export const SVG_FIXTURE = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1" viewBox="0 0 2 1"><rect width="1" height="1" fill="#f00"/><rect x="1" width="1" height="1" fill="#00f"/></svg>'
);
export const IMAGE_TOOL_FIXTURE = Buffer.from(makeImageToolSvg());
export const requireConvert = createRequire(
	fileURLToPath(
		new URL("../../../apps-store/convert/ui/package.json", import.meta.url)
	)
);

export interface PdfPage {
	drawText(text: string): void;
	getRotation(): { angle: number };
}

export interface PdfDocument {
	addPage(): PdfPage;
	getPage(index: number): PdfPage;
	getPageCount(): number;
	save(options?: { useObjectStreams?: boolean }): Promise<Uint8Array>;
}

export interface PdfDocumentRuntime {
	create(): Promise<PdfDocument>;
	load(bytes: ArrayBuffer | Uint8Array): Promise<PdfDocument>;
}

export interface PdfJsDocument {
	getPage(pageNumber: number): Promise<{
		getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
	}>;
	numPages: number;
}

export interface PdfJsLoadingTask {
	destroy(): Promise<void>;
	promise: Promise<PdfJsDocument>;
}

export interface PdfJsRuntime {
	getDocument(options: {
		data: Uint8Array;
		disableWorker: boolean;
		verbosity: number;
	}): PdfJsLoadingTask;
}

export interface HostCall {
	input: unknown;
	method: string;
}

export interface DownloadAttempt {
	body: number[];
	filename: string;
	href: string;
}

export interface FixtureState {
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
export const PDFDocument = (
	requireConvert("pdf-lib") as { PDFDocument: PdfDocumentRuntime }
).PDFDocument;

export function makeImageToolSvg(): string {
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

export function makePcmWavFixture(): Buffer {
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

export function appFrame(page: Page): FrameLocator {
	return page.frameLocator(FRAME_SELECTOR);
}

export function previewFrame(page: Page): FrameLocator {
	return page.frameLocator(PREVIEW_SELECTOR);
}

export async function openCompanion(
	page: Page,
	view = "convert"
): Promise<void> {
	await page.goto(`/?view=${encodeURIComponent(view)}`);
	await expect(
		appFrame(page).getByRole("heading", {
			name: "Convert files locally.",
			exact: true,
		})
	).toBeVisible();
}

export async function openPreview(page: Page): Promise<void> {
	await page.goto("/?surface=preview");
	await expect(
		previewFrame(page).getByRole("heading", {
			name: "Convert files locally.",
			exact: true,
		})
	).toBeVisible();
}

export async function fixtureState(page: Page): Promise<FixtureState> {
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

export async function captureProduct(
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

export async function observeDownloads(page: Page): Promise<void> {
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

export async function takeDownload(
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

export async function createPdfFixture(pageCount: number): Promise<Buffer> {
	const document = await PDFDocument.create();
	for (let index = 0; index < pageCount; index += 1) {
		document.addPage().drawText(`Fixture page ${index + 1}`);
	}
	return Buffer.from(await document.save({ useObjectStreams: true }));
}

export async function pdfPageCount(bytes: Buffer): Promise<number> {
	const document = await PDFDocument.load(bytes);
	return document.getPageCount();
}

export async function pdfRotation(
	bytes: Buffer,
	pageIndex = 0
): Promise<number> {
	const document = await PDFDocument.load(bytes);
	return document.getPage(pageIndex).getRotation().angle;
}

export async function pdfText(bytes: Buffer): Promise<string> {
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

export function zipEntries(
	bytes: Buffer
): Array<{ bytes: Buffer; name: string }> {
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

export function pngDimensions(bytes: Buffer) {
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

export function jpegDimensions(bytes: Buffer) {
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

export async function imageFingerprint(
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
