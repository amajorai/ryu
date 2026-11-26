// Real-browser spec for the Sessions tree of the thread bar, on the story of
// `e2e/harness/thread-hierarchy-story.{html,tsx}`. The story mounts the REAL
// `ThreadHierarchyBar` over a nest six levels deep: a bot's main thread, the
// sessions it spawned, and a chain of sessions that each spawned the next.
//
// The contract under test:
//   • Sessions lists the whole nest the open thread sits in as an indented
//     tree, whichever thread of the nest is open;
//   • every row opens its own thread, and the row of the open thread is marked;
//   • a row folds and unfolds, and the arrow keys walk the tree;
//   • the list fits a phone, and indents from the right in Arabic;
//   • a node whose Core has no tree route still lists one level of sessions.
//
// Screenshots for review go to THREAD_HIERARCHY_SHOTS when it is set.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";

// Cold Vite compiles the bar's module graph on the first navigation.
test.describe.configure({ timeout: 120_000 });

const STORY_URL = "/thread-hierarchy-story.html";
const SHOTS_DIR = process.env.THREAD_HIERARCHY_SHOTS;
const DESKTOP = { height: 800, width: 1280 };
const PHONE = { height: 844, width: 390 };

// The nest top down, as [thread id, level]. Sessions of one thread are listed
// newest activity first.
const NEST: [string, string][] = [
	["scout", "1"],
	["triage", "2"],
	["session-1", "2"],
	["session-2", "3"],
	["session-3", "4"],
	["session-4", "5"],
	["session-5", "6"],
	["macos", "6"],
	["docs", "6"],
	["changelog", "6"],
];

const rows = (page: Page) => page.getByTestId("thread-tree-row");
const row = (page: Page, id: string) => page.locator(`[data-tree-row="${id}"]`);
const currentThread = (page: Page) => page.getByTestId("current-thread");

async function openTree(page: Page, query: string, viewport = DESKTOP) {
	await page.setViewportSize(viewport);
	await page.goto(`${STORY_URL}${query}`);
	await expect(page.getByTestId("thread-hierarchy-bar")).toBeVisible();
	await page.getByTestId("sessions-trigger").click();
	await expect(page.getByTestId("sessions-panel")).toBeVisible();
	// The popover zooms in; measure only once it has its final size.
	await page
		.getByTestId("sessions-panel")
		.evaluate((panel) =>
			Promise.all(
				(
					panel.closest('[data-slot="popover-content"]')?.getAnimations() ?? []
				).map((animation) => animation.finished)
			).then(() => undefined)
		);
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
	if (SHOTS_DIR) {
		mkdirSync(SHOTS_DIR, { recursive: true });
	}
	// Let the popover finish opening before the picture is taken.
	await page.waitForTimeout(400);
	await page.screenshot({
		path: SHOTS_DIR ? path.join(SHOTS_DIR, name) : testInfo.outputPath(name),
	});
}

/** [thread id, level] of every listed row, top down. */
function listed(page: Page) {
	return rows(page).evaluateAll((items) =>
		items.map((item) => [
			item.getAttribute("data-tree-row"),
			item.getAttribute("aria-level"),
		])
	);
}

test("Sessions lists the whole nest as a tree, from any thread in it", async ({
	page,
}, testInfo) => {
	await openTree(page, "?theme=light");
	await expect(rows(page)).toHaveCount(NEST.length);
	expect(await listed(page)).toEqual(NEST);
	await expect(page.getByRole("tree")).toBeVisible();
	// The open thread is the marked row, and the only one.
	await expect(row(page, "session-5")).toHaveAttribute("aria-current", "page");
	await expect(page.locator("[data-tree-row][aria-current]")).toHaveCount(1);
	// A row carries the status, the title and the agent of its thread.
	await expect(row(page, "session-3")).toContainText(
		"Bisect the upload regression"
	);
	await expect(row(page, "session-3")).toContainText("Failed");
	await expect(
		row(page, "session-3").locator("[data-run-status]")
	).toHaveAttribute("data-run-status", "failed");
	await expect(row(page, "macos").getByTestId("thread-tree-agent")).toHaveText(
		"Quill"
	);
	// A deeper row starts further in.
	const parent = await row(page, "session-1")
		.getByTestId("thread-tree-toggle")
		.boundingBox();
	const child = await row(page, "session-2")
		.getByTestId("thread-tree-toggle")
		.boundingBox();
	expect(child?.x ?? 0).toBeGreaterThan(parent?.x ?? 0);
	await shot(page, testInfo, "tree-desktop-light.png");

	// The same tree from the top of the nest and from a thread in the middle.
	for (const current of ["scout", "session-2", "triage"]) {
		await openTree(page, `?theme=light&current=${current}`);
		await expect(rows(page)).toHaveCount(NEST.length);
		expect(await listed(page)).toEqual(NEST);
		await expect(row(page, current)).toHaveAttribute("aria-current", "page");
	}
});

