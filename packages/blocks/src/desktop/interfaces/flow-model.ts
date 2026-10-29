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
 * Flow lays the workspace out left to right, the way an infrastructure canvas
 * draws traffic: You -> agents (and teams) -> their conversations. Everything
 * here is pure so layout, keyboard travel, and the panel's numbers can be
 * tested without a DOM.
 */

/** World-space geometry, in CSS pixels at zoom 1. */
export const FLOW_GEOMETRY = {
	busX: 100,
	chipSize: 24,
	composerW: 280,
	convBusX: 388,
	convW: 280,
	convX: 416,
	corner: 8,
	leadW: 176,
	leadX: 132,
	moreH: 28,
	moreW: 104,
	nodeH: 40,
	originR: 20,
	row: 56,
	stubSize: 20,
} as const;

/** Conversations shown per lead before a "N more" node takes the last slot. */
export const FLOW_VISIBLE_PER_LEAD = 3;

/** The dot a node carries on its right edge. */
export type FlowDotTone = ThreadStatus | "idle" | "success";

/** Where a new conversation is filed and where its pending node sits. */
export interface FlowTarget {
	agentId?: string;
	/** The flow group the pending node joins (`agent:<id>`, `team:<id>`, `root`). */
	groupKey: string;
	/** Placeholder for the pending node ("Message Atlas"). */
	label: string;
	projectId?: string;
	teamId?: string;
}

interface FlowNodeBase {
	column: 0 | 1 | 2;
	h: number;
	id: string;
	/** The node this one hangs off (keyboard Left), or null for the origin. */
	parentId: string | null;
	w: number;
	/** Left edge. */
	x: number;
	/** Vertical center. */
	y: number;
}

export type FlowNode =
	| (FlowNodeBase & { kind: "origin" })
	| (FlowNodeBase & {
			agent: InterfaceAgent;
			conversations: number;
			kind: "agent";
			tone: FlowDotTone;
	  })
	| (FlowNodeBase & {
			conversations: number;
			group: InterfaceGroup;
			kind: "team";
			tone: FlowDotTone;
	  })
	| (FlowNodeBase & {
			conversations: number;
			kind: "lane";
			label: string;
	  })
	| (FlowNodeBase & {
			kind: "thread";
			status: ThreadStatus;
			thread: InterfaceThread;
	  })
	| (FlowNodeBase & { count: number; groupKey: string; kind: "more" })
	| (FlowNodeBase & { kind: "stub"; ownerId: string })
	| (FlowNodeBase & { kind: "composer"; target: FlowTarget });

export type FlowNodeKind = FlowNode["kind"];

export interface FlowEdge {
	arrow: boolean;
	dashed: boolean;
	id: string;
	/** Always four points (two corners), so edges morph cleanly when rows move. */
	points: [number, number][];
	/** The node this edge leads into, for tinting the open path. */
	to: string;
}

export interface FlowChip {
	/** Spoken label for the chip. */
	description: string;
	id: string;
	label: string;
	/** The most urgent conversation behind this chip, opened on press. */
	threadId: string | null;
	tone: "attention" | "plain";
	x: number;
	y: number;
}

/** The quiet round glyph on a connector that has nothing waiting on it. */
export interface FlowJoint {
	id: string;
	x: number;
	y: number;
}

export interface FlowLayout {
	bounds: { maxX: number; maxY: number; minX: number; minY: number };
	chips: FlowChip[];
	edges: FlowEdge[];
	/** One per lead connector without a chip, so every connector reads alike. */
	joints: FlowJoint[];
	nodes: FlowNode[];
}

export interface FlowLayoutOptions {
	/** Open thread: always laid out, even when it would sit behind "N more". */
	activeThreadId?: string | null;
	composer: FlowTarget | null;
	/** Lead keys the user brought onto the canvas this session. */
	engaged: readonly string[];
	/** Group keys whose full conversation list is shown. */
	expanded: readonly string[];
	/** Keep the origin's dotted "+" stub on the canvas at all times. */
	originStub?: boolean;
	/** Node id (`origin` or a lead) that shows its dotted "+" stub. */
	stubFor: string | null;
}

