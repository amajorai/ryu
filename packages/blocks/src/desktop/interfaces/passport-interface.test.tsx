// The DOM first, before React loads (a side-effect import stays first).
import "./passport-test-dom.ts";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	setSystemTime,
	test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	InterfaceAgentAct,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { agentActs, resolveInterfaceParams } from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	FIXTURE_AGENT_IDS,
	FIXTURE_ASK_IDS,
	FIXTURE_CLOCK,
	FIXTURE_NOW,
	FIXTURE_PRIVATE_STRINGS,
	usefulStateFixture,
} from "./game-acts-fixture.ts";
import { limitWords } from "./game3d-act-stage.tsx";
import {
	actOfficers,
	borderClosed,
	customsLayout,
	deskPaths,
} from "./passport-acts.tsx";
import {
	countryPose,
	deskFraming,
	layoutDesk,
	shownPhotos,
} from "./passport-desk.tsx";
import {
	PageNav,
	PassportInterface,
	pageTabs,
	passportSettings,
	spreadCaption,
	visaStatus,
} from "./passport-interface.tsx";
import {
	assignInks,
	assignSlots,
	bookletSpreads,
	buildPassport,
	countryCodes,
	countryPage,
	FIRST_PAGE_STAMPS,
	findStamp,
	latestLine,
	mrzCheckDigit,
	mrzLines,
	recordNumber,
	singleSpreads,
	spreadOfPage,
	stampDate,
	stampLabel,
	stampMarking,
	stampPage,
	upcomingTravel,
	wrapLines,
} from "./passport-model.ts";
import {
	type PassportNavigation,
	spreadPage,
	usePassportNavigation,
} from "./passport-navigation.ts";
import { IdentityFace, VisaFace } from "./passport-page-face.tsx";
import {
	deskArt,
	PASSPORT_DESK,
	PASSPORT_DESK_NIGHT,
	PASSPORT_VARS,
	passportVars,
} from "./passport-palette.ts";
import { stampTextRows } from "./passport-stamp-text.ts";
import { ActClockProvider } from "./use-acts.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Local mid-day, far from midnight in any time zone. */
const FIXED_NOW = new Date(2026, 9, 14, 12, 0, 0);
const DAY = 24 * HOUR;
/** Local noon today: day counts never straddle midnight, whenever tests run. */
const NOON = new Date(new Date().setHours(12, 0, 0, 0)).getTime();

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id">
): InterfaceThread {
	return {
		agentIds: [],
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: input.id,
		updatedAt: new Date().toISOString(),
		...input,
	};
}

function snapshotAt(now: number): InterfaceSnapshot {
	const at = (offset: number) => new Date(now - offset).toISOString();
	return {
		agents: [
			{
				avatarUrl: null,
				description: "Digs through papers",
				id: "agent-atlas",
				name: "Atlas",
				status: "idle",
			},
			{
				avatarUrl: null,
				description: "Ships the site",
				id: "agent-forge",
				name: "Forge",
				status: "working",
			},
			{
				avatarUrl: null,
				description: "Unvisited",
				id: "agent-quiet",
				name: "Quill",
				status: "idle",
			},
		],
		events: [
			{
				agentId: "agent-atlas",
				id: "event-standup",
				kind: "upcoming",
				label: "Weekdays at 9 AM",
				start: at(-2 * HOUR),
				title: "Standup summary",
			},
			{
				agentId: "agent-atlas",
				id: "event-past",
				kind: "past",
				label: null,
				outcome: "success",
				start: at(2 * HOUR),
				title: "Backup check",
			},
		],
		groups: [],
		threads: [
			thread({
				agentIds: ["agent-forge"],
				id: "thread-hero",
				running: true,
				title: "Rebuild the landing hero",
				updatedAt: at(MINUTE),
			}),
			thread({
				agentIds: ["agent-atlas", "agent-forge"],
				id: "thread-plan",
				title: "Launch week plan",
				updatedAt: at(2 * HOUR),
			}),
			thread({
				agentIds: ["agent-atlas"],
				id: "thread-research",
				lastMessageRole: "user",
				title: "Survey speculative decoding papers",
				updatedAt: at(3 * DAY),
			}),
			thread({
				agentIds: ["agent-atlas"],
				id: "thread-audit",
				runState: "failed",
				title: "Audit lockfile advisories",
				updatedAt: at(4 * DAY),
			}),
			thread({
				agentIds: [],
				id: "thread-general",
				lastMessageRole: null,
				title: "Office closed Friday",
				updatedAt: at(9 * DAY),
			}),
		],
		version: 1,
	};
}

// Day grouping (Today, held, travel days) is local-calendar based, so a fixture
// built from the live clock flips sections when the run straddles midnight.
// Every test runs at one fixed local mid-day instant instead.
beforeEach(() => {
	setSystemTime(FIXED_NOW);
});
afterEach(() => {
	setSystemTime();
});

async function mount(element: ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(element));
	return {
		container,
		async dispose() {
			await act(async () => root.unmount());
			container.remove();
		},
		async rerender(next: ReactElement) {
			await act(async () => root.render(next));
		},
	};
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

function button(container: HTMLElement, label: string | RegExp) {
	return [...container.querySelectorAll("button")].find((candidate) => {
		const name =
			candidate.getAttribute("aria-label") ?? candidate.textContent?.trim();
		return typeof label === "string" ? name === label : label.test(name ?? "");
	});
}

interface PortCalls {
	closed: number;
	opened: string[];
	started: Parameters<InterfacePort["startThread"]>[0][];
}

function recordingPort(): { calls: PortCalls; port: InterfacePort } {
	const calls: PortCalls = { closed: 0, opened: [], started: [] };
	return {
		calls,
		port: {
			closeThread: () => {
				calls.closed += 1;
			},
			openThread: (id) => {
				calls.opened.push(id);
			},
			startThread: (input) => {
				calls.started.push(input);
			},
		},
	};
}

