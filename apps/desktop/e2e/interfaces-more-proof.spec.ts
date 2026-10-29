// Real-browser proof for the ten workspace interfaces — Card Table, Sheet,
// Canvas, Calendar, Notebook, Mission Control, Ticker, Focus, Aquarium and Planets —
// mounted by `e2e/harness/interfaces-story.{html,tsx}` from the REAL renderers
// in `packages/blocks/src/desktop/interfaces/`.
//
// The story is the host: one fixture snapshot (six agents, the "Launch Crew"
// team, the "Website Redesign" project, ten threads covering every status,
// scheduled runs around now), an InterfacePort implemented in local state, and
// a labelled stub in place of the desktop's chat page (`threadView`). Every
// port call is echoed into the `port-log` output, so each test proves the
// renderer acted through the port.
//
// Contract asserted per interface: its key content renders from the snapshot,
// one real interaction reaches the port, and the host's thread view appears
// once a thread is open.
//
// Screenshots land in `docs/proof/interfaces/<key>-spec.png`; the unsuffixed
// PNGs beside them are the designers' curated shots and are never overwritten.

import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

// Cold Vite compiles the blocks and ui module graphs on first load.
test.describe.configure({ timeout: 120_000 });

const PROOF_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/interfaces"
);
const AGENT_NAMES = ["Atlas", "Brook", "Cipher", "Delta", "Echo", "Forge"];
const THREAD_TITLES = [
	"Rebuild the landing hero",
	"Roll out gateway 2.4 to production",
	"Launch week plan",
	"Pick a palette for the marketing site",
	"Audit lockfile advisories",
	"Draft 2.4 release notes",
	"Survey speculative decoding papers",
	"Write a changelog style guide",
	"Update the on-call runbook",
	"Office closed Friday",
];

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => {
		errors.push(error.message);
	});
});

test.afterEach(({ page }) => {
	expect(pageErrors.get(page) ?? []).toEqual([]);
});

function storyUrl(params: Record<string, string>): string {
	return `/interfaces-story.html?${new URLSearchParams(params).toString()}`;
}

/**
 * Capture once finite CSS transitions and animations have run, so a row that
 * was just selected is not caught halfway between its idle and active colors.
 * Looping animations (typing dots, live pulses) are left running.
 */
async function shot(page: Page, name: string): Promise<void> {
	await page.evaluate(async () => {
		const settling = document
			.getAnimations()
			.filter((animation) =>
				Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))
			);
		await Promise.all(
			settling.map((animation) => animation.finished.catch(() => undefined))
		);
	});
	await page.screenshot({ path: path.join(PROOF_DIR, `${name}-spec.png`) });
}

function portLog(page: Page) {
	return page.getByTestId("port-log");
}

function hostView(page: Page) {
	return page.getByTestId("stub-thread-view");
}

test("Card Table: seats and pot from the snapshot, dealing, and playing a card", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "card-table" }));
	const table = page.getByTestId("interface-card-table");
	await expect(table).toBeVisible();
	await expect(page.getByTestId("card-table-summary")).toHaveText(
		/^6 agents · 2 running · \d+ waiting on you$/
	);
	const seats = table.getByRole("list", { name: "Seats" });
	// Every agent takes a seat; working agents say so before their counts.
	for (const name of AGENT_NAMES) {
		await expect(
			seats.getByRole("button", {
				name: new RegExp(`^${name}(, working)?: .*Seat menu$`),
			})
		).toBeVisible();
	}
	const hand = page.getByTestId("card-table-hand");
	await expect(hand).toBeVisible();

	await table
		.getByRole("button", { exact: true, name: "Deal a thread" })
		.click();
	await expect(portLog(page)).toContainText("startThread({})");

	// The failed audit is the most urgent card in the hand.
	await hand
		.getByRole("button", { name: /^Audit lockfile advisories\. .*Play card$/ })
		.click();
	await expect(portLog(page)).toContainText("openThread(thread-audit)");
	const drawer = page.getByTestId("card-table-drawer");
	await expect(drawer).toBeVisible();
	await expect(drawer.getByTestId("stub-thread-view")).toContainText(
		"patch release"
	);
	await shot(page, "card-table");

	await drawer.getByRole("button", { name: "Close thread" }).click();
	await expect(portLog(page)).toContainText("closeThread()");
	await expect(drawer).toBeHidden();
});

