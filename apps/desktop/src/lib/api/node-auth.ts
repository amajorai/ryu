// apps/desktop/src/lib/api/node-auth.ts
//
// Whether a given Core NODE holds an auth token — which is a different question
// from whether this desktop window has a better-auth session. Core's
// `GET /api/auth/status` reports `authenticated: true` exactly when its
// `AuthState` was seeded from a stored token (`auth::load_token()`, see
// `apps/core/src/auth/mod.rs` `AuthState::new`).
//
// That is the SAME token `SyncClient::from_env()` requires
// (`apps/core/src/server/sync.rs` — no token ⇒ `SyncError::Unauthenticated` and the
// sync loop no-ops every tick). So this is the honest precondition to surface next
// to the cross-device sync toggle: without it, "sync on" would be a lie.

import { type ApiTarget, request } from "./client.ts";

interface AuthStatusWire {
	authenticated?: boolean;
	pending?: boolean;
}

/** A node's sign-in state. `null` = unknown (unreachable / older Core). */
export type NodeAuthState = "authenticated" | "signed-out" | null;

/**
 * Read whether the node itself is signed in. Returns `null` rather than throwing
 * when the node can't be reached, so callers can fail OPEN (never lock a control
 * on a status they couldn't read).
 */
export async function getNodeAuthState(
	target: ApiTarget
): Promise<NodeAuthState> {
	try {
		const data = await request<AuthStatusWire>(target, "/api/auth/status");
		return data.authenticated === true ? "authenticated" : "signed-out";
	} catch {
		return null;
	}
}
