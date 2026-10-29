import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { dubbingScript } from "../../../apps-store/video-studio/shared/dubbing.ts";
import type { GenerationJob } from "../../../apps-store/video-studio/shared/generation.ts";
import type {
	Asset,
	Project,
} from "../../../apps-store/video-studio/shared/project.ts";
import { parseProofJson } from "./fixture-json.ts";

const evidenceDirectory = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface StudioRequest {
	body?: unknown;
	method: string;
	path: string;
	query: string;
}

/** Native capability observation only, not the production RyuBridge contract. */
interface FixtureLegacyModelCapabilityObservation {
	model?: { complete?: unknown };
}

interface FixtureModelCall {
	prompt: string;
	system?: string;
}

interface FixtureTtsCall {
	language?: string;
	request_id?: string;
	speed?: number;
	text: string;
	voice?: string;
}

declare global {
	interface Window {
		__videoStudioRemainingProof?: {
			translationCalls: FixtureModelCall[];
			ttsCalls: FixtureTtsCall[];
		};
	}
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
			query: url.search,
		});
	});
	return requests;
}

async function seedAsset(
	page: Page,
	fixture: "audio" | "image" | "video",
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
	expect(asset).toMatchObject({ kind: fixture, name });
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

async function openOverflowTab(page: Page, label: string, value: string) {
	const more = page.getByRole("button", { name: /Show \d+ more tabs/ });
	if (await more.isVisible()) {
		await more.click();
	}
	await page.getByRole("combobox", { name: "Search tabs" }).fill(label);
	const tab = page.locator(`[data-tabs-menu-key="string:${value}"]`);
	await expect(tab).toBeVisible();
	await tab.click();
}

async function selectProject(page: Page, projectId: string) {
	await page.getByLabel("Project").selectOption(projectId);
	await expect(page.getByLabel("Project")).toHaveValue(projectId);
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

async function saveProject(page: Page) {
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDirectory, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDirectory, filename),
	});
}

test("asset preview, color scopes, organization validation, save, and delete reach the sidecar", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const still = await seedAsset(page, "image", "Panel review still.png");
	await createProject(page, uniqueTitle("Asset review"));
	await openOverflowTab(page, "Media", "media");
	const originalRow = assetRow(page, still.name);
	await expect(originalRow).toBeVisible();
	await originalRow
		.getByRole("button", { name: `Preview ${still.name}` })
		.click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	const previewImage = dialog.getByRole("img", {
		name: `Preview of ${still.name}`,
	});
	await expect(previewImage).toBeVisible();
	await expect(previewImage).toHaveJSProperty("complete", true);
	await saveScreenshot(page, "video-studio-remaining-asset-preview.png");
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await originalRow
		.getByRole("button", { name: `Preview ${still.name}` })
		.click();
	await dialog.getByRole("button", { name: "Close preview" }).click();
	await expect(dialog).toBeHidden();

	await originalRow
		.getByRole("button", { name: `Inspect color of ${still.name}` })
		.click();
	await expect(
		originalRow.getByText(/Luma \d+% · Saturation \d+% · Hue/)
	).toBeVisible();
	expect(
		requests.some(
			(request) =>
				request.method === "GET" &&
				request.path === `/assets/${still.id}/scopes` &&
				request.query === "?time=0"
		)
	).toBe(true);

	const organization = originalRow.locator("details.studio-asset-organization");
	const summary = organization.locator("summary");
	await summary.click();
	await expect(organization).toHaveAttribute("open", "");
	const nameField = organization.getByLabel(`Name for ${still.name}`);
	const folderField = organization.getByLabel(`Folder for ${still.name}`);
	const renamed = "Renamed panel still.png";
	await nameField.fill(`  ${renamed}  `);
	await folderField.fill("../private");
	await organization.getByRole("button", { name: "Save metadata" }).click();
	await expect(page.getByRole("status")).toContainText(
		"The request does not match the Video Studio contract."
	);
	const unchanged = (await readAssets(page)).find(
		(asset) => asset.id === still.id
	);
	expect(unchanged?.name).toBe(still.name);
	expect(unchanged?.folder).toBeUndefined();
	await folderField.fill("B-roll/Sunset");
	await organization.getByRole("button", { name: "Save metadata" }).click();
	await expect(page.getByRole("status")).toContainText("metadata saved.");
	const changed = (await readAssets(page)).find(
		(asset) => asset.id === still.id
	);
	expect(changed).toMatchObject({ folder: "B-roll/Sunset", name: renamed });
	const organizeRequests = requests.filter(
		(request) =>
			request.method === "POST" &&
			request.path === `/assets/${still.id}/organize`
	);
	expect(organizeRequests).toHaveLength(2);
	expect(organizeRequests.map((request) => request.body)).toEqual([
		{ delete: false, folder: "../private", name: renamed },
		{ delete: false, folder: "B-roll/Sunset", name: renamed },
	]);
	await saveScreenshot(page, "video-studio-remaining-asset-organization.png");

	const renamedRow = assetRow(page, renamed);
	await renamedRow.getByRole("button", { name: "Delete media" }).click();
	await expect(page.getByRole("status")).toContainText(
		`Deleted ${renamed}; removed 0 timeline clips.`
	);
	expect((await readAssets(page)).some((asset) => asset.id === still.id)).toBe(
		false
	);
	await expect(assetRow(page, renamed)).toHaveCount(0);
});

