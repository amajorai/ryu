// Real-browser proof for the eight layout interfaces — Board, Inbox, Graph,
// Timeline, Messenger, Terminal, Arena and Desk — mounted by
// `e2e/harness/interfaces-story.{html,tsx}` from the REAL renderers in
// `packages/blocks/src/desktop/interfaces/`.
//
// The story is the host: one fixture snapshot (six agents, the "Launch Crew"
// team, the "Website Redesign" project, ten threads covering every status),
// an InterfacePort implemented in local state, and a labelled stub in place of
// the desktop's chat page (`threadView`). Every port call is echoed into the
// `port-log` output, so each test proves the renderer acted through the port.
//
// Contract asserted per layout: its key content renders from the snapshot,
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
// The story has no thread nobody has written in, and the board drops an empty
// "Not started" lane, so these are the lanes it shows.
const STATUS_LABELS = [
	"Needs attention",
	"Your turn",
	"Working",
	"Waiting on agent",
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

/**
 * Pick a grouping from the Board header's Display menu (a popover outside the
 * board's own tree), then close the menu.
 */
async function groupBoardBy(page: Page, label: string): Promise<void> {
	await page
		.getByTestId("interface-board")
		.getByRole("button", { name: "Display" })
		.click();
	await page
		.getByRole("group", { name: "Group board by" })
		.getByRole("button", { name: label })
		.click();
	await page.keyboard.press("Escape");
}

test("Board: status lanes, the Agent toggle, and a card opening its thread", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "board" }));
	const board = page.getByTestId("interface-board");
	await expect(board).toBeVisible();
	await expect(board).toContainText("10 threads · 2 working");

	const lanes = board.getByRole("region", { name: "Threads by status" });
	await expect(lanes.getByRole("heading", { level: 2 })).toHaveCount(
		STATUS_LABELS.length
	);
	for (const label of STATUS_LABELS) {
		await expect(
			lanes.getByRole("heading", { name: new RegExp(`^${label}\\s*,`) })
		).toBeVisible();
	}
	await expect(
		lanes.getByRole("button", { name: "Audit lockfile advisories" })
	).toBeVisible();

	// Grouping by agent gives every agent a lane, plus Unassigned.
	await groupBoardBy(page, "Agent");
	const byAgent = board.getByRole("region", { name: "Threads by agent" });
	await expect(byAgent).toBeVisible();
	for (const name of [...AGENT_NAMES, "Unassigned"]) {
		await expect(
			byAgent.getByRole("heading", { name: new RegExp(`^${name}\\s*,`) })
		).toBeVisible();
	}

	await byAgent
		.getByRole("button", { name: "Rebuild the landing hero" })
		.click();
	await expect(portLog(page)).toContainText("openThread(thread-hero)");
	const panel = page.getByTestId("board-thread-panel");
	await expect(panel).toBeVisible();
	await expect(panel.getByTestId("stub-thread-view")).toContainText(
		"preloading it"
	);
	await shot(page, "board");

	await panel.getByRole("button", { name: "Close thread" }).click();
	await expect(portLog(page)).toContainText("closeThread()");
	await expect(panel).toBeHidden();
});

