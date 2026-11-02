import { translate as tr } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

export {
	estimateSize,
	hasUnderline,
	layoutMindmap,
	MINDMAP_HEIGHT,
	MINDMAP_THREAD_MAX_WIDTH,
	type MindmapBounds,
	type MindmapEdge,
	type MindmapLayout,
	type MindmapPlaced,
	type MindmapPoint,
	type MindmapSize,
	outerAnchor,
	type SizeOf,
	taperPath,
	visibleChildren,
} from "./mindmap-model-layout.ts";
export {
	clampZoom,
	fitView,
	MINDMAP_MAX_ZOOM,
	MINDMAP_MIN_ZOOM,
	type MindmapMove,
	type MindmapView,
	moveFocus,
	revealBox,
	visibleAncestor,
	zoomAt,
} from "./mindmap-model-view.ts";

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
		label: group ? group.name.trim() || tr("Untitled") : tr("Direct"),
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
			label: thread.title.trim() || tr("Untitled thread"),
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
			label: tr("{count} more", { count: rest.length }),
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
		label: tr("You"),
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
				label: agent?.name.trim() || tr("Agent"),
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
// Words
// ---------------------------------------------------------------------------

/** A group kind's label in the UI language ("" for none). */
export function groupKindLabel(
	kind: MindmapGroupKind | null,
	tl: LiteralMessage = tr
): string {
	switch (kind) {
		case "direct":
			return tl("Direct threads");
		case "project":
			return tl("Project");
		case "team":
			return tl("Team");
		default:
			return "";
	}
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
