import { translate as tr } from "@ryu/i18n/lite";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { extractTopics, type TopicOptions } from "./knowledge-model-topics.ts";

export {
	createLayout,
	hashString,
	isSettled,
	type Layout,
	layoutBounds,
	positionOf,
	reheat,
	replayLayout,
	settleLayout,
	statusCounts,
	stepLayout,
	type Vec3,
	warmTicks,
} from "./knowledge-model-layout.ts";
export {
	DEFAULT_SETTINGS,
	type ForceSettings,
	type KnowledgeSettings,
	nodeRadius,
	sameSettings,
	settingsFromParams,
} from "./knowledge-model-settings.ts";
export {
	extractTopics,
	MAX_TOPICS,
	type Topic,
	type TopicOptions,
	topicWords,
} from "./knowledge-model-topics.ts";

/**
 * Knowledge: the workspace as an Obsidian-style graph. This file is the pure
 * half (no React, no DOM): it turns a snapshot into typed nodes and links,
 * extracts topics from conversation titles, applies the controls panel's
 * filters (type toggles, orphans, local graph depth), matches search, and
 * runs the force layout both renderers share.
 */

export type KnowledgeNodeKind =
	| "agent"
	| "conversation"
	| "project"
	| "team"
	| "topic";

export type KnowledgeLinkKind = "filed" | "member" | "participant" | "topic";

export interface KnowledgeNode {
	/** Links in the full graph (before filters). */
	degree: number;
	id: string;
	kind: KnowledgeNodeKind;
	label: string;
	/** Id of the agent, group, thread, or the topic word. */
	refId: string;
	/** Conversation status; null for every other kind. */
	status: ThreadStatus | null;
	/** Conversation message count, else 0. */
	weight: number;
}

export interface KnowledgeLink {
	id: string;
	kind: KnowledgeLinkKind;
	/** Topic links only: the conversation names the topic in its latest message, not its title. */
	message?: boolean;
	source: string;
	target: string;
}

export interface KnowledgeGraph {
	links: KnowledgeLink[];
	nodes: KnowledgeNode[];
}

/** The order node kinds are listed in (accessible list, keyboard cycling). */
export const KIND_ORDER: readonly KnowledgeNodeKind[] = [
	"agent",
	"project",
	"team",
	"topic",
	"conversation",
];

export const KIND_LABELS: Record<KnowledgeNodeKind, string> = {
	agent: "Agent",
	conversation: "Conversation",
	project: "Project",
	team: "Team",
	topic: "Topic",
};

/** A node kind's label in the UI language, for copy that interpolates it. */
export function kindLabel(kind: KnowledgeNodeKind): string {
	switch (kind) {
		case "agent":
			return tr("Agent");
		case "conversation":
			return tr("Conversation");
		case "project":
			return tr("Project");
		case "team":
			return tr("Team");
		default:
			return tr("Topic");
	}
}

