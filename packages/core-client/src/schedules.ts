// apps/desktop/src/lib/api/schedules.ts
//
// Typed client for Core's scheduled-jobs (heartbeat) endpoints. A scheduled job
// fires on a cron expression or a fixed interval and runs a persisted workflow, a
// one-shot agent prompt, or a job Core owns (see `SystemJobTarget`). Routes live at the top level on Core
// (`/heartbeat/jobs`), NOT under `/api`. Consumed by the schedules page via the
// `useSchedules` hook.
//
// Note: this module does its own POST rather than reusing the shared `request`
// helper for creation, because Core surfaces validation failures (bad cron /
// interval) as a 400 with a `{ success: false, error }` body. The shared helper
// throws a generic status-only error and discards that body, so we read the
// JSON here to surface the exact Core validation message in the UI.

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";

import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
	request,
} from "./client.ts";

/** How a job is scheduled: a cron expression or a fixed interval. */
export type Schedule =
	| { kind: "cron"; expr: string; tz?: string | null }
	| { kind: "every"; interval: string };

/** A target a client can create: a workflow or a one-shot agent prompt. */
export type CreatableJobTarget =
	| { type: "workflow"; workflowId: string; input?: Record<string, string> }
	| {
			type: "agent";
			agentId: string;
			prompt: string;
			model?: string | null;
			conversationId?: string | null;
	  };

/**
 * A job Core owns and reconciles itself (an app's scheduled job, a quest check,
 * a maintenance sweep, or a target type this client does not know yet). `kind`
 * is the wire `type`; `pluginId` / `jobId` name an app job's owner. Read-only:
 * clients render it but never create or retarget one.
 */
export interface SystemJobTarget {
	jobId?: string;
	kind: string;
	pluginId?: string;
	type: "system";
}

/** What a job runs when it fires. */
export type JobTarget = CreatableJobTarget | SystemJobTarget;

/** A short read-only label for a job Core owns: its app, else its kind. */
export function systemTargetLabel(target: SystemJobTarget): string {
	return target.pluginId ? `app ${target.pluginId}` : `system ${target.kind}`;
}

/** Outcome of a single recorded job execution. */
export type ExecOutcome = "success" | "failure";

/** One recorded execution of a job (newest last in {@link ScheduledJob.history}). */
export interface ExecRecord {
	error: string | null;
	finishedAt: string;
	outcome: ExecOutcome;
	runId: string | null;
	startedAt: string;
}

/** A persisted scheduled job as returned by Core. */
export interface ScheduledJob {
	createdAt: string;
	enabled: boolean;
	history: ExecRecord[];
	id: string;
	lastOutcome: ExecOutcome | null;
	lastRunAt: string | null;
	name: string;
	schedule: Schedule;
	/** True when Core owns the job (a {@link SystemJobTarget}): render it read-only. */
	system: boolean;
	target: JobTarget;
	updatedAt: string;
}

/** Fields the UI sends when creating a job. */
export interface JobInput {
	enabled: boolean;
	name: string;
	quickRoutine?: boolean;
	requireApproval?: boolean;
	schedule: Schedule;
	target: CreatableJobTarget;
}

// ── Wire shapes (snake_case, tagged unions exactly as Core serializes them) ──

interface ScheduleWire {
	expr?: string;
	interval?: string;
	kind: "cron" | "every";
	tz?: string | null;
}

interface TargetWire {
	agent_id?: string;
	conversation_id?: string | null;
	input?: Record<string, string>;
	job_id?: string;
	model?: string | null;
	plugin_id?: string;
	prompt?: string;
	type: string;
	workflow_id?: string;
}

interface ExecRecordWire {
	error?: string | null;
	finished_at: string;
	outcome: ExecOutcome;
	run_id?: string | null;
	started_at: string;
}

interface JobWire {
	created_at: string;
	enabled?: boolean | null;
	history?: ExecRecordWire[] | null;
	id: string;
	last_outcome?: ExecOutcome | null;
	last_run_at?: string | null;
	name: string;
	schedule: ScheduleWire;
	target: TargetWire;
	updated_at: string;
}

