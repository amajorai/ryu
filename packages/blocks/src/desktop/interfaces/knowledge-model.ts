import {
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

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

export const nodeId = {
	agent: (id: string) => `agent:${id}`,
	conversation: (id: string) => `thread:${id}`,
	project: (id: string) => `project:${id}`,
	team: (id: string) => `team:${id}`,
	topic: (word: string) => `topic:${word}`,
} as const;

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

const MIN_TOPIC_LETTERS = 4;
const MIN_TOPIC_THREADS = 2;
/** Most topics kept, by reach, so a large workspace stays readable. */
export const MAX_TOPICS = 40;

/** Common words of four or more letters that never make a useful topic. */
const STOPWORDS = new Set([
	"about",
	"after",
	"again",
	"also",
	"been",
	"before",
	"being",
	"best",
	"could",
	"does",
	"done",
	"each",
	"from",
	"have",
	"here",
	"into",
	"just",
	"like",
	"make",
	"more",
	"most",
	"much",
	"need",
	"next",
	"only",
	"onto",
	"other",
	"over",
	"please",
	"same",
	"should",
	"some",
	"still",
	"such",
	"than",
	"that",
	"their",
	"them",
	"then",
	"there",
	"these",
	"they",
	"thing",
	"things",
	"this",
	"those",
	"through",
	"today",
	"under",
	"upon",
	"very",
	"want",
	"were",
	"what",
	"when",
	"where",
	"which",
	"while",
	"will",
	"with",
	"within",
	"without",
	"would",
	"your",
]);

/** Lower-cased words of at least four letters, in order. */
export function topicWords(text: string): string[] {
	const words: string[] = [];
	for (const match of text.toLowerCase().matchAll(/\p{L}+/gu)) {
		const word = match[0];
		if (word.length >= MIN_TOPIC_LETTERS && !STOPWORDS.has(word)) {
			words.push(word);
		}
	}
	return words;
}

export interface Topic {
	/** Conversations that mention the topic only in their latest message. */
	messageIds: string[];
	threadIds: string[];
	word: string;
}

export interface TopicOptions {
	/**
	 * Also link conversations whose latest message (not only their title)
	 * mentions a title word. Off by default: topics come from titles.
	 */
	messages?: boolean;
}

/**
 * Topics, deterministically: a topic is a lower-cased word of four or more
 * letters (not a stopword) that appears in the titles of two or more
 * conversations, and it links every conversation whose title contains it.
 * Words match literally. With `messages`, a conversation whose latest
 * message contains a title word counts too; `messageIds` records those, so
 * the panel can say why. Sorted by reach, then alphabetically.
 */
export function extractTopics(
	threads: readonly InterfaceThread[],
	options: TopicOptions = {}
): Topic[] {
	const candidates = new Set<string>();
	for (const thread of threads) {
		for (const word of topicWords(thread.title)) {
			candidates.add(word);
		}
	}
	const mentions = new Map<string, string[]>();
	const viaMessage = new Map<string, string[]>();
	const record = (
		map: Map<string, string[]>,
		form: string,
		threadId: string
	) => {
		const list = map.get(form) ?? [];
		list.push(threadId);
		map.set(form, list);
	};
	for (const thread of threads) {
		const inTitle = new Set(topicWords(thread.title));
		const seen = new Set<string>();
		for (const form of inTitle) {
			seen.add(form);
			record(mentions, form, thread.id);
		}
		const message = options.messages ? (thread.lastMessage ?? "") : "";
		for (const word of topicWords(message)) {
			if (candidates.has(word) && !seen.has(word)) {
				seen.add(word);
				record(mentions, word, thread.id);
				record(viaMessage, word, thread.id);
			}
		}
	}
	const topics: Topic[] = [];
	for (const [word, threadIds] of mentions) {
		if (threadIds.length >= MIN_TOPIC_THREADS) {
			topics.push({ messageIds: viaMessage.get(word) ?? [], threadIds, word });
		}
	}
	topics.sort(
		(a, b) =>
			b.threadIds.length - a.threadIds.length || a.word.localeCompare(b.word)
	);
	return topics.slice(0, MAX_TOPICS);
}

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
			label: thread.title.trim() || "Untitled conversation",
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

export function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface KnowledgeSettings {
	agents: boolean;
	/** Center force, 0..1. */
	centerForce: number;
	conversations: boolean;
	depth: 1 | 2;
	groups: boolean;
	/** Link distance in world units. */
	linkDistance: number;
	/** Link force, 0..1. */
	linkForce: number;
	/** Link thickness in CSS pixels. */
	linkWidth: number;
	/**
	 * Topics also link conversations whose latest message contains a title
	 * word. Off by default: topics come from titles alone.
	 */
	messages: boolean;
	mode: "global" | "local";
	/** Node size multiplier. */
	nodeSize: number;
	orphans: boolean;
	/** Repel force, 0..1. */
	repelForce: number;
	/** Text fade threshold, 0..1: higher keeps labels until zoomed further out. */
	textFade: number;
	topics: boolean;
}

export const DEFAULT_SETTINGS: KnowledgeSettings = {
	agents: true,
	centerForce: 0.5,
	conversations: true,
	depth: 1,
	groups: true,
	linkDistance: 30,
	linkForce: 0.6,
	linkWidth: 1,
	messages: false,
	mode: "global",
	nodeSize: 1,
	orphans: true,
	repelForce: 0.5,
	textFade: 0.5,
	topics: true,
};

/**
 * The panel's settings from the interface's live params (any missing key at
 * its default), so a choice saved through `updateSettings` comes back.
 */
export function settingsFromParams(
	params: Partial<Record<keyof KnowledgeSettings, unknown>> | undefined
): KnowledgeSettings {
	const out: KnowledgeSettings = { ...DEFAULT_SETTINGS };
	for (const key of Object.keys(
		DEFAULT_SETTINGS
	) as (keyof KnowledgeSettings)[]) {
		const value = params?.[key];
		if (typeof value === typeof DEFAULT_SETTINGS[key]) {
			(out as unknown as Record<string, unknown>)[key] = value;
		}
	}
	out.depth = out.depth === 2 ? 2 : 1;
	return out;
}

/** Whether two settings objects hold the same values. */
export function sameSettings(
	a: KnowledgeSettings,
	b: KnowledgeSettings
): boolean {
	return (Object.keys(a) as (keyof KnowledgeSettings)[]).every(
		(key) => a[key] === b[key]
	);
}

export interface ForceSettings {
	/**
	 * Height over width of the room the graph is shown in. Gravity pulls the
	 * short axis harder, so a portrait stage gets a tall graph that fills it.
	 */
	aspect?: number;
	centerForce: number;
	linkDistance: number;
	linkForce: number;
	repelForce: number;
}

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

/** Node radius in world units (before the node size setting). */
export function nodeRadius(node: KnowledgeNode): number {
	const links = Math.sqrt(node.degree);
	switch (node.kind) {
		case "project":
		case "team":
			return 6.6 + links * 0.8;
		case "agent":
			return 5.8 + links * 0.7;
		case "topic":
			return 3.6 + links * 0.5;
		default:
			return 3 + Math.min(2, Math.log2(1 + node.weight) * 0.45);
	}
}

// ---------------------------------------------------------------------------
// Force layout
// ---------------------------------------------------------------------------

export type Vec3 = [number, number, number];

export interface Layout {
	alpha: number;
	dims: 2 | 3;
	ids: string[];
	index: Map<string, number>;
	/** Per-link bias toward the target (d3's degree-weighted split). */
	linkBias: Float32Array;
	/** Per-link base strength (1 / smaller endpoint degree). */
	linkStrength: Float32Array;
	/** Source and target index per link. */
	links: Int32Array;
	positions: Float32Array;
	radii: Float32Array;
	velocities: Float32Array;
}

const ALPHA_MIN = 0.002;
const ALPHA_DECAY = 1 - ALPHA_MIN ** (1 / 300);
const VELOCITY_DECAY = 0.42;
const DEPTH_GRAVITY = 1.15;
/** World units kept between two nodes' radii (about 4px at the fit). */
const COLLIDE_GAP = 4;
/** Share of an overlap resolved per tick (each node takes half). */
const COLLIDE_STRENGTH = 0.35;
/** How far the stage aspect may stretch the layout (each way). */
const ASPECT_LIMIT = 2.4;

/**
 * Ticks to run before the first frame: small graphs open settled (so the
 * loading outline is where they stay),
 * large ones (where a tick costs more) settle on screen.
 */
export function warmTicks(count: number): number {
	return Math.round(
		Math.min(300, Math.max(20, 1_500_000 / Math.max(1, count * count)))
	);
}

export function hashString(value: string): number {
	let hash = 2_166_136_261;
	for (const char of value) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

/** A stable starting point for a node: a shell by kind, angle by id. */
function seedPosition(id: string, kind: KnowledgeNodeKind, dims: 2 | 3): Vec3 {
	const hash = hashString(id);
	const u = (hash & 0xff_ff) / 0xff_ff;
	const v = (hash >>> 16) / 0xff_ff;
	const shell =
		kind === "project" || kind === "team"
			? 18
			: kind === "agent"
				? 34
				: kind === "topic"
					? 50
					: 62;
	const theta = u * Math.PI * 2;
	if (dims === 2) {
		return [Math.cos(theta) * shell, Math.sin(theta) * shell, 0];
	}
	const phi = Math.acos(2 * v - 1);
	return [
		Math.sin(phi) * Math.cos(theta) * shell,
		Math.cos(phi) * shell,
		Math.sin(phi) * Math.sin(theta) * shell,
	];
}

/**
 * A layout for `graph`. Nodes already placed in `previous` keep their spot
 * (so toggling a filter does not reshuffle the graph); new ones start on a
 * deterministic shell. When `previous` holds exactly these nodes, its heat
 * carries over too, so a settled graph does not move.
 */
export function createLayout(
	graph: KnowledgeGraph,
	dims: 2 | 3,
	previous?: Layout | null
): Layout {
	const count = graph.nodes.length;
	const ids = graph.nodes.map((node) => node.id);
	const index = new Map(ids.map((id, position) => [id, position]));
	const positions = new Float32Array(count * 3);
	const radii = new Float32Array(count);
	let reused = 0;
	for (const [position, node] of graph.nodes.entries()) {
		radii[position] = nodeRadius(node);
		const before = previous?.index.get(node.id);
		const source =
			before !== undefined && previous
				? [
						previous.positions[before * 3] ?? 0,
						previous.positions[before * 3 + 1] ?? 0,
						dims === 3 ? (previous.positions[before * 3 + 2] ?? 0) : 0,
					]
				: seedPosition(node.id, node.kind, dims);
		if (before !== undefined) {
			reused += 1;
		}
		positions.set(source, position * 3);
	}
	const degree = new Int32Array(count);
	const pairs: number[] = [];
	for (const link of graph.links) {
		const source = index.get(link.source);
		const target = index.get(link.target);
		if (source === undefined || target === undefined) {
			continue;
		}
		pairs.push(source, target);
		degree[source] = (degree[source] ?? 0) + 1;
		degree[target] = (degree[target] ?? 0) + 1;
	}
	const links = Int32Array.from(pairs);
	const linkCount = links.length / 2;
	const linkBias = new Float32Array(linkCount);
	const linkStrength = new Float32Array(linkCount);
	for (let link = 0; link < linkCount; link += 1) {
		const sourceDegree = degree[links[link * 2] ?? 0] ?? 1;
		const targetDegree = degree[links[link * 2 + 1] ?? 0] ?? 1;
		linkBias[link] = sourceDegree / (sourceDegree + targetDegree);
		linkStrength[link] = 1 / Math.max(1, Math.min(sourceDegree, targetDegree));
	}
	const fresh = count === 0 ? 1 : 1 - reused / count;
	// The same nodes as before (back from a local graph): carry on from where
	// that layout was, so a settled graph stays exactly as it was.
	const same =
		previous !== null &&
		previous !== undefined &&
		reused === count &&
		previous.ids.length === count &&
		previous.dims === dims;
	return {
		alpha: same ? previous.alpha : Math.max(0.35, fresh),
		dims,
		ids,
		index,
		linkBias,
		links,
		linkStrength,
		positions,
		radii,
		velocities: new Float32Array(count * 3),
	};
}

export function isSettled(layout: Layout): boolean {
	return layout.alpha < ALPHA_MIN;
}

/** Wake the layout after a force setting changes. */
export function reheat(layout: Layout, alpha = 0.4): void {
	layout.alpha = Math.max(layout.alpha, alpha);
}

/**
 * Obsidian's "Animate": gather every node close to the centre and run the
 * simulation again from full heat, so the graph unfolds.
 */
export function replayLayout(layout: Layout, gather = 0.12): void {
	const count = layout.ids.length;
	const center = [0, 0, 0];
	for (let index = 0; index < count; index += 1) {
		for (let axis = 0; axis < 3; axis += 1) {
			center[axis] =
				(center[axis] ?? 0) + (layout.positions[index * 3 + axis] ?? 0) / count;
		}
	}
	for (let index = 0; index < count; index += 1) {
		for (let axis = 0; axis < 3; axis += 1) {
			const at = index * 3 + axis;
			const middle = center[axis] ?? 0;
			layout.positions[at] =
				middle + ((layout.positions[at] ?? 0) - middle) * gather;
			layout.velocities[at] = 0;
		}
	}
	layout.alpha = 1;
}

/** One tick: many-body repulsion, link springs, gravity to the centre. */
export function stepLayout(layout: Layout, forces: ForceSettings): void {
	if (isSettled(layout)) {
		return;
	}
	const { alpha, dims, links, linkBias, linkStrength, positions, velocities } =
		layout;
	const count = layout.ids.length;
	const axes = dims;
	const repel = 10 + forces.repelForce * 100;
	const gravity = 0.02 + forces.centerForce * 0.16;
	const aspect = Math.min(
		ASPECT_LIMIT,
		Math.max(1 / ASPECT_LIMIT, forces.aspect ?? 1)
	);
	const stretch = aspect ** 0.75;
	const axisGravity: Vec3 = [
		gravity * stretch,
		gravity / stretch,
		gravity * DEPTH_GRAVITY,
	];
	const spring = 0.2 + forces.linkForce * 1.6;
	// Repulsion stops past a few link lengths, so separate clusters drift
	// back together under gravity instead of pushing each other off screen.
	const reachSquared = (forces.linkDistance * 5) ** 2;

	for (let a = 0; a < count; a += 1) {
		for (let b = a + 1; b < count; b += 1) {
			let distanceSquared = 0;
			const delta: Vec3 = [0, 0, 0];
			for (let axis = 0; axis < axes; axis += 1) {
				const d =
					(positions[b * 3 + axis] ?? 0) - (positions[a * 3 + axis] ?? 0);
				delta[axis] = d;
				distanceSquared += d * d;
			}
			if (distanceSquared > reachSquared) {
				continue;
			}
			if (distanceSquared < 1) {
				// Coincident nodes: nudge apart deterministically.
				delta[0] = ((a * 7 + b * 13) % 11) / 11 - 0.5 || 0.3;
				distanceSquared = 1;
			}
			// Collide: two nodes never sit closer than their radii plus a
			// gap, so separate nodes never visually merge.
			const reach =
				(layout.radii[a] ?? 0) + (layout.radii[b] ?? 0) + COLLIDE_GAP;
			if (distanceSquared < reach * reach) {
				const distance = Math.sqrt(distanceSquared);
				const push = ((reach - distance) / distance) * COLLIDE_STRENGTH;
				for (let axis = 0; axis < axes; axis += 1) {
					const move = (delta[axis] ?? 0) * push;
					velocities[a * 3 + axis] = (velocities[a * 3 + axis] ?? 0) - move;
					velocities[b * 3 + axis] = (velocities[b * 3 + axis] ?? 0) + move;
				}
			}
			const weight = (repel * alpha) / distanceSquared;
			for (let axis = 0; axis < axes; axis += 1) {
				const push = (delta[axis] ?? 0) * weight;
				velocities[a * 3 + axis] = (velocities[a * 3 + axis] ?? 0) - push;
				velocities[b * 3 + axis] = (velocities[b * 3 + axis] ?? 0) + push;
			}
		}
	}

	const linkCount = links.length / 2;
	for (let link = 0; link < linkCount; link += 1) {
		const source = links[link * 2] ?? 0;
		const target = links[link * 2 + 1] ?? 0;
		const delta: Vec3 = [0, 0, 0];
		let length = 0;
		for (let axis = 0; axis < axes; axis += 1) {
			const d =
				(positions[target * 3 + axis] ?? 0) +
				(velocities[target * 3 + axis] ?? 0) -
				(positions[source * 3 + axis] ?? 0) -
				(velocities[source * 3 + axis] ?? 0);
			delta[axis] = d;
			length += d * d;
		}
		length = Math.sqrt(length) || 1e-3;
		const pull =
			((length - forces.linkDistance) / length) *
			alpha *
			spring *
			(linkStrength[link] ?? 1);
		const bias = linkBias[link] ?? 0.5;
		for (let axis = 0; axis < axes; axis += 1) {
			const move = (delta[axis] ?? 0) * pull;
			velocities[target * 3 + axis] =
				(velocities[target * 3 + axis] ?? 0) - move * bias;
			velocities[source * 3 + axis] =
				(velocities[source * 3 + axis] ?? 0) + move * (1 - bias);
		}
	}

	for (let node = 0; node < count; node += 1) {
		for (let axis = 0; axis < axes; axis += 1) {
			const slot = node * 3 + axis;
			// Depth pulls in a little harder, so the 3D graph is a thick
			// volume facing the camera: it turns in depth without stacking
			// nodes head-on. Width and height follow the stage's aspect.
			const pull = axisGravity[axis] ?? gravity;
			const velocity =
				((velocities[slot] ?? 0) - (positions[slot] ?? 0) * pull * alpha) *
				(1 - VELOCITY_DECAY);
			velocities[slot] = velocity;
			positions[slot] = (positions[slot] ?? 0) + velocity;
		}
	}
	layout.alpha += (0 - layout.alpha) * ALPHA_DECAY;
}

/** Run up to `ticks` steps at once (warm start, reduced motion, tests). */
export function settleLayout(
	layout: Layout,
	forces: ForceSettings,
	ticks: number
): void {
	for (let tick = 0; tick < ticks && !isSettled(layout); tick += 1) {
		stepLayout(layout, forces);
	}
}

/** Centre and radius of the bounding sphere around every node. */
export function layoutBounds(layout: Layout): {
	center: Vec3;
	radius: number;
} {
	const count = layout.ids.length;
	if (count === 0) {
		return { center: [0, 0, 0], radius: 40 };
	}
	const center: Vec3 = [0, 0, 0];
	for (let node = 0; node < count; node += 1) {
		for (let axis = 0; axis < 3; axis += 1) {
			center[axis] =
				(center[axis] ?? 0) + (layout.positions[node * 3 + axis] ?? 0);
		}
	}
	for (let axis = 0; axis < 3; axis += 1) {
		center[axis] = (center[axis] ?? 0) / count;
	}
	let radius = 0;
	for (let node = 0; node < count; node += 1) {
		const dx = (layout.positions[node * 3] ?? 0) - center[0];
		const dy = (layout.positions[node * 3 + 1] ?? 0) - center[1];
		const dz = (layout.positions[node * 3 + 2] ?? 0) - center[2];
		radius = Math.max(
			radius,
			Math.hypot(dx, dy, dz) + (layout.radii[node] ?? 0)
		);
	}
	// Room for the labels under the outermost nodes.
	radius *= 1.1;
	return { center, radius: Math.max(radius, 24) };
}

export function positionOf(layout: Layout, id: string): Vec3 | null {
	const index = layout.index.get(id);
	if (index === undefined) {
		return null;
	}
	return [
		layout.positions[index * 3] ?? 0,
		layout.positions[index * 3 + 1] ?? 0,
		layout.positions[index * 3 + 2] ?? 0,
	];
}

/** Threads by status for the panel's summary line. */
export function statusCounts(
	threads: readonly InterfaceThread[]
): Record<ThreadStatus, number> {
	const counts: Record<ThreadStatus, number> = {
		attention: 0,
		quiet: 0,
		waiting: 0,
		working: 0,
		"your-turn": 0,
	};
	for (const thread of threads) {
		counts[threadStatus(thread)] += 1;
	}
	return counts;
}
