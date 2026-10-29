import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
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

import { BACKEND_URL, getActiveToken } from "@/lib/auth-client.ts";

/** One managed node the active org can reach, as returned by the control plane. */
export interface ManagedNode {
	id: string;
	/** Last time the node was seen (its last `/gateway/resolve`), ISO string. */
	lastSeenAt: string | null;
	name: string;
	orgId: string;
	orgName: string | null;
	/** Personal owner, when this is a personal node. */
	ownerUserId?: string | null;
	/** Scope returned by the control plane's visibility filter. */
	scope?: "org" | "team" | "personal";
	/**
	 * The managed-server row this node runs on, or null when it has none.
	 *
	 * A DIFFERENT id from `id` above, which is the node's GatewayCredential.
	 * Anything addressing `/api/servers/orgs/:orgId/servers/:serverId/...` — the
	 * resize and quiet-hour-zone surfaces — needs this one and cannot derive it.
	 *
	 * Null is a real answer, not a missing field: adopted and resumed nodes are
	 * never linked to a server row, so a surface that needs it must render its
	 * absence rather than guess.
	 */
	serverId?: string | null;
	/** Team scope, when this is a team node. */
	teamId?: string | null;
	/** Publicly-reachable Core base URL the node advertised on registration. */
	url: string;
	/**
	 * Short-lived delegation scoped to this managed node. The wire field retains
	 * its historical name, but the control plane now returns one credential per
	 * node rather than a reusable account JWT shared across the response.
	 */
	userJwt: string | null;
}

const NODES_URL = `${BACKEND_URL.replace(/\/$/, "")}/api/control-plane/nodes`;

/**
 * Fetch the active org's reachable managed nodes. `null` means the scope could
 * not be refreshed; an empty array is a successful response with no reachable
 * nodes. Keeping those states distinct lets the node store remove nodes that
 * left the user's scope without wiping them during an offline refresh.
 */
export async function fetchManagedNodes(): Promise<ManagedNode[] | null> {
	let token: string | null = null;
	try {
		token = getActiveToken();
	} catch {
		// No storage available — treat as signed out.
	}
	if (!token) {
		return null;
	}

	try {
		const resp = await fetch(NODES_URL, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!resp.ok) {
			return null;
		}
		const json = z
			.object({
				nodes: z
					.array(
						z
							.object({
								id: z.string(),
								lastSeenAt: z.string().nullable(),
								name: z.string(),
								orgId: z.string(),
								orgName: z.string().nullable(),
								ownerUserId: z.string().nullish(),
								scope: z.enum(["org", "team", "personal"]).optional(),
								serverId: z.string().nullish(),
								teamId: z.string().nullish(),
								url: z.string(),
								userJwt: z.string().nullish().catch(undefined),
								token: z.string().nullish().catch(undefined),
							})
							.catchall(z.json())
					)
					.optional()
					.catch([]),
				token: z.string().nullish().catch(undefined),
				userJwt: z.string().nullish().catch(undefined),
			})
			.parse(await resp.json());
		const list = Array.isArray(json.nodes) ? json.nodes : [];
		// The per-node `userJwt` field now carries a node-bound delegation for
		// compatibility with the existing Desktop model. Read the old `token`
		// spelling only when talking to an older control plane.
		const shared = isNativeText(json.userJwt)
			? json.userJwt
			: isNativeText(json.token)
				? json.token
				: null;
		return list.map(({ token: legacyToken, ...node }) => ({
			...node,
			userJwt: isNativeText(node.userJwt)
				? node.userJwt
				: isNativeText(legacyToken)
					? legacyToken
					: shared,
		}));
	} catch {
		// Server unreachable / offline — degrade to no managed nodes.
		return null;
	}
}
