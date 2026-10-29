import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
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

interface GraphicRecord {
	animation: string;
	end: number;
	entryDuration: number;
	fill: string;
	height: number;
	id: string;
	opacity: number;
	shape: string;
	start: number;
	stroke: string;
	strokeWidth: number;
	width: number;
	x: number;
	y: number;
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

async function openGraphicsPanel(page: Page) {
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page
		.getByRole("combobox", { name: "Search tabs" })
		.fill("Vector graphics");
	const tab = page.locator('[data-tabs-menu-key="string:graphics"]');
	await expect(tab).toBeVisible();
	await tab.click();
	await expect(
		page.getByRole("heading", { name: "Vector graphics" })
	).toBeVisible();
}

async function setGraphicNumber(page: Page, label: string, value: string) {
	const input = page.getByLabel(label);
	await input.fill(value);
	await input.press("Tab");
	await expect(input).toHaveValue(value);
}

async function setColor(page: Page, triggerName: string, value: string) {
	await page.getByRole("button", { name: triggerName, exact: true }).click();
	const input = page.getByRole("textbox", { name: "Hex color value" }).last();
	await expect(input).toBeVisible();
	await input.fill(value);
	await expect(input).toHaveValue(value.toUpperCase());
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: triggerName, exact: true })
	).toContainText(value.toUpperCase());
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

async function previewRelativeBox(preview: Locator) {
	return preview.evaluate((element) => {
		const frame = element.closest(".studio-preview-frame");
		if (!frame) {
			throw new Error("Preview layer is missing its preview frame.");
		}
		const layerBox = element.getBoundingClientRect();
		const frameBox = frame.getBoundingClientRect();
		return {
			height: layerBox.height / frameBox.height,
			width: layerBox.width / frameBox.width,
		};
	});
}

async function previewTransformRatio(preview: Locator) {
	return preview.evaluate((element) => {
		const transform = getComputedStyle(element).transform;
		const matrix =
			transform === "none"
				? new DOMMatrixReadOnly()
				: new DOMMatrixReadOnly(transform);
		const box = element.getBoundingClientRect();
		return { x: matrix.m41 / box.width, y: matrix.m42 / box.height };
	});
}

async function projectAfterReload(
	page: Page,
	title: string,
	projectId: string
) {
	await page.reload();
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByLabel("Project").selectOption({ label: title });
	const playhead = page.getByRole("spinbutton", { name: "Playhead" });
	await playhead.fill("0.5");
	await playhead.press("Tab");
	const response = await page.request.get(`/__studio/projects/${projectId}`);
	expect(response.ok()).toBe(true);
	// SAFETY: The successful local GET checked above is forwarded unchanged from store.project(), whose native projectSchema parser owns this Project and its declared fields before JSON serialization. Native graphics is its graphicSchema array.
	return (await response.json()) as { graphics: GraphicRecord[] };
}

