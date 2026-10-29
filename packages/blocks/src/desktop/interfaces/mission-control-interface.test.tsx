import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceEvent,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { activityTicks } from "./mission-control-activity.tsx";
import { MissionControlInterface } from "./mission-control-interface.tsx";
import {
	ACTIVITY_HOURS,
	buildMissionControl,
	countdown,
	HOUR_MS,
	hourIndex,
	hourlyStarts,
} from "./mission-control-model.ts";

const MINUTE = 60_000;
/** Local mid-day and mid-hour, so buckets and "today" hold in any time zone. */
const NOW = new Date(2026, 9, 12, 12, 30).getTime();
const ago = (minutes: number, from = NOW) =>
	new Date(from - minutes * MINUTE).toISOString();
const ahead = (minutes: number, from = NOW) =>
	new Date(from + minutes * MINUTE).toISOString();

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
		updatedAt: ago(60),
		...input,
	};
}

function fixture(from: number): InterfaceSnapshot {
	const events: InterfaceEvent[] = [
		{
			agentId: "agent-grace",
			end: ago(119, from),
			id: "run-audit",
			kind: "past",
			label: "Every Monday",
			outcome: "failure",
			start: ago(120, from),
			title: "Dependency audit",
		},
		{
			agentId: "agent-ada",
			end: ago(299, from),
			id: "run-backup",
			kind: "past",
			label: "Daily",
			outcome: "success",
			start: ago(300, from),
			title: "Backup check",
		},
		{
			agentId: "agent-linus",
			id: "next-digest",
			kind: "upcoming",
			label: "Fridays",
			start: ahead(600, from),
			title: "Weekly digest",
		},
		{
			agentId: "agent-ada",
			count: 24,
			id: "next-sweep",
			kind: "upcoming",
			label: "Every hour",
			start: ahead(30, from),
			title: "Inbox sweep",
		},
	];
	return {
		agents: [
			{
				avatarUrl: null,
				description: "Writes the release notes",
				id: "agent-ada",
				name: "Ada",
				status: "idle",
			},
			{
				avatarUrl: null,
				description: "Triages bugs",
				id: "agent-grace",
				name: "Grace",
				status: "working",
			},
			{
				avatarUrl: null,
				description: "Never messaged",
				id: "agent-linus",
				name: "Linus",
				status: "idle",
			},
		],
		events,
		groups: [],
		threads: [
			thread({
				agentIds: ["agent-ada"],
				id: "thread-notes",
				lastMessage: "Draft is ready for review.",
				title: "Release notes",
				updatedAt: ago(20, from),
			}),
			thread({
				agentIds: ["agent-ada"],
				id: "thread-question",
				lastMessage: "Can you shorten the intro?",
				lastMessageRole: "user",
				title: "Intro edits",
				updatedAt: ago(90, from),
			}),
			thread({
				agentIds: ["agent-grace"],
				id: "thread-triage",
				lastMessage: "Looking at the crash reports now.",
				running: true,
				title: "Crash triage",
				updatedAt: ago(5, from),
			}),
			thread({
				agentIds: ["agent-grace"],
				id: "thread-flaky",
				lastMessage: "The run stopped.",
				runState: "failed",
				title: "Flaky test",
				updatedAt: ago(150, from),
			}),
			thread({
				id: "thread-old",
				lastMessage: "Ancient history.",
				title: "Last week",
				updatedAt: ago(60 * 24 * 7, from),
			}),
		],
		version: 1,
	};
}

const SNAPSHOT = fixture(NOW);

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
	};
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

function button(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label
	);
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

function render(
	overrides: Partial<Parameters<typeof MissionControlInterface>[0]> = {}
) {
	const { port } = recordingPort();
	return renderToStaticMarkup(
		<MissionControlInterface
			activeThreadId={null}
			loading={false}
			params={{}}
			port={port}
			snapshot={SNAPSHOT}
			threadView={null}
			{...overrides}
		/>
	);
}

