import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ditherAvatarHue } from "@ryu/ui/components/dither-kit/avatar.tsx";
import {
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
	resolveInterfaceParams,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { fitFlat } from "./knowledge-flat.tsx";
import { KnowledgeInterface } from "./knowledge-interface.tsx";
import {
	adjacency,
	buildKnowledgeGraph,
	createLayout,
	cycleNode,
	DEFAULT_SETTINGS,
	extractTopics,
	filterGraph,
	isSettled,
	type KnowledgeFilters,
	layoutBounds,
	linkedEntities,
	linkedThreads,
	neighbourhood,
	orderNodes,
	replayLayout,
	searchNodes,
	settleLayout,
	topicWords,
	warmTicks,
} from "./knowledge-model.ts";
import {
	agentColor,
	EMPTY_KNOWLEDGE_THEME,
	isDarkTheme,
	knowledgePalette,
} from "./knowledge-palette.ts";
import { KnowledgeLegend, KnowledgeLegendButton } from "./knowledge-parts.tsx";
import {
	buildStyles,
	createProjection,
	freeArea,
	MAX_FIT_DISC_PX,
	openingPose,
	pickNode,
	projectPose,
	segmentCrossesRect,
	syncLabels,
} from "./knowledge-stage.ts";

const KNOWLEDGE_PARAMS = resolveInterfaceParams("knowledge", {});
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
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-grace"],
			name: "Website",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			teamId: "team-docs",
			title: "Release notes for 2.4",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-checklist",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			title: "Release checklist",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			projectId: "project-site",
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			lastMessage: "The crashes stopped after the patch.",
			runState: "failed",
			title: "Crash in the flaky test",
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

const ALL: KnowledgeFilters = {
	agents: true,
	conversations: true,
	groups: true,
	local: null,
	orphans: true,
	topics: true,
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

function byName(container: HTMLElement, name: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) =>
			candidate.getAttribute("aria-label") === name ||
			candidate.textContent?.trim() === name
	);
}

function nodeButton(container: HTMLElement, startsWith: string) {
	return [
		...container.querySelectorAll('nav[aria-label="Graph nodes"] button'),
	].find((candidate) => candidate.textContent?.startsWith(startsWith));
}

