import {
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Mind Map view model. Pure: it turns a snapshot into a balanced tree (You at
 * the centre, projects and teams plus "Direct" as first-level branches, then
 * agents, then threads as leaves) and lays that tree out left and right of
 * the centre, MindNode style. No React, no DOM, so every rule is testable.
 */

export const MINDMAP_ROOT_ID = "you";
export const MINDMAP_DIRECT_ID = "group:direct";
/** Leaves shown under one node before the rest fold into a "N more" leaf. */
export const MINDMAP_LEAF_LIMIT = 8;
/** Maps with more threads than this start with quiet agents folded. */
export const MINDMAP_FOLD_THRESHOLD = 48;

export type MindmapKind = "agent" | "group" | "more" | "root" | "thread";
export type MindmapSide = "left" | "right";
export type MindmapGroupKind = "direct" | "project" | "team";

export interface MindmapNode {
	/** The agent an agent node stands for. */
	agentId: string | null;
	/** Palette slot of the first-level branch the node grows from; -1 for You. */
	branch: number;
	childIds: string[];
	depth: number;
	/** The snapshot group id of the node's branch (null for Direct and You). */
	groupId: string | null;
	groupKind: MindmapGroupKind | null;
	/** For a "more" leaf: how many leaves it stands for. */
	hiddenCount: number;
	/** For a "more" leaf: the threads it stands for. */
	hiddenThreadIds: string[];
	id: string;
	kind: MindmapKind;
	label: string;
	parentId: string | null;
	side: MindmapSide | null;
	/** A thread leaf's status. */
	status: ThreadStatus | null;
	/** Threads in this node's subtree (all of them, including folded ones). */
	threadCount: number;
	threadId: string | null;
	/** Threads in the subtree that failed or wait on you. */
	urgentCount: number;
	/** An agent that is working, or a thread with a live run. */
	working: boolean;
}

export interface MindmapTree {
	nodes: Map<string, MindmapNode>;
	rootId: string;
}

export function isUrgent(status: ThreadStatus | null): boolean {
	return status === "attention" || status === "your-turn";
}

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/** Most urgent first, then pinned, then newest: the order leaves read in. */
export function compareThreads(a: InterfaceThread, b: InterfaceThread): number {
	const rank =
		THREAD_STATUS_ORDER.indexOf(threadStatus(a)) -
		THREAD_STATUS_ORDER.indexOf(threadStatus(b));
	return rank || Number(b.pinned) - Number(a.pinned) || byRecency(a, b);
}

interface BranchDraft {
	agentIds: string[];
	/** Threads filed under each agent of this branch. */
	byAgent: Map<string, InterfaceThread[]>;
	group: InterfaceGroup | null;
	id: string;
	kind: MindmapGroupKind;
	label: string;
	/** Threads that belong to the branch itself (several agents, or none). */
	loose: InterfaceThread[];
}

function newBranch(group: InterfaceGroup | null): BranchDraft {
	return {
		agentIds: [],
		byAgent: new Map(),
		group,
		id: group ? `group:${group.id}` : MINDMAP_DIRECT_ID,
		kind: group ? group.kind : "direct",
		label: group ? group.name.trim() || "Untitled" : "Direct",
		loose: [],
	};
}

function addAgent(branch: BranchDraft, agentId: string): void {
	if (!branch.byAgent.has(agentId)) {
		branch.byAgent.set(agentId, []);
		branch.agentIds.push(agentId);
	}
}

function homeBranch(
	thread: InterfaceThread,
	byGroupId: Map<string, BranchDraft>,
	direct: BranchDraft
): BranchDraft {
	const project = thread.projectId ? byGroupId.get(thread.projectId) : null;
	if (project?.kind === "project") {
		return project;
	}
	const team = thread.teamId ? byGroupId.get(thread.teamId) : null;
	if (team?.kind === "team") {
		return team;
	}
	return direct;
}

function latestUpdate(threads: readonly InterfaceThread[]): string {
	let latest = "";
	for (const thread of threads) {
		if (thread.updatedAt > latest) {
			latest = thread.updatedAt;
		}
	}
	return latest;
}

/** Agents with recent threads first; agents without threads by name. */
function orderAgents(
	branch: BranchDraft,
	agents: Map<string, InterfaceAgent>
): string[] {
	return [...branch.agentIds].sort((a, b) => {
		const latestA = latestUpdate(branch.byAgent.get(a) ?? []);
		const latestB = latestUpdate(branch.byAgent.get(b) ?? []);
		if (latestA !== latestB) {
			return latestB.localeCompare(latestA);
		}
		return (agents.get(a)?.name ?? a).localeCompare(agents.get(b)?.name ?? b);
	});
}

function draftBranches(snapshot: InterfaceSnapshot): BranchDraft[] {
	const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	const projects: BranchDraft[] = [];
	const teams: BranchDraft[] = [];
	const byGroupId = new Map<string, BranchDraft>();
	const grouped = new Set<string>();
	for (const group of snapshot.groups) {
		if (byGroupId.has(group.id)) {
			continue;
		}
		const branch = newBranch(group);
		byGroupId.set(group.id, branch);
		(group.kind === "project" ? projects : teams).push(branch);
		for (const agentId of group.memberAgentIds) {
			if (agents.has(agentId)) {
				addAgent(branch, agentId);
				grouped.add(agentId);
			}
		}
	}
	const direct = newBranch(null);
	for (const thread of snapshot.threads) {
		const branch = homeBranch(thread, byGroupId, direct);
		const known = thread.agentIds.filter((id) => agents.has(id));
		const lead = known[0];
		if (known.length === 1 && lead) {
			addAgent(branch, lead);
			branch.byAgent.get(lead)?.push(thread);
		} else {
			branch.loose.push(thread);
		}
	}
	// Everyone stays reachable: agents in no group live under Direct.
	for (const agent of snapshot.agents) {
		if (!grouped.has(agent.id)) {
			addAgent(direct, agent.id);
		}
	}
	const branches = [...projects, ...teams];
	if (direct.agentIds.length > 0 || direct.loose.length > 0) {
		branches.push(direct);
	}
	for (const branch of branches) {
		branch.agentIds = orderAgents(branch, agents);
	}
	return branches;
}

/** Rows a branch takes with everything unfolded (stable side balancing). */
function branchWeight(branch: BranchDraft): number {
	let rows = branch.loose.length;
	for (const agentId of branch.agentIds) {
		rows += Math.max(1, branch.byAgent.get(agentId)?.length ?? 0);
	}
	return Math.max(1, rows);
}

/**
 * Split first-level branches between the right and left of the centre so
 * both sides carry similar weight: heaviest first onto the lighter side,
 * ties to the right. Each side keeps the branches' natural order.
 */
export function assignSides(weights: readonly number[]): MindmapSide[] {
	const sides: MindmapSide[] = weights.map(() => "right");
	const order = weights
		.map((weight, index) => ({ index, weight }))
		.sort((a, b) => b.weight - a.weight || a.index - b.index);
	let right = 0;
	let left = 0;
	for (const { index, weight } of order) {
		if (right <= left) {
			sides[index] = "right";
			right += weight;
		} else {
			sides[index] = "left";
			left += weight;
		}
	}
	return sides;
}

interface NodeSeed {
	agentId?: string | null;
	groupId?: string | null;
	groupKind?: MindmapGroupKind | null;
	hiddenCount?: number;
	hiddenThreadIds?: string[];
	id: string;
	kind: MindmapKind;
	label: string;
	status?: ThreadStatus | null;
	threadCount?: number;
	threadId?: string | null;
	urgentCount?: number;
	working?: boolean;
}

function attach(
	nodes: Map<string, MindmapNode>,
	parent: MindmapNode,
	seed: NodeSeed
): MindmapNode {
	const node: MindmapNode = {
		agentId: seed.agentId ?? null,
		branch: parent.kind === "root" ? -1 : parent.branch,
		childIds: [],
		depth: parent.depth + 1,
		groupId: seed.groupId ?? parent.groupId,
		groupKind: seed.groupKind ?? parent.groupKind,
		hiddenCount: seed.hiddenCount ?? 0,
		hiddenThreadIds: seed.hiddenThreadIds ?? [],
		id: seed.id,
		kind: seed.kind,
		label: seed.label,
		parentId: parent.id,
		side: parent.side,
		status: seed.status ?? null,
		threadCount: seed.threadCount ?? 0,
		threadId: seed.threadId ?? null,
		urgentCount: seed.urgentCount ?? 0,
		working: seed.working ?? false,
	};
	nodes.set(node.id, node);
	parent.childIds.push(node.id);
	return node;
}

function attachThreads(
	nodes: Map<string, MindmapNode>,
	parent: MindmapNode,
	threads: readonly InterfaceThread[],
	showAll: ReadonlySet<string>
): void {
	const sorted = [...threads].sort(compareThreads);
	const limited = !showAll.has(parent.id) && sorted.length > MINDMAP_LEAF_LIMIT;
	// The "more" leaf takes the last slot, so the column never exceeds the limit.
	const shown = limited ? sorted.slice(0, MINDMAP_LEAF_LIMIT - 1) : sorted;
	for (const thread of shown) {
		const status = threadStatus(thread);
		attach(nodes, parent, {
			id: `thread:${thread.id}`,
			kind: "thread",
			label: thread.title.trim() || "Untitled thread",
			status,
			threadCount: 1,
			threadId: thread.id,
			urgentCount: isUrgent(status) ? 1 : 0,
			working: thread.running,
		});
	}
	if (limited) {
		const rest = sorted.slice(shown.length);
		attach(nodes, parent, {
			hiddenCount: rest.length,
			hiddenThreadIds: rest.map((thread) => thread.id),
			id: `more:${parent.id}`,
			kind: "more",
			label: `${rest.length} more`,
			threadCount: rest.length,
			urgentCount: rest.filter((thread) => isUrgent(threadStatus(thread)))
				.length,
		});
	}
	for (const thread of threads) {
		parent.threadCount += 1;
		parent.urgentCount += isUrgent(threadStatus(thread)) ? 1 : 0;
	}
}

/**
 * Build the map's tree. Each thread appears exactly once: under its project,
 * else its team, else Direct; under its agent when it has one agent, or on the
 * branch itself when it has several (a team thread) or none.
 * `showAll` lists node ids whose leaves are not folded into "N more".
 */
export function buildMindmapTree(
	snapshot: InterfaceSnapshot,
	showAll: ReadonlySet<string> = new Set()
): MindmapTree {
	const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	const nodes = new Map<string, MindmapNode>();
	const root: MindmapNode = {
		agentId: null,
		branch: -1,
		childIds: [],
		depth: 0,
		groupId: null,
		groupKind: null,
		hiddenCount: 0,
		hiddenThreadIds: [],
		id: MINDMAP_ROOT_ID,
		kind: "root",
		label: "You",
		parentId: null,
		side: null,
		status: null,
		threadCount: 0,
		threadId: null,
		urgentCount: 0,
		working: false,
	};
	nodes.set(root.id, root);
	const branches = draftBranches(snapshot);
	const sides = assignSides(branches.map(branchWeight));
	for (const [index, branch] of branches.entries()) {
		const groupNode = attach(nodes, root, {
			groupId: branch.group?.id ?? null,
			groupKind: branch.kind,
			id: branch.id,
			kind: "group",
			label: branch.label,
		});
		groupNode.branch = index;
		groupNode.side = sides[index] ?? "right";
		for (const agentId of branch.agentIds) {
			const agent = agents.get(agentId);
			const agentNode = attach(nodes, groupNode, {
				agentId,
				id: `agent:${branch.id}:${agentId}`,
				kind: "agent",
				label: agent?.name.trim() || "Agent",
				working: agent?.status === "working",
			});
			attachThreads(
				nodes,
				agentNode,
				branch.byAgent.get(agentId) ?? [],
				showAll
			);
			groupNode.threadCount += agentNode.threadCount;
			groupNode.urgentCount += agentNode.urgentCount;
			groupNode.working ||= agentNode.working;
		}
		attachThreads(nodes, groupNode, branch.loose, new Set());
		groupNode.working ||= branch.loose.some((thread) => thread.running);
		root.threadCount += groupNode.threadCount;
		root.urgentCount += groupNode.urgentCount;
	}
	return { nodes, rootId: root.id };
}

/** Folded state for a fresh map: big maps start with quiet agents folded. */
export function initialCollapsed(tree: MindmapTree): Set<string> {
	const root = tree.nodes.get(tree.rootId);
	const collapsed = new Set<string>();
	if (!root || root.threadCount <= MINDMAP_FOLD_THRESHOLD) {
		return collapsed;
	}
	for (const node of tree.nodes.values()) {
		if (
			node.kind === "agent" &&
			node.childIds.length > 0 &&
			node.urgentCount === 0 &&
			!node.working
		) {
			collapsed.add(node.id);
		}
	}
	return collapsed;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface MindmapSize {
	height: number;
	width: number;
}

/** Fixed row heights per kind; widths come from the label (or a measurement). */
export const MINDMAP_HEIGHT: Record<MindmapKind, number> = {
	agent: 28,
	group: 32,
	more: 24,
	root: 44,
	thread: 24,
};

/** Widest a thread leaf grows before its title truncates. */
export const MINDMAP_THREAD_MAX_WIDTH = 280;

/** Rough label widths before the DOM measures the real ones. */
export function estimateSize(node: MindmapNode): MindmapSize {
	const chars = node.label.length;
	const height = MINDMAP_HEIGHT[node.kind];
	switch (node.kind) {
		case "root":
			return { height, width: Math.round(40 + chars * 8.6) };
		case "group":
			return { height, width: Math.round(8 + chars * 8.4) };
		case "agent":
			return {
				height,
				width: Math.round(40 + chars * 7.9 + (node.working ? 14 : 0)),
			};
		case "thread": {
			const mark =
				node.status === "quiet" || node.status === "waiting" ? 0 : 14;
			return {
				height,
				width: Math.min(
					MINDMAP_THREAD_MAX_WIDTH,
					Math.round(8 + mark + chars * 7.4)
				),
			};
		}
		default:
			return { height, width: Math.round(8 + chars * 6.6) };
	}
}

/** Space between a parent's outer edge and its children, by child kind. */
const GAP_X: Record<MindmapKind, number> = {
	agent: 48,
	group: 88,
	more: 52,
	root: 0,
	thread: 52,
};

/** Space between sibling subtrees, by kind. */
const GAP_Y: Record<MindmapKind, number> = {
	agent: 22,
	group: 64,
	more: 8,
	root: 0,
	thread: 10,
};

/** Branch thickness where an edge starts and ends, by child depth. */
const TAPER: readonly [number, number][] = [
	[0, 0],
	[8, 3],
	[3, 2],
	[2, 1.25],
];

export interface MindmapPlaced extends MindmapSize {
	id: string;
	/** Left edge, world units (You is centred on the origin). */
	x: number;
	/** Top edge. */
	y: number;
}

export interface MindmapEdge {
	branch: number;
	childId: string;
	/** The same outline shrunk onto the parent's anchor: where it grows from. */
	collapsedPath: string;
	/** A filled, tapered outline: curve, then the child's underline if any. */
	path: string;
}

export interface MindmapPoint {
	x: number;
	y: number;
}

export interface MindmapBounds {
	maxX: number;
	maxY: number;
	minX: number;
	minY: number;
}

export interface MindmapLayout {
	bounds: MindmapBounds;
	edges: MindmapEdge[];
	/** Visible node ids in reading order (tree pre-order). */
	order: string[];
	placed: Map<string, MindmapPlaced>;
}

export type SizeOf = (node: MindmapNode) => MindmapSize;

/** Children shown on the map: none while folded. */
export function visibleChildren(
	tree: MindmapTree,
	node: MindmapNode,
	collapsed: ReadonlySet<string>
): MindmapNode[] {
	if (node.kind !== "root" && collapsed.has(node.id)) {
		return [];
	}
	const children: MindmapNode[] = [];
	for (const id of node.childIds) {
		const child = tree.nodes.get(id);
		if (child) {
			children.push(child);
		}
	}
	return children;
}

/** Labels sit on an underline (MindNode style) except You and agents. */
export function hasUnderline(kind: MindmapKind): boolean {
	return kind === "group" || kind === "thread" || kind === "more";
}

function blockHeights(
	tree: MindmapTree,
	collapsed: ReadonlySet<string>,
	sizeOf: SizeOf
): Map<string, number> {
	const heights = new Map<string, number>();
	const visit = (node: MindmapNode): number => {
		const children = visibleChildren(tree, node, collapsed);
		let stack = 0;
		for (const [index, child] of children.entries()) {
			stack += visit(child) + (index > 0 ? GAP_Y[child.kind] : 0);
		}
		const own = sizeOf(node).height;
		const height = Math.max(own, stack);
		heights.set(node.id, height);
		return height;
	};
	const root = tree.nodes.get(tree.rootId);
	if (root) {
		visit(root);
	}
	return heights;
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

const TAPER_STEPS = 16;

/**
 * A filled branch that tapers from `startWidth` to `endWidth` along a smooth
 * horizontal S-curve, then (for underlined labels) runs flat to `underlineTo`.
 * The outline offsets the curve along its normal, so steep stretches keep
 * their thickness. Same command count for every edge, so paths can morph.
 */
export function taperPath(
	start: MindmapPoint,
	end: MindmapPoint,
	startWidth: number,
	endWidth: number,
	underlineTo: number = end.x
): string {
	const midX = (start.x + end.x) / 2;
	const top: string[] = [];
	const bottom: string[] = [];
	for (let step = 0; step <= TAPER_STEPS; step++) {
		const t = step / TAPER_STEPS;
		const inverse = 1 - t;
		// Cubic Bézier with horizontal tangents at both ends.
		const x =
			inverse ** 3 * start.x +
			3 * inverse ** 2 * t * midX +
			3 * inverse * t ** 2 * midX +
			t ** 3 * end.x;
		const y =
			inverse ** 3 * start.y +
			3 * inverse ** 2 * t * start.y +
			3 * inverse * t ** 2 * end.y +
			t ** 3 * end.y;
		const dx =
			3 * inverse ** 2 * (midX - start.x) + 3 * t ** 2 * (end.x - midX);
		const dy = 6 * inverse * t * (end.y - start.y);
		const length = Math.hypot(dx, dy) || 1;
		const half = (startWidth + (endWidth - startWidth) * t ** 0.8) / 2;
		const normalX = (-dy / length) * half;
		const normalY = (dx / length) * half;
		top.push(`${round(x + normalX)} ${round(y + normalY)}`);
		bottom.push(`${round(x - normalX)} ${round(y - normalY)}`);
	}
	const half = endWidth / 2;
	bottom.reverse();
	return `M${top.join("L")}L${round(underlineTo)} ${round(end.y + (end.x <= start.x ? -half : half))}L${round(underlineTo)} ${round(end.y + (end.x <= start.x ? half : -half))}L${bottom.join("L")}Z`;
}

function anchorY(node: MindmapNode, placed: MindmapPlaced): number {
	if (hasUnderline(node.kind)) {
		return placed.y + placed.height - 1;
	}
	return placed.y + placed.height / 2;
}

/** Where branches leave a node toward its children. */
export function outerAnchor(
	node: MindmapNode,
	placed: MindmapPlaced,
	side: MindmapSide
): MindmapPoint {
	if (node.kind === "root") {
		// Start inside You, so thick roots tuck under the centre label.
		const inset = Math.min(16, placed.width / 4);
		return {
			x: side === "right" ? placed.x + placed.width - inset : placed.x + inset,
			y: placed.y + placed.height / 2,
		};
	}
	return {
		x: side === "right" ? placed.x + placed.width : placed.x,
		y: anchorY(node, placed),
	};
}

function innerAnchor(
	node: MindmapNode,
	placed: MindmapPlaced,
	side: MindmapSide
): MindmapPoint {
	return {
		x: side === "right" ? placed.x : placed.x + placed.width,
		y: anchorY(node, placed),
	};
}

/**
 * Lay the visible tree out: You centred on the origin, each side's branches
 * stacked around it, every subtree centred on its parent.
 */
export function layoutMindmap(
	tree: MindmapTree,
	collapsed: ReadonlySet<string>,
	sizeOf: SizeOf = estimateSize
): MindmapLayout {
	const placed = new Map<string, MindmapPlaced>();
	const edges: MindmapEdge[] = [];
	const order: string[] = [];
	const bounds: MindmapBounds = {
		maxX: Number.NEGATIVE_INFINITY,
		maxY: Number.NEGATIVE_INFINITY,
		minX: Number.POSITIVE_INFINITY,
		minY: Number.POSITIVE_INFINITY,
	};
	const root = tree.nodes.get(tree.rootId);
	if (!root) {
		return {
			bounds: { maxX: 0, maxY: 0, minX: 0, minY: 0 },
			edges,
			order,
			placed,
		};
	}
	const heights = blockHeights(tree, collapsed, sizeOf);
	const grow = (box: MindmapPlaced) => {
		bounds.minX = Math.min(bounds.minX, box.x);
		bounds.minY = Math.min(bounds.minY, box.y);
		bounds.maxX = Math.max(bounds.maxX, box.x + box.width);
		bounds.maxY = Math.max(bounds.maxY, box.y + box.height);
	};
	const rootSize = sizeOf(root);
	const rootBox: MindmapPlaced = {
		...rootSize,
		id: root.id,
		x: -rootSize.width / 2,
		y: -rootSize.height / 2,
	};
	placed.set(root.id, rootBox);
	order.push(root.id);
	grow(rootBox);

	const placeChildren = (
		parent: MindmapNode,
		children: readonly MindmapNode[],
		side: MindmapSide
	) => {
		const parentBox = placed.get(parent.id);
		if (!parentBox || children.length === 0) {
			return;
		}
		const from = outerAnchor(parent, parentBox, side);
		let total = 0;
		for (const [index, child] of children.entries()) {
			total +=
				(heights.get(child.id) ?? 0) + (index > 0 ? GAP_Y[child.kind] : 0);
		}
		let cursor = parentBox.y + parentBox.height / 2 - total / 2;
		for (const [index, child] of children.entries()) {
			if (index > 0) {
				cursor += GAP_Y[child.kind];
			}
			const block = heights.get(child.id) ?? 0;
			const size = sizeOf(child);
			const edgeX =
				side === "right"
					? parentBox.x + parentBox.width + GAP_X[child.kind]
					: parentBox.x - GAP_X[child.kind];
			const box: MindmapPlaced = {
				...size,
				id: child.id,
				x: side === "right" ? edgeX : edgeX - size.width,
				y: cursor + block / 2 - size.height / 2,
			};
			placed.set(child.id, box);
			order.push(child.id);
			grow(box);
			const to = innerAnchor(child, box, side);
			const [startWidth, endWidth] = TAPER[Math.min(child.depth, 3)] ?? [2, 1];
			const underlineTo = hasUnderline(child.kind)
				? outerAnchor(child, box, side).x
				: to.x;
			edges.push({
				branch: child.branch,
				childId: child.id,
				collapsedPath: taperPath(from, from, 0, 0, from.x),
				path: taperPath(from, to, startWidth, endWidth, underlineTo),
			});
			placeChildren(child, visibleChildren(tree, child, collapsed), side);
			cursor += block;
		}
	};

	const rootChildren = visibleChildren(tree, root, collapsed);
	placeChildren(
		root,
		rootChildren.filter((child) => child.side !== "left"),
		"right"
	);
	placeChildren(
		root,
		rootChildren.filter((child) => child.side === "left"),
		"left"
	);
	return { bounds, edges, order, placed };
}

// ---------------------------------------------------------------------------
// View (pan and zoom)
// ---------------------------------------------------------------------------

export interface MindmapView {
	/** Scale. */
	k: number;
	/** Screen offset of the world origin. */
	x: number;
	y: number;
}

export const MINDMAP_MIN_ZOOM = 0.25;
export const MINDMAP_MAX_ZOOM = 2;

export function clampZoom(k: number): number {
	return Math.min(MINDMAP_MAX_ZOOM, Math.max(MINDMAP_MIN_ZOOM, k));
}

/**
 * Frame the whole map, never above `maxZoom` (100% unless the caller lets a
 * small map grow into the window), centred in the viewport. `minZoom` lets
 * automatic framing keep labels legible (the map may then overflow).
 */
export function fitView(
	bounds: MindmapBounds,
	viewport: MindmapSize,
	minZoom = MINDMAP_MIN_ZOOM,
	padding = 56,
	maxZoom = 1
): MindmapView {
	const width = Math.max(1, bounds.maxX - bounds.minX);
	const height = Math.max(1, bounds.maxY - bounds.minY);
	const k = clampZoom(
		Math.max(
			minZoom,
			Math.min(
				maxZoom,
				(viewport.width - padding * 2) / width,
				(viewport.height - padding * 2) / height
			)
		)
	);
	return {
		k,
		x: viewport.width / 2 - (bounds.minX + width / 2) * k,
		y: viewport.height / 2 - (bounds.minY + height / 2) * k,
	};
}

/** Zoom by `factor` keeping the screen point `at` fixed. */
export function zoomAt(
	view: MindmapView,
	factor: number,
	at: MindmapPoint
): MindmapView {
	const k = clampZoom(view.k * factor);
	const ratio = k / view.k;
	return {
		k,
		x: at.x - (at.x - view.x) * ratio,
		y: at.y - (at.y - view.y) * ratio,
	};
}

/** The smallest pan that brings `box` inside the viewport (with a margin). */
export function revealBox(
	view: MindmapView,
	box: MindmapPlaced,
	viewport: MindmapSize,
	margin = 48
): MindmapView {
	const left = view.x + box.x * view.k;
	const top = view.y + box.y * view.k;
	const right = left + box.width * view.k;
	const bottom = top + box.height * view.k;
	let dx = 0;
	let dy = 0;
	if (left < margin) {
		dx = margin - left;
	} else if (right > viewport.width - margin) {
		dx = Math.max(viewport.width - margin - right, margin - left);
	}
	if (top < margin) {
		dy = margin - top;
	} else if (bottom > viewport.height - margin) {
		dy = Math.max(viewport.height - margin - bottom, margin - top);
	}
	if (dx === 0 && dy === 0) {
		return view;
	}
	return { k: view.k, x: view.x + dx, y: view.y + dy };
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

export type MindmapMove =
	| { kind: "expand"; id: string }
	| { kind: "focus"; id: string };

function centreY(box: MindmapPlaced): number {
	return box.y + box.height / 2;
}

function closestByY(
	ids: readonly string[],
	layout: MindmapLayout,
	targetY: number
): string | null {
	let best: string | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const id of ids) {
		const box = layout.placed.get(id);
		if (!box) {
			continue;
		}
		const distance = Math.abs(centreY(box) - targetY);
		if (distance < bestDistance) {
			best = id;
			bestDistance = distance;
		}
	}
	return best;
}

function verticalNeighbour(
	tree: MindmapTree,
	layout: MindmapLayout,
	node: MindmapNode,
	direction: -1 | 1
): string | null {
	const from = layout.placed.get(node.id);
	if (!from) {
		return null;
	}
	const y = centreY(from);
	let best: string | null = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const id of layout.order) {
		const other = tree.nodes.get(id);
		const box = layout.placed.get(id);
		if (
			!(other && box) ||
			other.id === node.id ||
			other.depth !== node.depth ||
			other.side !== node.side
		) {
			continue;
		}
		const dy = (centreY(box) - y) * direction;
		if (dy <= 0) {
			continue;
		}
		// Prefer siblings, then the nearest row at the same depth.
		const score = dy + (other.parentId === node.parentId ? 0 : 10_000);
		if (score < bestScore) {
			best = id;
			bestScore = score;
		}
	}
	return best;
}

/**
 * Arrow keys follow the map: outward goes to a child (unfolding a folded
 * node first), inward to the parent, up and down to the neighbour at the same
 * level. On You, left and right pick a side.
 */
export function moveFocus(
	tree: MindmapTree,
	layout: MindmapLayout,
	collapsed: ReadonlySet<string>,
	fromId: string,
	key: string
): MindmapMove | null {
	const node = tree.nodes.get(fromId);
	if (!node) {
		return null;
	}
	if (key === "Home") {
		return { id: tree.rootId, kind: "focus" };
	}
	if (key === "ArrowUp" || key === "ArrowDown") {
		const next = verticalNeighbour(
			tree,
			layout,
			node,
			key === "ArrowUp" ? -1 : 1
		);
		return next ? { id: next, kind: "focus" } : null;
	}
	if (key !== "ArrowLeft" && key !== "ArrowRight") {
		return null;
	}
	const pressed: MindmapSide = key === "ArrowRight" ? "right" : "left";
	const box = layout.placed.get(node.id);
	if (node.kind === "root") {
		const children = visibleChildren(tree, node, collapsed)
			.filter((child) => child.side === pressed)
			.map((child) => child.id);
		const next = closestByY(children, layout, box ? centreY(box) : 0);
		return next ? { id: next, kind: "focus" } : null;
	}
	if (pressed !== node.side) {
		return node.parentId ? { id: node.parentId, kind: "focus" } : null;
	}
	if (node.childIds.length === 0) {
		return null;
	}
	if (collapsed.has(node.id)) {
		return { id: node.id, kind: "expand" };
	}
	const next = closestByY(node.childIds, layout, box ? centreY(box) : 0);
	return next ? { id: next, kind: "focus" } : null;
}

/** The nearest ancestor still on the map (folding hides descendants). */
export function visibleAncestor(
	tree: MindmapTree,
	layout: MindmapLayout,
	id: string
): string {
	let current = tree.nodes.get(id);
	while (current && !layout.placed.has(current.id)) {
		current = current.parentId ? tree.nodes.get(current.parentId) : undefined;
	}
	return current?.id ?? tree.rootId;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

const GROUP_KIND_LABEL: Record<MindmapGroupKind, string> = {
	direct: "Direct threads",
	project: "Project",
	team: "Team",
};

export function groupKindLabel(kind: MindmapGroupKind | null): string {
	return kind ? GROUP_KIND_LABEL[kind] : "";
}

export interface MindmapStats {
	agents: number;
	needYou: number;
	threads: number;
	working: number;
}

export function mindmapStats(snapshot: InterfaceSnapshot): MindmapStats {
	let needYou = 0;
	let working = 0;
	for (const thread of snapshot.threads) {
		const status = threadStatus(thread);
		if (isUrgent(status)) {
			needYou += 1;
		}
		if (status === "working") {
			working += 1;
		}
	}
	return {
		agents: snapshot.agents.length,
		needYou,
		threads: snapshot.threads.length,
		working,
	};
}
