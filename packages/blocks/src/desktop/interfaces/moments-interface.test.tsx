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
import { MomentsInterface } from "./moments-interface.tsx";
import {
	buildMomentsFlows,
	groupMomentsDays,
	momentsDayLabel,
	momentsFlowForThread,
	momentsFlowSummary,
	momentsGridStep,
	momentsMentionHandle,
	momentsMentionMatches,
	momentsMentionQuery,
	momentsNameList,
	momentsUpdatedLabel,
	parseMomentsIntent,
} from "./moments-model.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/**
 * Local noon today, so fixtures a few minutes or hours old never straddle
 * midnight, whatever time the suite runs.
 */
const NOW = new Date().setHours(12, 0, 0, 0);
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
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-grace"],
			name: "Website",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			projectId: "project-site",
			running: true,
			title: "Crash triage",
			updatedAt: ago(1),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			title: "Release notes",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			lastMessage: "The run stopped.",
			projectId: "project-site",
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(20),
		}),
		thread({
			agentIds: ["agent-ada", "agent-linus"],
			id: "thread-plan",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			teamId: "team-docs",
			title: "Docs plan",
			updatedAt: ago(30),
		}),
		thread({
			id: "thread-loose",
			lastMessage: "Who owns this?",
			lastMessageRole: "user",
			title: "Loose ends",
			updatedAt: new Date(NOW - 9 * DAY).toISOString(),
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
		async rerender(next: ReactElement) {
			await act(async () => root.render(next));
		},
	};
}

function buttonNamed(container: HTMLElement, text: string) {
	// Skip a card on its way out of a module switch: it is inert.
	const match = [...container.querySelectorAll("button")].find(
		(candidate) =>
			candidate.closest("[inert]") === null &&
			(candidate.getAttribute("aria-label") === text ||
				candidate.textContent?.trim().startsWith(text))
	);
	if (!match) {
		throw new Error(`No button named ${text}`);
	}
	return match;
}

async function click(element: HTMLElement) {
	await act(async () => element.click());
}

async function press(target: Element, key: string) {
	await act(async () => {
		target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
	});
}

