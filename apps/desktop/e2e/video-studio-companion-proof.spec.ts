import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

function uniqueTitle(prefix: string) {
	const timestamp = new Date().toISOString().replaceAll(":", "-");
	return `${prefix} ${timestamp} ${crypto.randomUUID().slice(0, 8)}`;
}

async function projectTitleField(page: Page) {
	return page
		.locator(".studio-inspector .ryu-app-field")
		.first()
		.locator("input");
}

async function openOverflowTab(page: Page, label: string, value: string) {
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page.getByRole("combobox", { name: "Search tabs" }).fill(label);
	const tabItem = page.locator(`[data-tabs-menu-key="string:${value}"]`);
	await expect(tabItem).toBeVisible();
	await tabItem.click();
}

async function coverageImage(page: Page): Promise<Buffer> {
	const bytes = await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 640;
		canvas.height = 360;
		const context = canvas.getContext("2d");
		if (!context) {
			throw new Error("Canvas rendering is unavailable in this browser.");
		}

		const gradient = context.createLinearGradient(0, 0, 640, 360);
		gradient.addColorStop(0, "#101d35");
		gradient.addColorStop(1, "#075985");
		context.fillStyle = gradient;
		context.fillRect(0, 0, 640, 360);
		context.fillStyle = "#f59e0b";
		context.beginPath();
		context.arc(510, 174, 66, 0, Math.PI * 2);
		context.fill();
		context.fillStyle = "#f8fafc";
		context.font = "600 34px sans-serif";
		context.fillText("RYU VIDEO STUDIO", 36, 150);
		context.font = "20px sans-serif";
		context.fillText("Real sidecar export regression", 38, 190);

		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((result) => {
				if (result) {
					resolve(result);
				} else {
					reject(new Error("Canvas could not create the PNG fixture."));
				}
			}, "image/png");
		});
		return Array.from(new Uint8Array(await blob.arrayBuffer()));
	});
	return Buffer.from(bytes);
}

async function extractRgbFrame(videoPath: string): Promise<Buffer> {
	return await new Promise((resolve, reject) => {
		const child = spawn("ffmpeg", [
			"-v",
			"error",
			"-ss",
			"1",
			"-i",
			videoPath,
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgb24",
			"pipe:1",
		]);
		const chunks: Buffer[] = [];
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-2000);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks));
			} else {
				reject(new Error(stderr || `Frame extraction exited with ${code}.`));
			}
		});
	});
}

async function downloadArtifact(page: Page, buttonName: string) {
	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: buttonName }).click();
	const download = await downloadPromise;
	const outputPath = await download.path();
	if (!outputPath) {
		throw new Error(
			`The ${buttonName} download was not preserved by Playwright.`
		);
	}
	return { download, outputPath };
}

async function createProject(page: Page, title: string) {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByRole("button", { name: "New project" }).click();
	await expect(page.getByRole("status")).toContainText("Project created.");
	await expect(page.locator(".studio-workspace")).not.toHaveAttribute(
		"inert",
		""
	);
	await expect(
		page.getByRole("button", { name: "Export video" })
	).toBeDisabled();
	const titleField = await projectTitleField(page);
	await expect(titleField).toBeVisible();
	await titleField.fill(title);
	await expect(titleField).toHaveValue(title);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	return titleField;
}