test("Vector graphics add, validate, edit all treatments, preview, and persist after reload", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const title = uniqueTitle("Coverage vector shape edit");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	const playhead = page.getByRole("spinbutton", { name: "Playhead" });
	await openGraphicsPanel(page);
	const add = page.getByRole("button", {
		name: "Add vector shape",
		exact: true,
	});
	await expect(add).toBeEnabled();
	await playhead.fill("0.5");
	await playhead.press("Tab");
	await expect(add).toBeEnabled();
	await add.click();
	await expect(page.getByText("Vector shape 1", { exact: true })).toBeVisible();
	const preview = page.locator(".studio-preview-frame .studio-graphic");
	await expect(preview).toHaveCount(1);

	const graphicKindControl = page.getByLabel("Vector shape 1 shape");
	await expect(graphicKindControl).toHaveValue("rectangle");
	await graphicKindControl.selectOption("ellipse");
	await expect(preview).toHaveCSS("border-radius", "50%");
	await graphicKindControl.selectOption("triangle");
	await expect(preview).toHaveCSS(
		"clip-path",
		"polygon(50% 0%, 100% 100%, 0% 100%)"
	);
	await graphicKindControl.selectOption("line");
	await expect(preview).toHaveCSS("background-color", "rgb(255, 255, 255)");
	await graphicKindControl.selectOption("triangle");

	await setGraphicNumber(page, "Graphic 1 Start", "0.25");
	await setGraphicNumber(page, "Graphic 1 End", "6");
	const left = page.getByLabel("Graphic 1 Left");
	await left.fill("1.2");
	await left.press("Tab");
	await expect(left).toHaveValue("0.08");
	await setGraphicNumber(page, "Graphic 1 Left", "0.22");
	await setGraphicNumber(page, "Graphic 1 Top", "0.24");
	const width = page.getByLabel("Graphic 1 Width");
	await width.fill("0.01");
	await width.press("Tab");
	await expect(width).toHaveValue("0.42");
	await setGraphicNumber(page, "Graphic 1 Width", "0.55");
	await setGraphicNumber(page, "Graphic 1 Height", "0.33");
	await setGraphicNumber(page, "Graphic 1 Opacity", "0.75");
	await setGraphicNumber(page, "Graphic 1 Entry duration", "0.5");
	const strokeWidth = page.getByLabel("Vector shape 1 stroke width");
	await strokeWidth.fill("0.1");
	await strokeWidth.press("Tab");
	await expect(strokeWidth).toHaveValue("0");
	await setGraphicNumber(page, "Vector shape 1 stroke width", "0.025");
	await setColor(page, "Graphic 1 fill color", "#E74795");
	await setColor(page, "Vector shape 1 stroke color", "#FBBF24");
	await graphicKindControl.selectOption("line");
	await expect(preview).toHaveCSS("background-color", "rgb(251, 191, 36)");
	expect((await previewRelativeBox(preview)).height).toBeCloseTo(0.025, 3);
	await graphicKindControl.selectOption("triangle");

	const animation = page.getByLabel("Graphic 1 entry animation");
	for (const [value, xOffset, yOffset] of [
		["none", 0, 0],
		["slide-up", 0, 0.04],
		["slide-down", 0, -0.04],
		["slide-left", -0.04, 0],
		["slide-right", 0.04, 0],
	] as const) {
		await animation.selectOption(value);
		await expect(animation).toHaveValue(value);
		await expect
			.poll(() =>
				previewTransformRatio(preview).then(
					({ x, y }) =>
						Math.abs(x - xOffset) < 0.001 && Math.abs(y - yOffset) < 0.001
				)
			)
			.toBe(true);
	}
	await expect(preview).toHaveCSS("background-color", "rgb(231, 71, 149)");
	await expect(preview).toHaveCSS("opacity", "0.75");
	await expect(preview).toHaveCSS(
		"clip-path",
		"polygon(50% 0%, 100% 100%, 0% 100%)"
	);
	const graphicBox = await previewRelativeBox(preview);
	expect(graphicBox.width).toBeCloseTo(0.55, 3);
	expect(graphicBox.height).toBeCloseTo(0.33, 3);

	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const save = [...requests]
		.reverse()
		.find(
			(request) =>
				request.path === `/projects/${projectId}` && request.method === "PUT"
		);
	const savedGraphic = capturedJsonArray(
		capturedJsonField(save?.body, "graphics")
	)[0];
	expect(savedGraphic).toMatchObject({
		animation: "slide-right",
		end: 6,
		entryDuration: 0.5,
		fill: "#E74795",
		height: 0.33,
		opacity: 0.75,
		shape: "triangle",
		start: 0.25,
		stroke: "#FBBF24",
		strokeWidth: 0.025,
		width: 0.55,
		x: 0.22,
		y: 0.24,
	});
	const persisted = await projectAfterReload(page, title, projectId);
	expect(persisted.graphics).toEqual([savedGraphic]);
	await openGraphicsPanel(page);
	await expect(page.getByLabel("Vector shape 1 shape")).toHaveValue("triangle");
	await expect(page.getByLabel("Graphic 1 Left")).toHaveValue("0.22");
	await expect(page.getByLabel("Graphic 1 Width")).toHaveValue("0.55");
	await expect(page.getByLabel("Graphic 1 fill color")).toContainText(
		"#E74795"
	);
	await expect(
		page.locator(".studio-preview-frame .studio-graphic")
	).toHaveCount(1);
	await page.locator(".studio-library").evaluate((element) => {
		element.scrollTop = 0;
	});
	await saveScreenshot(page, "video-studio-graphics-edited-after-reload.png");
});

