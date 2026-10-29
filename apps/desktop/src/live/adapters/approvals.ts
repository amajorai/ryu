// apps/desktop/src/live/adapters/approvals.ts
//
// Built-in live-activity adapter for PENDING APPROVALS — the "needs your input"
// card. Reads the existing approvals react-query cache (invalidated live by
// `useApprovalEvents`, mounted app-wide) and publishes one card per pending
// request. A decided request is removed by the reconcile pass. Tapping the card
// opens the approval inbox.

import type { LiveActivity } from "@ryu/app-host/live-activity";
import { useEffect } from "react";
import { useApprovals } from "@/src/hooks/useApprovals.ts";
import type { ApprovalRequest } from "@/src/lib/api/approvals.ts";
import { useLiveActivityStore } from "@/src/store/useLiveActivityStore.ts";

const KIND_LABELS = new Map<string, string>([
	["tool_call", "Tool call"],
	["workflow_gate", "Workflow gate"],
	["scheduled_run", "Scheduled run"],
	["trigger_run", "Trigger run"],
	["skill_synthesis", "Skill synthesis"],
	["heal_fix", "Heal fix"],
]);

function approvalToActivity(request: ApprovalRequest): LiveActivity {
	const kindLabel = KIND_LABELS.get(request.kind) ?? request.kind;
	const detail =
		request.summary || (request.title === kindLabel ? "" : request.title);
	return {
		id: `approval:${request.id}`,
		appId: "shell",
		kind: "approval",
		title: `${kindLabel} · ${request.title}`,
		detail: detail || "Waiting for your decision",
		status: "waiting",
		icon: "message-circle-question",
		startedAt: new Date(request.created_at).getTime(),
		updatedAt: new Date(request.created_at).getTime(),
		action: { kind: "route", path: "/inbox" },
	};
}

/** Reconcile the pending approval set against the registry. */
function reconcile(approvals: ApprovalRequest[]) {
	const store = useLiveActivityStore.getState();
	const pending = approvals.filter((a) => a.status === "pending");
	const desired = pending.map(approvalToActivity);
	store.applySourceSnapshot("shell", "approval", desired);
}

/** Mount ONE app-wide reconciliation of pending approvals → live activities. The
 *  approvals query is invalidated by the approval-event stream, so this stays
 *  live without its own subscription. */
export function useApprovalLiveActivities(): void {
	const { approvals } = useApprovals();

	useEffect(() => {
		reconcile(approvals);
	}, [approvals]);
}
