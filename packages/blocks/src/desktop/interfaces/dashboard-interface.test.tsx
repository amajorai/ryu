import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceEvent,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardInterface } from "./dashboard-interface.tsx";
import {
	ACTIVITY_HOURS,
	addWidget,
	availableWidgets,
	buildActivity,
	buildDashboard,
	cycleWidgetSize,
	DASHBOARD_LAYOUT_KEY,
	DEFAULT_LAYOUT,
	HOUR_MS,
	type LayoutItem,
	moveWidget,
	parseLayout,
	removeWidget,
	serializeLayout,
	untilLabel,
	WIDGETS,
} from "./dashboard-model.ts";

const MINUTE = 60_000;
/** Local mid-day, mid-hour, so hourly buckets hold in any time zone. */
const NOW = new Date(2026, 9, 12, 12, 30).getTime();

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id">,
	from = NOW
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
		updatedAt: new Date(from - 60 * MINUTE).toISOString(),
		...input,
	};
}

function fixture(from: number, events?: InterfaceEvent[]): InterfaceSnapshot {
	const ago = (minutes: number) =>
		new Date(from - minutes * MINUTE).toISOString();
	const ahead = (minutes: number) =>
		new Date(from + minutes * MINUTE).toISOString();
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
		events: events ?? [
			{
				agentId: "agent-ada",
				id: "run-digest",
				kind: "upcoming",
				label: "Fridays",
				start: ahead(600),
				title: "Weekly digest",
			},
			{
				agentId: "agent-grace",
				count: 24,
				id: "run-sweep",
				kind: "upcoming",
				label: "Every hour",
				start: ahead(30),
				title: "Inbox sweep",
			},
			{
				agentId: "agent-grace",
				end: ago(119),
				id: "run-audit",
				kind: "past",
				label: "Mondays",
				outcome: "failure",
				start: ago(120),
				title: "Dependency audit",
			},
		],
		groups: [],
		threads: [
			thread(
				{
					agentIds: ["agent-ada"],
					id: "thread-notes",
					lastMessage: "Draft is ready for review.",
					pinned: true,
					title: "Release notes",
					updatedAt: ago(20),
				},
				from
			),
			thread(
				{
					agentIds: ["agent-grace"],
					id: "thread-triage",
					lastMessage: "Looking at the stack trace now.",
					running: true,
					title: "Triage crash reports",
					updatedAt: ago(2),
				},
				from
			),
			thread(
				{
					agentIds: ["agent-grace"],
					id: "thread-audit",
					runState: "failed",
					title: "Audit dependencies",
					updatedAt: ago(90),
				},
				from
			),
			thread(
				{
					agentIds: ["agent-ada"],
					id: "thread-question",
					lastMessageRole: "user",
					title: "Question for Ada",
					updatedAt: ago(60 * 30),
				},
				from
			),
		],
		version: 1,
	};
}

// ---------------------------------------------------------------------------
// Layout model
// ---------------------------------------------------------------------------

