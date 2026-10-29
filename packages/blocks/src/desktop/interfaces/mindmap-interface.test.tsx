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
import {
	assignSides,
	buildMindmapTree,
	fitView,
	initialCollapsed,
	layoutMindmap,
	MINDMAP_DIRECT_ID,
	MINDMAP_FOLD_THRESHOLD,
	MINDMAP_LEAF_LIMIT,
	MINDMAP_ROOT_ID,
	moveFocus,
	revealBox,
	taperPath,
	visibleAncestor,
	zoomAt,
} from "./mindmap-model.ts";

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
			memberAgentIds: ["agent-ada"],
			name: "Website",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			projectId: "project-site",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada", "agent-linus"],
			id: "thread-plan",
			teamId: "team-docs",
			title: "Docs plan",
			updatedAt: ago(40),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
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
			id: "thread-loose",
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
// Import after the DOM exists: motion binds requestAnimationFrame on load, and
// exit animations (folding) only finish with a real frame loop.
const { MindmapInterface } = await import("./mindmap-interface.tsx");
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

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

function node(container: HTMLElement, id: string): HTMLElement {
	const element = container.querySelector<HTMLElement>(
		`[data-mindmap-node="${id}"]`
	);
	if (!element) {
		throw new Error(`Missing node ${id}`);
	}
	return element;
}

function buttonNamed(container: HTMLElement, label: string): HTMLElement {
	const match = [...container.querySelectorAll<HTMLElement>("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label
	);
	if (!match) {
		throw new Error(`Missing button ${label}`);
	}
	return match;
}

async function press(target: HTMLElement, key: string) {
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

function hasNode(container: HTMLElement, id: string): boolean {
	return container.querySelector(`[data-mindmap-node="${id}"]`) !== null;
}

const SETTLE_POLL_MS = 20;
const SETTLE_LIMIT_MS = 5000;

/**
 * Let a folded node's exit animation finish so it leaves the DOM. Polls instead
 * of sleeping a fixed time, so a loaded machine that runs the 0.24s exit late
 * still settles; the caller's assertion fails if it never leaves.
 */
async function settle(container: HTMLElement, id: string) {
	const deadline = performance.now() + SETTLE_LIMIT_MS;
	while (hasNode(container, id) && performance.now() < deadline) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
		});
	}
}

function focused(): string | undefined {
	return (document.activeElement as HTMLElement | null)?.dataset.mindmapNode;
}