test("Removing a vector graphic preserves its sibling and persists an empty layer list", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const title = uniqueTitle("Coverage vector shape removal");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	const playhead = page.getByRole("spinbutton", { name: "Playhead" });
	await playhead.fill("0.5");
	await playhead.press("Tab");
	await openGraphicsPanel(page);
	const add = page.getByRole("button", {
		name: "Add vector shape",
		exact: true,
	});
	await add.click();
	await add.click();
	await expect(page.getByText("Vector shape 2", { exact: true })).toBeVisible();
	await expect(
		page.locator(".studio-preview-frame .studio-graphic")
	).toHaveCount(2);
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const initialSave = [...requests]
		.reverse()
		.find(
			(request) =>
				request.path === `/projects/${projectId}` && request.method === "PUT"
		);
	const initialGraphics = capturedJsonArray(
		capturedJsonField(initialSave?.body, "graphics")
	);
	expect(initialGraphics).toHaveLength(2);
	const firstId = capturedJsonField(initialGraphics[0], "id");
	const secondId = capturedJsonField(initialGraphics[1], "id");
	expect(firstId).toBeTruthy();
	expect(secondId).toBeTruthy();

	await page.getByRole("button", { name: "Remove graphic" }).last().click();
	await expect(page.getByText("Vector shape 2", { exact: true })).toHaveCount(
		0
	);
	await expect(
		page.locator(".studio-preview-frame .studio-graphic")
	).toHaveCount(1);
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const afterSiblingRemoval = [...requests]
		.reverse()
		.find(
			(request) =>
				request.path === `/projects/${projectId}` && request.method === "PUT"
		);
	expect(
		capturedJsonArray(
			capturedJsonField(afterSiblingRemoval?.body, "graphics")
		).map((graphic) => capturedJsonField(graphic, "id"))
	).toEqual([firstId]);
	const reloaded = await projectAfterReload(page, title, projectId);
	expect(reloaded.graphics.map((graphic) => graphic.id)).toEqual([firstId]);
	await openGraphicsPanel(page);
	await expect(page.getByText("Vector shape 1", { exact: true })).toBeVisible();
	await expect(page.getByText("Vector shape 2", { exact: true })).toHaveCount(
		0
	);
	await expect(
		page.locator(".studio-preview-frame .studio-graphic")
	).toHaveCount(1);
	await page.locator(".studio-library").evaluate((element) => {
		element.scrollTop = 0;
	});
	await saveScreenshot(
		page,
		"video-studio-graphics-delete-preserves-sibling.png"
	);

	await page.getByRole("button", { name: "Remove graphic" }).click();
	await expect(
		page.locator(".studio-preview-frame .studio-graphic")
	).toHaveCount(0);
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const emptySave = [...requests]
		.reverse()
		.find(
			(request) =>
				request.path === `/projects/${projectId}` && request.method === "PUT"
		);
	expect(
		capturedJsonArray(capturedJsonField(emptySave?.body, "graphics"))
	).toEqual([]);
	const finalProject = await projectAfterReload(page, title, projectId);
	expect(finalProject.graphics).toEqual([]);
	await openGraphicsPanel(page);
	await expect(
		page.getByRole("button", { name: "Add vector shape" })
	).toBeEnabled();
	await expect(page.getByText("Vector shape 1", { exact: true })).toHaveCount(
		0
	);
	await expect(
		page.locator(".studio-preview-frame .studio-graphic")
	).toHaveCount(0);
	await saveScreenshot(page, "video-studio-graphics-empty-after-remove.png");
});
