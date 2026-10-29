import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ArenaInterface } from "./arena-interface.tsx";
import {
	arenaAgentTally,
	arenaNextUp,
	arenaStats,
	arenaUpcomingRuns,
	buildArenaCards,
	matchesArenaFilter,
	untilLabel,
} from "./arena-model.ts";

const MINUTE = 60_000;
const BASE = Date.parse("2026-10-12T12:00:00Z");
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
	groups: [
		{
			id: "team-docs",
			kind: "team",
			memberAgentIds: ["agent-ada", "agent-linus"],
			name: "Docs Crew",
		},
	],
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
		thread({
			id: "thread-loose",
			lastMessage: "Who owns this?",
			lastMessageRole: "user",
			title: "Loose ends",
			updatedAt: ago(600),
		}),
	],
	version: 1,
};

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

describe("arena model", () => {
	test("classifies agents and resolves focus and per-status threads", () => {
		const cards = buildArenaCards(SNAPSHOT);
		expect(cards.map((card) => card.name)).toEqual(["Grace", "Ada", "Linus"]);
		const [grace, ada, linus] = cards;
		expect(grace?.state).toBe("working");
		expect(grace?.focusThreadId).toBe("thread-triage");
		expect(grace?.latestByStatus.attention).toBe("thread-flaky");
		expect(grace?.needsYou).toBe(1);
		expect(ada?.state).toBe("needs-you");
		expect(ada?.latestByStatus.waiting).toBe("thread-question");
		expect(linus?.state).toBe("idle");
		expect(linus?.focusThread).toBeUndefined();
	});

	test("an idle agent with a failed run is failed, and still needs you", () => {
		const snapshot: InterfaceSnapshot = {
			...SNAPSHOT,
			agents: SNAPSHOT.agents.map((agent) => ({ ...agent, status: "idle" })),
			threads: SNAPSHOT.threads.map((item) => ({ ...item, running: false })),
		};
		const grace = buildArenaCards(snapshot).find(
			(card) => card.agentId === "agent-grace"
		);
		expect(grace?.state).toBe("failed");
		expect(grace && matchesArenaFilter(grace, "needs-you")).toBe(true);
		expect(grace && matchesArenaFilter(grace, "idle")).toBe(false);
	});

	test("names who shares the focus thread and counts shared threads", () => {
		const snapshot: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: [
				thread({
					agentIds: ["agent-ada", "agent-linus"],
					id: "thread-team",
					teamId: "team-docs",
					title: "Docs plan",
					updatedAt: ago(1),
				}),
				...SNAPSHOT.threads,
			],
		};
		const cards = buildArenaCards(snapshot);
		const ada = cards.find((card) => card.agentId === "agent-ada");
		expect(ada?.focusWith).toBe("Docs Crew");
		expect(ada?.shared["your-turn"]).toBe(1);
		expect(arenaStats(snapshot).yourTurn).toBe(2);
	});

	test("a shared thread shows once; later cards show their own thread", () => {
		const team = thread({
			agentIds: ["agent-ada", "agent-linus"],
			id: "thread-team",
			teamId: "team-docs",
			title: "Docs plan",
			updatedAt: ago(1),
		});
		const withOwn = buildArenaCards({
			...SNAPSHOT,
			threads: [
				team,
				thread({
					agentIds: ["agent-linus"],
					id: "thread-linus",
					title: "Style guide",
					updatedAt: ago(200),
				}),
				...SNAPSHOT.threads,
			],
		});
		const ada = withOwn.find((card) => card.agentId === "agent-ada");
		const linus = withOwn.find((card) => card.agentId === "agent-linus");
		expect(ada?.focusThreadId).toBe("thread-team");
		expect(linus?.focusThreadId).toBe("thread-linus");
		expect(linus?.focusRepeat).toBe(false);
		const onlyShared = buildArenaCards({
			...SNAPSHOT,
			threads: [team, ...SNAPSHOT.threads],
		}).find((card) => card.agentId === "agent-linus");
		expect(onlyShared?.focusThreadId).toBe("thread-team");
		expect(onlyShared?.focusRepeat).toBe(true);
	});

	test("filter chips partition agents by the badge each card wears", () => {
		const cards = buildArenaCards(SNAPSHOT);
		const names = (filter: Parameters<typeof matchesArenaFilter>[1]) =>
			cards
				.filter((card) => matchesArenaFilter(card, filter))
				.map((card) => card.name);
		expect(names("all")).toEqual(["Grace", "Ada", "Linus"]);
		expect(names("working")).toEqual(["Grace"]);
		expect(names("needs-you")).toEqual(["Ada"]);
		expect(names("idle")).toEqual(["Linus"]);
	});

	test("next up is the newest failed run, else the newest reply", () => {
		expect(arenaNextUp(SNAPSHOT)?.thread.id).toBe("thread-flaky");
		const calm: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: SNAPSHOT.threads.filter((item) => item.id !== "thread-flaky"),
		};
		expect(arenaNextUp(calm)?.thread.id).toBe("thread-notes");
		expect(arenaNextUp({ ...SNAPSHOT, threads: [] })).toBe(null);
	});

	test("aggregates thread and agent numbers", () => {
		expect(arenaStats(SNAPSHOT)).toEqual({
			agentCount: 3,
			agentsWorking: 1,
			failed: 1,
			needsYou: 2,
			threadCount: 5,
			unassigned: 1,
			waiting: 2,
			yourTurn: 1,
		});
	});
});