describe("mindmap model", () => {
	test("files every thread once: project, then team, then Direct", () => {
		const tree = buildMindmapTree(SNAPSHOT);
		const root = tree.nodes.get(MINDMAP_ROOT_ID);
		expect(root?.childIds).toEqual([
			"group:project-site",
			"group:team-docs",
			MINDMAP_DIRECT_ID,
		]);
		// Single-agent threads hang off their agent inside the branch.
		expect(
			tree.nodes.get("agent:group:project-site:agent-ada")?.childIds
		).toEqual(["thread:thread-notes"]);
		// Several agents: the thread belongs to the team itself.
		expect(tree.nodes.get("group:team-docs")?.childIds).toEqual([
			"agent:group:team-docs:agent-ada",
			"agent:group:team-docs:agent-linus",
			"thread:thread-plan",
		]);
		// Grace has no group; agent-less threads sit on Direct.
		const direct = tree.nodes.get(MINDMAP_DIRECT_ID);
		expect(direct?.childIds).toEqual([
			"agent:group:direct:agent-grace",
			"thread:thread-loose",
		]);
		const threadNodes = [...tree.nodes.values()].filter(
			(entry) => entry.kind === "thread"
		);
		expect(threadNodes).toHaveLength(SNAPSHOT.threads.length);
		expect(root?.threadCount).toBe(5);
	});

	test("orders leaves most urgent first and counts what needs you", () => {
		const tree = buildMindmapTree(SNAPSHOT);
		const grace = tree.nodes.get("agent:group:direct:agent-grace");
		expect(grace?.childIds).toEqual([
			"thread:thread-flaky",
			"thread:thread-triage",
		]);
		expect(grace?.urgentCount).toBe(1);
		expect(grace?.working).toBe(true);
		expect(tree.nodes.get("thread:thread-flaky")?.status).toBe("attention");
	});

	test("balances branches across both sides, heaviest first", () => {
		expect(assignSides([2, 4, 7])).toEqual(["left", "left", "right"]);
		expect(assignSides([1])).toEqual(["right"]);
		expect(assignSides([3, 3])).toEqual(["right", "left"]);
	});

	test("folds long leaf lists into a 'more' leaf until shown in full", () => {
		const many: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: Array.from({ length: 12 }, (_, index) =>
				thread({
					agentIds: ["agent-grace"],
					id: `t-${index}`,
					updatedAt: ago(index),
				})
			),
		};
		const tree = buildMindmapTree(many);
		const grace = tree.nodes.get("agent:group:direct:agent-grace");
		expect(grace?.childIds).toHaveLength(MINDMAP_LEAF_LIMIT);
		const more = tree.nodes.get("more:agent:group:direct:agent-grace");
		expect(more?.hiddenCount).toBe(12 - (MINDMAP_LEAF_LIMIT - 1));
		expect(more?.label).toBe("5 more");
		const full = buildMindmapTree(
			many,
			new Set(["agent:group:direct:agent-grace"])
		);
		expect(
			full.nodes.get("agent:group:direct:agent-grace")?.childIds
		).toHaveLength(12);
	});

	test("big maps start with quiet agents folded", () => {
		const big: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: Array.from({ length: MINDMAP_FOLD_THRESHOLD + 1 }, (_, index) =>
				thread({
					agentIds: [index % 2 ? "agent-ada" : "agent-grace"],
					id: `t-${index}`,
					// Grace's threads all wait on you; Ada's are quiet.
					lastMessageRole: index % 2 ? null : "assistant",
				})
			),
		};
		const collapsed = initialCollapsed(buildMindmapTree(big));
		expect(collapsed.has("agent:group:direct:agent-ada")).toBe(true);
		expect(collapsed.has("agent:group:direct:agent-grace")).toBe(false);
		expect(initialCollapsed(buildMindmapTree(SNAPSHOT)).size).toBe(0);
	});

	test("lays out right of You going right, left going left, centred", () => {
		const tree = buildMindmapTree(SNAPSHOT);
		const layout = layoutMindmap(tree, new Set());
		const you = layout.placed.get(MINDMAP_ROOT_ID);
		expect(you && you.x + you.width / 2).toBe(0);
		for (const id of layout.order) {
			const entry = tree.nodes.get(id);
			const box = layout.placed.get(id);
			if (!(entry && box) || entry.kind === "root") {
				continue;
			}
			if (entry.side === "right") {
				expect(box.x).toBeGreaterThan(0);
			} else {
				expect(box.x + box.width).toBeLessThan(0);
			}
		}
		// Every visible non-root node has exactly one branch.
		expect(layout.edges).toHaveLength(layout.order.length - 1);
	});

	test("folding hides descendants and keeps the fold reachable", () => {
		const tree = buildMindmapTree(SNAPSHOT);
		const folded = layoutMindmap(tree, new Set([MINDMAP_DIRECT_ID]));
		expect(folded.placed.has("thread:thread-triage")).toBe(false);
		expect(folded.placed.has(MINDMAP_DIRECT_ID)).toBe(true);
		expect(visibleAncestor(tree, folded, "thread:thread-triage")).toBe(
			MINDMAP_DIRECT_ID
		);
	});

	test("arrow keys walk parent, children, and neighbours", () => {
		const tree = buildMindmapTree(SNAPSHOT);
		const layout = layoutMindmap(tree, new Set());
		const direct = tree.nodes.get(MINDMAP_DIRECT_ID);
		const outward = direct?.side === "left" ? "ArrowLeft" : "ArrowRight";
		const inward = outward === "ArrowLeft" ? "ArrowRight" : "ArrowLeft";
		expect(
			moveFocus(tree, layout, new Set(), MINDMAP_ROOT_ID, outward)?.kind
		).toBe("focus");
		const child = moveFocus(
			tree,
			layout,
			new Set(),
			MINDMAP_DIRECT_ID,
			outward
		);
		expect(child?.kind).toBe("focus");
		expect(direct?.childIds).toContain(child?.id ?? "");
		expect(moveFocus(tree, layout, new Set(), child?.id ?? "", inward)).toEqual(
			{ id: MINDMAP_DIRECT_ID, kind: "focus" }
		);
		// Down from Grace reaches her sibling, the loose thread.
		expect(
			moveFocus(
				tree,
				layout,
				new Set(),
				"agent:group:direct:agent-grace",
				"ArrowDown"
			)
		).toEqual({ id: "thread:thread-loose", kind: "focus" });
		// Outward on a folded node unfolds it rather than moving.
		expect(
			moveFocus(
				tree,
				layout,
				new Set([MINDMAP_DIRECT_ID]),
				MINDMAP_DIRECT_ID,
				outward
			)
		).toEqual({ id: MINDMAP_DIRECT_ID, kind: "expand" });
		expect(moveFocus(tree, layout, new Set(), child?.id ?? "", "Home")).toEqual(
			{ id: MINDMAP_ROOT_ID, kind: "focus" }
		);
	});

	test("tapered branches have a fixed shape and close", () => {
		const a = taperPath({ x: 0, y: 0 }, { x: 100, y: 40 }, 6, 2, 160);
		const b = taperPath({ x: 0, y: 0 }, { x: -100, y: -30 }, 3, 1);
		expect(a.startsWith("M")).toBe(true);
		expect(a.endsWith("Z")).toBe(true);
		// Same command count, so motion can morph one into the other.
		expect(a.split("L")).toHaveLength(b.split("L").length);
		expect(a).toContain("160 ");
	});

	test("fits, zooms around a point, and reveals off-screen boxes", () => {
		const view = fitView(
			{ maxX: 400, maxY: 100, minX: -400, minY: -100 },
			{ height: 600, width: 1000 }
		);
		expect(view.k).toBe(1);
		expect(view.x).toBe(500);
		const small = fitView(
			{ maxX: 2000, maxY: 100, minX: -2000, minY: -100 },
			{ height: 600, width: 1000 }
		);
		expect(small.k).toBeLessThan(1);
		const zoomed = zoomAt({ k: 1, x: 0, y: 0 }, 2, { x: 100, y: 100 });
		expect(zoomed).toEqual({ k: 2, x: -100, y: -100 });
		const moved = revealBox(
			{ k: 1, x: 0, y: 0 },
			{ height: 20, id: "n", width: 100, x: 950, y: 10 },
			{ height: 600, width: 1000 }
		);
		expect(moved.x).toBeLessThan(0);
		expect(moved.y).toBeGreaterThan(0);
	});
});

