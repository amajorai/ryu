import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const STORY_URL = "/editor-toolbar-proof.html";

test("shows Spaces page tools in a compact rail and two-row expanded grid", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 1240 });
	await page.goto(STORY_URL);

	await expect(page.getByTestId("proof-status")).toHaveText(
		"Shared primitive mounted"
	);
	await expect(page.getByTestId("editor-surface-page")).toBeVisible();
	await expect(
		page.locator('[data-slot="nested-overflow-toolbar"]')
	).toHaveCount(1);

	const toolbar = page.locator('[data-slot="nested-overflow-toolbar"]');
	await expect(toolbar.getByRole("button", { name: "Undo" })).toBeVisible();
	await expect(toolbar.getByRole("button", { name: "Bold" })).toBeVisible();
	await toolbar.getByRole("button", { name: "Open editor tools" }).click();
	const expandedTools = page.getByRole("group", {
		name: "Page editor tools expanded",
	});
	await expect(expandedTools).toBeVisible();
	await expect(
		expandedTools.getByRole("group", { name: "Format tools" })
	).toBeVisible();
	await expect(
		expandedTools.getByRole("button", { name: /Underline/ })
	).toBeVisible();
	await expect(
		expandedTools.getByRole("group", { name: "Media tools" })
	).toBeVisible();
	const categoryRows = await expandedTools
		.locator(":scope > div")
		.evaluateAll(
			(categories) =>
				new Set(
					categories.map((category) =>
						Math.round(category.getBoundingClientRect().top)
					)
				).size
		);
	expect(categoryRows).toBe(2);
	const proofPath = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/image-editing/spaces-page-editor-toolbar-proof.png"
	);
	await mkdir(path.dirname(proofPath), { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: false,
		path: proofPath,
	});
	await toolbar.getByRole("button", { name: "Close editor tools" }).click();
	await expect(expandedTools).toHaveCount(0);
});

test("uses the same rail in the skill editor and applies Markdown actions", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page
		.locator('nav[aria-label="Editor surface"] button:nth-child(2)')
		.click();

	await expect(page.getByTestId("editor-surface-skill")).toBeVisible();
	await expect(
		page.locator('[data-slot="nested-overflow-toolbar"]')
	).toHaveCount(1);
	await page
		.locator(
			'[data-slot="nested-overflow-toolbar"] button[aria-label="Open editor tools"]'
		)
		.click();
	await page
		.locator(
			'[data-slot="nested-overflow-toolbar"] button[aria-label="Open Format tools"]'
		)
		.click();
	await expect(
		page.locator(
			'[data-slot="nested-overflow-toolbar"] button[aria-label="Back to editor tools"]'
		)
	).toBeVisible();

	const textarea = page.getByRole("textbox", {
		name: "Skill instructions (Markdown)",
	});
	await textarea.fill("hello");
	await textarea.press("ControlOrMeta+A");
	await page
		.locator('[data-slot="nested-overflow-toolbar"] button[aria-label="Bold"]')
		.click();
	await expect(textarea).toHaveValue("**hello**");
});
