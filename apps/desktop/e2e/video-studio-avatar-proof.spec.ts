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

async function selectColor(page: Page, controlLabel: string, hex: string) {
	await page.getByRole("button", { name: controlLabel, exact: true }).click();
	const hexInput = page
		.getByRole("textbox", { name: "Hex color value" })
		.last();
	await expect(hexInput).toBeVisible();
	await hexInput.fill(hex);
	await expect(hexInput).toHaveValue(hex.toUpperCase());
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: controlLabel, exact: true })
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

test("Avatar panel edits render, rig, persist, and remove avatars from the project", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const requests = recordStudioRequests(page);
	const title = uniqueTitle("Coverage avatar stage");
	await createProject(page, title);
	const projectId = await page.getByLabel("Project").inputValue();
	await openOverflowTab(page, "Avatars", "avatars");

	await page.getByRole("button", { name: "Add 2.5D avatar" }).click();
	await expect(page.getByText("Avatar 1", { exact: true })).toBeVisible();
	const playhead = page.getByRole("spinbutton", { name: "Playhead" });
	await playhead.fill("1.25");
	await playhead.press("Tab");
	const previewAvatar = page.locator(
		".studio-preview-frame [aria-label='2.5D avatar']"
	);
	await expect(previewAvatar).toBeVisible();

	const width = page.getByLabel("Avatar 1 Width");
	await width.fill("1.2");
	await width.press("Tab");
	await expect(width).toHaveValue("0.28");
	await width.fill("0.36");
	await width.press("Tab");
	await expect(width).toHaveValue("0.36");
	await selectColor(page, "Avatar 1 skin color", "#00B26D");
	await selectColor(page, "Avatar 1 outfit color", "#7C3AED");
	await selectColor(page, "Avatar 1 accent color", "#FF4F87");

	const pose = page.getByLabel("Avatar 1 pose");
	await pose.selectOption("wave");
	const motion = page.getByLabel("Avatar 1 motion");
	await motion.selectOption("slide-right");
	const rigProperty = page.getByLabel("Avatar 1 rig keyframe property");
	await rigProperty.selectOption("rightArm");
	const rigValue = page.getByLabel("Avatar 1 rig keyframe value");
	await rigValue.fill("35");
	await expect(rigProperty).toHaveValue("rightArm");
	await expect(rigValue).toHaveValue("35");
	await page
		.getByRole("button", { name: "Add rig keyframe at playhead" })
		.click();
	await expect(
		page.getByText("1 rig keyframe saved", { exact: true })
	).toBeVisible();
	await expect(
		previewAvatar.locator(".studio-avatar-arm-right")
	).toHaveAttribute("style", /rotate\(35deg\)/);

	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const firstSave = [...requests]
		.reverse()
		.find(
			(request) =>
				request.path === `/projects/${projectId}` && request.method === "PUT"
		);
	const savedProject = projectSchema.parse(firstSave?.body);
	expect(savedProject.avatars).toHaveLength(1);
	const savedAvatar = savedProject.avatars[0];
	expect(savedAvatar).toMatchObject({
		accent: "#FF4F87",
		animation: "slide-right",
		outfit: "#7C3AED",
		pose: "wave",
		rigKeyframes: [
			expect.objectContaining({ property: "rightArm", time: 1.25, value: 35 }),
		],
		skin: "#00B26D",
		width: 0.36,
	});

	await page.reload();
	await page.getByLabel("Project").selectOption({ label: title });
	await openOverflowTab(page, "Avatars", "avatars");
	await expect(page.getByLabel("Avatar 1 Width")).toHaveValue("0.36");
	await expect(page.getByLabel("Avatar 1 pose")).toHaveValue("wave");
	await expect(page.getByLabel("Avatar 1 motion")).toHaveValue("slide-right");
	await expect(
		page.getByRole("button", { name: "Avatar 1 skin color", exact: true })
	).toContainText("#00B26D");
	await expect(
		page.getByRole("button", { name: "Avatar 1 outfit color", exact: true })
	).toContainText("#7C3AED");
	await expect(
		page.getByRole("button", { name: "Avatar 1 accent color", exact: true })
	).toContainText("#FF4F87");
	await expect(
		page.getByText("1 rig keyframe saved", { exact: true })
	).toBeVisible();
	await playhead.fill("1.25");
	await playhead.press("Tab");
	await expect(
		page.locator(".studio-preview-frame [aria-label='2.5D avatar']")
	).toBeVisible();

	await page.getByRole("button", { name: "Add 2.5D avatar" }).click();
	await expect(page.getByText("Avatar 2", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Remove avatar" })).toHaveCount(
		2
	);
	await page.getByRole("button", { name: "Remove avatar" }).nth(1).click();
	await expect(page.getByRole("button", { name: "Remove avatar" })).toHaveCount(
		1
	);
	await expect(page.getByText("Avatar 2", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	const removeSave = [...requests]
		.reverse()
		.find(
			(request) =>
				request.path === `/projects/${projectId}` && request.method === "PUT"
		);
	expect(
		capturedJsonArray(capturedJsonField(removeSave?.body, "avatars"))
	).toEqual([expect.objectContaining({ id: savedAvatar?.id })]);

	await page.reload();
	await page.getByLabel("Project").selectOption({ label: title });
	await openOverflowTab(page, "Avatars", "avatars");
	await page.getByRole("spinbutton", { name: "Playhead" }).fill("1.25");
	await page.getByRole("spinbutton", { name: "Playhead" }).press("Tab");
	await page
		.getByLabel("Avatar 1 rig keyframe property")
		.selectOption("rightArm");
	await page.getByLabel("Avatar 1 rig keyframe value").fill("35");
	await expect(page.getByText("Avatar 1", { exact: true })).toBeVisible();
	await expect(page.getByText("Avatar 2", { exact: true })).toHaveCount(0);
	await expect(
		page.locator(".studio-preview-frame [aria-label='2.5D avatar']")
	).toBeVisible();
	await expect(
		page.locator(
			".studio-preview-frame [aria-label='2.5D avatar'] .studio-avatar-arm-right"
		)
	).toHaveAttribute("style", /rotate\(35deg\)/);
	await page
		.getByRole("button", { name: "Add 2.5D avatar" })
		.scrollIntoViewIfNeeded();
	await saveScreenshot(page, "video-studio-avatar-panel-persisted.png");
	await page
		.getByRole("button", { name: "Add rig keyframe at playhead" })
		.scrollIntoViewIfNeeded();
	await saveScreenshot(page, "video-studio-avatar-panel-rig-persisted.png");
});
