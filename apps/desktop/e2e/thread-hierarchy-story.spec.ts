// Real-browser spec for the thread hierarchy bar story
// (`e2e/harness/thread-hierarchy-story.{html,tsx}`), which mounts the REAL
// `ThreadHierarchyBar` over a deep nest: a project, a bot, and five sessions
// that each spawned the next.
//
// The contract under test:
//   • a chain longer than four crumbs keeps the first crumb, the parent and the
//     current thread, and folds the rest into a menu that opens them;
//   • a bar too narrow for that (a phone) keeps the parent and the current one;
//   • every crumb shows the run status of its thread;
//   • a crumb with threads beside it opens a menu of them;
//   • arrow keys move between crumbs along the reading direction, Enter opens
//     the focused crumb and Alt+ArrowUp opens the parent.
//
// Layout is the point (one row that neither wraps nor pushes the bar's buttons
// off screen), so this needs a layout engine and not a unit test. Screenshots
// for review go to THREAD_HIERARCHY_SHOTS when it is set.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";

// Cold Vite compiles the bar's module graph on the first navigation.
test.describe.configure({ timeout: 120_000 });

const STORY_URL = "/thread-hierarchy-story.html";
const SHOTS_DIR = process.env.THREAD_HIERARCHY_SHOTS;
const DESKTOP = { height: 800, width: 1280 };
const NARROW = { height: 700, width: 900 };
const PHONE = { height: 844, width: 390 };

const PARENT = "Patch the retry loop in the uploader";
const CURRENT = "Verify the fix on Windows";
const HIDDEN = [
	"Scout",
	"Audit the open pull requests",
	"Reproduce the flaky upload test",
	"Bisect the upload regression",
];

async function openStory(page: Page, query: string, viewport = DESKTOP) {
	await page.setViewportSize(viewport);
	await page.goto(`${STORY_URL}${query}`);
	await expect(page.getByTestId("thread-hierarchy-bar")).toBeVisible();
}

/** Save a screenshot for review. `height` keeps only the top of the page. */
async function shot(
	page: Page,
	testInfo: TestInfo,
	name: string,
	height?: number
) {
	if (SHOTS_DIR) {
		mkdirSync(SHOTS_DIR, { recursive: true });
	}
	const viewport = page.viewportSize();
	await page.screenshot({
		clip:
			height && viewport
				? { height, width: viewport.width, x: 0, y: 0 }
				: undefined,
		path: SHOTS_DIR ? path.join(SHOTS_DIR, name) : testInfo.outputPath(name),
	});
}

const crumbs = (page: Page) => page.getByTestId("crumb");
const stops = (page: Page) => page.locator("[data-crumb-stop]");
const currentThread = (page: Page) => page.getByTestId("current-thread");

test("a chain of five sessions folds its middle into a menu of the hidden ancestors", async ({
	page,
}, testInfo) => {
	await openStory(page, "?theme=light");
	await expect(crumbs(page)).toHaveText(["Atlas", PARENT, CURRENT]);
	await shot(page, testInfo, "crumbs-desktop-light.png", 320);

	await page.getByTestId("crumb-hidden").click();
	await expect(page.getByRole("menuitem")).toHaveText(HIDDEN);
	await shot(page, testInfo, "crumbs-desktop-light-hidden-menu.png", 320);

	await page
		.getByRole("menuitem", { name: "Bisect the upload regression" })
		.click();
	await expect(currentThread(page)).toHaveText("session-3");
	// One level up, the chain still has more than four crumbs.
	await expect(crumbs(page)).toHaveText([
		"Atlas",
		"Reproduce the flaky upload test",
		"Bisect the upload regression",
	]);
});

test("a chain of four crumbs is shown whole", async ({ page }) => {
	await openStory(page, "?theme=light&depth=2");
	await expect(crumbs(page)).toHaveText([
		"Atlas",
		"Scout",
		"Audit the open pull requests",
		"Reproduce the flaky upload test",
	]);
	await expect(page.getByTestId("crumb-hidden")).toHaveCount(0);
});

test("the bar stays on one row when the window is narrow", async ({
	page,
}, testInfo) => {
	await openStory(page, "?theme=light", NARROW);
	await expect(crumbs(page)).toHaveText(["Atlas", PARENT, CURRENT]);
	const bar = page.getByTestId("thread-hierarchy-bar");
	const box = await bar.boundingBox();
	// One row: the bar is 40 px tall and a wrapped breadcrumb would double it.
	expect(box?.height ?? 0).toBeGreaterThan(0);
	expect(box?.height ?? 0).toBeLessThan(48);
	// The bar's own buttons stay inside the window.
	const defaults = await page
		.getByRole("button", { name: "Defaults" })
		.boundingBox();
	expect((defaults?.x ?? 0) + (defaults?.width ?? 0)).toBeLessThanOrEqual(
		NARROW.width
	);
	await shot(page, testInfo, "crumbs-narrow-light.png", 320);
});