test("Board list: sections, J/K, project grouping, filters, and Mod+Shift+K", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "board", view: "list" }));
	const board = page.getByTestId("interface-board");
	const list = board.getByRole("region", { name: "Threads by status" });
	await expect(list).toBeVisible();
	for (const label of STATUS_LABELS) {
		await expect(list.getByRole("heading", { name: label })).toBeVisible();
	}

	// One Tab stop; J and K walk the rows in order.
	const firstRow = list.getByRole("button", {
		name: "Audit lockfile advisories",
	});
	await firstRow.focus();
	await page.keyboard.press("j");
	await expect(
		list.getByRole("button", { name: "Launch week plan" })
	).toBeFocused();
	await page.keyboard.press("k");
	await expect(firstRow).toBeFocused();

	// Collapsing a section hides its rows and keeps its count.
	const working = list.getByRole("button", { name: /^Working\s*2/ });
	await working.click();
	await expect(working).toHaveAttribute("aria-expanded", "false");
	await expect(
		list.getByRole("button", { name: "Rebuild the landing hero" })
	).toBeHidden();
	await working.click();

	// Mod+Shift+K: filter to working threads from the command menu.
	await page.keyboard.press("ControlOrMeta+Shift+K");
	const palette = page.getByRole("dialog");
	await expect(palette).toBeVisible();
	await page.keyboard.type("status working");
	await page.keyboard.press("Enter");
	await expect(palette).toBeHidden();
	await expect(board).toContainText("2 of 10 threads");
	await expect(
		board.getByRole("group", { name: "Active filters" })
	).toContainText("Status isWorking");
	await board.getByRole("button", { name: "Clear filters" }).click();
	await expect(board).toContainText("10 threads · 2 working");

	// Group by project; "+" files a new thread under the project.
	await groupBoardBy(page, "Project");
	const byProject = board.getByRole("region", { name: "Threads by project" });
	await expect(
		byProject.getByRole("heading", { name: "Website Redesign" })
	).toBeVisible();
	await expect(
		byProject.getByRole("heading", { name: "No project" })
	).toBeVisible();
	await byProject
		.getByRole("button", { name: "Rebuild the landing hero" })
		.click();
	await expect(portLog(page)).toContainText("openThread(thread-hero)");
	await expect(page.getByTestId("board-thread-panel")).toBeVisible();
	await shot(page, "board-list");
	await byProject
		.getByRole("button", { name: "New thread in Website Redesign" })
		.click();
	await expect(portLog(page)).toContainText("startThread(");
	await expect(portLog(page)).toContainText("project");
});

test("Inbox: urgency sections, J/K to move, Enter to open", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "inbox" }));
	const inbox = page.getByTestId("interface-inbox");
	await expect(inbox).toBeVisible();
	const list = inbox.getByRole("listbox", { name: "Inbox threads" });
	await expect(list.getByRole("option")).toHaveCount(10);
	await expect(page.getByTestId("inbox-summary")).toContainText("need you");
	for (const section of ["attention", "your-turn", "working", "waiting"]) {
		await expect(list.locator(`[data-section="${section}"]`)).toHaveCount(1);
	}
	// The failed audit is the most urgent row, and the list takes focus.
	const rows = list.locator("[data-inbox-row]");
	await expect(rows.first()).toHaveAttribute("data-inbox-row", "thread-audit");
	await expect(rows.first()).toBeFocused();

	const second = await rows.nth(1).getAttribute("data-inbox-row");
	await page.keyboard.press("j");
	await page.keyboard.press("j");
	await page.keyboard.press("k");
	await expect(rows.nth(1)).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(portLog(page)).toContainText(`openThread(${second})`);

	const detail = page.getByTestId("inbox-detail");
	await expect(detail).toBeVisible();
	await expect(detail.getByTestId("stub-thread-view")).toContainText(
		`· ${second}`
	);
	await shot(page, "inbox");
});

test("Graph: every agent is a node; picking one opens its side panel", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "graph" }));
	const graph = page.getByTestId("interface-graph");
	await expect(graph).toBeVisible();
	await expect(graph.locator('[data-graph-node="you"]')).toBeVisible();
	for (const name of AGENT_NAMES) {
		await expect(
			graph.locator(`[data-graph-node="agent:agent-${name.toLowerCase()}"]`)
		).toBeVisible();
	}
	await expect(
		graph.getByRole("button", { name: /^Team Launch Crew:/ })
	).toBeVisible();
	await expect(
		graph.getByRole("button", { name: /^Project Website Redesign:/ })
	).toBeVisible();

	await graph.locator('[data-graph-node="agent:agent-forge"]').click();
	const panel = page.getByRole("complementary", { name: "Forge details" });
	await expect(panel).toBeVisible();
	await expect(panel).toContainText("Full-stack engineer");
	await panel.getByRole("button", { name: /Rebuild the landing hero/ }).click();
	await expect(portLog(page)).toContainText("openThread(thread-hero)");

	const threadPanel = page.getByTestId("graph-thread-panel");
	await expect(threadPanel).toBeVisible();
	await expect(threadPanel.getByTestId("stub-thread-view")).toContainText(
		"preloading it"
	);
	// The map re-frames the thread's people beside the panel with an eased
	// pan; wait until "You" has settled clear of the panel before capturing.
	const panelLeft = (await threadPanel.boundingBox())?.x ?? 0;
	await expect
		.poll(async () => {
			const you = await graph.locator('[data-graph-node="you"]').boundingBox();
			return you ? you.x + you.width : Number.POSITIVE_INFINITY;
		})
		.toBeLessThan(panelLeft);
	await page.waitForTimeout(400);
	await shot(page, "graph");

	await threadPanel.getByRole("button", { name: "Back to Forge" }).click();
	await expect(portLog(page)).toContainText("closeThread()");
	await expect(panel).toBeVisible();
});