test("research citations and production checkpoints validate and survive project reload", async ({
	page,
}) => {
	const title = uniqueTitle("Project research and checkpoints");
	const projectId = await createProject(page, title);
	await openOverflowTab(page, "Plan", "storyboard");
	const sourceTitle = "Harbor archive chronology";
	const titleField = page.getByLabel("Research source title");
	const urlField = page.getByLabel("Research source URL");
	const noteField = page.getByLabel("Research source note");
	await titleField.fill(sourceTitle);
	await urlField.fill("http://example.org/archive");
	await noteField.fill("Use the handwritten entry for the year range.");
	await page.getByRole("button", { name: "Add research source" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Research sources require HTTPS."
	);
	expect((await readProject(page, projectId)).researchSources).toEqual([]);

	const sourceUrl = "https://example.org/archive/harbor?edition=4";
	await urlField.fill(sourceUrl);
	await page.getByRole("button", { name: "Add research source" }).click();
	await expect(page.getByText(sourceTitle, { exact: true })).toBeVisible();
	await expect(page.getByText(sourceUrl, { exact: true })).toBeVisible();
	await titleField.fill(sourceTitle);
	await urlField.fill(sourceUrl);
	await noteField.fill("Duplicate citation should stay blocked.");
	await page.getByRole("button", { name: "Add research source" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"This research source is already saved."
	);
	await saveProject(page);
	let saved = await readProject(page, projectId);
	expect(saved.researchSources).toHaveLength(1);
	expect(saved.researchSources[0]).toMatchObject({
		note: "Use the handwritten entry for the year range.",
		title: sourceTitle,
		url: sourceUrl,
	});
	expect(saved.researchSources[0]?.retrievedAt).toBeTruthy();

	await page.reload();
	await selectProject(page, projectId);
	await openOverflowTab(page, "Plan", "storyboard");
	await expect(page.getByText(sourceTitle, { exact: true })).toBeVisible();
	await expect(
		page.getByText("Use the handwritten entry for the year range.", {
			exact: true,
		})
	).toBeVisible();

	const researchStage = page
		.locator(".studio-activity-list .studio-activity-item")
		.filter({ has: page.getByText("Research", { exact: true }) });
	await researchStage
		.getByRole("button", { name: "Start", exact: true })
		.click();
	await expect(researchStage).toContainText("active");
	await researchStage
		.getByRole("button", { name: "Complete", exact: true })
		.click();
	await expect(researchStage).toContainText("complete");
	await saveProject(page);
	saved = await readProject(page, projectId);
	expect(saved.stages[0]).toMatchObject({ id: "research", status: "complete" });
	expect(saved.stages[0]?.startedAt).toBeTruthy();
	expect(saved.stages[0]?.completedAt).toBeTruthy();
	await saveScreenshot(page, "video-studio-remaining-research-stages.png");

	await page
		.getByRole("button", { name: `Remove research source ${sourceTitle}` })
		.click();
	await saveProject(page);
	expect((await readProject(page, projectId)).researchSources).toEqual([]);
});

test("recipe audio, multicam selection, and playhead input advance, pause, and recover", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const cameraA = await seedAsset(page, "video", "Panel camera A.mp4");
	const cameraB = await seedAsset(page, "video", "Panel camera B.mp4");
	const cameraC = await seedAsset(page, "video", "Panel camera C.mp4");
	const narration = await seedAsset(page, "audio", "Recipe narration.wav");
	const title = uniqueTitle("Recipe and multicam panels");
	const projectId = await createProject(page, title);

	await openOverflowTab(page, "Recipes", "recipes");
	await page.getByRole("button", { name: cameraA.name, exact: true }).click();
	const recipeAudio = page.getByLabel("Recipe audio source");
	await recipeAudio.selectOption(narration.id);
	await expect(recipeAudio).toHaveValue(narration.id);
	await page
		.getByLabel("Recipe title")
		.fill("Harbor edit with local narration");
	await page.getByLabel("Recipe format").selectOption("square");
	await page.getByRole("button", { name: "Apply recipe", exact: true }).click();
	await expect(page.getByRole("status")).toContainText(
		"Recipe applied and saved. Review the timeline before exporting."
	);
	const recipeRequest = requests.find(
		(request) =>
			request.method === "POST" &&
			request.path === `/projects/${projectId}/recipe`
	);
	expect(recipeRequest?.body).toMatchObject({
		assetIds: [cameraA.id],
		audioId: narration.id,
		format: "square",
		kind: "montage",
		title: "Harbor edit with local narration",
	});
	let saved = await readProject(page, projectId);
	expect(saved.segments.map((segment) => segment.assetId)).toEqual(
		expect.arrayContaining([cameraA.id, narration.id])
	);
	const audioLayer = saved.segments.find(
		(segment) => segment.assetId === narration.id
	);
	expect(audioLayer?.track).toBe(1);

	await openOverflowTab(page, "Multicam", "multicam");
	await page.getByRole("button", { name: cameraA.name, exact: true }).click();
	await page.getByRole("button", { name: cameraB.name, exact: true }).click();
	await page.getByLabel("Multicam program audio").selectOption(cameraC.id);
	await page.getByLabel("Multicam session name").fill("Panel interview A");
	await page.getByRole("button", { name: "Create multicam session" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Multicam session created with a program-audio track."
	);
	await page.getByRole("button", { name: cameraA.name, exact: true }).click();
	await page.getByRole("button", { name: cameraC.name, exact: true }).click();
	await page.getByLabel("Multicam program audio").selectOption(cameraB.id);
	await page.getByLabel("Multicam session name").fill("Panel interview B");
	await page.getByRole("button", { name: "Create multicam session" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Multicam session created with a program-audio track."
	);
	saved = await readProject(page, projectId);
	expect(saved.multicamGroups).toHaveLength(2);
	const firstGroup = saved.multicamGroups.find(
		(group) => group.name === "Panel interview A"
	);
	const secondGroup = saved.multicamGroups.find(
		(group) => group.name === "Panel interview B"
	);
	expect(firstGroup?.members.map((member) => member.assetId)).toEqual(
		expect.arrayContaining([cameraA.id, cameraB.id, cameraC.id])
	);
	expect(secondGroup?.members.map((member) => member.assetId)).toEqual(
		expect.arrayContaining([cameraA.id, cameraB.id, cameraC.id])
	);
	const multicamRequests = requests.filter(
		(request) =>
			request.method === "POST" &&
			request.path === `/projects/${projectId}/multicam`
	);
	expect(multicamRequests).toHaveLength(2);
	expect(multicamRequests.map((request) => request.body)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ action: "create", name: "Panel interview A" }),
			expect.objectContaining({ action: "create", name: "Panel interview B" }),
		])
	);
	if (!(firstGroup && secondGroup)) {
		throw new Error("Both locally saved multicam sessions must exist.");
	}
	const session = page.getByLabel("Multicam session", { exact: true });
	await session.selectOption(secondGroup.id);
	await expect(session).toHaveValue(secondGroup.id);
	await expect(
		page.getByLabel("Multicam switch angle").locator("option")
	).toHaveCount(2);
	await page.getByLabel("Multicam switch angle").selectOption(cameraC.name);
	await expect(page.getByLabel("Multicam switch angle")).toHaveValue(
		cameraC.name
	);

	const playButton = page.getByRole("button", { name: "Play timeline" });
	const playhead = page.getByRole("spinbutton", { name: "Playhead" });
	await playhead.fill("2.5");
	await playhead.press("Tab");
	await expect(playhead).toHaveValue("2.5");
	const startTime = Number(await playhead.inputValue());
	await saveScreenshot(
		page,
		"video-studio-remaining-recipe-multicam-number-field.png"
	);
	await playButton.click();
	await expect(
		page.getByRole("button", { name: "Pause playback" })
	).toBeVisible();
	await expect
		.poll(async () => Number(await playhead.inputValue()))
		.toBeGreaterThan(startTime);
	await playhead.focus();
	await expect(playButton).toBeVisible();
	const stoppedTime = Number(await playhead.inputValue());
	expect(stoppedTime).toBeGreaterThan(startTime);
	const stoppedValue = await playhead.inputValue();
	await expect.poll(() => playhead.inputValue()).toBe(stoppedValue);
	await playhead.fill("999");
	await playhead.press("Tab");
	await expect
		.poll(async () => Number(await playhead.inputValue()))
		.toBeCloseTo(stoppedTime, 2);
});

