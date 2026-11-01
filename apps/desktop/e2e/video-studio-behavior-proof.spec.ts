import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { projectSchema } from "../../../apps-store/video-studio/shared/project.ts";
import {
	capturedJsonArray,
	capturedJsonField,
} from "./captured-json-observations.ts";
import {
	assertPreviewPixels,
	createProject,
	createSyntheticVideo,
	downloadProjectJson,
	evidenceDir,
	importImage,
	importVideo,
	openOverflowTab,
	recordStudioRequests,
	uniqueTitle,
} from "./video-studio-behavior-proof.helpers.ts";

test("recipe composition and layout edits reach the sidecar and survive reload", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const title = uniqueTitle("Coverage recipe layout");
	await createProject(page, title);
	const projectId = await page
		.getByLabel("Project", { exact: true })
		.inputValue();
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
	// The audio mixer's "Track N gain/pan" spinbuttons also contain "Track".
	const secondClipTrack = page.getByRole("spinbutton", {
		name: "Track",
		exact: true,
	});
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
	// A first run opens the workspace tour above the panels, which leaves the
	// preview too small to sample; dismiss it before reading pixels.
	await page.getByRole("button", { name: "Skip tour" }).click();
	await assertPreviewPixels(
		page,
		path.join(evidenceDir, "video-studio-recipe-layout-persisted.png")
	);

	await page.reload();
	await page
		.getByLabel("Project", { exact: true })
		.selectOption({ label: title });
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
		const projectId = await page
			.getByLabel("Project", { exact: true })
			.inputValue();
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
		await expectMulticamProgram(page, 1);
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
		await expectMulticamProgram(page, 3);
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
		await page
			.getByLabel("Project", { exact: true })
			.selectOption({ label: title });
		await openOverflowTab(page, "Multicam", "multicam");
		const sessionPicker = page.getByLabel("Multicam session", { exact: true });
		await expect(
			sessionPicker.locator("option", { hasText: "Interview angles" })
		).toHaveCount(1);
		expect(await sessionPicker.inputValue()).not.toBe("");
		await expectMulticamProgram(page, 3);
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
		const projectId = await page
			.getByLabel("Project", { exact: true })
			.inputValue();
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
			// The import status counts the cues it kept (TranscriptPanel).
			"Imported 2 cues with their original timings."
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
		await page
			.getByLabel("Project", { exact: true })
			.selectOption({ label: title });
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

// MulticamPanel lists one program range per line under "Multicam program
// ranges" and states the program-audio track once, instead of a one-line
// "N full-frame angle ranges · program audio on track 2" summary.
async function expectMulticamProgram(page: Page, ranges: number) {
	await expect(
		page
			.getByRole("list", { name: "Multicam program ranges" })
			.getByRole("listitem")
	).toHaveCount(ranges);
	await expect(page.getByText(/^Program audio on track 2\./)).toBeVisible();
}
