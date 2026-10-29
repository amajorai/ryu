// The live gateway canvas model (managed guardrails spec 07.4): the topology
// a host hands the canvas, the pulses that animate it, and the pure helpers
// that turn a redacted traffic event into a pulse. Nothing here renders or
// fetches, so the desktop, the web console and the tests share one mapping.

import type { ReactNode } from "react";

export type CanvasNodeKind =
	/** Where requests come from: an API family, an SDK, a channel. */
	| "surface"
	/** A gateway replica or the local node. */
	| "gateway"
	/** A fixed pipeline stage or screener. */
	| "stage"
	/** A policy layer: org, team, member, key or agent. */
	| "scope"
	/** An upstream slot, badged with whose credential it spends. */
	| "provider"
	/** Supporting infrastructure: control plane, Core, enforcement channel. */
	| "infra";

export type CanvasHealth = "ok" | "degraded" | "down";

export interface CanvasNodeCounters {
	blocked: number;
	costMicroUsd?: number;
	p50Ms?: number;
	requests: number;
}

export interface CanvasNodeRef {
	assignmentId?: string;
	policyId?: string;
	scope?: { id: string; kind: string };
	slotId?: string;
}

export interface CanvasNode {
	/** A short second line ("3 policies", "Ryu-held credentials only"). */
	detail?: string;
	/**
	 * Nodes that share a group stack in one column, in traffic order, so a
	 * ladder of layers reads top to bottom instead of running off the side.
	 */
	group?: string;
	health?: CanvasHealth;
	id: string;
	kind: CanvasNodeKind;
	label: string;
	/** Fixed by Ryu or by the pipeline: the platform floor, fixed stages. */
	locked?: boolean;
	ref?: CanvasNodeRef;
}

export type CanvasEdgeKind =
	/** Requests flow along it. */
	| "traffic"
	/** A policy applies at its target. */
	| "assignment"
	/** Configuration or health, not requests (infrastructure links). */
	| "control";

export interface CanvasEdge {
	from: string;
	id: string;
	kind: CanvasEdgeKind;
	to: string;
}

export interface CanvasTopology {
	edges: CanvasEdge[];
	nodes: CanvasNode[];
	/** Changes only when nodes or edges change, never on a traffic tick. */
	version: string;
}

export type PulseOutcome =
	| "allow"
	| "block"
	| "redacted"
	| "cache_hit"
	| "degraded"
	| "error";

export interface TrafficPulse {
	/** Category codes the deciding layer named (S-codes or taxonomy ids). */
	codes?: string[];
	costMicroUsd?: number;
	latencyMs?: number;
	/** The node a blocked pulse stopped at. */
	layer?: string;
	outcome: PulseOutcome;
	/** Node ids the request passed, in order. A block ends at its layer. */
	path: string[];
	requestId?: string;
}

/** Counter snapshots by node id, for hosts that send aggregates. */
export type CanvasCounterMap = Record<string, CanvasNodeCounters | undefined>;

/** Requests along each link, keyed by edge id (`from->to`), for aggregates. */
export type CanvasLinkCounts = Record<string, number>;

/** A policy the palette offers for dragging onto a policy layer. */
export interface CanvasPolicyChip {
	id: string;
	label: string;
}

/** One concrete scope a policy layer node can take an assignment on. */
export interface CanvasAssignTarget {
	id: string;
	kind: string;
	label: string;
}

/**
 * Drag-to-assign (spec 07.6): the palette's policies, the concrete scopes
 * each policy layer offers, and the write. The write calls the same
 * assignment API as the forms and never replaces an existing assignment, so
 * a second drop on an occupied scope gets the forms' conflict notice.
 */
export interface CanvasAssignment {
	/**
	 * Resolves `false` when the viewer cancelled (a step-up prompt). Rejects
	 * with an `Error` whose message is the notice to show.
	 */
	assign(policyId: string, target: CanvasAssignTarget): Promise<boolean>;
	policies: readonly CanvasPolicyChip[];
	/** Scopes the node accepts a policy on; empty when it takes none. */
	targets(node: CanvasNode): readonly CanvasAssignTarget[];
}

export interface GatewayCanvasAdapter {
	/** Present when the viewer can drag policies onto policy layers. */
	assignment?: CanvasAssignment;
	/** Whether the viewer may save changes from the side panel. */
	canEdit: boolean;
	/** The side panel body for a selected node: forms or a read-only summary. */
	renderEditor(node: CanvasNode): ReactNode;
	/**
	 * Start the feed. Per-request hosts call `onPulse`; aggregated hosts call
	 * `onCounters` with whole snapshots, and may pass link counts with them.
	 * Returns the unsubscribe function.
	 */
	subscribe?(
		onPulse: (pulse: TrafficPulse) => void,
		onCounters: (counters: CanvasCounterMap, links?: CanvasLinkCounts) => void
	): () => void;
	topology: CanvasTopology;
}

export type CanvasFeedStatus =
	| "live"
	| "connecting"
	| "unavailable"
	| "denied"
	| "aggregated"
	| "off";