test("Timeline: days newest first, the Day/Week toggle, and opening an event", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "timeline" }));
	const timeline = page.getByTestId("interface-timeline");
	await expect(timeline).toBeVisible();
	const byDay = timeline.getByRole("region", { name: "Threads by day" });
	await expect(byDay).toBeVisible();
	await expect(byDay.getByRole("heading", { level: 2 }).first()).toHaveText(
		"Today"
	);
	await expect(
		byDay.getByRole("list", { name: "Threads, Today" })
	).toBeVisible();

	const scale = timeline.getByRole("group", { name: "Timeline scale" });
	await scale.getByRole("button", { name: "Week" }).click();
	const week = timeline.getByRole("region", { name: "Threads this week" });
	await expect(week).toBeVisible();
	await expect(week.getByLabel(/^Today, /).first()).toBeVisible();

	await week
		.getByRole("button", { name: /^Roll out gateway 2\.4 to production,/ })
		.click();
	await expect(portLog(page)).toContainText("openThread(thread-deploy)");
	const panel = page.getByTestId("timeline-thread-panel");
	await expect(panel).toBeVisible();
	await expect(panel.getByTestId("stub-thread-view")).toContainText(
		"Canary is at 25%"
	);
	await shot(page, "timeline");

	await scale.getByRole("button", { name: "Day" }).click();
	await expect(byDay).toBeVisible();
});

test("Messenger: agents are contacts; search filters and a contact opens", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "messenger" }));
	const messenger = page.getByTestId("interface-messenger");
	await expect(messenger).toBeVisible();
	const contacts = messenger.getByRole("list", { name: "Contacts" });
	for (const name of AGENT_NAMES) {
		await expect(
			contacts.getByRole("button", { name: new RegExp(`^${name}\\b`) })
		).toBeVisible();
	}
	await expect(
		contacts.getByRole("button", { name: /^Launch Crew \(team\)/ })
	).toBeVisible();

	const search = messenger.getByRole("searchbox", {
		name: "Search contacts and conversations",
	});
	await search.fill("gateway");
	await expect(contacts.getByRole("button")).toHaveCount(1);
	await expect(
		contacts.getByRole("button", { name: /^Delta\b/ })
	).toBeVisible();
	await search.fill("");
	await expect(
		contacts.getByRole("button", { name: /^Forge\b/ })
	).toBeVisible();

	await contacts.getByRole("button", { name: /^Forge\b/ }).click();
	await expect(portLog(page)).toContainText("openThread(thread-hero)");
	const thread = page.getByTestId("messenger-thread");
	await expect(thread.getByTestId("stub-thread-view")).toContainText(
		"preloading it"
	);
	await shot(page, "messenger");
});