describe("MindmapInterface", () => {
	test("renders the tree with accessible names and no thread panel", () => {
		const { port } = recordingPort();
		const html = renderToStaticMarkup(
			<MindmapInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(html).toContain('data-testid="interface-mindmap"');
		expect(html).toContain('role="tree"');
		expect(html).toContain('aria-label="Mind map"');
		expect(html).toContain("Docs Crew");
		expect(html).toContain("Crash triage");
		expect(html).toContain("Flaky test, Needs attention");
		expect(html).toContain('aria-label="New thread with Grace"');
		expect(html).not.toContain("mindmap-thread-panel");
		expect(html).not.toMatch(/style="[^"]*(#[0-9a-f]{3,8}|rgb)/i);
	});

	test("shows a skeleton while loading and an empty state with no data", () => {
		const { port } = recordingPort();
		const empty: InterfaceSnapshot = {
			agents: [],
			groups: [],
			threads: [],
			version: 1,
		};
		const loadingHtml = renderToStaticMarkup(
			<MindmapInterface
				activeThreadId={null}
				loading
				params={{}}
				port={port}
				snapshot={empty}
				threadView={null}
			/>
		);
		expect(loadingHtml).toContain('aria-busy="true"');
		expect(loadingHtml).toContain('data-testid="interface-mindmap"');
		const emptyHtml = renderToStaticMarkup(
			<MindmapInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={empty}
				threadView={null}
			/>
		);
		expect(emptyHtml).toContain("Nothing on the map yet");
		expect(emptyHtml).toContain("New thread");
	});

	test("opens threads, folds branches, and starts threads through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<MindmapInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await act(async () => node(view.container, "thread:thread-triage").click());
		expect(calls).toContain("open:thread-triage");

		await act(async () =>
			buttonNamed(view.container, "New thread with Grace").click()
		);
		expect(calls).toContain('start:{"agentId":"agent-grace"}');

		// Agents inside a branch file the new thread there too.
		await act(async () =>
			buttonNamed(view.container, "New thread with Linus").click()
		);
		expect(calls).toContain(
			'start:{"agentId":"agent-linus","teamId":"team-docs"}'
		);

		await act(async () =>
			buttonNamed(view.container, "Collapse Direct").click()
		);
		await settle(view.container, "thread:thread-triage");
		expect(hasNode(view.container, "thread:thread-triage")).toBe(false);
		expect(
			node(view.container, MINDMAP_DIRECT_ID).getAttribute("aria-expanded")
		).toBe("false");
		await act(async () =>
			buttonNamed(view.container, "Expand Direct (3 threads)").click()
		);
		expect(hasNode(view.container, "thread:thread-triage")).toBe(true);
		// No prompt is ever sent on the user's behalf.
		expect(calls.some((call) => call.includes("prompt"))).toBe(false);
		await view.dispose();
	});

	test("keyboard: arrows move, Space folds, Enter opens, + starts", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<MindmapInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const tree = buildMindmapTree(SNAPSHOT);
		const direct = tree.nodes.get(MINDMAP_DIRECT_ID);
		const outward = direct?.side === "left" ? "ArrowLeft" : "ArrowRight";
		const you = node(view.container, MINDMAP_ROOT_ID);
		expect(you.getAttribute("tabindex")).toBe("0");
		await act(async () => you.focus());

		// Walk to Direct → Grace → her most urgent thread.
		await press(you, outward);
		let guard = 0;
		while (focused() !== MINDMAP_DIRECT_ID && guard < 4) {
			const current = document.activeElement as HTMLElement;
			await press(current, "ArrowDown");
			guard += 1;
		}
		expect(focused()).toBe(MINDMAP_DIRECT_ID);
		await press(node(view.container, MINDMAP_DIRECT_ID), outward);
		expect(focused()).toBe("agent:group:direct:agent-grace");
		await press(node(view.container, "agent:group:direct:agent-grace"), "+");
		expect(calls).toContain('start:{"agentId":"agent-grace"}');
		await press(
			node(view.container, "agent:group:direct:agent-grace"),
			outward
		);
		expect(focused()).toBe("thread:thread-flaky");
		await press(node(view.container, "thread:thread-flaky"), "Enter");
		expect(calls).toContain("open:thread-flaky");

		// Space on the agent folds it; focus stays put.
		const grace = node(view.container, "agent:group:direct:agent-grace");
		await act(async () => grace.focus());
		await press(grace, " ");
		expect(grace.getAttribute("aria-expanded")).toBe("false");
		await settle(view.container, "thread:thread-flaky");
		expect(hasNode(view.container, "thread:thread-flaky")).toBe(false);
		await view.dispose();
	});

	test("docks the host's thread view and closes it with Escape", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<MindmapInterface
				activeThreadId="thread-triage"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div data-testid="host-thread">Host chat</div>}
			/>
		);
		const panel = view.container.querySelector(
			'[data-testid="mindmap-thread-panel"]'
		);
		expect(panel?.textContent).toContain("Crash triage");
		expect(panel?.textContent).toContain("Grace · Direct");
		expect(panel?.querySelector('[data-testid="host-thread"]') !== null).toBe(
			true
		);
		expect(
			node(view.container, "thread:thread-triage").getAttribute("aria-current")
		).toBe("true");
		await press(node(view.container, "thread:thread-triage"), "Escape");
		expect(calls).toContain("close");
		await view.dispose();
	});

	test("an opened thread inside a folded branch is unfolded into view", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<MindmapInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await act(async () =>
			buttonNamed(view.container, "Collapse Direct").click()
		);
		await settle(view.container, "thread:thread-flaky");
		expect(hasNode(view.container, "thread:thread-flaky")).toBe(false);
		await view.rerender(
			<MindmapInterface
				activeThreadId="thread-flaky"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div>Host chat</div>}
			/>
		);
		expect(
			node(view.container, "thread:thread-flaky").getAttribute("aria-selected")
		).toBe("true");
		await view.dispose();
	});
});
