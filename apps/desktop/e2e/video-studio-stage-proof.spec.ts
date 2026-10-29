import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { projectSchema } from "../../../apps-store/video-studio/shared/project.ts";
import {
	capturedJsonArray,
	capturedJsonField,
} from "./captured-json-observations.ts";

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

async function projectTitleField(page: Page) {
	return page
		.locator(".studio-inspector .ryu-app-field")
		.first()
		.locator("input");
}

async function createProject(page: Page, title: string) {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByRole("button", { name: "New project" }).click();
	await expect(page.getByRole("status")).toContainText("Project created.");
	const titleField = await projectTitleField(page);
	await expect(titleField).toBeVisible();
	await titleField.fill(title);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
}

async function openOverflowTab(page: Page, label: string, value: string) {
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page.getByRole("combobox", { name: "Search tabs" }).fill(label);
	const tabItem = page.locator(`[data-tabs-menu-key="string:${value}"]`);
	await expect(tabItem).toBeVisible();
	await tabItem.click();
}

async function selectBlockColor(page: Page, hex: string) {
	await page
		.getByRole("button", { name: "3D block 1 color", exact: true })
		.click();
	const input = page.getByRole("textbox", { name: "Hex color value" }).last();
	await expect(input).toBeVisible();
	await input.fill(hex);
	await expect(input).toHaveValue(hex.toUpperCase());
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: "3D block 1 color", exact: true })
	).toContainText(hex.toUpperCase());
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

