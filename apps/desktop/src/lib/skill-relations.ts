import type { InstalledSkill } from "./api/skills.ts";

export const NO_AGENT_CAPABILITIES = "__ryu_none__";

export type SkillRelationNodeKind = "agent" | "skill" | "tool";
export type SkillRelationEdgeKind = "agent-skill" | "skill-tool";
export type SkillAgentScope = "all-enabled" | "allowlist" | "none";

export interface SkillRelationAgent {
	description?: string | null;
	id: string;
	name: string;
	scopeUnavailable?: boolean;
	skills: readonly string[] | null;
}

export type SkillRelationSkill = Pick<
	InstalledSkill,
	"allowedTools" | "description" | "enabled" | "id" | "name"
>;

export interface SkillRelationNode {
	description?: string | null;
	enabled?: boolean;
	id: string;
	kind: SkillRelationNodeKind;
	label: string;
	scope?: SkillAgentScope;
	scopeUnavailable?: boolean;
	usageCount?: number;
}

export interface SkillRelationEdge {
	count?: number;
	id: string;
	kind: SkillRelationEdgeKind;
	source: string;
	target: string;
}

export interface SkillRelationGraph {
	edges: SkillRelationEdge[];
	nodes: SkillRelationNode[];
}

export interface SkillRelationGraphInput {
	agents: readonly SkillRelationAgent[];
	skills: readonly SkillRelationSkill[];
	usage: ReadonlyMap<string, number>;
}

function nodeId(kind: SkillRelationNodeKind, id: string): string {
	return `${kind}:${id}`;
}

function edgeId(
	kind: SkillRelationEdgeKind,
	source: string,
	target: string
): string {
	return `${kind}:${source}->${target}`;
}

function isEnabledSkill(skill: SkillRelationSkill): boolean {
	return skill.enabled;
}

/**
 * Resolve the same empty-means-all contract Core uses for an agent's skill
 * allowlist. The returned ids follow the installed-skill order, which keeps the
 * graph deterministic even when an explicit allowlist was saved in another order.
 */
export function resolveAgentSkillIds(
	agentSkills: readonly string[] | null,
	skills: readonly SkillRelationSkill[]
) {
	const enabledIds = skills.filter(isEnabledSkill).map((skill) => skill.id);
	if (agentSkills === null || agentSkills.length === 0) {
		return { ids: enabledIds, scope: "all-enabled" } satisfies {
			ids: string[];
			scope: SkillAgentScope;
		};
	}
	if (agentSkills.includes(NO_AGENT_CAPABILITIES)) {
		return { ids: [], scope: "none" } satisfies {
			ids: string[];
			scope: SkillAgentScope;
		};
	}

	const allowed = new Set(agentSkills);
	return {
		ids: enabledIds.filter((id) => allowed.has(id)),
		scope: "allowlist",
	} satisfies { ids: string[]; scope: SkillAgentScope };
}

function usageCountFor(
	usage: ReadonlyMap<string, number>,
	id: string
): number | undefined {
	const count = usage.get(id);
	return count !== undefined && Number.isFinite(count) ? count : undefined;
}

/** Build a deterministic graph from node-scoped configuration plus optional usage. */
export function buildSkillRelationGraph({
	agents,
	skills,
	usage,
}: SkillRelationGraphInput): SkillRelationGraph {
	const nodes: SkillRelationNode[] = [];
	const edges: SkillRelationEdge[] = [];

	for (const agent of agents) {
		const resolved = resolveAgentSkillIds(agent.skills, skills);
		const agentId = nodeId("agent", agent.id);
		nodes.push({
			description: agent.description ?? null,
			id: agentId,
			kind: "agent",
			label: agent.name,
			scope: resolved.scope,
			scopeUnavailable: agent.scopeUnavailable,
		});
		for (const skillId of resolved.ids) {
			const target = nodeId("skill", skillId);
			edges.push({
				id: edgeId("agent-skill", agentId, target),
				kind: "agent-skill",
				source: agentId,
				target,
			});
		}
	}

	const seenTools = new Set<string>();
	for (const skill of skills) {
		const skillId = nodeId("skill", skill.id);
		nodes.push({
			description: skill.description,
			enabled: skill.enabled,
			id: skillId,
			kind: "skill",
			label: skill.name,
			usageCount: usageCountFor(usage, skill.id),
		});

		for (const toolName of skill.allowedTools) {
			const trimmed = toolName.trim();
			if (!trimmed) {
				continue;
			}
			const toolId = nodeId("tool", trimmed);
			if (seenTools.has(trimmed)) {
				continue;
			}
			seenTools.add(trimmed);
			nodes.push({
				description: null,
				id: toolId,
				kind: "tool",
				label: trimmed,
			});
		}
	}

	for (const skill of skills) {
		const source = nodeId("skill", skill.id);
		const seenForSkill = new Set<string>();
		for (const toolName of skill.allowedTools) {
			const trimmed = toolName.trim();
			if (!trimmed || seenForSkill.has(trimmed)) {
				continue;
			}
			seenForSkill.add(trimmed);
			const target = nodeId("tool", trimmed);
			edges.push({
				id: edgeId("skill-tool", source, target),
				kind: "skill-tool",
				source,
				target,
			});
		}
	}

	return { edges, nodes };
}

/** Keep matches plus their one-hop neighbors for readable filtered graphs. */
export function filterSkillRelationGraph(
	graph: SkillRelationGraph,
	query: string
): SkillRelationGraph {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return graph;
	}

	const matchingIds = new Set(
		graph.nodes
			.filter((node) =>
				[node.id, node.label, node.description]
					.filter(Boolean)
					.join(" ")
					.toLowerCase()
					.includes(needle)
			)
			.map((node) => node.id)
	);
	const includedIds = new Set(matchingIds);
	for (const edge of graph.edges) {
		if (matchingIds.has(edge.source) || matchingIds.has(edge.target)) {
			includedIds.add(edge.source);
			includedIds.add(edge.target);
		}
	}

	return {
		edges: graph.edges.filter(
			(edge) => includedIds.has(edge.source) && includedIds.has(edge.target)
		),
		nodes: graph.nodes.filter((node) => includedIds.has(node.id)),
	};
}