test("Sheet: a row per thread, search and status filters, double-click to open", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "sheet" }));
	const sheet = page.getByTestId("interface-sheet");
	await expect(sheet).toBeVisible();
	const grid = sheet.getByRole("grid", { name: "Threads" });
	const rows = grid.getByRole("rowheader");
	await expect(rows).toHaveCount(THREAD_TITLES.length);
	for (const title of THREAD_TITLES) {
		await expect(
			grid.getByRole("rowheader", { name: new RegExp(`^${title}`) })
		).toBeVisible();
	}

	const search = sheet.getByRole("searchbox", { name: "Search threads" });
	await search.fill("gateway");
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText(
		"Roll out gateway 2.4 to production"
	);
	await sheet.getByRole("button", { name: "Clear search" }).click();
	await expect(rows).toHaveCount(THREAD_TITLES.length);

	const statuses = sheet.getByRole("group", { name: "Filter by status" });
	const working = statuses.getByRole("button", { name: "Working: 2" });
	await working.click();
	await expect(rows).toHaveCount(2);
	await working.click();
	await expect(rows).toHaveCount(THREAD_TITLES.length);

	await grid
		.getByRole("rowheader", { name: /^Rebuild the landing hero/ })
		.dblclick();
	await expect(portLog(page)).toContainText("openThread(thread-hero)");
	const panel = page.getByTestId("sheet-thread-panel");
	await expect(panel).toBeVisible();
	await expect(panel.getByTestId("stub-thread-view")).toContainText(
		"preloading it"
	);
	await shot(page, "sheet");

	await sheet.getByRole("button", { name: "New thread", exact: true }).click();
	await expect(portLog(page)).toContainText("startThread({})");
});

test("Canvas: status frames, the Agent arrangement, and a sticky opening", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "canvas" }));
	const canvas = page.getByTestId("interface-canvas");
	await expect(canvas).toBeVisible();
	await expect(canvas.getByTestId("canvas-card")).toHaveCount(
		THREAD_TITLES.length
	);
	await expect(
		canvas.getByRole("region", { name: "Working, 2 threads" })
	).toBeVisible();
	await expect(
		canvas.getByRole("region", { name: "Needs attention, 1 thread" })
	).toBeVisible();

	await canvas
		.getByRole("group", { name: "Arrange by" })
		.getByRole("button", { name: "Agent" })
		.click();
	await expect(
		canvas.getByRole("region", { name: /^Forge, \d+ threads?$/ })
	).toBeVisible();
	await expect(
		canvas.getByRole("region", { name: /^Delta, \d+ threads?$/ })
	).toBeVisible();

	await canvas
		.getByRole("button", {
			name: /^Rebuild the landing hero, Working, with Forge/,
		})
		.dblclick();
	await expect(portLog(page)).toContainText("openThread(thread-hero)");
	const panel = page.getByTestId("canvas-thread-panel");
	await expect(panel).toBeVisible();
	await expect(panel.getByTestId("stub-thread-view")).toContainText(
		"preloading it"
	);
	await shot(page, "canvas");
});

test("Calendar: threads and scheduled runs on the month, Week scale, opening a thread", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "calendar" }));
	const calendar = page.getByTestId("interface-calendar");
	await expect(calendar).toBeVisible();
	const month = page.getByTestId("calendar-month");
	await expect(month).toBeVisible();
	await expect(month.getByRole("columnheader")).toHaveCount(7);
	await expect(
		month.getByRole("gridcell", { name: /, today, / })
	).toBeVisible();

	const scale = calendar.getByRole("group", { name: "Calendar scale" });
	await scale.getByRole("button", { name: "Week" }).click();
	const week = page.getByTestId("calendar-week");
	await expect(week).toBeVisible();
	await expect(
		week.getByRole("button", { name: /^Scheduled run: Standup summary,/ })
	).toBeVisible();

	await week
		.getByRole("button", {
			name: /^Roll out gateway 2\.4 to production, Working, Delta,/,
		})
		.click();
	await expect(portLog(page)).toContainText("openThread(thread-deploy)");
	const panel = page.getByTestId("calendar-thread-panel");
	await expect(panel).toBeVisible();
	await expect(panel.getByTestId("stub-thread-view")).toContainText(
		"Canary is at 25%"
	);
	await shot(page, "calendar");
});

test("Notebook: pages in the sidebar tree, the home gallery, and opening a page", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "notebook" }));
	const notebook = page.getByTestId("interface-notebook");
	await expect(notebook).toBeVisible();
	const tree = notebook.getByRole("tree", { name: "Pages" });
	await expect(tree).toBeVisible();
	await expect(
		notebook.getByRole("region", { name: "Recently edited" })
	).toBeVisible();

	await tree
		.getByRole("treeitem", { name: "Rebuild the landing hero, Working" })
		.click();
	await expect(portLog(page)).toContainText("openThread(thread-hero)");
	const main = notebook.getByRole("main", { name: "Rebuild the landing hero" });
	await expect(main).toBeVisible();
	await expect(
		page.getByTestId("notebook-page-body").getByTestId("stub-thread-view")
	).toContainText("preloading it");
	await shot(page, "notebook");
});