describe("mission control model", () => {
	test("buckets the trailing 24 hours, oldest first", () => {
		const starts = hourlyStarts(NOW);
		expect(starts).toHaveLength(ACTIVITY_HOURS);
		expect(starts.at(-1)).toBeLessThanOrEqual(NOW);
		expect(NOW - (starts.at(-1) ?? 0)).toBeLessThan(HOUR_MS);
		expect(hourIndex(starts, NOW)).toBe(ACTIVITY_HOURS - 1);
		expect(hourIndex(starts, NOW + 5 * MINUTE)).toBe(ACTIVITY_HOURS - 1);
		expect(hourIndex(starts, NOW - 25 * HOUR_MS)).toBe(-1);
		expect(hourIndex(starts, Number.NaN)).toBe(-1);
	});

	test("counts statuses and builds the six KPIs", () => {
		const view = buildMissionControl(SNAPSHOT, NOW);
		expect(view.counts).toEqual({
			attention: 1,
			quiet: 0,
			waiting: 1,
			working: 1,
			"your-turn": 2,
		});
		const values = Object.fromEntries(
			view.kpis.map((kpi) => [kpi.id, kpi.value])
		);
		// The failed thread and the failed scheduled run: the same two alarms
		// the banner and the alerts panel report.
		expect(values).toEqual({
			attention: 2,
			online: 2,
			today: 4,
			waiting: 1,
			working: 1,
			"your-turn": 2,
		});
		for (const kpi of view.kpis) {
			expect(kpi.trend).toHaveLength(ACTIVITY_HOURS);
		}
		const tones = Object.fromEntries(
			view.kpis.map((kpi) => [kpi.id, kpi.tone])
		);
		expect(tones.attention).toBe("attention");
		expect(tones.working).toBe("live");
	});

	test("activity counts updates per hour and places finished runs", () => {
		const { activity } = buildMissionControl(SNAPSHOT, NOW);
		expect(activity.total).toBe(4);
		expect(activity.buckets.at(-1)?.threadIds).toEqual([
			"thread-triage",
			"thread-notes",
		]);
		expect(activity.max).toBe(2);
		expect(activity.peak?.count).toBe(2);
		expect(activity.runs.map((run) => run.id)).toEqual([
			"run-backup",
			"run-audit",
		]);
		expect(activityTicks(0)).toEqual([2, 1, 0]);
		expect(activityTicks(3)).toEqual([3, 2, 1, 0]);
		expect(activityTicks(5)).toEqual([6, 4, 2, 0]);
		expect(activityTicks(14)).toEqual([15, 10, 5, 0]);
	});

	test("stations keep agent order and pick the thread each is on", () => {
		const { stations } = buildMissionControl(SNAPSHOT, NOW);
		expect(stations.map((station) => station.agent.name)).toEqual([
			"Ada",
			"Grace",
			"Linus",
		]);
		const [ada, grace, linus] = stations;
		expect(ada?.state).toBe("your-turn");
		expect(ada?.focusThread?.id).toBe("thread-notes");
		expect(grace?.state).toBe("working");
		expect(grace?.focusThread?.id).toBe("thread-triage");
		expect(linus?.state).toBe("idle");
		expect(linus?.focusThread).toBeUndefined();
		expect(linus?.lastActive).toBe(null);
	});

	test("alerts list failures (threads and runs) before advisories", () => {
		const { alerts, banner } = buildMissionControl(SNAPSHOT, NOW);
		expect(alerts.map((alert) => `${alert.severity}:${alert.id}`)).toEqual([
			"warning:run:run-audit",
			"warning:thread:thread-flaky",
			"advisory:thread:thread-notes",
			"advisory:thread:thread-old",
		]);
		expect(banner).toEqual({
			detail: "1 thread · 1 scheduled run",
			headline: "2 failures",
			tone: "attention",
		});
	});

	test("a calm snapshot without events is nominal", () => {
		const calm: InterfaceSnapshot = {
			...SNAPSHOT,
			events: undefined,
			threads: SNAPSHOT.threads.filter((item) => item.id !== "thread-flaky"),
		};
		const view = buildMissionControl(calm, NOW);
		expect(view.banner.tone).toBe("nominal");
		expect(view.banner.headline).toBe("All systems nominal");
		expect(view.upcoming).toEqual([]);
		expect(view.activity.runs).toEqual([]);
		expect(view.alerts.every((alert) => alert.severity === "advisory")).toBe(
			true
		);
	});

	test("upcoming runs sort soonest first; the tape mixes threads and runs", () => {
		const view = buildMissionControl(SNAPSHOT, NOW);
		expect(view.upcoming.map((event) => event.id)).toEqual([
			"next-sweep",
			"next-digest",
		]);
		expect(view.tape.slice(0, 4).map((item) => item.id)).toEqual([
			"thread:thread-triage",
			"thread:thread-notes",
			"thread:thread-question",
			"run:run-audit",
		]);
		expect(view.tape.find((item) => item.id === "run:run-audit")?.mark).toBe(
			"failure"
		);
	});

	test("recent runs list finished runs newest first; stations carry hourly activity", () => {
		const view = buildMissionControl(SNAPSHOT, NOW);
		expect(view.recentRuns.map((event) => event.id)).toEqual([
			"run-audit",
			"run-backup",
		]);
		const calm = buildMissionControl({ ...SNAPSHOT, events: undefined }, NOW);
		expect(calm.recentRuns).toEqual([]);
		const [ada, grace, linus] = view.stations;
		const sum = (values: readonly number[] = []) =>
			values.reduce((total, value) => total + value, 0);
		expect(ada?.hourly).toHaveLength(ACTIVITY_HOURS);
		expect(sum(ada?.hourly)).toBe(2);
		expect(sum(grace?.hourly)).toBe(2);
		expect(sum(linus?.hourly)).toBe(0);
		for (const kpi of view.kpis) {
			expect(kpi.trendNote.startsWith("24h")).toBe(true);
		}
	});

	test("countdowns use one unit style", () => {
		expect(countdown(ahead(90), NOW)).toBe("1h 30m");
		expect(countdown(ahead(45), NOW)).toBe("45m 00s");
		expect(countdown(ahead(60 * 50), NOW)).toBe("2d 2h");
		expect(countdown(ago(1), NOW)).toBe("Due");
		expect(countdown("not a date", NOW)).toBe("");
	});
});

