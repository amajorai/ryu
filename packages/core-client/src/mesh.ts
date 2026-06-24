// apps/desktop/src/lib/api/mesh.ts
//
// Typed client for Core's mesh-status surface (`GET /api/mesh/status`,
// Contract 6 of the unified-tool-gateway spec). The endpoint is the canonical
// superset Core emits in snake_case; this module normalizes raw → camelCase.
//
// Null handling is load-bearing (P7 review fix): a vanilla install has mesh
// disabled (`enabled: false`) — that must read as NEUTRAL, never amber. Callers
// map `enabled: false` (and the 404/absent case) to `null` so `resolveTone`
// ignores the mesh slice entirely. Only `enabled && !reachable` is a real
// "mesh down" signal.
//
// The webhook-ingress mode is read from a SEPARATE endpoint
// (`GET /api/webhook-ingress/status`), NOT from mesh-status — the two planes are
// independent (a node can have ingress with mesh off), so folding the field into
// mesh-status would under-report it when mesh is disabled.

import { type ApiTarget, request } from "./client.ts";

/** A peer node on the tailnet, as surfaced in Contract 6. */
export interface MeshPeer {
	/** MagicDNS name (preferred) or first Tailscale IP — what to dial. */
	hostOrDns: string;
	/** Full MagicDNS name, empty when none. */
	magicDnsName: string;
	/** Short node name (P7 display key). */
	name: string;
	/** Whether the peer is currently online on the tailnet. */
	online: boolean;
	/** Peer OS (e.g. "macOS", "windows"). */
	os: string;
	/** Peer's Tailscale IPs. */
	tailscaleIps: string[];
}

/** Normalized mesh status (Contract 6). */
export interface MeshStatus {
	/** `"tailscale"` | `"headscale"` | null. */
	backend: string | null;
	/** Raw `BackendState` passthrough (e.g. "Running", "NeedsLogin"). */
	backendState: string;
	/** Control-plane server URL, when known. */
	controlServer: string | null;
	/** Mesh opted-in at all (`RYU_MESH_ENABLED` truthy). */
	enabled: boolean;
	/** This node's MagicDNS name (trailing dot stripped), or null. */
	magicDnsName: string | null;
	/** Peer nodes on the tailnet. */
	peers: MeshPeer[];
	/** tailscaled client up + authed. Equal to `up`. */
	reachable: boolean;
	/** This node's Tailscale IPs. */
	tailscaleIps: string[];
}

// ── Raw wire shapes (snake_case, as Core emits) ───────────────────────────────

interface RawPeer {
	host_or_dns?: string;
	magic_dns_name?: string;
	name?: string;
	online?: boolean;
	os?: string;
	tailscale_ips?: string[];
}

export interface RawMeshStatus {
	backend?: string | null;
	backend_state?: string;
	control_server?: string | null;
	enabled?: boolean;
	magic_dns_name?: string | null;
	peers?: RawPeer[];
	reachable?: boolean;
	tailscale_ips?: string[];
	up?: boolean;
	webhook_ingress_mode?: string | null;
}

function normalizePeer(raw: RawPeer): MeshPeer {
	return {
		name: raw.name ?? "",
		hostOrDns: raw.host_or_dns ?? "",
		magicDnsName: raw.magic_dns_name ?? "",
		tailscaleIps: raw.tailscale_ips ?? [],
		online: raw.online ?? false,
		os: raw.os ?? "",
	};
}

export function normalizeMeshStatus(raw: RawMeshStatus): MeshStatus {
	return {
		enabled: raw.enabled ?? false,
		// `up` is an alias of `reachable`; prefer `reachable`, fall back to `up`.
		reachable: raw.reachable ?? raw.up ?? false,
		backend: raw.backend ?? null,
		backendState: raw.backend_state ?? "Stopped",
		controlServer: raw.control_server ?? null,
		magicDnsName: raw.magic_dns_name ?? null,
		tailscaleIps: raw.tailscale_ips ?? [],
		peers: (raw.peers ?? []).map(normalizePeer),
	};
}

/**
 * Fetch mesh status via Core (`GET /api/mesh/status`).
 *
 * Throws on any non-2xx (including 404 when the mesh feature is absent) so the
 * caller can map the failure to `null` (neutral). A reachable Core with mesh
 * disabled returns `{ enabled: false }` (HTTP 200) and resolves normally.
 */
export async function fetchMeshStatus(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<MeshStatus> {
	const raw = await request<RawMeshStatus>(target, "/api/mesh/status", {
		signal,
	});
	return normalizeMeshStatus(raw);
}

// ── Webhook-ingress status (read from its own endpoint, soft dependency) ───────

/** Normalized webhook-ingress status (`GET /api/webhook-ingress/status`). */
export interface WebhookIngressStatus {
	/** Backend selector, e.g. "ryu_relay" | "tailscale_funnel" | "cloudflared". */
	kind: string;
	/** Resolved public URL, or null when not yet established. */
	publicUrl: string | null;
	/** Whether ingress can currently receive webhooks (public URL resolved). */
	up: boolean;
}

interface RawWebhookIngressStatus {
	kind?: string;
	public_url?: string | null;
	up?: boolean;
}

/**
 * Fetch webhook-ingress status. Soft dependency: Core always answers HTTP 200,
 * with `up:false` when no public URL is resolved — so callers gate the ingress
 * line on `up && kind`. A Core build without the plane (older binary) 404s, which
 * callers catch and render as no ingress line.
 */
export async function fetchWebhookIngressStatus(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<WebhookIngressStatus> {
	const raw = await request<RawWebhookIngressStatus>(
		target,
		"/api/webhook-ingress/status",
		{ signal }
	);
	return {
		kind: raw.kind ?? "",
		publicUrl: raw.public_url ?? null,
		up: raw.up ?? false,
	};
}