describe("Arena header and schedule", () => {
	test("the header tallies agents in the filter chips' unit", () => {
		expect(arenaAgentTally(buildArenaCards(SNAPSHOT))).toEqual({
			failed: 0,
			needsYou: 1,
			total: 3,
			working: 1,
		});
	});

	test("lists upcoming runs soonest first and says how soon", () => {
		const event = (id: string, minutes: number, kind: "past" | "upcoming") => ({
			agentId: null,
			id,
			kind,
			label: null,
			start: new Date(BASE + minutes * MINUTE).toISOString(),
			title: id,
		});
		const runs = arenaUpcomingRuns(
			[
				event("later", 60 * 30, "upcoming"),
				event("done", -10, "past"),
				event("soon", 5, "upcoming"),
			],
			BASE
		);
		expect(runs.map((run) => run.id)).toEqual(["soon", "later"]);
		expect(arenaUpcomingRuns(undefined, BASE)).toEqual([]);
		const at = (minutes: number) =>
			new Date(BASE + minutes * MINUTE).toISOString();
		expect(untilLabel(at(5), BASE)).toBe("in 5m");
		expect(untilLabel(at(59.8), BASE)).toBe("in 1h");
		expect(untilLabel(at(60 * 20), BASE)).toBe("in 20h");
		expect(untilLabel(at(60 * 24 * 3), BASE)).toBe("in 3d");
	});
});