describe("passport model", () => {
	test("statuses map onto entry markings", () => {
		expect(stampMarking(thread({ id: "a", running: true }))).toBe("processing");
		expect(stampMarking(thread({ id: "b" }))).toBe("arrived");
		expect(stampMarking(thread({ id: "c", runState: "interrupted" }))).toBe(
			"denied"
		);
		expect(stampMarking(thread({ id: "d", lastMessageRole: "user" }))).toBe(
			"applied"
		);
		expect(stampMarking(thread({ id: "e", lastMessageRole: null }))).toBe(
			"exited"
		);
	});

	test("country codes are three letters and unique", () => {
		const codes = countryCodes([
			{ id: "a", name: "Atlas" },
			{ id: "b", name: "Atlantis" },
			{ id: "c", name: "Atl" },
			{ id: "d", name: "Al" },
			{ id: "e", name: "42" },
		]);
		expect(codes.get("a")).toBe("ATL");
		expect(codes.get("b")).toBe("ATS");
		const values = [...codes.values()];
		expect(new Set(values).size).toBe(values.length);
		for (const value of values) {
			expect(value).toMatch(/^[A-Z0-9]{3}$/);
		}
		expect(codes.get("d")).toBe("ALX");
	});

	test("slots spread across ids before repeating", () => {
		const slots = assignSlots(["a", "b", "c", "d", "e", "f"], 6, "ink");
		expect(new Set(slots.values()).size).toBe(6);
		const again = assignSlots(["f", "e", "d", "c", "b", "a"], 6, "ink");
		expect([...again.entries()].sort()).toEqual([...slots.entries()].sort());
	});

	test("builds cover, notes, identity, then visa pages by recent travel", () => {
		const now = NOON;
		const passport = buildPassport(snapshotAt(now));
		expect(passport.pages[0]?.kind).toBe("cover");
		expect(passport.pages[1]?.kind).toBe("notes");
		expect(passport.pages[2]?.kind).toBe("identity");
		expect(passport.countries.map((country) => country.agent.name)).toEqual([
			"Forge",
			"Atlas",
			"Quill",
		]);
		// A shared conversation is stamped once, on its first agent's pages.
		const atlas = passport.countries[1];
		expect(atlas?.stamps.map((stamp) => stamp.thread.id)).toEqual([
			"thread-audit",
			"thread-research",
			"thread-plan",
		]);
		expect(atlas?.stamps[2]?.companions).toEqual(["FOR"]);
		expect(passport.unassigned.map((stamp) => stamp.thread.id)).toEqual([
			"thread-general",
		]);
		expect(countryPage(passport.pages, null)).toBeGreaterThan(0);
		expect(countryPage(passport.pages, "agent-quiet")).toBeGreaterThan(0);
		expect(passport.totals).toEqual({ countries: 2, stamps: 5, travelDays: 4 });
		// Pages after the cover pair up into whole spreads.
		expect((passport.pages.length - 1) % 2).toBe(0);
	});

	test("a full country continues onto a second page", () => {
		const now = Date.now();
		const snapshot = snapshotAt(now);
		snapshot.threads = Array.from({ length: FIRST_PAGE_STAMPS + 2 }, (_, i) =>
			thread({
				agentIds: ["agent-atlas"],
				id: `thread-${i}`,
				updatedAt: new Date(now - i * HOUR).toISOString(),
			})
		);
		const passport = buildPassport(snapshot);
		const atlasPages = passport.pages.filter(
			(page) => page.kind === "visa" && page.countryId === "agent-atlas"
		);
		expect(atlasPages).toHaveLength(2);
		expect(atlasPages[1]?.kind === "visa" && atlasPages[1].first).toBe(false);
		const second = atlasPages[1];
		// Oldest entries fill the first page; the newest spill onto the next.
		expect(second && stampPage(passport.pages, "thread-0")).toBe(
			second ? passport.pages.indexOf(second) : undefined
		);
	});

	test("first-seen times move the entry date back, never forward", () => {
		const now = Date.now();
		const snapshot = snapshotAt(now);
		const earlier = new Date(now - 5 * DAY).toISOString();
		const later = new Date(now + DAY).toISOString();
		const passport = buildPassport(snapshot, {
			"thread-hero": earlier,
			"thread-plan": later,
		});
		const hero = findStamp(passport, "thread-hero");
		const plan = findStamp(passport, "thread-plan");
		expect(hero?.entryAt).toBe(Date.parse(earlier));
		expect(plan?.entryAt).toBe(plan?.latestAt);
		expect(latestLine({ entryAt: now, latestAt: now })).toMatch(
			/^LAST \d{2}:\d{2}$/
		);
		expect(latestLine({ entryAt: now - 5 * DAY, latestAt: now })).toBe(
			`LAST ${stampDate(now).slice(0, 6)}`
		);
	});

	test("stamp layout is stable and skips unreadable timestamps", () => {
		const now = Date.now();
		const snapshot = snapshotAt(now);
		snapshot.threads.push(thread({ id: "thread-bad", updatedAt: "nope" }));
		const first = buildPassport(snapshot);
		const second = buildPassport(snapshot);
		expect(findStamp(first, "thread-bad")).toBeNull();
		const a = findStamp(first, "thread-plan");
		const b = findStamp(second, "thread-plan");
		expect(a?.rotation).toBe(b?.rotation);
		expect(Math.abs(a?.rotation ?? 99)).toBeLessThanOrEqual(8);
		expect(a?.rotation).not.toBe(0);
	});

	test("spreads pair pages after the closed cover", () => {
		expect(bookletSpreads(6)).toEqual([
			{ left: null, right: 0 },
			{ left: 1, right: 2 },
			{ left: 3, right: 4 },
			{ left: 5, right: null },
		]);
		expect(singleSpreads(3)).toHaveLength(3);
		expect(spreadOfPage(bookletSpreads(6), 4)).toBe(2);
		expect(spreadOfPage(bookletSpreads(6), 99)).toBe(0);
	});

	test("wraps stamp lines with an ellipsis when out of room", () => {
		expect(wrapLines("Rebuild the landing hero", 12, 2)).toEqual([
			"Rebuild the",
			"landing hero",
		]);
		expect(wrapLines("Survey speculative decoding papers", 15, 2)).toEqual([
			"Survey",
			"speculative…",
		]);
		expect(wrapLines("Rebuild the landing hero", 16, 1)).toEqual([
			"Rebuild the lan…",
		]);
		expect(wrapLines("Roll out gateway 2.4", 12, 1)).toEqual(["Roll out…"]);
		expect(wrapLines("Supercalifragilistic", 8, 1)).toEqual(["Superca…"]);
		expect(wrapLines("", 10, 2)).toEqual([]);
	});

	test("machine-readable lines use ICAO check digits", () => {
		expect(mrzCheckDigit("L898902C3")).toBe("6");
		expect(mrzCheckDigit("740812")).toBe("2");
		const [first, second] = mrzLines(buildPassport(snapshotAt(NOON)));
		expect(first).toHaveLength(44);
		expect(second).toHaveLength(44);
		expect(first.startsWith("P<RYU")).toBe(true);
	});

	test("upcoming travel keeps future scheduled runs only", () => {
		const now = Date.now();
		const events = snapshotAt(now).events;
		expect(upcomingTravel(events, now, 3).map((event) => event.id)).toEqual([
			"event-standup",
		]);
		expect(upcomingTravel(undefined, now, 3)).toEqual([]);
	});
});

