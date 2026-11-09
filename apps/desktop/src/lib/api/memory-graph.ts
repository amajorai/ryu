// apps/desktop/src/lib/api/memory-graph.ts
//
// Typed client for Core's access-filtered memory graph (`/api/memory/graph`),
// the topic/person/category projection the Memory Library draws.

import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

const edgesResponseSchema = z.looseObject({
	kind: z.string(),
	memory_id: z.string(),
	source: z.string(),
	target: z.string(),
	weight: z.number(),
});
const nodesResponseSchema = z.looseObject({
	agent_id: z.string().optional(),
	id: z.string(),
	kind: z.union([
		z.literal("memory"),
		z.literal("topic"),
		z.literal("person"),
		z.literal("category"),
		z.literal("scope"),
		z.literal("agent"),
	]),
	label: z.string(),
	memory_id: z.string().optional(),
	normalized: z.string(),
	scope: z.string().optional(),
	scope_id: z.string().optional(),
	sensitive: z.boolean(),
});
const graphResponseSchema = z.looseObject({
	edges: z.array(edgesResponseSchema).optional(),
	memory_count: z.number().optional(),
	nodes: z.array(nodesResponseSchema).optional(),
	truncated: z.boolean().optional(),
});

/** Typed graph projection returned by Core's memory graph endpoint. */
export type MemoryGraphNodeKind =
	| "memory"
	| "topic"
	| "person"
	| "category"
	| "scope"
	| "agent";

export interface MemoryGraphNode {
	agent_id?: string;
	id: string;
	kind: MemoryGraphNodeKind;
	label: string;
	memory_id?: string;
	normalized: string;
	scope?: string;
	scope_id?: string;
	sensitive: boolean;
}

export interface MemoryGraphEdge {
	kind: string;
	memory_id: string;
	source: string;
	target: string;
	weight: number;
}

export interface MemoryGraphSnapshot {
	edges: MemoryGraphEdge[];
	memoryCount: number;
	nodes: MemoryGraphNode[];
	truncated: boolean;
}

/** Fetch the access-filtered typed graph used by the Memory Library. */
export async function getMemoryGraph(
	target: ApiTarget,
	query: {
		agentId?: string;
		maxEdges?: number;
		maxNodes?: number;
		projectId?: string;
	} = {}
): Promise<MemoryGraphSnapshot> {
	const params = new URLSearchParams();
	if (query.agentId) {
		params.set("agent_id", query.agentId);
	}
	if (query.projectId) {
		params.set("project_id", query.projectId);
	}
	if (query.maxNodes !== undefined) {
		params.set("max_nodes", String(query.maxNodes));
	}
	if (query.maxEdges !== undefined) {
		params.set("max_edges", String(query.maxEdges));
	}
	const suffix = params.toString();
	const graph = await request(
		target,
		suffix ? `/api/memory/graph?${suffix}` : "/api/memory/graph",
		undefined,
		graphResponseSchema
	);
	return {
		edges: graph.edges ?? [],
		memoryCount: graph.memory_count ?? 0,
		nodes: graph.nodes ?? [],
		truncated: graph.truncated ?? false,
	};
}
