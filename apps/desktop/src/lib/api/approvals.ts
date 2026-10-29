import {
	approvalRequestSchema,
	type PendingAction,
} from "@ryuhq/core-client/approvals";
import { z } from "zod";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";

export type { PendingAction } from "@ryuhq/core-client/approvals";

// apps/desktop/src/lib/api/approvals.ts
//
// Typed client for the Core approval-inbox API (`/api/approvals/*`): the
// human-in-the-loop queue of actions awaiting the user's go-ahead. Field names
// are snake_case to match Core's serde shapes exactly. The event SSE stream uses
// fetch + ReadableStream (not EventSource) so the bearer token can be attached,
// mirroring the quests/monitors streams.

import { type ApiTarget, request } from "./client.ts";
import { streamChannel } from "./eventStream.ts";
import { encodePathId } from "./path-id.ts";

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
	/** First-person intent shown above the approval summary when available. */
	question?: string | null;
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

const approvalEventFields = z.discriminatedUnion("type", [
	z.object({ type: z.literal("created"), request: approvalRequestSchema }),
	z.object({ type: z.literal("decided"), request: approvalRequestSchema }),
]);
const approvalEventSchema = z.custom<z.output<typeof approvalEventFields>>(
	(value) => approvalEventFields.safeParse(value).success
);

const approvalListSchema = z
	.object({ approvals: z.array(approvalRequestSchema).optional() })
	.passthrough();
const approvalResultSchema = z
	.object({
		approval: approvalRequestSchema.optional(),
		error: z.string().optional(),
	})
	.passthrough();
const approvalModeSchema = z
	.object({ mode: z.string().optional() })
	.passthrough();

/** The approvals list path. Opts in to app-job approvals (`include=app_jobs`),
 *  which Core omits for released clients: an approval raised by a migrated monitor
 *  job is still decided from this inbox. */
export function approvalsListPath(status?: ApprovalStatus): string {
	const query = new URLSearchParams();
	if (status) {
		query.set("status", status);
	}
	query.set("include", "app_jobs");
	return `/api/approvals?${query.toString()}`;
}

export async function listApprovals(
	target: ApiTarget,
	status?: ApprovalStatus
): Promise<ApprovalRequest[]> {
	const path = approvalsListPath(status);
	const json = await request(target, path, undefined, approvalListSchema);
	return json.approvals ?? [];
}

export async function getApproval(
	target: ApiTarget,
	id: string
): Promise<ApprovalRequest | null> {
	const json = await request(
		target,
		`/api/approvals/${encodePathId(id)}`,
		undefined,
		approvalResultSchema
	);
	return json.approval ?? null;
}

export async function approveApproval(
	target: ApiTarget,
	id: string,
	note?: string
): Promise<ApprovalRequest> {
	return await decide(
		target,
		`/api/approvals/${encodePathId(id)}/approve`,
		note
	);
}

export async function rejectApproval(
	target: ApiTarget,
	id: string,
	note?: string
): Promise<ApprovalRequest> {
	return await decide(
		target,
		`/api/approvals/${encodePathId(id)}/reject`,
		note
	);
}

export async function getApprovalMode(
	target: ApiTarget
): Promise<ApprovalMode> {
	const json = await request(
		target,
		"/api/approvals/mode",
		undefined,
		approvalModeSchema
	);
	return z.enum(["off", "smart", "manual"]).catch("off").parse(json.mode);
}

export async function setApprovalMode(
	target: ApiTarget,
	mode: ApprovalMode
): Promise<void> {
	await request(
		target,
		"/api/approvals/mode",
		{
			method: "PUT",
			body: { mode },
		},
		gatewayJsonValueSchema
	);
}

async function decide(
	target: ApiTarget,
	path: string,
	note?: string
): Promise<ApprovalRequest> {
	const json = await request(
		target,
		path,
		{ method: "POST", body: note ? { note } : {} },
		approvalResultSchema
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
 * `onResync` runs after that connection re-opens, since events emitted while it
 * was down are not replayed.
 */
export function streamApprovalEvents(
	target: ApiTarget,
	onEvent: (event: ApprovalEvent) => void,
	signal?: AbortSignal,
	onResync?: () => void
): Promise<void> {
	return streamChannel(
		target,
		"approvals",
		onEvent,
		signal,
		approvalEventSchema,
		{ onResync }
	);
}
