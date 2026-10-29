// Generic browser checks for a game on the useful-state fixture (spec §7.3:
// S10, S13, S15, S17, S19, S20), run against a running interfaces story server
// (bunx vite --config e2e/harness/vite.interfaces-story.config.ts):
//
//   bun e2e/harness/useful-state-checks.ts <interface-id> [--out dir] [--wait ms]
//                                          [--cpu-throttle N] [--reduced-motion]
//                                          [--only 1280|390|views|escape]
//
// `<interface-id>` is a story renderer (farm, kitchen, ...) or `life` for the
// kit's act-layer demo island. The mode comes from the id (see MODES below):
// - list games (aquarium, planets, world-3d, world-2d) have no DOM keyboard
//   targets in the scene: their per-agent targets are list rows, and S19
//   checks the inline queue, the Queue sheet and the rows instead;
// - canvas games (world-3d, world-2d) draw the you-spot in the canvas, so
//   their slot and tray counts are not checked; they also reveal the kit's
//   ActAgentList on focus (S20);
// - seat-capped games (lobby, quiz 4; card-table 6) only need in-scene
//   targets for on-stage agents, and their off-stage tally must open the
//   Queue sheet.
// For `life` only, `--list-game`, `--agent-list` and `--capacity N` set the
// mode by hand; for a known id a flag that contradicts the table exits 2.
// The S19 layout lines (plates, plates on stage, alarms, you-spot gap) run in
// seven views, each named in its line ("S19 plates @390 touch"): 1280 and 390
// touch (the main runs), and one shot each of 390 with a mouse, the
// live-permission fixture at 1280 and 390 ("@1280 live"), and the first
// on-stage agent's thread opened at 1280 and 390 ("@390 open"; rides' open
// trip). Each measures once its plates have come to rest.
// Writes <id>-1280.png, <id>-390.png (touch) and <id>-view-<view>.png to
// `--out` (default "."), and exits 1
// when a check fails, printing which attribute to add where. A tap that is not
// actionable, or a crash in one viewport, is a FAIL line, never a lost run;
// "N/A" lines name parts a mode cannot check (canvas games' overlap/budget).
// A Tab stop inside an aria-hidden="true" layer fails as "focusable but
// aria-hidden".
//
// The page's Date starts at the fixture's now (FIXTURE_NOW_MS), and the
// browser runs in en-GB / UTC.
//
// ── The DOM contract (what each check looks for) ──────────────────────────
// data-act-agent="<agent id>"  every per-agent target: VillagerPlate (via
//                              VillagerSpec.actAgent), IsoMarker (actAgent),
//                              ActAgentList rows, and game-owned targets (town
//                              building buttons, CreatureList and "Bodies in
//                              orbit" rows, world-2d hotbar slots).
// data-iso-target              kit in-scene controls (plates, IsoMarker, act
//                              props); set by the kit.
// data-act-scene               a game's OWN in-scene overlay button that is not a
//                              kit plate (town's building, alarm, notice, tray,
//                              unread and suggestion buttons). Counts wherever
//                              data-iso-target does.
// data-you-spot="slot|tray|tally"
//                              each you-spot overlay: queue plates (asking
//                              villager plate via VillagerSpec.youSpot,
//                              IsoMarker youSpot, NoticePost), the tray item
//                              (TrayItem) and the "+N more" tally
//                              (TallyPlate scope="you"). Game-owned
//                              equivalents (aquarium, planets pointer plates)
//                              carry it too.
// data-tally="you|off"         a tally button (TallyPlate scope); "off" is the
//                              off-stage agents' tally.
// data-act-target="alarm|notice|suggestion|tally|tray|unread"
//                              each act-prop opener (ActPlateButton kind).
// data-icon-only               a plate collapsed to a glyph on a narrow stage
//                              (kit plates set it; a data-act-scene button
//                              with no visible text counts as icon-only).
// data-budgeted-overlay="<kind>"
//                              every budgeted status overlay (bubbles, tally,
//                              limit / progress / next / cue text, count
//                              stickers).
// data-agent-list              the container of a game's per-agent list rows
//                              (ActAgentList sets it, and data-act-agent-list).
// data-ask-queue="reveal|sheet", data-ask-queue-item, data-ask-card,
// data-blind-spot, data-need-you, data-queue-button
//                              the kit DOM components set these.
//
// Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium in
// containers whose preinstalled Chromium differs from the pinned Playwright.

import { chromium, type Locator, type Page } from "@playwright/test";
import {
	actOverlays,
	overlayBudget,
	stageAgents,
	youSpotSlots,
} from "@ryu/blocks/desktop/interfaces/game3d-acts.ts";
import { YOU_SPOT_GAP } from "@ryu/blocks/desktop/interfaces/game3d-plates.ts";
import { agentActs, unownedAsks } from "@ryuhq/protocol/interfaces";
import {
	FIXTURE_CLOCK,
	FIXTURE_NOW_MS,
	usefulStateFixture,
} from "@ryuhq/protocol/interfaces-fixture";

const USAGE =
	"usage: bun e2e/harness/useful-state-checks.ts <interface-id> [--out dir] [--wait ms]\n" +
	"       [--only 1280|390|views|escape]\n" +
	"       (for `life` only: [--list-game] [--agent-list] [--capacity N])";
function fail(message: string): never {
	process.stderr.write(`${message}\n${USAGE}\n`);
	process.exit(2);
}

/** Each game's mode, from spec §4.1 item 12 and §7.3. */
const LIST_GAMES = new Set(["aquarium", "planets", "world-3d", "world-2d"]);
const CANVAS_GAMES = new Set(["world-3d", "world-2d"]);
const CAPACITY: Record<string, number> = { "card-table": 6, lobby: 4, quiz: 4 };

const [id = "", ...rest] = process.argv.slice(2);
if (!id || id.startsWith("--")) {
	fail("the first argument is the interface id");
}
const flag = (name: string) => {
	const index = rest.indexOf(`--${name}`);
	return index === -1 ? undefined : rest[index + 1];
};
function readCapacity(): number | undefined {
	if (!rest.includes("--capacity")) {
		return undefined;
	}
	const raw = flag("capacity");
	if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
		fail(
			`--capacity needs a positive integer, got ${JSON.stringify(raw ?? "")}`
		);
	}
	return Number(raw);
}
const asked = {
	agentList: rest.includes("--agent-list"),
	capacity: readCapacity(),
	listGame: rest.includes("--list-game"),
};
const demo = id === "life";
const listGame = demo ? asked.listGame : LIST_GAMES.has(id);
const canvasGame = demo ? asked.agentList : CANVAS_GAMES.has(id);
const capacity = demo
	? (asked.capacity ?? Number.POSITIVE_INFINITY)
	: (CAPACITY[id] ?? Number.POSITIVE_INFINITY);
if (!demo) {
	const contradicts =
		(asked.listGame && !listGame) ||
		(asked.agentList && !canvasGame) ||
		(asked.capacity !== undefined && asked.capacity !== capacity);
	if (contradicts) {
		fail(
			`a flag contradicts ${id}'s mode (list ${listGame}, canvas ${canvasGame}, capacity ${capacity}); drop it`
		);
	}
}

const out = (flag("out") ?? ".").replace(/\/$/, "");
const base =
	process.env.INTERFACES_STORY_URL ??
	"http://127.0.0.1:5747/interfaces-story.html";
const capped = demo && Number.isFinite(capacity) ? `&capacity=${capacity}` : "";
const query = demo
	? `demo=life&phase=0${capped}`
	: `interface=${id}&fixture=useful`;
/** The same page with Ada's live permission ask (the demo's phase 1). */
const liveQuery = demo
	? `demo=life&phase=1${capped}`
	: `interface=${id}&fixture=useful&livePermission=1`;
/** The longest the scene may take to settle (`--wait ms`, default 30 s). */
const WAIT = Number(flag("wait") ?? 30_000);
/** Plates count as settled once none moves more than 1px for this long. */
const STILL_MS = 1200;
/** The longest a layout line waits for its plates to come to rest. */
const STILL_WAIT_MS = 10_000;
/** Never measure before this (the old fixed wait): the scene has mounted, fitted and parted its plates. */
const FIRST_LOOK_MS = 9000;
const SHORT = 8000;
/** `--cpu-throttle N` slows the page N× after it loads (a slow container). */
const THROTTLE = Number(flag("cpu-throttle") ?? 1);
/** `--reduced-motion` runs every check with prefers-reduced-motion: reduce. */
const REDUCED = rest.includes("--reduced-motion");
const ONLY = flag("only");
const STEPS = ["1280", "390", "views", "escape"] as const;
if (
	rest.includes("--only") &&
	!STEPS.includes(ONLY as (typeof STEPS)[number])
) {
	fail(`--only takes ${STEPS.join(", ")}, got ${JSON.stringify(ONLY ?? "")}`);
}

