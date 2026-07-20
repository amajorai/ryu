// apps/desktop/src/lib/api/connections.ts
//
// Typed client for Core's connected-client presence surface
// (`GET /api/connections`). This is the "who's on this node" view: every client
// that talks to a node declares an identity (client id, label, surface, and —
// when signed in — user id/name), and Core keeps a short-TTL in-memory registry
// of who has been active recently.
//
// IMPORTANT: this is presence/attribution, NOT verified identity or access
// control. Identities are self-declared behind the shared node token and the
// data model is single-tenant, so the panel answers "who is here", never "who is
// allowed to see what". See apps/core/src/connections for the full rationale.

import { type ApiTarget, request } from "./client.ts";

/** One currently-connected client (normalized to camelCase). */
export interface ConnectedClient {
	/** Stable per-install id — the dedup key. */
	clientId: string;
	/** Short device label, e.g. "Desktop", "CLI", "Phone". */
	clientLabel: string | null;
	/** Unix seconds of the first request seen from this client. */
	firstSeen: number;
	/** Unix seconds of the most recent request seen from this client. */
	lastSeen: number;
	/** Surface kind, e.g. "desktop" | "cli" | "mobile". */
	surface: string | null;
	/** Declared user id (the desktop sends the control-plane email), or null. */
	userId: string | null;
	/** Human display name, or null when signed out. */
	userName: string | null;
}

/** Normalized snapshot of who is connected to a node. */
export interface ConnectionsSnapshot {
	/** Number of distinct connected clients. */
	clientCount: number;
	clients: ConnectedClient[];
	/** Seconds of inactivity before a client ages out of the list. */
	ttlSecs: number;
	/** Number of distinct declared users (anonymous clients count individually). */
	userCount: number;
}

// ── Raw wire shapes (snake_case, as Core emits) ───────────────────────────────

interface RawClient {
	client_id?: string;
	client_label?: string | null;
	first_seen?: number;
	last_seen?: number;
	surface?: string | null;
	user_id?: string | null;
	user_name?: string | null;
}

interface RawConnections {
	client_count?: number;
	data?: RawClient[];
	ttl_secs?: number;
	user_count?: number;
}

function normalizeClient(raw: RawClient): ConnectedClient {
	return {
		userId: raw.user_id ?? null,
		userName: raw.user_name ?? null,
		clientId: raw.client_id ?? "",
		clientLabel: raw.client_label ?? null,
		surface: raw.surface ?? null,
		firstSeen: raw.first_seen ?? 0,
		lastSeen: raw.last_seen ?? 0,
	};
}

/**
 * Fetch the clients currently connected to a node (`GET /api/connections`).
 *
 * Throws on any non-2xx (including 404 on an older Core without the surface) so
 * the caller can map the failure to an empty/null state and hide the panel.
 */
export async function fetchConnections(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<ConnectionsSnapshot> {
	const raw = await request<RawConnections>(target, "/api/connections", {
		signal,
	});
	return {
		clients: (raw.data ?? []).map(normalizeClient),
		clientCount: raw.client_count ?? 0,
		userCount: raw.user_count ?? 0,
		ttlSecs: raw.ttl_secs ?? 90,
	};
}
