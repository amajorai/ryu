import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceAgent,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { TickerInterface } from "./ticker-interface.tsx";
import {
	activitySeries,
	buildTickerQuotes,
	countdown,
	DEFAULT_TICKER_RANGE,
	DEFAULT_TICKER_SORT,
	dailyActivity,
	describeChange,
	formatChange,
	formatPercent,
	leadThread,
	nextSort,
	openingPrice,
	seriesDirection,
	shownPercent,
	sortQuotes,
	spokenAge,
	symbolCandidates,
	tapeItems,
	tickerIndex,
	tickerSymbols,
	upcomingRuns,
} from "./ticker-model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Local noon, so "today" and "yesterday" never straddle a time zone edge. */
const NOW = new Date(2026, 9, 12, 12, 0, 0).getTime();
const at = (offset: number) => new Date(NOW - offset).toISOString();

function agent(id: string, name: string, working = false): InterfaceAgent {
	return {
		avatarUrl: null,
		description: `${name} does things`,
		id,
		name,
		status: working ? "working" : "idle",
	};
}

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
		updatedAt: at(HOUR),
		...input,
	};
}

/** Threads placed relative to `now`, so the component's own clock agrees. */
function fixture(now: number): InterfaceSnapshot {
	const ago = (offset: number) => new Date(now - offset).toISOString();
	return {
		agents: [
			agent("agent-forge", "Forge", true),
			agent("agent-echo", "Echo"),
			agent("agent-cipher", "Cipher"),
		],
		events: [
			{
				agentId: "agent-echo",
				id: "event-sweep",
				kind: "upcoming",
				label: "Every hour",
				start: new Date(now + HOUR).toISOString(),
				title: "Inbox sweep",
			},
			{
				agentId: null,
				id: "event-report",
				kind: "upcoming",
				label: "Monthly",
				start: new Date(now + 3 * DAY).toISOString(),
				title: "Usage report",
			},
			{
				agentId: "agent-forge",
				id: "event-old",
				kind: "past",
				label: "Daily",
				outcome: "success",
				start: ago(DAY),
				title: "Old run",
			},
		],
		groups: [
			{
				id: "team-launch",
				kind: "team",
				memberAgentIds: ["agent-forge", "agent-echo"],
				name: "Launch Crew",
			},
		],
		threads: [
			thread({
				agentIds: ["agent-forge"],
				id: "thread-hero",
				lastMessage: "Swapping the hero now.",
				messageCount: 9,
				running: true,
				title: "Rebuild the hero",
				updatedAt: ago(MINUTE),
			}),
			thread({
				agentIds: ["agent-forge", "agent-echo"],
				id: "thread-plan",
				lastMessage: "Plan locked.",
				messageCount: 20,
				title: "Launch plan",
				updatedAt: ago(10 * MINUTE),
			}),
			thread({
				agentIds: ["agent-echo"],
				id: "thread-changelog",
				lastMessage: "Guide is in the docs folder.",
				messageCount: 4,
				title: "Changelog guide",
				updatedAt: ago(DAY),
			}),
			thread({
				agentIds: ["agent-echo"],
				id: "thread-notes",
				lastMessage: "Notes drafted.",
				messageCount: 3,
				title: "Release notes",
				updatedAt: ago(DAY + HOUR),
			}),
			thread({
				agentIds: ["agent-cipher"],
				id: "thread-audit",
				lastMessage: "Two advisories affect us.",
				messageCount: 5,
				runState: "failed",
				title: "Audit advisories",
				updatedAt: ago(2 * HOUR),
			}),
			thread({
				id: "thread-loose",
				lastMessage: "Who owns this?",
				lastMessageRole: "user",
				messageCount: 1,
				title: "Loose ends",
				updatedAt: ago(30 * MINUTE),
			}),
		],
		version: 1,
	};
}

const SNAPSHOT = fixture(NOW);
/** A narrowed sparkline has more points than a "flat, then today" pair. */
const SPARK_MIN_POINTS = 2;

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
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

function requireElement(element: Element | null | undefined): HTMLElement {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected an element");
	}
	return element;
}

async function click(element: Element | null | undefined) {
	const target = requireElement(element);
	await act(async () => target.click());
}

