// Must stay first: happy-dom has to exist before React DOM and Base UI load.
import "./panels-test-dom.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { PanelsChatOpen } from "./panels-chat.tsx";
import { PanelsInterface } from "./panels-interface.tsx";
import {
	activityItems,
	buildAgentRows,
	buildPanelsActions,
	buildTopics,
	firstSentence,
	panelHeaderActions,
	panelsGreeting,
	panelsSummary,
	runWhen,
	skyAt,
	skyPhase,
	summarySentence,
	upcomingRuns,
} from "./panels-model.ts";
import { PANELS_DOM_FLAG } from "./panels-test-dom.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Scheduled runs sit around the real clock: the renderer reads Date.now().
const NOW = Date.now();
const MOUNT_TIMEOUT_MS = 30_000;
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();

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
			description: "Reviews pull requests.",
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
			outcome: "failure",
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
	groups: [
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Website",
		},
		{
			id: "team-core",
			kind: "team",
			memberAgentIds: ["agent-grace"],
			name: "Core",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			projectId: "project-site",
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
			teamId: "team-core",
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-failed",
			lastMessage: "The audit stopped on a timeout.",
			runState: "failed",
			teamId: "team-core",
			title: "Dependency audit.",
			updatedAt: ago(120),
		}),
	],
	version: 1,
};

const EMPTY: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: 1,
};

const registeredDom = Reflect.get(globalThis, PANELS_DOM_FLAG) === true;
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