function listedNodes(container: HTMLElement): string[] {
	return [
		...container.querySelectorAll('nav[aria-label="Graph nodes"] button'),
	].map((candidate) => candidate.textContent?.split(",")[0] ?? "");
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

describe("knowledge topics", () => {
	test("topics come from titles alone unless messages are asked for", () => {
		expect(DEFAULT_SETTINGS.messages).toBe(false);
	});

	test("words are lower-cased, 4+ letters, without stopwords", () => {
		expect(topicWords("Draft the 2.4 Release notes with Ada")).toEqual([
			"draft",
			"release",
			"notes",
		]);
	});

	test("title words match literally (no stemming or plural folding)", () => {
		const threads = [
			thread({ id: "a", title: "Crash triage" }),
			thread({ id: "b", title: "Crashes in CI" }),
		];
		expect(extractTopics(threads)).toEqual([]);
	});

	test("a title word mentioned by two conversations becomes a linking topic", () => {
		const topics = extractTopics(SNAPSHOT.threads);
		expect(topics.map((topic) => topic.word)).toEqual(["crash", "release"]);
		expect(topics[0]?.threadIds).toEqual(["thread-triage", "thread-flaky"]);
		expect(topics[1]?.threadIds).toEqual(["thread-notes", "thread-checklist"]);
		expect(extractTopics([SNAPSHOT.threads[0] as InterfaceThread])).toEqual([]);
	});

	test("titles alone by default; latest messages link only when asked", () => {
		const threads = [
			thread({ id: "a", title: "Release notes" }),
			thread({
				id: "b",
				lastMessage: "The release went out yesterday.",
				title: "Wrap-up",
			}),
		];
		expect(extractTopics(threads)).toEqual([]);
		const topics = extractTopics(threads, { messages: true });
		expect(topics).toEqual([
			{ messageIds: ["b"], threadIds: ["a", "b"], word: "release" },
		]);
	});
});

describe("knowledge graph", () => {
	const graph = buildKnowledgeGraph(SNAPSHOT);

	test("builds typed nodes and every kind of link", () => {
		const kinds = graph.nodes.map((node) => `${node.kind}:${node.label}`);
		expect(kinds).toContain("agent:Ada");
		expect(kinds).toContain("team:Docs Crew");
		expect(kinds).toContain("project:Website");
		expect(kinds).toContain("conversation:Crash triage");
		expect(kinds).toContain("topic:release");
		const links = graph.links.map((link) => `${link.kind} ${link.id}`);
		expect(links).toContain("member agent:agent-ada>team:team-docs");
		expect(links).toContain(
			"participant thread:thread-triage>agent:agent-grace"
		);
		expect(links).toContain("filed thread:thread-triage>project:project-site");
		expect(links).toContain("filed thread:thread-notes>team:team-docs");
		expect(links).toContain("topic thread:thread-flaky>topic:crash");
		// Project membership is not a link: projects connect via conversations.
		expect(
			links.some(
				(link) => link.includes(">project:") && link.startsWith("member")
			)
		).toBe(false);
		const triage = graph.nodes.find((node) => node.refId === "thread-triage");
		expect(triage?.status).toBe("working");
		const flaky = graph.nodes.find((node) => node.refId === "thread-flaky");
		expect(flaky?.status).toBe("attention");
	});

	test("filters kinds, orphans, and the local graph by depth", () => {
		const noTopics = filterGraph(graph, { ...ALL, topics: false });
		expect(noTopics.nodes.some((node) => node.kind === "topic")).toBe(false);
		expect(noTopics.links.some((link) => link.kind === "topic")).toBe(false);

		const noOrphans = filterGraph(graph, { ...ALL, orphans: false });
		expect(noOrphans.nodes.some((node) => node.refId === "thread-loose")).toBe(
			false
		);

		const depthOne = filterGraph(graph, {
			...ALL,
			local: { depth: 1, id: "agent:agent-grace" },
		});
		expect(orderNodes(depthOne.nodes).map((node) => node.label)).toEqual([
			"Grace",
			"Crash triage",
			"Crash in the flaky test",
		]);
		const depthTwo = filterGraph(graph, {
			...ALL,
			local: { depth: 2, id: "agent:agent-grace" },
		});
		expect(depthTwo.nodes.map((node) => node.label).sort()).toEqual([
			"Crash in the flaky test",
			"Crash triage",
			"Grace",
			"Website",
			"crash",
		]);
	});

	test("search, neighbourhoods, ordering and cycling", () => {
		expect([...searchNodes(graph.nodes, "#rel")].sort()).toEqual([
			"thread:thread-checklist",
			"thread:thread-notes",
			"topic:release",
		]);
		expect(searchNodes(graph.nodes, "  ").size).toBe(0);
		const around = neighbourhood(adjacency(graph.links), "team:team-docs", 1);
		expect([...around].sort()).toEqual([
			"agent:agent-ada",
			"agent:agent-linus",
			"team:team-docs",
			"thread:thread-notes",
		]);
		const ordered = orderNodes(graph.nodes);
		expect(ordered[0]?.kind).toBe("agent");
		expect(ordered.at(-1)?.kind).toBe("conversation");
		expect(cycleNode(ordered, null, 1)).toBe(ordered[0]?.id ?? null);
		expect(cycleNode(ordered, ordered[0]?.id ?? null, -1)).toBe(
			ordered.at(-1)?.id ?? null
		);
		expect(cycleNode([], null, 1)).toBe(null);
	});

	test("linked conversations come newest first, linked nodes exclude them", () => {
		expect(
			linkedThreads(SNAPSHOT, graph, "agent:agent-ada").map((item) => item.id)
		).toEqual(["thread-notes", "thread-checklist"]);
		expect(
			linkedEntities(graph, "thread:thread-notes").map((node) => node.label)
		).toEqual(["Ada", "Docs Crew", "release"]);
	});

	test("the layout is deterministic, settles, and keeps placed nodes", () => {
		const visible = filterGraph(graph, ALL);
		const first = createLayout(visible, 3);
		const second = createLayout(visible, 3);
		expect([...first.positions]).toEqual([...second.positions]);
		settleLayout(first, DEFAULT_SETTINGS, 400);
		expect(isSettled(first)).toBe(true);
		const bounds = layoutBounds(first);
		expect(bounds.radius).toBeGreaterThan(20);
		expect(bounds.radius).toBeLessThan(400);
		for (const value of first.positions) {
			expect(Number.isFinite(value)).toBe(true);
		}
		const fewer = filterGraph(graph, { ...ALL, topics: false });
		const kept = createLayout(fewer, 3, first);
		const index = first.index.get("agent:agent-ada") ?? 0;
		const keptIndex = kept.index.get("agent:agent-ada") ?? 0;
		expect(kept.positions[keptIndex * 3]).toBe(first.positions[index * 3]);
		expect(kept.alpha).toBeLessThan(1);
		const flat = createLayout(visible, 2);
		settleLayout(flat, DEFAULT_SETTINGS, 50);
		for (let node = 0; node < flat.ids.length; node += 1) {
			expect(flat.positions[node * 3 + 2]).toBe(0);
		}
		expect(warmTicks(10)).toBe(300);
		expect(warmTicks(2000)).toBe(20);
	});

	test("the 2D framing stays finite when filters hide every node", () => {
		const none = filterGraph(graph, {
			...ALL,
			agents: false,
			conversations: false,
			groups: false,
			topics: false,
		});
		const empty = createLayout(none, 2);
		expect(empty.ids.length).toBe(0);
		const area = freeArea(900, 600, 0);
		const fit = fitFlat(empty, area, new Map(), 60);
		expect(Number.isFinite(fit.k)).toBe(true);
		expect(fit.k).toBeGreaterThan(0);
		expect(fit).toMatchObject({ x: 0, y: 0 });
		// A subset that names no node frames the origin too.
		const flat = createLayout(filterGraph(graph, ALL), 2);
		const subset = fitFlat(flat, area, new Map(), 60, new Set());
		expect([subset.k, subset.x, subset.y].every(Number.isFinite)).toBe(true);
	});
});

describe("knowledge styles and palette", () => {
	const graph = filterGraph(buildKnowledgeGraph(SNAPSHOT), ALL);
	const layout = createLayout(graph, 3);
	const links = adjacency(graph.links);
	const light = knowledgePalette({
		...EMPTY_KNOWLEDGE_THEME,
		background: [255, 255, 255],
		primary: [10, 100, 250],
	});
	const dark = knowledgePalette({
		...EMPTY_KNOWLEDGE_THEME,
		background: [20, 20, 24],
	});

	test("dark themes get a deeper canvas, light themes a near-white one", () => {
		expect(light.mode).toBe("light");
		expect(dark.mode).toBe("dark");
		expect(dark.background[0]).toBeLessThan(20);
		expect(light.background).toEqual([255, 255, 255]);
		expect(isDarkTheme({ ...EMPTY_KNOWLEDGE_THEME, darkClass: true })).toBe(
			true
		);
		// "Your turn" has its own hue: never the working green, the
		// attention red or the neutral emphasis used for hover and selection.
		for (const palette of [light, dark]) {
			const yourTurn = palette.status["your-turn"];
			expect(yourTurn).not.toEqual(palette.status.working);
			expect(yourTurn).not.toEqual(palette.status.attention);
			expect(yourTurn).not.toEqual(palette.highlight);
			expect(yourTurn[2]).toBeGreaterThan(yourTurn[1]);
		}
		expect(agentColor("Ada", light)).toEqual(agentColor("Ada", light));
		expect(agentColor("Ada", light)).not.toEqual(agentColor("Ada", dark));
	});

	test("while a query is typed, matches stay lit and hover only rings", () => {
		const styles = buildStyles(
			graph,
			layout,
			links,
			light,
			{
				hovered: "agent:agent-grace",
				matches: new Set(["team:team-docs"]),
				query: true,
				selected: null,
			},
			1
		);
		const at = (id: string) => layout.index.get(id) ?? -1;
		expect(styles.alpha[at("team:team-docs")]).toBe(1);
		// Grace does not match: she stays dimmed under the pointer, with a ring.
		expect(styles.alpha[at("agent:agent-grace")]).toBeCloseTo(
			light.dimAlpha,
			5
		);
		expect(styles.ring[at("agent:agent-grace")]).toBeGreaterThan(0);
	});

	test("hubs and waiting conversations never share a grey", () => {
		for (const palette of [light, dark]) {
			const gap = Math.abs(palette.hub[0] - palette.status.waiting[0]);
			expect(gap).toBeGreaterThanOrEqual(40);
		}
	});

	test("hover lights a neighbourhood; search dims non-matches", () => {
		const hovered = buildStyles(
			graph,
			layout,
			links,
			light,
			{
				hovered: "agent:agent-grace",
				matches: new Set(),
				query: false,
				selected: null,
			},
			1
		);
		const at = (id: string) => layout.index.get(id) ?? -1;
		expect(hovered.alpha[at("agent:agent-grace")]).toBe(1);
		expect(hovered.alpha[at("thread:thread-triage")]).toBe(1);
		expect(hovered.alpha[at("agent:agent-ada")]).toBeCloseTo(light.dimAlpha);
		expect(hovered.label[at("thread:thread-triage")]).toBe(1);
		expect(hovered.label[at("agent:agent-ada")]).toBe(-1);

		const searched = buildStyles(
			graph,
			layout,
			links,
			light,
			{
				hovered: null,
				matches: new Set(["agent:agent-ada"]),
				query: true,
				selected: "agent:agent-ada",
			},
			1.5
		);
		expect(searched.alpha[at("agent:agent-ada")]).toBe(1);
		expect(searched.alpha[at("agent:agent-grace")]).toBeCloseTo(light.dimAlpha);
		expect(searched.ring[at("agent:agent-ada")]).toBe(1);
		expect(searched.size[at("agent:agent-ada")]).toBeCloseTo(
			(layout.radii[at("agent:agent-ada")] ?? 0) * 1.5
		);
	});

	test("picking takes the front-most node and labels never overlap", () => {
		const count = layout.ids.length;
		const projection = createProjection(count);
		for (let index = 0; index < count; index += 1) {
			projection.x[index] = 100 + index * 200;
			projection.y[index] = 100;
			projection.radius[index] = 8;
			projection.depth[index] = 10;
			projection.visible[index] = 1;
		}
		// Two nodes on one spot: the nearer one wins.
		projection.x[1] = 100;
		projection.depth[1] = 5;
		expect(pickNode(layout, projection, 102, 101)).toBe(layout.ids[1] ?? "");
		expect(pickNode(layout, projection, 160, 300)).toBe(null);

		const styles = buildStyles(
			graph,
			layout,
			links,
			light,
			{ hovered: null, matches: new Set(), query: false, selected: null },
			1
		);
		const labels = new Map<string, HTMLElement>();
		for (const id of layout.ids) {
			const element = document.createElement("span");
			Object.defineProperty(element, "offsetWidth", { value: 60 });
			labels.set(id, element);
		}
		syncLabels(
			layout,
			projection,
			styles,
			new Float32Array(count).fill(1),
			labels,
			{ height: 600, obstacles: null, textFade: 1, width: 4000 }
		);
		const shown = layout.ids.filter(
			(id) => labels.get(id)?.style.opacity !== "0"
		);
		// Nodes 0 and 1 share a spot: one label goes below, the other is
		// nudged aside (resting labels never flip above their node).
		expect(shown.length).toBe(count);
		const first = labels.get(layout.ids[0] ?? "")?.style.transform;
		const second = labels.get(layout.ids[1] ?? "")?.style.transform;
		expect(first).not.toBe(second);
		// Five wide labels on one spot near the stage edge: below and right
		// fit; nudges collide and the left side is clamped back into them.
		for (let index = 2; index < 5; index += 1) {
			projection.x[index] = 100;
			projection.depth[index] = index;
		}
		for (let index = 5; index < count; index += 1) {
			projection.visible[index] = 0;
		}
		const narrow = new Map<string, HTMLElement>();
		for (const id of layout.ids) {
			const element = document.createElement("span");
			Object.defineProperty(element, "offsetWidth", { value: 400 });
			narrow.set(id, element);
		}
		syncLabels(
			layout,
			projection,
			styles,
			new Float32Array(count).fill(1),
			narrow,
			{ height: 600, obstacles: null, textFade: 1, width: 4000 }
		);
		const crowded = layout.ids
			.slice(0, 5)
			.filter((id) => narrow.get(id)?.style.opacity !== "0");
		expect(crowded.length).toBe(2);
		projection.visible.fill(0);
		syncLabels(
			layout,
			projection,
			styles,
			new Float32Array(count).fill(1),
			labels,
			{ height: 600, obstacles: null, textFade: 1, width: 4000 }
		);
		expect(
			layout.ids.every((id) => labels.get(id)?.style.opacity === "0")
		).toBe(true);

		// A node in the legend row keeps its label out of the chrome.
		projection.visible.fill(1);
		for (let index = 0; index < count; index += 1) {
			projection.x[index] = 100 + index * 200;
			projection.y[index] = index === 0 ? 590 : 300;
		}
		syncLabels(
			layout,
			projection,
			styles,
			new Float32Array(count).fill(1),
			labels,
			{ height: 600, obstacles: null, textFade: 1, width: 4000 }
		);
		expect(labels.get(layout.ids[0] ?? "")?.style.opacity).toBe("0");
		expect(labels.get(layout.ids[1] ?? "")?.style.opacity).not.toBe("0");
	});
});

describe("knowledge camera framing", () => {
	const graph = filterGraph(buildKnowledgeGraph(SNAPSHOT), ALL);
	const stage = { height: 900, insetRight: 288, width: 1440 };

	test("the opening pose fits every node inside the free area", () => {
		const layout = createLayout(graph, 3);
		settleLayout(layout, { ...DEFAULT_SETTINGS }, 300);
		const pose = openingPose(layout, stage, new Map(), 30);
		const points = projectPose(layout, pose, stage, 1);
		const area = freeArea(stage.width, stage.height, stage.insetRight);
		expect(points).toHaveLength(layout.ids.length);
		for (const [x, y] of points) {
			expect(x).toBeGreaterThanOrEqual(area.left);
			expect(x).toBeLessThanOrEqual(area.right);
			expect(y).toBeGreaterThanOrEqual(area.top);
			expect(y).toBeLessThanOrEqual(area.bottom);
		}
	});

	test("a small subgraph keeps the global node scale", () => {
		const local = filterGraph(buildKnowledgeGraph(SNAPSHOT), {
			...ALL,
			local: { depth: 1, id: "team:team-docs" },
		});
		const layout = createLayout(local, 3);
		settleLayout(layout, { ...DEFAULT_SETTINGS }, 300);
		const pose = openingPose(layout, stage, new Map(), 30);
		for (const [, , radius] of projectPose(layout, pose, stage, 1)) {
			// Front nodes may sit a little nearer than the graph's middle.
			expect(radius).toBeLessThanOrEqual(MAX_FIT_DISC_PX * 1.4);
		}
	});

	test("a layout made from the same nodes carries on exactly where it was", () => {
		const layout = createLayout(graph, 3);
		settleLayout(layout, { ...DEFAULT_SETTINGS }, 400);
		const again = createLayout(graph, 3, layout);
		expect(again.alpha).toBe(layout.alpha);
		expect([...again.positions]).toEqual([...layout.positions]);
		// A changed node set wakes the layout so it can relax.
		const fewer = filterGraph(graph, { ...ALL, topics: false });
		expect(createLayout(fewer, 3, layout).alpha).toBeGreaterThan(layout.alpha);
	});
});

describe("knowledge label placement", () => {
	const graph = filterGraph(buildKnowledgeGraph(SNAPSHOT), ALL);
	const layout = createLayout(graph, 3);
	const links = adjacency(graph.links);
	const palette = knowledgePalette({
		...EMPTY_KNOWLEDGE_THEME,
		background: [255, 255, 255],
	});
	const count = layout.ids.length;
	const resting = buildStyles(
		graph,
		layout,
		links,
		palette,
		{ hovered: null, matches: new Set(), query: false, selected: null },
		1
	);
	const labelsOf = (width: number) => {
		const labels = new Map<string, HTMLElement>();
		for (const id of layout.ids) {
			const element = document.createElement("span");
			Object.defineProperty(element, "offsetWidth", { value: width });
			labels.set(id, element);
		}
		return labels;
	};
	const spread = () => {
		const projection = createProjection(count);
		for (let index = 0; index < count; index += 1) {
			projection.x[index] = 300 + index * 240;
			projection.y[index] = 300;
			projection.radius[index] = 8;
			projection.depth[index] = 10;
			projection.visible[index] = 1;
		}
		return projection;
	};
	const top = (element: HTMLElement | undefined) =>
		Number(/,\s*(-?[\d.]+)px/.exec(element?.style.transform ?? "")?.[1]);
	const left = (element: HTMLElement | undefined) =>
		Number(/\((-?[\d.]+)px/.exec(element?.style.transform ?? "")?.[1]);
	const frame = {
		height: 600,
		obstacles: null,
		textFade: 1,
		width: 300 + count * 240,
	};

	test("resting labels keep body-text contrast at the back of the graph", () => {
		const projection = spread();
		projection.fog.fill(1);
		const labels = labelsOf(60);
		syncLabels(
			layout,
			projection,
			resting,
			new Float32Array(count).fill(1),
			labels,
			frame
		);
		for (const id of layout.ids) {
			expect(Number(labels.get(id)?.style.opacity)).toBeGreaterThanOrEqual(
				0.85
			);
		}
	});

	test("a resting label whose slot below is taken still shows, clear of the node in the way", () => {
		const projection = spread();
		// A node right under the first one blocks its "below" slot.
		projection.x[1] = 300;
		projection.y[1] = 330;
		const labels = labelsOf(60);
		syncLabels(
			layout,
			projection,
			resting,
			new Float32Array(count).fill(1),
			labels,
			frame
		);
		const first = labels.get(layout.ids[0] ?? "");
		expect(first?.style.opacity).not.toBe("0");
		// Its box (16px tall) does not reach the blocking node's disc.
		const box = top(first);
		const blockerTop = (projection.y[1] ?? 0) - (projection.radius[1] ?? 0);
		const blockerBottom = (projection.y[1] ?? 0) + (projection.radius[1] ?? 0);
		expect(box + 16 <= blockerTop || box >= blockerBottom).toBe(true);
	});

	test("labels keep a gutter from the stage edge and clear the chrome", () => {
		const projection = spread();
		projection.x[0] = 4;
		const labels = labelsOf(120);
		syncLabels(
			layout,
			projection,
			resting,
			new Float32Array(count).fill(1),
			labels,
			{ ...frame, obstacles: [[1000, 0, 1400, 600]] }
		);
		const first = labels.get(layout.ids[0] ?? "");
		expect(first?.style.opacity).not.toBe("0");
		expect(left(first)).toBeGreaterThanOrEqual(12);
		// Nodes under the settings card keep their labels hidden.
		for (const [index, id] of layout.ids.entries()) {
			const x = projection.x[index] ?? 0;
			if (x > 1060 && x < 1340) {
				expect(labels.get(id)?.style.opacity).toBe("0");
			}
		}
	});

	test("a selected node's label claims space first; no label boxes intersect", () => {
		const settled = createLayout(graph, 2);
		settleLayout(settled, DEFAULT_SETTINGS, 400);
		const stage = { height: 520, width: 760 };
		// Project the settled layout onto the stage, as the 2D view's fit does.
		const xs: number[] = [];
		const ys: number[] = [];
		for (let index = 0; index < count; index += 1) {
			xs.push(settled.positions[index * 3] ?? 0);
			ys.push(settled.positions[index * 3 + 1] ?? 0);
		}
		const spanX = Math.max(...xs) - Math.min(...xs) || 1;
		const spanY = Math.max(...ys) - Math.min(...ys) || 1;
		const scale = Math.min(
			(stage.width - 240) / spanX,
			(stage.height - 160) / spanY
		);
		const projection = createProjection(count);
		for (let index = 0; index < count; index += 1) {
			projection.x[index] =
				stage.width / 2 +
				((xs[index] ?? 0) - (Math.min(...xs) + spanX / 2)) * scale;
			projection.y[index] =
				stage.height / 2 +
				((ys[index] ?? 0) - (Math.min(...ys) + spanY / 2)) * scale;
			projection.radius[index] =
				(settled.radii[index] ?? 3) * 0.62 * scale * 0.4;
			projection.depth[index] = 10;
			projection.visible[index] = 1;
		}
		const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
		const widthOf = (id: string) =>
			Math.round((nodesById.get(id)?.label.length ?? 6) * 6.5);
		const boxesOf = (selected: string, hovered: string | null) => {
			const styles = buildStyles(
				graph,
				settled,
				adjacency(graph.links),
				palette,
				{ hovered, matches: new Set(), query: false, selected },
				1
			);
			const labels = new Map<string, HTMLElement>();
			for (const id of settled.ids) {
				const element = document.createElement("span");
				Object.defineProperty(element, "offsetWidth", { value: widthOf(id) });
				labels.set(id, element);
			}
			syncLabels(
				settled,
				projection,
				styles,
				new Float32Array(count).fill(1),
				labels,
				{ ...stage, obstacles: [], textFade: 1 }
			);
			return settled.ids.flatMap((id) => {
				const element = labels.get(id);
				if (!element || element.style.opacity === "0") {
					return [];
				}
				const x = left(element);
				const y = top(element);
				return [{ box: [x, y, x + widthOf(id), y + 16], id }];
			});
		};
		for (const selected of settled.ids) {
			const shown = boxesOf(selected, null);
			// The selection's own label always shows.
			expect(shown.some((entry) => entry.id === selected)).toBe(true);
			for (const [index, a] of shown.entries()) {
				for (const b of shown.slice(index + 1)) {
					const overlapX =
						Math.min(a.box[2] ?? 0, b.box[2] ?? 0) -
						Math.max(a.box[0] ?? 0, b.box[0] ?? 0);
					const overlapY =
						Math.min(a.box[3] ?? 0, b.box[3] ?? 0) -
						Math.max(a.box[1] ?? 0, b.box[1] ?? 0);
					expect(overlapX > 0 && overlapY > 0).toBe(false);
				}
			}
		}
		// Hovering another node keeps both labels, still without overlap.
		const first = settled.ids[0] ?? "";
		const second = settled.ids[1] ?? "";
		const both = boxesOf(first, second).map((entry) => entry.id);
		expect(both).toContain(second);
	});

	test("a forced label moves off a link that runs through it", () => {
		const projection = spread();
		// Node 0's link runs straight down through its "below" slot.
		const linkIndex = 0;
		const source = layout.links[linkIndex * 2] ?? 0;
		const target = layout.links[linkIndex * 2 + 1] ?? 0;
		projection.x[source] = 400;
		projection.y[source] = 200;
		projection.x[target] = 400;
		projection.y[target] = 500;
		const id = layout.ids[source] ?? "";
		const styles = buildStyles(
			graph,
			layout,
			links,
			palette,
			{ hovered: null, matches: new Set(), query: false, selected: id },
			1
		);
		const labels = labelsOf(60);
		syncLabels(
			layout,
			projection,
			styles,
			new Float32Array(count).fill(1),
			labels,
			frame
		);
		const element = labels.get(id);
		expect(element?.style.opacity).toBe("1.00");
		const x = left(element);
		const y = top(element);
		expect(
			segmentCrossesRect([400, 200, 400, 500], [x, y + 2, x + 60, y + 14])
		).toBe(false);
	});

	test("labels of off-stage nodes hide, and the header band blocks its row", () => {
		const projection = spread();
		// Above the stage, inside the projection's visibility margin.
		projection.y[0] = -20;
		projection.y[1] = 40;
		const labels = labelsOf(60);
		syncLabels(
			layout,
			projection,
			resting,
			new Float32Array(count).fill(1),
			labels,
			{
				...frame,
				obstacles: [
					[Number.NEGATIVE_INFINITY, 0, Number.POSITIVE_INFINITY, 64],
				],
			}
		);
		expect(labels.get(layout.ids[0] ?? "")?.style.opacity).toBe("0");
		expect(labels.get(layout.ids[1] ?? "")?.style.opacity).toBe("0");
		expect(labels.get(layout.ids[2] ?? "")?.style.opacity).not.toBe("0");
		// A node at the very edge would need its label pushed far: hidden.
		const edge = spread();
		edge.x[0] = 2;
		const edgeLabels = labelsOf(200);
		syncLabels(
			layout,
			edge,
			resting,
			new Float32Array(count).fill(1),
			edgeLabels,
			frame
		);
		const first = edgeLabels.get(layout.ids[0] ?? "");
		if (first?.style.opacity !== "0") {
			// Shown only beside the node (right), never slid away under it.
			expect(left(first)).toBeGreaterThan(2);
			expect(first?.dataset.side).toBe("right");
		}
	});

	test("labels fade by kind as nodes shrink: conversations first, hubs last", () => {
		const kinds = new Map(graph.nodes.map((node) => [node.id, node.kind]));
		const shown = (radius: number) => {
			const projection = spread();
			projection.radius.fill(radius);
			const labels = labelsOf(60);
			for (const [id, element] of labels) {
				element.dataset.kind = kinds.get(id) ?? "";
			}
			syncLabels(
				layout,
				projection,
				resting,
				new Float32Array(count).fill(1),
				labels,
				{ ...frame, textFade: 0.5 }
			);
			const visible = new Set<string>();
			for (const [id, element] of labels) {
				if (element.style.opacity !== "0") {
					visible.add(kinds.get(id) ?? "");
				}
			}
			return visible;
		};
		const far = shown(5);
		expect(far.has("project") || far.has("team")).toBe(true);
		expect(far.has("conversation")).toBe(false);
		expect(far.has("agent")).toBe(false);
		const middle = shown(6.5);
		expect(middle.has("agent")).toBe(true);
		expect(middle.has("conversation")).toBe(true);
		const near = shown(12);
		for (const kind of ["agent", "conversation", "project", "team"]) {
			expect(near.has(kind)).toBe(true);
		}
	});

	test("hovering a node keeps resting labels in the slot they had", () => {
		const projection = spread();
		const labels = labelsOf(60);
		const alpha = new Float32Array(count).fill(1);
		syncLabels(layout, projection, resting, alpha, labels, frame);
		const second = labels.get(layout.ids[1] ?? "");
		expect(second?.dataset.side).toBe("below");
		// It was showing beside its node (as after an earlier camera move).
		if (second) {
			second.dataset.side = "right";
		}
		const hovered = buildStyles(
			graph,
			layout,
			links,
			palette,
			{
				hovered: layout.ids[0] ?? null,
				matches: new Set(),
				query: false,
				selected: null,
			},
			1
		);
		syncLabels(layout, projection, hovered, alpha, labels, frame);
		expect(second?.dataset.side).toBe("right");
		// At rest the preferred slot under the node wins back.
		syncLabels(layout, projection, resting, alpha, labels, frame);
		expect(second?.dataset.side).toBe("below");
	});

	test("agent tints follow their avatar, clear of status hues and of each other", () => {
		const names = ["Atlas", "Brook", "Cipher", "Delta", "Echo", "Forge"];
		for (const background of [
			[255, 255, 255],
			[20, 20, 24],
		] as const) {
			const tinted = knowledgePalette(
				{ ...EMPTY_KNOWLEDGE_THEME, background },
				names
			);
			const distance = (a: number, b: number) => {
				const gap = Math.abs(a - b) % 360;
				return gap > 180 ? 360 - gap : gap;
			};
			const hues = names.map((name) => tinted.agentHues.get(name) ?? -1);
			for (const [index, hue] of hues.entries()) {
				// Near the avatar the side panel shows.
				expect(
					distance(hue, ditherAvatarHue(names[index] ?? ""))
				).toBeLessThanOrEqual(30);
				for (const reserved of tinted.reserved) {
					expect(distance(hue, reserved)).toBeGreaterThanOrEqual(16);
				}
				for (const other of hues.slice(index + 1)) {
					expect(distance(hue, other)).toBeGreaterThanOrEqual(20);
				}
			}
			// An agent whose avatar hue is already clear keeps it exactly.
			expect(tinted.agentHues.get("Brook")).toBe(ditherAvatarHue("Brook"));
			// Hubs and waiting conversations are both neutral: hubs sit well
			// toward the text colour, so the two never read alike.
			const gap = Math.abs(tinted.hub[0] - tinted.status.waiting[0]);
			expect(gap).toBeGreaterThanOrEqual(40);
		}
	});

	test("animate gathers the layout and runs it again from full heat", () => {
		const replay = createLayout(graph, 3);
		settleLayout(replay, DEFAULT_SETTINGS, 400);
		// Spread: the largest distance of any node from the first.
		const spreadOf = () => {
			let widest = 0;
			for (let index = 0; index < replay.ids.length; index += 1) {
				widest = Math.max(
					widest,
					Math.hypot(
						(replay.positions[index * 3] ?? 0) - (replay.positions[0] ?? 0),
						(replay.positions[index * 3 + 1] ?? 0) - (replay.positions[1] ?? 0),
						(replay.positions[index * 3 + 2] ?? 0) - (replay.positions[2] ?? 0)
					)
				);
			}
			return widest;
		};
		const before = spreadOf();
		replayLayout(replay);
		expect(spreadOf()).toBeCloseTo(before * 0.12, 3);
		expect(isSettled(replay)).toBe(false);
		settleLayout(replay, DEFAULT_SETTINGS, 400);
		expect(spreadOf()).toBeGreaterThan(before * 0.5);
	});
});

describe("knowledge legend", () => {
	const palette = knowledgePalette({
		...EMPTY_KNOWLEDGE_THEME,
		background: [255, 255, 255],
	});
	const statuses = new Set(THREAD_STATUS_ORDER);
	const kinds = new Set(["agent", "project", "team"] as const);

	test("every status stays explained; only shape entries drop on narrow stages", () => {
		const markup = renderToStaticMarkup(
			<KnowledgeLegend
				agents={["Ada"]}
				kinds={kinds}
				palette={palette}
				statuses={statuses}
			/>
		);
		for (const status of THREAD_STATUS_ORDER) {
			expect(markup).toContain(THREAD_STATUS_LABELS[status]);
		}
		expect(markup.match(/max-\[1040px\]\/stage:hidden/g)?.length).toBe(2);
		const list = renderToStaticMarkup(
			<KnowledgeLegend
				agents={["Ada"]}
				kinds={kinds}
				layout="list"
				palette={palette}
				statuses={statuses}
			/>
		);
		expect(list).not.toContain("stage:hidden");
	});

	test("narrow stages fold the legend into a button", () => {
		const markup = renderToStaticMarkup(
			<KnowledgeLegendButton
				agents={[]}
				kinds={kinds}
				palette={palette}
				statuses={statuses}
			/>
		);
		expect(markup).toContain(">Legend<");
	});
});

describe("KnowledgeInterface", () => {
	test("renders loading, empty and open-thread states", () => {
		const { port } = recordingPort();
		const empty = { ...SNAPSHOT, agents: [], groups: [], threads: [] };
		const loadingMarkup = renderToStaticMarkup(
			<KnowledgeInterface
				activeThreadId={null}
				loading
				params={KNOWLEDGE_PARAMS}
				port={port}
				snapshot={empty}
				threadView={null}
			/>
		);
		expect(loadingMarkup).toContain('data-testid="interface-knowledge"');
		expect(loadingMarkup).toContain('aria-busy="true"');
		expect(loadingMarkup).toContain("Loading workspace");

		const emptyMarkup = renderToStaticMarkup(
			<KnowledgeInterface
				activeThreadId={null}
				loading={false}
				params={KNOWLEDGE_PARAMS}
				port={port}
				snapshot={empty}
				threadView={null}
			/>
		);
		expect(emptyMarkup).toContain("Nothing to graph yet");

		const openMarkup = renderToStaticMarkup(
			<KnowledgeInterface
				activeThreadId="thread-triage"
				loading={false}
				params={KNOWLEDGE_PARAMS}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div data-testid="host-thread-view">Host</div>}
			/>
		);
		expect(openMarkup).toContain('data-testid="knowledge-thread-panel"');
		expect(openMarkup).toContain('data-testid="host-thread-view"');
		expect(openMarkup).toContain('aria-label="Conversation: Crash triage"');
	});

	test("selecting nodes opens their panel and conversations open the host thread", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<KnowledgeInterface
				activeThreadId={null}
				loading={false}
				params={KNOWLEDGE_PARAMS}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(listedNodes(view.container)).toContain("release");
		await click(nodeButton(view.container, "Ada,"));
		const panel = view.container.querySelector(
			'[data-testid="knowledge-node-panel"]'
		);
		expect(panel?.getAttribute("aria-label")).toBe("Agent: Ada");
		// The kind leads the meta line under the name; no eyebrow above it.
		expect(panel?.textContent).toContain("Agent · 2 conversations");
		// The avatar is ringed in the agent's node colour.
		const ring = panel?.querySelector<HTMLElement>(
			"[data-knowledge-agent-ring]"
		);
		expect(ring?.style.boxShadow).toContain("inset 0 0 0 2px");
		await click(byName(view.container, "New conversation"));
		await click(
			byName(view.container, "Open Release checklist, Waiting on agent")
		);
		await click(nodeButton(view.container, "release,"));
		expect(
			view.container
				.querySelector('[data-testid="knowledge-node-panel"]')
				?.getAttribute("aria-label")
		).toBe("Topic: release");
		expect(byName(view.container, "New conversation")).toBe(undefined);
		await click(nodeButton(view.container, "Docs Crew,"));
		await click(byName(view.container, "Go to Ada, agent"));
		expect(
			view.container
				.querySelector('[data-testid="knowledge-node-panel"]')
				?.getAttribute("aria-label")
		).toBe("Agent: Ada");
		expect(calls).toEqual([
			'start:{"agentId":"agent-ada"}',
			"open:thread-checklist",
		]);
		await view.dispose();
	});

	test("a conversation opened from a node steps back to it", async () => {
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
				<KnowledgeInterface
					activeThreadId={activeThreadId}
					loading={false}
					params={KNOWLEDGE_PARAMS}
					port={port}
					snapshot={SNAPSHOT}
					threadView={activeThreadId ? <div>Host view</div> : null}
				/>
			);
		}
		const view = await mount(<Host />);
		await click(nodeButton(view.container, "Website,"));
		await click(byName(view.container, "Open Crash triage, Working"));
		expect(view.container.textContent).toContain("Host view");
		await click(byName(view.container, "Back to Website"));
		expect(
			view.container
				.querySelector('[data-testid="knowledge-node-panel"]')
				?.getAttribute("aria-label")
		).toBe("Project: Website");
		await click(byName(view.container, "Close Website"));
		expect(
			view.container.querySelector('[data-testid="knowledge-node-panel"]')
		).toBe(null);
		expect(calls).toEqual(["open:thread-triage", "close"]);
		await view.dispose();
	});

	test("settings filter kinds, switch to the local graph, and restore", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<KnowledgeInterface
				activeThreadId={null}
				loading={false}
				params={KNOWLEDGE_PARAMS}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const toggle = async (name: string) =>
			click(
				view.container.querySelector(`[role="switch"][aria-label="${name}"]`)
			);
		// "Include latest messages" is a sub-option of Topics.
		expect(
			view.container.querySelector(
				'[role="switch"][aria-label="Include latest messages in topics"]'
			)
		).not.toBe(null);
		await toggle("Show topics");
		expect(listedNodes(view.container)).not.toContain("release");
		expect(
			view.container.querySelector(
				'[role="switch"][aria-label="Include latest messages in topics"]'
			)
		).toBe(null);
		await toggle("Show orphans");
		expect(listedNodes(view.container)).not.toContain("Loose ends");

		await toggle("Local graph");
		expect(view.container.textContent).toContain("Select a node to centre on.");
		await click(nodeButton(view.container, "Grace,"));
		expect(view.container.querySelector("h2")?.textContent).toBe(
			"Local graph of Grace"
		);
		expect(listedNodes(view.container).sort()).toEqual([
			"Crash in the flaky test",
			"Crash triage",
			"Grace",
		]);
		await click(byName(view.container, "Depth 2"));
		expect(listedNodes(view.container)).toContain("Website");

		await click(byName(view.container, "Restore default settings"));
		expect(view.container.querySelector("h2")?.textContent).toBe(
			"Knowledge graph"
		);
		expect(listedNodes(view.container)).toContain("release");

		await click(byName(view.container, "Close graph settings"));
		expect(view.container.querySelector('[aria-label="Graph settings"]')).toBe(
			null
		);
		await click(byName(view.container, "Open graph settings"));
		expect(
			view.container.querySelector('[aria-label="Graph settings"]')
		).not.toBe(null);
		await view.dispose();
	});

	test("graph settings save through the port and follow the live params", async () => {
		const saved: Record<string, unknown>[] = [];
		const port: InterfacePort = {
			...recordingPort().port,
			updateSettings: (patch) => saved.push(patch),
		};
		const element = (params: typeof KNOWLEDGE_PARAMS) => (
			<KnowledgeInterface
				activeThreadId={null}
				loading={false}
				params={params}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(element(KNOWLEDGE_PARAMS)));
		const topics = () =>
			container.querySelector('[role="switch"][aria-label="Show topics"]');
		await click(topics());
		expect(saved).toEqual([{ topics: false }]);
		expect(listedNodes(container)).not.toContain("release");
		await click(byName(container, "Restore default settings"));
		expect(saved.at(-1)).toMatchObject({ orphans: true, topics: true });
		// Settings (or a reset there) arrive as new params and win.
		await act(async () =>
			root.render(element({ ...KNOWLEDGE_PARAMS, orphans: false }))
		);
		expect(listedNodes(container)).not.toContain("Loose ends");
		expect(
			container
				.querySelector('[role="switch"][aria-label="Show orphans"]')
				?.getAttribute("aria-checked")
		).toBe("false");
		await act(async () => root.unmount());
		container.remove();
	});

	test("restore default settings forgets the saved settings through the port", async () => {
		const saved: Record<string, unknown>[] = [];
		let resets = 0;
		const port: InterfacePort = {
			...recordingPort().port,
			resetSettings: () => {
				resets += 1;
			},
			updateSettings: (patch) => saved.push(patch),
		};
		const view = await mount(
			<KnowledgeInterface
				activeThreadId={null}
				loading={false}
				params={KNOWLEDGE_PARAMS}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await click(byName(view.container, "Restore default settings"));
		expect(resets).toBe(1);
		// No renderer defaults are written as overrides.
		expect(saved).toEqual([]);
		await view.dispose();
	});

	test("the keyboard walks nodes and Escape steps back out", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<KnowledgeInterface
				activeThreadId={null}
				loading={false}
				params={KNOWLEDGE_PARAMS}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const scene = view.container.querySelector('[role="application"]');
		if (!(scene instanceof HTMLElement)) {
			throw new Error("Expected the graph region");
		}
		const press = async (key: string, target: HTMLElement = scene) =>
			act(async () => {
				target.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key })
				);
			});
		await press("ArrowRight");
		await press("Enter");
		expect(
			view.container
				.querySelector('[data-testid="knowledge-node-panel"]')
				?.getAttribute("aria-label")
		).toBe("Agent: Ada");
		await press("Escape");
		expect(
			view.container.querySelector('[data-testid="knowledge-node-panel"]')
		).toBe(null);
		expect(calls).toEqual([]);
		await view.dispose();
	});
});