test("Stage panel generates a local world, edits a block, and removes only the added block", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const title = uniqueTitle("Coverage local stage world");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	const playhead = page.getByRole("spinbutton", { name: "Playhead" });
	await playhead.fill("0.5");
	await playhead.press("Tab");
	await openOverflowTab(page, "3D stage", "stage");

	const worldDirection = page.getByLabel("3D world direction");
	await worldDirection.fill(
		"A coastal lighthouse above a winding river at dusk"
	);
	const generateWorldButton = page.getByRole("button", {
		name: "Generate local world",
		exact: true,
	});
	await generateWorldButton.click();
	await expect(
		page.getByText(
			"Generated 8 editable blocks with a 12-second camera path.",
			{ exact: true }
		)
	).toBeVisible();
	await playhead.fill("1");
	await playhead.press("Tab");
	await expect(
		page.getByRole("button", { name: "Remove 3D block" })
	).toHaveCount(8);
	await expect(
		page.locator(".studio-preview-frame .studio-stage-object")
	).toHaveCount(8);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const worldSave = [...requests]
		.reverse()
		.find(
			(request) =>
				request.path === `/projects/${projectId}` && request.method === "PUT"
		);
	const savedWorld = projectSchema.parse(worldSave?.body);
	expect(savedWorld.stageWorldPrompt).toBe(
		"A coastal lighthouse above a winding river at dusk"
	);
	expect(savedWorld.spatialObjects).toHaveLength(8);
	expect(savedWorld.stageCamera.keyframes).toHaveLength(15);
	const generatedObjectIds = savedWorld.spatialObjects.map(
		(object) => object.id
	);
	await saveScreenshot(page, "video-studio-stage-generated-world.png");

	await page.getByRole("button", { name: "Add 3D block", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Remove 3D block" })
	).toHaveCount(9);
	await expect(page.getByText("3D block 9", { exact: true })).toBeVisible();
	const width = page.getByLabel("3D block 1 Width");
	await width.fill("1.2");
	await width.press("Tab");
	await expect(width).toHaveValue("1");
	await width.fill("0.82");
	await width.press("Tab");
	await expect(width).toHaveValue("0.82");
	await selectBlockColor(page, "#E74795");
	const motion = page.getByLabel("3D block 1 camera motion");
	await motion.selectOption("orbit-right");
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const withManualBlock = [...requests]
		.reverse()
		.find(
			(request) =>
				request.path === `/projects/${projectId}` && request.method === "PUT"
		);
	const withManualBlockProject = projectSchema.parse(withManualBlock?.body);
	expect(withManualBlockProject.spatialObjects).toHaveLength(9);
	expect(withManualBlockProject.spatialObjects[0]).toMatchObject({
		animation: "orbit-right",
		fill: "#E74795",
		height: 0.24,
		width: 0.82,
	});

	await page
		.getByRole("button", { name: "Remove 3D block", exact: true })
		.last()
		.click();
	await expect(
		page.getByRole("button", { name: "Remove 3D block" })
	).toHaveCount(8);
	await expect(page.getByText("3D block 9", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const afterRemoval = [...requests]
		.reverse()
		.find(
			(request) =>
				request.path === `/projects/${projectId}` && request.method === "PUT"
		);
	expect(
		capturedJsonArray(
			capturedJsonField(afterRemoval?.body, "spatialObjects")
		).map((object) => capturedJsonField(object, "id"))
	).toEqual(generatedObjectIds);

	await page.reload();
	await page.getByLabel("Project").selectOption({ label: title });
	await openOverflowTab(page, "3D stage", "stage");
	await playhead.fill("1");
	await playhead.press("Tab");
	await expect(worldDirection).toHaveValue(
		"A coastal lighthouse above a winding river at dusk"
	);
	await expect(
		page.getByRole("button", { name: "Remove 3D block" })
	).toHaveCount(8);
	await expect(width).toHaveValue("0.82");
	await expect(motion).toHaveValue("orbit-right");
	await expect(
		page.locator(".studio-preview-frame .studio-stage-object")
	).toHaveCount(8);
	await page.getByLabel("3D block 1 color").scrollIntoViewIfNeeded();
	await saveScreenshot(page, "video-studio-stage-world-blocks-persisted.png");
});

test("Stage camera bounds, keyframe path, and rendered position persist after reload", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const title = uniqueTitle("Coverage stage camera path");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	const playhead = page.getByRole("spinbutton", { name: "Playhead" });
	await playhead.fill("0.5");
	await playhead.press("Tab");
	await openOverflowTab(page, "3D stage", "stage");
	await page.getByRole("button", { name: "Add 3D block", exact: true }).click();
	await expect(
		page.locator(".studio-preview-frame .studio-stage-object")
	).toHaveCount(1);

	const cameraZoom = page.getByLabel("Stage camera Zoom");
	await cameraZoom.fill("2.5");
	await cameraZoom.press("Tab");
	await expect(cameraZoom).toHaveValue("1");
	await cameraZoom.fill("1.25");
	await cameraZoom.press("Tab");
	await expect(cameraZoom).toHaveValue("1.25");
	const cameraX = page.getByLabel("Stage camera Camera X");
	await cameraX.fill("1.2");
	await cameraX.press("Tab");
	await expect(cameraX).toHaveValue("0");
	await cameraX.fill("0.25");
	await cameraX.press("Tab");
	await expect(cameraX).toHaveValue("0.25");

	const pathTime = page.getByLabel("Stage camera path time");
	const pathProperty = page.getByLabel("Stage camera path property");
	const pathValue = page.getByLabel("Stage camera path value");
	await pathTime.fill("0.5");
	await pathProperty.selectOption("orbit");
	await pathValue.fill("-0.4");
	await page
		.getByRole("button", { name: "Add camera keyframe", exact: true })
		.click();
	await expect(
		page.getByText("1 camera keyframe saved", { exact: true })
	).toBeVisible();
	await pathTime.fill("2.5");
	await pathValue.fill("0.45");
	await page
		.getByRole("button", { name: "Add camera keyframe", exact: true })
		.click();
	await expect(
		page.getByText("2 camera keyframes saved", { exact: true })
	).toBeVisible();

	const stageObject = page
		.locator(".studio-preview-frame .studio-stage-object")
		.first();
	await playhead.fill("1");
	await playhead.press("Tab");
	const earlyPosition = await stageObject.evaluate(
		(element) => getComputedStyle(element).left
	);
	await playhead.fill("2.5");
	await playhead.press("Tab");
	const laterPosition = await stageObject.evaluate(
		(element) => getComputedStyle(element).left
	);
	expect(laterPosition).not.toBe(earlyPosition);

	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const save = [...requests]
		.reverse()
		.find(
			(request) =>
				request.path === `/projects/${projectId}` && request.method === "PUT"
		);
	const savedProject = projectSchema.parse(save?.body);
	expect(savedProject.stageCamera).toMatchObject({ x: 0.25, zoom: 1.25 });
	expect(savedProject.stageCamera.keyframes).toEqual([
		expect.objectContaining({ property: "orbit", time: 0.5, value: -0.4 }),
		expect.objectContaining({ property: "orbit", time: 2.5, value: 0.45 }),
	]);
	expect(savedProject.spatialObjects).toHaveLength(1);

	await page.reload();
	await page.getByLabel("Project").selectOption({ label: title });
	await openOverflowTab(page, "3D stage", "stage");
	await expect(page.getByLabel("Stage camera Camera X")).toHaveValue("0.25");
	await expect(page.getByLabel("Stage camera Zoom")).toHaveValue("1.25");
	await expect(
		page.getByText("2 camera keyframes saved", { exact: true })
	).toBeVisible();
	const reloadedPlayhead = page.getByRole("spinbutton", { name: "Playhead" });
	await reloadedPlayhead.fill("1");
	await reloadedPlayhead.press("Tab");
	const reloadedStageObject = page
		.locator(".studio-preview-frame .studio-stage-object")
		.first();
	const reloadedEarlyPosition = await reloadedStageObject.evaluate(
		(element) => getComputedStyle(element).left
	);
	await reloadedPlayhead.fill("2.5");
	await reloadedPlayhead.press("Tab");
	const reloadedLaterPosition = await reloadedStageObject.evaluate(
		(element) => getComputedStyle(element).left
	);
	expect(reloadedLaterPosition).not.toBe(reloadedEarlyPosition);
	await pathTime.fill("2.5");
	await pathProperty.selectOption("orbit");
	await pathValue.fill("0.45");
	await page
		.getByRole("button", { name: "Add camera keyframe", exact: true })
		.scrollIntoViewIfNeeded();
	await saveScreenshot(page, "video-studio-stage-camera-path-keyframes.png");
});
