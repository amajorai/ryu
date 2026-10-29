import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { fitView, keepInView, zoomAt } from "./flow-hooks.ts";
import { FlowInterface } from "./flow-interface.tsx";
import {
	activityPerHour,
	buildFlowLayout,
	connectSections,
	edgePath,
	FLOW_GEOMETRY,
	type FlowLayoutOptions,
	flowLogs,
	flowMetrics,
	flowNeighbor,
	flowPath,
	flowStartActions,
	leadTone,
	logClock,
	logDay,
	needsYouCount,
	threadGroupKey,
} from "./flow-model.ts";
import { monotonePath } from "./flow-panel.tsx";

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
			description: "",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	events: [
		{
			agentId: "agent-grace",
			end: ago(119),
			id: "event-sweep",
			kind: "past",
			label: "Every hour",
			outcome: "failure",
			start: ago(120),
			title: "Inbox sweep",
		},
		{
			agentId: "agent-grace",
			id: "event-next",
			kind: "upcoming",
			label: "Every hour",
			start: new Date(BASE + 60 * MINUTE).toISOString(),
			title: "Inbox sweep",
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
			memberAgentIds: [],
			name: "Website",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			messageCount: 4,
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-question",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			messageCount: 7,
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(120),
		}),
		thread({
			agentIds: ["agent-ada", "agent-linus"],
			id: "thread-docs",
			teamId: "team-docs",
			title: "Docs plan",
			updatedAt: ago(200),
		}),
		thread({
			id: "thread-loose",
			lastMessageRole: "user",
			title: "Loose ends",
			updatedAt: ago(60 * 30),
		}),
	],
	version: 1,
};

const EMPTY: InterfaceSnapshot = { ...SNAPSHOT, threads: [] };