test("Mission Control: key figures, a station per agent, Message and Open", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "mission-control" }));
	const wall = page.getByTestId("interface-mission-control");
	await expect(wall).toBeVisible();
	await expect(wall.getByRole("definition").first()).toBeVisible();
	for (const name of AGENT_NAMES) {
		await expect(
			wall.getByRole("button", { name: `Message ${name}` })
		).toBeVisible();
	}

	await wall.getByRole("button", { name: "Message Delta" }).click();
	await expect(portLog(page)).toContainText(
		'startThread({"agentId":"agent-delta"})'
	);

	await wall
		.getByRole("button", {
			name: "Open Forge's current thread: Rebuild the landing hero",
		})
		.click();
	await expect(portLog(page)).toContainText("openThread(thread-hero)");
	const panel = page.getByTestId("mission-thread-panel");
	await expect(panel).toBeVisible();
	await expect(panel.getByTestId("stub-thread-view")).toContainText(
		"preloading it"
	);
	await shot(page, "mission-control");

	await panel.getByRole("button", { name: "Close thread" }).click();
	await expect(portLog(page)).toContainText("closeThread()");
	await expect(panel).toBeHidden();
});

test("Ticker: a quote per agent, picking one, Message and opening a thread", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "ticker" }));
	const ticker = page.getByTestId("interface-ticker");
	await expect(ticker).toBeVisible();
	const watchlist = page.getByTestId("ticker-watchlist");
	for (const name of AGENT_NAMES) {
		await expect(
			watchlist.getByRole("button", { name: new RegExp(`^\\w+, ${name}\\b`) })
		).toBeVisible();
	}
	await expect(page.getByTestId("ticker-tape")).toBeVisible();

	await watchlist
		.getByRole("button", { name: /^\w+, Forge, working: / })
		.click();
	const detail = page.getByTestId("ticker-detail");
	await expect(detail).toHaveAttribute("data-agent-id", "agent-forge");

	await detail
		.getByRole("button", { exact: true, name: "Message Forge" })
		.click();
	await expect(portLog(page)).toContainText(
		'startThread({"agentId":"agent-forge"})'
	);

	await detail
		.getByRole("button", { name: /^Open Rebuild the landing hero: Working,/ })
		.click();
	await expect(portLog(page)).toContainText("openThread(thread-hero)");
	const panel = page.getByTestId("ticker-thread-panel");
	await expect(panel).toBeVisible();
	await expect(panel.getByTestId("stub-thread-view")).toContainText(
		"preloading it"
	);
	await shot(page, "ticker");
});

test("Focus: one card at a time, J to step, Open to work the thread", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "focus" }));
	const focus = page.getByTestId("interface-focus");
	await expect(focus).toHaveAttribute("data-state", "card");
	const card = page.getByTestId("focus-card");
	await expect(card).toBeVisible();
	await expect(focus.getByRole("navigation", { name: "Queue" })).toBeVisible();
	const heading = card.getByRole("heading").first();
	const first = (await heading.textContent()) ?? "";
	expect(THREAD_TITLES).toContain(first);

	await page.keyboard.press("j");
	await expect(heading).not.toHaveText(first);
	const second = (await heading.textContent()) ?? "";
	expect(THREAD_TITLES).toContain(second);
	await page.keyboard.press("k");
	await expect(heading).toHaveText(first);

	await card.getByRole("button", { name: "Open" }).click();
	await expect(portLog(page)).toContainText("openThread(");
	await expect(focus).toHaveAttribute("data-state", "open");
	await expect(
		page.getByTestId("focus-thread").getByTestId("stub-thread-view")
	).toContainText(first);
	await shot(page, "focus");
});

/** WebGL under SwiftShader compiles shaders and draws its first frame slowly. */
const SCENE_TIMEOUT = 60_000;