// ── What the fixture says should be on screen ─────────────────────────────
/** The default fixture's you-spot: Bo, the workflow gate, Ada; Gu's tray. */
const FIXTURE_YOU_SPOT = { slots: 3, trays: 1 };
const fixture = usefulStateFixture();
const actMap = agentActs(fixture, FIXTURE_NOW_MS, FIXTURE_CLOCK);
const unowned = unownedAsks(fixture);
{
	const all = [...actMap.values()];
	const allSlots = youSpotSlots(actMap, unowned).slots.length;
	const allTrays = all.filter((act) => act.act === "delivering").length;
	if (
		allSlots !== FIXTURE_YOU_SPOT.slots ||
		allTrays !== FIXTURE_YOU_SPOT.trays
	) {
		fail(
			`the fixture changed: ${allSlots} slots / ${allTrays} trays, the checks expect ${FIXTURE_YOU_SPOT.slots} / ${FIXTURE_YOU_SPOT.trays}`
		);
	}
}
const { offStage, onStage } = stageAgents(actMap, capacity);
const slots = youSpotSlots(
	actMap,
	unowned,
	onStage.map((act) => act.agentId)
);
const needsTarget = (act: (typeof onStage)[number]) =>
	act.threadId !== null || act.ask !== null || act.blockers.length > 0;
const expected = {
	agents: onStage.filter(needsTarget).map((act) => ({
		asking: act.act === "asking",
		id: act.agentId,
		label: act.ariaLabel,
		name: act.agentName,
	})),
	alarms: onStage.reduce((total, act) => total + act.blockers.length, 0),
	notices: slots.slots.filter((slot) => slot.carrier === "notice").length,
	offStage: offStage.count,
	queue: 9,
	slots: slots.slots.length,
	suggestions: onStage.filter((act) => act.suggestions.length > 0).length,
	tally: slots.overflow > 0 ? 1 : 0,
	trays: onStage.filter((act) => act.act === "delivering").length,
	unread: onStage.filter(
		(act) => act.pending.unread > 0 && act.act !== "delivering"
	).length,
};
/**
 * The fewest budgeted overlays a 390px stage of the fixture should draw: the
 * steady ones overlayBudget chooses (tallies, limit and status text). Bubbles
 * are left out because life scripts show them for a while and then drop them
 * (a delivery's bubble lasts a few seconds).
 */
const STEADY_OVERLAYS = new Set(["limit", "tally", "text"]);
const budgetItems = actOverlays(onStage, slots, offStage);
/**
 * The steady overlays overlayBudget chooses for a 390px stage `height` px
 * tall (the stage's own measured height: a squeezed stage keeps fewer).
 */
const budgetFloorAt = (height: number) =>
	[
		...overlayBudget(390, { domTargets: !listGame, height }).fill(budgetItems),
	].filter((chosen) => {
		const kind = budgetItems.find((item) => item.id === chosen)?.kind ?? "";
		return STEADY_OVERLAYS.has(kind);
	}).length;
if (expected.agents.length === 0) {
	fail(`no on-stage agents to check (capacity ${capacity})`);
}

/** Who a view's stage shows: its on-stage agents and their alarms. */
interface Cast {
	agents: { id: string; name: string }[];
	alarms: number;
}
const castOf = (acts: typeof onStage): Cast => ({
	agents: acts.map((act) => ({ id: act.agentId, name: act.agentName })),
	alarms: acts.reduce((total, act) => total + act.blockers.length, 0),
});
/** The live-permission fixture: Ada running with a live permission ask. */
const liveCast = castOf(
	stageAgents(
		agentActs(
			usefulStateFixture({ livePermission: true }),
			FIXTURE_NOW_MS,
			FIXTURE_CLOCK
		),
		capacity
	).onStage
);
/**
 * One page the S19 layout checks run on, named in each line ("S19 plates
 * @390 touch"): its width, touch or mouse, and fixture.
 */
interface View {
	cast: Cast;
	label: string;
	live: boolean;
	/** A thread opened on load (`&thread=`): the game's open-detail view. */
	opened: string | null;
	touch: boolean;
	width: number;
}
const view = (
	width: number,
	touch: boolean,
	live: boolean,
	opened: string | null = null
): View => ({
	cast: live ? liveCast : castOf(onStage),
	label: [
		String(width),
		touch ? "touch" : "",
		live ? "live" : "",
		opened ? "open" : "",
	]
		.filter(Boolean)
		.join(" "),
	live,
	opened,
	touch,
	width,
});
/**
 * The thread the "open" views open: the first on-stage agent's own thread
 * (rides shows it as the open trip; other games their thread view).
 */
const openedThread = demo
	? null
	: (onStage.find((act) => act.threadId)?.threadId ?? null);

interface Result {
	check: string;
	detail: string;
	/** Printed "N/A": a part of the check this mode cannot see. */
	na?: boolean;
	ok: boolean;
	/** Printed "WARN": worth a look, but does not fail the run. */
	warn?: boolean;
}
const results: Result[] = [];
function report(check: string, ok: boolean, detail = "") {
	results.push({ check, detail, ok });
}
function notApplicable(check: string, detail: string) {
	results.push({ check, detail, na: true, ok: true });
}
function warn(check: string, detail: string) {
	results.push({ check, detail, ok: true, warn: true });
}

// ── Page helpers, installed in every page ─────────────────────────────────
/**
 * `window.__act`: `tabbable(el)` (tabIndex ≥ 0, enabled, no inert / hidden
 * ancestor, laid out (an sr-only 1px box counts) and not visibility-hidden),
 * `ariaHidden(el)` (in an aria-hidden="true" subtree), `focusable(el)`
 * (tabbable and not aria-hidden), `name(el)` (accessible name:
 * aria-labelledby, else aria-label, else text without aria-hidden /
 * display:none / visibility:hidden parts, honouring children's aria-label),
 * `visibleText` (also without .sr-only parts) and `scene`.
 */
const PAGE_HELPERS = `(() => {
	const hidden = (el) => {
		if (!(el instanceof Element)) return false;
		if (el.getAttribute("aria-hidden") === "true") return true;
		const style = getComputedStyle(el);
		return style.display === "none" || style.visibility === "hidden";
	};
	const srOnly = (el) => {
		if (el.classList.contains("sr-only")) return true;
		const box = el.getBoundingClientRect();
		return box.width <= 1 && box.height <= 1 && getComputedStyle(el).overflow === "hidden";
	};
	const textOf = (node, honourLabels) => {
		let text = "";
		for (const child of node.childNodes) {
			if (child.nodeType === Node.TEXT_NODE) {
				text += child.textContent || "";
			} else if (child instanceof Element && !hidden(child) && (honourLabels || !srOnly(child))) {
				const label = honourLabels ? child.getAttribute("aria-label") : null;
				text += label !== null ? " " + label + " " : textOf(child, honourLabels);
			}
		}
		return text;
	};
	const squash = (text) => text.replace(/\\s+/g, " ").trim();
	window.__act = {
		tabbable(el) {
			if (!(el instanceof HTMLElement) || el.tabIndex < 0 || el.disabled) return false;
			if (el.closest("[inert], [hidden]")) return false;
			if (el.getClientRects().length === 0) return false;
			return getComputedStyle(el).visibility !== "hidden";
		},
		ariaHidden(el) {
			return el.closest('[aria-hidden="true"]') !== null;
		},
		focusable(el) {
			return window.__act.tabbable(el) && !window.__act.ariaHidden(el);
		},
		name(el) {
			const labelledBy = el.getAttribute("aria-labelledby");
			if (labelledBy) {
				return squash(labelledBy.split(/\\s+/).map((ref) => {
					const target = document.getElementById(ref);
					return target ? textOf(target, true) : "";
				}).join(" "));
			}
			const label = el.getAttribute("aria-label");
			return label !== null ? squash(label) : squash(textOf(el, true));
		},
		description(el) {
			const ids = el.getAttribute("aria-describedby");
			if (!ids) return "";
			return squash(ids.split(/\\s+/).map((ref) => {
				const target = document.getElementById(ref);
				return target ? textOf(target, false) : "";
			}).join(" "));
		},
		visibleText(el) {
			return squash(textOf(el, false));
		},
		scene(el) {
			return (el.hasAttribute("data-iso-target") || el.hasAttribute("data-act-scene")) &&
				el.closest("[data-agent-list], [data-act-agent-list], [data-ask-queue]") === null;
		},
	};
})();`;