describe("passport stamps", () => {
	test("record numbers come from the conversation, not its dates", () => {
		const plain = buildPassport(snapshotAt(NOON));
		const seen = buildPassport(snapshotAt(NOON), {
			"thread-hero": new Date(NOON - 3 * DAY).toISOString(),
		});
		const hero = findStamp(plain, "thread-hero");
		const heroSeen = findStamp(seen, "thread-hero");
		expect(hero?.entryAt).not.toBe(heroSeen?.entryAt);
		expect(recordNumber("FOR", "thread-hero")).toMatch(/^FOR-\d{5}$/);
		expect(recordNumber("FOR", "thread-hero")).toBe(
			recordNumber("FOR", "thread-hero")
		);
		expect(recordNumber("FOR", "thread-hero")).not.toBe(
			recordNumber("FOR", "thread-plan")
		);
	});

	test("countries that share a shape never share a similar ink", () => {
		const ids = ["a", "b", "c", "d", "e", "f"];
		// Everyone on one shape: all six inks, with no alike pair possible to
		// avoid, still hand out each ink once.
		const oneShape = new Map(ids.map((id) => [id, 0]));
		expect(new Set(assignInks(ids, oneShape, 6).values()).size).toBe(6);
		// Pairs on three shapes: no pair takes blue/violet, blue/slate,
		// green/slate, or oxblood/umber.
		const pairs = new Map(ids.map((id, index) => [id, index % 3]));
		const inks = assignInks(ids, pairs, 6);
		const alike = new Set(["0-3", "0-4", "2-4", "1-5"]);
		for (const shape of [0, 1, 2]) {
			const [first, second] = ids
				.filter((id) => pairs.get(id) === shape)
				.map((id) => inks.get(id) ?? -1)
				.sort();
			expect(alike.has(`${first}-${second}`)).toBe(false);
		}
		expect(new Set(inks.values()).size).toBe(6);
		expect(assignInks([...ids].reverse(), pairs, 6)).toEqual(inks);
	});

	test("triangle stamps print one destination line, clear of the slopes", () => {
		const rows = stampTextRows({
			date: "15 OCT 2026",
			latest: "LAST 05:24",
			marking: null,
			shape: "triangle",
			title: "Survey speculative decoding papers",
		});
		const titles = rows.filter((row) => row.family === "sans");
		expect(rows).toHaveLength(3);
		expect(titles).toHaveLength(1);
		expect(titles.at(0)?.text.endsWith("…")).toBe(true);
		// Every line ends above the base band's rule.
		for (const row of rows) {
			expect(row.y).toBeLessThan(114);
		}
		const circle = stampTextRows({
			date: "15 OCT 2026",
			latest: "LAST 05:24",
			marking: null,
			shape: "circle",
			title: "Survey speculative decoding papers",
		});
		expect(circle).toHaveLength(4);
	});
});

describe("passport navigation", () => {
	const PAGE_COUNT = 11;

	function NavigationProbe({
		animate,
		initialPage,
		onNavigation,
		pageCount = PAGE_COUNT,
		single,
	}: {
		animate: boolean;
		initialPage: number;
		onNavigation: (navigation: PassportNavigation) => void;
		pageCount?: number;
		single: boolean;
	}) {
		const spreads = single
			? singleSpreads(pageCount)
			: bookletSpreads(pageCount);
		const navigation = usePassportNavigation({ animate, initialPage, spreads });
		onNavigation(navigation);
		return null;
	}

	/** Collects the hook's latest result from each render. */
	function probeRecorder() {
		let latest: PassportNavigation | null = null;
		return {
			current(): PassportNavigation {
				if (!latest) {
					throw new Error("Expected the probe to render");
				}
				return latest;
			},
			record(navigation: PassportNavigation) {
				latest = navigation;
			},
		};
	}

	test("a spread opens on its left page", () => {
		expect(spreadPage(bookletSpreads(PAGE_COUNT), 0)).toBe(0);
		expect(spreadPage(bookletSpreads(PAGE_COUNT), 2)).toBe(3);
		expect(spreadPage(singleSpreads(PAGE_COUNT), 7)).toBe(7);
	});

	test("switching to single pages keeps the open page", async () => {
		const recorder = probeRecorder();
		const probe = (single: boolean) => (
			<NavigationProbe
				animate={false}
				initialPage={8}
				onNavigation={recorder.record}
				single={single}
			/>
		);
		const view = await mount(probe(false));
		// Page 8 is the right page of the 7–8 spread.
		expect(recorder.current().page).toBe(8);
		expect(recorder.current().spread).toBe(4);
		await view.rerender(probe(true));
		expect(recorder.current().page).toBe(8);
		expect(recorder.current().spread).toBe(8);
		await view.rerender(probe(false));
		expect(recorder.current().spread).toBe(4);
		await act(async () => recorder.current().next());
		expect(recorder.current().page).toBe(9);
		await view.rerender(probe(true));
		expect(recorder.current().spread).toBe(9);
		await view.dispose();
	});

	test("a shrinking booklet stays on its last page, not the cover", async () => {
		const recorder = probeRecorder();
		const probe = (pageCount: number) => (
			<NavigationProbe
				animate={false}
				initialPage={10}
				onNavigation={recorder.record}
				pageCount={pageCount}
				single={false}
			/>
		);
		const view = await mount(probe(PAGE_COUNT));
		expect(recorder.current().page).toBe(10);
		await view.rerender(probe(7));
		expect(recorder.current().page).toBe(6);
		expect(recorder.current().spread).toBe(spreadOfPage(bookletSpreads(7), 6));
		expect(recorder.current().spread).toBeGreaterThan(0);
		await act(async () => recorder.current().goToPage(99));
		expect(recorder.current().page).toBe(6);
		await view.dispose();
	});

	test("a turn in flight lands at once when the layout changes", async () => {
		const recorder = probeRecorder();
		const root = createRoot(document.createElement("div"));
		const render = (single: boolean) =>
			act(async () =>
				root.render(
					<NavigationProbe
						animate
						initialPage={0}
						onNavigation={recorder.record}
						single={single}
					/>
				)
			);
		await render(false);
		await act(async () => recorder.current().goToPage(2));
		expect(recorder.current().turn).not.toBeNull();
		await render(true);
		expect(recorder.current().turn).toBeNull();
		expect(recorder.current().page).toBe(2);
		expect(recorder.current().spread).toBe(2);
		// Back in the desk's layout, the dropped turn does not replay.
		await render(false);
		expect(recorder.current().turn).toBeNull();
		await act(async () => root.unmount());
	});

	test("a turn runs between spreads and lands on the target page", async () => {
		const recorder = probeRecorder();
		const view = await mount(
			<NavigationProbe
				animate
				initialPage={0}
				onNavigation={recorder.record}
				single={false}
			/>
		);
		await act(async () => recorder.current().goToPage(6));
		expect(recorder.current().turn).toEqual({ from: 0, to: 3 });
		expect(recorder.current().page).toBe(6);
		await act(async () => recorder.current().finishTurn());
		expect(recorder.current().turn).toBeNull();
		expect(recorder.current().spread).toBe(3);
		await view.dispose();
	});
});

