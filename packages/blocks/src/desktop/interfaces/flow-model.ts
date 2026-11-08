import { translate as tr } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import type {
	InterfaceAgent,
	InterfaceSnapshot,
	ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { scopeFromNodeId } from "./flow-model-panel.ts";
import { needsYouCount } from "./flow-model-threads.ts";
import type { FlowNode, FlowTarget } from "./flow-model-types.ts";
import { newConversationLabel } from "./thread-display-title.ts";

/**
 * Flow lays the workspace out left to right, the way an infrastructure canvas
 * draws traffic: You -> agents (and teams) -> their conversations. Everything
 * here is pure so layout, keyboard travel, and the panel's numbers can be
 * tested without a DOM.
 */

export { edgePath } from "./flow-model-edges.ts";
export {
	buildFlowLayout,
	flowNeighbor,
	flowPath,
} from "./flow-model-layout.ts";
export {
	activityPerHour,
	type FlowLogEntry,
	type FlowMetrics,
	type FlowScope,
	flowLogs,
	flowMetrics,
	logClock,
	logDay,
	scopeFromNodeId,
	scopeThreads,
} from "./flow-model-panel.ts";
export {
	FLOW_UNASSIGNED_KEY,
	firstNeedingYou,
	leadTone,
	needsYouCount,
	threadGroupKey,
} from "./flow-model-threads.ts";
export {
	FLOW_GEOMETRY,
	FLOW_VISIBLE_PER_LEAD,
	type FlowChip,
	type FlowDirection,
	type FlowDotTone,
	type FlowEdge,
	type FlowJoint,
	type FlowLayout,
	type FlowLayoutOptions,
	type FlowNode,
	type FlowNodeKind,
	type FlowTarget,
} from "./flow-model-types.ts";

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
		label: tr("Message {name}", { name: agent.name }),
	};
}

function agentActions(snapshot: InterfaceSnapshot): FlowAction[] {
	return snapshot.agents.map((agent) => ({
		agent,
		description: agent.description.trim() || tr("Start a conversation"),
		icon: "agent",
		id: `agent:${agent.id}`,
		target: agentTarget(agent),
		title: tr("Message {name}", { name: agent.name }),
	}));
}

function teamActions(snapshot: InterfaceSnapshot): FlowAction[] {
	return snapshot.groups
		.filter((group) => group.kind === "team")
		.map((group) => ({
			description: tr(
				"{count, plural, one {Reaches # member} other {Reaches # members}}",
				{ count: group.memberAgentIds.length }
			),
			icon: "team",
			id: `team:${group.id}`,
			target: {
				groupKey: `team:${group.id}`,
				label: tr("Message {name}", { name: group.name }),
				teamId: group.id,
			},
			title: tr("Message {name}", { name: group.name }),
		}));
}

function projectActions(
	snapshot: InterfaceSnapshot,
	tl: LiteralMessage
): FlowAction[] {
	return snapshot.groups
		.filter((group) => group.kind === "project")
		.map((group) => ({
			description: tl("File a new conversation under it"),
			icon: "project",
			id: `project:${group.id}`,
			target: {
				groupKey: "root",
				label: tl("New conversation in {name}", { name: group.name }),
				projectId: group.id,
			},
			title: tl("Start in {name}", { name: group.name }),
		}));
}

/** Every way to start, and the short list the first card shows. */
export function flowStartActions(
	snapshot: InterfaceSnapshot,
	tl: LiteralMessage
): {
	all: FlowAction[];
	short: FlowAction[];
} {
	const waiting = needsYouCount(snapshot);
	const review: FlowAction[] =
		waiting > 0
			? [
					{
						description: tl(
							"{count, plural, one {{countLabel} conversation is} other {{countLabel} conversations are}} waiting on you",
							{ count: waiting, countLabel: String(waiting) }
						),
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
						target: { groupKey: "root", label: newConversationLabel(tl) },
						title: "Start a conversation",
					},
				]
			: [];
	const agents = agentActions(snapshot);
	const teams = teamActions(snapshot);
	const projects = projectActions(snapshot, tl);
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
	ownerId: string,
	tl: LiteralMessage
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
			{
				id: "projects",
				items: projectActions(snapshot, tl),
				label: "Projects",
			},
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
				label: tr("Message {name}", { name: team.name }),
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
							? tl("Message {name} directly", { name })
							: tl("Message everyone in {name}", { name }),
					icon: "blank" as const,
					id: "new",
					target: start,
					title: newConversationLabel(tl),
				},
			],
			label: null,
		},
		{
			id: "projects",
			items: projects.map((project) => ({
				description: tl("File it under {name}", { name: project.name }),
				icon: "project" as const,
				id: `project:${project.id}`,
				target: {
					...start,
					label: tr("{name} in {project}", { name, project: project.name }),
					projectId: project.id,
				},
				title: tl("Add to {name}", { name: project.name }),
			})),
			label: "Add to project",
		},
	];
	return sections.filter((section) => section.items.length > 0);
}

/** A spoken name for a node, used as its accessible label. */
export function nodeLabel(
	node: FlowNode,
	statusLabel: (status: ThreadStatus) => string,
	tl: LiteralMessage
): string {
	switch (node.kind) {
		case "origin":
			return tl("You");
		case "agent":
			return tl(
				"{name}, {count, plural, one {# conversation} other {# conversations}}",
				{ count: node.conversations, name: node.agent.name }
			);
		case "team":
			return tl(
				"{name} team, {count, plural, one {# conversation} other {# conversations}}",
				{ count: node.conversations, name: node.group.name }
			);
		case "lane":
			return tl(
				"{name}, {count, plural, one {# conversation} other {# conversations}}",
				{ count: node.conversations, name: node.label }
			);
		case "thread":
			return tl("{title}, {status}", {
				status: statusLabel(node.status),
				title: node.thread.title.trim() || tl("Untitled conversation"),
			});
		case "more":
			return tl("Show {count} more", { count: node.count });
		case "stub":
			return "Connect";
		default:
			return node.target.label;
	}
}
