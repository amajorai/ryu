// apps/desktop/src/lib/api/managed-nodes.ts
//
// Typed client for the org's managed (Ryu Cloud) nodes (A4 / #501).
//
// Like credits.ts / channels.ts (and unlike the Core-node clients), this targets
// the identity/control-plane server (:3000, BACKEND_URL), authenticated with the
// Better-Auth session bearer token. "Which managed nodes my org can reach" is a
// shared/owned registry fact, so it lives in the control plane, not a local Core
// node. Each node is a GatewayCredential that advertised a `reachableUrl` on its
// `/gateway/resolve` handshake; the server resolves the caller's active org from
// the session, so this route takes no org argument.
//
//   GET /api/control-plane/nodes -> the active org's reachable managed nodes
//
// Hydration is best-effort: a signed-out user, a user without an org, or an
// older server without the route all degrade to an empty list (never an error),
// so the NodeSelector keeps its local + LAN + mesh nodes regardless.

import { BACKEND_URL, TOKEN_KEY } from "@/lib/auth-client.ts";

/** One managed node the active org can reach, as returned by the control plane. */
export interface ManagedNode {
	id: string;
	/** Last time the node was seen (its last `/gateway/resolve`), ISO string. */
	lastSeenAt: string | null;
	name: string;
	orgId: string;
	orgName: string | null;
	/**
	 * Per-org gateway data-plane token this managed node authenticates to the
	 * hosted fleet with (WS4). Null until the control plane (WS3/WS5) mints and
	 * returns it, so hydration degrades gracefully on an older server.
	 */
	token: string | null;
	/** Publicly-reachable Core base URL the node advertised on registration. */
	url: string;
}

const NODES_URL = `${BACKEND_URL.replace(/\/$/, "")}/api/control-plane/nodes`;

/**
 * Fetch the active org's reachable managed nodes. Returns an empty array on any
 * non-2xx (not signed in, no org, route absent) so the caller never has to
 * handle errors: managed-node hydration is purely additive to the local picker.
 */
export async function fetchManagedNodes(): Promise<ManagedNode[]> {
	let token: string | null = null;
	try {
		token = localStorage.getItem(TOKEN_KEY);
	} catch {
		// No storage available — treat as signed out.
	}
	if (!token) {
		return [];
	}

	try {
		const resp = await fetch(NODES_URL, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!resp.ok) {
			return [];
		}
		const json = (await resp.json()) as { nodes?: ManagedNode[] };
		return Array.isArray(json.nodes) ? json.nodes : [];
	} catch {
		// Server unreachable / offline — degrade to no managed nodes.
		return [];
	}
}