describe("PassportInterface", () => {
	test("without WebGL lists a row per country; the HUD opens the booklet", async () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<PassportInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOON)}
				threadView={null}
			/>
		);
		expect(markup).toContain('data-testid="interface-passport"');
		expect(markup).toContain('data-testid="passport-isles"');
		expect(markup).toContain("Map of travels");
		expect(markup).toContain("2 countries · 5 stamps · 4 travel days");
		expect(markup).toContain("Atlas: apply for a visa");
		// The booklet waits in the HUD until it is opened.
		expect(markup).not.toContain('data-testid="passport-booklet"');

		const view = await mount(
			<PassportInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOON)}
				threadView={null}
			/>
		);
		await click(button(view.container, "Booklet"));
		const booklet = view.container.querySelector(
			'[data-testid="passport-booklet"]'
		);
		// The booklet opens where the stamps are, not on its cover.
		expect(booklet?.innerHTML).not.toContain('aria-label="Open passport"');
		expect(booklet?.innerHTML).toContain("data-thread-id=");
		expect(button(view.container, "Previous page")).toBeDefined();
		expect(button(view.container, "Atlas visa pages")).toBeDefined();
		expect(button(view.container, "Unassigned visa pages")).toBeDefined();
		expect(booklet?.innerHTML).toContain(">GEN</button>");
		await view.dispose();
	});

	test("a country's row opens its visa pages; its agent's row applies", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<PassportInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOON)}
				threadView={null}
			/>
		);
		const isle = [...view.container.querySelectorAll("button")].find(
			(candidate) =>
				candidate.getAttribute("aria-label")?.startsWith("Atlas (") ?? false
		);
		await click(isle ?? null);
		expect(
			view.container.querySelector('nav[aria-label="Pages"] p')?.textContent
		).toBe("Page 4 of 6");
		await click(button(view.container, "Atlas: apply for a visa"));
		expect(
			view.container.querySelector(
				'form[aria-label="Visa application to Atlas"]'
			)
		).not.toBeNull();
		await view.dispose();
	});

	test("shows a skeleton while loading", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<PassportInterface
				activeThreadId={null}
				loading
				params={{}}
				port={port}
				snapshot={{ ...snapshotAt(NOON), threads: [] }}
				threadView={null}
			/>
		);
		expect(markup).not.toContain('aria-label="Open passport"');
		expect(markup).toContain("animate-skeleton");
	});

	test("an empty workspace still issues a passport and says why", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<PassportInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={{ agents: [], groups: [], threads: [], version: 1 }}
				threadView={null}
			/>
		);
		expect(view.container.textContent).toContain(
			"0 countries · 0 stamps · 0 travel days"
		);
		await click(button(view.container, "Map of travels"));
		expect(view.container.textContent).toContain("No travels yet");
		await view.dispose();
	});

	test("first-seen storage keeps every current thread past the limit", async () => {
		const key = "ryu.interfaces.passport.first-seen";
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		const seenAt = (index: number) =>
			new Date(base + index * MINUTE).toISOString();
		const stored: Record<string, string> = {};
		const threads: InterfaceThread[] = [];
		for (let index = 0; index < 600; index += 1) {
			stored[`thread-${index}`] = seenAt(index);
			threads.push(thread({ id: `thread-${index}` }));
		}
		for (let index = 0; index < 20; index += 1) {
			stored[`departed-${index}`] = seenAt(1000 + index);
		}
		threads.push(thread({ id: "thread-new" }));
		window.localStorage.setItem(key, JSON.stringify(stored));

		const { port } = recordingPort();
		const view = await mount(
			<PassportInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={{ agents: [], groups: [], threads, version: 1 }}
				threadView={null}
			/>
		);
		const saved: Record<string, string> = JSON.parse(
			window.localStorage.getItem(key) ?? "{}"
		);
		expect(saved["thread-0"]).toBe(seenAt(0));
		expect(saved["thread-599"]).toBe(seenAt(599));
		expect(saved["thread-new"]).toBeDefined();
		expect(Object.keys(saved).some((id) => id.startsWith("departed-"))).toBe(
			false
		);
		await view.dispose();
		window.localStorage.removeItem(key);
	});

	test("index tabs turn to a country's pages", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<PassportInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOON)}
				threadView={null}
			/>
		);
		await click(button(view.container, "Booklet"));
		const caption = () =>
			view.container.querySelector('nav[aria-label="Pages"] p')?.textContent;
		expect(caption()).not.toBe("Cover");
		await click(button(view.container, "Identity page"));
		expect(caption()).toBe("Page 2 of 6");
		await click(button(view.container, "Atlas visa pages"));
		// Atlas is the second country: page 4.
		expect(caption()).toBe("Page 4 of 6");
		await view.dispose();
	});

	test("the map opens stamps and files visa applications through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<PassportInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOON)}
				threadView={null}
			/>
		);
		await click(button(view.container, "Map of travels"));
		await click(button(view.container, "Audit lockfile advisories"));
		expect(calls.opened).toEqual(["thread-audit"]);

		const applyButtons = [
			...view.container.querySelectorAll("button[aria-label]"),
		].filter((candidate) =>
			candidate.getAttribute("aria-label")?.startsWith("Apply for a visa to ")
		);
		await click(applyButtons[1]);
		const form = view.container.querySelector(
			'form[aria-label="Visa application to Atlas"]'
		);
		const field = form?.querySelector("textarea");
		if (!field) {
			throw new Error("Expected the visa application");
		}
		expect(calls.started).toEqual([]);
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value"
			)?.set;
			field.focus();
			setter?.call(field, "  Compare EAGLE-2 latency  ");
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
		});
		const submit = button(view.container, "Submit application");
		await click(submit);
		expect(calls.started).toEqual([
			{ agentId: "agent-atlas", prompt: "Compare EAGLE-2 latency" },
		]);
		await view.dispose();
	});

	test("an open conversation is filed as an immigration record", async () => {
		const { calls, port } = recordingPort();
		const snapshot = snapshotAt(NOON);
		const view = await mount(
			<PassportInterface
				activeThreadId="thread-audit"
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshot}
				threadView={<div data-testid="host-thread">Host chat</div>}
			/>
		);
		const record = view.container.querySelector(
			'aside[aria-label="Immigration record"]'
		);
		expect(record?.querySelector('[data-testid="host-thread"]')).not.toBeNull();
		expect(record?.textContent).toContain("Audit lockfile advisories");
		expect(record?.textContent).toContain("Entry denied");
		await click(button(view.container, "Close record"));
		expect(calls.closed).toBe(1);
		await view.dispose();
	});

	test("Escape files the record from the passport, not from the conversation", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<PassportInterface
				activeThreadId="thread-hero"
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOON)}
				threadView={
					<button data-testid="host-thread" type="button">
						Host chat
					</button>
				}
			/>
		);
		const press = async (target: Element | null) => {
			await act(async () => {
				target?.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
				);
			});
		};
		await press(view.container.querySelector('[data-testid="host-thread"]'));
		expect(calls.closed).toBe(0);
		await press(
			view.container.querySelector('[data-testid="passport-isles"] button')
		);
		expect(calls.closed).toBe(1);
		await view.dispose();
	});

	test("leaves page keys to the host's cover", async () => {
		const { calls, port } = recordingPort();
		const press = async (key: string) => {
			await act(async () => {
				document.body.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key })
				);
			});
		};
		const passport = (activeThreadId: string | null) => (
			<PassportInterface
				activeThreadId={activeThreadId}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOON)}
				threadView={activeThreadId ? <p>Host chat</p> : null}
			/>
		);
		// Page keys wait for the stage's first measurement; give it a size.
		const measure = HTMLElement.prototype.getBoundingClientRect;
		HTMLElement.prototype.getBoundingClientRect = () =>
			DOMRect.fromRect({ height: 900, width: 1400 });
		const desk = await mount(passport(null));
		HTMLElement.prototype.getBoundingClientRect = measure;
		await click(button(desk.container, "Booklet"));
		const caption = () =>
			desk.container.querySelector('nav[aria-label="Pages"] p')?.textContent;
		(document.activeElement as HTMLElement | null)?.blur();
		const before = caption();
		expect(before).toBeTruthy();
		// While the host covers the passport it is inert: <body> keys pass it by.
		desk.container.setAttribute("inert", "");
		await press("End");
		expect(caption()).toBe(before);
		desk.container.removeAttribute("inert");
		await press("End");
		expect(caption()).not.toBe(before);
		await desk.dispose();

		// Escape leaves an open conversation only when nothing covers it.
		const open = await mount(passport("thread-hero"));
		(document.activeElement as HTMLElement | null)?.blur();
		open.container.setAttribute("inert", "");
		await press("Escape");
		expect(calls.closed).toBe(0);
		open.container.removeAttribute("inert");
		await press("Escape");
		expect(calls.closed).toBe(1);
		await open.dispose();
	});

	test("the visa application lists the country's previous entries", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<PassportInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOON)}
				threadView={null}
			/>
		);
		await click(button(view.container, "Map of travels"));
		await click(button(view.container, "Apply for a visa to Forge"));
		const panel = view.container.querySelector(
			'aside[aria-label="Visa application"]'
		);
		expect(panel?.textContent).toContain("Previous entries");
		const previous = [...(panel?.querySelectorAll("li button") ?? [])];
		expect(previous.length).toBeGreaterThan(0);
		await click(previous[0] ?? null);
		expect(calls.opened).toEqual(["thread-hero"]);
		expect(calls.started).toEqual([]);
		await view.dispose();
	});

	test("unassigned entries go by one name in the map", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<PassportInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOON)}
				threadView={null}
			/>
		);
		await click(button(view.container, "Map of travels"));
		const text = view.container.textContent ?? "";
		expect(text).toContain("Unassigned");
		expect(text).toContain("GEN · ");
		expect(text).not.toContain("Observations");
		await view.dispose();
	});

	test("stamp labels speak dates with a title-case month", () => {
		const passport = buildPassport(snapshotAt(NOON));
		const stamp = passport.countries
			.flatMap((country) => country.stamps)
			.find((candidate) => candidate.thread.id === "thread-hero");
		if (!stamp) {
			throw new Error("Expected the hero stamp");
		}
		expect(stampLabel(stamp, "Forge")).toMatch(
			/entered \d{2} [A-Z][a-z]{2} \d{4}/
		);
	});
});