/** What `window.__act` offers inside `page.evaluate`. */
interface ActHelpers {
	ariaHidden: (element: Element) => boolean;
	description: (element: Element) => string;
	focusable: (element: Element) => boolean;
	name: (element: Element) => string;
	scene: (element: Element) => boolean;
	tabbable: (element: Element) => boolean;
	visibleText: (element: Element) => string;
}

/** Starts the page's Date at the fixture's now; it keeps ticking. */
function fixtureClockScript(nowMs: number): string {
	return `(() => {
		const Real = Date;
		const offset = ${nowMs} - Real.now();
		class Shifted extends Real {
			constructor(...args) {
				super(...(args.length > 0 ? args : [Real.now() + offset]));
			}
			static now() {
				return Real.now() + offset;
			}
		}
		globalThis.Date = Shifted;
	})();`;
}

const browser = await chromium.launch({
	args: [
		"--use-gl=angle",
		"--use-angle=swiftshader",
		"--enable-unsafe-swiftshader",
		"--ignore-gpu-blocklist",
	],
	executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});

async function open(
	width: number,
	height: number,
	touch = false,
	live = false,
	opened: string | null = null
): Promise<Page> {
	const page = await browser.newPage({
		hasTouch: touch,
		isMobile: touch,
		locale: "en-GB",
		reducedMotion: REDUCED ? "reduce" : "no-preference",
		timezoneId: "UTC",
		viewport: { height, width },
	});
	await page.addInitScript(fixtureClockScript(FIXTURE_NOW_MS));
	await page.addInitScript(PAGE_HELPERS);
	const thread = opened ? `&thread=${encodeURIComponent(opened)}` : "";
	await page.goto(`${base}?${live ? liveQuery : query}${thread}`);
	const waited = await waitForSettle(page);
	if (!waited.settled && REDUCED) {
		// Checked anyway, but a reduced-motion stage that never settled fails
		// here, so a late or moving frame is never taken for the final one.
		report(
			`settle @${width}`,
			false,
			`plates still moving or the stage not settled after ${WAIT}ms (data-iso-fit: ${waited.stages})`
		);
	} else if (!waited.settled) {
		process.stderr.write(
			`note: ${width}px plates still moving after ${WAIT}ms (data-iso-fit: ${waited.stages}); checking anyway\n`
		);
	}
	const fps = await measureFps(page);
	tapTimeouts.set(page, tapTimeoutFor(fps));
	if (THROTTLE > 1) {
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
	}
	return page;
}

/**
 * Waits until the scene settles: villagers walking to their spots carry
 * their plates, so a fixed wait catches them mid-walk on a slow renderer.
 * Settled = every villager has finished its one-off steps (the kit's
 * `data-life-busy` on the canvas is 0, when it is there), every kit stage
 * reads `data-iso-fit` "done" ("none" with no WebGL; a page with no kit
 * stage, as town and planets draw their own canvas, settles on its plates
 * alone) and no plate has moved for STILL_MS (there must be plates: a lazy
 * scene mounts seconds after load), after at least FIRST_LOOK_MS; gives up
 * at WAIT with the stages' status.
 */
async function waitForSettle(
	page: Page
): Promise<{ ms: number; settled: boolean; stages: string }> {
	const start = Date.now();
	await page.waitForTimeout(FIRST_LOOK_MS);
	let last = "";
	let stillSince = Date.now();
	let stages = "";
	while (Date.now() - start < WAIT) {
		const { busy, canvas, fits, now } = await page.evaluate(() => ({
			canvas: document.querySelector("canvas") !== null,
			busy: [
				...document.querySelectorAll<HTMLElement>("[data-life-busy]"),
			].some((canvas) => canvas.dataset.lifeBusy !== "0"),
			// Each kit stage's plate fit and the separation after it.
			fits: [...document.querySelectorAll<HTMLElement>("[data-iso-fit]")].map(
				(stage) => stage.dataset.isoFit ?? ""
			),
			// The same plates separation parts (stagePlates), and bubbles.
			now: [
				...document.querySelectorAll(
					"[data-iso-target], [data-iso-plate], [data-you-spot], [data-life-bubble]"
				),
			]
				.map((element) => {
					const box = element.getBoundingClientRect();
					return `${Math.round(box.left)},${Math.round(box.top)}`;
				})
				.join(" "),
		}));
		stages = fits.join(", ") || "no stage";
		const fitted = fits.every((fit) => fit === "done" || fit === "none");
		if (busy || !fitted || now !== last) {
			last = now;
			stillSince = Date.now();
		} else if ((now !== "" || canvas) && Date.now() - stillSince >= STILL_MS) {
			// A scene with no plates (planets) settles on its canvas.
			return { ms: Date.now() - start, settled: true, stages };
		}
		await page.waitForTimeout(200);
	}
	return { ms: Date.now() - start, settled: false, stages };
}

/**
 * Waits (up to STILL_WAIT_MS) until no plate, you-spot or bubble has moved
 * for STILL_MS, so a layout line measures where plates rest.
 */
async function waitStill(page: Page) {
	const start = Date.now();
	let last = "";
	let stillSince = Date.now();
	while (Date.now() - start < STILL_WAIT_MS) {
		const now = await page.evaluate(() =>
			[
				...document.querySelectorAll(
					"[data-iso-target], [data-iso-plate], [data-you-spot], [data-life-bubble]"
				),
			]
				.map((element) => {
					const box = element.getBoundingClientRect();
					return `${Math.round(box.left)},${Math.round(box.top)}`;
				})
				.join(" ")
		);
		if (now !== last) {
			last = now;
			stillSince = Date.now();
		} else if (Date.now() - stillSince >= STILL_MS) {
			return;
		}
		await page.waitForTimeout(200);
	}
}

/** The first match, or null (reported as `what` missing, with a hint). */
async function need(
	check: string,
	locator: Locator,
	what: string,
	hint = ""
): Promise<Locator | null> {
	try {
		await locator.first().waitFor({ timeout: SHORT });
		return locator.first();
	} catch {
		report(check, false, `missing: ${what}${hint ? ` (${hint})` : ""}`);
		return null;
	}
}

/** A Playwright error's first line plus its last call-log line (the why). */
function brief(message: string): string {
	const lines = message
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const last = lines.at(-1) ?? "";
	return lines.length > 1 && last !== lines[0]
		? `${lines[0]} … ${last.slice(0, 160)}`
		: (lines[0] ?? "");
}

/** Each page's tap timeout, from its measured frame rate. */
const tapTimeouts = new WeakMap<Page, number>();

/** The page's frame rate over 2 s (requestAnimationFrame callbacks). */
function measureFps(page: Page): Promise<number> {
	return page.evaluate(async () => {
		let frames = 0;
		let running = true;
		const tick = () => {
			frames += 1;
			if (running) {
				requestAnimationFrame(tick);
			}
		};
		const start = performance.now();
		requestAnimationFrame(tick);
		await new Promise((resolve) => setTimeout(resolve, 2000));
		running = false;
		return frames / ((performance.now() - start) / 1000);
	});
}

/**
 * How long a tap may take: SHORT on a real GPU, and about a dozen frames on
 * a slow software renderer (Playwright waits for the target to be stable
 * over frames), capped at 20 s. A slow renderer is not a failed tap.
 */
function tapTimeoutFor(fps: number): number {
	if (!(fps > 0)) {
		return 20_000;
	}
	return Math.min(20_000, Math.max(SHORT, Math.round((12 / fps) * 1000)));
}

