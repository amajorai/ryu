// apps/desktop/src/hooks/useNodeSandboxes.ts
//
// Per-node list of running sandboxes for the node selector. Each node runs its
// own Core, so this keys the query by the node's base URL and asks that node
// directly (`GET /api/sandboxes`). It is gated on `enabled` (the caller passes
// the node's reachable state) so we never fire at an unreachable node, and every
// request is bounded by a timeout so a node that went down mid-poll can't hang
// the fetch. The interval is short (~7s) so the running set + elapsed times feel
// live.
//
// The query THROWS (rather than returning []) when the node is unreachable or on
// an older Core without the surface, leaving `data` undefined — the caller uses
// that to hide the section, distinct from an empty array (which shows an explicit
// "No sandboxes running").

import { useQuery } from "@tanstack/react-query";

import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchNodeSandboxes, type SandboxRun } from "@/src/lib/api/sandboxes.ts";

const REFRESH_MS = 7000;
const TIMEOUT_MS = 6000;

export function useNodeSandboxes(target: ApiTarget, enabled: boolean) {
	return useQuery<SandboxRun[]>({
		queryKey: ["node-sandboxes", target.url],
		queryFn: ({ signal }) => {
			// Bound the request so an unreachable node can't leave it pending until the
			// OS TCP timeout; abort whichever fires first (query teardown or timeout).
			const merged = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
			return fetchNodeSandboxes(target, merged);
		},
		enabled,
		refetchInterval: REFRESH_MS,
		staleTime: REFRESH_MS / 2,
		retry: false,
	});
}
