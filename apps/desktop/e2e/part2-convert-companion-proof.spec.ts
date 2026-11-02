// Continues convert-companion-proof.spec.ts (split under the file token limit); helpers live in convert-companion-proof.helpers.ts.

import { expect, test } from "@playwright/test";
import {
	appFrame,
	captureProduct,
	IMAGE_TOOL_FIXTURE,
	imageFingerprint,
	jpegDimensions,
	makePcmWavFixture,
	observeDownloads,
	openCompanion,
	pdfPageCount,
	pngDimensions,
	takeDownload,
} from "./convert-companion-proof.helpers.ts";

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