describe("dashboard layout model", () => {
	test("the default layout uses every panel and fills whole rows", () => {
		const ids = new Set(DEFAULT_LAYOUT.map((item) => item.id));
		for (const spec of WIDGETS.filter((entry) => entry.kind === "panel")) {
			expect(ids.has(spec.id)).toBe(true);
		}
		expect(ids.size).toBe(DEFAULT_LAYOUT.length);
	});

	test("parseLayout returns null for nothing, junk, or the wrong shape", () => {
		expect(parseLayout(null)).toBeNull();
		expect(parseLayout("")).toBeNull();
		expect(parseLayout("{not json")).toBeNull();
		expect(parseLayout(JSON.stringify({ widgets: "nope" }))).toBeNull();
	});

	test("parseLayout drops unknown ids and duplicates and repairs sizes", () => {
		const raw = JSON.stringify({
			version: 1,
			widgets: [
				{ id: "from-the-future", size: "m" },
				{ id: "recent", size: "full" },
				{ id: "recent", size: "s" },
				{ id: "agents", size: "huge" },
				{ id: "stat-working", size: "l" },
				"pinned",
			],
		});
		expect(parseLayout(raw)).toEqual([
			{ id: "recent", size: "full" },
			{ id: "agents", size: "s" },
			{ id: "stat-working", size: "s" },
			{ id: "pinned", size: "s" },
		]);
	});

	test("an empty stored list is a real choice, not a fallback", () => {
		expect(parseLayout(serializeLayout([]))).toEqual([]);
	});

	test("serializeLayout round-trips", () => {
		expect(parseLayout(serializeLayout(DEFAULT_LAYOUT))).toEqual([
			...DEFAULT_LAYOUT,
		]);
	});

	test("moveWidget reorders and clamps", () => {
		const layout: LayoutItem[] = [
			{ id: "recent", size: "m" },
			{ id: "agents", size: "s" },
			{ id: "pinned", size: "s" },
		];
		expect(moveWidget(layout, "pinned", 0).map((item) => item.id)).toEqual([
			"pinned",
			"recent",
			"agents",
		]);
		expect(moveWidget(layout, "recent", 99).map((item) => item.id)).toEqual([
			"agents",
			"pinned",
			"recent",
		]);
		expect(moveWidget(layout, "activity", 0)).toEqual(layout);
	});

	test("cycleWidgetSize walks S, M, L, full and wraps; tiles stop at M", () => {
		let layout: LayoutItem[] = [
			{ id: "recent", size: "s" },
			{ id: "stat-working", size: "s" },
		];
		const sizes: string[] = [];
		for (let step = 0; step < 4; step += 1) {
			layout = cycleWidgetSize(layout, "recent");
			sizes.push(layout[0]?.size ?? "");
		}
		expect(sizes).toEqual(["m", "l", "full", "s"]);
		layout = cycleWidgetSize(layout, "stat-working");
		expect(layout[1]?.size).toBe("m");
		layout = cycleWidgetSize(layout, "stat-working");
		expect(layout[1]?.size).toBe("s");
	});

	test("add and remove keep the catalog in step", () => {
		const base: LayoutItem[] = [
			{ id: "stat-your-turn", size: "s" },
			{ id: "recent", size: "m" },
		];
		const withStat = addWidget(base, "stat-agents");
		expect(withStat.map((item) => item.id)).toEqual([
			"stat-your-turn",
			"stat-agents",
			"recent",
		]);
		const withPanel = addWidget(withStat, "agents");
		expect(withPanel.at(-1)).toEqual({ id: "agents", size: "s" });
		expect(addWidget(withPanel, "agents")).toEqual(withPanel);
		expect(
			availableWidgets(withPanel).some((spec) => spec.id === "agents")
		).toBe(false);
		const removed = removeWidget(withPanel, "agents");
		expect(availableWidgets(removed).some((spec) => spec.id === "agents")).toBe(
			true
		);
	});
});

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

describe("dashboard view model", () => {
	test("activity buckets 24 local hours ending with the current one", () => {
		const snapshot = fixture(NOW);
		const activity = buildActivity(snapshot.threads, NOW);
		expect(activity.buckets).toHaveLength(ACTIVITY_HOURS);
		const last = activity.buckets.at(-1);
		expect(last?.start).toBe(new Date(2026, 9, 12, 12, 0).getTime());
		expect(activity.buckets[0]?.start).toBe(
			(last?.start ?? 0) - (ACTIVITY_HOURS - 1) * HOUR_MS
		);
		// The 30-hour-old thread falls outside the window.
		expect(activity.total).toBe(3);
		expect(last?.threadIds).toEqual(["thread-triage", "thread-notes"]);
		expect(activity.peak).toBe(last ?? null);
		expect(activity.max).toBe(2);
	});

	test("buildDashboard sorts threads into status lists and counts tiles", () => {
		const view = buildDashboard(fixture(NOW), NOW);
		expect(view.byStatus.working.map((item) => item.id)).toEqual([
			"thread-triage",
		]);
		expect(view.byStatus.attention.map((item) => item.id)).toEqual([
			"thread-audit",
		]);
		expect(view.byStatus["your-turn"].map((item) => item.id)).toEqual([
			"thread-notes",
		]);
		expect(view.byStatus.waiting.map((item) => item.id)).toEqual([
			"thread-question",
		]);
		expect(view.pinned.map((item) => item.id)).toEqual(["thread-notes"]);
		expect(view.failedRuns.map((event) => event.id)).toEqual(["run-audit"]);
		expect(view.recent[0]?.id).toBe("thread-triage");
		expect(view.stats).toMatchObject({
			agents: 3,
			agentsWorking: 1,
			attention: 1,
			failedRuns: 1,
			threads: 4,
			updated24h: 3,
			working: 1,
			yourTurn: 1,
		});
		// The hourly sweep due in 30 minutes counts as its 24 runs.
		expect(view.stats.scheduled24h).toBe(25);
	});

	test("upcoming keeps future runs, soonest first, and null without schedules", () => {
		const view = buildDashboard(fixture(NOW), NOW);
		expect(view.upcoming?.map((event) => event.id)).toEqual([
			"run-sweep",
			"run-digest",
		]);
		const bare = { ...fixture(NOW), events: undefined };
		expect(buildDashboard(bare, NOW).upcoming).toBeNull();
	});

	test("agents list working agents first, then by latest thread", () => {
		const view = buildDashboard(fixture(NOW), NOW);
		expect(view.agents.map((row) => row.agent.id)).toEqual([
			"agent-grace",
			"agent-ada",
			"agent-linus",
		]);
		expect(view.agents[0]?.latest?.id).toBe("thread-triage");
		expect(view.agents[2]?.latest).toBeNull();
	});

	test("untilLabel floors so it never overstates the wait", () => {
		const at = (ms: number) => new Date(NOW + ms).toISOString();
		expect(untilLabel(at(30 * 1000), NOW)).toBe("now");
		expect(untilLabel(at(59 * MINUTE + 58_000), NOW)).toBe("in 59m");
		expect(untilLabel(at(5 * HOUR_MS), NOW)).toBe("in 5h");
		expect(untilLabel(at(50 * HOUR_MS), NOW)).toBe("in 2d");
	});
});

