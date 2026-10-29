import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/pinned-agent-stage-proof.html";

test("shows hero, pair, and three-up pinned agent densities", async ({
	page,
}) => {
	await page.goto(STORY_URL);

	const hero = page.getByTestId("pinned-preview-1");
	const pair = page.getByTestId("pinned-preview-2");
	const grid = page.getByTestId("pinned-preview-4");

	await expect(
		hero.locator('[data-testid="pinned-agent-stage"]')
	).toHaveAttribute("data-layout", "hero");
	await expect(
		pair.locator('[data-testid="pinned-agent-stage"]')
	).toHaveAttribute("data-layout", "pair");
	await expect(
		grid.locator('[data-testid="pinned-agent-stage"]')
	).toHaveAttribute("data-layout", "grid");

	await expect(hero.getByText("Chief of staff")).toBeVisible();
	await expect(pair.getByText("Personal")).toBeVisible();
	await expect(grid.getByText("Amazon Bot")).toBeVisible();
	await expect(grid.getByText("Computer Helper")).toBeVisible();
	await expect(grid.getByText("Other agents")).toBeVisible();

	await grid.locator('[data-agent-id="chief-of-staff"]').hover();
	await grid.getByRole("button", { name: "Unpin Chief of staff" }).click();
	await expect(
		grid.locator('[data-testid="pinned-agent-stage"]')
	).toHaveAttribute("data-pinned-count", "3");

	await page.screenshot({
		path: test.info().outputPath("pinned-agent-stage-proof.png"),
		fullPage: true,
	});
});
