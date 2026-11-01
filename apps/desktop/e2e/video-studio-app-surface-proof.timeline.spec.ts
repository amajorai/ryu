import { expect, test } from "@playwright/test";
import {
	assetRow,
	createProject,
	openOverflowTab,
	readProject,
	readRenderJobs,
	saveProject,
	saveScreenshot,
	seedAsset,
	selectProject,
	uniqueTitle,
} from "./video-studio-app-surface-proof.helpers.ts";

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

	const zoom = page.getByLabel("Timeline zoom", { exact: true });
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
	// The ruler draws its ticks on a canvas (TimelineRuler); a press seeks to
	// the time under the pointer, measured from the ruler's left edge at the
	// 120 px/s zoom chosen above.
	await page
		.locator("[data-timeline-ruler]")
		.click({ position: { x: 3 * 120, y: 20 } });
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
	await page
		.getByRole("button", { name: "Import SRT / VTT", exact: true })
		.click();
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