export const nodeId = {
	agent: (id: string) => `agent:${id}`,
	conversation: (id: string) => `thread:${id}`,
	project: (id: string) => `project:${id}`,
	team: (id: string) => `team:${id}`,
	topic: (word: string) => `topic:${word}`,
} as const;

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/** The whole workspace graph: every node and link, before any filter. */
export function buildKnowledgeGraph(
	snapshot: InterfaceSnapshot,
	options: TopicOptions = {}
): KnowledgeGraph {
	const nodes = new Map<string, KnowledgeNode>();
	const links: KnowledgeLink[] = [];
	const add = (node: Omit<KnowledgeNode, "degree">) => {
		nodes.set(node.id, { ...node, degree: 0 });
	};
	const link = (
		kind: KnowledgeLinkKind,
		source: string,
		target: string,
		message = false
	) => {
		const from = nodes.get(source);
		const to = nodes.get(target);
		if (!(from && to) || source === target) {
			return;
		}
		from.degree += 1;
		to.degree += 1;
		links.push({
			id: `${source}>${target}`,
			kind,
			source,
			target,
			...(message ? { message } : {}),
		});
	};

	for (const agent of snapshot.agents) {
		add({
			id: nodeId.agent(agent.id),
			kind: "agent",
			label: agent.name,
			refId: agent.id,
			status: null,
			weight: 0,
		});
	}
	for (const group of snapshot.groups) {
		add({
			id: nodeId[group.kind](group.id),
			kind: group.kind,
			label: group.name,
			refId: group.id,
			status: null,
			weight: 0,
		});
	}
	for (const thread of snapshot.threads) {
		add({
			id: nodeId.conversation(thread.id),
			kind: "conversation",
			label: thread.title.trim() || tr("Untitled conversation"),
			refId: thread.id,
			status: threadStatus(thread),
			weight: thread.messageCount,
		});
	}
	const topics = extractTopics(snapshot.threads, options);
	for (const topic of topics) {
		add({
			id: nodeId.topic(topic.word),
			kind: "topic",
			label: topic.word,
			refId: topic.word,
			status: null,
			weight: topic.threadIds.length,
		});
	}

	for (const group of snapshot.groups) {
		if (group.kind !== "team") {
			continue;
		}
		for (const agentId of new Set(group.memberAgentIds)) {
			link("member", nodeId.agent(agentId), nodeId.team(group.id));
		}
	}
	for (const thread of snapshot.threads) {
		const conversation = nodeId.conversation(thread.id);
		for (const agentId of new Set(thread.agentIds)) {
			link("participant", conversation, nodeId.agent(agentId));
		}
		if (thread.projectId) {
			link("filed", conversation, nodeId.project(thread.projectId));
		}
		if (thread.teamId) {
			link("filed", conversation, nodeId.team(thread.teamId));
		}
	}
	for (const topic of topics) {
		const viaMessage = new Set(topic.messageIds);
		for (const threadId of topic.threadIds) {
			link(
				"topic",
				nodeId.conversation(threadId),
				nodeId.topic(topic.word),
				viaMessage.has(threadId)
			);
		}
	}
	return { links, nodes: [...nodes.values()] };
}

export type Adjacency = Map<string, Set<string>>;

export function adjacency(links: readonly KnowledgeLink[]): Adjacency {
	const map: Adjacency = new Map();
	const touch = (from: string, to: string) => {
		const set = map.get(from) ?? new Set<string>();
		set.add(to);
		map.set(from, set);
	};
	for (const link of links) {
		touch(link.source, link.target);
		touch(link.target, link.source);
	}
	return map;
}

/** `id` and everything within `depth` links of it. */
export function neighbourhood(
	links: Adjacency,
	id: string,
	depth: number
): Set<string> {
	const seen = new Set([id]);
	let frontier = [id];
	for (let step = 0; step < depth; step += 1) {
		const next: string[] = [];
		for (const current of frontier) {
			for (const neighbour of links.get(current) ?? []) {
				if (!seen.has(neighbour)) {
					seen.add(neighbour);
					next.push(neighbour);
				}
			}
		}
		frontier = next;
	}
	return seen;
}

export interface KnowledgeFilters {
	agents: boolean;
	conversations: boolean;
	/** Groups: projects and teams. */
	groups: boolean;
	/** Local graph: only nodes within `depth` links of this node. */
	local: { depth: number; id: string } | null;
	orphans: boolean;
	topics: boolean;
}

function kindShown(kind: KnowledgeNodeKind, filters: KnowledgeFilters) {
	switch (kind) {
		case "agent":
			return filters.agents;
		case "conversation":
			return filters.conversations;
		case "topic":
			return filters.topics;
		default:
			return filters.groups;
	}
}

/**
 * The part of the graph the controls panel lets through: hidden kinds go
 * (with their links), the local graph keeps only the neighbourhood of its
 * centre, and orphans (no remaining links) go unless asked for.
 */