test("Aquarium: a 3D reef with a creature per agent, messaging one, opening its thread", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "aquarium" }));
	const aquarium = page.getByTestId("interface-aquarium");
	await expect(aquarium).toBeVisible();
	await expect(page.getByTestId("aquarium-summary")).toBeVisible();
	await expect(page.getByTestId("aquarium-tank")).toBeVisible();
	// The 3D reef mounted (a name plate per creature) and drew its first frame
	// (the filling state gave way to the water).
	await expect(page.locator("[data-plate]")).toHaveCount(AGENT_NAMES.length, {
		timeout: SCENE_TIMEOUT,
	});
	await expect(page.getByTestId("aquarium-filling")).toHaveCount(0, {
		timeout: SCENE_TIMEOUT,
	});

	// The creature list is the tank's keyboard and screen-reader path: one
	// button per agent from the snapshot.
	const tank = aquarium.getByRole("list", { name: "Agents in the tank" });
	for (const name of AGENT_NAMES) {
		await expect(
			tank.getByRole("button", {
				name: new RegExp(`^${name}, .*, (working|idle), \\d+ threads?`),
			})
		).toHaveCount(1);
	}

	await aquarium
		.getByRole("button", { exact: true, name: "New thread" })
		.click();
	await expect(portLog(page)).toContainText("startThread({})");

	const forge = tank.getByRole("button", { name: /^Forge, .*, working, / });
	await forge.focus();
	await page.keyboard.press("Enter");
	const panel = page.getByTestId("aquarium-panel");
	await expect(panel).toHaveAttribute("data-view", "agent");
	await expect(
		aquarium.getByRole("complementary", { name: "Forge" })
	).toBeVisible();

	// Messaging the creature starts a thread addressed to its agent.
	await panel
		.getByRole("textbox", { name: "Message Forge" })
		.fill("Tighten the hero spacing");
	await panel.getByRole("button", { exact: true, name: "Send" }).click();
	await expect(portLog(page)).toContainText(
		'startThread({"agentId":"agent-forge","prompt":"Tighten the hero spacing"})'
	);
	await expect(panel).toHaveAttribute("data-view", "thread");
	await expect(panel.getByTestId("stub-thread-view")).toContainText(
		"Tighten the hero spacing"
	);

	await panel.getByRole("button", { name: "Back to Forge" }).click();
	await expect(portLog(page)).toContainText("closeThread()");
	await expect(panel).toHaveAttribute("data-view", "agent");

	await panel
		.getByRole("button", { name: "Open Rebuild the landing hero" })
		.click();
	await expect(portLog(page)).toContainText("openThread(thread-hero)");
	await expect(panel).toHaveAttribute("data-view", "thread");
	await expect(panel.getByTestId("stub-thread-view")).toContainText(
		"preloading it"
	);
	await expect(hostView(page)).toHaveCount(1);
	await shot(page, "aquarium");
});

test("Planets: a 3D system with a planet per agent, messaging one, opening a moon", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "planets" }));
	const planets = page.getByTestId("interface-planets");
	await expect(planets).toBeVisible();
	const summary = page.getByTestId("planets-summary");
	await expect(summary).toBeVisible();
	await expect(summary.getByRole("definition").first()).toHaveText(
		String(AGENT_NAMES.length)
	);
	await expect(
		planets.getByRole("application", {
			name: /^Solar system: you at the centre, 6 planets, 2 working, /,
		})
	).toBeVisible();
	// The 3D scene mounted (a plate per planet) and drew its first frame (the
	// placeholder sketch faded out).
	await expect(page.locator("[data-planet-plate]")).toHaveCount(
		AGENT_NAMES.length,
		{ timeout: SCENE_TIMEOUT }
	);
	await expect(page.getByTestId("planets-placeholder")).toHaveCount(0, {
		timeout: SCENE_TIMEOUT,
	});

	// The HUD list is the scene's keyboard and screen-reader path: the star,
	// then one button per agent from the snapshot.
	const bodies = planets.getByRole("list", {
		name: "Bodies in orbit, innermost first",
	});
	await expect(
		bodies.getByRole("button", { name: /^You, the star\. / })
	).toBeVisible();
	for (const name of AGENT_NAMES) {
		await expect(
			bodies.getByRole("button", {
				name: new RegExp(`^${name}, \\d+ threads?`),
			})
		).toBeVisible();
	}

	await planets
		.getByRole("button", { exact: true, name: "New thread" })
		.click();
	await expect(portLog(page)).toContainText("startThread({})");

	await bodies.getByRole("button", { name: /^Forge, .*working/ }).click();
	const panel = page.getByTestId("planets-panel");
	await expect(panel).toHaveAttribute("data-view", "planet");
	await expect(
		planets.getByRole("complementary", { name: "Forge" })
	).toBeVisible();

	// Messaging the planet starts a thread addressed to its agent.
	await panel
		.getByRole("textbox", { name: "Message Forge" })
		.fill("Tighten the hero spacing");
	await panel.getByRole("button", { exact: true, name: "Send" }).click();
	await expect(portLog(page)).toContainText(
		'startThread({"agentId":"agent-forge","prompt":"Tighten the hero spacing"})'
	);
	await expect(panel).toHaveAttribute("data-view", "thread");
	await expect(panel.getByTestId("stub-thread-view")).toContainText(
		"Tighten the hero spacing"
	);

	await panel.getByRole("button", { name: "Back to Forge" }).click();
	await expect(portLog(page)).toContainText("closeThread()");
	await expect(panel).toHaveAttribute("data-view", "planet");

	await panel
		.getByRole("button", { name: "Open Rebuild the landing hero" })
		.click();
	await expect(portLog(page)).toContainText("openThread(thread-hero)");
	await expect(panel).toHaveAttribute("data-view", "thread");
	await expect(panel.getByTestId("stub-thread-view")).toContainText(
		"preloading it"
	);
	await expect(hostView(page)).toHaveCount(1);
	await shot(page, "planets");
});