export interface CanvasFeedState {
	message?: string;
	status: CanvasFeedStatus;
}

/**
 * Whether requests pass through a node. Infrastructure carries configuration
 * and health, never requests, so it has no counts to draw.
 */
export function carriesRequests(node: CanvasNode): boolean {
	return node.kind !== "infra";
}

// ── Ids ──────────────────────────────────────────────────────────────────────

export const GATEWAY_NODE_ID = "gateway";
export const ROUTE_NODE_ID = "stage:route";
export const OTHER_PROVIDER_ID = "provider:other";

/**
 * Every layer a request can pass between the gateway and the router, in the
 * order the gateway applies them. A topology includes the ones it has.
 */
export const TRAFFIC_CHAIN = [
	"stage:rate_limit",
	"stage:budget",
	"stage:standing",
	"stage:platform_floor",
	"scope:org",
	"scope:team",
	"scope:member",
	"scope:key",
	"scope:agent",
	"stage:node",
	"stage:inspector",
	"stage:evaluator",
	"stage:classifier",
] as const;

export type TrafficChainId = (typeof TRAFFIC_CHAIN)[number];

/** The node each `verdict.decided_by` value names. */
const DECIDED_BY_NODE: Record<string, TrafficChainId> = {
	agent: "scope:agent",
	budget: "stage:budget",
	evaluator: "stage:evaluator",
	inspector: "stage:inspector",
	node: "stage:node",
	org: "scope:org",
	platform_floor: "stage:platform_floor",
	rate_limit: "stage:rate_limit",
	standing: "stage:standing",
};

/** Audit `provider` tags written by guardrail rows, not by an upstream. */
const MARKER_PROVIDERS = new Set([
	"none",
	"credits-debit",
	"evaluator",
	"inspector",
	"firewall",
	"companion-dlp",
	"gateway",
	"",
]);

export function providerNodeId(provider: string): string {
	return `provider:${provider}`;
}

/** The surface node a route template belongs to. */
export function surfaceForRoute(route: string | null | undefined): string {
	if (!route) {
		return "surface:other";
	}
	if (route.startsWith("/passthrough/")) {
		return "surface:passthrough";
	}
	if (route.includes("/messages")) {
		return "surface:anthropic";
	}
	if (route.startsWith("/v1/")) {
		return "surface:openai";
	}
	return "surface:other";
}

// ── Wire event ──────────────────────────────────────────────────────────────

/**
 * The fields of a gateway `/v1/traffic` event the canvas reads. Older
 * gateways omit the verdict fields; every one of them is optional here.
 */
export interface CanvasTrafficEvent {
	cache_hit?: boolean;
	error?: string | null;
	kind?: string | null;
	latency_ms?: number;
	provider: string;
	provider_cost_micro_usd?: number | null;
	request_id: string;
	route?: string | null;
	seq?: number | null;
	ts?: string;
	verdict?: {
		action?: string;
		categories?: readonly string[];
		decided_by?: string;
		degraded?: string | null;
	} | null;
}

/** Lookups a topology answers for the pulse mapping, built once per version. */
export interface TopologyIndex {
	/** The chain nodes this topology has, in traffic order. */
	chain: readonly string[];
	has(id: string): boolean;
	providerFor(provider: string): string | null;
	surfaceFor(route: string | null | undefined): string | null;
}

export function indexTopology(topology: CanvasTopology): TopologyIndex {
	const ids = new Set(topology.nodes.map((node) => node.id));
	const chain = TRAFFIC_CHAIN.filter((id) => ids.has(id));
	const firstSurface =
		topology.nodes.find((node) => node.kind === "surface")?.id ?? null;
	return {
		chain,
		has: (id) => ids.has(id),
		providerFor: (provider) => {
			const id = providerNodeId(provider);
			if (ids.has(id)) {
				return id;
			}
			return ids.has(OTHER_PROVIDER_ID) ? OTHER_PROVIDER_ID : null;
		},
		surfaceFor: (route) => {
			const id = surfaceForRoute(route);
			return ids.has(id) ? id : firstSurface;
		},
	};
}

function eventKind(event: CanvasTrafficEvent): string {
	if (event.kind) {
		return event.kind;
	}
	if (event.cache_hit) {
		return "cache_hit";
	}
	return event.error ? "failure" : "completion";
}

function compact(ids: ReadonlyArray<string | null>): string[] {
	return ids.filter((id): id is string => id !== null);
}

/**
 * The pulse one traffic event draws, or `null` when it draws none.
 *
 * One request can publish several rows: a guardrail verdict, rows for the
 * auxiliary calls it made (an inspector model call), and its completion or
 * failure. Only the terminal row draws, and it carries the verdict the
 * gateway noted, so a sanitized request is one pulse, not two.
 */
