// apps/desktop/src/live/adapters/approvals.ts
//
// Built-in live-activity adapter for PENDING APPROVALS — the "needs your input"
// card. Reads the existing approvals react-query cache (invalidated live by
// `useApprovalEvents`, mounted app-wide) and publishes one card per pending
// request. A decided request is removed by the reconcile pass. Tapping the card
// opens the approval inbox.

import type { LiveActivity } from "@ryu/app-host/live-activity";
import { translate as tl } from "@ryu/i18n/core";
import { localizeApproval } from "@ryuhq/core-client/approval-text";
import { useEffect } from "react";
import { useApprovals } from "@/src/hooks/useApprovals.ts";
import type { ApprovalRequest } from "@/src/lib/api/approvals.ts";
import { useLiveActivityStore } from "@/src/store/useLiveActivityStore.ts";

/** Each approval kind's label, read at render time so it follows the locale. */
const KIND_LABELS = new Map<string, () => string>([
	["tool_call", () => tl("Tool call")],
	["workflow_gate", () => tl("Workflow gate")],
	["scheduled_run", () => tl("Scheduled run")],
	["trigger_run", () => tl("Trigger run")],
	["skill_synthesis", () => tl("Skill synthesis")],
	["heal_fix", () => tl("Heal fix")],
]);

function approvalToActivity(request: ApprovalRequest): LiveActivity {
	const kindLabel = KIND_LABELS.get(request.kind)?.() ?? request.kind;
	// Core sends the card wording as messages; render them in this locale.
	const text = localizeApproval(request);
	const detail = text.summary || (text.title === kindLabel ? "" : text.title);
	return {
		id: `approval:${request.id}`,
		appId: "shell",
		kind: "approval",
		title: `${kindLabel} · ${text.title}`,
		detail: detail || tl("Waiting for your decision"),
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