const STATUS_RANK = new Map(
	THREAD_STATUS_ORDER.map((status, index) => [status, index])
);

function byUrgency(a: InterfaceThread, b: InterfaceThread): number {
	const rank =
		(STATUS_RANK.get(threadStatus(a)) ?? 0) -
		(STATUS_RANK.get(threadStatus(b)) ?? 0);
	return (
		rank ||
		Number(b.pinned) - Number(a.pinned) ||
		b.updatedAt.localeCompare(a.updatedAt) ||
		a.id.localeCompare(b.id)
	);
}

/** The status a lead shows: live work first, then what needs the user. */
export function leadTone(
	threads: readonly InterfaceThread[],
	working: boolean
): FlowDotTone {
	const statuses = new Set(threads.map(threadStatus));
	if (working || statuses.has("working")) {
		return "working";
	}
	if (statuses.has("attention")) {
		return "attention";
	}
	if (statuses.has("your-turn")) {
		return "your-turn";
	}
	return "idle";
}

/** The lane that gathers conversations with no agent or team. */
export const FLOW_UNASSIGNED_KEY = "lane:unassigned";

/** Which flow group a thread belongs to: its team, else its first agent. */
export function threadGroupKey(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): string {
	if (
		thread.teamId &&
		snapshot.groups.some(
			(group) => group.kind === "team" && group.id === thread.teamId
		)
	) {
		return `team:${thread.teamId}`;
	}
	const agentId = thread.agentIds.find((id) =>
		snapshot.agents.some((agent) => agent.id === id)
	);
	return agentId ? `agent:${agentId}` : "orphan";
}

type LeadGroup =
	| {
			key: string;
			kind: "lead";
			lead:
				| { agent: InterfaceAgent; kind: "agent" }
				| { group: InterfaceGroup; kind: "team"; working: boolean }
				| { kind: "lane"; label: string };
			threads: InterfaceThread[];
	  }
	| { kind: "root"; target: FlowTarget };

function collectGroups(
	snapshot: InterfaceSnapshot,
	options: FlowLayoutOptions
): LeadGroup[] {
	const byKey = new Map<string, InterfaceThread[]>();
	for (const thread of snapshot.threads) {
		const key = threadGroupKey(snapshot, thread);
		const list = byKey.get(key) ?? [];
		list.push(thread);
		byKey.set(key, list);
	}
	const wanted = new Set([
		...byKey.keys(),
		...options.engaged,
		...(options.composer ? [options.composer.groupKey] : []),
	]);
	const groups: LeadGroup[] = [];
	for (const agent of snapshot.agents) {
		const key = `agent:${agent.id}`;
		if (wanted.has(key)) {
			groups.push({
				key,
				kind: "lead",
				lead: { agent, kind: "agent" },
				threads: (byKey.get(key) ?? []).sort(byUrgency),
			});
		}
	}
	for (const group of snapshot.groups) {
		const key = `team:${group.id}`;
		if (group.kind === "team" && wanted.has(key)) {
			groups.push({
				key,
				kind: "lead",
				lead: {
					group,
					kind: "team",
					working: snapshot.agents.some(
						(agent) =>
							agent.status === "working" &&
							group.memberAgentIds.includes(agent.id)
					),
				},
				threads: (byKey.get(key) ?? []).sort(byUrgency),
			});
		}
	}
	const orphans = byKey.get("orphan") ?? [];
	if (orphans.length > 0) {
		groups.push({
			key: FLOW_UNASSIGNED_KEY,
			kind: "lead",
			lead: { kind: "lane", label: "Unassigned" },
			threads: orphans.sort(byUrgency),
		});
	}
	const composer = options.composer;
	if (
		composer &&
		!groups.some(
			(group) => group.kind === "lead" && group.key === composer.groupKey
		)
	) {
		groups.push({ kind: "root", target: composer });
	}
	return groups;
}

function straight(
	from: [number, number],
	to: [number, number]
): [number, number][] {
	return [from, from, to, to];
}

function elbow(
	from: [number, number],
	turnX: number,
	to: [number, number]
): [number, number][] {
	return [from, [turnX, from[1]], [turnX, to[1]], to];
}

