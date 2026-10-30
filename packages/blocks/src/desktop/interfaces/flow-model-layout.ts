import {
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { elbow, straight } from "./flow-model-edges.ts";
import {
	byUrgency,
	FLOW_UNASSIGNED_KEY,
	firstNeedingYou,
	needsYou,
	needsYouCount,
	threadGroupKey,
} from "./flow-model-threads.ts";
import {
	FLOW_GEOMETRY,
	FLOW_VISIBLE_PER_LEAD,
	type FlowChip,
	type FlowEdge,
	type FlowJoint,
	type FlowLayout,
	type FlowLayoutOptions,
	type FlowNode,
	type FlowTarget,
} from "./flow-model-types.ts";

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