test("project edits, output format, duplicate isolation, and reload persistence work", async ({
	page,
}) => {
	const originalTitle = uniqueTitle("Coverage film");
	await createProject(page, originalTitle);
	await page.getByLabel("Output format").selectOption("1080x1920");
	await expect(
		page.getByRole("button", { name: "Save changes" })
	).toBeEnabled();
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	await expect(page.locator(".studio-stage-heading")).toContainText(
		"1080 × 1920"
	);
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "video-studio-project-edit-saved.png"),
	});

	await page.reload();
	const projectPicker = page.getByLabel("Project");
	await expect(
		projectPicker.locator("option", { hasText: originalTitle })
	).toHaveCount(1);
	await projectPicker.selectOption({ label: originalTitle });
	await expect(await projectTitleField(page)).toHaveValue(originalTitle);
	await expect(page.getByLabel("Output format")).toHaveValue("1080x1920");

	await page.getByRole("button", { name: "Duplicate project" }).click();
	await expect(page.getByRole("status")).toContainText("Project duplicated.");
	const duplicateTitle = `${originalTitle} copy`;
	await expect(
		projectPicker.locator("option", { hasText: duplicateTitle })
	).toHaveCount(1);
	await expect(await projectTitleField(page)).toHaveValue(duplicateTitle);
	await (await projectTitleField(page)).fill(`${duplicateTitle} edited`);
	await page.getByLabel("Output format").selectOption("1080x1080");
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");

	await page.reload();
	const reloadedPicker = page.getByLabel("Project");
	await reloadedPicker.selectOption({ label: originalTitle });
	await expect(await projectTitleField(page)).toHaveValue(originalTitle);
	await expect(page.getByLabel("Output format")).toHaveValue("1080x1920");
	await reloadedPicker.selectOption({ label: `${duplicateTitle} edited` });
	await expect(await projectTitleField(page)).toHaveValue(
		`${duplicateTitle} edited`
	);
	await expect(page.getByLabel("Output format")).toHaveValue("1080x1080");
	await page.screenshot({
		fullPage: true,
		path: path.join(
			evidenceDir,
			"video-studio-duplicate-isolated-after-reload.png"
		),
	});
});

test("a saved still-media timeline renders, passes media review, and downloads a valid MP4", async ({
	page,
}) => {
	test.setTimeout(180_000);
	const title = uniqueTitle("Coverage export");
	await createProject(page, title);
	await page.getByLabel("Output format").selectOption("640x360");
	await page.getByLabel("Frame rate").selectOption("24");
	const fileChooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import media" }).click();
	const fileChooser = await fileChooserPromise;
	await fileChooser.setFiles({
		name: "coverage-still.png",
		mimeType: "image/png",
		buffer: await coverageImage(page),
	});
	await expect(page.getByRole("status")).toContainText(
		"Media imported. Add it to the timeline from the library."
	);
	await expect(
		page.getByRole("button", { name: "Export video" })
	).toBeDisabled();
	await page
		.getByRole("button", { name: "Add coverage-still.png to timeline" })
		.click();
	await expect(
		page.getByRole("button", { name: "Export video" })
	).toBeEnabled();
	await page.getByRole("button", { name: "Export video" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Rendering the saved timeline",
		{ timeout: 10_000 }
	);
	await expect(
		page.getByRole("heading", { name: "Export history" })
	).toBeVisible();
	await expect(page.getByRole("status")).toContainText(
		"Export completed. Your video is ready to download.",
		{ timeout: 180_000 }
	);
	await expect(page.getByText(/640 × 360 · 24 fps · 0:05\.0/)).toBeVisible();
	await expect(page.getByText(/Delivery review · Passed/)).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "video-studio-export-completed-review.png"),
	});

	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download MP4" }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe(`${title}.mp4`);
	const outputPath = await download.path();
	expect(outputPath).not.toBeNull();
	if (!outputPath) {
		throw new Error("Playwright did not preserve the completed MP4 download.");
	}
	const [metadata, bytes] = await Promise.all([
		stat(outputPath),
		readFile(outputPath),
	]);
	expect(metadata.size).toBeGreaterThan(1000);
	expect(bytes.toString("ascii", 4, 8)).toBe("ftyp");
	const frame = await extractRgbFrame(outputPath);
	expect(frame).toHaveLength(640 * 360 * 3);
	const sampledColors = new Set<string>();
	for (let y = 24; y < 360; y += 32) {
		for (let x = 24; x < 640; x += 32) {
			const offset = (y * 640 + x) * 3;
			sampledColors.add(
				`${frame[offset]},${frame[offset + 1]},${frame[offset + 2]}`
			);
		}
	}
	expect(sampledColors.size).toBeGreaterThan(8);
	await expect(page.getByRole("status")).toContainText(
		"Rendered video downloaded."
	);
});

