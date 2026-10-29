import {
	type GraphEdge,
	type GraphNode,
	type InterfaceGraph,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/** Fixed node footprints (px), so React Flow never has to measure them. */
export const GRAPH_NODE_SIZE: Record<
	GraphNode["kind"],
	{ height: number; width: number }
> = {
	agent: { height: 48, width: 48 },
	project: { height: 34, width: 196 },
	team: { height: 34, width: 196 },
	you: { height: 80, width: 80 },
};

/** How a node or edge is drawn relative to what the user is looking at. */
export type GraphEmphasis = "dimmed" | "focus" | "normal" | "related";

/** Threads a node stands for: everything (you), an agent's, a team's, a project's. */
export function threadsForNode(
	snapshot: InterfaceSnapshot,
	node: GraphNode
): InterfaceThread[] {
	const matches = snapshot.threads.filter((thread) => {
		switch (node.kind) {
			case "agent":
				return node.refId !== null && thread.agentIds.includes(node.refId);
			case "team":
				return thread.teamId === node.refId;
			case "project":
				return thread.projectId === node.refId;
			default:
				return true;
		}
	});
	return matches.sort(
		(a, b) =>
			THREAD_STATUS_ORDER.indexOf(threadStatus(a)) -
				THREAD_STATUS_ORDER.indexOf(threadStatus(b)) ||
			Number(b.pinned) - Number(a.pinned) ||
			b.updatedAt.localeCompare(a.updatedAt) ||
			a.id.localeCompare(b.id)
	);
}

export function groupForNode(
	snapshot: InterfaceSnapshot,
	node: GraphNode
): InterfaceGroup | undefined {
	if (node.kind !== "team" && node.kind !== "project") {
		return undefined;
	}
	return snapshot.groups.find(
		(group) => group.id === node.refId && group.kind === node.kind
	);
}

/** Every node id an edge touches together with `ids` (the neighborhood). */
export function neighborhood(
	edges: readonly GraphEdge[],
	ids: ReadonlySet<string>
): Set<string> {
	const related = new Set<string>();
	for (const edge of edges) {
		if (ids.has(edge.source)) {
			related.add(edge.target);
		}
		if (ids.has(edge.target)) {
			related.add(edge.source);
		}
	}
	for (const id of ids) {
		related.delete(id);
	}
	return related;
}

/** Map node ids a thread involves: its agents, plus its team and project. */
export function threadNodeIds(thread: InterfaceThread): Set<string> {
	const ids = new Set(thread.agentIds.map((id) => `agent:${id}`));
	if (thread.teamId) {
		ids.add(`team:${thread.teamId}`);
	}
	if (thread.projectId) {
		ids.add(`project:${thread.projectId}`);
	}
	return ids;
}

/** Agents linked to a node on the map (members, or collaborators for an agent). */
export function linkedAgentIds(
	graph: InterfaceGraph,
	nodeId: string
): string[] {
	const ids: string[] = [];
	for (const edge of graph.edges) {
		if (edge.kind === "talks") {
			continue;
		}
		let other: string | null = null;
		if (edge.source === nodeId) {
			other = edge.target;
		} else if (edge.target === nodeId) {
			other = edge.source;
		}
		if (other?.startsWith("agent:")) {
			ids.push(other.slice("agent:".length));
		}
	}
	return [...new Set(ids)];
}

/**
 * The point `distance` px along the straight line from `from` toward `to`,
 * where a line drawn between two round nodes should stop.
 */
export function stepToward(
	from: { x: number; y: number },
	to: { x: number; y: number },
	distance: number
): { x: number; y: number } {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const length = Math.hypot(dx, dy);
	if (length <= distance) {
		return from;
	}
	return {
		x: from.x + (dx / length) * distance,
		y: from.y + (dy / length) * distance,
	};
}

/** Distance from the agent ring to a team or project card's center. */
const GROUP_OFFSET = 176;
/** Arc length kept between two group cards on the outer ring. */
const GROUP_SPACING = 232;

function angleBetween(a: number, b: number): number {
	return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/**
 * Moves each team and project card just outside the agent ring, at the
 * angular center of the agents it links to, and spreads cards that would
 * overlap. The map then stays compact and balanced around you.
 */
export function settleGroups(graph: InterfaceGraph): InterfaceGraph {
	const agents = graph.nodes.filter((node) => node.kind === "agent");
	const ring = Math.max(0, ...agents.map((node) => Math.hypot(node.x, node.y)));
	const radius = ring + GROUP_OFFSET;
	const position = new Map(graph.nodes.map((node) => [node.id, node]));
	const placed: { angle: number; id: string }[] = [];
	for (const node of graph.nodes) {
		if (node.kind !== "team" && node.kind !== "project") {
			continue;
		}
		let sin = 0;
		let cos = 0;
		for (const edge of graph.edges) {
			const member = edge.source === node.id ? position.get(edge.target) : null;
			if (edge.kind === "member" && member) {
				const length = Math.hypot(member.x, member.y) || 1;
				sin += member.y / length;
				cos += member.x / length;
			}
		}
		const angle =
			Math.hypot(sin, cos) > 0.01
				? Math.atan2(sin, cos)
				: Math.atan2(node.y, node.x);
		placed.push({ angle, id: node.id });
	}
	// Push overlapping cards apart, a few relaxation passes.
	const minGap = GROUP_SPACING / Math.max(radius, 1);
	for (let pass = 0; pass < 8; pass++) {
		for (const [index, a] of placed.entries()) {
			for (const b of placed.slice(index + 1)) {
				const delta = angleBetween(b.angle, a.angle);
				if (Math.abs(delta) < minGap) {
					const push = (minGap - Math.abs(delta)) / 2;
					const direction = delta >= 0 ? 1 : -1;
					a.angle -= push * direction;
					b.angle += push * direction;
				}
			}
		}
	}
	const angles = new Map(placed.map((entry) => [entry.id, entry.angle]));
	return {
		edges: graph.edges,
		nodes: graph.nodes.map((node) => {
			const angle = angles.get(node.id);
			return angle === undefined
				? node
				: {
						...node,
						x: Math.round(Math.cos(angle) * radius),
						y: Math.round(Math.sin(angle) * radius),
					};
		}),
	};
}

function listNames(names: string[]): string {
	if (names.length <= 1) {
		return names[0] ?? "";
	}
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** The whole map in sentences, for screen readers (the canvas is visual). */
export function graphSummary(
	snapshot: InterfaceSnapshot,
	graph: InterfaceGraph
): string[] {
	const label = new Map(graph.nodes.map((node) => [node.id, node.label]));
	const teams = snapshot.groups.filter((group) => group.kind === "team");
	const projects = snapshot.groups.filter((group) => group.kind === "project");
	const working = snapshot.agents
		.filter((agent) => agent.status === "working")
		.map((agent) => agent.name);
	const lines = [
		`Map of ${plural(snapshot.agents.length, "agent")}, ${plural(teams.length, "team")} and ${plural(projects.length, "project")}, with ${plural(snapshot.threads.length, "thread")} in all.`,
	];
	const talks = graph.edges
		.filter((edge) => edge.kind === "talks")
		.map(
			(edge) =>
				`${label.get(edge.target) ?? "an agent"} (${plural(edge.weight, "thread")})`
		);
	if (talks.length > 0) {
		lines.push(`You talk with ${listNames(talks)}.`);
	}
	lines.push(
		working.length > 0
			? `${listNames(working)} ${working.length === 1 ? "is" : "are"} working now.`
			: "No agent is working right now."
	);
	for (const status of ["attention", "your-turn"] as const) {
		const names = graph.nodes
			.filter((node) => {
				// Threads arrive most urgent first.
				const first = threadsForNode(snapshot, node)[0];
				return (
					node.kind === "agent" &&
					first !== undefined &&
					threadStatus(first) === status
				);
			})
			.map((node) => node.label);
		if (names.length > 0) {
			lines.push(`${THREAD_STATUS_LABELS[status]}: ${listNames(names)}.`);
		}
	}
	for (const edge of graph.edges) {
		if (edge.kind === "collaborates") {
			lines.push(
				`${label.get(edge.source)} and ${label.get(edge.target)} work together in ${plural(edge.weight, "thread")}.`
			);
		}
	}
	for (const group of [...teams, ...projects]) {
		const members = linkedAgentIds(graph, `${group.kind}:${group.id}`)
			.map((id) => label.get(`agent:${id}`))
			.filter((name): name is string => Boolean(name));
		lines.push(
			members.length > 0
				? `${group.kind === "team" ? "Team" : "Project"} ${group.name}: ${listNames(members)}.`
				: `${group.kind === "team" ? "Team" : "Project"} ${group.name} has no agents yet.`
		);
	}
	return lines;
}
