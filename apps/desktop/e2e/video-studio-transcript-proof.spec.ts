import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface StudioRequest {
	body?: unknown;
	method: string;
	path: string;
}

interface SourceAsset {
	duration: number;
	hasAudio: boolean;
	id: string;
	kind: string;
	name: string;
}

interface Transcript {
	assetId: string;
	cues: Array<{ end: number; id: string; start: number; text: string }>;
	duration: number;
	error?: string;
	nextOffset: number;
	origin: string;
	revision: number;
	status: string;
	timing: string;
	words: Array<{ end: number; id: string; start: number; text: string }>;
}

interface TranscriptBridgeCall {
	audioLength: number;
	audioPrefix: string;
	detailed: boolean;
	filename: string;
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

async function seedAudioAsset(page: Page, name: string): Promise<SourceAsset> {
	const fixture = await page.request.get("/__proof/audio");
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
	expect(asset).toMatchObject({ name, kind: "audio", hasAudio: true });
	expect(asset.duration).toBeGreaterThan(23.9);
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

async function openOverflowTab(page: Page, label: string, value: string) {
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page.getByRole("combobox", { name: "Search tabs" }).fill(label);
	const tab = page.locator(`[data-tabs-menu-key="string:${value}"]`);
	await expect(tab).toBeVisible();
	await tab.click();
}

async function readTranscript(
	page: Page,
	assetId: string
): Promise<Transcript> {
	const response = await page.request.get(
		`/__studio/assets/${assetId}/transcript`
	);
	expect(response.ok()).toBe(true);
	const body = await response.json();
	expect(body.transcript).not.toBeNull();
	// SAFETY: This proof GET reaches the real Video Studio store.transcript reader, which parses transcriptSchema before the host serializes it; the non-null assertion above excludes its absent branch.
	return body.transcript as Transcript;
}

async function readTranscriberCalls(
	page: Page
): Promise<TranscriptBridgeCall[]> {
	const response = await page.request.get("/__proof/state");
	expect(response.ok()).toBe(true);
	const state = await response.json();
	return state.calls;
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

test("Transcript windows stop safely, failed retry recovers, and word/highlight captions persist", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const asset = await seedAudioAsset(
		page,
		`${uniqueTitle("Coverage spoken source")}.wav`
	);
	const title = uniqueTitle("Coverage transcript recovery");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	await page
		.getByRole("button", { name: `Add ${asset.name} to timeline`, exact: true })
		.click();
	await expect(
		page.getByRole("button", {
			name: `Select ${asset.name} at 0.00 seconds`,
		})
	).toBeVisible();
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	await openOverflowTab(page, "Transcript", "transcript");

	const source = page.getByLabel("Transcript source");
	await expect(source).toHaveValue("");
	await source.selectOption(asset.id);
	const transcribe = page.getByRole("button", {
		name: "Transcribe with Ryu",
		exact: true,
	});
	const applyWords = page.getByRole("button", {
		name: "Apply word captions",
		exact: true,
	});
	const applyHighlighted = page.getByRole("button", {
		name: "Apply highlighted captions",
		exact: true,
	});
	await expect(transcribe).toBeEnabled();
	await expect(applyWords).toHaveCount(0);
	await expect(applyHighlighted).toHaveCount(0);
	const delayed = await page.request.post("/__proof/delay-next-transcription", {
		data: { milliseconds: 800 },
	});
	expect(delayed.ok()).toBe(true);
	await transcribe.click();
	const stop = page.getByRole("button", {
		name: "Stop after this window",
		exact: true,
	});
	await expect(stop).toBeVisible();
	await expect
		.poll(async () => (await readTranscriberCalls(page)).length)
		.toBe(1);
	await stop.click();
	await expect(page.getByRole("status")).toContainText(
		"Transcription will stop after the current window is saved."
	);
	await expect(page.getByRole("status")).toContainText(
		"Transcription stopped. Saved windows can be resumed."
	);
	const stopped = await readTranscript(page, asset.id);
	expect(stopped).toMatchObject({
		assetId: asset.id,
		origin: "ryu-transcription",
		status: "canceled",
		timing: "segments",
		nextOffset: 20,
	});
	expect(stopped.cues).toEqual([
		expect.objectContaining({
			start: 0.5,
			end: 1.8,
			text: "Harbor lights are ahead.",
		}),
	]);
	const transcribeAgain = page.getByRole("button", {
		name: "Transcribe again",
		exact: true,
	});
	await expect(transcribeAgain).toBeEnabled();

	const failureMessage = "Local transcription fixture failed.";
	const failureArmed = await page.request.post(
		"/__proof/fail-next-transcription",
		{ data: { message: failureMessage } }
	);
	expect(failureArmed.ok()).toBe(true);
	await transcribeAgain.click();
	await expect(page.getByRole("status")).toContainText(failureMessage);
	const failed = await readTranscript(page, asset.id);
	expect(failed).toMatchObject({
		status: "failed",
		error: failureMessage,
		nextOffset: 0,
		cues: [],
		words: [],
	});
	await expect(transcribeAgain).toBeEnabled();

	await transcribeAgain.click();
	await expect(page.getByRole("status")).toContainText(
		"Source transcript saved. Review its timing before applying captions."
	);
	const completed = await readTranscript(page, asset.id);
	expect(completed).toMatchObject({
		status: "completed",
		timing: "segments",
		nextOffset: asset.duration,
	});
	expect(completed.cues).toHaveLength(2);
	expect(completed.cues[1]).toMatchObject({
		start: 20.5,
		end: 21.8,
		text: "Harbor lights are ahead.",
	});
	expect(completed.words.map((word) => word.text)).toEqual([
		"Harbor",
		"lights",
		"are",
		"ahead.",
		"Harbor",
		"lights",
		"are",
		"ahead.",
	]);
	await expect(
		page.getByRole("button", {
			name: "Transcription complete",
			exact: true,
		})
	).toBeDisabled();
	await expect(applyWords).toBeEnabled();
	await expect(applyHighlighted).toBeEnabled();
	const bridgeCalls = await readTranscriberCalls(page);
	expect(bridgeCalls).toHaveLength(4);
	for (const call of bridgeCalls) {
		expect(call.audioPrefix.startsWith("data:audio/wav;base64,")).toBe(true);
		expect(call.audioLength).toBeGreaterThan(1000);
		expect(call.filename).toBe("source-window.wav");
		expect(call.detailed).toBe(true);
	}
	const transcriptCreates = requests.filter(
		(request) =>
			request.path === `/assets/${asset.id}/transcript` &&
			request.method === "POST"
	);
	expect(transcriptCreates).toHaveLength(3);
	expect(transcriptCreates[0]?.body).toBeUndefined();
	expect(transcriptCreates[1]?.body).toMatchObject({
		restart: true,
		revision: stopped.revision,
	});
	const stopCalls = requests.filter(
		(request) =>
			request.path === `/assets/${asset.id}/stop-transcript` &&
			request.method === "POST"
	);
	// SAFETY: These captured stop-transcript POSTs come from the mounted TranscriptPanel cancellation/failure branches, whose JSON bodies author literal string statuses.
	expect(
		stopCalls.map((request) => (request.body as { status: string }).status)
	).toEqual(["canceled", "failed"]);
	await saveScreenshot(page, "video-studio-transcript-retry-completed.png");

	await applyWords.click();
	await expect(page.getByRole("status")).toContainText(
		"Source transcript mapped onto the timeline, including trims and speed changes."
	);
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const wordSave = [...requests]
		.reverse()
		.find(
			(request) =>
				request.path === `/projects/${projectId}` && request.method === "PUT"
		);
	// SAFETY: This controlled save follows the mounted word-caption action: captionsForSource/withActiveCaptions builds native Caption rows, and App.save serializes that project in this matched PUT.
	const wordProject = wordSave?.body as {
		captions: Array<{ sourceAssetId?: string; text: string }>;
	};
	expect(wordProject.captions).toHaveLength(8);
	expect(wordProject.captions.map((caption) => caption.text)).toEqual([
		"Harbor",
		"lights",
		"are",
		"ahead.",
		"Harbor",
		"lights",
		"are",
		"ahead.",
	]);
	expect(
		wordProject.captions.every((caption) => caption.sourceAssetId === asset.id)
	).toBe(true);
	await saveScreenshot(page, "video-studio-transcript-word-captions.png");

	await applyHighlighted.click();
	await expect(page.getByRole("status")).toContainText(
		"Source transcript mapped onto the timeline, including trims and speed changes."
	);
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const highlightedSave = [...requests]
		.reverse()
		.find(
			(request) =>
				request.path === `/projects/${projectId}` && request.method === "PUT"
		);
	// SAFETY: This controlled highlighted-caption save is the mounted App.save project PUT after highlightedCaptionsForSource/withActiveCaptions; native Caption rows own the inspected text/source/word fields.
	const highlightedProject = highlightedSave?.body as {
		captions: Array<{
			highlightColor?: string;
			sourceAssetId?: string;
			text: string;
			words?: Array<{ text: string }>;
		}>;
	};
	expect(highlightedProject.captions).toHaveLength(2);
	for (const caption of highlightedProject.captions) {
		expect(caption).toMatchObject({
			highlightColor: "#ffd43b",
			sourceAssetId: asset.id,
			text: "Harbor lights are ahead.",
		});
		expect(caption.words?.map((word) => word.text)).toEqual([
			"Harbor",
			"lights",
			"are",
			"ahead.",
		]);
	}

	await page.reload();
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByLabel("Project").selectOption({ label: title });
	const savedProject = await page.request.get(
		`/__studio/projects/${projectId}`
	);
	expect(savedProject.ok()).toBe(true);
	const project = await savedProject.json();
	expect(project.captions).toEqual(highlightedProject.captions);
	const playhead = page.getByRole("spinbutton", { name: "Playhead" });
	await playhead.fill("0.7");
	await playhead.press("Tab");
	await openOverflowTab(page, "Captions", "captions");
	const previewCaption = page.locator(".studio-preview-frame .studio-caption");
	await expect(previewCaption).toHaveText("Harbor lights are ahead.");
	const highlightedWords = previewCaption.locator("span");
	await expect(highlightedWords).toHaveCount(4);
	await expect(highlightedWords.nth(0)).toHaveCSS("color", "rgb(255, 212, 59)");
	const primaryForeground = await highlightedWords
		.nth(1)
		.evaluate((element) => {
			const parent = element.parentElement;
			if (!parent) {
				throw new Error("Caption word is missing its caption container.");
			}
			const probe = document.createElement("span");
			probe.style.color = "var(--primary-foreground)";
			parent.append(probe);
			const color = getComputedStyle(probe).color;
			probe.remove();
			return color;
		});
	await expect(highlightedWords.nth(1)).toHaveCSS("color", primaryForeground);
	await saveScreenshot(
		page,
		"video-studio-transcript-highlighted-after-reload.png"
	);

	const transcribeUpdates = requests.filter(
		(request) =>
			request.path === `/assets/${asset.id}/transcript` &&
			request.method === "PUT"
	);
	expect(transcribeUpdates).toHaveLength(3);
	expect(transcribeUpdates[0]?.body).toMatchObject({
		offset: 0,
		timing: "segments",
		cues: [expect.objectContaining({ start: 0.5, end: 1.8 })],
	});
	// SAFETY: This matched controlled transcription PUT is authored by mounted TranscriptPanel from schema-parsed current.nextOffset and transcriptWindowWords native Caption rows, then JSON-serialized by the proof bridge.
	const retriedWindow = transcribeUpdates[1]?.body as {
		offset: number;
		words: Array<{ text: string }>;
	};
	expect(retriedWindow.offset).toBe(0);
	expect(retriedWindow.words.map((word) => word.text)).toEqual([
		"Harbor",
		"lights",
		"are",
		"ahead.",
	]);
	expect(transcribeUpdates[2]?.body).toMatchObject({
		offset: 20,
		cues: [expect.objectContaining({ start: 20.5, end: 21.8 })],
	});
});
