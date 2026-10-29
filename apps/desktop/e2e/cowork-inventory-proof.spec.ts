import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const errors: string[] = [];
const errorStacks: string[] = [];

test.beforeEach(({ page }) => {
	errors.length = 0;
	errorStacks.length = 0;
	page.on("pageerror", (error) => {
		errors.push(error.message);
		errorStacks.push(error.stack ?? error.message);
	});
});
test.afterEach(async ({ page }, info) => {
	const slug = info.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
	await writeFile(
		test.info().outputPath(`${slug}-pageerrors.json`),
		JSON.stringify(errors)
	);
	await info.attach("cowork-inventory-pageerror-stacks", {
		body: JSON.stringify(errorStacks, null, 2),
		contentType: "application/json",
	});
	if (info.status === info.expectedStatus) {
		expect(errors).toEqual([]);
		// Capture the settled production components after their UI assertions.
		await page.waitForTimeout(700);
		await page.screenshot({
			path: test.info().outputPath(`${slug}.png`),
			fullPage: true,
		});
	}
});

test("saved plan rows open the selected rendered artifact", async ({
	page,
}) => {
	await page.goto("/plan-pinned-summary-proof.html");
	await page.getByRole("button", { name: /Plans/ }).click();
	const rows = page.getByTestId("pinned-summary-plan");
	await expect(rows).toHaveCount(2);
	await rows.nth(1).click();
	await expect(page.getByTestId("plan-artifact-empty")).not.toBeVisible();
	await expect(page.getByTestId("plan-artifact-viewer")).toContainText(
		"Persist plans to Artifacts"
	);
	await expect(page.getByTestId("plan-artifact-viewer")).toContainText(
		"Save every ACP and Pi plan snapshot"
	);
});

test("source group expansion and complete inventory action preserve their separate state", async ({
	page,
}) => {
	await page.goto("/cowork-sources-story.html");
	const group = page.getByRole("button", { name: /^Local files/ });
	await expect(group).toHaveAttribute("aria-expanded", "false");
	await page.getByRole("button", { name: "Open all sources" }).click();
	await expect(page.locator("body")).toHaveAttribute(
		"data-sources-opened",
		"true"
	);
	await expect(group).toHaveAttribute("aria-expanded", "false");
	await group.click();
	await expect(group).toHaveAttribute("aria-expanded", "true");
	const summary = page.getByTestId("pinned-summary");
	await expect(
		summary.getByText("effort-colors.ts", { exact: true })
	).toBeVisible();
	await expect(
		summary.getByText("bun test src/lib/effort-colors.test.ts")
	).toBeVisible();
	await group.click();
	await expect(group).toHaveAttribute("aria-expanded", "false");
	await group.click();
	await expect(
		summary.getByText("effort-colors.ts", { exact: true })
	).toBeVisible();
});

test("subagent roster overflow opens a task transcript and returns to the roster", async ({
	page,
}) => {
	await page.setViewportSize({ width: 720, height: 840 });
	await page.goto("/subagents-workspace-proof.html");
	await expect(page.getByRole("heading", { name: /Active.*5/ })).toBeVisible();
	await expect(page.getByText("Inspect chart rendering")).not.toBeVisible();
	await page.getByRole("button", { name: "Show 1 more" }).click();
	await expect(page.getByText("Inspect chart rendering")).toBeVisible();
	await page
		.getByRole("button", { name: "Open Trace stats data flow" })
		.click();
	await expect(page.getByTestId("subagent-detail")).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Trace stats data flow" })
	).toBeVisible();
	await page.getByRole("button", { name: "Back to subagents" }).click();
	await expect(page.getByTestId("subagents-roster")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Open Trace stats data flow" })
	).toBeVisible();
});