const NO_OPTIONS: FlowLayoutOptions = {
	composer: null,
	engaged: [],
	expanded: [],
	stubFor: null,
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

async function press(target: Element | null | undefined, key: string) {
	if (!(target instanceof HTMLElement)) {
		throw new Error("Expected a key target");
	}
	await act(async () => {
		target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
	});
}

async function type(input: Element | null | undefined, value: string) {
	if (!(input instanceof HTMLInputElement)) {
		throw new Error("Expected an input");
	}
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		input.focus();
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

function byLabel(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label
	);
}

function byText(container: HTMLElement, text: string) {
	return [...container.querySelectorAll("button")].find((candidate) =>
		candidate.textContent?.includes(text)
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

describe("flow model", () => {
	test("groups threads under their team, else their first agent", () => {
		const [notes, , , , docs, loose] = SNAPSHOT.threads;
		expect(notes && threadGroupKey(SNAPSHOT, notes)).toBe("agent:agent-ada");
		expect(docs && threadGroupKey(SNAPSHOT, docs)).toBe("team:team-docs");
		expect(loose && threadGroupKey(SNAPSHOT, loose)).toBe("orphan");
	});

	test("lays out You -> leads -> conversations, most urgent first", () => {
		const layout = buildFlowLayout(SNAPSHOT, NO_OPTIONS);
		const ids = layout.nodes.map((node) => node.id);
		expect(ids).toEqual([
			"origin",
			"agent:agent-ada",
			"thread:thread-notes",
			"thread:thread-question",
			"agent:agent-grace",
			"thread:thread-flaky",
			"thread:thread-triage",
			"team:team-docs",
			"thread:thread-docs",
			"lane:unassigned",
			"thread:thread-loose",
		]);
		// Linus has no conversations and was not engaged, so he is not drawn.
		expect(ids).not.toContain("agent:agent-linus");
		const ada = layout.nodes.find((node) => node.id === "agent:agent-ada");
		const firstNote = layout.nodes.find(
			(node) => node.id === "thread:thread-notes"
		);
		expect(ada?.x).toBe(FLOW_GEOMETRY.leadX);
		expect(firstNote?.x).toBe(FLOW_GEOMETRY.convX);
		// The first conversation sits on its lead's row; the next drops a row.
		expect(firstNote?.y).toBe(ada?.y);
		const question = layout.nodes.find(
			(node) => node.id === "thread:thread-question"
		);
		expect(question && ada && question.y - ada.y).toBe(FLOW_GEOMETRY.row);
		// A conversation with no agent hangs off a quiet "Unassigned" lane.
		const loose = layout.nodes.find(
			(node) => node.id === "thread:thread-loose"
		);
		expect(loose?.column).toBe(2);
		expect(loose?.parentId).toBe("lane:unassigned");
		const lane = layout.nodes.find((node) => node.id === "lane:unassigned");
		expect(lane?.kind === "lane" && lane.label).toBe("Unassigned");
		expect(lane?.y).toBe(loose?.y);
	});

	test("connector chips speak only for what waits on you", () => {
		const layout = buildFlowLayout(SNAPSHOT, NO_OPTIONS);
		const chips = new Map(layout.chips.map((chip) => [chip.id, chip]));
		const adaWaiting = SNAPSHOT.threads.filter(
			(thread) =>
				threadGroupKey(SNAPSHOT, thread) === "agent:agent-ada" &&
				["attention", "your-turn"].includes(threadStatus(thread))
		);
		if (adaWaiting.length > 0) {
			expect(chips.get("chip:agent:agent-ada")?.label).toBe(
				String(adaWaiting.length)
			);
		} else {
			expect(chips.has("chip:agent:agent-ada")).toBe(false);
		}
		for (const chip of layout.chips) {
			expect(Number(chip.label)).toBeGreaterThan(0);
			expect(chip.threadId).toBeTruthy();
		}
		expect(chips.get("chip:origin")?.label).toBe(
			String(needsYouCount(SNAPSHOT))
		);
		const calm = buildFlowLayout(
			{
				...SNAPSHOT,
				threads: SNAPSHOT.threads.filter(
					(thread) => !["attention", "your-turn"].includes(threadStatus(thread))
				),
			},
			NO_OPTIONS
		);
		expect(calm.chips).toEqual([]);
	});

	test("conversations without an agent use the conversation column", () => {
		const layout = buildFlowLayout(SNAPSHOT, NO_OPTIONS);
		const loose = layout.nodes.find(
			(node) => node.id === "thread:thread-loose"
		);
		expect(loose?.x).toBe(FLOW_GEOMETRY.convX);
		expect(loose?.w).toBe(FLOW_GEOMETRY.convW);
	});

	test("the open path runs from You through the owner to the node", () => {
		const layout = buildFlowLayout(SNAPSHOT, NO_OPTIONS);
		expect([...flowPath(layout, "thread:thread-flaky")]).toEqual([
			"thread:thread-flaky",
			"agent:agent-grace",
			"origin",
		]);
		expect(flowPath(layout, null).size).toBe(0);
	});

	test("the origin keeps its + stub when asked to", () => {
		const layout = buildFlowLayout(SNAPSHOT, {
			...NO_OPTIONS,
			originStub: true,
		});
		expect(layout.nodes.at(-1)?.id).toBe("stub:origin");
		expect(
			layout.edges.find((edge) => edge.id === "edge:stub:origin")?.dashed
		).toBe(true);
	});

	test("lead tone puts live work first, then failures, then replies", () => {
		const [notes, question, triage, flaky] = SNAPSHOT.threads;
		expect(
			leadTone([flaky, notes].filter(Boolean) as InterfaceThread[], true)
		).toBe("working");
		expect(
			leadTone([flaky, notes].filter(Boolean) as InterfaceThread[], false)
		).toBe("attention");
		expect(leadTone([notes].filter(Boolean) as InterfaceThread[], false)).toBe(
			"your-turn"
		);
		expect(
			leadTone([question].filter(Boolean) as InterfaceThread[], false)
		).toBe("idle");
		expect(triage).toBeDefined();
	});

	test("collapses long leads behind N more, but keeps the open thread", () => {
		const many: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: Array.from({ length: 5 }, (_, index) =>
				thread({
					agentIds: ["agent-ada"],
					id: `thread-${index}`,
					updatedAt: ago(index * 10),
				})
			),
		};
		const collapsed = buildFlowLayout(many, NO_OPTIONS);
		const more = collapsed.nodes.find((node) => node.kind === "more");
		expect(more?.kind === "more" && more.count).toBe(3);
		expect(
			collapsed.nodes
				.filter((node) => node.kind === "thread")
				.map((node) => node.id)
		).toEqual(["thread:thread-0", "thread:thread-1"]);

		const pinned = buildFlowLayout(many, {
			...NO_OPTIONS,
			activeThreadId: "thread-4",
		});
		expect(pinned.nodes.some((node) => node.id === "thread:thread-4")).toBe(
			true
		);

		const open = buildFlowLayout(many, {
			...NO_OPTIONS,
			expanded: ["agent:agent-ada"],
		});
		expect(open.nodes.some((node) => node.kind === "more")).toBe(false);
		expect(open.nodes.filter((node) => node.kind === "thread")).toHaveLength(5);
	});

	test("stubs and the pending composer take the next slot under a lead", () => {
		const withStub = buildFlowLayout(SNAPSHOT, {
			...NO_OPTIONS,
			stubFor: "agent:agent-ada",
		});
		const stub = withStub.nodes.find(
			(node) => node.id === "stub:agent:agent-ada"
		);
		const ada = withStub.nodes.find((node) => node.id === "agent:agent-ada");
		expect(stub && ada && stub.y - ada.y).toBe(FLOW_GEOMETRY.row * 2);
		expect(
			withStub.edges.find((edge) => edge.id === "edge:stub:agent:agent-ada")
				?.dashed
		).toBe(true);

		const engaged = buildFlowLayout(SNAPSHOT, {
			...NO_OPTIONS,
			composer: {
				agentId: "agent-linus",
				groupKey: "agent:agent-linus",
				label: "Message Linus",
			},
			engaged: ["agent:agent-linus"],
		});
		const composer = engaged.nodes.find((node) => node.kind === "composer");
		const linus = engaged.nodes.find((node) => node.id === "agent:agent-linus");
		expect(composer?.parentId).toBe("agent:agent-linus");
		expect(composer?.y).toBe(linus?.y);

		const root = buildFlowLayout(EMPTY, {
			...NO_OPTIONS,
			composer: { groupKey: "root", label: "New conversation" },
		});
		expect(root.nodes.map((node) => node.id)).toEqual([
			"origin",
			"composer:root",
		]);
	});

	test("edges keep one path shape so they can morph", () => {
		const shape = (d: string) => d.replace(/[-\d.]+/g, "n");
		const straight = edgePath([
			[0, 0],
			[0, 0],
			[100, 0],
			[100, 0],
		]);
		const bent = edgePath([
			[0, 0],
			[40, 0],
			[40, 56],
			[100, 56],
		]);
		expect(shape(straight)).toBe(shape(bent));
		expect(bent).toContain("Q 40 0");
	});

	test("arrow keys travel along connections", () => {
		const layout = buildFlowLayout(SNAPSHOT, NO_OPTIONS);
		expect(flowNeighbor(layout, null, "right")).toBe("origin");
		expect(flowNeighbor(layout, "origin", "right")).toBe("agent:agent-ada");
		expect(flowNeighbor(layout, "agent:agent-ada", "right")).toBe(
			"thread:thread-notes"
		);
		expect(flowNeighbor(layout, "thread:thread-notes", "down")).toBe(
			"thread:thread-question"
		);
		expect(flowNeighbor(layout, "thread:thread-question", "left")).toBe(
			"agent:agent-ada"
		);
		expect(flowNeighbor(layout, "agent:agent-ada", "down")).toBe(
			"agent:agent-grace"
		);
		expect(flowNeighbor(layout, "origin", "left")).toBe(null);
		expect(flowNeighbor(layout, "agent:agent-ada", "up")).toBe(null);
	});

	test("panel numbers: metrics, hourly activity, and logs", () => {
		const grace = { agentId: "agent-grace", kind: "agent" } as const;
		const threads = SNAPSHOT.threads.filter((item) =>
			item.agentIds.includes("agent-grace")
		);
		expect(flowMetrics(threads)).toEqual({
			conversations: 2,
			messages: 9,
			needsYou: 1,
			working: 1,
		});
		// "Needs you" agrees with the inbox chips: failures plus replies.
		expect(flowMetrics(SNAPSHOT.threads).needsYou).toBe(
			needsYouCount(SNAPSHOT)
		);
		const buckets = activityPerHour(SNAPSHOT, grace, BASE);
		expect(buckets).toHaveLength(24);
		expect(buckets[23]).toBe(1);
		// The failed run and the failed thread both landed two hours ago.
		expect(buckets[21]).toBe(2);
		const logs = flowLogs(SNAPSHOT, grace, BASE);
		expect(logs.map((entry) => `${entry.verb} ${entry.title}`)).toEqual([
			"Working Crash triage",
			"Failed Inbox sweep",
			"Failed Flaky test",
		]);
		expect(logs[1]?.threadId).toBe(null);
		const team = flowLogs(
			SNAPSHOT,
			{ kind: "team", teamId: "team-docs" },
			BASE
		);
		expect(team.map((entry) => entry.title)).toEqual(["Docs plan"]);
	});

	test("log times are a fixed clock under day headings", () => {
		const today = new Date(BASE);
		today.setHours(9, 5, 0, 0);
		const now = today.getTime() + MINUTE;
		expect(logClock(today.toISOString())).toBe("09:05");
		expect(logDay(today.toISOString(), now)).toBe("Today");
		const yesterday = new Date(today);
		yesterday.setDate(today.getDate() - 1);
		expect(logDay(yesterday.toISOString(), now)).toBe("Yesterday");
		const earlier = new Date(2026, 9, 3, 12).toISOString();
		expect(logDay(earlier, new Date(2026, 9, 12, 12).getTime())).toBe("Oct 3");
		expect(logClock("not a date")).toBe("");
		expect(logDay("not a date", BASE)).toBe("");
	});

	test("every lead connector carries a chip or a quiet joint, never both", () => {
		const layout = buildFlowLayout(SNAPSHOT, NO_OPTIONS);
		const chipKeys = new Set(
			layout.chips.map((chip) => chip.id.replace("chip:", ""))
		);
		const jointKeys = new Set(
			layout.joints.map((joint) => joint.id.replace("joint:", ""))
		);
		const leads = layout.nodes.filter(
			(node) =>
				(node.kind === "agent" ||
					node.kind === "team" ||
					node.kind === "lane") &&
				layout.nodes.some((child) => child.parentId === node.id)
		);
		for (const lead of leads) {
			expect(chipKeys.has(lead.id) !== jointKeys.has(lead.id)).toBe(true);
		}
		for (const joint of layout.joints) {
			const lead = layout.nodes.find(
				(node) => node.id === joint.id.replace("joint:", "")
			);
			expect(joint.y).toBe(lead?.y ?? Number.NaN);
		}
	});

	test("a lead's dot is presence; its conversations carry status", () => {
		const layout = buildFlowLayout(SNAPSHOT, NO_OPTIONS);
		for (const node of layout.nodes) {
			if (node.kind === "agent") {
				expect(node.tone).toBe(
					node.agent.status === "working" ? "working" : "idle"
				);
			}
		}
	});

	test("unassigned conversations have their own scope", () => {
		const threads = flowLogs(SNAPSHOT, { kind: "unassigned" }, BASE)
			.filter((entry) => entry.threadId)
			.map((entry) => entry.threadId);
		expect(threads).toEqual(["thread-loose"]);
		expect(connectSections(SNAPSHOT, "lane:unassigned")).toEqual([]);
	});

	test("keepInView pans, and zooms only when the branch cannot fit", () => {
		const area = { bottom: 800, left: 32, right: 508, top: 32 };
		const box = { maxX: 696, maxY: 160, minX: 132, minY: 100 };
		const view = keepInView({ k: 1, x: 200, y: 0 }, box, area);
		expect(view.k).toBeLessThan(1);
		expect(view.x + box.minX * view.k).toBeGreaterThanOrEqual(area.left - 0.01);
		expect(view.x + box.maxX * view.k).toBeLessThanOrEqual(area.right + 0.01);
		const visible = { k: 1, x: -100, y: 0 };
		expect(keepInView(visible, { ...box, maxX: 500 }, area)).toBe(visible);
	});

	test("start actions lead with review, then agents and a project", () => {
		const { all, short } = flowStartActions(SNAPSHOT);
		expect(short.map((action) => action.title)).toEqual([
			"Review what needs you",
			"Message Ada",
			"Message Grace",
			"Start in Website",
		]);
		expect(all.map((action) => action.id)).toEqual([
			"review",
			"agent:agent-ada",
			"agent:agent-grace",
			"agent:agent-linus",
			"team:team-docs",
			"project:project-site",
		]);
		expect(
			all.find((action) => action.id === "agent:agent-linus")?.description
		).toBe("Start a conversation");
		const lonely = flowStartActions({ ...EMPTY, agents: [], groups: [] });
		expect(lonely.short.map((action) => action.id)).toEqual(["blank"]);
	});

	test("connect menus offer a new conversation and projects", () => {
		const ada = connectSections(SNAPSHOT, "agent:agent-ada");
		expect(
			ada.map((section) => section.items.map((item) => item.title))
		).toEqual([["New conversation"], ["Add to Website"]]);
		expect(ada[1]?.items[0]?.target).toEqual({
			agentId: "agent-ada",
			groupKey: "agent:agent-ada",
			label: "Ada in Website",
			projectId: "project-site",
		});
		const you = connectSections(SNAPSHOT, "origin");
		expect(you.map((section) => section.label)).toEqual([
			"Agents",
			"Teams",
			"Projects",
		]);
		expect(connectSections(SNAPSHOT, "agent:missing")).toEqual([]);
	});

	test("fitting centers small flows and pins large ones to the corner", () => {
		const small = fitView(
			{ maxX: 200, maxY: 100, minX: 0, minY: 0 },
			{ height: 600, width: 1000 }
		);
		expect(small).toEqual({ k: 1, x: 400, y: 250 });
		const large = fitView(
			{ maxX: 2000, maxY: 400, minX: -20, minY: 0 },
			{ height: 600, width: 800 },
			0.7
		);
		expect(large.k).toBe(0.7);
		expect(large.x).toBeCloseTo(64 + 20 * 0.7);
		const zoomed = zoomAt({ k: 1, x: 0, y: 0 }, 2, 100, 100);
		expect(zoomed).toEqual({ k: 2, x: -100, y: -100 });
	});

	test("the activity line is a smooth curve that stays inside the plot", () => {
		expect(monotonePath([])).toBe("");
		expect(monotonePath([[0, 10]])).toBe("M 0.0 10.0");
		const path = monotonePath([
			[0, 72],
			[10, 72],
			[20, 8],
			[30, 72],
		]);
		expect(path.startsWith("M 0.0 72.0 C")).toBe(true);
		expect(path).not.toContain(" V ");
		// Monotone: no control point dips below the baseline or above the peak.
		const ys = [...path.matchAll(/(-?\d+\.\d) (-?\d+\.\d)/g)].map((match) =>
			Number(match[2])
		);
		expect(Math.max(...ys)).toBeLessThanOrEqual(72);
		expect(Math.min(...ys)).toBeGreaterThanOrEqual(8);
	});
});

describe("FlowInterface", () => {
	test("shows a skeleton while loading and the start card when empty", () => {
		const { port } = recordingPort();
		const loading = renderToStaticMarkup(
			<FlowInterface
				activeThreadId={null}
				loading
				params={{}}
				port={port}
				snapshot={EMPTY}
				threadView={null}
			/>
		);
		expect(loading).toContain('data-testid="interface-flow"');
		expect(loading).toContain('aria-busy="true"');
		const empty = renderToStaticMarkup(
			<FlowInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={EMPTY}
				threadView={null}
			/>
		);
		expect(empty).toContain('aria-label="Start"');
		expect(empty).toContain("Message Ada");
		expect(empty).toContain("View all");
		expect(empty).not.toContain('data-flow-node="origin"');
	});

	test("draws the flow and shows the host thread view in the side panel", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<FlowInterface
				activeThreadId="thread-flaky"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div data-testid="host-thread-view">Host</div>}
			/>
		);
		expect(markup).toContain('data-flow-node="origin"');
		expect(markup).toContain('aria-label="Flaky test, Needs attention"');
		expect(markup).toContain('data-testid="host-thread-view"');
		expect(markup).toContain('role="application"');
	});

	test("choosing a start action grows the canvas into a composer", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<FlowInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={EMPTY}
				threadView={null}
			/>
		);
		await click(byText(view.container, "View all"));
		expect(byText(view.container, "Message Docs Crew")).toBeDefined();
		await click(byText(view.container, "Message Grace"));
		expect(
			view.container.querySelector('[data-flow-node="agent:agent-grace"]')
		).not.toBe(null);
		const input = view.container.querySelector(
			'input[aria-label="Message Grace"]'
		);
		await type(input, "Summarize the crash reports");
		const form = view.container.querySelector("form");
		await act(async () => {
			form?.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
		});
		expect(calls).toEqual([
			'start:{"agentId":"agent-grace","prompt":"Summarize the crash reports"}',
		]);
		await view.dispose();
	});

	test("an empty prompt is never sent and Escape drops the pending node", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<FlowInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={EMPTY}
				threadView={null}
			/>
		);
		await click(byText(view.container, "Message Ada"));
		const form = view.container.querySelector("form");
		await act(async () => {
			form?.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
		});
		expect(calls).toEqual([]);
		await press(view.container.querySelector("form input"), "Escape");
		// The pending node animates out and focus returns to the agent it hung off.
		expect(document.activeElement?.getAttribute("data-flow-node")).toBe(
			"agent:agent-ada"
		);
		expect(
			view.container.querySelector('[data-flow-node="agent:agent-ada"]')
		).not.toBe(null);
		await view.dispose();
	});

	test("selecting a lead opens its overview and its + stub connects", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<FlowInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await click(byLabel(view.container, "Grace, 2 conversations, Working"));
		const panel = view.container.querySelector('[aria-label="Grace overview"]');
		expect(panel?.textContent).toContain("Metrics");
		expect(panel?.textContent).toContain("Activity per hour");
		expect(panel?.textContent).toContain("Crash triage");
		// Selecting a lead pins its "+" as an overlay; no row is inserted.
		expect(
			view.container.querySelector('[data-flow-node="stub:agent:agent-grace"]')
		).toBe(null);
		expect(panel?.textContent).not.toContain("By status");
		expect(panel?.textContent).toContain("Needs you");
		// The panel's "+" names its target, unlike the canvas-wide start button.
		expect(byLabel(view.container, "New conversation with Grace")).toBeTruthy();

		await click(byLabel(view.container, "Connect to Grace"));
		const menu = view.container.querySelector('[role="menu"]');
		expect(menu?.getAttribute("aria-labelledby")).toBeTruthy();
		expect(view.container.textContent).toContain("Connect to Grace");
		const items = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])];
		expect(items.map((item) => item.textContent)).toEqual([
			"New conversationMessage Grace directly",
			"Add to WebsiteFile it under Website",
		]);
		await click(items[1]);
		const input = view.container.querySelector(
			'input[aria-label="Grace in Website"]'
		);
		await type(input, "Audit the forms");
		await act(async () => {
			view.container
				.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true })
				);
		});
		expect(calls).toEqual([
			'start:{"agentId":"agent-grace","projectId":"project-site","prompt":"Audit the forms"}',
		]);

		// A log row opens its conversation.
		await click(byLabel(view.container, "Grace, 2 conversations, Working"));
		await click(byText(view.container, "Flaky test"));
		expect(calls.at(-1)).toBe("open:thread-flaky");
		await view.dispose();
	});

	test("conversation nodes open threads; Escape closes the panel", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<FlowInterface
				activeThreadId="thread-notes"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div data-testid="host-thread-view">Host</div>}
			/>
		);
		await click(byLabel(view.container, "Crash triage, Working"));
		expect(calls).toEqual(["open:thread-triage"]);
		await press(view.container.querySelector('[role="application"]'), "Escape");
		expect(calls).toEqual(["open:thread-triage", "close"]);
		await click(byLabel(view.container, "Close panel"));
		expect(calls.at(-1)).toBe("close");
		await view.dispose();
	});

	test("arrow keys move focus between connected nodes", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<FlowInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const canvas = view.container.querySelector('[role="application"]');
		const focused = () =>
			document.activeElement?.getAttribute("data-flow-node") ?? null;
		await press(canvas, "ArrowRight");
		expect(focused()).toBe("agent:agent-ada");
		await press(document.activeElement, "ArrowRight");
		expect(focused()).toBe("thread:thread-notes");
		await press(document.activeElement, "ArrowDown");
		expect(focused()).toBe("thread:thread-question");
		await press(document.activeElement, "ArrowLeft");
		expect(focused()).toBe("agent:agent-ada");
		// Roving tab stop follows focus.
		expect(
			[
				...view.container.querySelectorAll('[data-flow-node][tabindex="0"]'),
			].map((node) => node.getAttribute("data-flow-node"))
		).toEqual(["agent:agent-ada"]);
		await view.dispose();
	});

	test("a lead's hover stub opens its menu without adding a row", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<FlowInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const rows = () =>
			view.container.querySelectorAll("[data-flow-node]").length;
		const before = rows();
		// The origin keeps its own stub on the canvas at all times.
		expect(
			view.container.querySelector('[data-flow-node="stub:origin"]')
		).not.toBe(null);
		await click(byLabel(view.container, "Connect to Ada"));
		expect(view.container.textContent).toContain("Connect to Ada");
		expect(view.container.querySelector('[role="menu"]')).not.toBe(null);
		expect(rows()).toBe(before);
		await view.dispose();
	});

	test("Tab reaches the selected lead's stub and opens its menu", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<FlowInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const stub = () => byLabel(view.container, "Connect to Ada");
		expect(stub()?.tabIndex).toBe(-1);
		await click(
			view.container.querySelector('[data-flow-node="agent:agent-ada"]')
		);
		// Selected, Ada's stub joins the tab order; other leads' stay out.
		expect(stub()?.tabIndex).toBe(0);
		expect(
			[
				...view.container.querySelectorAll<HTMLElement>(
					"[data-flow-hover-stub]"
				),
			]
				.filter((button) => button.tabIndex === 0)
				.map((button) => button.getAttribute("aria-label"))
		).toEqual(["Connect to Ada"]);
		await click(stub());
		expect(view.container.querySelector('[role="menu"]')).not.toBe(null);
		await view.dispose();
	});

	test("the waiting chip and review action open the most urgent thread", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<FlowInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await click(
			byLabel(
				view.container,
				`Review next: ${needsYouCount(SNAPSHOT)} waiting on you`
			)
		);
		expect(calls).toEqual(["open:thread-flaky"]);
		await click(byLabel(view.container, "New conversation"));
		await click(byText(view.container, "Review what needs you"));
		expect(calls).toEqual(["open:thread-flaky", "open:thread-flaky"]);
		await view.dispose();
	});
});