// ---------------------------------------------------------------------------
// Rendering and interaction
// ---------------------------------------------------------------------------

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
if (typeof Element.prototype.getAnimations !== "function") {
	Element.prototype.getAnimations = () => [];
}
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

beforeEach(() => {
	globalThis.localStorage?.clear();
});

function recordingPort(): { calls: string[]; port: InterfacePort } {
	const calls: string[] = [];
	return {
		calls,
		port: {
			closeThread: () => calls.push("close"),
			openThread: (id) => calls.push(`open:${id}`),
			startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
		},
	};
}

const HOST_VIEW = <div data-testid="host-view">Host conversation</div>;

function dashboard(
	overrides: Partial<{
		activeThreadId: string | null;
		loading: boolean;
		port: InterfacePort;
		snapshot: InterfaceSnapshot;
		threadView: ReactNode | null;
	}> = {}
): ReactElement {
	return (
		<DashboardInterface
			activeThreadId={overrides.activeThreadId ?? null}
			loading={overrides.loading ?? false}
			params={{}}
			port={overrides.port ?? recordingPort().port}
			snapshot={overrides.snapshot ?? fixture(Date.now())}
			threadView={overrides.threadView ?? null}
		/>
	);
}

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

async function press(element: Element | null | undefined, key: string) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected an element to send keys to");
	}
	await act(async () => {
		element.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

function byLabel(root: ParentNode, label: string): HTMLElement | null {
	return root.querySelector<HTMLElement>(`[aria-label="${label}"]`);
}

function byText(root: ParentNode, text: string): HTMLElement | null {
	return (
		[...root.querySelectorAll<HTMLElement>("button")].find(
			(element) => element.textContent?.trim() === text
		) ?? null
	);
}

function widgetOrder(root: ParentNode): string[] {
	return [...root.querySelectorAll<HTMLElement>("[data-widget-id]")].map(
		(element) => element.dataset.widgetId ?? ""
	);
}

describe("DashboardInterface", () => {
	test("renders every default widget with its title", () => {
		const html = renderToStaticMarkup(dashboard());
		expect(html).toContain('data-testid="interface-dashboard"');
		for (const item of DEFAULT_LAYOUT) {
			expect(html).toContain(`data-widget-id="${item.id}"`);
		}
		expect(html).toContain("Triage crash reports");
		expect(html).toContain("Inbox sweep");
		expect(html).toContain("Run failed");
		expect(html).toContain("Scheduled run failed");
	});

	test("shows a skeleton while loading", () => {
		const html = renderToStaticMarkup(dashboard({ loading: true }));
		expect(html).toContain('aria-busy="true"');
		expect(html).not.toContain("data-widget-id");
	});

	test("shows an empty state with no threads or agents", () => {
		const html = renderToStaticMarkup(
			dashboard({
				snapshot: { agents: [], groups: [], threads: [], version: 1 },
			})
		);
		expect(html).toContain("No threads or agents yet");
		expect(html).toContain("Start a thread");
	});

	test("says so when the host has no schedules", () => {
		const html = renderToStaticMarkup(
			dashboard({ snapshot: { ...fixture(Date.now()), events: undefined } })
		);
		expect(html).toContain("This host has no scheduled routines.");
	});

	test("a list row opens its thread through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(dashboard({ port }));
		const row = view.container.querySelector(
			'[data-widget-id="attention"] [data-thread-id="thread-audit"]'
		);
		await click(row);
		expect(calls).toEqual(["open:thread-audit"]);
		await view.dispose();
	});

	test("an agent with no threads starts one; others open their latest", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(dashboard({ port }));
		await click(
			byLabel(view.container, "Linus: start a thread. Idle, 0 threads.")
		);
		const grace = [
			...view.container.querySelectorAll<HTMLElement>(
				'[data-widget-id="agents"] button'
			),
		].find((element) =>
			element.getAttribute("aria-label")?.startsWith("Grace: open")
		);
		await click(grace);
		expect(calls).toEqual([
			'start:{"agentId":"agent-linus"}',
			"open:thread-triage",
		]);
		await view.dispose();
	});

	test("the open thread shows the host view in a slide-over; Escape closes", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			dashboard({
				activeThreadId: "thread-audit",
				port,
				threadView: HOST_VIEW,
			})
		);
		const panel = view.container.querySelector(
			'[data-testid="dashboard-thread-panel"]'
		);
		expect(panel?.querySelector('[data-testid="host-view"]')).not.toBeNull();
		expect(panel?.textContent).toContain("Audit dependencies");
		expect(panel?.textContent).toContain("Needs attention");
		await press(document.body, "Escape");
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("edit mode resizes, moves, removes, and remembers the layout", async () => {
		const view = await mount(dashboard());
		const root = view.container;
		expect(byLabel(root, "Remove Recent")).toBeNull();
		await click(byLabel(root, "Edit dashboard"));

		const resize = root.querySelector<HTMLElement>(
			'[data-widget-id="recent"] [aria-label^="Resize Recent"]'
		);
		await click(resize);
		expect(
			root.querySelector<HTMLElement>('[data-widget-id="recent"]')?.dataset.size
		).toBe("l");

		const handle = root.querySelector<HTMLElement>(
			'[data-widget-id="pinned"] [aria-label^="Move Pinned"]'
		);
		await press(handle, "Home");
		expect(widgetOrder(root)[0]).toBe("pinned");

		// The removed widget animates out, so read the saved layout instead.
		await click(byLabel(root, "Remove Upcoming runs"));

		const stored = parseLayout(localStorage.getItem(DASHBOARD_LAYOUT_KEY));
		expect(stored?.[0]).toEqual({ id: "pinned", size: "s" });
		expect(stored?.find((item) => item.id === "recent")?.size).toBe("l");
		expect(stored?.some((item) => item.id === "upcoming")).toBe(false);

		await click(byText(root, "Done"));
		expect(byLabel(root, "Remove Recent")).toBeNull();
		await view.dispose();
	});

	test("Escape leaves edit mode", async () => {
		const view = await mount(dashboard());
		await click(byLabel(view.container, "Edit dashboard"));
		expect(byLabel(view.container, "Remove Recent")).not.toBeNull();
		await press(document.body, "Escape");
		expect(byLabel(view.container, "Remove Recent")).toBeNull();
		await view.dispose();
	});

	test("a stored layout is restored and unknown widgets are ignored", async () => {
		localStorage.setItem(
			DASHBOARD_LAYOUT_KEY,
			JSON.stringify({
				version: 1,
				widgets: [
					{ id: "weather", size: "m" },
					{ id: "activity", size: "full" },
					{ id: "stat-agents", size: "s" },
				],
			})
		);
		const view = await mount(dashboard());
		expect(widgetOrder(view.container)).toEqual(["activity", "stat-agents"]);
		expect(
			view.container.querySelector<HTMLElement>('[data-widget-id="activity"]')
				?.dataset.size
		).toBe("full");
		await view.dispose();
	});

	test("reset restores the default arrangement", async () => {
		localStorage.setItem(
			DASHBOARD_LAYOUT_KEY,
			serializeLayout([{ id: "recent", size: "s" }])
		);
		const view = await mount(dashboard());
		await click(byLabel(view.container, "Edit dashboard"));
		await click(byText(view.container, "Reset"));
		expect(widgetOrder(view.container)).toEqual(
			DEFAULT_LAYOUT.map((item) => item.id)
		);
		expect(localStorage.getItem(DASHBOARD_LAYOUT_KEY)).toBeNull();
		await view.dispose();
	});
});
