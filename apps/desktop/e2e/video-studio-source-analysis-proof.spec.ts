import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	estimateBeatTimes,
	loudnessPeakTimes,
	type MediaAnalysis,
	silenceRanges,
} from "../../../apps-store/video-studio/shared/analysis.ts";
import type {
	Asset,
	Project,
} from "../../../apps-store/video-studio/shared/project.ts";

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
	expect(asset).toMatchObject({
		name,
		kind: fixture,
		hasAudio: true,
	});
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

async function getAnalysis(page: Page, assetId: string) {
	const response = await page.request.get(
		`/__studio/assets/${assetId}/analysis`
	);
	expect(response.ok()).toBe(true);
	// SAFETY: This successful local analysis GET serializes store.analysis(), which returns native analysisSchema-parsed MediaAnalysis or null, inside the authored analysis object.
	const body = (await response.json()) as { analysis: MediaAnalysis | null };
	return body.analysis;
}

async function getProject(page: Page, projectId: string) {
	const response = await page.request.get(`/__studio/projects/${projectId}`);
	expect(response.ok()).toBe(true);
	// SAFETY: The successful local GET checked above is forwarded unchanged from store.project(), whose native projectSchema parser owns this Project and its declared fields before JSON serialization.
	return (await response.json()) as Project;
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

function clock(value: number) {
	return `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, "0")}`;
}

function projectDuration(project: Project) {
	return Math.max(
		0,
		...project.segments.map(
			(segment) =>
				segment.start + (segment.sourceOut - segment.sourceIn) / segment.speed
		)
	);
}

function segmentDuration(segment: Project["segments"][number]) {
	return (segment.sourceOut - segment.sourceIn) / segment.speed;
}

test("SourceAnalysis cancels and retries local analysis, maps measured edits, and restores sidecar results", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const video = await seedAsset(
		page,
		"video",
		`${uniqueTitle("Coverage cut-and-pulse source")}.mp4`
	);
	const audio = await seedAsset(
		page,
		"audio",
		`${uniqueTitle("Coverage silence source")}.wav`
	);
	const title = uniqueTitle("Coverage source analysis project");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	const videoRow = assetRow(page, video.name);
	const audioRow = assetRow(page, audio.name);

	const analyzeVideo = videoRow.getByRole("button", {
		name: "Analyze source",
		exact: true,
	});
	await analyzeVideo.click();
	await expect(videoRow).toContainText("Analyzing scenes and audio…");
	const cancel = videoRow.getByRole("button", {
		name: "Cancel analysis",
		exact: true,
	});
	await expect(cancel).toBeVisible();
	await expect
		.poll(async () => (await getAnalysis(page, video.id))?.status, {
			timeout: 10_000,
		})
		.toBe("running");
	await cancel.click();
	await expect
		.poll(async () => (await getAnalysis(page, video.id))?.status, {
			timeout: 10_000,
		})
		.toBe("canceled");
	await expect(videoRow).toContainText("Operation canceled.");
	await expect(cancel).toHaveCount(0);
	await saveScreenshot(page, "video-studio-source-analysis-canceled.png");

	await analyzeVideo.click();
	await expect
		.poll(async () => (await getAnalysis(page, video.id))?.status, {
			timeout: 20_000,
		})
		.toBe("completed");
	const completedVideoAnalysis = await getAnalysis(page, video.id);
	expect(completedVideoAnalysis).not.toBeNull();
	expect(completedVideoAnalysis?.waveform.length).toBeGreaterThan(20);
	expect(completedVideoAnalysis?.sceneCuts).toEqual([3, 5]);
	await expect(videoRow).toContainText("2 detected scene changes");
	await expect(
		videoRow.getByRole("img", { name: "Audio envelope, normalized" })
	).toBeVisible();
	await videoRow.getByRole("button", { name: "Hide analysis" }).click();
	await expect(
		videoRow.getByRole("img", { name: "Audio envelope, normalized" })
	).toHaveCount(0);
	await videoRow.getByRole("button", { name: "View analysis" }).click();
	await expect(
		videoRow.getByRole("img", { name: "Audio envelope, normalized" })
	).toBeVisible();
	await videoRow.evaluate((element) => {
		element.scrollIntoView({ block: "center" });
	});
	await saveScreenshot(page, "video-studio-source-analysis-video-results.png");

	const addFullVideo = videoRow.getByRole("button", {
		name: `Add ${video.name} to timeline`,
	});
	await addFullVideo.click();
	const boundaries = [
		0,
		...(completedVideoAnalysis?.sceneCuts ?? []),
		video.duration,
	];
	const sceneStart = boundaries[1] ?? 0;
	const sceneEnd = boundaries[2] ?? video.duration;
	const sceneRange = videoRow.getByRole("button", {
		name: `Add ${sceneStart.toFixed(1)} – ${sceneEnd.toFixed(1)} s`,
		exact: true,
	});
	await sceneRange.click();

	const peakTimes = loudnessPeakTimes(
		completedVideoAnalysis?.waveform ?? [],
		video.duration
	);
	const beatTimes = estimateBeatTimes(
		completedVideoAnalysis?.waveform ?? [],
		video.duration
	);
	expect(peakTimes.length).toBeGreaterThan(0);
	expect(beatTimes.length).toBeGreaterThan(1);
	await videoRow.getByRole("button", { name: "Add loudness markers" }).click();
	await expect(page.getByRole("status")).toContainText(
		`Added ${peakTimes.length} loudness marker${peakTimes.length === 1 ? "" : "s"} from ${video.name}.`
	);
	const extraBeatTimes = beatTimes.filter((time) => !peakTimes.includes(time));
	await videoRow
		.getByRole("button", { name: "Add estimated beat markers" })
		.click();
	await expect(page.getByRole("status")).toContainText(
		`Added ${extraBeatTimes.length} estimated beat marker${extraBeatTimes.length === 1 ? "" : "s"} from ${video.name}.`
	);
	await saveProject(page);
	const markedProject = await getProject(page, projectId);
	expect(markedProject.segments).toHaveLength(2);
	expect(markedProject.segments).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				assetId: video.id,
				sourceIn: 0,
				sourceOut: video.duration,
			}),
			expect.objectContaining({
				assetId: video.id,
				sourceIn: sceneStart,
				sourceOut: sceneEnd,
			}),
		])
	);
	const expectedTimes = [...new Set([...peakTimes, ...beatTimes])].sort(
		(left, right) => left - right
	);
	expect(markedProject.markers.map((marker) => marker.time)).toEqual(
		expectedTimes
	);
	for (const time of peakTimes) {
		expect(markedProject.markers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					color: "#38bdf8",
					time,
				}),
			])
		);
	}
	for (const time of extraBeatTimes) {
		expect(markedProject.markers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					color: "#f97316",
					time,
				}),
			])
		);
	}
	await saveScreenshot(page, "video-studio-source-analysis-markers-saved.png");

	await audioRow
		.getByRole("button", { name: `Add ${audio.name} to timeline` })
		.click();
	await saveProject(page);
	const beforeSilenceRemoval = await getProject(page, projectId);
	const beforeDuration = projectDuration(beforeSilenceRemoval);
	const originalAudioDuration = beforeSilenceRemoval.segments
		.filter((segment) => segment.assetId === audio.id)
		.reduce((total, segment) => total + segmentDuration(segment), 0);
	expect(originalAudioDuration).toBeCloseTo(audio.duration, 2);

	await audioRow
		.getByRole("button", { name: "Analyze source", exact: true })
		.click();
	await expect
		.poll(async () => (await getAnalysis(page, audio.id))?.status, {
			timeout: 20_000,
		})
		.toBe("completed");
	const audioAnalysis = await getAnalysis(page, audio.id);
	expect(audioAnalysis?.waveform.length).toBeGreaterThan(20);
	const silent = silenceRanges(audioAnalysis?.waveform ?? [], audio.duration);
	expect(silent.length).toBeGreaterThan(0);
	const removedSeconds = silent.reduce(
		(total, [start, end]) => total + end - start,
		0
	);
	expect(removedSeconds).toBeGreaterThan(3);
	await expect(audioRow).toContainText("Audio analysis ready.");
	const removeSilence = audioRow.getByRole("button", {
		name: "Remove detected silence",
		exact: true,
	});
	await expect(removeSilence).toBeVisible();
	await removeSilence.click();
	await expect(page.getByRole("status")).toContainText(
		`Removed ${clock(removedSeconds)} of detected silence from ${audio.name}.`
	);
	await audioRow.evaluate((element) => {
		element.scrollIntoView({ block: "center" });
	});
	await saveScreenshot(
		page,
		"video-studio-source-analysis-silence-removed.png"
	);
	await saveProject(page);
	const afterSilenceRemoval = await getProject(page, projectId);
	const trimmedAudio = afterSilenceRemoval.segments.filter(
		(segment) => segment.assetId === audio.id
	);
	expect(trimmedAudio.length).toBeGreaterThan(1);
	expect(
		trimmedAudio.reduce((total, segment) => total + segmentDuration(segment), 0)
	).toBeCloseTo(originalAudioDuration - removedSeconds, 1);
	expect(projectDuration(afterSilenceRemoval)).toBeCloseTo(
		beforeDuration - removedSeconds,
		1
	);
	await page.reload();
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	const reloadedVideoRow = assetRow(page, video.name);
	const reloadedAudioRow = assetRow(page, audio.name);
	await reloadedVideoRow
		.getByRole("button", { name: "View analysis", exact: true })
		.click();
	await expect(reloadedVideoRow).toContainText("2 detected scene changes");
	await expect(
		reloadedVideoRow.getByRole("img", {
			name: "Audio envelope, normalized",
		})
	).toBeVisible();
	await reloadedAudioRow
		.getByRole("button", { name: "View analysis", exact: true })
		.click();
	await expect(
		reloadedAudioRow.getByRole("button", {
			name: "Remove detected silence",
		})
	).toBeVisible();
	const reloadedProject = await getProject(page, projectId);
	expect(reloadedProject.markers).toHaveLength(expectedTimes.length);
	expect(
		reloadedProject.segments.filter((segment) => segment.assetId === audio.id)
	).toHaveLength(trimmedAudio.length);
	expect(
		reloadedProject.segments.filter((segment) => segment.assetId === video.id)
	).toHaveLength(2);
	await reloadedVideoRow.evaluate((element) => {
		element.scrollIntoView({ block: "center" });
	});
	await saveScreenshot(page, "video-studio-source-analysis-after-reload.png");
	await reloadedAudioRow.evaluate((element) => {
		element.scrollIntoView({ block: "center" });
	});
	await saveScreenshot(page, "video-studio-source-silence-after-reload.png");

	const videoAnalyzeRequests = requests.filter(
		(request) =>
			request.method === "POST" &&
			request.path === `/assets/${video.id}/analyze`
	);
	expect(videoAnalyzeRequests).toHaveLength(2);
	expect(
		requests.filter(
			(request) =>
				request.method === "POST" &&
				request.path === `/assets/${video.id}/cancel-analysis`
		)
	).toHaveLength(1);
	expect(
		requests.filter(
			(request) =>
				request.method === "POST" &&
				request.path === `/assets/${audio.id}/analyze`
		)
	).toHaveLength(1);
	const saves = requests.filter(
		(request) =>
			request.method === "PUT" && request.path === `/projects/${projectId}`
	);
	expect(saves.length).toBeGreaterThanOrEqual(3);
	const lastSave = saves.at(-1);
	expect(lastSave?.body).toMatchObject({
		id: projectId,
		markers: expect.arrayContaining([
			expect.objectContaining({ color: "#38bdf8" }),
			expect.objectContaining({ color: "#f97316" }),
		]),
	});
});