test("every row opens its own thread", async ({ page }) => {
	await openTree(page, "?theme=light");
	for (const [id] of NEST) {
		if (!(await page.getByTestId("sessions-panel").isVisible())) {
			await page.getByTestId("sessions-trigger").click();
		}
		await row(page, id).click();
		await expect(currentThread(page)).toHaveText(id);
	}
});

test("a row folds and unfolds, and the arrow keys walk the tree", async ({
	page,
}, testInfo) => {
	await openTree(page, "?theme=dark");
	await expect(rows(page)).toHaveCount(NEST.length);
	await row(page, "session-1").getByTestId("thread-tree-toggle").click();
	await expect(rows(page)).toHaveCount(3);
	await expect(row(page, "session-1")).toHaveAttribute(
		"aria-expanded",
		"false"
	);
	// Folding is not opening.
	await expect(currentThread(page)).toHaveText("session-5");
	await shot(page, testInfo, "tree-desktop-dark-folded.png");

	await row(page, "session-1").focus();
	await page.keyboard.press("ArrowRight");
	await expect(rows(page)).toHaveCount(NEST.length);
	await expect(row(page, "session-1")).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(row(page, "session-2")).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(row(page, "session-3")).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(rows(page)).toHaveCount(5);
	await page.keyboard.press("ArrowLeft");
	await expect(row(page, "session-2")).toBeFocused();
	await page.keyboard.press("Home");
	await expect(row(page, "scout")).toBeFocused();
	await page.keyboard.press("End");
	await expect(row(page, "session-3")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(currentThread(page)).toHaveText("session-3");
	await shot(page, testInfo, "tree-desktop-dark.png");
});

test("the tree fits a phone", async ({ page }, testInfo) => {
	await openTree(page, "?theme=dark", PHONE);
	await expect(rows(page)).toHaveCount(NEST.length);
	const panel = await page.getByTestId("sessions-panel").boundingBox();
	expect(panel?.x ?? -1).toBeGreaterThanOrEqual(0);
	expect((panel?.x ?? 0) + (panel?.width ?? 0)).toBeLessThanOrEqual(
		PHONE.width
	);
	// The deepest rows stay inside the panel and keep to one line.
	for (const id of ["session-5", "changelog"]) {
		const box = await row(page, id).boundingBox();
		expect(box?.x ?? -1).toBeGreaterThanOrEqual(panel?.x ?? 0);
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
			(panel?.x ?? 0) + (panel?.width ?? 0)
		);
		expect(box?.height ?? 0).toBeLessThan(40);
	}
	await shot(page, testInfo, "tree-phone-dark.png");

	await openTree(page, "?theme=light", PHONE);
	await expect(rows(page)).toHaveCount(NEST.length);
	await shot(page, testInfo, "tree-phone-light.png");
});

test("Arabic indents from the right and the arrow keys follow", async ({
	page,
}, testInfo) => {
	await openTree(page, "?theme=light&locale=ar");
	await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
	await expect(rows(page)).toHaveCount(NEST.length);
	const parent = await row(page, "session-1")
		.getByTestId("thread-tree-toggle")
		.boundingBox();
	const child = await row(page, "session-2")
		.getByTestId("thread-tree-toggle")
		.boundingBox();
	expect(child?.x ?? 0).toBeLessThan(parent?.x ?? 0);
	await shot(page, testInfo, "tree-desktop-ar.png");

	await row(page, "session-1").focus();
	await page.keyboard.press("ArrowRight");
	await expect(rows(page)).toHaveCount(3);
	await page.keyboard.press("ArrowLeft");
	await expect(rows(page)).toHaveCount(NEST.length);
	await page.keyboard.press("ArrowLeft");
	await expect(row(page, "session-2")).toBeFocused();

	await openTree(page, "?theme=dark&locale=ar", PHONE);
	await expect(rows(page)).toHaveCount(NEST.length);
	await shot(page, testInfo, "tree-phone-ar.png");
});

test("a Core without the tree route still lists the sessions one level down", async ({
	page,
}) => {
	await openTree(page, "?theme=light&tree=missing&current=scout");
	expect(await listed(page)).toEqual([
		["scout", "1"],
		["triage", "2"],
		["session-1", "2"],
	]);
	await expect(row(page, "scout")).toHaveAttribute("aria-current", "page");
	await row(page, "session-1").click();
	await expect(currentThread(page)).toHaveText("session-1");
});

test("a main thread that delegated nothing says so", async ({ page }) => {
	await openTree(page, "?theme=light&current=quill");
	await expect(page.getByTestId("sessions-panel")).toContainText(
		"No sessions yet. Delegated work appears here."
	);
	await expect(rows(page)).toHaveCount(0);
});