async function press(element: Element | null | undefined, key: string) {
	const target = requireElement(element);
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}

function byLabel(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find((candidate) =>
		(candidate.getAttribute("aria-label") ?? "").startsWith(label)
	);
}

function rowOrder(container: HTMLElement): string[] {
	return [
		...container.querySelectorAll("[data-testid='ticker-watchlist'] tbody tr"),
	].map((row) => row.getAttribute("data-agent-id") ?? "");
}

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

describe("ticker symbols", () => {
	test("derive readable 3–4 letter symbols", () => {
		const names = ["Atlas", "Brook", "Cipher", "Delta", "Echo", "Forge"];
		const symbols = tickerSymbols(
			names.map((name) => agent(`agent-${name}`, name))
		);
		expect([...symbols.values()]).toEqual([
			"ATLS",
			"BRK",
			"CPHR",
			"DLT",
			"ECHO",
			"FRG",
		]);
		expect(symbolCandidates("Code Review Bot")[0]).toBe("CRB");
		expect(symbolCandidates("Release Notes")[0]).toBe("RNO");
	});

	test("stay unique and uppercase for duplicates, short and non-Latin names", () => {
		const agents = [
			agent("a", "Atlas"),
			agent("b", "Atlas"),
			agent("c", "Atlas"),
			agent("d", "Al"),
			agent("e", "李华"),
			agent("f", "李华"),
			agent("g", ""),
			agent("h", "Café"),
		];
		const symbols = [...tickerSymbols(agents).values()];
		expect(new Set(symbols).size).toBe(agents.length);
		for (const symbol of symbols) {
			expect(symbol).toMatch(/^[A-Z]{3,4}$/);
		}
		expect(symbols.slice(0, 3)).toEqual(["ATLS", "ATL", "ATLA"]);
		expect(symbols[7]).toBe("CAFE");
	});
});