test("every crumb shows the run status of its thread", async ({ page }) => {
	await openStory(page, "?theme=light");
	const dots = crumbs(page).locator("[data-run-status]");
	await expect(dots).toHaveCount(3);
	await expect(dots.nth(0)).toHaveAttribute("data-run-status", "completed");
	await expect(dots.nth(0)).toHaveAttribute("aria-label", "Completed");
	await expect(dots.nth(1)).toHaveAttribute("data-run-status", "running");
	await expect(dots.nth(2)).toHaveAttribute("aria-label", "In progress");
});

test("a crumb opens the threads beside it", async ({ page }, testInfo) => {
	await openStory(page, "?theme=dark");
	await shot(page, testInfo, "crumbs-desktop-dark.png", 320);
	// Only the current session has threads beside it among the visible crumbs.
	const siblings = page.getByTestId("crumb-siblings");
	await expect(siblings).toHaveCount(1);
	await siblings.click();
	await expect(page.getByRole("menuitem")).toHaveText([
		"Check the macOS build",
		"Update the upload docs page",
		"Write the changelog entry",
	]);
	await shot(page, testInfo, "crumbs-desktop-dark-sibling-menu.png", 320);
	await page
		.getByRole("menuitem", { name: "Update the upload docs page" })
		.click();
	await expect(currentThread(page)).toHaveText("docs");
	await expect(crumbs(page).last()).toHaveText("Update the upload docs page");
});

test("arrow keys move between crumbs, Enter opens one and Alt+ArrowUp opens the parent", async ({
	page,
}) => {
	await openStory(page, "?theme=light");
	// Atlas, the menu of hidden ancestors, the parent, the current crumb's menu.
	await expect(stops(page)).toHaveCount(4);
	await stops(page).first().focus();
	await page.keyboard.press("ArrowRight");
	await expect(page.getByTestId("crumb-hidden")).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(stops(page).nth(2)).toBeFocused();
	await expect(stops(page).nth(2)).toHaveText(PARENT);
	await page.keyboard.press("End");
	await expect(page.getByTestId("crumb-siblings")).toBeFocused();
	await page.keyboard.press("Home");
	await expect(stops(page).first()).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(stops(page).first()).toBeFocused();
	// Moving focus opened nothing.
	await expect(currentThread(page)).toHaveText("session-5");

	await page.keyboard.press("Alt+ArrowUp");
	await expect(currentThread(page)).toHaveText("session-4");

	await stops(page).first().focus();
	await page.keyboard.press("Enter");
	await expect(currentThread(page)).toHaveText("project");
});

for (const theme of ["light", "dark"]) {
	test(`a phone keeps the parent and the current crumb (${theme})`, async ({
		page,
	}, testInfo) => {
		await openStory(page, `?theme=${theme}`, PHONE);
		await expect(crumbs(page)).toHaveText([PARENT, CURRENT]);
		await expect(page.getByTestId("crumb-hidden")).toBeVisible();
		const bar = await page.getByTestId("thread-hierarchy-bar").boundingBox();
		expect(bar?.height ?? 0).toBeGreaterThan(0);
		expect(bar?.height ?? 0).toBeLessThan(48);
		await shot(page, testInfo, `crumbs-phone-${theme}.png`);

		await page.getByTestId("crumb-hidden").click();
		await expect(
			page.getByText("Scout", { exact: true }).first()
		).toBeVisible();
		await expect(
			page.getByText("Atlas", { exact: true }).first()
		).toBeVisible();
		// Let the sheet finish sliding in before the picture.
		await page.waitForTimeout(600);
		await shot(page, testInfo, `crumbs-phone-${theme}-hidden-menu.png`);
	});
}

test("Arabic reads right to left and the arrow keys follow", async ({
	page,
}, testInfo) => {
	await openStory(page, "?theme=light&locale=ar", NARROW);
	await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
	await expect(crumbs(page)).toHaveCount(3);
	await expect(crumbs(page).first()).toHaveText("Atlas");
	// The first crumb sits at the right edge, the current one to its left.
	const first = await crumbs(page).first().boundingBox();
	const last = await crumbs(page).last().boundingBox();
	expect(first?.x ?? 0).toBeGreaterThan(last?.x ?? 0);
	await page.waitForTimeout(400);
	await shot(page, testInfo, "crumbs-narrow-ar.png", 320);

	await stops(page).first().focus();
	await page.keyboard.press("ArrowLeft");
	await expect(page.getByTestId("crumb-hidden")).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(stops(page).first()).toBeFocused();

	await page.setViewportSize(PHONE);
	await expect(crumbs(page)).toHaveCount(2);
	await page.waitForTimeout(400);
	await shot(page, testInfo, "crumbs-phone-ar.png");
});
