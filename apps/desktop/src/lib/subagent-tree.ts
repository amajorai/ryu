// apps/desktop/src/lib/subagent-tree.ts
//
// The nest a thread sits in, as one tree: the root thread and every session
// spawned below it. Core sends the rows flat with a parent link
// (`GET /api/hierarchy/threads/:id/tree`); this builder nests them and
// flattens them again into the indented rows a list draws. It trusts nothing
// about the order or the links: a repeated id is dropped, and a row whose
// parent is missing, is itself, or would close a loop becomes a root.

import type {
	SessionSummary,
	ThreadTreeNode,
} from "@/src/lib/api/hierarchy.ts";

/** What a node stands for: a main thread, or a session spawned from one. */
export type SubagentTreeKind = "thread" | "session";

export interface SubagentTreeNode {
	agentId: string | null;
	/** The agent's display name, when the resolver knows it. */
	agentName?: string;
	/** Sessions this node spawned, in the order Core sent them. */
	children: SubagentTreeNode[];
	/** The conversation a click opens. */
	conversationId: string;
	id: string;
	kind: SubagentTreeKind;
	/** Null for a root. */
	parentId: string | null;
	/** Core's run status ("running", "failed", ...), or null with none. */
	status: string | null;
	title: string | null;
	updatedAt: number;
}

/** One line of the indented list. */
export interface SubagentTreeRow {
	/** 0 for a root, 1 for what it spawned, and so on. */
	depth: number;
	/** False while the node's children are folded away. */
	expanded: boolean;
	hasChildren: boolean;
	node: SubagentTreeNode;
}

/** Whether following parent links up from `start` reaches `id`. */
function reaches(
	start: SubagentTreeNode,
	id: string,
	byId: ReadonlyMap<string, SubagentTreeNode>
): boolean {
	let current: SubagentTreeNode | undefined = start;
	for (let hops = 0; current && hops <= byId.size; hops += 1) {
		if (current.id === id) {
			return true;
		}
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return false;
}

/**
 * Nest Core's flat rows. Returns the roots: one for a whole tree, several when
 * the caller may not see the thread that joins them.
 */
export function buildSubagentTree(
	nodes: readonly ThreadTreeNode[],
	agentName: (id: string) => string | undefined = () => undefined
): SubagentTreeNode[] {
	const byId = new Map<string, SubagentTreeNode>();
	for (const { conversation, parent_id: parentId } of nodes) {
		if (byId.has(conversation.id)) {
			continue;
		}
		const agentId = conversation.agent_id;
		byId.set(conversation.id, {
			agentId,
			agentName: agentId ? agentName(agentId) : undefined,
			children: [],
			conversationId: conversation.id,
			id: conversation.id,
			kind:
				conversation.thread_role === "main" || !parentId ? "thread" : "session",
			parentId: parentId ?? null,
			status: conversation.run_status,
			title: conversation.title,
			updatedAt: conversation.updated_at,
		});
	}
	const roots: SubagentTreeNode[] = [];
	for (const node of byId.values()) {
		const parent = node.parentId ? byId.get(node.parentId) : undefined;
		if (parent && !reaches(parent, node.id, byId)) {
			parent.children.push(node);
		} else {
			node.parentId = null;
			roots.push(node);
		}
	}
	return roots;
}

/**
 * The one-level tree an older Core can still give: the thread itself and the
 * sessions it spawned (`/sessions`), for a node without the tree route.
 */
export function treeFromSessions(
	root: SessionSummary,
	sessions: readonly SessionSummary[]
): ThreadTreeNode[] {
	return [
		{ conversation: root, parent_id: null },
		...sessions
			.filter((session) => session.id !== root.id)
			.map((session) => ({ conversation: session, parent_id: root.id })),
	];
}

/**
 * The tree as indented rows, top down, parents before their children. The
 * children of a node in `collapsed` are left out.
 */
export function flattenSubagentTree(
	roots: readonly SubagentTreeNode[],
	collapsed: ReadonlySet<string> = new Set()
): SubagentTreeRow[] {
	const rows: SubagentTreeRow[] = [];
	const visit = (node: SubagentTreeNode, depth: number) => {
		const hasChildren = node.children.length > 0;
		const expanded = hasChildren && !collapsed.has(node.id);
		rows.push({ depth, expanded, hasChildren, node });
		if (expanded) {
			for (const child of node.children) {
				visit(child, depth + 1);
			}
		}
	};
	for (const root of roots) {
		visit(root, 0);
	}
	return rows;
}