async function settle(ms = 30) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

async function mountActs(element: ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(element));
	await settle();
	return {
		container,
		dispose: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

/** Clicks like a user: the card opens after the click has finished. */
async function press(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	act(() => element.click());
	await settle();
}

const actsPort: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

function passport(snapshot: InterfaceSnapshot = usefulStateFixture()) {
	return (
		<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
			<PassportInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={actsPort}
				snapshot={snapshot}
				threadView={null}
			/>
		</ActClockProvider>
	);
}

/** An agent's row in the text equivalent: the list item of its Apply button. */
function agentRow(
	container: HTMLElement,
	name: keyof typeof FIXTURE_AGENT_IDS
) {
	return container
		.querySelector(
			`[data-testid="passport-isles"] [data-act-agent="${FIXTURE_AGENT_IDS[name]}"]`
		)
		?.closest("li");
}

function buttons(scope: Element | null | undefined, text: string) {
	return [...(scope?.querySelectorAll("button") ?? [])].filter(
		(candidate) => candidate.textContent === text
	);
}

describe("Passport useful state", () => {
	test("renders the fixture with no console errors", async () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			const view = await mountActs(passport());
			await view.dispose();
		} finally {
			console.error = original;
		}
		expect(errors).toEqual([]);
	});

	test("agent rows are described by act.ariaLabel", async () => {
		const view = await mountActs(passport());
		const ada = view.container.querySelector(
			`[data-testid="passport-isles"] [data-act-agent="${FIXTURE_AGENT_IDS.ada}"]`
		);
		const describedBy = ada?.getAttribute("aria-describedby") ?? "";
		expect(document.getElementById(describedBy)?.textContent).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run."
		);
		await view.dispose();
	});

	test("Ada's agent-row Answer button opens the ask card", async () => {
		const view = await mountActs(passport());
		await press(buttons(agentRow(view.container, "ada"), "Answer")[0]);
		expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
			"Can I run shell.run now?"
		);
		await view.dispose();
	});

	test("Di's agent row has two Details buttons, the second opens the BlockerCard for Nightly backup", async () => {
		const view = await mountActs(passport());
		const details = buttons(agentRow(view.container, "di"), "Details");
		expect(details).toHaveLength(2);
		await press(details[1]);
		expect(
			document.querySelector("[data-blocker-card]")?.textContent
		).toContain("Nightly backup");
		await view.dispose();
	});

	test("the HUD summary reads 3 need you · 2 working · 1 failed · 1 limited", async () => {
		const view = await mountActs(passport());
		expect(view.container.textContent).toContain(
			"3 need you · 2 working · 1 failed · 1 limited"
		);
		const queue = view.container.querySelector("[data-queue-button]");
		expect(queue?.textContent).toBe("Queue · 9");
		expect(queue?.closest(".sr-only")).toBeNull();
		await view.dispose();
	});

	test("Gu's Open answer opens the reply card", async () => {
		const view = await mountActs(passport());
		await press(buttons(agentRow(view.container, "gu"), "Open answer")[0]);
		expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
			"Edited 3 files"
		);
		await view.dispose();
	});

	test("AskQueueList lists Ha's heal_fix suggestion", async () => {
		const view = await mountActs(passport());
		const items = [
			...view.container.querySelectorAll(
				"[data-ask-queue='reveal'] [data-ask-queue-item]"
			),
		].map((item) => item.getAttribute("aria-label"));
		expect(items).toContain(
			"Ha suggests: Apply the fix for Daily digest? Waiting 2 hours."
		);
		await view.dispose();
	});

	test("without asks the rows and counters are unchanged", () => {
		const { asks: _asks, ...old } = usefulStateFixture();
		const markup = renderToStaticMarkup(passport(old as InterfaceSnapshot));
		expect(markup).not.toContain("data-act-agent");
		expect(markup).not.toContain("data-act-status");
		expect(markup).not.toContain("data-ask-queue");
		expect(markup).not.toContain("data-queue-button");
		// Today's counts in the title plate.
		expect(markup).toMatch(/\d+ countries · \d+ stamps/);
		// The renderer as it was before the act layer: passport-legacy.golden.html,
		// rendered from the commit before passport adopted acts. Ids and the
		// kit's own stage attributes (data-iso-*) are normalised away in both.
		const sansIds = (html: string) =>
			html
				.replace(/_[rR]_[0-9a-zA-Z]+_/g, "ID")
				.replace(/ data-iso-[a-z-]+="[^"]*"/g, "");
		const golden = sansIds(
			readFileSync(join(import.meta.dir, "passport-legacy.golden.html"), "utf8")
		);
		const { askBlindSpots: _blind, ...bare } = old;
		const render = (snapshot: InterfaceSnapshot) =>
			sansIds(
				renderToStaticMarkup(
					<PassportInterface
						activeThreadId={null}
						loading={false}
						params={{}}
						port={actsPort}
						snapshot={snapshot}
						threadView={null}
					/>
				)
			);
		expect(render(bare as InterfaceSnapshot)).toBe(golden);
		// A host that sends blind spots but no asks still gets today's view.
		expect(render(old as InterfaceSnapshot)).toBe(golden);
		expect(sansIds(markup)).toBe(golden);
	});

	test("redacted: no fixture titles, routine names or targets", () => {
		const markup = renderToStaticMarkup(
			passport(usefulStateFixture({ privacy: "redacted" }))
		);
		for (const secret of FIXTURE_PRIVATE_STRINGS) {
			expect(markup).not.toContain(secret);
		}
	});

	test("the limit reads as a closed border", () => {
		const acts = agentActs(usefulStateFixture(), FIXTURE_NOW, FIXTURE_CLOCK);
		const fa = acts.get(FIXTURE_AGENT_IDS.fa);
		const words = (item: InterfaceAgentAct | undefined) =>
			item &&
			limitWords(item, {
				clock: FIXTURE_CLOCK,
				limitText: borderClosed,
				nowMs: FIXTURE_NOW,
			});
		expect(words(fa)).toBe("Border closed till 15:10");
		const guessed = fa && {
			...fa,
			blockers: [
				{
					kind: "rate-limited",
					source: "estimate",
				} as InterfaceAgentAct["blockers"][number],
			],
			timer: null,
		};
		expect(words(guessed)).toBe("Likely border closed");
	});

	test("villager plates: Ada's answers her ask; Cy's applies for a visa (15a)", async () => {
		const snapshot = usefulStateFixture();
		const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
		const layout = layoutDesk(buildPassport(snapshot), "spread");
		const opened: string[] = [];
		const cast = actOfficers({
			acts,
			layout,
			looks: new Map(
				Object.values(FIXTURE_AGENT_IDS).map((id) => [id, {} as never])
			),
			onAsk: (askId) => opened.push(askId),
			reduced: true,
			shown: new Set(),
		});
		const ada = cast.find((spec) => spec.actAgent === FIXTURE_AGENT_IDS.ada);
		expect(ada?.label).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run. Answer their ask."
		);
		ada?.activate?.();
		expect(opened).toEqual([FIXTURE_ASK_IDS.adaToolCall]);
		const cy = cast.find((spec) => spec.actAgent === FIXTURE_AGENT_IDS.cy);
		expect(cy?.activate).toBeUndefined();
		// Rendered as the kit's plates (drei's Html is a plain wrapper here).
		mock.module("@react-three/drei", () => ({
			Html: ({ children }: { children: ReactNode }) => children,
		}));
		const { VillagerPlate } = await import("./game3d-villager.tsx");
		const plate = (spec: (typeof cast)[number] | undefined) => {
			if (!spec) {
				throw new Error("no plate");
			}
			const holder = document.createElement("div");
			holder.innerHTML = renderToStaticMarkup(
				<VillagerPlate
					onSelect={() => undefined}
					selected={false}
					spec={spec}
				/>
			);
			const button = holder.querySelector("button");
			if (!button) {
				throw new Error("no button");
			}
			return button;
		};
		expect(plate(ada).hasAttribute("aria-pressed")).toBe(false);
		expect(plate(ada).getAttribute("tabindex")).toBe("0");
		expect(plate(cy).getAttribute("aria-pressed")).toBe("false");
		mock.restore();
	});

	test("the customs desk's queue: a row before the booklet's front edge, apart", () => {
		// Test 21's rendered targets are in passport-scene.test.tsx.
		const snapshot = usefulStateFixture();
		for (const mode of ["spread", "single"] as const) {
			const layout = layoutDesk(buildPassport(snapshot), mode);
			const places = customsLayout(layout);
			const paths = deskPaths(layout);
			const toward = (at: readonly number[]) =>
				Math.SQRT1_2 * ((at[0] ?? 0) + (at[2] ?? 0));
			const across = (at: readonly number[]) =>
				Math.SQRT1_2 * ((at[0] ?? 0) - (at[2] ?? 0));
			const slots = (["you-1", "you-2", "you-3", "you-4"] as const).map(
				(point) => {
					expect(paths.points[point]).toEqual(places.slots[point]);
					return places.slots[point];
				}
			);
			for (const [index, slot] of slots.entries()) {
				// Before the booklet's front edge, on the desk.
				expect(toward(slot)).toBeGreaterThan(layout.halfB + 1);
				for (const other of slots.slice(index + 1)) {
					const apart = Math.hypot(
						across(slot) - across(other),
						toward(slot) - toward(other)
					);
					expect(apart).toBeGreaterThan(1.4);
				}
			}
			// Every tab is a place an ask slip starts from.
			for (const station of layout.stations) {
				expect(paths.points[`tab-${station.id}`]).toEqual(station.at);
			}
		}
	});

	test("a failure outranks a running run in the agent's pose; Di's failure stays counted while working", () => {
		const stamp = (marking: string) => ({ marking }) as never;
		expect(countryPose([stamp("processing"), stamp("denied")])).toBe("failed");
		expect(countryPose([stamp("processing")])).toBe("working");
		// Di with a running thread as well as the failures: the act stays on
		// the stopped runs; passport-scene.test.tsx renders its alarms and
		// DENIED stamp.
		const snapshot = usefulStateFixture();
		const di = snapshot.threads.find(
			(thread) => thread.agentIds[0] === FIXTURE_AGENT_IDS.di
		);
		const running = {
			...snapshot,
			threads: [
				...snapshot.threads,
				{ ...(di as InterfaceThread), id: "t-di-live", running: true },
			],
		};
		const acts = agentActs(running, FIXTURE_NOW, FIXTURE_CLOCK);
		expect(acts.get(FIXTURE_AGENT_IDS.di)?.blockers.length).toBeGreaterThan(0);
	});
});

