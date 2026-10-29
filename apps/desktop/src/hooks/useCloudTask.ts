// apps/desktop/src/hooks/useCloudTask.ts
//
// Live status of a conversation's cloud task for the composer's CloudTaskPanel.
// The query is keyed by the node's base URL and credentials, asks that node's
// Core directly, and is bounded by a timeout. While the task is moving
// (preparing, running, finishing) it polls every few seconds; once it settles
// the poll stops until a mutation invalidates the key.
//
// The query THROWS on an older Core without the route or an unreachable node,
// leaving `data` undefined — the panel hides. `null` means Core has no task for
// this owner yet, which also renders nothing.

import { useQuery } from "@tanstack/react-query";

import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type CloudTaskStatus,
	fetchCloudTask,
} from "@/src/lib/api/cloud-tasks.ts";

export const CLOUD_TASK_QUERY_KEY = "cloud-task";

const REFRESH_MS = 3000;
const TIMEOUT_MS = 6000;
const MOVING_STATES = new Set(["preparing", "running", "finishing"]);

export function useCloudTask(
	target: ApiTarget,
	conversationId: string,
	enabled: boolean
) {
	return useQuery<CloudTaskStatus | null>({
		queryKey: [
			CLOUD_TASK_QUERY_KEY,
			target.url,
			target.token ?? null,
			target.userJwt ?? null,
			conversationId,
		],
		queryFn: ({ signal }) => {
			// Abort whichever fires first: query teardown or the request timeout.
			const merged = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
			return fetchCloudTask(target, conversationId, merged);
		},
		enabled,
		retry: false,
		refetchInterval: (query) => {
			const task = query.state.data;
			return MOVING_STATES.has(task?.state ?? "") || task?.activeRun
				? REFRESH_MS
				: false;
		},
	});
}
