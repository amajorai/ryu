import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { MotionGlobalConfig } from "motion/react";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { GlanceAgentsFace } from "./glance-faces.tsx";
import { GlanceHome, glanceClockWidgetType } from "./glance-home.tsx";
import { GlanceInterface } from "./glance-interface.tsx";
import {
	buildGlanceAgents,
	buildGlanceFlow,
	glanceClock,
	glanceKeyAction,
	glanceListWindow,
	glanceRunWhen,
	glanceSharedGroup,
	glanceTileColumns,
	glanceUpcoming,
	glanceWaitingLine,
	glanceWaitingOnAgent,
	glanceWaitingOnYou,
	glanceWorking,
	glanceWorkingLine,
	stepGlanceFace,
} from "./glance-model.ts";
import { GLANCE_STATE_TEXT, GlanceMark } from "./glance-parts.tsx";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BASE = Date.parse("2026-10-12T12:00:00Z");
// Scheduled runs sit around the real clock: the renderer reads Date.now().
const NOW = Date.now();
/** Interactive tests mount a full renderer; allow for a loaded machine. */
const MOUNT_TIMEOUT_MS = 30_000;
const ago = (minutes: number) =>
	new Date(BASE - minutes * MINUTE).toISOString();

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

const SNAPSHOT: InterfaceSnapshot = {
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
	events: [
		{
			agentId: "agent-ada",
			id: "event-past",
			kind: "past",
			label: "Daily",
			outcome: "success",
			start: new Date(NOW - 3 * HOUR).toISOString(),
			title: "Backup check",
		},
		{
			agentId: null,
			id: "event-later",
			kind: "upcoming",
			label: "Monthly",
			start: new Date(NOW + 30 * HOUR).toISOString(),
			title: "Usage report",
		},
		{
			agentId: "agent-grace",
			id: "event-soon",
			kind: "upcoming",
			label: "Every hour",
			start: new Date(NOW + 40 * MINUTE).toISOString(),
			title: "Inbox sweep",
		},
	],
	groups: [],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-question",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-old-reply",
			lastMessage: "Here is the summary.",
			title: "Weekly summary",
			updatedAt: ago(10),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			lastMessage: "The run stopped.",
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(120),
		}),
	],
	version: 1,
};

const EMPTY: InterfaceSnapshot = {
	agents: [],
	events: [],
	groups: [],
	threads: [],
	version: 1,
};

const registeredDom = globalThis.document === undefined;
// Faces hand over in sequence; skip the timing so a swap lands at once.
MotionGlobalConfig.skipAnimations = true;
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

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

async function press(key: string) {
	await act(async () => {
		document.body.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key })
		);
	});
}

/** Buttons whose accessible name is exactly, or starts with, `label`. */
function button(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find((candidate) => {
		const name =
			candidate.getAttribute("aria-label") ?? candidate.textContent ?? "";
		return name === label || name.startsWith(label);
	});
}

function tab(container: HTMLElement, label: string) {
	return container.querySelector(`[role='tab'][aria-label='${label}']`);
}