test("fixture-backed stock search imports attributed media and opens the exact credits URL", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const title = uniqueTitle("Stock attribution workflow");
	const projectId = await createProject(page, title);
	await openOverflowTab(page, "Stock", "stock");
	const provider = page.getByLabel("Open media provider");
	await provider.selectOption("wikimedia.commons");
	const searchField = page.getByLabel("Search open media");
	const query = "harbor movement footage";
	await searchField.fill(query);
	const armFailure = await page.request.post("/__proof/arm-stock-failure");
	expect(armFailure.ok()).toBe(true);
	await searchField.press("Enter");
	await expect(page.getByRole("status")).toContainText(
		"Fixture stock search failed once."
	);
	await expect(searchField).toHaveValue(query);
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await expect(
		page.getByText("Coverage harbor film", { exact: true })
	).toBeVisible();
	const searchRequests = requests.filter(
		(request) => request.method === "GET" && request.path === "/stock/search"
	);
	expect(searchRequests).toHaveLength(2);
	for (const request of searchRequests) {
		const queryParams = new URLSearchParams(request.query);
		expect(queryParams.get("provider")).toBe("wikimedia.commons");
		expect(queryParams.get("q")).toBe(query);
		expect(queryParams.get("limit")).toBe("8");
	}

	await page.getByRole("button", { name: "Import to library" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Imported Coverage harbor film.mp4. Review the source rights before publishing."
	);
	const importedStock = (await readAssets(page)).find(
		(asset) => asset.name === "Coverage harbor film.mp4"
	);
	expect(importedStock).toMatchObject({
		folder: "Open catalog",
		kind: "video",
		origin: {
			identifier: "coverage-harbor-film",
			provider: "wikimedia.commons",
		},
	});
	const importRequest = requests.find(
		(request) => request.method === "POST" && request.path === "/stock"
	);
	expect(importRequest?.body).toEqual({
		identifier: "coverage-harbor-film",
		provider: "wikimedia.commons",
	});
	if (!importedStock) {
		throw new Error(
			"The fixture-backed stock import must create a sidecar asset."
		);
	}

	await openOverflowTab(page, "Media", "media");
	await page.getByLabel("Search media").fill(importedStock.name);
	await assetRow(page, importedStock.name)
		.getByRole("button", { name: `Add ${importedStock.name} to timeline` })
		.click();
	await saveProject(page);
	expect(
		(await readProject(page, projectId)).segments.map(
			(segment) => segment.assetId
		)
	).toContain(importedStock.id);

	await openOverflowTab(page, "Credits", "credits");
	const sourceUrl =
		"https://commons.wikimedia.org/wiki/File:Coverage_harbor_film.mp4";
	const sourceLink = page.getByRole("link", { name: "Open source page" });
	await expect(sourceLink).toHaveAttribute("href", sourceUrl);
	await expect(sourceLink).toHaveAttribute("target", "_blank");
	await expect(sourceLink).toHaveAttribute("rel", "noreferrer noopener");
	await page.context().route(sourceUrl, (route) =>
		route.fulfill({
			body: "<h1>Fixture attribution destination</h1>",
			contentType: "text/html",
		})
	);
	const popupPromise = page.waitForEvent("popup");
	await sourceLink.click();
	const popup = await popupPromise;
	await expect(popup).toHaveURL(sourceUrl);
	await expect(
		popup.getByRole("heading", { name: "Fixture attribution destination" })
	).toBeVisible();

	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download credits" }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe(`${title}-credits.md`);
	const outputPath = await download.path();
	expect(outputPath).toBeTruthy();
	if (!outputPath) {
		throw new Error("The fixture-backed credit document was not preserved.");
	}
	expect(await readFile(outputPath, "utf8")).toContain(sourceUrl);
	await saveScreenshot(page, "video-studio-remaining-stock-credits.png");
});