describe("passport desk layout", () => {
	test("a tab per country round the booklet, in page order, never in front", () => {
		const passport = buildPassport(usefulStateFixture());
		for (const mode of ["spread", "single"] as const) {
			const layout = layoutDesk(passport, mode);
			expect(layout.stations.map((station) => station.id)).toEqual(
				passport.countries.map((country) => country.id)
			);
			// Pages run clockwise from the left edge, over the back, down the right.
			const order = { left: 0, right: 2, top: 1 } as const;
			const edges = layout.stations.map((station) => order[station.edge]);
			expect(edges).toEqual([...edges].sort((a, b) => a - b));
			for (const station of layout.stations) {
				expect(station.page).toBe(countryPage(passport.pages, station.id));
				// Outside the booklet, and never past its front edge.
				const [a, b] = station.ab;
				expect(Math.abs(a) > layout.halfA || b < -layout.halfB).toBe(true);
				expect(b).toBeLessThan(layout.halfB);
			}
		}
		// A spread is two pages wide; a phone's single page one.
		expect(layoutDesk(passport, "spread").halfA).toBeGreaterThan(
			layoutDesk(passport, "single").halfA * 1.8
		);
	});

	test("the camera frames the desk, not the looser world box", () => {
		const layout = layoutDesk(buildPassport(usefulStateFixture()), "spread");
		const insets = { bottom: 88, left: 16, right: 16, top: 176 };
		const wide = deskFraming(layout, 1280, 800, insets);
		expect(wide.fill).toBeGreaterThan(1);
		expect(wide.portrait.pitch).toBeGreaterThan(0.56);
		expect(deskFraming(layout, 0, 0, insets).fill).toBe(1);
	});

	test("the shown pages' photos: the first visa page of each country only", () => {
		const passport = buildPassport(usefulStateFixture());
		const spreads = bookletSpreads(passport.pages.length);
		// The cover, then notes and identity: no photos.
		expect(shownPhotos(passport.pages, spreads[0])).toEqual([]);
		expect(shownPhotos(passport.pages, spreads[1])).toEqual([]);
		const visas = shownPhotos(passport.pages, spreads[2]);
		expect(visas.map((photo) => photo.side)).toEqual(["left", "right"]);
		expect(visas.map((photo) => photo.countryId)).toEqual(
			passport.countries.slice(0, 2).map((country) => country.id)
		);
	});
});