function viewButton(container: HTMLElement, view: string) {
	return container.querySelector(
		`[data-testid='panels-sidebar'] [data-view='${view}']`
	);
}

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (threadId) => calls.push(`open:${threadId}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

function panels(
	overrides: Partial<Parameters<typeof PanelsInterface>[0]> = {}
): ReactElement {
	return (
		<PanelsInterface
			activeThreadId={null}
			loading={false}
			params={{}}
			port={recordingPort().port}
			snapshot={SNAPSHOT}
			threadView={null}
			{...overrides}
		/>
	);
}

describe("panels model", () => {
	test("places the sun by day and the moon by night", () => {
		const noon = skyAt(new Date(2026, 9, 14, 12, 30));
		expect(noon.body).toBe("sun");
		expect(noon.phase).toBe("day");
		expect(noon.progress).toBeCloseTo(0.5, 2);
		expect(noon.altitude).toBeCloseTo(1, 2);
		const midnight = skyAt(new Date(2026, 9, 14, 0, 30));
		expect(midnight.body).toBe("moon");
		expect(midnight.phase).toBe("night");
		expect(midnight.progress).toBeGreaterThan(0);
		expect(midnight.progress).toBeLessThan(1);
		expect(skyPhase(new Date(2026, 9, 14, 6, 15))).toBe("dawn");
		expect(skyPhase(new Date(2026, 9, 14, 18, 15))).toBe("dusk");
	});

	test("suggests the most urgent actions first, verb first", () => {
		const actions = buildPanelsActions(SNAPSHOT);
		expect(actions.map((action) => action.kind)).toEqual([
			"retry",
			"reply",
			"ask",
			"follow-up",
		]);
		expect(actions[0]?.sentence).toBe(
			"Retry Grace's failed run on Dependency audit"
		);
		expect(actions[1]?.sentence).toBe("Reply to Ada about Release notes");
		expect(actions[0]?.target).toEqual({
			kind: "open",
			threadId: "thread-failed",
		});
	});

	test("offers to ask an agent you have not talked to", () => {
		const actions = buildPanelsActions(SNAPSHOT, 8);
		const ask = actions.find((action) => action.kind === "ask");
		expect(ask?.sentence).toBe("Ask Linus about reviews pull requests");
		expect(ask?.target).toEqual({ agentId: "agent-linus", kind: "start" });
	});

	test("leaves live runs out of the suggestions", () => {
		const actions = buildPanelsActions(SNAPSHOT, 8);
		expect(
			actions.some(
				(action) =>
					action.target.kind === "open" &&
					action.target.threadId === "thread-triage"
			)
		).toBe(false);
	});

	test("phrases a thread waiting on its agent as a check, not a chase", () => {
		const actions = buildPanelsActions(SNAPSHOT, 8);
		const check = actions.find((action) => action.kind === "follow-up");
		expect(check?.verb).toBe("Follow up");
		expect(check?.sentence.startsWith("Follow up with Ada on")).toBe(true);
	});

	test("lists recent activity as events, without live runs", () => {
		const items = activityItems(SNAPSHOT, NOW, 8);
		expect(items.some((item) => item.id === "thread:thread-triage")).toBe(
			false
		);
		const run = items.find((item) => item.id === "run:event-past");
		expect(run?.verb).toBe("failed");
		expect(run?.actor).toBe("Backup check");
		const notes = items.find((item) => item.id === "thread:thread-notes");
		expect(`${notes?.actor} ${notes?.verb}`).toBe("Ada replied");
		const ats = items.map((item) => item.at);
		expect([...ats].sort().reverse()).toEqual(ats);
	});

	test("trims a detail to its first full sentence", () => {
		expect(firstSentence("Here are three directions. B keeps contrast")).toBe(
			"Here are three directions."
		);
		expect(firstSentence("v1.2 is out, no break")).toBe(
			"v1.2 is out, no break"
		);
	});

	test("summarises what needs you in one sentence", () => {
		expect(summarySentence(panelsSummary(SNAPSHOT))).toBe(
			"Two conversations need you, and one agent is working."
		);
		expect(summarySentence(panelsSummary(EMPTY))).toBe(
			"Nothing needs you right now."
		);
	});

	test("lists upcoming runs soonest first and dates them", () => {
		const runs = upcomingRuns(SNAPSHOT, NOW);
		expect(runs.map((event) => event.id)).toEqual([
			"event-soon",
			"event-later",
		]);
		expect(runWhen(new Date(NOW + 40 * MINUTE).toISOString(), NOW)).toBe(
			"in 40m"
		);
	});

	test("orders working agents first, then agents waiting on you", () => {
		const rows = buildAgentRows(SNAPSHOT);
		expect(rows.map((row) => row.agent.id)).toEqual([
			"agent-grace",
			"agent-ada",
			"agent-linus",
		]);
		expect(rows[0]?.status).toBe("working");
		expect(rows[0]?.line).toBe("Triages bugs");
		const linus = rows.find((row) => row.agent.id === "agent-linus");
		expect(linus?.target).toEqual({ agentId: "agent-linus", kind: "start" });
	});

	test("greets by the local hour, with evening running to 2 AM", () => {
		expect(panelsGreeting(new Date(2026, 9, 14, 8, 0))).toBe("Good morning");
		expect(panelsGreeting(new Date(2026, 9, 14, 13, 0))).toBe("Good afternoon");
		expect(panelsGreeting(new Date(2026, 9, 14, 21, 0))).toBe("Good evening");
		expect(panelsGreeting(new Date(2026, 9, 14, 0, 10))).toBe("Good evening");
		expect(panelsGreeting(new Date(2026, 9, 14, 3, 0))).toBe("Good night");
		expect(panelsGreeting(new Date(2026, 9, 14, 5, 0))).toBe("Good morning");
	});

	test("names each panel link by the thread it opens, never twice", () => {
		const actions = panelHeaderActions(SNAPSHOT, NOW);
		expect(actions.working?.text).toBe("Watch");
		const targets = [actions.agents, actions.activity, actions.upcoming]
			.filter((action) => action !== null)
			.map((action) => JSON.stringify(action?.target));
		expect(new Set(targets).size).toBe(targets.length);
		for (const action of [actions.agents, actions.activity, actions.upcoming]) {
			if (action) {
				expect(action.text).toMatch(/^(Reply in|Retry) /);
			}
		}
		expect(actions.agents).not.toBeNull();
	});

	test("files threads under projects, then teams, then the rest", () => {
		const topics = buildTopics(SNAPSHOT);
		expect(topics.map((topic) => topic.id)).toEqual([
			"project-site",
			"team-core",
			"other",
		]);
		expect(topics[1]?.threads.map((item) => item.id)).toEqual([
			"thread-triage",
			"thread-failed",
		]);
		expect(buildTopics(EMPTY)).toEqual([]);
	});
});

describe("panels renderer", () => {
	test("renders Home with suggestions and the four panels", () => {
		const html = renderToStaticMarkup(panels());
		expect(html).toContain('data-testid="interface-panels"');
		expect(html).toContain('data-testid="panels-sky"');
		expect(html).toContain('data-testid="panels-actions"');
		for (const id of [
			"panels-working",
			"panels-upcoming",
			"panels-agents",
			"panels-activity",
		]) {
			expect(html).toContain(`data-testid="${id}"`);
		}
		expect(html).toContain("Inbox sweep");
	});

	test("shows skeletons while loading and a calm empty state", () => {
		const loading = renderToStaticMarkup(panels({ loading: true }));
		expect(loading).toContain('data-testid="panels-skeleton"');
		expect(loading).toContain('aria-busy="true"');
		const empty = renderToStaticMarkup(panels({ snapshot: EMPTY }));
		expect(empty).toContain('data-testid="panels-actions-empty"');
		expect(empty).toContain("No agent is working right now.");
	});

	test(
		"tapping a verb opens its thread; an ask starts one without a prompt",
		async () => {
			const { calls, port } = recordingPort();
			const view = await mount(panels({ port }));
			await click(button(view.container, "Retry Grace's failed run"));
			expect(calls).toEqual(["open:thread-failed"]);
			await view.rerender(
				panels({
					port,
					snapshot: {
						...SNAPSHOT,
						threads: SNAPSHOT.threads.filter(
							(item) => !item.agentIds.includes("agent-ada")
						),
					},
				})
			);
			await click(button(view.container, "Ask Ada"));
			expect(calls.at(-1)).toBe('start:{"agentId":"agent-ada"}');
			await view.dispose();
		},
		MOUNT_TIMEOUT_MS
	);

	test(
		"a panel's header link opens the thread it names",
		async () => {
			const { calls, port } = recordingPort();
			const view = await mount(panels({ port }));
			const working = view.container.querySelector(
				"[data-testid='panels-working']"
			);
			await click(working?.querySelector("button[aria-label^='Watch']"));
			expect(calls).toEqual(["open:thread-triage"]);
			const agents = view.container.querySelector(
				"[data-testid='panels-agents']"
			);
			const reply = agents?.querySelector(
				"[data-testid='panels-panel-action']"
			);
			expect(reply?.textContent?.startsWith("Reply in")).toBe(true);
			await click(reply);
			expect(calls.at(-1)?.startsWith("open:")).toBe(true);
			await view.dispose();
		},
		MOUNT_TIMEOUT_MS
	);

	test(
		"shows the host's thread view in Chat and closes it with Escape",
		async () => {
			const { calls, port } = recordingPort();
			const view = await mount(
				panels({
					activeThreadId: "thread-notes",
					port,
					threadView: <div data-testid="host-thread">host</div>,
				})
			);
			const root = view.container.querySelector(
				"[data-testid='interface-panels']"
			);
			expect(root?.getAttribute("data-view")).toBe("chat");
			expect(
				view.container.querySelector(
					"[data-testid='panels-thread-frame'] [data-testid='host-thread']"
				)
			).not.toBeNull();
			await press("Escape");
			expect(calls).toEqual(["close"]);
			await view.dispose();
		},
		MOUNT_TIMEOUT_MS
	);

	test(
		"Chat reopens the most recent conversation; Projects starts in a topic",
		async () => {
			const { calls, port } = recordingPort();
			const view = await mount(panels({ port }));
			await click(viewButton(view.container, "chat"));
			expect(calls).toEqual(["open:thread-triage"]);
			await click(viewButton(view.container, "projects"));
			const root = view.container.querySelector(
				"[data-testid='interface-panels']"
			);
			expect(root?.getAttribute("data-view")).toBe("projects");
			expect(
				view.container.querySelectorAll("[data-testid='panels-topic']")
			).toHaveLength(3);
			await click(button(view.container, "New conversation in Website"));
			expect(calls.at(-1)).toBe(
				'start:{"agentId":"agent-ada","projectId":"project-site"}'
			);
			await view.dispose();
		},
		MOUNT_TIMEOUT_MS
	);

	test(
		"New chat sends only a prompt the user typed",
		async () => {
			const { calls, port } = recordingPort();
			const view = await mount(panels({ port }));
			await click(button(view.container, "New chat"));
			expect(
				view.container.querySelector("[data-testid='panels-chat-empty']")
			).not.toBeNull();
			expect(calls).toEqual([]);
			await view.dispose();
		},
		MOUNT_TIMEOUT_MS
	);

	test(
		"the Chat switcher lists recent conversations and opens one",
		async () => {
			const opened: string[] = [];
			const view = await mount(
				<PanelsChatOpen
					now={NOW}
					onClose={() => undefined}
					onNewChat={() => undefined}
					onOpenThread={(threadId) => opened.push(threadId)}
					snapshot={SNAPSHOT}
					thread={SNAPSHOT.threads[0]}
					threadView={<div data-testid="host-thread">host</div>}
				/>
			);
			const trigger = button(view.container, "Conversation: Release notes");
			await click(trigger);
			const items = [
				...document.body.querySelectorAll("[role='menuitem']"),
			].filter((item) => item.textContent?.includes("Crash triage"));
			expect(items).toHaveLength(1);
			expect(document.body.textContent).toContain("Dependency audit.");
			await click(items[0]);
			expect(opened).toEqual(["thread-triage"]);
			await view.dispose();
		},
		MOUNT_TIMEOUT_MS
	);

	test(
		"closing a conversation returns to the page it was opened from",
		async () => {
			const { calls, port } = recordingPort();
			const view = await mount(panels({ port }));
			await click(viewButton(view.container, "projects"));
			await click(viewButton(view.container, "chat"));
			expect(calls).toEqual(["open:thread-triage"]);
			await view.rerender(
				panels({
					activeThreadId: "thread-triage",
					port,
					threadView: <div data-testid="host-thread">host</div>,
				})
			);
			await press("Escape");
			expect(calls.at(-1)).toBe("close");
			await view.rerender(panels({ port }));
			const root = view.container.querySelector(
				"[data-testid='interface-panels']"
			);
			expect(root?.getAttribute("data-view")).toBe("projects");
			await view.dispose();
		},
		MOUNT_TIMEOUT_MS
	);
});
