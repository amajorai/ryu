// Real-browser spec for the feedback card story
// (`e2e/harness/feedback-card-story.html`): the in-chat idea and bug card.
//
// The unit tests cover the card's logic. This spec covers what only a painted
// page shows: that the attached lines on screen are the redacted ones, that
// the copied report is exactly what was on the card, and that the card keeps
// its shape in both themes at desktop and phone width. It also writes the
// screenshots a reviewer looks at.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

// Cold Vite compiles the card's module graph on first navigation.
test.describe.configure({ mode: "serial", timeout: 180_000 });

const STORY_URL = "/feedback-card-story.html";
const SHOTS_DIR =
	process.env.RYU_FEEDBACK_SHOTS ?? "test-results/feedback-card-story";
const SEND = "Copy and open feedback board";

const VIEWPORTS = [
	{ height: 900, name: "desktop", width: 1280 },
	{ height: 844, name: "phone", width: 390 },
] as const;
const THEMES = ["light", "dark"] as const;
const SHOT_PANES = ["idea", "bug", "thanks", "declined", "read-only"] as const;

async function openStory(page: Page, theme: "dark" | "light" = "light") {
	await page.goto(`${STORY_URL}?theme=${theme}`, {
		waitUntil: "domcontentloaded",
	});
	// The attached lines arrive after the first paint; the send button waits
	// for them, so an enabled button means the card is complete.
	await expect(
		page.getByTestId("story-bug").getByRole("button", { name: SEND })
	).toBeEnabled({ timeout: 120_000 });
}

function card(page: Page, pane: string) {
	return page.getByTestId(`story-${pane}`).getByTestId("feedback-card");
}

test("an idea card shows the draft and what the app would attach", async ({
	page,
}) => {
	await openStory(page);
	const idea = card(page, "idea");
	await expect(idea).toHaveAttribute("data-state", "draft");
	await expect(idea.getByLabel("Title")).toHaveValue(
		"Dark theme for PDF exports"
	);
	await expect(idea.getByLabel("Details")).toHaveValue(/reading list/);
	// Bug-only fields stay off an idea.
	await expect(idea.getByLabel("Steps to reproduce")).toHaveCount(0);
	await expect(idea.getByText("App version: 0.5.2")).toBeVisible();
	await expect(idea.getByText("System: windows-x86_64")).toBeVisible();
	// An idea carries no errors.
	await expect(idea.getByText(/Recent error/)).toHaveCount(0);
});

test("a bug card attaches recent errors with private text removed", async ({
	page,
}) => {
	await openStory(page);
	const bug = card(page, "bug");
	await expect(bug.getByLabel("Steps to reproduce")).toHaveValue(/Export/);
	await expect(bug.getByLabel("What you expected")).toBeVisible();
	await expect(bug.getByLabel("What happened instead")).toBeVisible();
	await expect(
		bug.getByText(/Recent error 1: files\.export_pdf/)
	).toBeVisible();
	await expect(bug.getByText(/Recent error 2: web\.fetch/)).toBeVisible();
	const text = (await bug.textContent()) ?? "";
	expect(text).toContain("[REDACTED");
	expect(text).not.toContain("dana");
	expect(text).not.toContain("story-token");
});

test("the card never grows wider than its column", async ({ page }) => {
	await page.setViewportSize({ height: 844, width: 390 });
	await openStory(page);
	for (const pane of ["idea", "bug"]) {
		const box = await card(page, pane).boundingBox();
		if (!box) {
			throw new Error(`${pane} card is not laid out`);
		}
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
	}
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);
});

test("sending copies only what is still on the card", async ({ page }) => {
	await openStory(page);
	const bug = card(page, "bug");
	await bug.getByLabel("Title").fill("PDF export fails");
	await bug.getByRole("button", { name: "Remove Model" }).click();
	await expect(bug.getByText(/^Model:/)).toHaveCount(0);
	await bug.getByRole("button", { name: SEND }).click();

	await expect(bug).toHaveAttribute("data-state", "copied");
	await expect(bug.getByText("Thank you for your feedback")).toBeVisible();
	await expect(bug.getByTestId("feedback-copied-badge")).toBeVisible();

	const report = page.getByTestId("story-report");
	await expect(report).toHaveCount(1);
	await expect(report).toContainText("[Bug] PDF export fails");
	await expect(report).toContainText("App version: 0.5.2");
	await expect(report).not.toContainText("Model:");
	await expect(report).not.toContainText("dana");
	// The agent hears a fixed sentence, never the report.
	await expect(page.getByTestId("story-follow-ups")).toContainText(
		"I copied the bug report"
	);
	await expect(page.getByTestId("story-opened")).toHaveText("1");
});

test("Not now closes the card and sends nothing", async ({ page }) => {
	await openStory(page);
	const idea = card(page, "idea");
	await idea.getByRole("button", { name: "Not now" }).click();
	await expect(idea).toHaveAttribute("data-state", "declined");
	await expect(idea.getByText("Nothing was sent.")).toBeVisible();
	await expect(page.getByTestId("story-report")).toHaveCount(0);
	await expect(page.getByTestId("story-opened")).toHaveText("0");
	await expect(page.getByTestId("story-follow-ups")).toContainText("Not now.");
});

test("closed and read-only cards offer no way to send", async ({ page }) => {
	await openStory(page);
	for (const pane of ["thanks", "declined", "read-only"]) {
		await expect(
			card(page, pane).getByRole("button", { name: SEND })
		).toHaveCount(0);
	}
	await expect(card(page, "thanks")).toHaveAttribute("data-state", "copied");
	await expect(card(page, "read-only")).toHaveAttribute(
		"data-state",
		"read-only"
	);
});

test("screenshots of every state, both themes, desktop and phone", async ({
	page,
}) => {
	mkdirSync(SHOTS_DIR, { recursive: true });
	for (const viewport of VIEWPORTS) {
		await page.setViewportSize({
			height: viewport.height,
			width: viewport.width,
		});
		for (const theme of THEMES) {
			await openStory(page, theme);
			await page.evaluate(async () => {
				await document.fonts.ready;
			});
			for (const pane of SHOT_PANES) {
				await card(page, pane).screenshot({
					path: path.join(SHOTS_DIR, `${pane}-${theme}-${viewport.name}.png`),
				});
			}
			await page.screenshot({
				fullPage: true,
				path: path.join(SHOTS_DIR, `all-${theme}-${viewport.name}.png`),
			});
		}
	}
});
