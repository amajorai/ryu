// apps/desktop/src/hooks/useNodeSystemInfo.ts
//
// Per-node live hardware snapshot (CPU/RAM/disk/GPU) for the node selector. Each
// node runs its own Core, so this keys the query by the node's base URL and asks
// that node directly. It is gated on `enabled` (the caller passes the node's
// online state) so we never fire at an unreachable node, and every request is
// bounded by a timeout so a node that went down mid-poll can't hang the fetch.

import { useQuery } from "@tanstack/react-query";

import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchSystemInfo, type SystemInfo } from "@/src/lib/api/system.ts";

const REFRESH_MS = 30_000;
const TIMEOUT_MS = 6000;

export function useNodeSystemInfo(target: ApiTarget, enabled: boolean) {
	return useQuery<SystemInfo>({
		queryKey: ["node-system-info", target.url],
		queryFn: ({ signal }) => {
			// Bound the request so an unreachable node can't leave it pending until the
			// OS TCP timeout; abort whichever fires first (query teardown or timeout).
			const merged = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
			return fetchSystemInfo(target, merged);
		},
		enabled,
		refetchInterval: REFRESH_MS,
		staleTime: REFRESH_MS / 2,
		retry: false,
	});
}