const scheduledInputFields = z.record(z.string(), z.string());
const scheduledInputString = z.string();
const scheduledWorkflowInput = z.custom<z.output<typeof scheduledInputFields>>(
	(value) =>
		scheduledInputFields.safeParse(value).success &&
		Object.entries(Object.call(undefined, value)).every(
			([, entry]) => scheduledInputString.safeParse(entry).success
		)
);
/** Target types this client validates field by field. */
const KNOWN_TARGET_TYPES = new Set([
	"workflow",
	"agent",
	"app_job",
	"monitor",
	"quest",
	"identity_health",
	"learning_cycle",
]);
// Known types are checked strictly; a type a newer Core adds is accepted with
// its fields kept, so one new row never fails the whole list.
const scheduledTargetFields = z.union([
	z.object({
		type: z.literal("workflow"),
		workflow_id: z.string().optional(),
		input: scheduledWorkflowInput.optional(),
	}),
	z.object({
		type: z.literal("agent"),
		agent_id: z.string().optional(),
		prompt: z.string().optional(),
		model: z.string().nullable().optional(),
		conversation_id: z.string().nullable().optional(),
	}),
	z.object({
		type: z.literal("app_job"),
		plugin_id: z.string(),
		job_id: z.string(),
		payload: z.record(z.string(), z.unknown()).nullable().optional(),
	}),
	z.object({ type: z.literal("monitor"), monitor_id: z.string() }),
	z.object({ type: z.literal("quest"), quest_id: z.string() }),
	z.object({ type: z.literal("identity_health") }),
	z.object({ type: z.literal("learning_cycle") }),
	z
		.object({
			type: z.string().refine((type) => !KNOWN_TARGET_TYPES.has(type)),
		})
		.passthrough(),
]);
const scheduledTargetResponse = z.custom<
	z.output<typeof scheduledTargetFields>
>((value) => scheduledTargetFields.safeParse(value).success);
export const scheduledScheduleFields = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("cron"),
		expr: z.string().optional(),
		tz: z.string().nullable().optional(),
	}),
	z.object({ kind: z.literal("every"), interval: z.string().optional() }),
]);
const scheduledRecordFields = z.object({
	started_at: z.string(),
	finished_at: z.string(),
	outcome: z.enum(["success", "failure"]),
	run_id: z.string().nullable().optional(),
	error: z.string().nullable().optional(),
});
const scheduledJobFields = z.object({
	id: z.string(),
	name: z.string(),
	schedule: scheduledScheduleFields,
	target: scheduledTargetResponse,
	enabled: z.boolean().nullable().optional(),
	require_approval: z.boolean().optional(),
	owner_app: z.string().nullable().optional(),
	owner_user_id: z.string().nullable().optional(),
	org_id: z.string().nullable().optional(),
	created_at: z.string(),
	updated_at: z.string(),
	last_run_at: z.string().nullable().optional(),
	last_outcome: z.enum(["success", "failure"]).nullable().optional(),
	history: z.array(scheduledRecordFields).nullable().optional(),
});
const scheduledJobResponse = z.custom<z.output<typeof scheduledJobFields>>(
	(value) => scheduledJobFields.safeParse(value).success
);
const scheduledCreateResponse = z.object({
	success: z.boolean().optional(),
	job: scheduledJobResponse,
});
const scheduledErrorResponse = z.object({ error: z.string() });

// Reuse the existing whole native ScheduledJob owner and its complete target,
// schedule, execution-history and tenancy fields; keep raw publisher references.
const scheduledListFieldsSchema = z.object({
	jobs: z.array(scheduledJobResponse).nullish(),
});
export const scheduledListResponseSchema = z.custom<
	z.output<typeof scheduledListFieldsSchema>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		scheduledListFieldsSchema.safeParse(value).success
);
const scheduledDeleteFieldsSchema = z.object({ success: z.boolean() });
const scheduledDeleteResponseSchema = z.custom<
	z.output<typeof scheduledDeleteFieldsSchema>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		scheduledDeleteFieldsSchema.safeParse(value).success
);

function toSchedule(s: ScheduleWire): Schedule {
	if (s.kind === "cron") {
		const schedule: Schedule = { kind: "cron", expr: s.expr ?? "" };
		if (s.tz !== undefined) {
			schedule.tz = s.tz;
		}
		return schedule;
	}
	return { kind: "every", interval: s.interval ?? "" };
}

function toSystemTarget(t: TargetWire): SystemJobTarget {
	const target: SystemJobTarget = { type: "system", kind: t.type };
	if (t.plugin_id !== undefined) {
		target.pluginId = t.plugin_id;
	}
	if (t.job_id !== undefined) {
		target.jobId = t.job_id;
	}
	return target;
}

