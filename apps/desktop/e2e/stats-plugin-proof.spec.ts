import path from "node:path";
import { expect, test } from "@playwright/test";

const STORY_URL = "/stats-plugin-proof.html";

test.describe.configure({ timeout: 120_000 });

test("renders the extracted provider-neutral session stats strip", async ({
	page,
}) => {
	await page.goto(STORY_URL);

	const proof = page.getByTestId("stats-plugin-proof");
	await expect(proof).toBeVisible();
	await expect(page.getByTestId("stats-turns")).toContainText("2");
	await expect(page.getByTestId("stats-steps")).toContainText("3");
	await expect(page.getByTestId("stats-input")).toBeVisible();
	await expect(page.getByTestId("stats-output")).toBeVisible();
	await expect(page.getByTestId("stats-cache-hit")).toBeVisible();
	await expect(page.getByTestId("stats-cache-timer")).toContainText("m");
});

test("opens the full stats breakdown and settings controls", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page.getByTestId("stats-turns").hover();

	const details = page.getByTestId("stats-plugin-details");
	await expect(details).toBeVisible();
	for (const label of [
		"Tokens Input",
		"Tokens Output",
		"Tokens Cached",
		"Tokens Total",
		"Cache Hit Rate",
		"Cache Read",
		"Cache Write",
		"Cache Timer",
		"Input Speed",
		"Output Speed",
		"Total Speed",
		"Context Length",
		"Context Window",
		"Context % (usable)",
		"Compaction Counter",
		"Session Usage",
		"Weekly Usage",
		"Extra Usage Used",
		"Weekly Fable Usage",
	]) {
		await expect(details).toContainText(label);
	}
	await expect(page.getByTestId("stats-context-bar")).toBeVisible();
	await expect(page.getByTestId("stats-session-usage-bar")).toBeVisible();
	await expect(page.getByTestId("stats-weekly-usage-bar")).toBeVisible();
	await expect(page.locator("#stats-cache-hot-glyph")).toHaveValue("🔥");
	await expect(page.locator("#stats-cache-countdown-glyph")).toHaveValue("⏱");
	await expect(page.locator("#stats-cache-cold-glyph")).toHaveValue("❄");
	await expect(page.locator("#stats-compaction-triggers")).toBeChecked();
	await expect(page.locator("#stats-compaction-reclaimed")).toBeChecked();
	await expect(page.locator("#stats-usage-percent-mode")).toHaveValue("used");

	await page.locator("#stats-usage-percent-mode").selectOption("remaining");
	await expect(page.getByTestId("stats-session-usage-bar")).toContainText(
		"66%"
	);
	await page.locator("#stats-reset-timer-mode").selectOption("progress");
	await expect(details).toContainText("elapsed");

	await page.setViewportSize({ width: 1280, height: 1200 });
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/prompt-cache/session-stats.png"
		),
	});
});