export function pulseFromEvent(
	event: CanvasTrafficEvent,
	index: TopologyIndex
): TrafficPulse | null {
	const kind = eventKind(event);
	if (kind === "verdict") {
		return null;
	}
	const marker = MARKER_PROVIDERS.has(event.provider);
	if (kind !== "failure" && marker) {
		return null;
	}
	const verdict = event.verdict ?? null;
	const action = verdict?.action ?? "allow";
	const decidedBy = verdict?.decided_by ?? "none";
	const codes = verdict?.categories?.length
		? [...verdict.categories]
		: undefined;
	const head = compact([
		index.surfaceFor(event.route),
		index.has(GATEWAY_NODE_ID) ? GATEWAY_NODE_ID : null,
	]);
	const route = index.has(ROUTE_NODE_ID) ? ROUTE_NODE_ID : null;
	const provider = marker ? null : index.providerFor(event.provider);
	const base = {
		codes,
		latencyMs: event.latency_ms,
		requestId: event.request_id || undefined,
	};

	if (kind === "failure" && action === "block") {
		if (decidedBy === "upstream") {
			const path = compact([...head, ...index.chain, route, provider]);
			return { ...base, layer: path.at(-1), outcome: "block", path };
		}
		const stop = DECIDED_BY_NODE[decidedBy];
		const at = stop ? index.chain.indexOf(stop) : -1;
		// A refusal no layer claims (a bad key, a malformed body) stops at the
		// gateway itself.
		const path = at === -1 ? head : [...head, ...index.chain.slice(0, at + 1)];
		return { ...base, layer: path.at(-1), outcome: "block", path };
	}

	if (kind === "cache_hit") {
		return {
			...base,
			outcome: "cache_hit",
			path: compact([...head, ...index.chain, route]),
		};
	}

	const path = compact([...head, ...index.chain, route, provider]);
	const cost = event.provider_cost_micro_usd ?? undefined;
	if (kind === "failure") {
		return { ...base, costMicroUsd: cost, outcome: "error", path };
	}
	let outcome: PulseOutcome = "allow";
	if (action === "sanitize") {
		outcome = "redacted";
	} else if (verdict?.degraded) {
		outcome = "degraded";
	}
	return { ...base, costMicroUsd: cost, outcome, path };
}

// ── Dedupe ──────────────────────────────────────────────────────────────────

/**
 * Drops events already seen, bounded to `capacity` keys (oldest out first).
 * A reconnect replays the gateway's recent ring; this keeps those rows from
 * counting twice. The sequence number is unique per gateway process; the
 * request id rides along so a restarted gateway's new sequence never
 * collides with the old one.
 */
export function createEventDeduper(capacity = 4096) {
	const seen = new Set<string>();
	const order: string[] = [];
	return (event: CanvasTrafficEvent): boolean => {
		const key =
			typeof event.seq === "number"
				? `${event.seq}:${event.request_id}`
				: `${event.request_id}:${eventKind(event)}:${event.provider}:${event.ts ?? ""}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		order.push(key);
		if (order.length > capacity) {
			const oldest = order.shift();
			if (oldest !== undefined) {
				seen.delete(oldest);
			}
		}
		return true;
	};
}

// ── Pulse budget ────────────────────────────────────────────────────────────

/** Most pulses drawn in any one second (spec 07.5). */
export const MAX_PULSES_PER_SECOND = 30;
/** Of those, how many are kept for blocks so a flood never hides one. */
const BLOCK_RESERVE = 10;

/** A sliding one-second window that admits at most `limit` timestamps. */
function slidingWindow(limit: number) {
	const stamps: number[] = [];
	return (now: number): boolean => {
		while (stamps.length > 0 && (stamps[0] ?? 0) <= now - 1000) {
			stamps.shift();
		}
		if (stamps.length >= limit) {
			return false;
		}
		stamps.push(now);
		return true;
	};
}

/**
 * Which pulses get drawn. Counters always count every event; only drawing is
 * sampled. Blocks have their own share of the budget.
 */
export function createPulseBudget(perSecond = MAX_PULSES_PER_SECOND) {
	const reserve = Math.min(BLOCK_RESERVE, Math.floor(perSecond / 3));
	const blocks = slidingWindow(reserve);
	const others = slidingWindow(perSecond - reserve);
	return (pulse: TrafficPulse, now: number): boolean =>
		pulse.outcome === "block" ? blocks(now) : others(now);
}

// ── Labels ──────────────────────────────────────────────────────────────────

export const OUTCOME_LABELS: Record<PulseOutcome, string> = {
	allow: "Allowed",
	block: "Blocked",
	cache_hit: "Served from cache",
	degraded: "Screened in a reduced mode",
	error: "Failed upstream",
	redacted: "Sanitized",
};

export const NODE_KIND_LABELS: Record<CanvasNodeKind, string> = {
	gateway: "Gateway",
	infra: "Infrastructure",
	provider: "Provider",
	scope: "Policy layer",
	stage: "Stage",
	surface: "Client",
};

export const HEALTH_LABELS: Record<CanvasHealth, string> = {
	degraded: "Degraded",
	down: "Down",
	ok: "Healthy",
};

/** Compact counts: 980, 1.2k, 34k, 1.1M. */
export function formatCount(value: number): string {
	if (value < 1000) {
		return String(value);
	}
	if (value < 10_000) {
		return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	}
	if (value < 1_000_000) {
		return `${Math.round(value / 1000)}k`;
	}
	return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