function toTarget(t: TargetWire): JobTarget {
	if (t.type === "workflow") {
		return {
			type: "workflow",
			workflowId: t.workflow_id ?? "",
			input: t.input,
		};
	}
	if (t.type !== "agent") {
		return toSystemTarget(t);
	}
	const target: CreatableJobTarget = {
		type: "agent",
		agentId: t.agent_id ?? "",
		prompt: t.prompt ?? "",
	};
	if (t.model !== undefined) {
		target.model = t.model;
	}
	if (t.conversation_id !== undefined) {
		target.conversationId = t.conversation_id;
	}
	return target;
}

function toRecord(r: ExecRecordWire): ExecRecord {
	return {
		startedAt: r.started_at,
		finishedAt: r.finished_at,
		outcome: r.outcome,
		runId: r.run_id ?? null,
		error: r.error ?? null,
	};
}

function toJob(j: JobWire): ScheduledJob {
	const target = toTarget(j.target);
	return {
		id: j.id,
		name: j.name,
		schedule: toSchedule(j.schedule),
		system: target.type === "system",
		target,
		enabled: j.enabled ?? true,
		createdAt: j.created_at,
		updatedAt: j.updated_at,
		lastRunAt: j.last_run_at ?? null,
		lastOutcome: j.last_outcome ?? null,
		history: (j.history ?? []).map(toRecord),
	};
}

function toScheduleBody(s: Schedule) {
	if (s.kind === "cron") {
		const schedule: ScheduleWire = { kind: "cron", expr: s.expr };
		if (s.tz !== undefined) {
			schedule.tz = s.tz;
		}
		return schedule;
	}
	return { kind: "every", interval: s.interval };
}

function toTargetBody(t: CreatableJobTarget) {
	if (t.type === "workflow") {
		return {
			type: "workflow",
			workflow_id: t.workflowId,
			input: t.input ?? {},
		};
	}
	const target: TargetWire = {
		type: "agent",
		agent_id: t.agentId,
		prompt: t.prompt,
	};
	if (t.model !== undefined) {
		target.model = t.model;
	}
	if (t.conversationId !== undefined) {
		target.conversation_id = t.conversationId;
	}
	return target;
}

function toJobBody(input: JobInput) {
	const body = {
		name: input.name,
		schedule: toScheduleBody(input.schedule),
		target: toTargetBody(input.target),
		enabled: input.enabled,
		require_approval: input.requireApproval ?? false,
	};
	if (input.quickRoutine !== undefined) {
		Object.assign(body, { quick_routine: input.quickRoutine });
	}
	return body;
}

/**
 * List all scheduled jobs on the active node, including the jobs Core reconciles
 * for apps (`include=app_jobs`; an older Core ignores the parameter).
 */
export async function fetchJobs(target: ApiTarget): Promise<ScheduledJob[]> {
	const json = await request(
		target,
		"/heartbeat/jobs?include=app_jobs",
		{},
		scheduledListResponseSchema
	);
	return (json.jobs ?? []).map(toJob);
}

/**
 * Create a scheduled job.
 *
 * On a 400 (invalid cron/interval) Core returns `{ success: false, error }`.
 * We read that body and throw an {@link Error} carrying the exact Core message
 * so the form can surface the real validation error, not a bare status code.
 */
export async function createJob(
	target: ApiTarget,
	input: JobInput
): Promise<ScheduledJob> {
	const resp = await fetchForTarget(target)(apiUrl(target, "/heartbeat/jobs"), {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
		body: JSON.stringify(toJobBody(input)),
	});
	const text = await resp.text();
	const json = text ? JSON.parse(text) : {};
	if (!resp.ok) {
		const parsed = scheduledErrorResponse.safeParse(json);
		const message = parsed.success
			? parsed.data.error
			: `Failed to create job (${resp.status})`;
		throw new Error(message);
	}
	return toJob(scheduledCreateResponse.parse(json).job);
}

/** Delete a scheduled job by id. */
export async function deleteJob(target: ApiTarget, id: string): Promise<void> {
	await request(
		target,
		`/heartbeat/jobs/${id}`,
		{ method: "DELETE" },
		scheduledDeleteResponseSchema
	);
}
