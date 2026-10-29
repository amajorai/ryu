import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import type {
	Asset,
	Caption,
	Project,
} from "../../../apps-store/video-studio/shared/project.ts";
import {
	capturedJsonArray,
	capturedJsonField,
} from "./captured-json-observations.ts";
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

interface ModelCall {
	prompt: string;
	system: string;
}

declare global {
	interface Window {
		__coverageModelCalls?: ModelCall[];
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
		});
	});
	return requests;
}

function seedVideoAsset(
	page: Page,
	name: string,
	_ignoredName?: string
): Promise<Asset>;
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
	expect(asset).toMatchObject({ name, kind: "video", hasAudio: false });
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

async function selectProjectAfterReload(page: Page, projectId: string) {
	await page.reload();
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByLabel("Project").selectOption(projectId);
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

test("Plan drafts scenes, validates and saves production edits, reviews scene assets, and assembles the persisted edit", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const video = await seedVideoAsset(
		page,
		"video",
		`${uniqueTitle("Storyboard visual take")}.mp4`
	);
	const title = uniqueTitle("Storyboard plan project");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	await openOverflowTab(page, "Plan", "storyboard");
	const briefField = page.getByRole("textbox", {
		name: "What are we making, and who is it for?",
	});
	await expect(briefField).toBeVisible();

	const brief = "A short film about the people who keep a harbor moving.";
	const draftButton = page.getByRole("button", {
		name: "Draft scenes with Ryu",
		exact: true,
	});
	await expect(draftButton).toBeDisabled();
	await briefField.fill(brief);
	await expect(draftButton).toBeEnabled();
	const armDraftFailure = await page.request.post(
		"/__proof/arm-scene-draft-failure"
	);
	expect(armDraftFailure.ok()).toBe(true);
	await draftButton.click();
	await expect(page.getByRole("status")).toContainText(
		"Fixture scene draft failed once."
	);
	await expect(page.getByLabel("Scene 1 title")).toHaveCount(0);
	await expect(draftButton).toBeEnabled();
	await draftButton.click();
	await expect(page.getByRole("status")).toContainText(
		"Draft scenes added for review. No media has been generated."
	);
	await expect(page.getByLabel(/Scene \d+ title/)).toHaveCount(3);
	const modelCalls = await page.evaluate(
		() => window.__coverageModelCalls ?? []
	);
	expect(modelCalls).toHaveLength(2);
	expect(modelCalls.map((call) => call.prompt)).toEqual([brief, brief]);
	expect(modelCalls[0]?.system).toContain("Produce 3 to 8 original scenes");

	await page.getByLabel("Research source title").fill("Harbor planning brief");
	await page
		.getByLabel("Research source URL")
		.fill("http://example.org/harbor");
	await page
		.getByLabel("Research source note")
		.fill("  Background for the production team.  ");
	await page.getByRole("button", { name: "Add research source" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Research sources require HTTPS."
	);
	await expect(
		page.getByText("Harbor planning brief", { exact: true })
	).toHaveCount(0);
	await page
		.getByLabel("Research source URL")
		.fill("  https://example.org/harbor  ");
	await page.getByRole("button", { name: "Add research source" }).click();
	await expect(
		page.getByText("Harbor planning brief", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("https://example.org/harbor", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Background for the production team.", { exact: true })
	).toBeVisible();

	const researchStage = page
		.locator(".studio-activity-list .studio-activity-item")
		.filter({ has: page.getByText("Research", { exact: true }) });
	await expect(researchStage).toHaveCount(1);
	await researchStage.getByRole("button", { name: "Start" }).click();
	await expect(
		researchStage.getByText("active", { exact: true })
	).toBeVisible();
	await researchStage.getByRole("button", { name: "Complete" }).click();
	await expect(
		researchStage.getByText("complete", { exact: true })
	).toBeVisible();

	const budgetCap = page.getByLabel("Project production budget cap");
	await budgetCap.fill("28.75");
	await budgetCap.press("Tab");
	await expect(budgetCap).toHaveValue("28.75");
	const imageEstimate = page.getByLabel("Image generation estimate");
	await imageEstimate.fill("2.35");
	await imageEstimate.press("Tab");
	await expect(imageEstimate).toHaveValue("2.35");

	await page.getByRole("button", { name: "Add scene", exact: true }).click();
	await expect(page.getByLabel(/Scene \d+ title/)).toHaveCount(4);
	await expect(page.getByLabel("Scene 4 title")).toHaveValue("Scene 4");
	await page.getByLabel("Scene 4 title").fill("A new horizon");
	await page
		.getByLabel("Scene 4 script")
		.fill("The harbor wakes to another day.");
	await page
		.getByLabel("Scene 4 visual direction")
		.fill("Lift from the waterline as the sun clears the breakwater.");
	await page.getByLabel("Scene 1 title").fill("Harbor at first light");
	await page
		.getByLabel("Scene 1 script")
		.fill("The first boats leave before sunrise.");
	await page
		.getByLabel("Scene 1 visual direction")
		.fill("Track along the harbor wall into the morning light.");
	await page
		.getByLabel("Scene 1 review status")
		.selectOption("changes-requested");
	await page
		.getByLabel("Scene 1 review note")
		.fill("Show more of the working crew before the wide shot.");

	const failSave = await page.request.post("/__proof/fail-next-project-save");
	expect(failSave.ok()).toBe(true);
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText(
		"Fixture project save failed."
	);
	const beforeRetry = await getProject(page, projectId);
	expect(beforeRetry.brief).toBe("");
	expect(beforeRetry.scenes).toHaveLength(0);
	expect(beforeRetry.researchSources).toEqual([]);
	await expect(
		page.getByRole("textbox", {
			name: "What are we making, and who is it for?",
		})
	).toHaveValue(brief);
	await expect(page.getByLabel("Scene 1 review note")).toHaveValue(
		"Show more of the working crew before the wide shot."
	);
	await saveProject(page);

	let saved = await getProject(page, projectId);
	expect(saved.brief).toBe(brief);
	expect(saved.researchSources).toHaveLength(1);
	expect(saved.researchSources[0]).toMatchObject({
		note: "Background for the production team.",
		title: "Harbor planning brief",
		url: "https://example.org/harbor",
	});
	expect(saved.stages.find((stage) => stage.id === "research")).toMatchObject({
		status: "complete",
	});
	expect(saved.productionBudget).toMatchObject({
		estimates: { image: 2_350_000 },
		limitMicroUsd: 28_750_000,
	});
	expect(saved.scenes).toHaveLength(4);
	expect(saved.scenes[0]).toMatchObject({
		approved: false,
		prompt: "Track along the harbor wall into the morning light.",
		reviewNotes: "Show more of the working crew before the wide shot.",
		reviewStatus: "changes-requested",
		script: "The first boats leave before sunrise.",
		title: "Harbor at first light",
	});
	expect(saved.scenes[0]?.id).toMatch(/^[0-9a-f-]{36}$/i);

	for (let index = 1; index <= saved.scenes.length; index += 1) {
		await page.getByLabel(`Scene ${index} visual take`).selectOption(video.id);
	}
	const requireApproval = page.getByRole("button", {
		name: "Require scene approval",
		exact: true,
	});
	if (await requireApproval.isVisible()) {
		await requireApproval.click();
	}
	await expect(
		page.getByRole("button", { name: "Scene approval required", exact: true })
	).toBeVisible();
	await saveProject(page);

	const beforeAssemble = await getProject(page, projectId);
	expect(beforeAssemble.scenes.map((scene) => scene.assetIds)).toEqual(
		Array.from({ length: 4 }, () => [video.id])
	);
	await page.getByRole("button", { name: "Assemble storyboard" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Approve each scene before assembling this production."
	);
	expect((await getProject(page, projectId)).segments).toHaveLength(0);

	await page
		.getByRole("button", { name: "Approve scene", exact: true })
		.first()
		.click();
	await expect(
		page.getByRole("button", { name: "Reopen review" }).first()
	).toBeVisible();
	await expect(page.getByLabel("Scene 1 review status")).toBeDisabled();
	await expect(page.getByLabel("Scene 1 review note")).toBeDisabled();
	await page
		.getByRole("button", { name: "Reopen review", exact: true })
		.first()
		.click();
	await expect(page.getByLabel("Scene 1 review status")).toBeEnabled();
	await expect(page.getByLabel("Scene 1 review note")).toBeEnabled();
	await page.getByLabel("Scene 1 review status").selectOption("in-review");
	await page
		.getByLabel("Scene 1 review note")
		.fill("Approved after the wider crew shot was added.");
	await page
		.getByRole("button", { name: "Approve scene", exact: true })
		.first()
		.click();
	for (let index = 2; index <= 4; index += 1) {
		const sceneCard = page
			.locator(".studio-scene")
			.filter({ has: page.getByLabel(`Scene ${index} title`) });
		await sceneCard
			.getByRole("button", { name: "Approve scene", exact: true })
			.click();
		await expect(
			sceneCard.getByRole("button", { name: "Reopen review", exact: true })
		).toBeVisible();
	}
	saved = await getProject(page, projectId);
	expect(saved.scenes.every((scene) => scene.approved)).toBe(true);
	expect(saved.scenes[0]?.reviewNotes).toBe(
		"Approved after the wider crew shot was added."
	);

	const assembleRequest = await getProject(page, projectId);
	await page.getByRole("button", { name: "Assemble storyboard" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Storyboard assembled into the timeline. Review the edit before exporting."
	);
	const assembled = await getProject(page, projectId);
	expect(assembled.segments).toHaveLength(4);
	expect(assembled.segments.map((segment) => segment.assetId)).toEqual(
		Array.from({ length: 4 }, () => video.id)
	);
	expect(
		assembled.segments.map((segment) => segment.sourceOut - segment.sourceIn)
	).toEqual(Array.from({ length: 4 }, () => 5));
	expect(assembled.titles.map((item) => item.text)).toEqual(
		assembled.scenes.map((scene) => scene.title)
	);
	const assemblyRequests = requests.filter(
		(request) =>
			request.path === `/projects/${projectId}/assemble` &&
			request.method === "POST"
	);
	expect(assemblyRequests).toHaveLength(2);
	expect(assemblyRequests[0]?.body).toMatchObject({
		includeTitles: true,
		revision: beforeAssemble.revision,
	});
	expect(assemblyRequests[1]?.body).toMatchObject({
		includeTitles: true,
		revision: assembleRequest.revision,
	});
	await selectProjectAfterReload(page, projectId);
	await openOverflowTab(page, "Plan", "storyboard");
	await expect(
		page.getByRole("textbox", {
			name: "What are we making, and who is it for?",
		})
	).toHaveValue(brief);
	await expect(page.getByLabel("Scene 1 title")).toHaveValue(
		"Harbor at first light"
	);
	await expect(page.getByLabel("Scene 1 review note")).toHaveValue(
		"Approved after the wider crew shot was added."
	);
	await expect(
		page.getByRole("button", { name: "Scene approval required" })
	).toBeVisible();
	await saveScreenshot(page, "video-studio-plan-assembly-overview.png");
	await expect(page.getByLabel("Scene 1 title")).toBeVisible();
	await page.getByLabel("Scene 1 title").scrollIntoViewIfNeeded();
	await saveScreenshot(page, "video-studio-plan-scenes-assembled.png");
});

test("Timed captions import, translate, edit, download, and retain word-highlight color after reload", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const title = uniqueTitle("Timed caption project");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	const initial = await getProject(page, projectId);
	const wordCue: Caption = {
		end: 1.5,
		highlightColor: "#ffd43b",
		id: crypto.randomUUID(),
		start: 0.5,
		text: "Seed voice",
		words: [
			{ end: 0.95, id: crypto.randomUUID(), start: 0.5, text: "Seed" },
			{ end: 1.5, id: crypto.randomUUID(), start: 0.95, text: "voice" },
		],
	};
	const seedResponse = await page.request.put(
		`/__studio/projects/${projectId}`,
		{
			data: { ...initial, captions: [wordCue] },
		}
	);
	expect(seedResponse.ok()).toBe(true);
	await selectProjectAfterReload(page, projectId);
	await openOverflowTab(page, "Captions", "captions");
	await expect(page.getByLabel("Caption 1 highlight color")).toBeVisible();
	await page.getByRole("button", { name: "Caption 1 highlight color" }).click();
	const hexInput = page.getByLabel("Hex color value");
	await expect(hexInput).toHaveValue("#FFD43B");
	await hexInput.fill("#38BDF8");
	await expect(
		page.getByRole("button", { name: "Caption 1 highlight color" })
	).toContainText("#38BDF8");
	await page.getByRole("textbox", { name: "Caption 1" }).click();
	await saveProject(page);
	expect((await getProject(page, projectId)).captions[0]?.highlightColor).toBe(
		"#38BDF8"
	);

	const srt = [
		"1",
		"00:00:01,250 --> 00:00:02,750",
		"Hello from the edit room.",
		"",
	].join("\n");
	const subtitleFile = {
		name: "harbor-captions.srt",
		mimeType: "text/plain",
		buffer: Buffer.from(srt),
	};
	const subtitleChooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import SRT / VTT" }).click();
	const subtitleChooser = await subtitleChooserPromise;
	await subtitleChooser.setFiles(subtitleFile);
	await expect(page.getByRole("textbox", { name: "Caption 1" })).toHaveValue(
		"Hello from the edit room."
	);
	await page.getByLabel("Caption translation language").fill("French");
	await page.getByRole("button", { name: "Translate with Ryu" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Translated captions are ready for review. Their timings were preserved."
	);
	const frenchOption = page
		.getByLabel("Caption track")
		.locator("option")
		.filter({ hasText: "French · French" });
	await expect(frenchOption).toHaveCount(1);
	const frenchTrackId = await frenchOption.getAttribute("value");
	expect(frenchTrackId).toBeTruthy();
	await expect(page.getByRole("textbox", { name: "Caption 1" })).toHaveValue(
		"Bonjour: Hello from the edit room."
	);
	await page.getByLabel("Caption track").selectOption("");
	await expect(page.getByRole("textbox", { name: "Caption 1" })).toHaveValue(
		"Hello from the edit room."
	);
	// SAFETY: Native getAttribute returns string|null; the existing toBeTruthy assertion rejected null and empty string. This const retains that captured value across awaits.
	await page.getByLabel("Caption track").selectOption(frenchTrackId as string);
	await expect(page.getByRole("textbox", { name: "Caption 1" })).toHaveValue(
		"Bonjour: Hello from the edit room."
	);

	await page
		.getByRole("textbox", { name: "Caption 1" })
		.fill("Bonjour tout le monde.");
	const startFields = page.getByRole("spinbutton", { name: "Caption start" });
	const endFields = page.getByRole("spinbutton", { name: "Caption end" });
	await startFields.first().fill("1.5");
	await startFields.first().press("Tab");
	await endFields.first().fill("3");
	await endFields.first().press("Tab");
	await page.getByRole("button", { name: "Add caption", exact: true }).click();
	await expect(page.getByLabel("Caption 2")).toHaveValue("New caption");
	await page.getByLabel("Caption 2").fill("Temporary cue");
	await startFields.nth(1).fill("4");
	await startFields.nth(1).press("Tab");
	await endFields.nth(1).fill("5");
	await endFields.nth(1).press("Tab");
	await expect(startFields.nth(1)).toHaveValue("4");
	await expect(endFields.nth(1)).toHaveValue("5");
	await saveProject(page);
	const withTemporaryCue = await getProject(page, projectId);
	expect(withTemporaryCue.captionTracks[0]?.captions).toHaveLength(2);
	expect(withTemporaryCue.captionTracks[0]?.captions[1]).toMatchObject({
		end: 5,
		start: 4,
		text: "Temporary cue",
	});
	const firstCue = page
		.locator(".studio-scene")
		.filter({ has: page.getByRole("textbox", { name: "Caption 1" }) });
	await firstCue.getByRole("button").first().click();
	await expect(page.locator(".font-mono")).toContainText("0:01.5 /");
	await page
		.getByRole("button", { name: "Remove caption", exact: true })
		.last()
		.click();
	await expect(page.getByLabel("Caption 2")).toHaveCount(0);
	await saveProject(page);
	expect(
		(await getProject(page, projectId)).captionTracks[0]?.captions
	).toHaveLength(1);

	const downloadPromise = page.waitForEvent("download");
	await page
		.getByRole("button", { name: "Download subtitles", exact: true })
		.click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe(`${title}.srt`);
	const downloadPath = await download.path();
	expect(downloadPath).toBeTruthy();
	expect(await readFile(downloadPath, "utf8")).toBe(
		"1\n00:00:01,500 --> 00:00:03,000\nBonjour tout le monde.\n"
	);

	const persisted = await getProject(page, projectId);
	expect(persisted.captionTrackId).toBe(frenchTrackId);
	expect(persisted.captions).toHaveLength(1);
	expect(persisted.captions[0]).toMatchObject({
		end: 2.75,
		start: 1.25,
		text: "Hello from the edit room.",
	});
	expect(persisted.captionTracks).toHaveLength(1);
	expect(persisted.captionTracks[0]).toMatchObject({
		language: "French",
		label: "French",
	});
	expect(persisted.captionTracks[0]?.captions[0]).toMatchObject({
		end: 3,
		start: 1.5,
		text: "Bonjour tout le monde.",
	});
	expect(persisted.captionTracks[0]?.captions).toHaveLength(1);
	const translationCalls = await page.evaluate(
		() => window.__coverageModelCalls ?? []
	);
	const translationCall = translationCalls.find((call) =>
		call.system.includes("Translate the supplied caption text")
	);
	expect(translationCall).toBeDefined();
	const translationInput = z
		.object({
			captions: z.array(z.object({ id: z.string(), text: z.string() })),
			language: z.string(),
		})
		.parse(JSON.parse(translationCall?.prompt ?? "{}"));
	expect(translationInput).toMatchObject({
		captions: [{ text: "Hello from the edit room." }],
		language: "French",
	});
	const projectSave = requests.find(
		(request) =>
			request.path === `/projects/${projectId}` &&
			request.method === "PUT" &&
			Array.isArray(capturedJsonField(request.body, "captionTracks")) &&
			capturedJsonArray(capturedJsonField(request.body, "captionTracks"))
				.length === 1
	);
	expect(projectSave).toBeDefined();
	expect(capturedJsonField(projectSave?.body, "captionTrackId")).toBe(
		frenchTrackId
	);

	await selectProjectAfterReload(page, projectId);
	await openOverflowTab(page, "Captions", "captions");
	// SAFETY: The same captured string|null const passed the original toBeTruthy assertion before any use; its value cannot change across the reload.
	await expect(page.getByLabel("Caption track")).toHaveValue(
		frenchTrackId as string
	);
	await expect(page.getByRole("textbox", { name: "Caption 1" })).toHaveValue(
		"Bonjour tout le monde."
	);
	await saveScreenshot(page, "video-studio-captions-track-overview.png");
	await page.locator(".studio-library").evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await expect(page.getByRole("textbox", { name: "Caption 1" })).toBeVisible();
	await saveScreenshot(page, "video-studio-captions-french-saved.png");
});