describe("passport pages and tabs", () => {
	test("page tabs: identity, each country, unassigned, marking the open pages", () => {
		const passport = buildPassport(snapshotAt(NOON));
		const spreads = bookletSpreads(passport.pages.length);
		const tabs = pageTabs(passport, spreads[1]);
		expect(tabs.map((tab) => tab.label)).toEqual([
			"Identity page",
			"Forge visa pages",
			"Atlas visa pages",
			"Quill visa pages",
			"Unassigned visa pages",
		]);
		expect(tabs.filter((tab) => tab.active).map((tab) => tab.code)).toEqual([
			"ID",
		]);
		expect(spreadCaption(spreads[1], passport.pages.length)).toBe(
			"Pages 1–2 of 6"
		);
		expect(spreadCaption(spreads[0], passport.pages.length)).toBe("Cover");
		const single = singleSpreads(passport.pages.length);
		expect(spreadCaption(single[4], passport.pages.length)).toBe("Page 4 of 6");
	});

	test("the page controls turn pages and jump by tab (a phone's tabs too)", async () => {
		const passport = buildPassport(snapshotAt(NOON));
		const turned: string[] = [];
		const nav = (compact: boolean) => (
			<PageNav
				caption="Pages 3–4 of 6"
				compact={compact}
				hasNext
				hasPrevious={false}
				onNext={() => turned.push("next")}
				onPage={(page) => turned.push(`page ${page}`)}
				onPrevious={() => turned.push("previous")}
				tabs={pageTabs(passport, bookletSpreads(passport.pages.length)[2])}
			/>
		);
		const view = await mount(nav(false));
		expect(
			button(view.container, "Previous page")?.hasAttribute("disabled")
		).toBe(true);
		await click(button(view.container, "Next page"));
		await click(button(view.container, "Atlas visa pages"));
		expect(turned).toEqual(["next", "page 4"]);
		expect(
			button(view.container, "Forge visa pages")?.getAttribute("aria-current")
		).toBe("page");
		await view.rerender(nav(true));
		// A phone stacks the tabs under the arrows, scrolling sideways.
		const list = view.container.querySelector('ul[aria-label="Page tabs"]');
		expect(list?.className).toContain("overflow-x-auto");
		expect(list?.querySelectorAll("button")).toHaveLength(5);
		await view.dispose();
	});

	test("Page Down, Page Up and the arrow keys turn the booklet", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<PassportInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOON)}
				threadView={null}
			/>
		);
		await click(button(view.container, "Booklet"));
		const caption = () =>
			view.container.querySelector('nav[aria-label="Pages"] p')?.textContent;
		const press = async (key: string, target: EventTarget = document.body) => {
			await act(async () => {
				target.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key })
				);
			});
		};
		const start = caption();
		await press("PageDown");
		const after = caption();
		expect(after).not.toBe(start);
		await press("PageUp");
		expect(caption()).toBe(start);
		const inBooklet = view.container.querySelector(
			'[data-testid="passport-booklet"] button'
		);
		await press("ArrowRight", inBooklet ?? document.body);
		expect(caption()).toBe(after);
		await press("Home");
		expect(caption()).toBe("Cover");
		// Typing in a field never turns a page.
		const field = document.createElement("textarea");
		view.container.append(field);
		await press("PageDown", field);
		expect(caption()).toBe("Cover");
		await view.dispose();
	});

	test("visa pages: photo frame, name, emblem, status, and a stamp per conversation", async () => {
		const passport = buildPassport(usefulStateFixture());
		const acts = agentActs(usefulStateFixture(), FIXTURE_NOW, FIXTURE_CLOCK);
		const di = passport.countries.find(
			(country) => country.id === FIXTURE_AGENT_IDS.di
		);
		const page = passport.pages.find(
			(item) => item.kind === "visa" && item.countryId === di?.id
		);
		if (!(di && page?.kind === "visa")) {
			throw new Error("Expected Di's visa page");
		}
		expect(visaStatus(di, acts.get(di.agent.id))).toBe("Entry denied");
		const ed = passport.countries.find(
			(country) => country.id === FIXTURE_AGENT_IDS.ed
		);
		expect(visaStatus(ed ?? null, acts.get(FIXTURE_AGENT_IDS.ed))).toBe(
			"Stopped"
		);
		expect(
			visaStatus(
				passport.countries.find((c) => c.id === FIXTURE_AGENT_IDS.ada) ?? null,
				acts.get(FIXTURE_AGENT_IDS.ada)
			)
		).toBe("Waiting for your signature");
		expect(
			visaStatus(
				passport.countries.find((c) => c.id === FIXTURE_AGENT_IDS.fa) ?? null,
				acts.get(FIXTURE_AGENT_IDS.fa)
			)
		).toBe("Border closed");
		const opened: string[] = [];
		const view = await mount(
			<VisaFace
				activeThreadId={null}
				country={di}
				onOpen={(threadId) => opened.push(threadId)}
				page={page}
				status={visaStatus(di, acts.get(di.agent.id))}
			/>
		);
		const text = view.container.textContent ?? "";
		expect(text).toContain("PHOTO");
		expect(view.container.querySelector("h2")?.textContent).toBe("Di");
		expect(text).toContain(di.code);
		expect(
			view.container.querySelector("[data-visa-status]")?.textContent
		).toBe("Entry denied");
		const stamps = [
			...view.container.querySelectorAll<HTMLButtonElement>(
				"button[data-thread-id]"
			),
		];
		expect(stamps).toHaveLength(di.stamps.length);
		// The stamps keep the booklet's markings: Di's failed runs are denied.
		expect(di.stamps.some((stamp) => stamp.marking === "denied")).toBe(true);
		await click(stamps[0]);
		expect(opened).toEqual([di.stamps[0]?.thread.id ?? ""]);
		await view.dispose();
	});

	test("the identity page: the holder, the totals and the summary line", async () => {
		const passport = buildPassport(snapshotAt(NOON));
		const view = await mount(
			<IdentityFace
				number={2}
				passport={passport}
				summary="3 need you · 2 working"
			/>
		);
		const text = view.container.textContent ?? "";
		expect(text).toContain("You");
		expect(text).toContain(passport.number);
		expect(
			view.container.querySelector("[data-identity-summary]")?.textContent
		).toBe("3 need you · 2 working");
		const totals = [...view.container.querySelectorAll("dd")].map(
			(item) => item.textContent
		);
		expect(totals).toContain(String(passport.totals.stamps));
		await view.dispose();
	});
});