function distance(a: [number, number], b: [number, number]): number {
	return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function toward(
	from: [number, number],
	to: [number, number],
	length: number
): [number, number] {
	const total = distance(from, to);
	if (total === 0) {
		return from;
	}
	const ratio = length / total;
	return [
		from[0] + (to[0] - from[0]) * ratio,
		from[1] + (to[1] - from[1]) * ratio,
	];
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * A four-point edge as an SVG path with rounded corners. The command shape is
 * fixed (M L Q L Q L) even for straight edges, so motion can morph between
 * any two layouts.
 */
export function edgePath(
	points: readonly [number, number][],
	radius: number = FLOW_GEOMETRY.corner
): string {
	const [start, first, second, end] = points as [
		[number, number],
		[number, number],
		[number, number],
		[number, number],
	];
	const corner = (
		before: [number, number],
		at: [number, number],
		after: [number, number]
	) => {
		const room = Math.min(
			radius,
			distance(before, at) / 2,
			distance(at, after) / 2
		);
		return [toward(at, before, room), toward(at, after, room)] as const;
	};
	const [inA, outA] = corner(start, first, second);
	const [inB, outB] = corner(first, second, end);
	const p = ([x, y]: [number, number]) => `${round(x)} ${round(y)}`;
	return `M ${p(start)} L ${p(inA)} Q ${p(first)} ${p(outA)} L ${p(inB)} Q ${p(second)} ${p(outB)} L ${p(end)}`;
}

interface Cursor {
	chips: FlowChip[];
	edges: FlowEdge[];
	/** Vertical centers of column-1 rows, for the origin's bus. */
	entries: number[];
	joints: FlowJoint[];
	nodes: FlowNode[];
	y: number;
}

function visibleThreads(
	threads: InterfaceThread[],
	expanded: boolean,
	activeThreadId: string | null
): InterfaceThread[] {
	if (expanded || threads.length <= FLOW_VISIBLE_PER_LEAD) {
		return threads;
	}
	const shown = threads.slice(0, FLOW_VISIBLE_PER_LEAD - 1);
	const active = threads.find((thread) => thread.id === activeThreadId);
	if (active && !shown.includes(active)) {
		shown[shown.length - 1] = active;
	}
	return shown;
}

function leadNode(
	group: Extract<LeadGroup, { kind: "lead" }>,
	y: number
): FlowNode {
	const g = FLOW_GEOMETRY;
	const common = {
		column: 1 as const,
		conversations: group.threads.length,
		h: g.nodeH,
		id: group.key,
		parentId: "origin",
		w: g.leadW,
		x: g.leadX,
		y,
	};
	// A lead's dot is presence (working or idle); its conversations carry status.
	if (group.lead.kind === "agent") {
		return {
			...common,
			agent: group.lead.agent,
			kind: "agent",
			tone: group.lead.agent.status === "working" ? "working" : "idle",
		};
	}
	if (group.lead.kind === "team") {
		return {
			...common,
			group: group.lead.group,
			kind: "team",
			tone: group.lead.working ? "working" : "idle",
		};
	}
	return { ...common, kind: "lane", label: group.lead.label };
}

function addRootRow(cursor: Cursor, node: FlowNode, dashed: boolean): void {
	const g = FLOW_GEOMETRY;
	cursor.nodes.push(node);
	cursor.entries.push(node.y);
	cursor.edges.push({
		arrow: !dashed,
		dashed,
		id: `edge:${node.id}`,
		// Filled in once the origin's height is known.
		points: [
			[g.busX, node.y],
			[g.busX, node.y],
			[g.busX, node.y],
			[node.x - 2, node.y],
		],
		to: node.id,
	});
	cursor.y += g.row;
}

function placeLead(
	group: Extract<LeadGroup, { kind: "lead" }>,
	options: FlowLayoutOptions,
	cursor: Cursor
): void {
	const g = FLOW_GEOMETRY;
	const leadY = cursor.y + g.nodeH / 2;
	const leadRight = g.leadX + g.leadW;
	cursor.nodes.push(leadNode(group, leadY));
	cursor.entries.push(leadY);
	cursor.edges.push({
		arrow: true,
		dashed: false,
		id: `edge:${group.key}`,
		points: [
			[g.busX, leadY],
			[g.busX, leadY],
			[g.busX, leadY],
			[g.leadX - 2, leadY],
		],
		to: group.key,
	});

	const visible = visibleThreads(
		group.threads,
		options.expanded.includes(group.key),
		options.activeThreadId ?? null
	);
	let slot = 0;
	const link = (
		id: string,
		to: string,
		y: number,
		toX: number,
		dashed: boolean
	) => {
		cursor.edges.push({
			arrow: !dashed,
			dashed,
			id,
			points:
				slot === 0
					? straight([leadRight, leadY], [toX, y])
					: elbow([g.convBusX, leadY], g.convBusX, [toX, y]),
			to,
		});
	};
	for (const thread of visible) {
		const y = leadY + slot * g.row;
		cursor.nodes.push({
			column: 2,
			h: g.nodeH,
			id: `thread:${thread.id}`,
			kind: "thread",
			parentId: group.key,
			status: threadStatus(thread),
			thread,
			w: g.convW,
			x: g.convX,
			y,
		});
		link(
			`edge:${group.key}:${thread.id}`,
			`thread:${thread.id}`,
			y,
			g.convX - 2,
			false
		);
		slot += 1;
	}
	const hidden = group.threads.length - visible.length;
	if (hidden > 0) {
		const y = leadY + slot * g.row;
		cursor.nodes.push({
			column: 2,
			count: hidden,
			groupKey: group.key,
			h: g.moreH,
			id: `more:${group.key}`,
			kind: "more",
			parentId: group.key,
			w: g.moreW,
			x: g.convX,
			y,
		});
		link(`edge:more:${group.key}`, `more:${group.key}`, y, g.convX, true);
		slot += 1;
	}
	// The connector only speaks when something behind it waits on the user.
	const waiting = group.threads.filter(needsYou);
	const jointX = (leadRight + g.convBusX) / 2;
	if (visible.length > 0 && waiting.length > 0) {
		cursor.chips.push({
			description: `${waiting.length} waiting on you`,
			id: `chip:${group.key}`,
			label: String(waiting.length),
			threadId: waiting[0]?.id ?? null,
			tone: "attention",
			x: jointX,
			y: leadY,
		});
	} else if (visible.length > 0) {
		cursor.joints.push({ id: `joint:${group.key}`, x: jointX, y: leadY });
	}
	const composer =
		options.composer?.groupKey === group.key ? options.composer : null;
	if (composer) {
		const y = leadY + slot * g.row;
		cursor.nodes.push({
			column: 2,
			h: g.nodeH,
			id: `composer:${group.key}`,
			kind: "composer",
			parentId: group.key,
			target: composer,
			w: g.composerW,
			x: g.convX,
			y,
		});
		link(
			`edge:composer:${group.key}`,
			`composer:${group.key}`,
			y,
			g.convX,
			true
		);
		slot += 1;
	} else if (options.stubFor === group.key) {
		const y = leadY + slot * g.row;
		cursor.nodes.push({
			column: 2,
			h: g.stubSize,
			id: `stub:${group.key}`,
			kind: "stub",
			ownerId: group.key,
			parentId: group.key,
			w: g.stubSize,
			x: g.convX,
			y,
		});
		link(`edge:stub:${group.key}`, `stub:${group.key}`, y, g.convX, true);
		slot += 1;
	}
	cursor.y += Math.max(1, slot) * g.row;
}

/** Lays the snapshot out as a left-to-right flow. */
export function buildFlowLayout(
	snapshot: InterfaceSnapshot,
	options: FlowLayoutOptions
): FlowLayout {
	const g = FLOW_GEOMETRY;
	const cursor: Cursor = {
		chips: [],
		edges: [],
		joints: [],
		entries: [],
		nodes: [],
		y: 0,
	};
	for (const group of collectGroups(snapshot, options)) {
		if (group.kind === "lead") {
			placeLead(group, options, cursor);
		} else {
			addRootRow(
				cursor,
				{
					column: 1,
					h: g.nodeH,
					id: "composer:root",
					kind: "composer",
					parentId: "origin",
					target: group.target,
					w: g.composerW,
					x: g.leadX,
					y: cursor.y + g.nodeH / 2,
				},
				true
			);
		}
	}
	const first = cursor.entries[0] ?? g.nodeH / 2;
	const last = cursor.entries.at(-1) ?? first;
	const originY = (first + last) / 2;
	if (
		options.stubFor === "origin" ||
		(options.originStub && !options.composer)
	) {
		addRootRow(
			cursor,
			{
				column: 1,
				h: g.stubSize,
				id: "stub:origin",
				kind: "stub",
				ownerId: "origin",
				parentId: "origin",
				w: g.stubSize,
				x: g.leadX,
				y: cursor.y + g.nodeH / 2,
			},
			true
		);
	}
	// Every column-1 row branches off the bus at the origin's height.
	const rowIds = new Set(
		cursor.nodes
			.filter((node) => node.column === 1)
			.map((node) => `edge:${node.id}`)
	);
	for (const edge of cursor.edges) {
		if (rowIds.has(edge.id)) {
			const end = edge.points[3] as [number, number];
			edge.points = elbow([g.busX, originY], g.busX, end);
		}
	}
	cursor.nodes.unshift({
		column: 0,
		h: g.originR * 2,
		id: "origin",
		kind: "origin",
		parentId: null,
		w: g.originR * 2,
		x: -g.originR,
		y: originY,
	});
	if (cursor.entries.length > 0) {
		cursor.edges.unshift({
			arrow: false,
			dashed: false,
			id: "edge:trunk",
			points: straight([g.originR + 4, originY], [g.busX, originY]),
			to: "origin",
		});
		const waiting = needsYouCount(snapshot);
		if (waiting > 0) {
			cursor.chips.unshift({
				description: `${waiting} waiting on you`,
				id: "chip:origin",
				label: String(waiting),
				threadId: firstNeedingYou(snapshot)?.id ?? null,
				tone: "attention",
				x: (g.originR + g.busX) / 2 + 2,
				y: originY,
			});
		}
	}
	let maxX = -g.originR;
	let maxY = originY + g.originR;
	let minY = originY - g.originR;
	for (const node of cursor.nodes) {
		maxX = Math.max(maxX, node.x + node.w);
		maxY = Math.max(maxY, node.y + node.h / 2);
		minY = Math.min(minY, node.y - node.h / 2);
	}
	return {
		// The origin's "You" caption hangs below it.
		bounds: {
			maxX,
			maxY: Math.max(maxY, originY + 40),
			minX: -g.originR,
			minY,
		},
		chips: cursor.chips,
		edges: cursor.edges,
		joints: cursor.joints,
		nodes: cursor.nodes,
	};
}

export type FlowDirection = "down" | "left" | "right" | "up";

/** The node an arrow key moves to from `id`, along the flow's connections. */
export function flowNeighbor(
	layout: FlowLayout,
	id: string | null,
	direction: FlowDirection
): string | null {
	const current = layout.nodes.find((node) => node.id === id);
	if (!current) {
		return layout.nodes[0]?.id ?? null;
	}
	if (direction === "left") {
		return current.parentId;
	}
	if (direction === "right") {
		const children = layout.nodes
			.filter((node) => node.parentId === current.id)
			.sort((a, b) => a.y - b.y);
		const level = children.filter((node) => Math.abs(node.y - current.y) < 1);
		return (level[0] ?? children[0])?.id ?? null;
	}
	const column = layout.nodes
		.filter((node) => node.column === current.column)
		.sort((a, b) => a.y - b.y);
	const index = column.findIndex((node) => node.id === current.id);
	const next = column[index + (direction === "down" ? 1 : -1)];
	return next?.id ?? null;
}

// ---------------------------------------------------------------------------
// Panel numbers
// ---------------------------------------------------------------------------

export type FlowScope =
	| { kind: "agent"; agentId: string }
	| { kind: "all" }
	| { kind: "team"; teamId: string }
	| { kind: "unassigned" };

export function scopeFromNodeId(id: string | null): FlowScope | null {
	if (id === "origin") {
		return { kind: "all" };
	}
	if (id?.startsWith("agent:")) {
		return { agentId: id.slice("agent:".length), kind: "agent" };
	}
	if (id?.startsWith("team:")) {
		return { kind: "team", teamId: id.slice("team:".length) };
	}
	if (id === FLOW_UNASSIGNED_KEY) {
		return { kind: "unassigned" };
	}
	return null;
}

export function scopeThreads(
	snapshot: InterfaceSnapshot,
	scope: FlowScope
): InterfaceThread[] {
	if (scope.kind === "all") {
		return snapshot.threads;
	}
	// The same grouping the canvas draws, so a lead's panel and its node agree.
	let key = "orphan";
	if (scope.kind === "agent") {
		key = `agent:${scope.agentId}`;
	} else if (scope.kind === "team") {
		key = `team:${scope.teamId}`;
	}
	return snapshot.threads.filter(
		(thread) => threadGroupKey(snapshot, thread) === key
	);
}

export interface FlowMetrics {
	conversations: number;
	messages: number;
	/** Failed runs plus replies waiting on the user: what the inbox chips count. */
	needsYou: number;
	working: number;
}

export function flowMetrics(threads: readonly InterfaceThread[]): FlowMetrics {
	let needsYouTotal = 0;
	let working = 0;
	let messages = 0;
	for (const thread of threads) {
		if (needsYou(thread)) {
			needsYouTotal += 1;
		}
		if (threadStatus(thread) === "working") {
			working += 1;
		}
		messages += thread.messageCount;
	}
	return {
		conversations: threads.length,
		messages,
		needsYou: needsYouTotal,
		working,
	};
}

const HOUR = 3_600_000;

function inScope(
	snapshot: InterfaceSnapshot,
	scope: FlowScope,
	agentId: string | null
): boolean {
	if (scope.kind === "all") {
		return true;
	}
	if (scope.kind === "agent") {
		return agentId === scope.agentId;
	}
	if (scope.kind === "unassigned") {
		return agentId === null;
	}
	const team = snapshot.groups.find((group) => group.id === scope.teamId);
	return agentId !== null && Boolean(team?.memberAgentIds.includes(agentId));
}

/**
 * Activity in each of the last 24 hours, oldest first: conversation updates
 * plus scheduled runs that started in that hour.
 */
export function activityPerHour(
	snapshot: InterfaceSnapshot,
	scope: FlowScope,
	now: number
): number[] {
	const buckets = Array.from({ length: 24 }, () => 0);
	const add = (iso: string) => {
		const at = Date.parse(iso);
		if (Number.isNaN(at) || at > now) {
			return;
		}
		const age = Math.floor((now - at) / HOUR);
		if (age < 24) {
			buckets[23 - age] = (buckets[23 - age] ?? 0) + 1;
		}
	};
	for (const thread of scopeThreads(snapshot, scope)) {
		add(thread.updatedAt);
	}
	for (const event of snapshot.events ?? []) {
		if (event.kind === "past" && inScope(snapshot, scope, event.agentId)) {
			add(event.start);
		}
	}
	return buckets;
}

export interface FlowLogEntry {
	at: string;
	id: string;
	threadId: string | null;
	title: string;
	tone: FlowDotTone;
	verb: string;
}

function threadVerb(thread: InterfaceThread): string {
	switch (threadStatus(thread)) {
		case "attention":
			return thread.runState === "interrupted" ? "Stopped" : "Failed";
		case "working":
			return "Working";
		case "your-turn":
			return "Replied";
		case "waiting":
			return "Asked";
		default:
			return "Opened";
	}
}

/** Recent updates in a scope, newest first, like a request log. */
export function flowLogs(
	snapshot: InterfaceSnapshot,
	scope: FlowScope,
	now: number,
	limit = 24
): FlowLogEntry[] {
	const entries: FlowLogEntry[] = scopeThreads(snapshot, scope).map(
		(thread) => ({
			at: thread.updatedAt,
			id: `thread:${thread.id}`,
			threadId: thread.id,
			title: thread.title.trim() || "Untitled conversation",
			tone: threadStatus(thread),
			verb: threadVerb(thread),
		})
	);
	for (const event of snapshot.events ?? []) {
		const start = Date.parse(event.start);
		if (
			event.kind !== "past" ||
			Number.isNaN(start) ||
			start > now ||
			!inScope(snapshot, scope, event.agentId)
		) {
			continue;
		}
		const failed = event.outcome === "failure";
		entries.push({
			at: event.start,
			id: `event:${event.id}`,
			threadId: null,
			title: event.title,
			tone: failed ? "attention" : "success",
			verb: failed ? "Failed" : "Ran",
		});
	}
	return entries
		.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
		.slice(0, limit);
}

const pad = (value: number) => String(value).padStart(2, "0");
const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** `HH:MM` in local time, for the log's fixed-width time column. */
export function logClock(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The day heading a log entry falls under: Today, Yesterday, or `Mon D`. */
export function logDay(iso: string, now: number): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	const day = new Date(date);
	day.setHours(0, 0, 0, 0);
	const daysAgo = Math.round((start.getTime() - day.getTime()) / 86_400_000);
	if (daysAgo === 0) {
		return "Today";
	}
	if (daysAgo === 1) {
		return "Yesterday";
	}
	return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** Conversations waiting on the user: failed runs and replies. */
function needsYou(thread: InterfaceThread): boolean {
	const status = threadStatus(thread);
	return status === "attention" || status === "your-turn";
}

export function needsYouCount(snapshot: InterfaceSnapshot): number {
	return snapshot.threads.filter(needsYou).length;
}

/** The node ids from the origin down to `id`, for tinting the open path. */
export function flowPath(layout: FlowLayout, id: string | null): Set<string> {
	const path = new Set<string>();
	const byId = new Map(layout.nodes.map((node) => [node.id, node]));
	let current = id ? byId.get(id) : undefined;
	while (current && !path.has(current.id)) {
		path.add(current.id);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path;
}

/** The most urgent conversation waiting on the user, if any. */
export function firstNeedingYou(
	snapshot: InterfaceSnapshot
): InterfaceThread | undefined {
	return snapshot.threads
		.filter((thread) => {
			const status = threadStatus(thread);
			return status === "attention" || status === "your-turn";
		})
		.sort(byUrgency)[0];
}

// ---------------------------------------------------------------------------
// Start actions (the first card, the "+" menus)
// ---------------------------------------------------------------------------

export type FlowActionIcon = "agent" | "blank" | "project" | "review" | "team";

export interface FlowAction {
	agent?: InterfaceAgent;
	description: string;
	icon: FlowActionIcon;
	id: string;
	/** Null for "Review what needs you", which opens a conversation instead. */
	target: FlowTarget | null;
	title: string;
}

export function agentTarget(agent: InterfaceAgent): FlowTarget {
	return {
		agentId: agent.id,
		groupKey: `agent:${agent.id}`,
		label: `Message ${agent.name}`,
	};
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

function agentActions(snapshot: InterfaceSnapshot): FlowAction[] {
	return snapshot.agents.map((agent) => ({
		agent,
		description: agent.description.trim() || "Start a conversation",
		icon: "agent",
		id: `agent:${agent.id}`,
		target: agentTarget(agent),
		title: `Message ${agent.name}`,
	}));
}

function teamActions(snapshot: InterfaceSnapshot): FlowAction[] {
	return snapshot.groups
		.filter((group) => group.kind === "team")
		.map((group) => ({
			description: `Reaches ${plural(group.memberAgentIds.length, "member", "members")}`,
			icon: "team",
			id: `team:${group.id}`,
			target: {
				groupKey: `team:${group.id}`,
				label: `Message ${group.name}`,
				teamId: group.id,
			},
			title: `Message ${group.name}`,
		}));
}

function projectActions(snapshot: InterfaceSnapshot): FlowAction[] {
	return snapshot.groups
		.filter((group) => group.kind === "project")
		.map((group) => ({
			description: "File a new conversation under it",
			icon: "project",
			id: `project:${group.id}`,
			target: {
				groupKey: "root",
				label: `New conversation in ${group.name}`,
				projectId: group.id,
			},
			title: `Start in ${group.name}`,
		}));
}

/** Every way to start, and the short list the first card shows. */
export function flowStartActions(snapshot: InterfaceSnapshot): {
	all: FlowAction[];
	short: FlowAction[];
} {
	const waiting = needsYouCount(snapshot);
	const review: FlowAction[] =
		waiting > 0
			? [
					{
						description: `${plural(waiting, "conversation is", "conversations are")} waiting on you`,
						icon: "review",
						id: "review",
						target: null,
						title: "Review what needs you",
					},
				]
			: [];
	const blank: FlowAction[] =
		snapshot.agents.length === 0
			? [
					{
						description: "Ask without picking an agent",
						icon: "blank",
						id: "blank",
						target: { groupKey: "root", label: "New conversation" },
						title: "Start a conversation",
					},
				]
			: [];
	const agents = agentActions(snapshot);
	const teams = teamActions(snapshot);
	const projects = projectActions(snapshot);
	const all = [...review, ...blank, ...agents, ...teams, ...projects];
	const roomForAgents = Math.max(
		1,
		4 - review.length - blank.length - Math.min(1, projects.length)
	);
	const short = [
		...review,
		...blank,
		...agents.slice(0, roomForAgents),
		...projects.slice(0, 1),
	].slice(0, 4);
	return { all, short };
}

export interface FlowMenuSection {
	id: string;
	items: FlowAction[];
	label: string | null;
}

/** Choices in a node's "Connect to" menu, in sections. */
export function connectSections(
	snapshot: InterfaceSnapshot,
	ownerId: string
): FlowMenuSection[] {
	const scope = scopeFromNodeId(ownerId);
	const projects = snapshot.groups.filter((group) => group.kind === "project");
	if (!scope || scope.kind === "unassigned") {
		return [];
	}
	if (scope.kind === "all") {
		return [
			{ id: "agents", items: agentActions(snapshot), label: "Agents" },
			{ id: "teams", items: teamActions(snapshot), label: "Teams" },
			{ id: "projects", items: projectActions(snapshot), label: "Projects" },
		].filter((section) => section.items.length > 0);
	}
	let base: FlowTarget | null = null;
	let name = "";
	if (scope.kind === "agent") {
		const agent = snapshot.agents.find((item) => item.id === scope.agentId);
		if (agent) {
			base = agentTarget(agent);
			name = agent.name;
		}
	} else {
		const team = snapshot.groups.find((group) => group.id === scope.teamId);
		if (team) {
			base = {
				groupKey: `team:${team.id}`,
				label: `Message ${team.name}`,
				teamId: team.id,
			};
			name = team.name;
		}
	}
	if (!base) {
		return [];
	}
	const start = base;
	const sections: FlowMenuSection[] = [
		{
			id: "new",
			items: [
				{
					description:
						scope.kind === "agent"
							? `Message ${name} directly`
							: `Message everyone in ${name}`,
					icon: "blank" as const,
					id: "new",
					target: start,
					title: "New conversation",
				},
			],
			label: null,
		},
		{
			id: "projects",
			items: projects.map((project) => ({
				description: `File it under ${project.name}`,
				icon: "project" as const,
				id: `project:${project.id}`,
				target: {
					...start,
					label: `${name} in ${project.name}`,
					projectId: project.id,
				},
				title: `Add to ${project.name}`,
			})),
			label: "Add to project",
		},
	];
	return sections.filter((section) => section.items.length > 0);
}

/** A spoken name for a node, used as its accessible label. */
export function nodeLabel(
	node: FlowNode,
	statusLabel: (status: ThreadStatus) => string
): string {
	switch (node.kind) {
		case "origin":
			return "You";
		case "agent":
			return `${node.agent.name}, ${plural(node.conversations, "conversation", "conversations")}`;
		case "team":
			return `${node.group.name} team, ${plural(node.conversations, "conversation", "conversations")}`;
		case "lane":
			return `${node.label}, ${plural(node.conversations, "conversation", "conversations")}`;
		case "thread":
			return `${node.thread.title.trim() || "Untitled conversation"}, ${statusLabel(node.status)}`;
		case "more":
			return `Show ${node.count} more`;
		case "stub":
			return "Connect";
		default:
			return node.target.label;
	}
}
