import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	assetRow,
	createProject,
	evidenceDir,
	fillNumber,
	openOverflowTab,
	readAnalysis,
	readAssets,
	readGenerationJobs,
	readProject,
	recordStudioRequests,
	saveProject,
	saveScreenshot,
	seedAsset,
	selectProject,
	uniqueTitle,
} from "./video-studio-app-surface-proof.helpers.ts";

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