describe("Passport settings", () => {
	test("the cover defaults to navy and falls back on junk", () => {
		expect(resolveInterfaceParams("passport", {})).toMatchObject({
			cover: "navy",
		});
		expect(
			resolveInterfaceParams("passport", { cover: "plaid" })
		).toMatchObject({ cover: "navy" });
		expect(passportSettings({ cover: "green" }).cover).toBe("green");
	});

	test("navy is the stock booklet; other covers repaint the boards only", () => {
		expect(deskArt(false)).toBe(PASSPORT_DESK);
		expect(deskArt(true, "navy")).toBe(PASSPORT_DESK_NIGHT);
		expect(passportVars("navy")).toBe(PASSPORT_VARS);
		const burgundy = deskArt(false, "burgundy");
		expect(burgundy.cover).not.toBe(PASSPORT_DESK.cover);
		expect(burgundy.coverEdge).not.toBe(PASSPORT_DESK.coverEdge);
		expect(burgundy.paper).toBe(PASSPORT_DESK.paper);
		expect(deskArt(true, "burgundy").cover).not.toBe(burgundy.cover);
		const vars = passportVars("black") as Record<string, string>;
		const stock = PASSPORT_VARS as Record<string, string>;
		expect(vars["--pp-cover"]).not.toBe(stock["--pp-cover"]);
		expect(vars["--pp-paper"]).toBe(stock["--pp-paper"]);
	});

	test("the booklet sheet reads the cover from params", async () => {
		const { port } = recordingPort();
		const coverOf = async (cover?: "burgundy") => {
			const view = await mount(
				<PassportInterface
					activeThreadId={null}
					loading={false}
					params={cover ? { cover } : {}}
					port={port}
					snapshot={snapshotAt(NOON)}
					threadView={null}
				/>
			);
			await click(button(view.container, "Booklet"));
			const painted = [
				...view.container.querySelectorAll<HTMLElement>(
					'[data-testid="passport-booklet"] [style]'
				),
			]
				.map((element) => element.style.getPropertyValue("--pp-cover"))
				.find(Boolean);
			await view.dispose();
			return painted;
		};
		const stock = (PASSPORT_VARS as Record<string, string>)["--pp-cover"];
		expect(await coverOf()).toBe(stock);
		expect(await coverOf("burgundy")).toBe(
			(passportVars("burgundy") as Record<string, string>)["--pp-cover"]
		);
	});
});
