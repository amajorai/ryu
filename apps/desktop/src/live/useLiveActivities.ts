// apps/desktop/src/live/useLiveActivities.ts
//
// The aggregate live-activity hook: mounts every producer ONCE (the built-in
// adapters for agent runs / downloads / operations / approvals / meetings, plus the
// contributed `contributes.live_activities` adapter) and exposes the ordered
// card list for the shell's render surfaces. Call this once from a component
// that is always mounted (LayoutContent), like the other app-wide stream hooks.

import { useAgentRunLiveActivities } from "./adapters/agent-runs.ts";
import { useApprovalLiveActivities } from "./adapters/approvals.ts";
import { useContributedLiveActivities } from "./adapters/contributed.ts";
import { useDownloadLiveActivities } from "./adapters/downloads.ts";
import { useMeetingLiveActivities } from "./adapters/meetings.ts";
import { useOperationLiveActivities } from "./adapters/operations.ts";

export function useLiveActivities(): void {
	useAgentRunLiveActivities();
	useDownloadLiveActivities();
	useOperationLiveActivities();
	useApprovalLiveActivities();
	useMeetingLiveActivities();
	useContributedLiveActivities();
}

export type {
	LiveActivity,
	LiveActivityStatus,
} from "@ryu/app-host/live-activity";
export { isLiveStatus } from "@ryu/app-host/live-activity";
