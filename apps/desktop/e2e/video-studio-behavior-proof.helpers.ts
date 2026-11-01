import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { parseProofJsonRecord } from "./fixture-json.ts";

export const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

export interface StudioRequest {
	body?: unknown;
	method: string;
	path: string;
}

export function uniqueTitle(prefix: string) {
	return `${prefix} ${new Date().toISOString().replaceAll(":", "-")} ${crypto.randomUUID().slice(0, 8)}`;
}

export function recordStudioRequests(page: Page) {
	const requests: StudioRequest[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (!url.pathname.startsWith("/__studio/")) {
			return;
		}
		const body = request.postData();
		let parsedBody: unknown;
		if (body) {
			try {
				parsedBody = JSON.parse(body);
			} catch {
				parsedBody = body;
			}
		}
		requests.push({
			...(parsedBody === undefined ? undefined : { body: parsedBody }),
			method: request.method(),
			path: url.pathname.slice("/__studio".length),
		});
	});
	return requests;
}

export async function openOverflowTab(
	page: Page,
	label: string,
	value: string
) {
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page.getByRole("combobox", { name: "Search tabs" }).fill(label);
	const tabItem = page.locator(`[data-tabs-menu-key="string:${value}"]`);
	await expect(tabItem).toBeVisible();
	await tabItem.click();
}

export async function projectTitleField(page: Page) {
	return page
		.locator(".studio-inspector .ryu-app-field")
		.first()
		.locator("input");
}

export async function createProject(page: Page, title: string) {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByRole("button", { name: "New project" }).click();
	await expect(page.getByRole("status")).toContainText("Project created.");
	const titleField = await projectTitleField(page);
	await expect(titleField).toBeVisible();
	await titleField.fill(title);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	return titleField;
}

export async function makePng(page: Page, label: string): Promise<Buffer> {
	const bytes = await page.evaluate(async (text) => {
		const canvas = document.createElement("canvas");
		canvas.width = 640;
		canvas.height = 360;
		const context = canvas.getContext("2d");
		if (!context) {
			throw new Error("Canvas rendering is unavailable.");
		}
		context.fillStyle = "#0c2340";
		context.fillRect(0, 0, 640, 360);
		context.fillStyle = "#f97316";
		context.fillRect(80, 60, 480, 240);
		context.fillStyle = "#ffffff";
		context.font = "600 28px sans-serif";
		context.fillText(text, 96, 185);
		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((result) => {
				if (result) {
					resolve(result);
				} else {
					reject(new Error("Could not create the image fixture."));
				}
			}, "image/png");
		});
		return Array.from(new Uint8Array(await blob.arrayBuffer()));
	}, label);
	return Buffer.from(bytes);
}

export async function importImage(page: Page, name: string) {
	const fileChooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import media" }).click();
	await (await fileChooserPromise).setFiles({
		buffer: await makePng(page, name),
		mimeType: "image/png",
		name,
	});
	await expect(page.getByRole("status")).toContainText("Media imported.");
}

export async function importVideo(
	page: Page,
	filePath: string,
	fileName: string
) {
	const fileChooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import media" }).click();
	await (await fileChooserPromise).setFiles(filePath);
	await expect(page.getByRole("status")).toContainText("Media imported.", {
		timeout: 30_000,
	});
	await expect(
		page.getByRole("button", { name: `Add ${fileName} to timeline` })
	).toBeVisible();
}

export async function createSyntheticVideo(
	outputPath: string,
	color: string,
	frequency: number
) {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("ffmpeg", [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			`color=c=${color}:s=320x180:r=24:d=4`,
			"-f",
			"lavfi",
			"-i",
			`sine=frequency=${frequency}:sample_rate=48000:duration=4`,
			"-shortest",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-y",
			outputPath,
		]);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-2000);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(stderr || `FFmpeg exited with ${code}.`));
			}
		});
	});
}

export async function assertPreviewPixels(page: Page, screenshotPath: string) {
	const screenshot = await page.screenshot({
		fullPage: true,
		path: screenshotPath,
	});
	const width = screenshot.readUInt32BE(16);
	const height = screenshot.readUInt32BE(20);
	const pixels = await new Promise<Buffer>((resolve, reject) => {
		const child = spawn("ffmpeg", [
			"-v",
			"error",
			"-f",
			"image2pipe",
			"-i",
			"pipe:0",
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgb24",
			"pipe:1",
		]);
		const chunks: Buffer[] = [];
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-1000);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks));
			} else {
				reject(new Error(stderr || `Screenshot decode exited with ${code}.`));
			}
		});
		child.stdin.end(screenshot);
	});
	expect(pixels).toHaveLength(width * height * 3);
	const samplePoints = await page.evaluate(() => {
		return ["recipe-first.png", "recipe-second.png"].map((name) => {
			const image = [
				...document.querySelectorAll<HTMLImageElement>(
					".studio-preview-frame img"
				),
			].find((candidate) => candidate.alt === name);
			if (!image) {
				throw new Error(`Preview image ${name} is missing.`);
			}
			const rectangle = image.getBoundingClientRect();
			const imageWidth = Math.min(
				rectangle.width,
				rectangle.height * (image.naturalWidth / image.naturalHeight)
			);
			const imageHeight =
				imageWidth / (image.naturalWidth / image.naturalHeight);
			return {
				x: rectangle.x + (rectangle.width - imageWidth) / 2 + imageWidth * 0.75,
				y:
					rectangle.y +
					(rectangle.height - imageHeight) / 2 +
					imageHeight * 0.5,
			};
		});
	});
	const scale = await page.evaluate(() => window.devicePixelRatio);
	for (const { x, y } of samplePoints) {
		const offset = (Math.floor(y * scale) * width + Math.floor(x * scale)) * 3;
		expect(pixels[offset]).toBeGreaterThan(180);
		expect(pixels[offset + 1]).toBeGreaterThan(70);
		expect(pixels[offset + 1]).toBeLessThan(160);
		expect(pixels[offset + 2]).toBeLessThan(60);
	}
}

export async function downloadProjectJson(page: Page) {
	await openOverflowTab(page, "Exports", "exports");
	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download project JSON" }).click();
	const download = await downloadPromise;
	const outputPath = await download.path();
	if (!outputPath) {
		throw new Error("Playwright did not preserve the project JSON download.");
	}
	// SAFETY: The native App project-JSON button downloads JSON.stringify of its active project object; Playwright returns that download file, and this view leaves every field value unknown.
	return parseProofJsonRecord(await readFile(outputPath, "utf8"));
}
