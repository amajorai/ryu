import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { projectSchema } from "../../../apps-store/video-studio/shared/project.ts";
import {
	capturedJsonArray,
	capturedJsonField,
} from "./captured-json-observations.ts";
import { parseProofJsonRecord } from "./fixture-json.ts";

const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface StudioRequest {
	body?: unknown;
	method: string;
	path: string;
}

function uniqueTitle(prefix: string) {
	return `${prefix} ${new Date().toISOString().replaceAll(":", "-")} ${crypto.randomUUID().slice(0, 8)}`;
}

function recordStudioRequests(page: Page) {
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

async function openOverflowTab(page: Page, label: string, value: string) {
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page.getByRole("combobox", { name: "Search tabs" }).fill(label);
	const tabItem = page.locator(`[data-tabs-menu-key="string:${value}"]`);
	await expect(tabItem).toBeVisible();
	await tabItem.click();
}

async function projectTitleField(page: Page) {
	return page
		.locator(".studio-inspector .ryu-app-field")
		.first()
		.locator("input");
}

async function createProject(page: Page, title: string) {
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

async function makePng(page: Page, label: string): Promise<Buffer> {
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

async function importImage(page: Page, name: string) {
	const fileChooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import media" }).click();
	await (await fileChooserPromise).setFiles({
		buffer: await makePng(page, name),
		mimeType: "image/png",
		name,
	});
	await expect(page.getByRole("status")).toContainText("Media imported.");
}

async function importVideo(page: Page, filePath: string, fileName: string) {
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

async function createSyntheticVideo(
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

async function assertPreviewPixels(page: Page, screenshotPath: string) {
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

async function downloadProjectJson(page: Page) {
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

test("recipe composition and layout edits reach the sidecar and survive reload", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const title = uniqueTitle("Coverage recipe layout");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	await importImage(page, "recipe-first.png");
	await importImage(page, "recipe-second.png");
	await openOverflowTab(page, "Recipes", "recipes");
	const applyRecipe = page.getByRole("button", { name: "Apply recipe" });
	await expect(applyRecipe).toBeDisabled();
	await page.getByLabel("Production recipe").selectOption("cinematic");
	await page.getByRole("button", { name: "recipe-first.png" }).click();
	await page.getByRole("button", { name: "recipe-second.png" }).click();
	await page.getByLabel("Recipe shot duration").fill("2.5");
	await page.getByLabel("Recipe title").fill("Two-shot review cut");
	await page.getByLabel("Recipe format").selectOption("vertical");
	await expect(applyRecipe).toBeEnabled();
	await applyRecipe.click();
	await expect(page.getByRole("status")).toContainText(
		"Recipe applied and saved. Review the timeline before exporting."
	);
	await expect(page.locator(".studio-stage-heading")).toContainText(
		"1080 × 1920"
	);
	for (const imageName of ["recipe-first.png", "recipe-second.png"]) {
		const preview = page.getByRole("img", { name: imageName, exact: true });
		await expect(preview).toBeVisible();
		await expect
			.poll(() =>
				preview.evaluate<number, HTMLImageElement>(
					(image) => image.naturalWidth
				)
			)
			.toBe(640);
	}
	const recipeRequest = requests.find(
		(request) => request.path === `/projects/${projectId}/recipe`
	);
	expect(recipeRequest).toMatchObject({
		method: "POST",
		body: {
			audioId: null,
			format: "vertical",
			kind: "cinematic",
			shotDuration: 2.5,
			title: "Two-shot review cut",
		},
	});
	expect(recipeRequest?.body).toMatchObject({
		assetIds: expect.arrayContaining([expect.any(String), expect.any(String)]),
	});
	const recipeIds = capturedJsonArray(
		capturedJsonField(recipeRequest?.body, "assetIds")
	);
	expect(recipeIds).toHaveLength(2);
	await expect(
		page.getByRole("button", { name: "Export video" })
	).toBeEnabled();
	await page
		.getByRole("button", { name: /Select recipe-second\.png at/ })
		.click();
	const secondClipStart = page.getByRole("spinbutton", {
		name: "Timeline start",
	});
	await secondClipStart.fill("0");
	await secondClipStart.press("Tab");
	const secondClipTrack = page.getByRole("spinbutton", { name: "Track" });
	await secondClipTrack.fill("2");
	await secondClipTrack.press("Tab");
	await expect(secondClipStart).toHaveValue("0");
	await expect(secondClipTrack).toHaveValue("2");

	await openOverflowTab(page, "Layouts", "layouts");
	await page.getByLabel("Layout preset").selectOption("side-by-side");
	const firstClip = page.getByRole("button", {
		name: "recipe-first.png · Track 1",
		exact: true,
	});
	const secondClip = page.getByRole("button", {
		name: "recipe-second.png · Track 2",
		exact: true,
	});
	await firstClip.click();
	await secondClip.click();
	await expect(
		page.getByRole("button", { name: "Apply layout" })
	).toBeEnabled();
	await page.getByRole("button", { name: "Apply layout" }).click();
	await expect(page.getByRole("status")).toContainText(
		"side-by-side layout applied to 2 clips."
	);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const playhead = page.getByRole("spinbutton", { name: "Playhead" });
	await playhead.fill("1");
	await playhead.press("Tab");
	for (const imageName of ["recipe-first.png", "recipe-second.png"]) {
		const preview = page.getByRole("img", { name: imageName, exact: true });
		await expect
			.poll(() =>
				preview.evaluate((image) =>
					Number.parseFloat(getComputedStyle(image).opacity)
				)
			)
			.toBeGreaterThan(0.9);
	}
	const firstPreview = page.getByRole("img", {
		name: "recipe-first.png",
		exact: true,
	});
	const secondPreview = page.getByRole("img", {
		name: "recipe-second.png",
		exact: true,
	});
	expect(
		await firstPreview.evaluate((image) => image.getBoundingClientRect().x)
	).toBeLessThan(
		await secondPreview.evaluate((image) => image.getBoundingClientRect().x)
	);
	const saveRequest = [...requests]
		.reverse()
		.find(
			(request) =>
				request.path === `/projects/${projectId}` && request.method === "PUT"
		);
	const savedProject = projectSchema.parse(saveRequest?.body);
	expect(savedProject.segments).toHaveLength(2);
	expect(savedProject.segments.map((segment) => segment.assetId)).toEqual(
		recipeIds
	);
	expect(savedProject.segments.map((segment) => segment.start)).toEqual([0, 0]);
	expect(savedProject.segments.map((segment) => segment.track)).toEqual([0, 1]);
	expect(
		savedProject.segments.map(({ scale, x, y }) => ({ scale, x, y }))
	).toEqual([
		{ scale: 0.5, x: -0.5, y: 0 },
		{ scale: 0.5, x: 0.5, y: 0 },
	]);
	expect(savedProject.titles).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ text: "Two-shot review cut" }),
		])
	);
	await assertPreviewPixels(
		page,
		path.join(evidenceDir, "video-studio-recipe-layout-persisted.png")
	);

	await page.reload();
	await page.getByLabel("Project").selectOption({ label: title });
	await expect(page.locator(".studio-stage-heading")).toContainText(
		"1080 × 1920"
	);
	await openOverflowTab(page, "Layouts", "layouts");
	const reloadedPreview = page.getByRole("img", {
		name: "recipe-first.png",
		exact: true,
	});
	await expect(reloadedPreview).toBeVisible();
	await expect
		.poll(() =>
			reloadedPreview.evaluate<number, HTMLImageElement>(
				(image) => image.naturalWidth
			)
		)
		.toBe(640);
	const reloadedSecondPreview = page.getByRole("img", {
		name: "recipe-second.png",
		exact: true,
	});
	await expect(reloadedSecondPreview).toBeVisible();
	await expect
		.poll(() =>
			reloadedSecondPreview.evaluate<number, HTMLImageElement>(
				(image) => image.naturalWidth
			)
		)
		.toBe(640);
	const reloaded = await downloadProjectJson(page);
	expect(reloaded).toMatchObject({
		height: 1920,
		title,
		width: 1080,
	});
	expect(reloaded.segments).toEqual(savedProject.segments);
	await openOverflowTab(page, "Layouts", "layouts");
	const reloadedPlayhead = page.getByRole("spinbutton", {
		name: "Playhead",
	});
	await reloadedPlayhead.fill("1");
	await reloadedPlayhead.press("Tab");
	for (const preview of [reloadedPreview, reloadedSecondPreview]) {
		await expect
			.poll(() =>
				preview.evaluate((image) =>
					Number.parseFloat(getComputedStyle(image).opacity)
				)
			)
			.toBeGreaterThan(0.9);
	}
	await assertPreviewPixels(
		page,
		path.join(evidenceDir, "video-studio-layout-after-reload.png")
	);
});

test("multicam create, angle switch and ungroup persist real editable timeline state", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "video-studio-multicam-")
	);
	try {
		const cameraOne = path.join(directory, "camera-one.mp4");
		const cameraTwo = path.join(directory, "camera-two.mp4");
		const programAudio = path.join(directory, "program-audio.mp4");
		await Promise.all([
			createSyntheticVideo(cameraOne, "red", 440),
			createSyntheticVideo(cameraTwo, "blue", 523),
			createSyntheticVideo(programAudio, "green", 659),
		]);
		const title = uniqueTitle("Coverage multicam");
		await createProject(page, title);
		const projectId = await page.getByLabel("Project").inputValue();
		await importVideo(page, cameraOne, "camera-one.mp4");
		await importVideo(page, cameraTwo, "camera-two.mp4");
		await importVideo(page, programAudio, "program-audio.mp4");
		await openOverflowTab(page, "Multicam", "multicam");
		await expect(
			page.getByRole("button", { name: "Create multicam session" })
		).toBeDisabled();
		await page.getByRole("button", { name: "camera-one.mp4" }).click();
		await page.getByRole("button", { name: "camera-two.mp4" }).click();
		await page.getByLabel("Multicam program audio").selectOption({
			label: "program-audio.mp4",
		});
		await page.getByLabel("Multicam session name").fill("Interview angles");
		await expect(
			page.getByRole("button", { name: "Create multicam session" })
		).toBeEnabled();
		await page.getByRole("button", { name: "Create multicam session" }).click();
		await expect(page.getByRole("status")).toContainText(
			"Multicam session created with a program-audio track."
		);
		await expect(
			page.getByText(/1 full-frame angle range · program audio on track 2/)
		).toBeVisible();
		await page.getByLabel("Multicam switch angle").selectOption({
			label: "camera-two.mp4",
		});
		await page.getByLabel("Multicam switch start").fill("1");
		await page.getByLabel("Multicam switch end").fill("2");
		await page
			.getByRole("button", { name: "Switch camera over range" })
			.click();
		await expect(page.getByRole("status")).toContainText(
			"Camera angle switched over the selected range."
		);
		await expect(
			page.getByText(/3 full-frame angle ranges · program audio on track 2/)
		).toBeVisible();
		const multicamCalls = requests.filter(
			(request) =>
				request.path === `/projects/${projectId}/multicam` &&
				request.method === "POST"
		);
		expect(multicamCalls).toHaveLength(2);
		expect(multicamCalls[0]).toMatchObject({
			body: {
				action: "create",
				masterAssetId: expect.any(String),
				name: "Interview angles",
				members: expect.arrayContaining([
					expect.objectContaining({
						assetId: expect.any(String),
						kind: "angle",
					}),
					expect.objectContaining({ assetId: expect.any(String), kind: "mic" }),
				]),
			},
		});
		expect(multicamCalls[1]).toMatchObject({
			body: {
				action: "change",
				entries: [{ angle: "camera-two.mp4", end: 2, start: 1 }],
				groupId: expect.any(String),
			},
		});
		await page.screenshot({
			fullPage: true,
			path: path.join(evidenceDir, "video-studio-multicam-switched.png"),
		});

		await page.reload();
		await page.getByLabel("Project").selectOption({ label: title });
		await openOverflowTab(page, "Multicam", "multicam");
		const sessionPicker = page.getByLabel("Multicam session", { exact: true });
		await expect(
			sessionPicker.locator("option", { hasText: "Interview angles" })
		).toHaveCount(1);
		expect(await sessionPicker.inputValue()).not.toBe("");
		await expect(
			page.getByText(/3 full-frame angle ranges · program audio on track 2/)
		).toBeVisible();
		const persisted = await downloadProjectJson(page);
		expect(persisted.multicamGroups).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "Interview angles",
					switches: expect.arrayContaining([
						expect.objectContaining({
							angle: "camera-two.mp4",
							end: 2,
							start: 1,
						}),
					]),
				}),
			])
		);
		await openOverflowTab(page, "Multicam", "multicam");
		await page.getByRole("button", { name: "Ungroup session" }).click();
		await expect(page.getByRole("status")).toContainText(
			"Multicam metadata removed; timeline clips remain editable."
		);
		await expect(
			page.getByRole("button", { name: "Ungroup session" })
		).toHaveCount(0);
		await page.screenshot({
			fullPage: true,
			path: path.join(evidenceDir, "video-studio-multicam-ungrouped.png"),
		});
		const ungrouped = await downloadProjectJson(page);
		expect(ungrouped.multicamGroups).toEqual([]);
		expect(ungrouped.segments).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ assetId: expect.any(String), track: 0 }),
				expect.objectContaining({ assetId: expect.any(String), track: 1 }),
			])
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("source subtitle import validates, retries, maps to the timeline and survives reload", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "video-studio-transcript-")
	);
	try {
		const video = path.join(directory, "interview-source.mp4");
		await createSyntheticVideo(video, "purple", 392);
		const title = uniqueTitle("Coverage transcript");
		await createProject(page, title);
		const projectId = await page.getByLabel("Project").inputValue();
		void projectId;
		await importVideo(page, video, "interview-source.mp4");
		await page
			.getByRole("button", { name: "Add interview-source.mp4 to timeline" })
			.click();
		await openOverflowTab(page, "Transcript", "transcript");
		await page.getByLabel("Transcript source").selectOption({
			label: "interview-source.mp4",
		});

		const invalidFile = page.waitForEvent("filechooser");
		await page.getByRole("button", { name: "Import source SRT / VTT" }).click();
		await (await invalidFile).setFiles({
			buffer: Buffer.from("1\n00:00:00.500 --> broken\nInvalid cue\n"),
			mimeType: "text/plain",
			name: "invalid.srt",
		});
		await expect(page.getByRole("status")).toContainText(
			"Invalid subtitle timestamp."
		);
		await expect(
			page.getByRole("button", { name: "Import source SRT / VTT" })
		).toBeEnabled();

		const validFile = page.waitForEvent("filechooser");
		await page.getByRole("button", { name: "Import source SRT / VTT" }).click();
		await (await validFile).setFiles({
			buffer: Buffer.from(
				"1\n00:00:00,250 --> 00:00:01,250\nFirst spoken cue\n\n2\n00:00:01,500 --> 00:00:02,250\nSecond spoken cue\n"
			),
			mimeType: "text/plain",
			name: "interview.srt",
		});
		await expect(page.getByRole("status")).toContainText(
			"Source transcript imported with its original timings."
		);
		await expect(
			page.getByText("0.3s First spoken cue", { exact: true })
		).toBeVisible();
		await expect(
			page.getByText("1.5s Second spoken cue", { exact: true })
		).toBeVisible();
		await page
			.getByRole("button", { name: "Apply to timeline captions" })
			.click();
		await expect(page.getByRole("status")).toContainText(
			"Source transcript mapped onto the timeline, including trims and speed changes."
		);
		await page.getByRole("button", { name: "Save changes" }).click();
		await expect(page.getByRole("status")).toContainText("Project saved.");
		const playhead = page.getByRole("spinbutton", { name: "Playhead" });
		await playhead.fill("0.5");
		await playhead.press("Tab");
		const stageCaption = page.locator(".studio-preview-frame .studio-caption");
		await expect(stageCaption).toHaveText("First spoken cue");

		const importRequest = requests.find((request) =>
			request.path.endsWith("/import-transcript")
		);
		expect(importRequest).toMatchObject({
			method: "POST",
			body: {
				revision: null,
				cues: [
					expect.objectContaining({
						start: 0.25,
						end: 1.25,
						text: "First spoken cue",
					}),
					expect.objectContaining({
						start: 1.5,
						end: 2.25,
						text: "Second spoken cue",
					}),
				],
			},
		});
		await openOverflowTab(page, "Captions", "captions");
		await expect(page.getByRole("textbox", { name: "Caption 1" })).toHaveValue(
			"First spoken cue"
		);
		await page.screenshot({
			fullPage: true,
			path: path.join(
				evidenceDir,
				"video-studio-transcript-captions-saved.png"
			),
		});

		await page.reload();
		await page.getByLabel("Project").selectOption({ label: title });
		await openOverflowTab(page, "Transcript", "transcript");
		await page.getByLabel("Transcript source").selectOption({
			label: "interview-source.mp4",
		});
		await expect(
			page.getByText("0.3s First spoken cue", { exact: true })
		).toBeVisible();
		const reloadedPlayhead = page.getByRole("spinbutton", {
			name: "Playhead",
		});
		await reloadedPlayhead.fill("0.5");
		await reloadedPlayhead.press("Tab");
		await expect(
			page.locator(".studio-preview-frame .studio-caption")
		).toHaveText("First spoken cue");
		await page.screenshot({
			fullPage: true,
			path: path.join(evidenceDir, "video-studio-transcript-after-reload.png"),
		});
		const persisted = await downloadProjectJson(page);
		expect(persisted.captions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					end: 1.25,
					sourceAssetId: expect.any(String),
					start: 0.25,
					text: "First spoken cue",
				}),
				expect.objectContaining({
					end: 2.25,
					start: 1.5,
					text: "Second spoken cue",
				}),
			])
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