export function filterGraph(
	graph: KnowledgeGraph,
	filters: KnowledgeFilters
): KnowledgeGraph {
	let kept = new Set(
		graph.nodes
			.filter((node) => kindShown(node.kind, filters))
			.map((node) => node.id)
	);
	let links = graph.links.filter(
		(link) => kept.has(link.source) && kept.has(link.target)
	);
	const center = filters.local?.id;
	if (filters.local && center && kept.has(center)) {
		kept = neighbourhood(adjacency(links), center, filters.local.depth);
		links = links.filter(
			(link) => kept.has(link.source) && kept.has(link.target)
		);
	}
	if (!filters.orphans) {
		const linked = new Set<string>();
		for (const link of links) {
			linked.add(link.source);
			linked.add(link.target);
		}
		kept = new Set([...kept].filter((id) => linked.has(id) || id === center));
	}
	return {
		links,
		nodes: graph.nodes.filter((node) => kept.has(node.id)),
	};
}

/**
 * Display label. Topics are extracted, not user-authored tags, so they read
 * as plain words (the colour and the "Topic" kind tell them apart).
 */
export function displayLabel(node: Pick<KnowledgeNode, "kind" | "label">) {
	return node.label;
}

/** Ids of nodes whose label contains the query (case-insensitive). */
export function searchNodes(
	nodes: readonly KnowledgeNode[],
	query: string
): Set<string> {
	const needle = query.trim().toLowerCase().replace(/^#/, "");
	if (!needle) {
		return new Set();
	}
	return new Set(
		nodes
			.filter((node) => node.label.toLowerCase().includes(needle))
			.map((node) => node.id)
	);
}

/** Nodes in list order: by kind, then busiest first, then by label. */
export function orderNodes(nodes: readonly KnowledgeNode[]): KnowledgeNode[] {
	return [...nodes].sort(
		(a, b) =>
			KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
			b.degree - a.degree ||
			a.label.localeCompare(b.label)
	);
}

/** The next node for arrow-key cycling, wrapping at both ends. */
export function cycleNode(
	ordered: readonly KnowledgeNode[],
	current: string | null,
	step: 1 | -1
): string | null {
	if (ordered.length === 0) {
		return null;
	}
	const index = ordered.findIndex((node) => node.id === current);
	if (index === -1) {
		return (step === 1 ? ordered[0] : ordered.at(-1))?.id ?? null;
	}
	const next = (index + step + ordered.length) % ordered.length;
	return ordered[next]?.id ?? null;
}

/** Threads linked to a node, newest first (a conversation links to itself). */
/** Conversations linked to a topic only through their latest message. */
export function messageMentions(
	graph: KnowledgeGraph,
	topicId: string
): Set<string> {
	const ids = new Set<string>();
	for (const link of graph.links) {
		if (link.message && link.target === topicId) {
			ids.add(link.source.slice("thread:".length));
		}
	}
	return ids;
}

export function linkedThreads(
	snapshot: InterfaceSnapshot,
	graph: KnowledgeGraph,
	id: string
): InterfaceThread[] {
	const ids = new Set<string>();
	for (const link of graph.links) {
		const other =
			(link.source === id && link.target) ||
			(link.target === id && link.source) ||
			null;
		if (other?.startsWith("thread:")) {
			ids.add(other.slice("thread:".length));
		}
	}
	return snapshot.threads
		.filter((thread) => ids.has(thread.id))
		.sort(
			(a, b) =>
				b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
		);
}

/** Linked nodes that are not conversations, ordered like the node list. */
export function linkedEntities(
	graph: KnowledgeGraph,
	id: string
): KnowledgeNode[] {
	const neighbours = adjacency(graph.links).get(id) ?? new Set<string>();
	return orderNodes(
		graph.nodes.filter(
			(node) => neighbours.has(node.id) && node.kind !== "conversation"
		)
	);
}

/** "3 links", "1 member": a count of one of the map's nouns, as an ICU message. */
export function countOf(
	count: number,
	noun: "conversation" | "link" | "member" | "node"
): string {
	switch (noun) {
		case "conversation":
			return tr(
				"{count, plural, one {# conversation} other {# conversations}}",
				{ count }
			);
		case "link":
			return tr("{count, plural, one {# link} other {# links}}", {
				count,
			});
		case "member":
			return tr("{count, plural, one {# member} other {# members}}", {
				count,
			});
		default:
			return tr("{count, plural, one {# node} other {# nodes}}", {
				count,
			});
	}
}