describe("ticker model", () => {
	test("buckets threads by their latest local day, oldest first", () => {
		const days = dailyActivity(SNAPSHOT.threads, 3, NOW);
		expect(days.map((day) => day.threads)).toEqual([0, 2, 4]);
		expect(days.map((day) => day.messages)).toEqual([0, 7, 35]);
		expect(days.at(-1)?.key).toBe("2026-10-12");
	});

	test("closes each day on a running total seeded by older threads", () => {
		const days = dailyActivity(SNAPSHOT.threads, 3, NOW);
		const total = SNAPSHOT.threads.reduce(
			(sum, thread) => sum + thread.messageCount,
			0
		);
		const opening = total - 42;
		expect(openingPrice(days)).toBe(opening);
		expect(days.map((day) => day.close)).toEqual([opening, opening + 7, total]);
		expect(seriesDirection(days)).toBe("up");
		expect(seriesDirection(dailyActivity([], 7, NOW))).toBe("flat");
	});

	test("quotes price messages and move by today's messages", () => {
		const quotes = buildTickerQuotes(SNAPSHOT, NOW);
		const [forge, echo, cipher] = quotes;
		expect(forge?.symbol).toBe("FRG");
		expect(forge?.price).toBe(29);
		expect(forge?.previousClose).toBe(0);
		expect(forge?.change).toBe(29);
		expect(forge?.changePercent).toBe(null);
		expect(forge?.direction).toBe("up");
		expect(forge?.todayThreads).toBe(2);
		// Sparklines narrow to the stretch with activity, like the chart.
		expect(forge?.spark[0]).toBe(0);
		expect(forge?.spark.at(-1)).toBe(29);
		expect(forge?.spark.length).toBeGreaterThan(SPARK_MIN_POINTS);
		expect(forge?.stats).toMatchObject({ threads: 2, working: 1, yourTurn: 1 });
		expect(forge?.groups).toEqual(["Launch Crew"]);
		expect(echo?.price).toBe(27);
		// Price and change share a unit: the price less yesterday's close.
		expect(echo?.previousClose).toBe(7);
		expect(echo?.change).toBe(20);
		expect(echo?.changePercent).toBeCloseTo((20 / 7) * 100);
		expect(echo?.direction).toBe("up");
		expect(echo?.todayThreads).toBe(1);
		expect(echo?.spark[0]).toBe(0);
		expect(echo?.spark).toContain(7);
		expect(echo?.spark.at(-1)).toBe(27);
		expect(echo?.threads.map((item) => item.id)).toEqual([
			"thread-plan",
			"thread-changelog",
			"thread-notes",
		]);
		expect(cipher?.stats.attention).toBe(1);
		expect(cipher && leadThread(cipher)?.id).toBe("thread-audit");
		expect(forge && leadThread(forge)?.id).toBe("thread-hero");
	});

	test("a series narrows to the stretch with activity instead of a wall", () => {
		const forgeThreads = SNAPSHOT.threads.filter((item) =>
			item.agentIds.includes("agent-forge")
		);
		// Everything happened in the last ten minutes: minute buckets, not days.
		const recent = activitySeries(forgeThreads, 14, NOW);
		expect(recent.unit).toBe("time");
		expect(recent.narrowed).toBe(true);
		expect(recent.opening).toBe(0);
		expect(recent.buckets.at(-1)?.close).toBe(29);
		const active = recent.buckets.filter((bucket) => bucket.threads > 0);
		expect(active.length).toBe(2);
		expect(recent.buckets.length).toBeLessThanOrEqual(24);
		expect(recent.buckets[0]?.date).toBeLessThan(NOW - 10 * MINUTE);
		// Activity spread over weeks keeps whole days.
		const spread = activitySeries(
			[
				thread({ id: "old", messageCount: 3, updatedAt: at(10 * DAY) }),
				thread({ id: "new", messageCount: 2, updatedAt: at(HOUR) }),
			],
			14,
			NOW
		);
		expect(spread.unit).toBe("day");
		expect(spread.buckets.at(-1)?.close).toBe(5);
		expect(spread.buckets.filter((bucket) => bucket.threads > 0).length).toBe(
			2
		);
		// A quiet range keeps every day, flat at the opening price.
		const quiet = activitySeries(
			[thread({ id: "older", messageCount: 4, updatedAt: at(40 * DAY) })],
			7,
			NOW
		);
		expect(quiet.unit).toBe("day");
		expect(quiet.narrowed).toBe(false);
		expect(quiet.buckets.length).toBe(7);
		expect(quiet.buckets.every((bucket) => bucket.close === 4)).toBe(true);
	});

	test("percent moves hide when their base is too small to mean anything", () => {
		expect(shownPercent(640, 10, 74)).toBe(null);
		expect(shownPercent(500, 7, 42)).toBe(null);
		expect(shownPercent(20, 50, 60)).toBe(20);
		expect(shownPercent(null, 50, 60)).toBe(null);
		expect(spokenAge("1m")).toBe("1 minute ago");
		expect(spokenAge("3h")).toBe("3 hours ago");
		expect(spokenAge("now")).toBe("just now");
	});

	test("an agent with no activity is flat at zero", () => {
		const quotes = buildTickerQuotes(
			{ ...SNAPSHOT, agents: [agent("agent-new", "Nova")] },
			NOW
		);
		expect(quotes[0]).toMatchObject({
			change: 0,
			changePercent: 0,
			direction: "flat",
			lastActive: null,
			previousClose: 0,
			price: 0,
		});
		expect(quotes[0] && leadThread(quotes[0])).toBe(undefined);
	});

	test("the index covers every thread and counts breadth", () => {
		const quotes = buildTickerQuotes(SNAPSHOT, NOW);
		expect(tickerIndex(SNAPSHOT, quotes, NOW)).toEqual({
			active: 3,
			change: 35,
			changePercent: 500,
			direction: "up",
			previousClose: 7,
			price: 42,
			quiet: 0,
			threads: 6,
			todayThreads: 4,
			working: 1,
		});
	});

	test("sorts by each column with stable ties", () => {
		const quotes = buildTickerQuotes(SNAPSHOT, NOW);
		const symbolsBy = (sort: Parameters<typeof sortQuotes>[1]) =>
			sortQuotes(quotes, sort).map((quote) => quote.symbol);
		expect(symbolsBy(DEFAULT_TICKER_SORT)).toEqual(["FRG", "ECHO", "CPHR"]);
		expect(symbolsBy({ direction: "asc", key: "symbol" })).toEqual([
			"CPHR",
			"ECHO",
			"FRG",
		]);
		expect(symbolsBy({ direction: "desc", key: "change" })).toEqual([
			"FRG",
			"ECHO",
			"CPHR",
		]);
		expect(symbolsBy({ direction: "asc", key: "change" })).toEqual([
			"CPHR",
			"ECHO",
			"FRG",
		]);
		expect(nextSort(DEFAULT_TICKER_SORT, "price")).toEqual({
			direction: "asc",
			key: "price",
		});
		expect(nextSort(DEFAULT_TICKER_SORT, "symbol")).toEqual({
			direction: "asc",
			key: "symbol",
		});
		expect(nextSort(DEFAULT_TICKER_SORT, "change")).toEqual({
			direction: "desc",
			key: "change",
		});
	});

	test("the tape lists the newest messages with their symbols", () => {
		const symbols = tickerSymbols(SNAPSHOT.agents);
		const items = tapeItems(SNAPSHOT, symbols, 3);
		expect(items.map((item) => [item.threadId, item.symbol])).toEqual([
			["thread-hero", "FRG"],
			["thread-plan", "FRG"],
			["thread-loose", null],
		]);
		expect(items[2]?.role).toBe("user");
	});

	test("upcoming runs skip past events and sort soonest first", () => {
		const runs = upcomingRuns(SNAPSHOT, tickerSymbols(SNAPSHOT.agents), NOW);
		expect(runs.map((run) => [run.event.id, run.symbol])).toEqual([
			["event-sweep", "ECHO"],
			["event-report", null],
		]);
		expect(countdown(new Date(NOW + 5 * MINUTE).toISOString(), NOW)).toBe(
			"in 5m"
		);
		expect(countdown(new Date(NOW + 3 * HOUR).toISOString(), NOW)).toBe(
			"in 3h"
		);
		expect(countdown(new Date(NOW + 2 * DAY).toISOString(), NOW)).toBe("in 2d");
	});

	test("formats moves with signs, a true minus, and a dash for no baseline", () => {
		expect(formatChange(2)).toBe("+2");
		expect(formatChange(-1)).toBe("−1");
		expect(formatChange(0)).toBe("0");
		expect(formatPercent(100)).toBe("+100.0%");
		expect(formatPercent(-50)).toBe("−50.0%");
		expect(formatPercent(0)).toBe("0.0%");
		expect(formatPercent(null)).toBe("—");
		expect(describeChange(-1, -50)).toBe(
			"down 1 message in threads active today, 50.0 percent"
		);
		expect(describeChange(35, null)).toBe(
			"up 35 messages in threads active today, none before today"
		);
		expect(describeChange(0, 0)).toBe("no threads active today");
	});
});