describe("ArenaInterface", () => {
	test("renders loading and empty states", () => {
		const { port } = recordingPort();
		const empty = { ...SNAPSHOT, agents: [], threads: [] };
		const loadingMarkup = renderToStaticMarkup(
			<ArenaInterface
				activeThreadId={null}
				loading
				params={{}}
				port={port}
				snapshot={empty}
				threadView={null}
			/>
		);
		expect(loadingMarkup).toContain('data-testid="interface-arena"');
		expect(loadingMarkup).toContain('aria-busy="true"');
		const emptyMarkup = renderToStaticMarkup(
			<ArenaInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={empty}
				threadView={null}
			/>
		);
		expect(emptyMarkup).toContain("No agents on the wall yet");
	});

	test("shows the host thread view in a panel beside the wall", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<ArenaInterface
				activeThreadId="thread-triage"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div data-testid="host-thread-view">Host</div>}
			/>
		);
		expect(markup).toContain('data-testid="arena-thread-panel"');
		expect(markup).toContain('data-testid="host-thread-view"');
		expect(markup).toContain('aria-label="Thread: Crash triage"');
		// The panel owns closing; the lead card does not repeat it.
		expect(markup).not.toContain('aria-label="Close Crash triage"');
		expect(markup.match(/aria-label="Close thread"/g)).toHaveLength(1);
		// The header counts agents, the same unit as the filter chips below it,
		// so its "need you" number always matches the "Needs you" chip.
		expect(markup).toContain(
			'need you<span class="sr-only">. 1 agent with a failed run'
		);
		expect(markup).toContain('title="Needs you (1 agent)"');
		expect(markup).toContain("your turn");
	});

	test("card actions and filters act through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<ArenaInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await click(
			button(view.container, "Open Grace's live thread: Crash triage")
		);
		await click(button(view.container, "Message Linus"));
		await click(
			button(view.container, "Open Grace's latest failed run (1 total)")
		);
		expect(calls).toEqual([
			"open:thread-triage",
			'start:{"agentId":"agent-linus"}',
			"open:thread-flaky",
		]);
		const linusCard = view.container.querySelector(
			'article[data-agent-id="agent-linus"]'
		);
		expect(
			[...(linusCard?.querySelectorAll("button") ?? [])].map((item) =>
				item.getAttribute("aria-label")
			)
		).toEqual(["Message Linus"]);

		await click(button(view.container, "Idle (1 agent)"));
		const cards = view.container.querySelectorAll("article[data-agent-id]");
		expect(
			[...cards].map((card) => card.getAttribute("data-agent-id"))
		).toEqual(["agent-linus"]);
		await view.dispose();
	});

	test("the card leading the open thread mirrors it and closes it", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<ArenaInterface
				activeThreadId="thread-loose"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div>Host</div>}
			/>
		);
		expect(view.container.textContent).toContain("Loose ends");
		expect(view.container.querySelector('li[aria-current="true"]')).not.toBe(
			null
		);
		await view.dispose();

		const leading = await mount(
			<ArenaInterface
				activeThreadId="thread-triage"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div>Host</div>}
			/>
		);
		const current = leading.container.querySelector(
			'article[aria-current="true"]'
		);
		expect(current?.getAttribute("data-agent-id")).toBe("agent-grace");
		await click(button(leading.container, "Close thread"));
		await click(button(leading.container, "Open Loose ends"));
		expect(calls).toEqual(["close", "open:thread-loose"]);
		await leading.dispose();
	});

	test("focus follows the panel and the opener's card leads a shared thread", async () => {
		const shared: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: [
				thread({
					agentIds: ["agent-ada", "agent-linus"],
					id: "thread-team",
					teamId: "team-docs",
					title: "Docs plan",
					updatedAt: ago(1),
				}),
				...SNAPSHOT.threads,
			],
		};
		const calls: string[] = [];
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
				<ArenaInterface
					activeThreadId={activeThreadId}
					loading={false}
					params={{}}
					port={port}
					snapshot={shared}
					threadView={activeThreadId ? <div>Host</div> : null}
				/>
			);
		}
		const view = await mount(<Host />);
		const container = view.container;
		const linusOpen = button(
			container,
			"Open Linus's latest thread: Docs plan"
		);
		await act(async () => linusOpen?.focus());
		await click(linusOpen);
		expect(calls).toEqual(["open:thread-team"]);
		const current = container.querySelector('article[aria-current="true"]');
		expect(current?.getAttribute("data-agent-id")).toBe("agent-linus");
		expect(document.activeElement?.tagName).toBe("H2");
		expect(document.activeElement?.textContent).toBe("Docs plan");

		await act(async () => {
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		expect(calls).toEqual(["open:thread-team", "close"]);
		expect(document.activeElement?.getAttribute("aria-label")).toBe(
			"Open Linus's latest thread: Docs plan"
		);
		expect(container.textContent).toContain("You wrote last");
		await view.dispose();
	});
});
