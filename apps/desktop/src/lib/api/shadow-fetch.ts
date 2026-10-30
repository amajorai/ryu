// apps/desktop/src/lib/api/shadow-fetch.ts

import { DEFAULT_CORE_URL } from "@/lib/core-url.ts";
import { isLocalNode, useNodeStore } from "@/src/store/useNodeStore.ts";

/**
 * INVARIANT: Shadow is local-only and device-bound.
 *
 * Shadow captures the screen, audio, input, and OCR of the *physical machine the
 * human is sitting at*. That context only has meaning relative to this device, so
 * every Shadow/Timeline/companion call in this module MUST stay pinned to the
 * local machine and must NEVER route through the per-tab node store
 * (`useActiveNode` / `ApiTarget`). Compute (chat, agents, Ghost) is swappable
 * across nodes; sensors are not — capturing a remote/headless node's screen would
 * surface another machine's activity as if it were yours.
 *
 * Do not parameterize this with a node URL. If you need Shadow on a different box,
 * run the desktop on that box.
 *
 * The base is the LOCAL Core's `/api/shadow` proxy (never the per-tab node):
 * `DEFAULT_CORE_URL` is the profile-aware local sidecar URL. Requests use the
 * local node bearer from `useNodeStore`, and Core stamps Shadow's own shared
 * secret on the upstream hop.
 */
const SHADOW_BASE = `${DEFAULT_CORE_URL}/api/shadow`;

/**
 * Shadow is pinned to this desktop's local Core, never the tab's active node.
 * Core requires the local node bearer even on loopback; keep it on this local
 * hop and never pass it to Jev or a model endpoint.
 */
export function shadowFetch(
	path: string,
	init: RequestInit = {}
): Promise<Response> {
	const headers = new Headers(init.headers);
	const token = useNodeStore.getState().nodes.find(isLocalNode)?.token;
	if (token) {
		headers.set("Authorization", `Bearer ${token}`);
	}
	return fetch(`${SHADOW_BASE}${path}`, { ...init, headers });
}
