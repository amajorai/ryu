import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import {
	assetRow,
	createProject,
	openOverflowTab,
	readAssets,
	readProject,
	recordStudioRequests,
	saveProject,
	saveScreenshot,
	seedAsset,
	selectProject,
	uniqueTitle,
} from "./video-studio-remaining-panels-proof.helpers.ts";

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
		// The source preview names its still by frame and position.
		name: `Frame of ${still.name} at 0:00.0`,
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
				// ColorScopes asks for the full-detail scopes of the first frame.
				new URLSearchParams(request.query).get("time") === "0"
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
	await cameraAngle(page, cameraA.name).click();
	await cameraAngle(page, cameraB.name).click();
	await page.getByLabel("Multicam program audio").selectOption(cameraC.id);
	await page.getByLabel("Multicam session name").fill("Panel interview A");
	await page.getByRole("button", { name: "Create multicam session" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Multicam session created with a program-audio track."
	);
	await cameraAngle(page, cameraA.name).click();
	await cameraAngle(page, cameraC.name).click();
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
	// NumberField clamps an out-of-range playhead to the timeline end
	// instead of reverting it.
	const timelineEnd = Number(await playhead.getAttribute("aria-valuemax"));
	expect(timelineEnd).toBeGreaterThan(stoppedTime);
	await playhead.fill("999");
	await playhead.press("Tab");
	await expect
		.poll(async () => Number(await playhead.inputValue()))
		.toBeCloseTo(timelineEnd, 2);
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

// After a session exists, the "More microphones" field lists the same camera
// files as buttons, so pick angles inside the "Camera angles" field.
function cameraAngle(page: Page, name: string) {
	return page
		.getByText("Camera angles", { exact: true })
		.locator("..")
		.getByRole("button", { name, exact: true });
}