test("title cards, lower thirds, styling and removal persist through the real project API", async ({
	page,
}) => {
	const projectTitle = uniqueTitle("Coverage titles");
	await createProject(page, projectTitle);
	await openOverflowTab(page, "Titles", "titles");
	await page.getByRole("button", { name: "Add title" }).click();
	await page.getByRole("button", { name: "Add lower third" }).click();
	await page
		.getByRole("textbox", { name: "Title 1 text" })
		.fill("Regression title card");
	await page
		.getByRole("textbox", { name: "Title 2 text" })
		.fill("Ryu Studio · Editor");

	const titleFieldValues = [
		["Start", "0.5"],
		["End", "4"],
		["Horizontal position", "0.4"],
		["Vertical position", "0.6"],
		["Text size", "0.12"],
		["Fade in", "0.35"],
		["Fade out", "0.45"],
	] as const;
	for (const [label, value] of titleFieldValues) {
		const field = page.getByRole("spinbutton", {
			name: `Title 1 ${label}`,
		});
		await field.fill(value);
		await field.press("Tab");
		await expect(field).toHaveValue(value);
	}
	await page.getByLabel("Title 1 entry animation").selectOption("slide-up");
	await page.getByRole("button", { name: "Title 1 color" }).click();
	await page.getByRole("textbox", { name: "Hex color value" }).fill("#1d4ed8");
	await expect(
		page.getByRole("button", { name: "Title 1 color" })
	).toContainText("#1D4ED8");
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	await expect(
		page.getByRole("button", { name: "Export video" })
	).toBeEnabled();

	await page.reload();
	const projectPicker = page.getByLabel("Project");
	await projectPicker.selectOption({ label: projectTitle });
	await openOverflowTab(page, "Titles", "titles");
	await expect(page.getByRole("textbox", { name: "Title 1 text" })).toHaveValue(
		"Regression title card"
	);
	await expect(page.getByRole("textbox", { name: "Title 2 text" })).toHaveValue(
		"Ryu Studio · Editor"
	);
	for (const [label, value] of titleFieldValues) {
		await expect(
			page.getByRole("spinbutton", { name: `Title 1 ${label}` })
		).toHaveValue(value);
	}
	await expect(page.getByLabel("Title 1 entry animation")).toHaveValue(
		"slide-up"
	);
	await expect(
		page.getByRole("button", { name: "Title 1 color" })
	).toContainText("#1D4ED8");
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "video-studio-title-edit-persisted.png"),
	});

	await page.getByRole("button", { name: "Remove title" }).last().click();
	await expect(page.getByRole("textbox", { name: "Title 2 text" })).toHaveCount(
		0
	);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	await page.reload();
	await page.getByLabel("Project").selectOption({ label: projectTitle });
	await openOverflowTab(page, "Titles", "titles");
	await expect(page.getByRole("textbox", { name: "Title 1 text" })).toHaveValue(
		"Regression title card"
	);
	await expect(page.getByRole("textbox", { name: "Title 2 text" })).toHaveCount(
		0
	);
});

