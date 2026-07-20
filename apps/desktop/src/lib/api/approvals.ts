// apps/desktop/src/lib/api/approvals.ts
//
// Typed client for the Core approval-inbox API (`/api/approvals/*`): the
// human-in-the-loop queue of actions awaiting the user's go-ahead. Field names
// are snake_case to match Core's serde shapes exactly. The event SSE stream uses
// fetch + ReadableStream (not EventSource) so the bearer token can be attached,
// mirroring the quests/monitors streams.

import { type ApiTarget, request } from "./client.ts";
import { streamChannel } from "./eventStream.ts";

export type ApprovalKind =
	| "tool_call"
	| "workflow_gate"
	| "scheduled_run"
	| "trigger_run"
	| "skill_synthesis"
	| "heal_fix";

export type ApprovalStatus =
	| "pending"
	| "approved"
	| "rejected"
	| "expired"
	| "cancelled";

export interface PendingAction {
	type:
		| "scheduled_job"
		| "workflow_resume"
		| "trigger_workflow"
		| "trigger_agent"
		| "activate_skill"
		| "heal_rerun";
	[key: string]: unknown;
}

export interface ApprovalRequest {
	action?: PendingAction | null;
	agent_id?: string | null;
	conversation_id?: string | null;
	created_at: string;
	decided_at?: string | null;
	error?: string | null;
	expires_at?: string | null;
	id: string;
	kind: ApprovalKind;
	note?: string | null;
	result?: string | null;
	risk_tags: string[];
	source_ref?: string | null;
	status: ApprovalStatus;
	summary: string;
	title: string;
}

/** Global approval mode (Layer B): `off` gates nothing, `smart` gates only
 *  risky tools, `manual` gates every tool call. */
export type ApprovalMode = "off" | "smart" | "manual";

// Internally-tagged union mirroring Core's `ApprovalEvent` (`{ "type": ... }`).
export type ApprovalEvent =
	| { type: "created"; request: ApprovalRequest }
	| { type: "decided"; request: ApprovalRequest };

export async function listApprovals(
	target: ApiTarget,
	status?: ApprovalStatus
): Promise<ApprovalRequest[]> {
	const path = status ? `/api/approvals?status=${status}` : "/api/approvals";
	const json = await request<{ approvals?: ApprovalRequest[] }>(target, path);
	return json.approvals ?? [];
}

export async function getApproval(
	target: ApiTarget,
	id: string
): Promise<ApprovalRequest | null> {
	const json = await request<{ approval?: ApprovalRequest }>(
		target,
		`/api/approvals/${id}`
	);
	return json.approval ?? null;
}

export async function approveApproval(
	target: ApiTarget,
	id: string,
	note?: string
): Promise<ApprovalRequest> {
	return await decide(target, `/api/approvals/${id}/approve`, note);
}

export async function rejectApproval(
	target: ApiTarget,
	id: string,
	note?: string
): Promise<ApprovalRequest> {
	return await decide(target, `/api/approvals/${id}/reject`, note);
}

export async function getApprovalMode(
	target: ApiTarget
): Promise<ApprovalMode> {
	const json = await request<{ mode?: string }>(target, "/api/approvals/mode");
	return (json.mode as ApprovalMode) ?? "off";
}

export async function setApprovalMode(
	target: ApiTarget,
	mode: ApprovalMode
): Promise<void> {
	await request(target, "/api/approvals/mode", {
		method: "PUT",
		body: { mode },
	});
}

async function decide(
	target: ApiTarget,
	path: string,
	note?: string
): Promise<ApprovalRequest> {
	const json = await request<{ approval?: ApprovalRequest; error?: string }>(
		target,
		path,
		{ method: "POST", body: note ? { note } : {} }
	);
	if (!json.approval) {
		throw new Error(json.error ?? "decision failed");
	}
	return json.approval;
}

/**
 * Subscribe to approval events and invoke `onEvent` for every event. Resolves
 * when `signal` aborts. Shares the single multiplexed node connection
 * (`/api/events/all`, see eventStream.ts) instead of its own HTTP socket.
 */
export function streamApprovalEvents(
	target: ApiTarget,
	onEvent: (event: ApprovalEvent) => void,
	signal?: AbortSignal
): Promise<void> {
	return streamChannel(target, "approvals", onEvent, signal);
}