test("Terminal: ls, open by number, @agent to start, unknown commands, history", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "terminal" }));
	const terminal = page.getByTestId("interface-terminal");
	await expect(terminal).toBeVisible();
	const prompt = terminal.getByRole("textbox", { name: "Terminal command" });
	await expect(prompt).toBeFocused();
	const log = terminal.getByRole("log", { name: "Terminal output" });

	await prompt.fill("ls");
	await prompt.press("Enter");
	await expect(log).toContainText("Audit lockfile advisories");
	await expect(log).toContainText("Rebuild the landing hero");
	await expect(log).toContainText("Office closed Friday");

	// `ls` lists the most urgent first, so #1 is the failed audit.
	await prompt.fill("open 1");
	await prompt.press("Enter");
	await expect(portLog(page)).toContainText("openThread(thread-audit)");
	await expect(log).toContainText("opened #1 Audit lockfile advisories");
	const pane = terminal.getByRole("region", {
		name: "Thread: Audit lockfile advisories",
	});
	await expect(pane.getByTestId("stub-thread-view")).toContainText(
		"patch release"
	);
	await shot(page, "terminal");

	await prompt.fill("frobnicate");
	await prompt.press("Enter");
	await expect(log).toContainText("ryu: command not found: frobnicate");

	await prompt.press("ArrowUp");
	await expect(prompt).toHaveValue("frobnicate");
	await prompt.press("ArrowUp");
	await expect(prompt).toHaveValue("open 1");
	await prompt.press("ArrowDown");
	await expect(prompt).toHaveValue("frobnicate");

	await prompt.fill("@atlas hi");
	await prompt.press("Enter");
	await expect(portLog(page)).toContainText(
		'startThread({"agentId":"agent-atlas","prompt":"hi"})'
	);
	// The story host opens the new thread, so the pane follows it.
	await expect(
		terminal.getByRole("region", { name: "Thread: hi" })
	).toBeVisible();
});

test("Arena: a card per agent, filter chips, Message and Open", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "arena" }));
	const arena = page.getByTestId("interface-arena");
	await expect(arena).toBeVisible();
	const wall = arena.getByRole("list", { name: "All agents" });
	for (const name of AGENT_NAMES) {
		await expect(
			wall.getByRole("button", { name: `Message ${name}` })
		).toBeVisible();
	}
	await expect(arena).toContainText("Office closed Friday");

	await arena.getByRole("button", { name: /^Working \(/ }).click();
	const working = arena.getByRole("list", { name: "Working agents" });
	await expect(working).toBeVisible();
	await expect(working.getByRole("button", { name: /^Message / })).toHaveCount(
		2
	);
	await expect(
		working.getByRole("button", { name: "Message Forge" })
	).toBeVisible();
	await expect(
		working.getByRole("button", { name: "Message Delta" })
	).toBeVisible();

	await working.getByRole("button", { name: "Message Forge" }).click();
	await expect(portLog(page)).toContainText(
		'startThread({"agentId":"agent-forge"})'
	);

	await working
		.getByRole("button", { name: "Open Delta's live thread" })
		.click();
	await expect(portLog(page)).toContainText("openThread(thread-deploy)");
	const panel = page.getByTestId("arena-thread-panel");
	await expect(panel).toBeVisible();
	await expect(panel.getByTestId("stub-thread-view")).toContainText(
		"Canary is at 25%"
	);
	await shot(page, "arena");
});

test("Desk: views filter the list, Enter opens a row, details list the agents", async ({
	page,
}) => {
	await page.goto(storyUrl({ interface: "desk" }));
	const desk = page.getByTestId("interface-desk");
	await expect(desk).toBeVisible();
	await expect(
		desk.getByRole("navigation", { name: "Desk views" })
	).toBeVisible();
	const rows = desk.locator("[data-testid^='desk-row-']");

	await desk.getByTestId("desk-view-all").click();
	await expect(rows).toHaveCount(10);
	await desk.getByTestId("desk-view-working").click();
	await expect(rows).toHaveCount(2);
	await expect(desk.getByTestId("desk-row-thread-hero")).toBeVisible();
	await expect(desk.getByTestId("desk-row-thread-deploy")).toBeVisible();

	await desk.getByTestId("desk-view-team:team-launch").click();
	await expect(rows).toHaveCount(1);
	const row = desk.getByTestId("desk-row-thread-launch-plan");
	await row.focus();
	await page.keyboard.press("Enter");
	await expect(portLog(page)).toContainText("openThread(thread-launch-plan)");
	await expect(hostView(page)).toContainText("Plan locked");

	// The details panel names every agent on the open conversation.
	const toggle = desk.getByTestId("desk-details-toggle");
	if ((await toggle.getAttribute("aria-expanded")) !== "true") {
		await toggle.click();
	}
	const details = desk.getByTestId("desk-details");
	await expect(details).toBeVisible();
	for (const name of ["Atlas", "Echo", "Forge"]) {
		await expect(
			details.getByRole("button", { name: `Open ${name}'s inbox` })
		).toBeVisible();
	}
	await shot(page, "desk");

	await toggle.click();
	await expect(details).toBeHidden();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
});
