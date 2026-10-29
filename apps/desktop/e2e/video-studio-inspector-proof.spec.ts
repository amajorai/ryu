import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type {
	Asset,
	Project,
	Segment,
} from "../../../apps-store/video-studio/shared/project.ts";
import { parseProofJson } from "./fixture-json.ts";

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
				parsedBody = parseProofJson(body);
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

async function seedAsset(
	page: Page,
	fixture: "audio" | "video",
	name: string
): Promise<Asset> {
	const fixtureResponse = await page.request.get(`/__proof/${fixture}`);
	expect(fixtureResponse.ok()).toBe(true);
	const bytes = await fixtureResponse.body();
	const start = await page.request.post("/__studio/uploads", {
		data: { name, size: bytes.byteLength },
	});
	expect(start.status()).toBe(201);
	const upload = await start.json();
	for (let offset = 0; offset < bytes.byteLength; offset += upload.chunkSize) {
		const response = await page.request.put(`/__studio/uploads/${upload.id}`, {
			data: {
				offset,
				data: bytes
					.subarray(offset, offset + upload.chunkSize)
					.toString("base64"),
			},
		});
		expect(response.ok()).toBe(true);
	}
	const finish = await page.request.post(
		`/__studio/uploads/${upload.id}/finish`
	);
	expect(finish.status()).toBe(201);
	const asset = await finish.json();
	expect(asset).toMatchObject({ name, kind: fixture });
	return asset;
}

async function createProject(page: Page, title: string) {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByRole("button", { name: "New project" }).click();
	await expect(page.getByRole("status")).toContainText("Project created.");
	const titleField = page
		.locator(".studio-inspector .ryu-app-field")
		.first()
		.locator("input");
	await titleField.fill(title);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
}

function assetRow(page: Page, assetName: string) {
	return page.locator(".studio-asset").filter({ hasText: assetName });
}

async function getProject(page: Page, projectId: string): Promise<Project> {
	const response = await page.request.get(`/__studio/projects/${projectId}`);
	expect(response.ok()).toBe(true);
	return await response.json();
}

function segmentFor(project: Project, segmentId: string): Segment {
	const segment = project.segments.find((item) => item.id === segmentId);
	if (!segment) {
		throw new Error(`Saved project is missing clip ${segmentId}.`);
	}
	return segment;
}

async function fillNumber(page: Page, label: string, value: string) {
	const field = page.getByRole("spinbutton", { name: label, exact: true });
	await field.fill(value);
	await field.press("Tab");
	await expect(field).toHaveValue(value);
}

async function saveProject(page: Page) {
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
}

async function waitForPreviewFrame(page: Page, expectedTime = 0) {
	const video = page.locator(".studio-preview-frame video").first();
	await expect(video).toHaveCount(1);
	await expect
		.poll(
			() =>
				video.evaluate((element) => {
					if (!(element instanceof HTMLVideoElement)) {
						throw new Error(
							"Expected proof element to be an HTMLVideoElement."
						);
					}
					return element.readyState;
				}),
			{ timeout: 10_000 }
		)
		.toBeGreaterThanOrEqual(2);
	await expect
		.poll(
			() =>
				video.evaluate((element) => {
					if (!(element instanceof HTMLVideoElement)) {
						throw new Error(
							"Expected proof element to be an HTMLVideoElement."
						);
					}
					return element.currentTime;
				}),
			{ timeout: 10_000 }
		)
		.toBeCloseTo(expectedTime, 2);
}

async function captureScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