test("codec settings, project and interchange downloads, and package import round-trip", async ({
	page,
}) => {
	const title = uniqueTitle("Coverage formats");
	await createProject(page, title);
	await page.getByLabel("Output format").selectOption("1080x1920");
	await page.getByLabel("Frame rate").selectOption("25");
	await page.getByLabel("Video codec").selectOption("h265");
	await page.getByLabel("Export preset").selectOption("review");
	await page.getByLabel("Visual style").selectOption("cinematic");
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const projectPicker = page.getByLabel("Project");
	const sourceId = await projectPicker.inputValue();

	await page.reload();
	await projectPicker.selectOption({ label: title });
	await expect(page.getByLabel("Output format")).toHaveValue("1080x1920");
	await expect(page.getByLabel("Frame rate")).toHaveValue("25");
	await expect(page.getByLabel("Video codec")).toHaveValue("h265");
	await expect(page.getByLabel("Export preset")).toHaveValue("review");
	await expect(page.getByLabel("Visual style")).toHaveValue("cinematic");
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "video-studio-export-settings-persisted.png"),
	});

	const projectJson = await downloadArtifact(page, "Download project JSON");
	expect(projectJson.download.suggestedFilename()).toBe(`${title}.json`);
	// SAFETY: This controlled project JSON download is the native App export of the reloaded projectSchema-parsed project; its authored codec/preset/title strings are preserved by JSON.stringify and Playwright captures that same file.
	const projectData = JSON.parse(
		await readFile(projectJson.outputPath, "utf8")
	) as { exportCodec?: string; exportPreset?: string; title?: string };
	expect(projectData).toMatchObject({
		exportCodec: "h265",
		exportPreset: "review",
		title,
	});

	const fcpxml = await downloadArtifact(page, "Download FCPXML");
	expect(fcpxml.download.suggestedFilename()).toMatch(/\.fcpxml$/);
	const fcpxmlText = await readFile(fcpxml.outputPath, "utf8");
	expect(fcpxmlText).toContain("<fcpxml");
	expect(fcpxmlText).toContain(title);
	const premiereXml = await downloadArtifact(page, "Download Premiere XML");
	expect(premiereXml.download.suggestedFilename()).toMatch(/\.xml$/);
	expect(await readFile(premiereXml.outputPath, "utf8")).toContain("<xmeml");

	const productionPackage = await downloadArtifact(
		page,
		"Download production package"
	);
	expect(productionPackage.download.suggestedFilename()).toBe(
		`${title}.ryu-video-package.json`
	);
	// SAFETY: The native server projectPackage builder parses its result with projectPackageSchema before the GET JSON response; App forwards that result to this download, preserving the builder-owned format string, assets array and nested project fields.
	const packageData = JSON.parse(
		await readFile(productionPackage.outputPath, "utf8")
	) as {
		assets?: unknown[];
		format?: string;
		project?: { exportCodec?: string; id?: string; title?: string };
	};
	expect(packageData.format).toBe("ryu.video-studio.package.v1");
	expect(packageData.assets).toEqual([]);
	expect(packageData.project).toMatchObject({
		exportCodec: "h265",
		id: sourceId,
		title,
	});

	const fileChooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import production package" }).click();
	await (await fileChooserPromise).setFiles(productionPackage.outputPath);
	await expect(page.getByRole("status")).toContainText(
		"Production package imported as a new project."
	);
	const importedId = await projectPicker.inputValue();
	expect(importedId).not.toBe(sourceId);
	await expect(projectPicker.locator("option", { hasText: title })).toHaveCount(
		2
	);
	await expect(page.getByLabel("Video codec")).toHaveValue("h265");
});

test("track audio/lock state, markers, undo/redo and marker seeking persist", async ({
	page,
}) => {
	const title = uniqueTitle("Coverage timeline");
	await createProject(page, title);
	await page.getByLabel("Output format").selectOption("640x360");
	const fileChooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import media" }).click();
	await (await fileChooserPromise).setFiles({
		name: "timeline-still.png",
		mimeType: "image/png",
		buffer: await coverageImage(page),
	});
	await expect(page.getByRole("status")).toContainText("Media imported.");
	await page
		.getByRole("button", { name: "Add timeline-still.png to timeline" })
		.click();

	const trackName = page.getByRole("textbox", { name: "Track 1 name" });
	await trackName.fill("Main video");
	await trackName.press("Tab");
	await page.getByRole("button", { name: "Mute Main video" }).click();
	await page.getByRole("button", { name: "Solo Main video" }).click();
	await page.getByRole("button", { name: "Lock Main video" }).click();
	await expect(
		page.locator('.studio-track[data-muted="true"][data-locked="true"]')
	).toHaveCount(1);
	await expect(
		page.getByRole("button", { name: "Unmute Main video" })
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("button", { name: "Unsolo Main video" })
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("button", { name: "Unlock Main video" })
	).toHaveAttribute("aria-pressed", "true");

	const playhead = page.getByRole("spinbutton", { name: "Playhead" });
	await playhead.fill("1.5");
	await playhead.press("Tab");
	await page.getByRole("textbox", { name: "Marker label" }).fill("Editor note");
	await page.getByRole("button", { name: "Marker color" }).click();
	await page.getByRole("textbox", { name: "Hex color value" }).fill("#dc2626");
	await page.getByRole("button", { name: "Add marker" }).click();
	await expect(page.getByText("1 timeline marker")).toBeVisible();
	await page.getByRole("button", { name: "Undo" }).click();
	await expect(page.getByText("1 timeline marker")).toHaveCount(0);
	await page.getByRole("button", { name: "Redo" }).click();
	await page.getByText("1 timeline marker").click();
	await expect(page.locator(".studio-marker-swatch")).toHaveCSS(
		"background-color",
		"rgb(220, 38, 38)"
	);
	await playhead.fill("3");
	await playhead.press("Tab");
	await page.getByText("Editor note · 0:01.5", { exact: true }).click();
	await expect(playhead).toHaveValue("1.5");
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");

	await page.reload();
	const projectPicker = page.getByLabel("Project");
	await projectPicker.selectOption({ label: title });
	await expect(page.getByRole("textbox", { name: "Track 1 name" })).toHaveValue(
		"Main video"
	);
	await expect(
		page.locator('.studio-track[data-muted="true"][data-locked="true"]')
	).toHaveCount(1);
	await expect(
		page.getByRole("button", { name: "Unmute Main video" })
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("button", { name: "Unsolo Main video" })
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("button", { name: "Unlock Main video" })
	).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByText("1 timeline marker")).toBeVisible();
	await page.getByText("1 timeline marker").click();
	await expect(page.locator(".studio-marker-swatch")).toHaveCSS(
		"background-color",
		"rgb(220, 38, 38)"
	);
	await page.screenshot({
		fullPage: true,
		path: path.join(
			evidenceDir,
			"video-studio-markers-and-track-persisted.png"
		),
	});

	await page.getByRole("button", { name: "Remove marker Editor note" }).click();
	await expect(page.getByText("1 timeline marker")).toHaveCount(0);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	await page.reload();
	await page.getByLabel("Project").selectOption({ label: title });
	await expect(page.getByText("1 timeline marker")).toHaveCount(0);
});

