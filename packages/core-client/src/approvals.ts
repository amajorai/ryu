// apps/desktop/src/lib/api/approvals.ts (minus the SSE stream — the shared
// client mirrors the desktop surface without the multiplexed event channel,
// the same split as the quests client)
//
// Typed client for the Core approval-inbox API (`/api/approvals/*`): the
// human-in-the-loop queue of actions awaiting the user's go-ahead. Field names
// are snake_case to match Core's serde shapes exactly.

import { z } from "zod";
import {
	appJsonValueSchema,
	appResponseValueSchema,
} from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

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

// Full native queued-action variants from approvals/mod.rs and scheduler/store.rs.
function approvalWire<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const approvalOptionalText = z.string().nullable().optional();
const approvalStringMapFields = z.record(z.string(), z.string());
const approvalStringMap = z.custom<z.output<typeof approvalStringMapFields>>(
	(value) =>
		approvalStringMapFields.safeParse(value).success &&
		Object.entries(Object.call(undefined, value)).every(
			([, entry]) => z.string().safeParse(entry).success
		)
);
/** Job target types this client validates field by field. */
const KNOWN_JOB_TARGET_TYPES = new Set([
	"workflow",
	"agent",
	"app_job",
	"monitor",
	"quest",
	"identity_health",
	"learning_cycle",
]);
// Known types are checked strictly; a type a newer Core adds is accepted with
// its fields kept, so one new row never fails the whole inbox.
const approvalJobTargetSchema = approvalWire(
	z.union([
		z.object({
			type: z.literal("workflow"),
			workflow_id: z.string(),
			input: approvalStringMap,
		}),
		z.object({
			type: z.literal("agent"),
			agent_id: z.string(),
			prompt: z.string(),
			model: approvalOptionalText,
			conversation_id: approvalOptionalText,
		}),
		z.object({
			type: z.literal("app_job"),
			plugin_id: z.string(),
			job_id: z.string(),
			payload: z.record(z.string(), appJsonValueSchema).nullable().optional(),
		}),
		z.object({ type: z.literal("monitor"), monitor_id: z.string() }),
		z.object({ type: z.literal("quest"), quest_id: z.string() }),
		z.object({ type: z.literal("identity_health") }),
		z.object({ type: z.literal("learning_cycle") }),
		z
			.object({
				type: z.string().refine((type) => !KNOWN_JOB_TARGET_TYPES.has(type)),
			})
			.passthrough(),
	])
);
const approvalConnectionScopeSchema = approvalWire(
	z.object({ id: z.string(), toolkit: z.string() })
);
export const pendingApprovalActionSchema = approvalWire(
	z.discriminatedUnion("type", [
		z.object({
			type: z.literal("scheduled_job"),
			target: approvalJobTargetSchema,
			job_id: approvalOptionalText,
		}),
		z.object({ type: z.literal("workflow_resume"), run_id: z.string() }),
		z.object({
			type: z.literal("trigger_workflow"),
			workflow_id: z.string(),
			payload_json: z.string(),
		}),
		z.object({
			type: z.literal("trigger_agent"),
			agent_id: z.string(),
			prompt: z.string(),
		}),
		z.object({
			type: z.literal("activate_skill"),
			slug: z.string(),
			skill_md: z.string(),
		}),
		z.object({
			type: z.literal("heal_rerun"),
			agent_id: approvalOptionalText,
			prompt: z.string(),
		}),
		z.object({ type: z.literal("heal_workflow_rerun"), run_id: z.string() }),
		z.object({
			type: z.literal("app_send_turn"),
			plugin_id: z.string(),
			agent_id: approvalOptionalText,
			conversation_id: z.string(),
			cwd: approvalOptionalText,
			text: z.string(),
			model: approvalOptionalText,
		}),
		z.object({
			type: z.literal("tool_call"),
			tool_id: z.string(),
			arguments: appJsonValueSchema,
			agent_id: approvalOptionalText,
			profile_ids: z.array(z.string()),
			session_id: approvalOptionalText,
			host_conversation_id: approvalOptionalText,
			composio_connection_scope: z
				.array(approvalConnectionScopeSchema)
				.nullable()
				.optional(),
			conversation_scope: z.array(z.string()).nullable().optional(),
			configure_approved: z.boolean(),
		}),
	])
);
export type PendingAction = z.output<typeof pendingApprovalActionSchema>;
export const approvalRequestSchema = approvalWire(
	z.object({
		id: z.string(),
		kind: z.enum([
			"tool_call",
			"workflow_gate",
			"scheduled_run",
			"trigger_run",
			"skill_synthesis",
			"heal_fix",
		]),
		title: z.string(),
		question: approvalOptionalText,
		summary: z.string(),
		agent_id: approvalOptionalText,
		conversation_id: approvalOptionalText,
		source_ref: approvalOptionalText,
		risk_tags: z.array(z.string()),
		status: z.enum(["pending", "approved", "rejected", "expired", "cancelled"]),
		note: approvalOptionalText,
		error: approvalOptionalText,
		result: approvalOptionalText,
		action: pendingApprovalActionSchema.nullable().optional(),
		created_at: z.string(),
		decided_at: approvalOptionalText,
		expires_at: approvalOptionalText,
	})
);
const approvalsListResponseSchema = approvalWire(
	z.object({
		approvals: z.array(approvalRequestSchema).optional(),
		error: z.string().optional(),
	})
);
const approvalItemResponseSchema = approvalWire(
	z.object({
		approval: approvalRequestSchema.optional(),
		error: z.string().optional(),
	})
);

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
	question?: string | null;
	result?: string | null;
	risk_tags: string[];
	source_ref?: string | null;
	status: ApprovalStatus;
	summary: string;
	title: string;
}

/**
 * List approval requests, including the ones that run an app job Core
 * reconciles (`include=app_jobs`; an older Core ignores the parameter).
 */
export async function listApprovals(
	target: ApiTarget,
	status?: ApprovalStatus
): Promise<ApprovalRequest[]> {
	const path = status
		? `/api/approvals?status=${status}&include=app_jobs`
		: "/api/approvals?include=app_jobs";
	const json = await request(target, path, {}, approvalsListResponseSchema);
	return json.approvals ?? [];
}

export async function getApproval(
	target: ApiTarget,
	id: string
): Promise<ApprovalRequest | null> {
	const json = await request(
		target,
		`/api/approvals/${id}`,
		{},
		approvalItemResponseSchema
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

async function decide(
	target: ApiTarget,
	path: string,
	note?: string
): Promise<ApprovalRequest> {
	const json = await request(
		target,
		path,
		{ method: "POST", body: note ? { note } : {} },
		approvalItemResponseSchema
	);
	if (!json.approval) {
		throw new Error(json.error ?? "decision failed");
	}
	return json.approval;
}