/** Taps `locator`; a tap that is not actionable is reported, not thrown. */
async function tap(
	check: string,
	locator: Locator,
	what: string
): Promise<boolean> {
	try {
		await locator.tap({ timeout: tapTimeouts.get(locator.page()) ?? SHORT });
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		report(check, false, `tap failed: ${what} (${brief(message)})`);
		return false;
	}
}

/**
 * Closes the open card with its Close button and waits for it to go, then
 * drops focus: the card hands it back to its opener (a reveal-queue button),
 * and a focused reveal strip covers the top of the stage.
 */
async function closeCard(check: string, page: Page) {
	const card = page.locator("[data-ask-card]");
	try {
		if ((await card.count()) > 0) {
			await settled(page, "[data-ask-card]");
			await card
				.getByRole("button", { exact: true, name: "Close" })
				.click({ timeout: SHORT });
			await card.waitFor({ state: "detached", timeout: 15_000 });
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		report(check, false, `closing the card failed (${brief(message)})`);
	}
	await page.evaluate(() =>
		(document.activeElement as HTMLElement | null)?.blur()
	);
}

/**
 * Waits for the dialog around `selector` (the Queue sheet, a card) to finish
 * its open animation: a tap while it still slides in is dropped, which on a
 * slow machine reads as a missing card.
 */
async function settled(page: Page, selector: string) {
	await page
		.locator(selector)
		.first()
		.evaluate(
			async (element) => {
				const root = element.closest("[role='dialog']") ?? element;
				const deadline = performance.now() + 15_000;
				while (performance.now() < deadline) {
					const running = root.getAnimations({ subtree: true });
					if (
						running.length === 0 &&
						!root.hasAttribute("data-starting-style")
					) {
						return;
					}
					await Promise.all(
						running.map((animation) =>
							animation.finished.catch(() => undefined)
						)
					);
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			},
			undefined,
			{ timeout: 20_000 }
		)
		.catch(() => undefined);
}

/** Closes the Queue sheet if one is open, so the next tap is not blocked. */
async function closeSheet(page: Page) {
	if ((await page.locator("[data-ask-queue='sheet']").count()) === 0) {
		return;
	}
	await page.keyboard.press("Escape");
	await page
		.locator("[data-ask-queue='sheet']")
		.first()
		.waitFor({ state: "detached", timeout: SHORT })
		.catch(() => undefined);
}

/** Tabs from the top of the page until focus lands inside `selector`. */
async function tabInto(page: Page, selector: string): Promise<boolean> {
	await page.evaluate(() =>
		(document.activeElement as HTMLElement | null)?.blur()
	);
	for (let press = 0; press < 60; press++) {
		await page.keyboard.press("Tab");
		const inside = await page.evaluate(
			(target) => document.activeElement?.closest(target) !== null,
			selector
		);
		if (inside) {
			return true;
		}
	}
	return false;
}

/** The revealed container is visible and the focused control has a ring. */
function revealed(
	page: Page,
	selector: string
): Promise<{ focused?: string; ring: boolean; visible: boolean }> {
	return page.evaluate(async (target) => {
		// Two frames, so a focus ring's (reduced-motion) transition has landed.
		await new Promise((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(resolve))
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const box = document.querySelector(target)?.getBoundingClientRect();
		const active = document.activeElement as HTMLElement | null;
		const style = active ? getComputedStyle(active) : null;
		const ring = style
			? style.outlineStyle !== "none" && style.outlineWidth !== "0px"
			: false;
		return {
			// What lacked the ring, so a failure says where to look.
			...(ring
				? {}
				: {
						focused: `${active?.tagName.toLowerCase() ?? "none"} "${(active?.getAttribute("aria-label") ?? active?.textContent ?? "").slice(0, 30)}" outline ${style?.outlineStyle ?? "-"} ${style?.outlineWidth ?? "-"}`,
					}),
			ring,
			visible: (box?.width ?? 0) > 40 && (box?.height ?? 0) > 20,
		};
	}, selector);
}

interface Target {
	agent: string;
	description: string;
	focusable: boolean;
	/** A Tab stop inside an aria-hidden="true" layer. */
	hiddenStop: boolean;
	iconOnly: boolean;
	name: string;
	pressed: boolean;
	scene: boolean;
	youSpot: boolean;
}

/** Every per-agent target outside the ask queue. */
function readTargets(page: Page): Promise<Target[]> {
	return page.evaluate(() => {
		const act = (window as unknown as { __act: ActHelpers }).__act;
		return [...document.querySelectorAll<HTMLElement>("[data-act-agent]")]
			.filter((element) => element.closest("[data-ask-queue]") === null)
			.map((element) => ({
				agent: element.dataset.actAgent ?? "",
				description: act.description(element),
				focusable: act.focusable(element),
				hiddenStop: act.tabbable(element) && act.ariaHidden(element),
				iconOnly:
					element.hasAttribute("data-icon-only") ||
					(element.hasAttribute("data-act-scene") &&
						act.visibleText(element).length <= 2),
				name: act.name(element),
				pressed: element.hasAttribute("aria-pressed"),
				scene: act.scene(element),
				youSpot: element.hasAttribute("data-you-spot"),
			}));
	});
}

interface SceneStop {
	agent: string | null;
	hidden: boolean;
	name: string;
	/** An act-prop opener (data-act-target): S19 counts those per kind. */
	prop: boolean;
}

/**
 * Every Tab stop in the scene ([data-iso-target], [data-act-scene],
 * [data-iso-focus], outside the queue and agent lists), tagged or not.
 */
function readSceneStops(page: Page): Promise<SceneStop[]> {
	return page.evaluate(() => {
		const act = (window as unknown as { __act: ActHelpers }).__act;
		return [
			...document.querySelectorAll<HTMLElement>(
				"[data-iso-target], [data-act-scene], [data-iso-focus]"
			),
		]
			.filter(
				(element) =>
					element.closest(
						"[data-agent-list], [data-act-agent-list], [data-ask-queue]"
					) === null && act.tabbable(element)
			)
			.map((element) => ({
				agent: element.dataset.actAgent ?? null,
				hidden: act.ariaHidden(element),
				name: act.name(element),
				prop: element.hasAttribute("data-act-target"),
			}));
	});
}

/** `name` is about the agent called `agentName` ("Ada", "Ada asks: …"). */
function namesAgent(name: string, agentName: string): boolean {
	if (!name.startsWith(agentName)) {
		return false;
	}
	const next = name.charAt(agentName.length);
	return next === "" || /[\s,.:'’]/.test(next);
}

/** How far (px, on both axes) two text plates may overlap. */
const PLATE_SLACK = 3;

/**
 * Every pair of visible in-scene plates with words ([data-iso-plate],
 * [data-iso-target], and villagers' speech bubbles, which hang outside their
 * plate) that overlap by more than PLATE_SLACK px. A plate and its own
 * bubble never count.
 */
function plateOverlaps(page: Page): Promise<string[]> {
	return page.evaluate((slack) => {
		const act = (window as unknown as { __act: ActHelpers }).__act;
		const plates = [
			...document.querySelectorAll<HTMLElement>(
				"[data-iso-plate], [data-iso-target], [data-life-bubble]"
			),
		]
			.filter(
				(element) =>
					element.closest(
						"[data-agent-list], [data-act-agent-list], [data-ask-queue]"
					) === null &&
					(element.hasAttribute("data-life-bubble") ||
						element.parentElement?.closest("[data-iso-plate]") == null)
			)
			.map((element) => ({
				box: element.getBoundingClientRect(),
				element,
				text: act.visibleText(element),
			}))
			.filter(
				(plate) =>
					plate.text.length > 0 && plate.box.width > 1 && plate.box.height > 1
			);
		const pairs: string[] = [];
		for (let i = 0; i < plates.length; i++) {
			for (let j = i + 1; j < plates.length; j++) {
				const a = plates[i];
				const b = plates[j];
				if (
					!(a && b) ||
					a.element.contains(b.element) ||
					b.element.contains(a.element)
				) {
					continue;
				}
				const x =
					Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
				const y =
					Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
				if (x > slack && y > slack) {
					pairs.push(
						`"${a.text.slice(0, 24)}" × "${b.text.slice(0, 24)}" (${Math.round(x)}×${Math.round(y)}px)`
					);
				}
			}
		}
		return pairs;
	}, PLATE_SLACK);
}

/**
 * Every visible in-scene plate (and speech bubble) that reaches past its
 * stage's edge by more than PLATE_SLACK px, where the stage cuts it off.
 */
function platesOffStage(page: Page): Promise<string[]> {
	return page.evaluate((slack) => {
		const act = (window as unknown as { __act: ActHelpers }).__act;
		const off: string[] = [];
		for (const element of document.querySelectorAll<HTMLElement>(
			"[data-iso-plate], [data-iso-target], [data-life-bubble]"
		)) {
			const stage = element.closest("[data-testid='iso-stage']");
			const box = element.getBoundingClientRect();
			const text = act.visibleText(element);
			if (!stage || box.width <= 1 || box.height <= 1 || text.length === 0) {
				continue;
			}
			const room = stage.getBoundingClientRect();
			const past = Math.max(
				room.left - box.left,
				box.right - room.right,
				room.top - box.top,
				box.bottom - room.bottom
			);
			if (past > slack) {
				off.push(
					`"${text.slice(0, 24)}" (${Math.round(past)}px past the edge)`
				);
			}
		}
		return off;
	}, PLATE_SLACK);
}

const ASK_SUFFIX = "Answer their ask.";
/**
 * Named by the act sentence: exactly it, or it plus one short action clause
 * ("Open their desk", "start a new thread here", "Open its card."). An asking
 * agent's target ends exactly "Answer their ask."; no one else's does.
 */
function namedBy(name: string, label: string, asking: boolean): boolean {
	if (asking) {
		return name === `${label} ${ASK_SUFFIX}`;
	}
	if (name === label) {
		return true;
	}
	if (!name.startsWith(`${label} `)) {
		return false;
	}
	const clause = name.slice(label.length + 1);
	return (
		clause !== ASK_SUFFIX && clause.length <= 40 && /^[^.!?]+\.?$/.test(clause)
	);
}

/**
 * S19 plates: no two in-scene text plates overlap at 1280; at 390 overlaps
 * are a WARN that lists the pairs (canvas games: N/A).
 */
async function checkPlates(page: Page, { label, width }: View) {
	const check = `S19 plates @${label}`;
	if (canvasGame) {
		notApplicable(check, "plates are drawn in the canvas");
		return;
	}
	const off = await platesOffStage(page);
	report(
		`S19 plates on stage @${label}`,
		off.length === 0,
		off.length === 0
			? ""
			: `${off.length} plates cut off by the stage edge (plate separation keeps kit plates inside; move the prop): ${off.slice(0, 6).join("; ")}`
	);
	const pairs = await plateOverlaps(page);
	const detail = `${pairs.length} overlapping text plates (join plate separation with data-iso-plate, or move the prop): ${pairs.slice(0, 6).join("; ")}`;
	if (pairs.length === 0) {
		report(check, true);
	} else if (width < 640) {
		// A phone stage holds every plate at icon size and plate separation caps
		// its nudges, so a dense cast can still touch: listed, not failed.
		warn(check, detail);
	} else {
		report(check, false, detail);
	}
}

/**
 * S19 alarms: no alarm plate may cover a figure or a name plate, its own
 * agent's (the blocked pose it explains) or a neighbour's. A figure is the
 * box between the kit's head and feet markers (`data-act-figure`), or, for
 * a game without them, the box under its name plate. Every on-stage
 * agent's figure and plate is compared with every alarm; fewer measured
 * alarms than the fixture has is a WARN, not a PASS.
 */
async function checkAlarmCover(page: Page, { cast, label }: View) {
	const check = `S19 alarms @${label}`;
	if (canvasGame) {
		notApplicable(check, "figures are drawn in the canvas");
		return;
	}
	const { agents } = cast;
	const result = await page.evaluate(
		({ agents, slack }) => {
			interface Box {
				bottom: number;
				left: number;
				right: number;
				top: number;
			}
			const scene = (element: Element) =>
				element.closest(
					"[data-agent-list], [data-act-agent-list], [data-ask-queue]"
				) === null;
			const box = (element: Element): Box => element.getBoundingClientRect();
			const named = (label: string, name: string) =>
				label === name || /^[\s,.:'’·]/.test(label.slice(name.length))
					? label.startsWith(name)
					: false;
			const plates = [
				...document.querySelectorAll<HTMLElement>(
					"[data-iso-target], [data-iso-plate]"
				),
			].filter(
				(element) =>
					scene(element) &&
					!element.hasAttribute("data-act-target") &&
					element.getBoundingClientRect().width > 0
			);
			const marks: { box: Box; what: string }[] = [];
			let probed = 0;
			for (const agent of agents) {
				const plate =
					plates.find((element) => element.dataset.actAgent === agent.id) ??
					plates.find((element) =>
						named(
							(
								element.getAttribute("aria-label") ??
								element.textContent ??
								""
							).trim(),
							agent.name
						)
					);
				const head = document.querySelector(
					`[data-act-figure="${CSS.escape(agent.id)}"][data-figure-edge="head"]`
				);
				const feet = document.querySelector(
					`[data-act-figure="${CSS.escape(agent.id)}"][data-figure-edge="feet"]`
				);
				if (head && feet) {
					probed += 1;
					const top = head.getBoundingClientRect();
					const bottom = feet.getBoundingClientRect();
					const tall = Math.max(8, bottom.top - top.top);
					const middle = (top.left + bottom.left) / 2;
					const half = Math.max(12, tall * 0.28);
					marks.push({
						box: {
							bottom: bottom.top,
							left: middle - half,
							right: middle + half,
							top: top.top,
						},
						what: `${agent.name}'s figure`,
					});
				} else if (plate) {
					const at = box(plate);
					marks.push({
						box: {
							bottom: at.bottom + (at.bottom - at.top) * 2.5,
							left: at.left,
							right: at.right,
							top: at.bottom,
						},
						what: `${agent.name}'s figure (estimated)`,
					});
				}
				if (plate) {
					marks.push({ box: box(plate), what: `${agent.name}'s name plate` });
				}
			}
			const alarms = [
				...document.querySelectorAll<HTMLElement>("[data-act-target='alarm']"),
			].filter(
				(element) => scene(element) && element.getBoundingClientRect().width > 0
			);
			const covers: string[] = [];
			let compared = 0;
			for (const alarm of alarms) {
				const label = alarm.getAttribute("aria-label") ?? "";
				const at = box(alarm);
				for (const mark of marks) {
					compared += 1;
					const x =
						Math.min(at.right, mark.box.right) -
						Math.max(at.left, mark.box.left);
					const y =
						Math.min(at.bottom, mark.box.bottom) -
						Math.max(at.top, mark.box.top);
					if (x > slack && y > slack) {
						covers.push(
							`"${label.slice(0, 28)}" covers ${mark.what} (${Math.round(x)}×${Math.round(y)}px)`
						);
					}
				}
			}
			return {
				alarms: alarms.length,
				compared,
				covers,
				figures: marks.length,
				probed,
			};
		},
		{ agents, slack: PLATE_SLACK }
	);
	const counted = `${result.alarms}/${cast.alarms} alarms × ${result.figures} figures and plates (${result.probed} probed), ${result.compared} pairs`;
	if (result.covers.length > 0) {
		warn(
			check,
			`${result.covers.slice(0, 6).join("; ")} — ${counted} (move layout.alarms to the figure's open side, or set StationLayout.alarmSide/alarmRows)`
		);
	} else if (result.alarms < cast.alarms || result.compared === 0) {
		warn(check, `not all alarms measured: ${counted}`);
	} else {
		report(check, true, counted);
	}
}

/**
 * S19 you-spot gap: no two you-spot plates (queue slots, trays, the tally)
 * overlap or sit closer than YOU_SPOT_GAP - 0.5px (touch targets; the
 * half px is rounding).
 */
async function checkYouSpotGap(page: Page, { label }: View) {
	const check = `S19 you-spot gap @${label}`;
	if (canvasGame) {
		notApplicable(check, "you-spots are drawn in the canvas");
		return;
	}
	const { overlaps, spots, tight } = await page.evaluate((minGap) => {
		const boxes = [...document.querySelectorAll("[data-you-spot]")]
			.map((element) => element.getBoundingClientRect())
			.filter((box) => box.width > 0 && box.height > 0);
		let overlapping = 0;
		const close: number[] = [];
		for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) {
				const a = boxes[i];
				const b = boxes[j];
				if (!(a && b)) {
					continue;
				}
				const gap = Math.max(
					b.left - a.right,
					a.left - b.right,
					b.top - a.bottom,
					a.top - b.bottom
				);
				if (gap < 0) {
					overlapping += 1;
				}
				if (gap < minGap) {
					close.push(Math.round(gap * 10) / 10);
				}
			}
		}
		return { overlaps: overlapping, spots: boxes.length, tight: close };
	}, YOU_SPOT_GAP - 0.5);
	report(
		check,
		tight.length === 0,
		tight.length === 0
			? `${spots} you-spots`
			: `you-spot plates closer than ${YOU_SPOT_GAP - 0.5}px: ${tight.join(", ")}px, ${overlaps} overlapping (YOU_SPOT_GAP is ${YOU_SPOT_GAP})`
	);
}

/** The S19 layout lines for one view: plates, plates on stage, alarms, you-spot gap. */
async function checkLayout(page: Page, at: View) {
	// Measure settled plates only: a plate mid-slide can read closer than
	// it rests.
	await waitStill(page);
	await checkPlates(page, at);
	await checkAlarmCover(page, at);
	await checkYouSpotGap(page, at);
}

/**
 * S12 (reduced motion): two captures 2 s apart are the same picture, so a
 * reduced-motion frame really holds still.
 */
async function checkStill(page: Page, { label }: View) {
	if (!REDUCED) {
		return;
	}
	const first = await page.screenshot();
	await page.waitForTimeout(2000);
	const second = await page.screenshot();
	report(
		`S12 still @${label}`,
		first.equals(second),
		first.equals(second)
			? ""
			: "the frame changed within 2 s under reduced motion"
	);
}

// ── 1280 × 800 ─────────────────────────────────────────────────────────────
async function wide() {
	const page = await open(1280, 800);
	try {
		await checkWide(page);
	} finally {
		await page.close();
	}
}

async function checkWide(page: Page) {
	await page.screenshot({ path: `${out}/${id}-1280.png` });
	const at = view(1280, false, false);
	await checkLayout(page, at);
	await checkStill(page, at);

	// S10: the blind-spot caption, visible, and never "all clear".
	const caption = await need(
		"S10",
		page.locator("[data-blind-spot]"),
		"the blind-spot caption",
		"render BlindSpotCaption"
	);
	if (caption) {
		const text = await caption.textContent();
		const shown = await caption.evaluate((element) => {
			const box = element.getBoundingClientRect();
			return (
				box.width > 1 && box.height > 1 && element.closest(".sr-only") === null
			);
		});
		const body = (await page.locator("body").textContent()) ?? "";
		report(
			"S10",
			text === "Some questions and prompts only show in their chat" &&
				shown &&
				!/all clear/i.test(body),
			JSON.stringify({ shown, text })
		);
	}

	// S17: exactly one tab-reachable in-scene target per on-stage agent with a
	// thread, ask or blocker, named by its act sentence (asking: no
	// aria-pressed). List games: a reachable row named or described by it.
	const targets = await readTargets(page);
	const stops = await readSceneStops(page);
	const wrong: string[] = [];
	const hiddenNames = new Set([
		...targets.filter((target) => target.hiddenStop).map((t) => t.name),
		...stops.filter((stop) => stop.hidden).map((stop) => stop.name),
	]);
	for (const name of hiddenNames) {
		wrong.push(`"${name.slice(0, 60)}": focusable but aria-hidden`);
	}
	const shownStops = stops.filter((stop) => !stop.hidden);
	if (listGame && shownStops.length > 0) {
		wrong.push(
			`${shownStops.length} in-scene Tab stops (list games keep scene plates at tabIndex -1): ${shownStops
				.slice(0, 4)
				.map((stop) => `"${stop.name.slice(0, 40)}"`)
				.join(", ")}`
		);
	}
	for (const agent of expected.agents) {
		const mine = targets.filter(
			(target) => target.agent === agent.id && target.focusable
		);
		if (listGame) {
			const outside = mine.filter((target) => !target.scene);
			const row = outside.find(
				(target) =>
					namedBy(target.name, agent.label, agent.asking) ||
					target.description === agent.label
			);
			if (!row) {
				wrong.push(
					`${agent.name}: no reachable row named or described by its act sentence (data-act-agent on the row)`
				);
			} else if (agent.asking && row.pressed) {
				wrong.push(`${agent.name}: asking row has aria-pressed`);
			}
			continue;
		}
		const scene = mine.filter((target) => target.scene);
		const plates = shownStops.filter((stop) => !stop.prop);
		const tagged = plates.filter((stop) => stop.agent === agent.id);
		const untagged = plates.filter(
			(stop) => stop.agent === null && namesAgent(stop.name, agent.name)
		);
		for (const stop of untagged) {
			wrong.push(
				`${agent.name}: untagged in-scene Tab stop "${stop.name.slice(0, 40)}" (data-act-agent, or tabIndex -1)`
			);
		}
		const stopCount = tagged.length + untagged.length;
		if (stopCount > 1) {
			wrong.push(`${agent.name}: ${stopCount} in-scene Tab stops (want one)`);
		}
		const plate = scene.find((target) =>
			namedBy(target.name, agent.label, agent.asking)
		);
		if (!plate) {
			const got = scene[0]
				? ` (got "${scene[0].name.slice(0, 60)}")`
				: " (data-act-agent plus data-iso-target or data-act-scene)";
			wrong.push(
				`${agent.name}: no in-scene target named by its act sentence${got}`
			);
		} else if (agent.asking && plate.pressed) {
			wrong.push(`${agent.name}: asking target has aria-pressed`);
		}
	}
	report("S17", wrong.length === 0, wrong.join("; "));

	// S20: Tab reaches the ask queue, which shows with a focus ring; canvas
	// games also reveal their ActAgentList.
	const queueReached = await tabInto(page, "[data-ask-queue='reveal']");
	const queueShown = queueReached
		? await revealed(page, "[data-ask-queue='reveal']")
		: { ring: false, visible: false };
	let listShown = { reached: true, ring: true, visible: true };
	if (canvasGame) {
		const reached = await tabInto(page, "[data-act-agent-list]");
		listShown = {
			reached,
			...(reached
				? await revealed(page, "[data-act-agent-list]")
				: { ring: false, visible: false }),
		};
	}
	report(
		"S20",
		queueReached &&
			queueShown.ring &&
			queueShown.visible &&
			listShown.reached &&
			listShown.ring &&
			listShown.visible,
		JSON.stringify({
			list: listShown,
			queue: { reached: queueReached, ...queueShown },
		})
	);
}

// ── The other S19 views: one shot each ────────────────────────────────────
/**
 * Overlaps that show only in some views: a 390 stage with a mouse (the
 * main 390 run is touch), and the live-permission fixture at 1280 and 390.
 */
async function layoutViews() {
	const views = [
		view(390, false, false),
		view(1280, false, true),
		view(390, false, true),
	];
	if (openedThread) {
		views.push(
			view(1280, false, false, openedThread),
			view(390, false, false, openedThread)
		);
	}
	for (const at of views) {
		const page = await open(
			at.width,
			at.width > 640 ? 800 : 844,
			at.touch,
			at.live,
			at.opened
		);
		try {
			await page.screenshot({
				path: `${out}/${id}-view-${at.label.replaceAll(" ", "-")}.png`,
			});
			await checkLayout(page, at);
		} finally {
			await page.close();
		}
	}
}

// ── 390 × 844, touch ──────────────────────────────────────────────────────
async function narrow() {
	const page = await open(390, 844, true);
	try {
		await checkNarrow(page);
	} finally {
		await page.close();
	}
}

async function checkNarrow(page: Page) {
	await page.screenshot({ path: `${out}/${id}-390.png` });
	const at = view(390, true, false);
	await checkLayout(page, at);
	await checkStill(page, at);

	// S13: no horizontal scroll, before and after Ada's card opens; the card
	// and everything in it stay inside the 16px gutters.
	const noScroll = () =>
		page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth
		);
	const before = await noScroll();
	const ada = await need(
		"S13",
		page.locator(
			"[data-ask-queue='reveal'] [data-ask-queue-item][aria-label^='Ada asks']"
		),
		"Ada's queue button",
		"render AskQueueList"
	);
	if (ada) {
		await ada.evaluate((button: HTMLElement) => button.click());
		const card = await need(
			"S13",
			page.locator("[data-ask-card]"),
			"Ada's card"
		);
		if (card) {
			await page.waitForTimeout(1500);
			const outside = await card.evaluate((root) =>
				[root, ...root.querySelectorAll("*")].flatMap((element) => {
					const box = element.getBoundingClientRect();
					if (box.width === 0 || box.height === 0) {
						return [];
					}
					return box.left >= 15.5 && box.right <= window.innerWidth - 15.5
						? []
						: [
								`${element.tagName.toLowerCase()} ${Math.round(box.left)}-${Math.round(box.right)}`,
							];
				})
			);
			const after = await noScroll();
			report(
				"S13",
				before && after && outside.length === 0,
				JSON.stringify({ after, before, outside: outside.slice(0, 6) })
			);
			await closeCard("S13", page);
		}
	}

	// S15: "3 need you" and "Queue · 9" visible without scrolling; the tap
	// paths open Bo's card, Gu's through the sheet, and the sheet through the
	// off-stage tally when seats are capped.
	const needYou = await need(
		"S15",
		page.locator("[data-need-you]"),
		"the need-you button",
		"render NeedYouButton"
	);
	const queue = await need(
		"S15",
		page.locator("[data-queue-button]"),
		"the Queue button",
		"render QueueButton"
	);
	if (needYou && queue) {
		const inView = async (locator: Locator) => {
			const box = await locator.boundingBox();
			return (
				box !== null &&
				box.y >= 0 &&
				box.y + box.height <= 844 &&
				box.x >= 0 &&
				box.x + box.width <= 390
			);
		};
		const needText = await needYou.textContent();
		const queueText = await queue.textContent();
		const visible = (await inView(needYou)) && (await inView(queue));
		let boText = "";
		if (await tap("S15", needYou, "the need-you button")) {
			boText =
				(await (
					await need("S15", page.locator("[data-ask-card]"), "Bo's card")
				)?.textContent()) ?? "";
			await closeCard("S15", page);
		}
		let guText = "";
		try {
			const sheetGu = (await tap("S15", queue, "the Queue button"))
				? await need(
						"S15",
						page
							.locator("[data-ask-queue='sheet'] section")
							.filter({
								has: page.getByRole("heading", { name: "2 answers ready" }),
							})
							.locator("[data-ask-queue-item][aria-label^='Gu ']"),
						'Gu under "2 answers ready" in the Queue sheet'
					)
				: null;
			if (sheetGu) {
				await settled(page, "[data-ask-queue='sheet']");
			}
			if (sheetGu && (await tap("S15", sheetGu, "Gu in the Queue sheet"))) {
				const guCard = await need(
					"S15",
					page.locator("[data-ask-card]"),
					"Gu's card",
					"the sheet item's tap did not open the card"
				);
				if (guCard) {
					await settled(page, "[data-ask-card]");
				}
				guText = (await guCard?.textContent()) ?? "";
				await closeCard("S15", page);
			}
		} finally {
			await closeSheet(page);
		}
		let tallyOk = true;
		if (expected.offStage > 0) {
			tallyOk = false;
			const tally = await need(
				"S15",
				page.locator("[data-act-target='tally'][data-tally='off']"),
				"the off-stage tally",
				'TallyPlate scope="off" (data-tally="off")'
			);
			try {
				const reachable = tally
					? await tally.evaluate((element) =>
							(window as unknown as { __act: ActHelpers }).__act.focusable(
								element
							)
						)
					: false;
				if (tally && !reachable) {
					report("S15", false, "the off-stage tally is not a Tab stop");
				}
				if (
					tally &&
					reachable &&
					(await tap("S15", tally, "the off-stage tally"))
				) {
					tallyOk = await page
						.locator("[data-ask-queue='sheet']")
						.first()
						.waitFor({ timeout: SHORT })
						.then(
							() => true,
							() => false
						);
				}
			} finally {
				await closeSheet(page);
			}
		}
		report(
			"S15",
			tallyOk &&
				needText === "3 need you" &&
				queueText === `Queue · ${expected.queue}` &&
				visible &&
				boText.includes("Which DB to use?") &&
				guText.includes("Edited 3 files"),
			JSON.stringify({
				boText: boText.slice(0, 40),
				guText: guText.slice(0, 40),
				needText,
				queueText,
				tallyOk,
				visible,
			})
		);
	}

	// S19 (every game): you-spot overlays present (not in canvas games) and
	// apart, at most 8 budgeted overlays. Then DOM games: every prop target
	// and per-agent target reachable, icon-only at 390; list games: every
	// queue item reachable inline and in the sheet, and a row per agent.
	const layout = await page.evaluate((minGap) => {
		const act = (window as unknown as { __act: ActHelpers }).__act;
		const spots = [...document.querySelectorAll("[data-you-spot]")].map(
			(element) => ({
				box: element.getBoundingClientRect(),
				kind: element.getAttribute("data-you-spot") ?? "",
			})
		);
		let overlaps = 0;
		const tight: number[] = [];
		for (let i = 0; i < spots.length; i++) {
			for (let j = i + 1; j < spots.length; j++) {
				const a = spots[i]?.box;
				const b = spots[j]?.box;
				if (
					a &&
					b &&
					a.left < b.right &&
					b.left < a.right &&
					a.top < b.bottom &&
					b.top < a.bottom
				) {
					overlaps += 1;
				}
				if (a && b && a.width > 0 && b.width > 0) {
					const gap = Math.max(
						b.left - a.right,
						a.left - b.right,
						b.top - a.bottom,
						a.top - b.bottom
					);
					if (gap < minGap) {
						tight.push(Math.round(gap * 10) / 10);
					}
				}
			}
		}
		const count = (kind: string) =>
			spots.filter((spot) => spot.kind === kind).length;
		const drawn = [
			...document.querySelectorAll("[data-budgeted-overlay]"),
		].filter((element) => {
			const box = element.getBoundingClientRect();
			return box.width > 0 && box.height > 0;
		});
		const budgeted = drawn.length;
		const steady = drawn.filter(
			(element) => element.getAttribute("data-budgeted-overlay") !== "bubble"
		).length;
		const targets: Record<string, number> = {};
		const notIconOnly: string[] = [];
		const hiddenStops: string[] = [];
		for (const element of document.querySelectorAll<HTMLElement>(
			"[data-act-target]"
		)) {
			const kind = element.dataset.actTarget ?? "";
			const sceneTarget = act.scene(element);
			if (sceneTarget && act.tabbable(element) && act.ariaHidden(element)) {
				hiddenStops.push(kind);
			}
			if (sceneTarget && act.focusable(element)) {
				const key =
					kind === "tally" ? `tally:${element.dataset.tally ?? ""}` : kind;
				targets[key] = (targets[key] ?? 0) + 1;
			}
			const queuePlate = kind === "notice" || kind === "tally";
			const glyph =
				element.hasAttribute("data-icon-only") ||
				(element.hasAttribute("data-act-scene") &&
					act.visibleText(element).length <= 2);
			if (sceneTarget && !(queuePlate || glyph)) {
				notIconOnly.push(kind);
			}
		}
		const inline = [
			...document.querySelectorAll(
				"[data-ask-queue='reveal'] [data-ask-queue-item]"
			),
		].filter((element) => act.focusable(element)).length;
		return {
			budgeted,
			hiddenStops,
			inline,
			steady,
			notIconOnly,
			overlaps,
			tight,
			slots: count("slot"),
			tallies: count("tally"),
			targets,
			trays: count("tray"),
		};
	}, YOU_SPOT_GAP - 0.5);
	const problems: string[] = [];
	if (!canvasGame) {
		if (layout.slots < expected.slots) {
			problems.push(
				`${layout.slots}/${expected.slots} queue plates marked (data-you-spot="slot" on each queue plate)`
			);
		}
		if (layout.trays < expected.trays) {
			problems.push(
				`${layout.trays}/${expected.trays} tray items marked (data-you-spot="tray")`
			);
		}
		if (layout.tallies < expected.tally) {
			problems.push('no you-spot tally (TallyPlate scope="you")');
		}
	}
	if (!canvasGame) {
		// The you-spot gap and overlaps have their own line per view
		// (checkYouSpotGap).
		if (layout.budgeted > 8) {
			problems.push(
				`${layout.budgeted} budgeted overlays (cap 8; apply overlayBudget)`
			);
		}
		const stageHeight = await page.evaluate(
			() =>
				document
					.querySelector("[data-testid='iso-stage']")
					?.getBoundingClientRect().height ?? 0
		);
		const budgetFloor = budgetFloorAt(stageHeight);
		if (layout.steady < budgetFloor) {
			problems.push(
				`${layout.steady}/${budgetFloor} steady budgeted overlays (tally, limit, status text) marked (data-budgeted-overlay on each one overlayBudget chose)`
			);
		}
	}
	for (const kind of layout.hiddenStops) {
		problems.push(`${kind} target: focusable but aria-hidden`);
	}
	const targets = await readTargets(page);
	if (listGame) {
		if (layout.inline < expected.queue) {
			problems.push(
				`${layout.inline}/${expected.queue} reachable inline queue items (render AskQueueList)`
			);
		}
		const queueButton = await need(
			"S19",
			page.locator("[data-queue-button]"),
			"the Queue button"
		);
		if (queueButton) {
			try {
				const sheet = (await tap("S19", queueButton, "the Queue button"))
					? await need(
							"S19",
							page.locator("[data-ask-queue='sheet']"),
							"the Queue sheet"
						)
					: null;
				if (sheet) {
					await settled(page, "[data-ask-queue='sheet']");
					const reachable = await sheet.evaluate((root) => {
						const act = (window as unknown as { __act: ActHelpers }).__act;
						return [...root.querySelectorAll("[data-ask-queue-item]")].filter(
							(element) => act.focusable(element)
						).length;
					});
					if (reachable < expected.queue) {
						problems.push(
							`${reachable}/${expected.queue} reachable Queue sheet items`
						);
					}
				}
			} finally {
				await closeSheet(page);
			}
		}
		const rows = new Set(
			targets
				.filter((target) => target.focusable && !target.scene)
				.map((target) => target.agent)
		);
		const missing = expected.agents
			.filter((agent) => !rows.has(agent.id))
			.map((agent) => agent.name);
		if (missing.length > 0) {
			problems.push(
				`no reachable row for ${missing.join(", ")} (data-act-agent on each row; not display:none)`
			);
		}
	} else {
		const want: Record<string, number> = {
			alarm: expected.alarms,
			notice: expected.notices,
			suggestion: expected.suggestions,
			tray: expected.trays,
			unread: expected.unread,
		};
		for (const [kind, count] of Object.entries(want)) {
			if ((layout.targets[kind] ?? 0) < count) {
				problems.push(
					`${layout.targets[kind] ?? 0}/${count} reachable ${kind} targets (data-act-target="${kind}" with data-iso-target or data-act-scene)`
				);
			}
		}
		if (expected.offStage > 0 && (layout.targets["tally:off"] ?? 0) < 1) {
			problems.push('no reachable off-stage tally (TallyPlate scope="off")');
		}
		if (layout.notIconOnly.length > 0) {
			problems.push(
				`not icon-only at 390: ${layout.notIconOnly.join(", ")} (pass budget.iconOnly)`
			);
		}
		for (const agent of expected.agents) {
			const scene = targets.filter(
				(target) => target.agent === agent.id && target.scene
			);
			const plate = scene.find((target) => target.focusable) ?? scene[0];
			if (!plate?.focusable) {
				problems.push(`${agent.name}: no reachable in-scene target`);
			} else if (!(plate.youSpot || plate.iconOnly)) {
				problems.push(
					`${agent.name}: target not icon-only at 390 (data-icon-only)`
				);
			}
		}
	}
	report(
		"S19",
		problems.length === 0,
		problems.length ? problems.join("; ") : JSON.stringify(layout)
	);
	if (canvasGame) {
		notApplicable(
			"S19",
			"you-spot overlap and overlay budget (canvas: drawn in the canvas)"
		);
	}
}

// ── Escape: the host's top bar stays on top of the renderer ──────────────
/**
 * The renderer inside the desktop's real host frame (`?chrome=1`): the
 * switcher, Marketplace and Settings must be the topmost element at their
 * centres (nothing the renderer draws covers them), and the switcher must
 * open the menu with Back to chat. At 1280 and at 390 (touch).
 */
async function escapeChecks() {
	if (demo) {
		notApplicable(
			"escape",
			"the life demo island has no host frame (?chrome=1 applies only to story renderers)"
		);
		return;
	}
	for (const [width, height, touch] of [
		[1280, 800, false],
		[390, 844, true],
	] as const) {
		const page = await browser.newPage({
			hasTouch: touch,
			isMobile: touch,
			locale: "en-GB",
			reducedMotion: REDUCED ? "reduce" : "no-preference",
			timezoneId: "UTC",
			viewport: { height, width },
		});
		try {
			await page.addInitScript(fixtureClockScript(FIXTURE_NOW_MS));
			await page.addInitScript(PAGE_HELPERS);
			await page.goto(`${base}?${query}&chrome=1`);
			await page.waitForSelector('[data-testid="interface-switcher-button"]', {
				timeout: WAIT,
			});
			await waitForSettle(page);
			const probes = await page.evaluate(() => {
				const bar = document.querySelector(
					'[data-testid="ryu-interface-topbar"]'
				);
				const named = (text: string) =>
					[
						...(bar?.querySelectorAll('nav[aria-label="Workspace"] button') ??
							[]),
					].find((button) => button.textContent?.includes(text)) ?? null;
				const targets: [string, Element | null][] = [
					[
						"switcher",
						document.querySelector('[data-testid="interface-switcher-button"]'),
					],
					["Marketplace", named("Marketplace")],
					["Settings", named("Settings")],
				];
				return targets.map(([name, element]) => {
					if (!element) {
						return { name, ok: false, why: "missing" };
					}
					const rect = element.getBoundingClientRect();
					const x = rect.left + rect.width / 2;
					const y = rect.top + rect.height / 2;
					const hit = document.elementFromPoint(x, y);
					const onTop =
						hit !== null && (hit === element || element.contains(hit));
					return {
						name,
						ok: onTop && rect.width > 0 && rect.height > 0,
						why: onTop
							? `${Math.round(rect.width)}×${Math.round(rect.height)}`
							: `covered by ${hit?.tagName.toLowerCase() ?? "nothing"}${hit?.getAttribute("data-testid") ? `[${hit.getAttribute("data-testid")}]` : ""}`,
					};
				});
			});
			const covered = probes.filter((probe) => !probe.ok);
			await page.click('[data-testid="interface-switcher-button"]');
			// `isVisible` does not wait; the menu opens a frame after the click.
			const back = await page
				.getByRole("menuitem", { name: "Back to chat" })
				.waitFor({ state: "visible", timeout: 5000 })
				.then(() => true)
				.catch(() => false);
			await page.screenshot({ path: `${out}/${id}-escape-${width}.png` });
			report(
				`escape @${width}`,
				covered.length === 0 && back,
				covered.length > 0
					? covered.map((probe) => `${probe.name} ${probe.why}`).join("; ")
					: `switcher visible and on top; ${probes.map((probe) => `${probe.name} ${probe.why}`).join(", ")}; menu ${back ? "opens with Back to chat" : "has no Back to chat"}`
			);
		} finally {
			await page.close();
		}
	}
}

try {
	for (const [name, run] of [
		["1280", wide],
		["390", narrow],
		["views", layoutViews],
		["escape", escapeChecks],
	] as const) {
		// `--only escape` (or 1280, 390, views) runs just that part.
		if (ONLY && ONLY !== name) {
			continue;
		}
		try {
			await run();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			report(`run ${name}`, false, `crashed: ${message.split("\n")[0]}`);
		}
	}
} finally {
	await browser.close();
}
for (const result of results) {
	let status = result.ok ? "PASS" : "FAIL";
	if (result.na) {
		status = "N/A ";
	} else if (result.warn) {
		status = "WARN";
	}
	process.stdout.write(
		`${status} ${result.check}${result.detail ? `  ${result.detail}` : ""}\n`
	);
}
process.stdout.write(
	`Saved ${out}/${id}-1280.png, ${id}-390.png (touch) and ${id}-view-*.png\n`
);
if (results.length === 0) {
	process.stderr.write("no checks ran\n");
	process.exit(1);
}
process.exit(results.every((result) => result.ok) ? 0 : 1);