describe("MissionControlInterface", () => {
	test("renders loading and empty states", () => {
		const empty = { ...SNAPSHOT, agents: [], events: [], threads: [] };
		const loadingMarkup = render({ loading: true, snapshot: empty });
		expect(loadingMarkup).toContain('data-testid="interface-mission-control"');
		expect(loadingMarkup).toContain('aria-busy="true"');
		expect(loadingMarkup).toContain("Connecting…");
		expect(loadingMarkup).not.toContain("Agent status");
		// The empty wall is the real wall, zeroed, with a line per panel.
		const emptyMarkup = render({ snapshot: empty });
		expect(emptyMarkup).toContain("No agents yet");
		expect(emptyMarkup).toContain("No alerts");
		expect(emptyMarkup).toContain("No thread updates in the last 24 hours");
		expect(emptyMarkup).toContain("Nothing scheduled");
		expect(emptyMarkup).toContain('data-kpi="working"');
		expect(emptyMarkup).toContain("All systems nominal");
	});

	test("renders the wall: banner, KPIs, stations, alerts, chart, runs, tape", () => {
		const live = fixture(Date.now());
		const markup = render({ snapshot: live });
		expect(markup).toContain("2 failures");
		expect(markup).toContain("Failed");
		expect(markup).not.toContain(">Alert<");
		for (const label of [
			"Working",
			"Needs attention",
			"Your turn",
			"Waiting on agent",
			"Agents active",
			"Updated today",
		]) {
			expect(markup).toContain(`>${label}<`);
		}
		expect(markup).toContain('data-agent-id="agent-grace"');
		expect(markup).toContain('data-severity="warning"');
		expect(markup).toContain("Threads updated per hour, last 24 hours");
		expect(markup).toContain("Inbox sweep");
		expect(markup).toContain("×24/day");
		expect(markup).toContain('aria-label="Latest updates"');
		expect(markup).toContain("Recent runs");
		expect(markup).toContain('data-outcome="failure"');
		expect(markup).toContain("24h · by last update");
		expect(markup).not.toContain('data-testid="mission-thread-panel"');
	});

	test("shows the host thread view in a slide-over", () => {
		const markup = render({
			activeThreadId: "thread-triage",
			threadView: <div data-testid="host-thread-view">Host</div>,
		});
		expect(markup).toContain('data-testid="mission-thread-panel"');
		expect(markup).toContain('data-testid="host-thread-view"');
		expect(markup).toContain('aria-label="Thread: Crash triage"');
		expect(markup).toContain("inert");
	});

	test("stations, alerts, chart, and tape act through the port", async () => {
		const { calls, port } = recordingPort();
		const live = fixture(Date.now());
		const view = await mount(
			<MissionControlInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={live}
				threadView={null}
			/>
		);
		await click(
			button(view.container, "Open Grace's current thread: Crash triage")
		);
		await click(button(view.container, "Message Linus"));
		await click(button(view.container, "Open Flaky test: Run failed"));
		await click(
			button(view.container, "Follow up with Grace on Dependency audit")
		);
		await click(button(view.container, "New thread"));
		const bar = [
			...view.container.querySelectorAll<HTMLButtonElement>(
				"li[data-hour] button"
			),
		].find((item) =>
			item.getAttribute("aria-label")?.endsWith("Open the newest, Crash triage")
		);
		await click(bar);
		const tapeItem = [
			...view.container.querySelectorAll<HTMLButtonElement>(
				"[data-tape-item] button"
			),
		].find((item) => item.getAttribute("aria-label")?.startsWith("Open Intro"));
		await click(tapeItem);
		expect(calls).toEqual([
			"open:thread-triage",
			'start:{"agentId":"agent-linus"}',
			"open:thread-flaky",
			'start:{"agentId":"agent-grace"}',
			"start:{}",
			"open:thread-triage",
			"open:thread-question",
		]);
		await view.dispose();
	});

	test("the tape is one static list, newest first, every entry focusable", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<MissionControlInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={fixture(Date.now())}
				threadView={null}
			/>
		);
		const tape = view.container.querySelector('[aria-label="Latest updates"]');
		expect(tape?.querySelectorAll("ul")).toHaveLength(1);
		expect(tape?.querySelector('[aria-hidden="true"] button')).toBeNull();
		const entries = [...(tape?.querySelectorAll("[data-tape-item]") ?? [])];
		expect(entries.length).toBeGreaterThan(2);
		expect(
			new Set(entries.map((entry) => entry.getAttribute("data-tape-item"))).size
		).toBe(entries.length);
		for (const item of tape?.querySelectorAll("button") ?? []) {
			expect(item.tabIndex).toBe(0);
		}
		await view.dispose();
	});

	test("Review jumps to the first failure and lights the alerts panel", async () => {
		const { port } = recordingPort();
		const live = fixture(Date.now());
		const view = await mount(
			<MissionControlInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={live}
				threadView={null}
			/>
		);
		const review = [...view.container.querySelectorAll("button")].find(
			(candidate) => candidate.textContent?.includes("Review")
		);
		await click(review);
		const flashing = view.container.querySelector('[data-flash="true"]');
		expect(flashing).not.toBeNull();
		expect(
			view.container
				.querySelector('li[data-flash="true"]')
				?.getAttribute("data-severity")
		).toBe("warning");
		// The newest failure is a scheduled run; its action is the follow-up.
		expect(document.activeElement?.getAttribute("aria-label")).toBe(
			"Follow up with Grace on Dependency audit"
		);
		await view.dispose();
	});

	test("every waiting-on-you advisory is listed; the list scrolls instead of collapsing", async () => {
		const { port } = recordingPort();
		const from = Date.now();
		const base = fixture(from);
		const extra = [1, 2, 3, 4].map((index) =>
			thread({
				agentIds: ["agent-ada"],
				id: `thread-extra-${index}`,
				lastMessage: "Ready when you are.",
				title: `Extra ${index}`,
				updatedAt: ago(30 + index, from),
			})
		);
		const view = await mount(
			<MissionControlInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={{ ...base, threads: [...base.threads, ...extra] }}
				threadView={null}
			/>
		);
		expect(
			view.container.querySelectorAll('li[data-severity="advisory"]').length
		).toBe(6);
		expect(
			[...view.container.querySelectorAll("button")].some((candidate) =>
				candidate.textContent?.includes("more")
			)
		).toBe(false);
		await view.dispose();
	});

	test("scheduled runs switch between upcoming and recent tabs", async () => {
		const { port } = recordingPort();
		const live = fixture(Date.now());
		const view = await mount(
			<MissionControlInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={live}
				threadView={null}
			/>
		);
		const tabs = [...view.container.querySelectorAll('[role="tab"]')];
		expect(tabs.map((tab) => tab.textContent)).toEqual([
			"Upcoming2",
			"Recent2",
		]);
		const panelFor = (tab: Element | undefined) =>
			view.container.querySelector(
				`#${CSS.escape(tab?.getAttribute("aria-controls") ?? "")}`
			);
		const [upcoming, recent] = tabs;
		expect(upcoming?.getAttribute("aria-selected")).toBe("true");
		expect(panelFor(recent)?.hasAttribute("hidden")).toBe(true);
		await click(recent);
		expect(recent?.getAttribute("aria-selected")).toBe("true");
		expect(panelFor(recent)?.hasAttribute("hidden")).toBe(false);
		expect(panelFor(upcoming)?.hasAttribute("hidden")).toBe(true);
		expect(
			panelFor(recent)?.querySelector('[data-outcome="failure"]')
		).not.toBeNull();
		await view.dispose();
	});

	test("Escape and the close button close the panel; focus returns", async () => {
		const calls: string[] = [];
		const live = fixture(Date.now());
		function Host() {
			const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
			const port: InterfacePort = {
				closeThread: () => {
					calls.push("close");
					setActiveThreadId(null);
				},
				openThread: (id) => {
					calls.push(`open:${id}`);
					setActiveThreadId(id);
				},
				startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
			};
			return (
				<MissionControlInterface
					activeThreadId={activeThreadId}
					loading={false}
					params={{}}
					port={port}
					snapshot={live}
					threadView={activeThreadId ? <div>Host view</div> : null}
				/>
			);
		}
		const view = await mount(<Host />);
		const opener = button(
			view.container,
			"Open Grace's current thread: Crash triage"
		);
		opener?.focus();
		await click(opener);
		const heading = view.container.querySelector(
			'[data-testid="mission-thread-panel"] h2'
		);
		expect(heading?.textContent).toBe("Crash triage");
		expect(document.activeElement).toBe(heading);

		await act(async () => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		expect(calls).toEqual(["open:thread-triage", "close"]);
		expect(document.activeElement).toBe(opener ?? null);

		await click(button(view.container, "Open Flaky test: Run failed"));
		await click(button(view.container, "Close thread"));
		expect(calls.slice(2)).toEqual(["open:thread-flaky", "close"]);
		await view.dispose();
	});
});
