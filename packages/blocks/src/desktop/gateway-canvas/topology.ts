// Builds a canvas topology from the parts a host knows about. The desktop
// feeds it the local gateway's stages and providers; the web console feeds it
// the organization's policy layers. Both get the same chain order, the same
// node ids and the same edges, so pulses and click-to-edit work the same.

import {
	type CanvasEdge,
	type CanvasHealth,
	type CanvasNode,
	type CanvasNodeRef,
	type CanvasTopology,
	GATEWAY_NODE_ID,
	providerNodeId,
	ROUTE_NODE_ID,
	TRAFFIC_CHAIN,
	type TrafficChainId,
} from "./model.ts";

export interface TopologyPart {
	detail?: string;
	health?: CanvasHealth;
	label: string;
	locked?: boolean;
	ref?: CanvasNodeRef;
}

export interface TopologyInput {
	/** Layers between the gateway and the router, keyed by chain id. */
	chain: Partial<Record<TrafficChainId, TopologyPart>>;
	gateway: TopologyPart;
	/** Supporting services, linked to the gateway by a control edge. */
	infra?: Array<TopologyPart & { id: string }>;
	/** Upstreams by provider name (the audit `provider` tag). */
	providers: Array<TopologyPart & { name: string }>;
	route: TopologyPart;
	/** Clients by surface id (`surface:openai`, `surface:sdk`, ...). */
	surfaces: Array<TopologyPart & { id: string }>;
}

/** Which column group each chain layer stacks in. */
const CHAIN_GROUP: Record<TrafficChainId, string> = {
	"scope:agent": "policy",
	"scope:key": "policy",
	"scope:member": "policy",
	"scope:org": "policy",
	"scope:team": "policy",
	"stage:budget": "admission",
	"stage:classifier": "screening",
	"stage:evaluator": "screening",
	"stage:inspector": "screening",
	"stage:node": "screening",
	"stage:platform_floor": "policy",
	"stage:rate_limit": "admission",
	"stage:standing": "admission",
};

function node(
	id: string,
	kind: CanvasNode["kind"],
	part: TopologyPart,
	group?: string
): CanvasNode {
	return {
		detail: part.detail,
		group,
		health: part.health,
		id,
		kind,
		label: part.label,
		locked: part.locked,
		ref: part.ref,
	};
}

function edge(from: string, to: string, kind: CanvasEdge["kind"]): CanvasEdge {
	return { from, id: `${from}->${to}`, kind, to };
}

/** A stable fingerprint of everything a node renders from the topology. */
function fingerprint(nodes: readonly CanvasNode[]): string {
	return nodes
		.map((entry) =>
			[
				entry.id,
				entry.label,
				entry.detail ?? "",
				entry.health ?? "",
				entry.locked ? "1" : "",
			].join("~")
		)
		.join("|");
}

export function buildTopology(input: TopologyInput): CanvasTopology {
	const nodes: CanvasNode[] = [];
	const edges: CanvasEdge[] = [];

	for (const surface of input.surfaces) {
		nodes.push(node(surface.id, "surface", surface));
		edges.push(edge(surface.id, GATEWAY_NODE_ID, "traffic"));
	}
	nodes.push(node(GATEWAY_NODE_ID, "gateway", input.gateway));

	let previous = GATEWAY_NODE_ID;
	for (const id of TRAFFIC_CHAIN) {
		const part = input.chain[id];
		if (!part) {
			continue;
		}
		const kind = id.startsWith("scope:") ? "scope" : "stage";
		nodes.push(node(id, kind, part, CHAIN_GROUP[id]));
		edges.push(edge(previous, id, "traffic"));
		previous = id;
	}

	nodes.push(node(ROUTE_NODE_ID, "stage", { locked: true, ...input.route }));
	edges.push(edge(previous, ROUTE_NODE_ID, "traffic"));

	for (const provider of input.providers) {
		const id = providerNodeId(provider.name);
		nodes.push(node(id, "provider", provider, "providers"));
		edges.push(edge(ROUTE_NODE_ID, id, "traffic"));
	}

	for (const service of input.infra ?? []) {
		nodes.push(node(service.id, "infra", service));
		edges.push(edge(service.id, GATEWAY_NODE_ID, "control"));
	}

	return { edges, nodes, version: fingerprint(nodes) };
}