async function type(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		input.focus();
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		// react-dom loads before the DOM is registered, so it watches keyup too.
		input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
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

function props(port: InterfacePort) {
	return {
		activeThreadId: null,
		loading: false,
		params: {},
		port,
		snapshot: SNAPSHOT,
		threadView: null,
	};
}

describe("moments model", () => {
	test("gathers what needs you, then each project, team, and agent", () => {
		const flows = buildMomentsFlows(SNAPSHOT);
		expect(flows.map((flow) => flow.id)).toEqual([
			"project:project-site",
			"needs-you",
			"agent:agent-ada",
			"team:team-docs",
			"unassigned",
		]);
		const needsYou = flows.find((flow) => flow.kind === "needs-you");
		// Failed runs lead, then replies waiting on the user.
		expect(needsYou?.modules.map((item) => item.thread.id)).toEqual([
			"thread-flaky",
			"thread-notes",
		]);
		expect(needsYou?.name).toBe("Review what needs you");
		const site = flows.find((flow) => flow.kind === "project");
		expect(site?.name).toBe("Website");
		expect(site?.start).toEqual({ projectId: "project-site" });
		expect(flows.find((flow) => flow.kind === "agent")?.name).toBe(
			"Work with Ada"
		);
	});

	test("files flows under the day they last moved", () => {
		const days = groupMomentsDays(buildMomentsFlows(SNAPSHOT), NOW);
		expect(days[0]?.label).toBe("Today");
		// "Review what needs you" leads its day.
		expect(days[0]?.flows[0]?.kind).toBe("needs-you");
		expect(days.at(-1)?.flows.map((flow) => flow.id)).toEqual(["unassigned"]);
		expect(momentsDayLabel(days.at(-1)?.key ?? "", NOW)).not.toBe("Today");
	});

	test("shows each flow once, whole, without repeating a front sheet", () => {
		const flows = buildMomentsFlows(SNAPSHOT);
		const cards = groupMomentsDays(flows, NOW).flatMap((day) => day.flows);
		const ids = cards.map((card) => card.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.length).toBe(flows.length);
		for (const card of cards) {
			const flow = flows.find((item) => item.id === card.id);
			expect(card.modules.length).toBe(flow?.modules.length ?? -1);
			expect(card.preview.length).toBe(card.modules.length);
		}
		const fronts = cards.map((card) => card.preview[0]?.thread.id);
		expect(new Set(fronts).size).toBe(fronts.length);
	});

	test("words days, updates, names, and summaries the MercuryOS way", () => {
		expect(momentsUpdatedLabel(new Date(NOW).toISOString(), NOW)).toBe(
			"Updated just now"
		);
		expect(momentsUpdatedLabel(ago(18), NOW)).toBe("Updated 18 min ago");
		expect(momentsNameList(["Ada", "Grace", "Linus"])).toBe(
			"Ada, Grace, and Linus"
		);
		expect(momentsNameList(["A", "B", "C", "D", "E"])).toBe(
			"A, B, and 3 others"
		);
		const team = buildMomentsFlows(SNAPSHOT).find(
			(flow) => flow.kind === "team"
		);
		expect(team && momentsFlowSummary(team)).toBe("1 item with Ada and Linus");
	});

	test("an opened thread lands in needs-you while it waits, else its home flow", () => {
		const flows = buildMomentsFlows(SNAPSHOT);
		expect(momentsFlowForThread(flows, "thread-triage")?.id).toBe(
			"project:project-site"
		);
		expect(momentsFlowForThread(flows, "thread-flaky")?.id).toBe("needs-you");
		expect(momentsFlowForThread(flows, "thread-notes")?.id).toBe("needs-you");
		expect(momentsFlowForThread(flows, null)).toBeUndefined();
	});

	test("arrow keys step by row and column in a two-column timeline", () => {
		// Two cards per row, then a lone card on the next day's row.
		const rects = [
			{ height: 160, left: 0, top: 0 },
			{ height: 160, left: 500, top: 0 },
			{ height: 160, left: 0, top: 180 },
			{ height: 160, left: 500, top: 180 },
			{ height: 160, left: 0, top: 420 },
		];
		expect(momentsGridStep(rects, 1, "row", 1)).toBe(3);
		expect(momentsGridStep(rects, 3, "row", 1)).toBe(4);
		expect(momentsGridStep(rects, 2, "row", -1)).toBe(0);
		expect(momentsGridStep(rects, 0, "column", 1)).toBe(1);
		expect(momentsGridStep(rects, 4, "row", 1)).toBe(4);
		expect(momentsGridStep([{ height: 0, left: 0, top: 0 }], 0, "row", 1)).toBe(
			null
		);
	});

	test("reads @name out of an intent and suggests agents for it", () => {
		expect(parseMomentsIntent(SNAPSHOT, "@grace fix the flaky test")).toEqual({
			agent: SNAPSHOT.agents[1],
			prompt: "fix the flaky test",
		});
		expect(parseMomentsIntent(SNAPSHOT, "ask @nobody")).toEqual({
			agent: undefined,
			prompt: "ask @nobody",
		});
		expect(momentsMentionQuery("hey @gr", 7)).toEqual({
			query: "gr",
			start: 4,
		});
		expect(momentsMentionQuery("email@x", 7)).toBeNull();
		expect(
			momentsMentionMatches(SNAPSHOT.agents, "a").map((agent) => agent.name)
		).toEqual(["Ada", "Grace"]);
	});
});

describe("moments mention handles", () => {
	test("a picked agent's handle parses back to that agent", () => {
		const agents = [
			{
				avatarUrl: null,
				description: "",
				id: "agent-oneil",
				name: "O'Neil",
				status: "idle" as const,
			},
			{
				avatarUrl: null,
				description: "",
				id: "agent-li",
				name: "李明",
				status: "idle" as const,
			},
			{
				avatarUrl: null,
				description: "",
				id: "agent-mary",
				name: "Mary Jane",
				status: "idle" as const,
			},
		];
		const snapshot = { ...SNAPSHOT, agents };
		expect(agents.map(momentsMentionHandle)).toEqual([
			"ONeil",
			"agent-li",
			"MaryJane",
		]);
		for (const agent of agents) {
			expect(
				parseMomentsIntent(snapshot, `@${momentsMentionHandle(agent)} do X`)
			).toEqual({ agent, prompt: "do X" });
		}
	});
});

describe("MomentsInterface", () => {
	test("renders a loading skeleton and empty states", () => {
		const { port } = recordingPort();
		const loading = renderToStaticMarkup(
			<MomentsInterface {...props(port)} loading />
		);
		expect(loading).toContain('data-testid="interface-moments"');
		expect(loading).toContain('data-testid="moments-loading"');

		const empty = renderToStaticMarkup(
			<MomentsInterface
				{...props(port)}
				snapshot={{ ...SNAPSHOT, threads: [] }}
			/>
		);
		expect(empty).toContain("Nothing in motion yet");
		const noAgents = renderToStaticMarkup(
			<MomentsInterface
				{...props(port)}
				snapshot={{ ...SNAPSHOT, agents: [], threads: [] }}
			/>
		);
		expect(noAgents).toContain("No agents yet");
	});

	test("shows the day timeline with flow cards and the intent bar", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(<MomentsInterface {...props(port)} />);
		expect(markup).toContain("Today");
		expect(markup).toContain("Review what needs you");
		expect(markup).toContain("Work with Ada");
		expect(markup).toContain("Docs Crew");
		expect(markup).toContain("Unassigned threads");
		expect(markup).toContain('placeholder="What would you like to do?"');
	});

	test("zooms into a flow, steps through modules, and opens one", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(<MomentsInterface {...props(port)} />);
		await click(buttonNamed(view.container, "Website"));
		const flow = view.container.querySelector("[data-testid='moments-flow']");
		expect(flow?.querySelector("h1")?.textContent).toBe("Website");
		// The module list marks the focused module; the card follows it.
		const focus = () =>
			view.container.querySelector("[aria-current='true'] .truncate")
				?.textContent;
		expect(focus()).toBe("Crash triage");

		await click(buttonNamed(view.container, "Next"));
		expect(focus()).toBe("Flaky test");
		await press(flow as Element, "ArrowLeft");
		expect(focus()).toBe("Crash triage");
		await press(flow as Element, "ArrowRight");

		// A failed run asks for a reply; opening goes through the port.
		await click(buttonNamed(view.container, "Reply"));
		expect(calls).toEqual(["open:thread-flaky"]);

		await press(flow as Element, "Escape");
		// Zooming out brings the timeline back (the flow layer fades away).
		expect(view.container.querySelector("[data-moments-home]")).not.toBe(null);
		await view.dispose();
	});

	test("focus survives opening a thread, so Esc still zooms out", async () => {
		const { calls, port } = recordingPort();
		const base = props(port);
		const view = await mount(<MomentsInterface {...base} />);
		await click(buttonNamed(view.container, "Website"));
		const open = buttonNamed(view.container, "Open");
		open.focus();
		await click(open);
		expect(calls).toEqual(["open:thread-triage"]);
		// The host answers by opening the thread; the Open button unmounts.
		open.blur();
		await view.rerender(
			<MomentsInterface
				{...base}
				activeThreadId="thread-triage"
				threadView={<div data-testid="host-chat">chat</div>}
			/>
		);
		const expanded = view.container.querySelector(
			"[data-testid='moments-expanded']"
		);
		expect(document.activeElement).toBe(expanded);
		await press(expanded as Element, "Escape");
		expect(calls.at(-1)).toBe("close");
		await view.dispose();
	});

	test("/ and Esc work from the page, and a back swipe zooms out", async () => {
		const { port } = recordingPort();
		const view = await mount(<MomentsInterface {...props(port)} />);
		const input = view.container.querySelector("input[role='combobox']");
		await press(document.body, "/");
		expect(document.activeElement).toBe(input);
		(input as HTMLInputElement).blur();

		await click(buttonNamed(view.container, "Website"));
		const root = view.container.querySelector(
			"[data-testid='interface-moments']"
		) as Element;
		await act(async () => {
			for (const step of [1, 2, 3, 4]) {
				root.dispatchEvent(
					new WheelEvent("wheel", {
						bubbles: true,
						cancelable: true,
						deltaX: -40 * step,
					})
				);
			}
		});
		// Zooming out puts focus back on the flow card it came from.
		const focused = () => document.activeElement?.textContent ?? "";
		expect(focused().startsWith("Website")).toBe(true);

		await click(buttonNamed(view.container, "Work with Ada"));
		(document.activeElement as HTMLElement | null)?.blur();
		await press(document.body, "Escape");
		expect(focused().startsWith("Work with Ada")).toBe(true);
		await view.dispose();
	});

	test("leaves page keys to the host's cover", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(<MomentsInterface {...props(port)} />);
		await click(buttonNamed(view.container, "Website"));
		(document.activeElement as HTMLElement | null)?.blur();
		// While the host covers Moments it is inert: <body> keys pass it by.
		view.container.setAttribute("inert", "");
		await press(document.body, "Escape");
		await press(document.body, "ArrowDown");
		await press(document.body, "/");
		expect(document.activeElement).toBe(document.body);
		expect(calls).toEqual([]);
		view.container.removeAttribute("inert");
		await press(document.body, "Escape");
		expect(document.activeElement?.textContent?.startsWith("Website")).toBe(
			true
		);
		await view.dispose();
	});

	test("arrow keys move between flows on the timeline", async () => {
		const { port } = recordingPort();
		const view = await mount(<MomentsInterface {...props(port)} />);
		const cards = () => [
			...view.container.querySelectorAll<HTMLElement>("[data-moments-flow]"),
		];
		expect(cards()[0]?.tabIndex).toBe(0);
		await press(cards()[0] as Element, "ArrowDown");
		expect(cards()[1]?.tabIndex).toBe(0);
		expect(cards()[0]?.tabIndex).toBe(-1);

		// With nothing focused, the first arrow lands on the selected flow.
		(document.activeElement as HTMLElement | null)?.blur();
		await press(document.body, "ArrowDown");
		expect(document.activeElement).toBe(cards()[1] ?? null);
		await press(document.body, "End");
		expect(document.activeElement).toBe(cards().at(-1) ?? null);

		// ArrowDown in the empty intent bar drops into the timeline too.
		const input = view.container.querySelector<HTMLInputElement>(
			"input[role='combobox']"
		);
		input?.focus();
		await press(input as Element, "ArrowDown");
		expect(document.activeElement).toBe(cards().at(-1) ?? null);
		await view.dispose();
	});

	test("an open thread shows the host's view inside the focused card", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<MomentsInterface
				{...props(port)}
				activeThreadId="thread-triage"
				threadView={<div data-testid="host-chat">chat</div>}
			/>
		);
		const expanded = view.container.querySelector(
			"[data-testid='moments-expanded']"
		);
		expect(expanded?.querySelector("[data-testid='host-chat']")).not.toBe(null);
		expect(view.container.querySelector("h1")?.textContent).toBe("Website");

		// Picking another module swaps the conversation through the port.
		await click(buttonNamed(view.container, "Flaky test"));
		expect(calls).toEqual(["open:thread-flaky"]);

		await click(buttonNamed(view.container, "Close conversation"));
		expect(calls.at(-1)).toBe("close");
		await view.dispose();
	});

	test("the intent bar starts a thread with the typed prompt and @agent", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(<MomentsInterface {...props(port)} />);
		const input = view.container.querySelector<HTMLInputElement>(
			"input[role='combobox']"
		);
		if (!input) {
			throw new Error("Expected the intent bar");
		}
		await type(input, "@gr");
		expect(
			view.container.querySelector("[role='listbox']")?.textContent
		).toContain("Grace");
		await press(input, "Enter");
		expect(input.value).toBe("@Grace ");
		expect(calls).toEqual([]);

		await type(input, "@Grace look at the flaky test");
		await press(input, "Enter");
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-grace", prompt: "look at the flaky test" })}`,
		]);
		expect(input.value).toBe("");

		// An empty line never starts a thread.
		await press(input, "Enter");
		expect(calls).toHaveLength(1);
		await view.dispose();
	});
});