describe("TickerInterface", () => {
	test("renders loading and empty states", () => {
		const { port } = recordingPort();
		const empty = { ...SNAPSHOT, agents: [], events: [], threads: [] };
		const loadingMarkup = renderToStaticMarkup(
			<TickerInterface
				activeThreadId={null}
				loading
				params={{}}
				port={port}
				snapshot={empty}
				threadView={null}
			/>
		);
		expect(loadingMarkup).toContain('data-testid="interface-ticker"');
		expect(loadingMarkup).toContain('aria-busy="true"');
		expect(loadingMarkup).toContain('data-slot="skeleton"');
		const emptyMarkup = renderToStaticMarkup(
			<TickerInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={empty}
				threadView={null}
			/>
		);
		// Empty keeps the real chrome: the table and its headers, one quiet row.
		expect(emptyMarkup).toContain('data-testid="ticker-watchlist"');
		expect(emptyMarkup).toContain('aria-sort="descending"');
		expect(emptyMarkup).toContain("No agents yet");
		expect(emptyMarkup).toContain("No messages yet");
		// The detail pane says so once, with the same action as the header.
		expect(emptyMarkup).toContain('data-testid="ticker-detail-empty"');
		expect(emptyMarkup).not.toContain("priced by their messages");
	});

	test("lists every agent as a ticker and details the top one", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<TickerInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={fixture(Date.now())}
				threadView={null}
			/>
		);
		expect(markup).toContain('data-testid="ticker-watchlist"');
		expect(markup).toContain('data-testid="ticker-tape"');
		expect(markup).toContain('aria-sort="descending"');
		expect(markup).toContain('data-testid="ticker-detail"');
		expect(markup).toContain('id="ticker-detail-symbol">FRG');
		expect(markup).toContain("Upcoming runs");
		expect(markup).toContain('data-testid="ticker-price-chart"');
		expect(markup).toContain(
			'aria-label="Rebuild the hero, Forge, 1 minute ago"'
		);
		expect(markup).not.toContain('aria-label="Tape: ');
		// Mono is for symbols only; figures are sans with tabular numerals.
		expect(markup).not.toContain("font-mono tabular-nums");
		expect(markup).not.toContain("text-[11px]");
		// One unit per change pill (messages), never a percent or a "new" tag.
		expect(markup).not.toMatch(/>new</i);
		expect(markup).not.toContain("animate-ping");
		expect(markup).not.toContain("linearGradient");
		expect(markup).not.toContain('data-testid="ticker-thread-panel"');
	});

	test("the move is labelled as threads active today, and the sparkline header bounds the range", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<TickerInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={fixture(Date.now())}
				threadView={null}
			/>
		);
		const detail = markup.slice(markup.indexOf('data-testid="ticker-detail"'));
		expect(detail).toContain(">Active today<");
		expect(detail).not.toContain(">Today<");
		const header = markup.match(
			/<th[^>]*data-testid="ticker-spark-header"[^>]*>(.*?)<\/th>/
		);
		expect(header?.[0]).toContain(
			'title="Recent activity within the past 2 weeks"'
		);
		expect(header?.[1]).toContain(
			'<span class="sr-only">Recent activity within the past 2 weeks</span>'
		);
	});

	test("the detail opens on a two-week line chart narrowed to its activity", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<TickerInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={fixture(Date.now())}
				threadView={null}
			/>
		);
		expect(DEFAULT_TICKER_RANGE).toBe(14);
		expect(markup).toContain("Recent activity within the past 2 weeks");
		expect(markup).not.toMatch(/past week\b/i);
		const chart = markup.slice(
			markup.indexOf('data-testid="ticker-price-chart"')
		);
		expect(chart).toContain('data-unit="time"');
		const line = chart.match(/<path class="fill-none[^"]*" d="([^"]+)"/)?.[1];
		expect(line).toBeDefined();
		expect(line).toMatch(/^M0,[\d.]+ L/);
		expect(line).not.toMatch(/ [HV]/);
		// A line view only, as Robinhood draws it: no volume strip.
		expect(chart).not.toContain('data-testid="ticker-volume-bar"');
		// The caption names the narrowed window the axis actually draws.
		expect(markup).toMatch(/>Since \d{2}:\d{2}</);
		// Range buttons say what they are, so "1M" never matches a tape item.
		expect(markup).toContain('aria-label="2 weeks"');
		expect(markup).toContain('aria-label="1 month"');
		// No absurd percent on a near-zero base in the header.
		expect(markup).not.toContain("500.0%");
		// Breadth: a zero count reads muted, never in the move's colour.
		const live = fixture(Date.now());
		const breadth = tickerIndex(
			live,
			buildTickerQuotes(live, Date.now()),
			Date.now()
		);
		const breadthTone = (markup_: string, label: string) =>
			markup_.match(
				new RegExp(`title="${label}"><span class="tabular-nums ([^"]+)"`)
			)?.[1];
		expect(breadthTone(markup, "Tickers with threads active today")).toBe(
			breadth.active > 0 ? "text-status-success" : "text-muted-foreground"
		);
		expect(markup).toContain('title="Tickers with no thread active today"');
		const idle = renderToStaticMarkup(
			<TickerInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={{ ...live, threads: [] }}
				threadView={null}
			/>
		);
		expect(breadthTone(idle, "Tickers with threads active today")).toBe(
			"text-muted-foreground"
		);
		// One move per watchlist row: the pill, not a second line under the price.
		expect(markup).not.toMatch(/block font-mono text-\[11px\]/);
	});

	test("shows the host thread view in a panel and selects its ticker", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<TickerInterface
				activeThreadId="thread-audit"
				loading={false}
				params={{}}
				port={port}
				snapshot={fixture(Date.now())}
				threadView={<div data-testid="host-thread-view">Host</div>}
			/>
		);
		expect(markup).toContain('data-testid="ticker-thread-panel"');
		expect(markup).toContain('data-testid="host-thread-view"');
		expect(markup).toContain('aria-label="Thread: Audit advisories"');
		expect(markup).toContain('id="ticker-detail-symbol">CPHR');
	});

	test("selection, sorting, and actions go through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<TickerInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={fixture(Date.now())}
				threadView={null}
			/>
		);
		const { container } = view;
		expect(rowOrder(container)).toEqual([
			"agent-forge",
			"agent-echo",
			"agent-cipher",
		]);

		await click(byLabel(container, "ECHO, Echo"));
		const detail = container.querySelector("[data-testid='ticker-detail']");
		expect(detail?.getAttribute("data-agent-id")).toBe("agent-echo");
		expect(byLabel(container, "ECHO, Echo")?.getAttribute("aria-current")).toBe(
			"true"
		);

		await click(byLabel(container, "Message Echo"));
		await click(byLabel(container, "Open Changelog guide"));

		await click(
			[...container.querySelectorAll("th button")].find(
				(button) => button.textContent === "Symbol"
			)
		);
		expect(rowOrder(container)).toEqual([
			"agent-cipher",
			"agent-echo",
			"agent-forge",
		]);
		expect(
			container
				.querySelector("th[aria-sort='ascending']")
				?.textContent?.startsWith("Symbol")
		).toBe(true);

		await click(byLabel(container, "Inbox sweep"));
		expect(calls).toEqual([
			'start:{"agentId":"agent-echo"}',
			"open:thread-changelog",
		]);
		await view.dispose();
	});

	test("arrow keys move the selection; Enter opens the lead thread; T messages", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<TickerInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={fixture(Date.now())}
				threadView={null}
			/>
		);
		const { container } = view;
		const selectedId = () =>
			container
				.querySelector("[data-testid='ticker-detail']")
				?.getAttribute("data-agent-id");
		await press(byLabel(container, "FRG, Forge"), "ArrowDown");
		expect(selectedId()).toBe("agent-echo");
		await press(byLabel(container, "ECHO, Echo"), "End");
		expect(selectedId()).toBe("agent-cipher");
		await press(byLabel(container, "CPHR, Cipher"), "Enter");
		await press(byLabel(container, "CPHR, Cipher"), "t");
		await press(byLabel(container, "CPHR, Cipher"), "Home");
		expect(selectedId()).toBe("agent-forge");
		expect(calls).toEqual([
			"open:thread-audit",
			'start:{"agentId":"agent-cipher"}',
		]);
		await view.dispose();
	});

	test("the tape opens threads and the panel closes through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<TickerInterface
				activeThreadId="thread-hero"
				loading={false}
				params={{}}
				port={port}
				snapshot={fixture(Date.now())}
				threadView={<div>Host</div>}
			/>
		);
		const { container } = view;
		await click(
			container.querySelector(
				"[data-testid='ticker-tape'] button[data-thread-id='thread-loose']"
			)
		);
		await click(byLabel(container, "Close thread"));
		await press(
			container.querySelector("[data-testid='interface-ticker']"),
			"Escape"
		);
		expect(calls).toEqual(["open:thread-loose", "close", "close"]);
		const current = container.querySelector(
			"[data-testid='ticker-detail'] button[aria-current='true']"
		);
		expect(current?.getAttribute("data-thread-id")).toBe("thread-hero");
		await view.dispose();
	});

	test("a price that moves while on screen flashes in its direction", async () => {
		const { port } = recordingPort();
		const snapshot = fixture(Date.now());
		const render = (next: InterfaceSnapshot) => (
			<TickerInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={next}
				threadView={null}
			/>
		);
		const view = await mount(render(snapshot));
		const tick = (agentId: string) =>
			view.container
				.querySelector(`tr[data-agent-id='${agentId}'] [data-price-tick]`)
				?.getAttribute("data-price-tick");
		expect(tick("agent-cipher")).toBe(undefined);
		await view.rerender(
			render({
				...snapshot,
				threads: snapshot.threads.map((item) =>
					item.id === "thread-audit" ? { ...item, messageCount: 8 } : item
				),
			})
		);
		expect(tick("agent-cipher")).toBe("up");
		expect(tick("agent-forge")).toBe(undefined);
		await view.dispose();
	});
});
