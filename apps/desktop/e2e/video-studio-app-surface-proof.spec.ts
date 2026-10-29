import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { GenerationJob } from "../../../apps-store/video-studio/shared/generation.ts";
import type {
	Asset,
	Project,
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

interface RenderJob {
	error?: string;
	id: string;
	projectId: string;
	review?: { passed: boolean; checks: Array<{ id: string; message: string }> };
	revision: number;
	status: string;
}

interface FixtureImageCall {
	count: number;
	model?: string;
	project_id: string;
	prompt: string;
	request_id: string;
}

declare global {
	interface Window {
		__videoStudioFixtureImageCalls?: FixtureImageCall[];
	}
}

function uniqueTitle(prefix: string) {
	return `${prefix} ${new Date().toISOString().replaceAll(":", "-")} ${crypto.randomUUID().slice(0, 8)}`;
}

function recordStudioRequests(page: Page) {
	const requests: StudioRequest[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (
			!url.pathname.startsWith("/__studio/") ||
			url.pathname.includes("/uploads")
		) {
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
	fixture: "image" | "video",
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
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	return page.getByLabel("Project").inputValue();
}

async function selectProject(page: Page, projectId: string) {
	await page.getByLabel("Project").selectOption(projectId);
	await expect(page.getByLabel("Project")).toHaveValue(projectId);
}

async function openOverflowTab(page: Page, label: string, value: string) {
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page.getByRole("combobox", { name: "Search tabs" }).fill(label);
	const tab = page.locator(`[data-tabs-menu-key="string:${value}"]`);
	await expect(tab).toBeVisible();
	await tab.click();
}

function assetRow(page: Page, name: string) {
	return page
		.locator(".studio-asset")
		.filter({ has: page.getByText(name, { exact: true }) });
}

async function readProject(page: Page, projectId: string): Promise<Project> {
	const response = await page.request.get(`/__studio/projects/${projectId}`);
	expect(response.ok()).toBe(true);
	return await response.json();
}

async function readAssets(page: Page): Promise<Asset[]> {
	const response = await page.request.get("/__studio/assets");
	expect(response.ok()).toBe(true);
	const result = await response.json();
	return result.assets;
}

async function readAnalysis(page: Page, assetId: string) {
	const response = await page.request.get(
		`/__studio/assets/${assetId}/analysis`
	);
	expect(response.ok()).toBe(true);
	return await response.json();
}

async function readGenerationJobs(
	page: Page,
	projectId: string
): Promise<GenerationJob[]> {
	const response = await page.request.get(
		`/__studio/generations?projectId=${projectId}`
	);
	expect(response.ok()).toBe(true);
	const result = await response.json();
	return result.jobs;
}

async function readRenderJobs(page: Page): Promise<RenderJob[]> {
	const response = await page.request.get("/__studio/renders");
	expect(response.ok()).toBe(true);
	const result = await response.json();
	return result.jobs;
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

test("App media, reference, generation, and library tabs keep user edits on the real sidecar", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const video = await seedAsset(page, "video", "Harbor reference fixture.mp4");
	const still = await seedAsset(page, "image", "Harbor graphic fixture.png");
	const sourceTitle = uniqueTitle("Nested sequence source");
	const sourceProjectId = await createProject(page, sourceTitle);
	await page.getByLabel("Output format").selectOption("640x360");
	await page.getByLabel("Frame rate").selectOption("24");
	await saveProject(page);
	await openOverflowTab(page, "Media", "media");
	await assetRow(page, video.name)
		.getByRole("button", { name: `Add ${video.name} to timeline` })
		.click();
	await saveProject(page);
	const sourceProject = await readProject(page, sourceProjectId);
	expect(sourceProject.segments).toHaveLength(1);

	const targetTitle = uniqueTitle("Companion surface target");
	const targetProjectId = await createProject(page, targetTitle);
	await openOverflowTab(page, "Media", "media");
	const importUrl = "https://media.fixture.test/harbor-broll.mp4";
	const remoteUrlField = page.getByLabel("Import media URL");
	await remoteUrlField.fill(importUrl);
	const importFault = await page.request.post(
		"/__proof/fail-next-remote-import"
	);
	expect(importFault.ok()).toBe(true);
	await page.getByRole("button", { name: "Import URL", exact: true }).click();
	await expect(page.getByRole("status")).toContainText(
		"Fixture media URL import failed once."
	);
	await expect(remoteUrlField).toHaveValue(importUrl);
	await page.getByRole("button", { name: "Import URL", exact: true }).click();
	await expect(page.getByRole("status")).toContainText(
		"Remote media imported. Add it to the timeline from the library."
	);
	await expect(remoteUrlField).toHaveValue("");
	const remoteAsset = (await readAssets(page)).find(
		(asset) => asset.name === "harbor-broll.mp4"
	);
	expect(remoteAsset).toMatchObject({
		folder: "Field footage",
		kind: "video",
		name: "harbor-broll.mp4",
	});
	const importRequests = requests.filter(
		(request) => request.path === "/assets/import" && request.method === "POST"
	);
	expect(importRequests).toHaveLength(2);
	expect(importRequests.map((request) => request.body)).toEqual([
		{ name: "harbor-broll.mp4", source: { url: importUrl } },
		{ name: "harbor-broll.mp4", source: { url: importUrl } },
	]);

	const searchField = page.getByLabel("Search media");
	await searchField.fill("harbor-broll");
	await page.getByLabel("Media folder").selectOption("Field footage");
	await expect(assetRow(page, "harbor-broll.mp4")).toBeVisible();
	await expect(page.locator(".studio-asset")).toHaveCount(1);
	await searchField.fill(still.name);
	await page.getByLabel("Media folder").selectOption("");
	const stillRow = assetRow(page, still.name);
	await expect(stillRow).toBeVisible();
	await stillRow
		.getByRole("button", { name: `Upscale ${still.name} 2 times` })
		.click();
	await expect(page.getByRole("status")).toContainText(
		"2× local upscale added to the media library."
	);
	const twice = (await readAssets(page)).find((asset) =>
		asset.name.includes("2× local upscale")
	);
	expect(twice).toMatchObject({ kind: "image", width: 640, height: 360 });
	await stillRow
		.getByRole("button", { name: `Upscale ${still.name} 4 times` })
		.click();
	await expect(page.getByRole("status")).toContainText(
		"4× local upscale added to the media library."
	);
	const fourTimes = (await readAssets(page)).find((asset) =>
		asset.name.includes("4× local upscale")
	);
	expect(fourTimes).toMatchObject({ kind: "image", width: 1280, height: 720 });

	await page
		.getByRole("button", { name: "Add sequence clip", exact: true })
		.click();
	const sequenceName = `Sequence · ${sourceTitle}`;
	await expect(page.getByRole("status")).toContainText(
		`${sequenceName} added to the media library.`,
		{ timeout: 60_000 }
	);
	await searchField.fill("");
	await expect(assetRow(page, sequenceName)).toBeVisible();
	const sequenceBefore = (await readAssets(page)).find(
		(asset) => asset.name === sequenceName
	);
	expect(sequenceBefore?.sequenceProjectId).toBe(sourceProjectId);
	await page.getByLabel("Media folder").selectOption("");
	await selectProject(page, sourceProjectId);
	await page.getByLabel("Search media").fill(video.name);
	await page
		.locator(".studio-asset")
		.filter({ has: page.getByText(video.name, { exact: true }) })
		.getByRole("button", { name: `Add ${video.name} to timeline` })
		.click();
	await saveProject(page);
	expect((await readProject(page, sourceProjectId)).segments).toHaveLength(2);
	await selectProject(page, targetProjectId);
	await page.getByLabel("Search media").fill(sequenceName);
	// Refresh renders the source timeline with FFmpeg before returning its asset.
	// Await that operation, as sequence creation above does, before checking feedback.
	const refreshedResponse = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname ===
				`/__studio/assets/${sequenceBefore?.id}/refresh-sequence` &&
			response.request().method() === "POST",
		{ timeout: 60_000 }
	);
	await assetRow(page, sequenceName)
		.getByRole("button", { name: `Refresh ${sequenceName}` })
		.click();
	expect((await refreshedResponse).status()).toBe(200);
	await expect(page.getByRole("status")).toContainText(
		"refreshed from its source timeline."
	);
	const refreshedSequence = (await readAssets(page)).find(
		(asset) => asset.name === sequenceName
	);
	expect(refreshedSequence?.duration).toBeCloseTo(16, 1);
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		clip: { x: 0, y: 0, width: 1440, height: 720 },
		path: path.join(
			evidenceDir,
			"video-studio-sequence-refreshed-readback.png"
		),
	});

	await page.getByLabel("Search media").fill("");
	const referenceRow = page
		.locator(".studio-asset")
		.filter({ has: page.getByText(video.name, { exact: true }) });
	await referenceRow.getByRole("button", { name: "Analyze source" }).click();
	await expect
		.poll(async () => (await readAnalysis(page, video.id)).analysis?.status, {
			timeout: 30_000,
		})
		.toBe("completed");
	await openOverflowTab(page, "Reference", "reference");
	await page.getByLabel("Reference video").selectOption(video.id);
	await page.getByRole("button", { name: "Build reference profile" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Reference profile saved to this project."
	);
	const referenceBrief = "Crew-led harbor stories with a measured pace.";
	await page.getByLabel("Reference brief").fill(referenceBrief);
	await page.getByRole("button", { name: "Copy brief to Plan" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Reference brief copied to Plan."
	);
	await saveProject(page);
	const persisted = await readProject(page, targetProjectId);
	expect(persisted.referenceProfile).toMatchObject({
		assetId: video.id,
		assetName: video.name,
		brief: referenceBrief,
	});
	expect(persisted.brief).toBe(referenceBrief);
	await openOverflowTab(page, "Plan", "storyboard");
	await expect(
		page.getByRole("textbox", {
			name: "What are we making, and who is it for?",
		})
	).toHaveValue(referenceBrief);

	await openOverflowTab(page, "Find footage", "search");
	await expect(
		page.getByRole("heading", { name: "Find footage by meaning" })
	).toBeVisible();
	await expect(
		page.getByText(/Open in a Ryu host with Spaces access/)
	).toBeVisible();
	await openOverflowTab(page, "Stock", "stock");
	await expect(page.getByLabel("Open media provider")).toBeVisible();
	await openOverflowTab(page, "Sync", "sync");
	await expect(page.getByRole("heading", { name: "Sync clips" })).toBeVisible();
	await openOverflowTab(page, "Generate", "generate");
	await expect(
		page.getByRole("heading", { name: "Generate with Ryu" })
	).toBeVisible();
	await page
		.getByPlaceholder("Describe the scene, subject, and motion…")
		.fill("Harbor title card at first light");
	const imageFailure = await page.request.post(
		"/__proof/fail-next-image-generation"
	);
	expect(imageFailure.ok()).toBe(true);
	await page
		.getByRole("button", { name: "Generate media", exact: true })
		.click();
	await expect(page.getByRole("status")).toContainText(
		"Fixture image generation failed once."
	);
	const incompleteJobs = await readGenerationJobs(page, targetProjectId);
	expect(incompleteJobs).toHaveLength(1);
	expect(incompleteJobs[0]).toMatchObject({
		message: "Fixture image generation failed once.",
		request: {
			kind: "image",
			projectId: targetProjectId,
			prompt: "Harbor title card at first light",
		},
		status: "incomplete",
	});
	await page
		.getByRole("button", { name: "Generate media", exact: true })
		.click();
	await expect(page.getByRole("status")).toContainText(
		"Generated media saved to your library. Review it before adding it to the timeline."
	);
	const generationCalls = await page.evaluate(
		() => window.__videoStudioFixtureImageCalls ?? []
	);
	expect(generationCalls).toHaveLength(2);
	expect(generationCalls.map((call) => call.prompt)).toEqual([
		"Harbor title card at first light",
		"Harbor title card at first light",
	]);
	expect(generationCalls[0]).toMatchObject({
		count: 1,
		project_id: targetProjectId,
	});
	const completedJobs = await readGenerationJobs(page, targetProjectId);
	expect(completedJobs.map((job) => job.status).sort()).toEqual([
		"completed",
		"incomplete",
	]);
	const generatedAsset = (await readAssets(page)).find((asset) =>
		asset.name.includes("Generated image")
	);
	expect(generatedAsset).toMatchObject({ kind: "image" });
	await openOverflowTab(page, "Credits", "credits");
	await expect(
		page.getByRole("heading", { name: "Credits and provenance" })
	).toBeVisible();
	await expect(
		page.getByText("No attributed source media is used by this project.")
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Download credits" })
	).toBeEnabled();
	const creditsDownloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download credits" }).click();
	const creditsDownload = await creditsDownloadPromise;
	expect(creditsDownload.suggestedFilename()).toBe(`${targetTitle}-credits.md`);
	const creditsPath = await creditsDownload.path();
	expect(creditsPath).toBeTruthy();
	if (!creditsPath) {
		throw new Error("The generated credits document was not preserved.");
	}
	expect(await readFile(creditsPath, "utf8")).toContain(
		`# Credits — ${targetTitle}`
	);
	await expect(page.getByRole("status")).toContainText(
		"Credits document downloaded."
	);
	await saveScreenshot(page, "video-studio-app-media-reference-generation.png");
});

test("App creative panels save editable titles, graphics, avatars, worlds, and meshes", async ({
	page,
}) => {
	const title = uniqueTitle("App creative panels");
	const projectId = await createProject(page, title);

	await openOverflowTab(page, "Titles", "titles");
	await page.getByRole("button", { name: "Add title", exact: true }).click();
	const titleText = "A harbor at first light";
	await page.getByRole("textbox", { name: "Title 1 text" }).fill(titleText);
	await page.getByLabel("Title 1 entry animation").selectOption("slide-left");

	await openOverflowTab(page, "Vector graphics", "graphics");
	await page.getByRole("button", { name: "Add vector shape" }).click();
	await page.getByLabel("Vector shape 1 shape").selectOption("ellipse");
	await fillNumber(page, "Graphic 1 Width", "0.62");
	await fillNumber(page, "Graphic 1 Height", "0.24");

	await openOverflowTab(page, "Avatars", "avatars");
	await page.getByRole("button", { name: "Add 2.5D avatar" }).click();
	await page.getByLabel("Avatar 1 pose").selectOption("wave");
	await page.getByLabel("Avatar 1 motion").selectOption("slide-right");
	await page.getByLabel("Avatar 1 rig keyframe value").fill("0.7");
	await page
		.getByRole("button", { name: "Add rig keyframe at playhead" })
		.click();

	await openOverflowTab(page, "3D stage", "stage");
	const worldPrompt = "A quiet harbor with a lighthouse and a cedar pier";
	await page.getByLabel("3D world direction").fill(worldPrompt);
	await page.getByRole("button", { name: "Generate local world" }).click();
	await expect(page.getByText(/Generated 8 editable blocks/)).toBeVisible();
	await page.getByLabel("Stage camera path time").fill("1.5");
	await page.getByLabel("Stage camera path property").selectOption("zoom");
	await page.getByLabel("Stage camera path value").fill("1.25");
	await page.getByRole("button", { name: "Add camera keyframe" }).click();

	await openOverflowTab(page, "Meshes", "meshes");
	const invalidObjChooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import 3D mesh" }).click();
	await (await invalidObjChooserPromise).setFiles({
		name: "broken-triangle.obj",
		mimeType: "text/plain",
		buffer: Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 4\n"),
	});
	await expect(page.getByRole("status")).not.toContainText(
		"Imported broken-triangle.obj"
	);
	await expect(page.getByText("Mesh 1", { exact: true })).toHaveCount(0);

	const meshChooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import 3D mesh" }).click();
	await (await meshChooserPromise).setFiles({
		name: "harbor-triangle.obj",
		mimeType: "text/plain",
		buffer: Buffer.from(
			"o Harbor marker\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"
		),
	});
	await expect(page.getByRole("status")).toContainText(
		"Imported harbor-triangle.obj as 1 editable mesh."
	);
	await page.getByLabel("Mesh 1 keyframe property").selectOption("rotationY");
	await page.getByLabel("Mesh 1 keyframe value").fill("30");
	await page
		.getByRole("button", { name: "Add mesh keyframe at playhead" })
		.click();

	await saveProject(page);
	const saved = await readProject(page, projectId);
	expect(saved.titles).toHaveLength(1);
	expect(saved.titles[0]).toMatchObject({
		animation: "slide-left",
		text: titleText,
	});
	expect(saved.graphics).toHaveLength(1);
	expect(saved.graphics[0]).toMatchObject({
		height: 0.24,
		shape: "ellipse",
		width: 0.62,
	});
	expect(saved.avatars).toHaveLength(1);
	expect(saved.avatars[0]).toMatchObject({
		animation: "slide-right",
		pose: "wave",
		rigKeyframes: [
			{
				property: "leftArm",
				time: 0,
				value: 0.7,
			},
		],
	});
	expect(saved.stageWorldPrompt).toBe(worldPrompt);
	expect(saved.spatialObjects).toHaveLength(8);
	expect(saved.stageCamera.keyframes).toHaveLength(16);
	expect(saved.stageCamera.keyframes).toContainEqual(
		expect.objectContaining({ property: "zoom", time: 1.5, value: 1.25 })
	);
	expect(saved.meshes).toHaveLength(1);
	expect(saved.meshes[0]).toMatchObject({
		faces: [[0, 1, 2]],
		keyframes: [{ property: "rotationY", time: 0, value: 30 }],
		vertices: [
			[0, 0, 0],
			[1, 0, 0],
			[0, 1, 0],
		],
	});
	await saveScreenshot(page, "video-studio-app-creative-panels.png");
});

test("App timeline controls, caption import, and export recovery preserve the saved edit", async ({
	page,
}) => {
	const video = await seedAsset(page, "video", "App timeline fixture.mp4");
	const title = uniqueTitle("App timeline and export");
	const projectId = await createProject(page, title);
	await openOverflowTab(page, "Media", "media");
	await assetRow(page, video.name)
		.getByRole("button", { name: `Add ${video.name} to timeline` })
		.click();
	await saveProject(page);

	const playButton = page.getByRole("button", { name: "Play timeline" });
	await playButton.click();
	await expect(
		page.getByRole("button", { name: "Pause playback" })
	).toBeVisible();
	await page.getByRole("button", { name: "Pause playback" }).click();
	await expect(playButton).toBeVisible();

	const playhead = page.getByRole("spinbutton", { name: "Playhead" });
	await playhead.fill("2");
	await playhead.press("Tab");
	await page
		.getByRole("button", { name: "Insert selected clip at playhead" })
		.click();
	await expect(page.getByRole("status")).toContainText(
		`Inserted ${video.name} at 0:02.0 and rippled later layers.`
	);
	await saveProject(page);
	expect(
		(await readProject(page, projectId)).segments
			.map((segment) => ({ start: segment.start, track: segment.track }))
			.sort((left, right) => left.start - right.start)
	).toEqual([
		{ start: 0, track: 0 },
		{ start: 2, track: 0 },
		{ start: 10, track: 0 },
	]);

	await page
		.getByRole("button", { name: "Project settings", exact: true })
		.click();
	await expect(
		page.locator(".studio-inspector").getByText("Project settings", {
			exact: true,
		})
	).toBeVisible();
	await page.getByLabel("Output format").selectOption("1280x720");
	await saveProject(page);
	expect(await readProject(page, projectId)).toMatchObject({
		height: 720,
		width: 1280,
	});

	const zoom = page.getByLabel("Timeline zoom");
	await zoom.selectOption("120");
	await expect(zoom).toHaveValue("120");
	const zoomedWidth = await page
		.locator(".studio-tracks")
		.evaluate((element) => Number.parseFloat(getComputedStyle(element).width));
	expect(zoomedWidth).toBeGreaterThan(2000);

	await playhead.fill("4");
	await playhead.press("Tab");
	await page
		.getByRole("textbox", { name: "Marker label" })
		.fill("App edit marker");
	await page.getByRole("button", { name: "Add marker" }).click();
	await expect(page.getByRole("status")).toContainText("Marker added at 0:04.");
	await saveProject(page);
	expect((await readProject(page, projectId)).markers).toContainEqual(
		expect.objectContaining({ label: "App edit marker", time: 4 })
	);
	await playhead.fill("1");
	await playhead.press("Tab");
	const threeSecondTick = page
		.locator(".studio-ruler button")
		.filter({ hasText: /^3s$/ });
	await threeSecondTick.click();
	await expect(playhead).toHaveValue("3");

	await page.getByRole("button", { name: "Move Track 1 up" }).click();
	await saveProject(page);
	let timelineProject = await readProject(page, projectId);
	expect(timelineProject.segments.every((segment) => segment.track === 1)).toBe(
		true
	);
	await page.getByRole("button", { name: "Move Track 2 down" }).click();
	await saveProject(page);
	timelineProject = await readProject(page, projectId);
	expect(timelineProject.segments.every((segment) => segment.track === 0)).toBe(
		true
	);

	await openOverflowTab(page, "Captions", "captions");
	const subtitleFile = {
		name: "app-surface.srt",
		mimeType: "text/plain",
		buffer: Buffer.from(
			"1\n00:00:00,500 --> 00:00:01,750\nImported from the App surface.\n\n"
		),
	};
	const subtitleChooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import SRT / VTT" }).click();
	await (await subtitleChooserPromise).setFiles(subtitleFile);
	await expect(page.getByRole("textbox", { name: "Caption 1" })).toHaveValue(
		"Imported from the App surface."
	);
	await saveProject(page);
	let persisted = await readProject(page, projectId);
	expect(persisted.captions).toMatchObject([
		{ end: 1.75, start: 0.5, text: "Imported from the App surface." },
	]);

	await page.reload();
	await selectProject(page, projectId);
	await openOverflowTab(page, "Captions", "captions");
	await expect(page.getByRole("textbox", { name: "Caption 1" })).toHaveValue(
		"Imported from the App surface."
	);
	persisted = await readProject(page, projectId);
	expect(persisted.captions[0]).toMatchObject({
		end: 1.75,
		start: 0.5,
		text: "Imported from the App surface.",
	});

	// The local FFmpeg used by this proof lacks the subtitles filter. Preserve
	// the imported-cue reload proof above, then render the same saved edit with
	// an empty caption list so export/retry exercises the available filters.
	await page
		.getByRole("button", { name: "Remove caption", exact: true })
		.click();
	await saveProject(page);
	expect((await readProject(page, projectId)).captions).toEqual([]);

	const delay = await page.request.post("/__proof/arm-render-delay");
	expect(delay.ok()).toBe(true);
	await page.getByRole("button", { name: "Export video", exact: true }).click();
	await expect(page.getByRole("status")).toContainText(
		"Rendering the saved timeline. You can continue editing."
	);
	await expect(
		page.getByRole("heading", { name: "Export history" })
	).toBeVisible();
	await expect
		.poll(async () => {
			const response = await page.request.get("/__proof/render-active");
			return (await response.json()).active;
		})
		.toBe(true);
	await page.getByRole("button", { name: "Cancel export" }).click();
	await expect
		.poll(async () => {
			const jobs = await readRenderJobs(page);
			return jobs.find((job) => job.projectId === projectId)?.status;
		})
		.toBe("canceled");
	await expect(
		page.getByRole("button", { name: "Retry export" })
	).toBeVisible();
	await page.getByRole("button", { name: "Retry export" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Retrying the saved timeline export."
	);
	await expect(page.getByRole("status")).toContainText(
		"Export completed. Your video is ready to download.",
		{ timeout: 180_000 }
	);
	const renderJobs = await readRenderJobs(page);
	expect(
		renderJobs
			.filter((job) => job.projectId === projectId)
			.map((job) => job.status)
			.sort()
	).toEqual(["canceled", "completed"]);
	const completed = renderJobs.find(
		(job) => job.projectId === projectId && job.status === "completed"
	);
	expect(completed?.review).toMatchObject({
		height: 720,
		passed: true,
		width: 1280,
	});
	await page.getByText(/Delivery review · Passed/).click();
	await expect(page.getByText("Frame size:")).toBeVisible();
	await expect(page.getByText("Frame rate:")).toBeVisible();
	await saveScreenshot(page, "video-studio-app-timeline-caption-export.png");
});