test("caption translation and dubbing recover through local fixtures and appear in generation history", async ({
	page,
}) => {
	const title = uniqueTitle("Caption generation history");
	const projectId = await createProject(page, title);
	await openOverflowTab(page, "Captions", "captions");
	const subtitleChooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import SRT / VTT" }).click();
	await (await subtitleChooserPromise).setFiles({
		name: "panel-captions.srt",
		mimeType: "text/plain",
		buffer: Buffer.from(
			"1\n00:00:00,500 --> 00:00:01,750\nThe harbor is waking.\n\n"
		),
	});
	await expect(page.getByRole("textbox", { name: "Caption 1" })).toHaveValue(
		"The harbor is waking."
	);
	await saveProject(page);
	const original = await readProject(page, projectId);
	expect(original.captions[0]).toMatchObject({ start: 0.5, end: 1.75 });
	await page.reload();
	await selectProject(page, projectId);
	await openOverflowTab(page, "Captions", "captions");
	await expect(page.getByRole("textbox", { name: "Caption 1" })).toHaveValue(
		"The harbor is waking."
	);

	const languageField = page.getByLabel("Caption translation language");
	await languageField.fill("French");
	await expect(languageField).toHaveValue("French");
	const bridgeState = await page.evaluate(() => ({
		captionText: document.querySelector<HTMLInputElement>(
			'[aria-label="Caption 1"]'
		)?.value,
		// SAFETY: This single capability read observes the legacy model.complete
		// property installed by this fixture host. Other bridge fields are not
		// validated or promoted to the production RyuBridge contract.
		modelComplete:
			(
				window as Omit<Window, "ryu"> & {
					ryu?: FixtureLegacyModelCapabilityObservation;
				}
			).ryu?.model?.complete instanceof Function,
		translationLanguage: document.querySelector<HTMLInputElement>(
			'[aria-label="Caption translation language"]'
		)?.value,
		proofCalls: window.__videoStudioRemainingProof?.translationCalls.length,
	}));
	expect(bridgeState).toMatchObject({
		captionText: "The harbor is waking.",
		modelComplete: true,
		translationLanguage: "French",
		proofCalls: 0,
	});
	const translateButton = page.getByRole("button", {
		name: "Translate with Ryu",
	});
	await expect(translateButton).toBeEnabled();
	const translationFailure = await page.request.post(
		"/__proof/arm-translation-failure"
	);
	expect(translationFailure.ok()).toBe(true);
	await translateButton.click();
	await expect(page.getByRole("status")).toContainText(
		"Fixture caption translation failed once."
	);
	expect((await readProject(page, projectId)).captions[0]?.text).toBe(
		"The harbor is waking."
	);
	await expect(translateButton).toBeEnabled();
	await translateButton.click();
	await expect(page.getByRole("status")).toContainText(
		"Translated captions are ready for review. Their timings were preserved."
	);
	await saveProject(page);
	let saved = await readProject(page, projectId);
	const translatedTrack = saved.captionTracks.find(
		(track) => track.language === "French"
	);
	expect(translatedTrack?.captions[0]).toMatchObject({
		end: 1.75,
		start: 0.5,
		text: "Bonjour: The harbor is waking.",
	});
	expect(saved.captionTrackId).toBe(translatedTrack?.id);
	const modelCalls = await page.evaluate(
		() => window.__videoStudioRemainingProof?.translationCalls ?? []
	);
	expect(modelCalls).toHaveLength(2);
	expect(JSON.parse(modelCalls[0]?.prompt ?? "{}")).toMatchObject({
		language: "French",
		captions: [{ text: "The harbor is waking." }],
	});

	const dubbingLanguage = page.getByLabel("Dubbing language");
	const dubbingVoice = page.getByLabel("Dubbing voice");
	const dubbingSpeed = page.getByLabel("Dubbing speed");
	await dubbingLanguage.fill("fr-FR");
	await dubbingVoice.fill("Harbor narrator");
	await dubbingSpeed.fill("1.2");
	const dubButton = page.getByRole("button", { name: "Create dubbed track" });
	await expect(dubButton).toBeEnabled();
	const dubbingFailure = await page.request.post(
		"/__proof/arm-dubbing-failure"
	);
	expect(dubbingFailure.ok()).toBe(true);
	await dubButton.click();
	await expect(page.getByRole("status")).toContainText(
		"Fixture dubbing failed once."
	);
	const failedJobs = await readGenerationJobs(page, projectId);
	expect(failedJobs).toHaveLength(1);
	expect(failedJobs[0]).toMatchObject({
		message: "Fixture dubbing failed once.",
		request: {
			kind: "audio",
			language: "fr-FR",
			projectId,
			prompt: dubbingScript(translatedTrack?.captions ?? []),
			route: "node-default",
			speed: 1.2,
			voice: "Harbor narrator",
		},
		status: "incomplete",
	});
	await expect(dubButton).toBeEnabled();
	await dubButton.click();
	await expect(page.getByRole("status")).toContainText(
		"Dubbed audio saved and added to the timeline. Review pronunciation and timing."
	);
	await saveProject(page);
	saved = await readProject(page, projectId);
	expect(saved.captionTrackId).toBe(translatedTrack?.id);
	expect(
		saved.captionTracks.find((track) => track.id === translatedTrack?.id)
			?.captions[0]
	).toMatchObject({
		start: 0.5,
		end: 1.75,
		text: "Bonjour: The harbor is waking.",
	});
	const audioAssetId = saved.segments.find(
		(segment) => segment.track === 1
	)?.assetId;
	expect(audioAssetId).toBeTruthy();
	const audioAsset = (await readAssets(page)).find(
		(asset) => asset.id === audioAssetId
	);
	expect(audioAsset).toMatchObject({
		kind: "audio",
		name: "Dubbed captions fr-FR.wav",
	});

	const dubCalls = await page.evaluate(
		() => window.__videoStudioRemainingProof?.ttsCalls ?? []
	);
	expect(dubCalls).toHaveLength(2);
	const expectedScript = dubbingScript(translatedTrack?.captions ?? []);
	expect(
		dubCalls.map((call) => ({
			language: call.language,
			speed: call.speed,
			text: call.text,
			voice: call.voice,
		}))
	).toEqual([
		{
			language: "fr-FR",
			speed: 1.2,
			text: expectedScript,
			voice: "Harbor narrator",
		},
		{
			language: "fr-FR",
			speed: 1.2,
			text: expectedScript,
			voice: "Harbor narrator",
		},
	]);

	await openOverflowTab(page, "Generate", "generate");
	await expect(
		page.getByRole("heading", { name: "Generation history" })
	).toBeVisible();
	const failedHistory = page
		.locator("details.studio-scene")
		.filter({ hasText: "Fixture dubbing failed once." });
	await expect(failedHistory).not.toHaveAttribute("open", "");
	await failedHistory.locator("summary").click();
	await expect(failedHistory).toHaveAttribute("open", "");
	await expect(failedHistory).toContainText(
		"Voice: Harbor narrator · Language: fr-FR · Rate: 1.2×"
	);
	await expect(failedHistory).toContainText(
		"Check the provider before retrying; this request may already have incurred a charge."
	);
	const completedHistory = page.locator("details.studio-scene").filter({
		hasText:
			"Caption timing was retained; review the generated audio duration.",
	});
	await expect(completedHistory).not.toHaveAttribute("open", "");
	await completedHistory.locator("summary").click();
	await expect(completedHistory).toHaveAttribute("open", "");
	await expect(completedHistory).toContainText(
		`Saved media: ${audioAsset?.name}`
	);
	const allJobs = await readGenerationJobs(page, projectId);
	expect(allJobs.map((job) => job.status).sort()).toEqual([
		"completed",
		"incomplete",
	]);
	await saveScreenshot(
		page,
		"video-studio-remaining-caption-generation-history.png"
	);
});