function root(container: HTMLElement) {
	const element = container.querySelector("[data-testid='interface-glance']");
	if (!element) {
		throw new Error("Glance root missing");
	}
	return element;
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

function glance(
	overrides: Partial<Parameters<typeof GlanceInterface>[0]> = {}
): ReactElement {
	const { port } = recordingPort();
	return (
		<GlanceInterface
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

describe("glance model", () => {
	test("faces wrap in both directions and keys map to actions", () => {
		expect(stepGlanceFace("clock", 1)).toBe("agents");
		expect(stepGlanceFace("flow", 1)).toBe("clock");
		expect(stepGlanceFace("clock", -1)).toBe("flow");
		const key = (name: string, extra = {}) => ({
			altKey: false,
			ctrlKey: false,
			key: name,
			metaKey: false,
			...extra,
		});
		expect(glanceKeyAction(key("ArrowRight"))).toBe("next");
		expect(glanceKeyAction(key("ArrowLeft"))).toBe("previous");
		expect(glanceKeyAction(key("Escape"))).toBe("close");
		expect(glanceKeyAction(key("ArrowRight", { metaKey: true }))).toBeNull();
		expect(glanceKeyAction(key("j"))).toBeNull();
	});

	test("waiting on you puts failed runs first, then the newest replies", () => {
		expect(glanceWaitingOnYou(SNAPSHOT).map((item) => item.id)).toEqual([
			"thread-flaky",
			"thread-old-reply",
			"thread-notes",
		]);
		expect(glanceWorking(SNAPSHOT).map((item) => item.id)).toEqual([
			"thread-triage",
		]);
		expect(glanceWaitingOnAgent(SNAPSHOT).map((item) => item.id)).toEqual([
			"thread-question",
		]);
		expect(glanceWaitingLine(0)).toBe("Nothing needs you");
		expect(glanceWaitingLine(1)).toBe("1 thread needs you");
		expect(glanceWaitingLine(3)).toBe("3 threads need you");
		expect(glanceWorkingLine(0)).toBe("No agents working");
		expect(glanceWorkingLine(1)).toBe("1 agent working");
		expect(glanceWorkingLine(4)).toBe("4 agents working");
	});

	test("agent tiles keep snapshot order and a working tile shows its live run", () => {
		const tiles = buildGlanceAgents(SNAPSHOT);
		expect(tiles.map((tile) => tile.agent.name)).toEqual([
			"Ada",
			"Grace",
			"Linus",
		]);
		const [ada, grace, linus] = tiles;
		expect(ada?.state).toBe("your-turn");
		expect(ada?.thread?.id).toBe("thread-notes");
		expect(ada?.active).toBe(true);
		// Grace has a failed run and a newer reply, but she is working.
		expect(grace?.state).toBe("working");
		expect(grace?.thread?.id).toBe("thread-triage");
		expect(grace?.threadCount).toBe(3);
		expect(linus?.state).toBe("idle");
		expect(linus?.thread).toBeNull();
		expect(linus?.active).toBe(false);
		expect(glanceTileColumns(4)).toBe(2);
		expect(glanceTileColumns(6)).toBe(2);
		expect(glanceTileColumns(7)).toBe(3);
	});

	test("long lists fold into one more line, and shared threads name their group", () => {
		expect(glanceListWindow(6, 6)).toEqual({ hidden: 0, shown: 6 });
		expect(glanceListWindow(7, 6)).toEqual({ hidden: 2, shown: 5 });
		expect(glanceListWindow(0, 4)).toEqual({ hidden: 0, shown: 0 });
		const withGroup: InterfaceSnapshot = {
			...SNAPSHOT,
			groups: [
				{ id: "team-x", kind: "team", memberAgentIds: [], name: "Crew" },
			],
		};
		const shared = thread({
			agentIds: ["agent-ada", "agent-grace"],
			id: "s",
			teamId: "team-x",
		});
		const solo = thread({ agentIds: ["agent-ada"], id: "o", teamId: "team-x" });
		expect(glanceSharedGroup(withGroup, shared)).toBe("Crew");
		expect(glanceSharedGroup(withGroup, solo)).toBeNull();
		expect(glanceSharedGroup(SNAPSHOT, shared)).toBeNull();
	});

	test("run times read for a glance", () => {
		const now = new Date(2026, 9, 13, 9, 0).getTime();
		const at = (hours: number) => new Date(now + hours * HOUR).toISOString();
		expect(glanceRunWhen(at(40 / 60), now, "en-US")).toBe("in 40m");
		expect(glanceRunWhen(at(59.8 / 60), now, "en-US")).toBe("in 1h");
		expect(glanceRunWhen(at(3), now, "en-US")).toBe("in 3h");
		expect(glanceRunWhen(at(10), now, "en-US")).toBe("Today 7 PM");
		expect(glanceRunWhen(at(24), now, "en-US")).toBe("Tomorrow 9 AM");
		expect(glanceRunWhen(at(72.5), now, "en-US")).toBe("Fri 9:30 AM");
		expect(glanceRunWhen(at(240), now, "en-US")).toBe("Oct 23");
		expect(glanceRunWhen("not a date", now)).toBe("");
		expect(glanceUpcoming(SNAPSHOT, NOW).map((event) => event.id)).toEqual([
			"event-soon",
			"event-later",
		]);
		expect(glanceUpcoming({ ...SNAPSHOT, events: undefined }, NOW)).toEqual([]);
	});

	test("the clock drops the day period from its digits", () => {
		const clock = glanceClock(new Date(2026, 9, 13, 9, 41), "en-US");
		expect(clock).toEqual({
			date: "Tuesday, October 13",
			period: "AM",
			time: "9:41",
		});
		expect(glanceClock(new Date(2026, 9, 13, 21, 5), "en-GB").period).toBe(
			null
		);
	});

	test("flow paints a calm field plus one light per agent, faster when working", () => {
		const blobs = buildGlanceFlow(SNAPSHOT);
		expect(blobs).toHaveLength(2 + SNAPSHOT.agents.length);
		const grace = blobs.find((blob) => blob.id === "agent-grace");
		const linus = blobs.find((blob) => blob.id === "agent-linus");
		expect(grace?.working).toBe(true);
		expect(grace?.tone).toBe("success");
		expect(linus?.working).toBe(false);
		expect(grace?.duration ?? 0).toBeLessThan(linus?.duration ?? 0);
		for (const blob of blobs) {
			expect(blob.x).toBeGreaterThanOrEqual(0);
			expect(blob.x).toBeLessThanOrEqual(1);
		}
		expect(buildGlanceFlow(EMPTY)).toHaveLength(2);
	});
});

describe("GlanceInterface", () => {
	test("renders the clock face, loading, and empty states", () => {
		const markup = renderToStaticMarkup(glance());
		expect(markup).toContain('data-testid="interface-glance"');
		expect(markup).toContain('data-face="clock"');
		// Near is the default, so the first frame shows the detail widgets.
		expect(markup).toContain('data-distance="near"');
		expect(markup).toContain("Needs you");
		expect(markup).toContain("Flaky test");
		expect(markup).toContain(">Distance</span>");
		expect(markup).toContain('role="tablist"');

		const loading = renderToStaticMarkup(
			glance({ loading: true, snapshot: EMPTY })
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).not.toContain("need you");

		const empty = renderToStaticMarkup(glance({ snapshot: EMPTY }));
		expect(empty).toContain("Nothing needs you");
	});

	test(
		"shows the host thread view in a sheet and closes through the port",
		async () => {
			const { calls, port } = recordingPort();
			const markup = renderToStaticMarkup(
				glance({
					activeThreadId: "thread-triage",
					port,
					threadView: <div data-testid="host-thread-view">Host</div>,
				})
			);
			expect(markup).toContain('data-testid="glance-thread-sheet"');
			expect(markup).toContain('data-testid="host-thread-view"');
			expect(markup).toContain('aria-label="Thread: Crash triage"');

			const view = await mount(
				glance({
					activeThreadId: "thread-triage",
					port,
					threadView: <div>Host</div>,
				})
			);
			await click(button(view.container, "Close thread"));
			await press("Escape");
			expect(calls).toEqual(["close", "close"]);
			await view.dispose();
		},
		MOUNT_TIMEOUT_MS
	);

	test(
		"the clock line, tiles, and keys act through the port",
		async () => {
			const { calls, port } = recordingPort();
			const view = await mount(glance({ port }));
			await click(button(view.container, "Far"));
			expect(root(view.container).getAttribute("data-distance")).toBe("far");
			await click(
				button(view.container, "3 threads need you. Open Flaky test")
			);

			await press("ArrowRight");
			expect(root(view.container).getAttribute("data-face")).toBe("agents");
			await click(button(view.container, "Grace, Working. Open Crash triage"));
			await click(button(view.container, "Linus, Idle. Start a thread"));

			await press("ArrowLeft");
			expect(root(view.container).getAttribute("data-face")).toBe("clock");
			await click(tab(view.container, "Flow"));
			expect(root(view.container).getAttribute("data-face")).toBe("flow");
			expect(tab(view.container, "Flow")?.getAttribute("aria-selected")).toBe(
				"true"
			);

			expect(calls).toEqual([
				"open:thread-flaky",
				"open:thread-triage",
				'start:{"agentId":"agent-linus"}',
			]);
			await view.dispose();
		},
		MOUNT_TIMEOUT_MS
	);

	test(
		"distance switches Near detail on and the Home Screen opens threads",
		async () => {
			const { calls, port } = recordingPort();
			const view = await mount(glance({ port }));
			expect(root(view.container).getAttribute("data-distance")).toBe("near");
			expect(view.container.textContent).toContain("Next run");
			expect(view.container.textContent).toContain("Inbox sweep");

			await click(button(view.container, "Home Screen"));
			expect(root(view.container).getAttribute("data-state")).toBe("home");
			const widgets = [...view.container.querySelectorAll("[data-widget]")].map(
				(widget) => widget.getAttribute("data-widget")
			);
			expect(widgets).toEqual([
				"Needs you",
				"Working",
				"Clock",
				"Waiting on agents",
				"Upcoming runs",
				"Agents",
			]);
			await click(button(view.container, "Open Release notes"));
			await click(button(view.container, "1 waiting on agents"));
			expect(calls).toEqual(["open:thread-notes", "open:thread-question"]);

			await press("Escape");
			expect(root(view.container).getAttribute("data-state")).toBe("faces");

			// While the Home Screen is up its toggle says how to leave it.
			await click(button(view.container, "Home Screen"));
			await click(button(view.container, "Done"));
			expect(root(view.container).getAttribute("data-state")).toBe("faces");
			await view.dispose();
		},
		MOUNT_TIMEOUT_MS
	);

	test(
		"an empty agents face offers a first thread",
		async () => {
			const { calls, port } = recordingPort();
			const view = await mount(glance({ port, snapshot: EMPTY }));
			await click(tab(view.container, "Agents"));
			expect(view.container.textContent).toContain("No agents yet");
			await click(button(view.container, "New thread"));
			expect(calls).toEqual(["start:{}"]);
			await view.dispose();
		},
		MOUNT_TIMEOUT_MS
	);
});

describe("GlanceHome", () => {
	const home = (now: number) =>
		renderToStaticMarkup(
			<GlanceHome
				distance="far"
				loading={false}
				now={now}
				onOpenThread={() => undefined}
				onStartWithAgent={() => undefined}
				snapshot={SNAPSHOT}
			/>
		);

	test("the clock widget fits two-digit hours in its own width", () => {
		for (const [hour, minute] of [
			[12, 58],
			[23, 58],
		] as const) {
			const at = new Date(2026, 9, 13, hour, minute);
			const { time } = glanceClock(at);
			const markup = home(at.getTime());
			expect(time.length).toBeGreaterThanOrEqual(4);
			expect(markup).toContain(`>${time}`);
			// The digits are sized against the widget, never the whole display.
			expect(markup).toContain("[container-type:inline-size]");
			expect(markup).toContain(glanceClockWidgetType(time));
		}
		expect(glanceClockWidgetType("12:58")).toBe("text-[min(36cqi,1em)]");
		expect(glanceClockWidgetType("9:41")).toBe("text-[min(44cqi,1em)]");
	});

	test("one label for the set that needs you, and no decorative stripes", () => {
		const markup = home(NOW);
		expect(markup).toContain('data-widget="Needs you"');
		expect(markup).not.toContain('data-widget="Your turn"');
		expect(markup).not.toContain("Waiting on you</h3>");
		expect(markup).not.toContain("bg-primary/50");
	});
});

describe("GlanceAgentsFace", () => {
	const face = (distance: "far" | "near") =>
		renderToStaticMarkup(
			<GlanceAgentsFace
				distance={distance}
				loading={false}
				now={NOW}
				onOpenThread={() => undefined}
				onShowAll={() => undefined}
				onStartThread={() => undefined}
				onStartWithAgent={() => undefined}
				snapshot={SNAPSHOT}
			/>
		);

	test("far tiles carry name and status only; near adds the thread", () => {
		const far = face("far");
		expect(far).toContain("Your turn");
		expect(far).not.toContain(">Release notes<");
		expect(far).not.toContain(" · ");
		const near = face("near");
		expect(near).toContain("Release notes");
	});
});

describe("GlanceMark", () => {
	test("your turn and working differ in form, not only in hue", () => {
		const yourTurn = renderToStaticMarkup(<GlanceMark state="your-turn" />);
		const working = renderToStaticMarkup(<GlanceMark state="working" />);
		expect(working).toContain("data-mark-ring");
		expect(yourTurn).not.toContain("data-mark-ring");
		// A theme may make primary and success the same hue; the word stays apart.
		expect(GLANCE_STATE_TEXT["your-turn"]).toBe("text-foreground");
		expect(GLANCE_STATE_TEXT.working).not.toBe(GLANCE_STATE_TEXT["your-turn"]);
	});
});
