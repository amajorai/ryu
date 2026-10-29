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

async function seedVideoAsset(page: Page, name: string): Promise<Asset> {
	const fixture = await page.request.get("/__proof/video");
	expect(fixture.ok()).toBe(true);
	const bytes = await fixture.body();
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
	expect(asset).toMatchObject({ name, kind: "video", hasAudio: true });
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
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
}

async function openOverflowTab(page: Page, label: string, value: string) {
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page.getByRole("combobox", { name: "Search tabs" }).fill(label);
	const tab = page.locator(`[data-tabs-menu-key="string:${value}"]`);
	await expect(tab).toBeVisible();
	await tab.click();
}

async function getProject(page: Page, projectId: string): Promise<Project> {
	const response = await page.request.get(`/__studio/projects/${projectId}`);
	expect(response.ok()).toBe(true);
	return await response.json();
}

async function getAssets(page: Page): Promise<Asset[]> {
	const response = await page.request.get("/__studio/assets");
	expect(response.ok()).toBe(true);
	const result = await response.json();
	return result.assets;
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

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

function segmentFor(project: Project, assetId: string): Segment {
	const segment = project.segments.find((item) => item.assetId === assetId);
	if (!segment) {
		throw new Error(`The persisted timeline is missing asset ${assetId}.`);
	}
	return segment;
}

test("local soundtrack settings flow into a storyboard scene and retryable manual clip sync", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const video = await seedVideoAsset(
		page,
		"Harbor reference with camera audio.mp4"
	);
	const title = uniqueTitle("Audio production project");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	expect((await getProject(page, projectId)).requireApproval).toBe(false);

	await openOverflowTab(page, "Plan", "storyboard");
	await fillNumber(page, "Project production budget cap", "20.75");
	await fillNumber(page, "Image generation estimate", "0.55");
	await fillNumber(page, "Video generation estimate", "3.10");
	await fillNumber(page, "Narration generation estimate", "1.20");
	await saveProject(page);
	const budgeted = await getProject(page, projectId);
	expect(budgeted.productionBudget).toMatchObject({
		estimates: { audio: 1_200_000, image: 550_000, video: 3_100_000 },
		limitMicroUsd: 20_750_000,
	});

	await openOverflowTab(page, "Media", "media");
	await fillNumber(page, "Soundtrack duration", "6");
	await fillNumber(page, "Soundtrack tempo", "112");
	await page.getByLabel("Soundtrack mood").selectOption("tense");
	const soundtrackName = "Local tense soundtrack 112 BPM.wav";
	const soundtrackFault = await page.request.post(
		"/__proof/fail-next-soundtrack"
	);
	expect(soundtrackFault.ok()).toBe(true);
	await page.getByRole("button", { name: "Create soundtrack" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Fixture soundtrack request failed once."
	);
	await expect(
		page.getByRole("button", { name: "Create soundtrack" })
	).toBeEnabled();
	expect(
		(await getAssets(page)).some((asset) => asset.name === soundtrackName)
	).toBe(false);
	await page.getByRole("button", { name: "Create soundtrack" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Local soundtrack saved to the media library."
	);
	await expect
		.poll(async () =>
			(await getAssets(page)).some((asset) => asset.name === soundtrackName)
		)
		.toBe(true);
	const foundSoundtrack = (await getAssets(page)).find(
		(asset) => asset.name === soundtrackName
	);
	expect(foundSoundtrack).toBeDefined();
	if (!foundSoundtrack) {
		throw new Error(
			"The local soundtrack was not persisted in the media library."
		);
	}
	const soundtrack = foundSoundtrack;
	expect(soundtrack).toMatchObject({ kind: "audio", name: soundtrackName });
	expect(soundtrack.duration).toBeCloseTo(6, 1);
	const soundtrackRequests = requests.filter(
		(request) => request.path === "/soundtrack" && request.method === "POST"
	);
	expect(soundtrackRequests).toHaveLength(2);
	expect(soundtrackRequests.map((request) => request.body)).toEqual([
		{ bpm: 112, duration: 6, mood: "tense" },
		{ bpm: 112, duration: 6, mood: "tense" },
	]);

	await openOverflowTab(page, "Plan", "storyboard");
	await page.getByRole("button", { name: "Add scene", exact: true }).click();
	await page.getByLabel("Scene 1 visual take").selectOption(video.id);
	await fillNumber(page, "Scene 1 duration", "5.5");
	await fillNumber(page, "Scene 1 visual source in", "0.75");
	const muteVisualAudio = page.getByRole("button", {
		name: "Mute visual audio",
		exact: true,
	});
	await muteVisualAudio.click();
	await expect(muteVisualAudio).toHaveAttribute("aria-pressed", "true");
	await page.getByLabel("Scene 1 add audio").selectOption(soundtrack.id);
	const audioOffsetLabel = `Scene 1 audio in: ${soundtrackName}`;
	// The scene NumberField commits and renders millisecond precision without
	// trailing zeros.
	await fillNumber(
		page,
		audioOffsetLabel,
		String(Number(soundtrack.duration.toFixed(3)))
	);
	await page
		.getByRole("button", { name: "Fit scene to this audio", exact: true })
		.click();
	await expect(page.getByRole("status")).toContainText(
		"The selected audio range is empty."
	);
	await fillNumber(page, audioOffsetLabel, "1.25");
	await saveProject(page);
	const authoredScene = await getProject(page, projectId);
	expect(authoredScene.scenes[0]).toMatchObject({
		audioOffsets: { [soundtrack.id]: 1.25 },
		assetIds: [video.id, soundtrack.id],
		duration: 5.5,
		muteVisualAudio: true,
		sourceIn: 0.75,
	});
	await page
		.getByRole("button", { name: "Fit scene to this audio", exact: true })
		.click();
	await expect(
		page.getByRole("spinbutton", { name: "Scene 1 duration", exact: true })
	).toHaveValue(String(Number((soundtrack.duration - 1.25).toFixed(3))));
	await saveProject(page);
	let project = await getProject(page, projectId);
	expect(project.scenes[0]).toMatchObject({
		audioOffsets: { [soundtrack.id]: 1.25 },
		assetIds: [video.id, soundtrack.id],
		muteVisualAudio: true,
		sourceIn: 0.75,
	});
	expect(project.scenes[0]?.duration).toBeCloseTo(
		soundtrack.duration - 1.25,
		6
	);

	await page
		.getByRole("button", { name: "Remove audio layer", exact: true })
		.click();
	await saveProject(page);
	project = await getProject(page, projectId);
	expect(project.scenes[0]?.assetIds).toEqual([video.id]);
	expect(project.scenes[0]?.audioOffsets).toEqual({});
	await page.getByLabel("Scene 1 add audio").selectOption(soundtrack.id);
	await saveProject(page);
	project = await getProject(page, projectId);
	expect(project.scenes[0]?.assetIds).toEqual([video.id, soundtrack.id]);
	expect(project.scenes[0]?.audioOffsets).toEqual({ [soundtrack.id]: 0 });

	await page.getByRole("button", { name: "Assemble storyboard" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Storyboard assembled into the timeline. Review the edit before exporting."
	);
	project = await getProject(page, projectId);
	const videoSegment = segmentFor(project, video.id);
	const soundtrackSegment = segmentFor(project, soundtrack.id);
	expect(project.segments).toHaveLength(2);
	expect(videoSegment).toMatchObject({
		sourceIn: 0.75,
		volume: 0,
	});
	expect(videoSegment.sourceOut).toBeCloseTo(
		0.75 + soundtrack.duration - 1.25,
		6
	);
	expect(soundtrackSegment).toMatchObject({ track: 1, volume: 1 });

	await openOverflowTab(page, "Sync", "sync");
	await page
		.getByLabel("Sync reference clip")
		.selectOption(soundtrackSegment.id);
	const videoTarget = page.locator(".studio-library").getByRole("button", {
		name: new RegExp(video.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
	});
	await expect(videoTarget).toHaveAttribute("aria-pressed", "false");
	await videoTarget.click();
	await expect(videoTarget).toHaveAttribute("aria-pressed", "true");
	await page.getByLabel("Sync alignment method").selectOption("manual");
	await fillNumber(page, "Sync manual offset", "0.375");
	const beforeSync = await getProject(page, projectId);
	const syncFault = await page.request.post("/__proof/fail-next-sync");
	expect(syncFault.ok()).toBe(true);
	await page.getByRole("button", { name: "Align selected clips" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Fixture clip sync failed once."
	);
	const afterFailedSync = await getProject(page, projectId);
	expect(segmentFor(afterFailedSync, video.id).start).toBe(videoSegment.start);
	await expect(
		page.getByRole("button", { name: "Align selected clips" })
	).toBeEnabled();
	await page.getByRole("button", { name: "Align selected clips" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Shifted 1 clip · confidence 100%."
	);
	const synced = await getProject(page, projectId);
	const syncedVideo = segmentFor(synced, video.id);
	expect(syncedVideo.start).toBeCloseTo(11 / 30, 5);
	expect(segmentFor(synced, soundtrack.id).start).toBe(0);
	const syncRequests = requests.filter(
		(request) =>
			request.path === `/projects/${projectId}/sync` &&
			request.method === "POST"
	);
	expect(syncRequests).toHaveLength(2);
	expect(syncRequests[0]?.body).toMatchObject({
		mode: "manual",
		offsetSeconds: 0.375,
		referenceClipId: soundtrackSegment.id,
		targetClipIds: [videoSegment.id],
		revision: beforeSync.revision,
	});
	expect(syncRequests[1]?.body).toMatchObject({
		mode: "manual",
		offsetSeconds: 0.375,
		referenceClipId: soundtrackSegment.id,
		targetClipIds: [videoSegment.id],
		revision: beforeSync.revision,
	});

	await fillNumber(page, "Playhead", "1");
	await expect(page.locator(".font-mono")).toContainText("0:01.0 /");
	await saveScreenshot(page, "video-studio-audio-mix-sync.png");
});