test("capture frame, clip split/duplicate/delete and ripple range edits persist", async ({
	page,
}) => {
	const title = uniqueTitle("Coverage edit");
	await createProject(page, title);
	await page.getByLabel("Output format").selectOption("640x360");
	const fileChooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import media" }).click();
	await (await fileChooserPromise).setFiles({
		name: "edit-still.png",
		mimeType: "image/png",
		buffer: await coverageImage(page),
	});
	await expect(page.getByRole("status")).toContainText("Media imported.");
	await page
		.getByRole("button", { name: "Add edit-still.png to timeline" })
		.click();

	const playhead = page.getByRole("spinbutton", { name: "Playhead" });
	await playhead.fill("1.5");
	await playhead.press("Tab");
	await page.getByRole("button", { name: "Capture frame" }).click();
	await expect(page.getByRole("status")).toContainText(
		"Captured a PNG frame at 0:01.5 and added it to the library.",
		{ timeout: 30_000 }
	);
	await expect(
		page.getByText(`${title} frame 0:01.5`, { exact: true })
	).toBeVisible();

	await page.getByRole("button", { name: "Split at playhead" }).click();
	const clips = page.locator(".studio-timeline-clip");
	await expect(clips).toHaveCount(2);
	await expect(
		page.getByRole("button", { name: "Select edit-still.png at 1.50 seconds" })
	).toBeVisible();
	await page.getByRole("button", { name: "Duplicate", exact: true }).click();
	await expect(clips).toHaveCount(3);
	await page.getByRole("button", { name: "Delete clip", exact: true }).click();
	await expect(clips).toHaveCount(2);

	const rangeStart = page.getByRole("spinbutton", { name: "Range start" });
	const rangeEnd = page.getByRole("spinbutton", { name: "Range end" });
	await rangeStart.fill("1");
	await rangeStart.press("Tab");
	await rangeEnd.fill("2");
	await rangeEnd.press("Tab");
	await page.getByRole("button", { name: "Ripple delete range" }).click();
	await expect(page.getByText(/0:01\.5 \/ 0:04\.0/)).toBeVisible();
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");

	await page.reload();
	await page.getByLabel("Project").selectOption({ label: title });
	await expect(clips).toHaveCount(2);
	await expect(page.getByText(/0:00\.0 \/ 0:04\.0/)).toBeVisible();
	await expect(
		page.getByText(`${title} frame 0:01.5`, { exact: true })
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "video-studio-timeline-edits-persisted.png"),
	});
});