test("Clip inspector saves visual changes, effect/transition values, and editable keyframes with retry", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const video = await seedAsset(
		page,
		"video",
		`${uniqueTitle("Inspector visual source")}.mp4`
	);
	const title = uniqueTitle("Inspector visual project");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	const mediaRow = assetRow(page, video.name);
	await mediaRow
		.getByRole("button", { name: `Add ${video.name} to timeline` })
		.click();
	await saveProject(page);
	const initialProject = await getProject(page, projectId);
	const videoSegmentId = initialProject.segments[0]?.id;
	expect(videoSegmentId).toBeTruthy();

	await fillNumber(page, "top", "0.12");
	await fillNumber(page, "Rounding (%)", "12");
	await fillNumber(page, "Softness (px)", "6");
	await fillNumber(page, "Exposure", "0.5");
	await page.getByLabel("Visual effect").selectOption("grayscale");
	await page.getByLabel("Effect stack").selectOption("blur");
	await fillNumber(page, "blur amount (%)", "35");
	await page.getByLabel("Entry transition").selectOption("slide-left");
	await fillNumber(page, "Transition seconds", "0.6");
	await page.getByLabel("Animation property").selectOption("x");
	await page.getByRole("button", { name: "Add keyframe", exact: true }).click();
	await expect(page.getByRole("spinbutton", { name: "x at 0s" })).toHaveValue(
		"0"
	);
	await fillNumber(page, "x at 0s", "0.25");

	const playhead = page.getByRole("spinbutton", {
		name: "Playhead",
		exact: true,
	});
	await playhead.fill("2");
	await playhead.press("Tab");
	await expect(playhead).toHaveValue("2");
	await page
		.locator(".studio-inspector")
		.getByRole("button", { name: "0:00.0", exact: true })
		.click();
	await expect(playhead).toHaveValue("0");

	const failureArmed = await page.request.post(
		"/__proof/fail-next-project-save"
	);
	expect(failureArmed.ok()).toBe(true);
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText(
		"Fixture project save failed."
	);
	await expect(
		page.getByRole("button", { name: "Save changes", exact: true })
	).toBeEnabled();
	const failedWrite = requests
		.filter(
			(request) =>
				request.method === "PUT" && request.path === `/projects/${projectId}`
		)
		.at(-1);
	expect(failedWrite?.body).toMatchObject({
		segments: [
			expect.objectContaining({
				crop: expect.objectContaining({ top: 0.12 }),
				edgeRounding: 0.12,
				edgeSoftness: 6,
				visualEffect: "grayscale",
			}),
		],
	});
	const beforeRetry = await getProject(page, projectId);
	expect(segmentFor(beforeRetry, videoSegmentId ?? "missing")).toMatchObject({
		crop: expect.objectContaining({ top: 0 }),
		effects: [],
		entryTransition: "none",
	});
	await page.getByRole("button", { name: "1 s", exact: true }).click();
	await waitForPreviewFrame(page, 1);
	await captureScreenshot(page, "video-studio-inspector-save-failure.png");

	await saveProject(page);
	const savedProject = await getProject(page, projectId);
	const savedVideo = segmentFor(savedProject, videoSegmentId ?? "missing");
	expect(savedVideo).toMatchObject({
		colorGrade: expect.objectContaining({ exposure: 0.5 }),
		crop: expect.objectContaining({ top: 0.12 }),
		edgeRounding: 0.12,
		edgeSoftness: 6,
		effects: [{ amount: 0.35, enabled: true, type: "blur" }],
		entryDuration: 0.6,
		entryTransition: "slide-left",
		keyframes: [{ property: "x", time: 0, value: 0.25 }],
		visualEffect: "grayscale",
	});
	await waitForPreviewFrame(page, 1);
	await captureScreenshot(
		page,
		"video-studio-inspector-visual-controls-saved.png"
	);

	await page
		.getByRole("button", { name: "Remove blur effect", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Remove keyframe", exact: true })
		.click();
	await saveProject(page);
	const removedProject = await getProject(page, projectId);
	expect(segmentFor(removedProject, videoSegmentId ?? "missing")).toMatchObject(
		{
			effects: [],
			keyframes: [],
		}
	);

	await page.reload();
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await expect(page.getByLabel("Project")).toHaveValue(projectId);
	await page
		.getByRole("button", {
			name: `Select ${video.name} at 0.00 seconds`,
			exact: true,
		})
		.click();
	await page.getByRole("button", { name: "1 s", exact: true }).click();
	await waitForPreviewFrame(page, 1);
	await expect(page.getByRole("spinbutton", { name: "top" })).toHaveValue(
		"0.12"
	);
	await expect(
		page.getByRole("spinbutton", { name: "Rounding (%)" })
	).toHaveValue("12");
	await expect(
		page.getByRole("spinbutton", { name: "Softness (px)" })
	).toHaveValue("6");
	await expect(page.getByRole("spinbutton", { name: "Exposure" })).toHaveValue(
		"0.5"
	);
	await expect(page.getByLabel("Visual effect")).toHaveValue("grayscale");
	await expect(page.getByLabel("Effect stack")).toHaveValue("none");
	await expect(page.getByLabel("Entry transition")).toHaveValue("slide-left");
	await expect(
		page.getByRole("spinbutton", { name: "Transition seconds" })
	).toHaveValue("0.6");
	await page.locator(".studio-library").evaluate((element) => {
		element.scrollTop = 0;
	});
	await captureScreenshot(
		page,
		"video-studio-inspector-visual-controls-after-reload.png"
	);
});

test("Clip inspector links overlapping audio/video clips and persists audio processing and waveform settings", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const video = await seedAsset(
		page,
		"video",
		`${uniqueTitle("Inspector link video")}.mp4`
	);
	const audio = await seedAsset(
		page,
		"audio",
		`${uniqueTitle("Inspector link audio")}.wav`
	);
	const title = uniqueTitle("Inspector audio project");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	await assetRow(page, video.name)
		.getByRole("button", { name: `Add ${video.name} to timeline` })
		.click();
	await saveProject(page);
	await assetRow(page, audio.name)
		.getByRole("button", { name: `Add ${audio.name} to timeline` })
		.click();
	await saveProject(page);
	const projectWithSequentialClips = await getProject(page, projectId);
	const audioSegmentId = projectWithSequentialClips.segments.find(
		(segment) => segment.assetId === audio.id
	)?.id;
	expect(audioSegmentId).toBeTruthy();
	expect(
		projectWithSequentialClips.segments.find(
			(segment) => segment.assetId === audio.id
		)?.start
	).toBe(video.duration);

	await fillNumber(page, "Timeline start", "0");
	await expect(
		page.getByRole("button", { name: "Save changes", exact: true })
	).toBeEnabled();
	await saveProject(page);
	const overlappingProject = await getProject(page, projectId);
	expect(
		overlappingProject.segments.find((segment) => segment.id === audioSegmentId)
	).toMatchObject({ start: 0, sourceIn: 0, sourceOut: audio.duration });
	const link = page.getByRole("button", {
		name: "Link overlapping audio/video",
		exact: true,
	});
	await expect(link).toBeEnabled();
	await link.click();
	await saveProject(page);
	const linkedProject = await getProject(page, projectId);
	const linkedVideo = linkedProject.segments.find(
		(segment) => segment.assetId === video.id
	);
	const linkedAudio = linkedProject.segments.find(
		(segment) => segment.assetId === audio.id
	);
	expect(linkedVideo?.linkGroupId).toBeTruthy();
	expect(linkedAudio?.linkGroupId).toBe(linkedVideo?.linkGroupId);
	await expect(
		page.getByRole("button", { name: "Unlink audio/video", exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Unlink audio/video", exact: true })
		.click();
	await saveProject(page);
	const unlinkedProject = await getProject(page, projectId);
	expect(
		unlinkedProject.segments.find((segment) => segment.assetId === video.id)
			?.linkGroupId
	).toBeUndefined();
	expect(
		unlinkedProject.segments.find((segment) => segment.assetId === audio.id)
			?.linkGroupId
	).toBeUndefined();

	await page.getByLabel("Audio processing").selectOption("normalize");
	await page.getByLabel("Duck under other audio").selectOption("yes");
	await page.getByLabel("Audio visualization").selectOption("waveform");
	await page
		.getByRole("button", { name: "Waveform color", exact: true })
		.click();
	const colorField = page.getByRole("textbox", { name: "Hex color value" });
	await expect(colorField).toBeVisible();
	await colorField.fill("#FF4F87");
	await colorField.press("Tab");
	await expect(
		page.getByRole("button", { name: "Waveform color", exact: true })
	).toContainText("#FF4F87");
	await fillNumber(page, "Waveform height (%)", "64");
	await saveProject(page);
	const savedProject = await getProject(page, projectId);
	const savedAudio = savedProject.segments.find(
		(segment) => segment.id === audioSegmentId
	);
	expect(savedAudio).toMatchObject({
		audioProcessing: "normalize",
		duckUnderVoice: true,
		visualization: "waveform",
		waveformColor: "#FF4F87",
		waveformHeight: 0.64,
		y: 0.35,
	});
	const lastSave = requests
		.filter(
			(request) =>
				request.method === "PUT" && request.path === `/projects/${projectId}`
		)
		.at(-1);
	expect(lastSave?.body).toMatchObject({
		segments: expect.arrayContaining([
			expect.objectContaining({
				audioProcessing: "normalize",
				duckUnderVoice: true,
				visualization: "waveform",
				waveformColor: "#FF4F87",
				waveformHeight: 0.64,
			}),
		]),
	});

	await page.reload();
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await expect(page.getByLabel("Project")).toHaveValue(projectId);
	await page
		.getByRole("button", {
			name: `Select ${audio.name} at 0.00 seconds`,
			exact: true,
		})
		.click();
	await waitForPreviewFrame(page);
	await expect(page.getByLabel("Audio processing")).toHaveValue("normalize");
	await expect(page.getByLabel("Duck under other audio")).toHaveValue("yes");
	await expect(page.getByLabel("Audio visualization")).toHaveValue("waveform");
	await expect(
		page.getByRole("button", { name: "Waveform color", exact: true })
	).toContainText("#FF4F87");
	await expect(
		page.getByRole("spinbutton", { name: "Waveform height (%)" })
	).toHaveValue("64");
	const reloadedProject = await getProject(page, projectId);
	expect(
		reloadedProject.segments.find((segment) => segment.id === audioSegmentId)
	).toMatchObject({
		audioProcessing: "normalize",
		duckUnderVoice: true,
		visualization: "waveform",
		waveformColor: "#FF4F87",
		waveformHeight: 0.64,
	});
	await page.locator(".studio-inspector").evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await page.locator(".studio-library").evaluate((element) => {
		element.scrollTop = 0;
	});
	await captureScreenshot(
		page,
		"video-studio-inspector-audio-controls-after-reload.png"
	);
});
