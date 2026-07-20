// apps/desktop/src/lib/api/schedules.ts
//
// Typed client for Core's scheduled-jobs (heartbeat) endpoints. A scheduled job
// fires on a cron expression or a fixed interval and runs either a persisted
// workflow or a one-shot agent prompt. Routes live at the top level on Core
// (`/heartbeat/jobs`), NOT under `/api`. Consumed by the schedules page via the
// `useSchedules` hook.
//
// Note: this module does its own POST rather than reusing the shared `request`
// helper for creation, because Core surfaces validation failures (bad cron /
// interval) as a 400 with a `{ success: false, error }` body. The shared helper
// throws a generic status-only error and discards that body, so we read the
// JSON here to surface the exact Core validation message in the UI.

import { type ApiTarget, apiUrl, makeHeaders, request } from "./client.ts";

/** How a job is scheduled: a cron expression or a fixed interval. */
export type Schedule =
	| { kind: "cron"; expr: string }
	| { kind: "every"; interval: string };

/** What a job runs when it fires: a workflow or a one-shot agent prompt. */
export type JobTarget =
	| { type: "workflow"; workflowId: string; input?: Record<string, string> }
	| { type: "agent"; agentId: string; prompt: string };

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
	requireApproval: boolean;
	schedule: Schedule;
	/**
	 * True for Core's internal maintenance jobs (identity-vault health sweep,
	 * continual-learning cycle) that are ensured at startup rather than created
	 * by the user. Derived from the wire target type, so surfaces can hide them
	 * by default without losing user-created automations.
	 */
	system: boolean;
	target: JobTarget;
	updatedAt: string;
}

/** Fields the UI sends when creating a job. */
export interface JobInput {
	enabled: boolean;
	name: string;
	requireApproval?: boolean;
	schedule: Schedule;
	target: JobTarget;
}

// ── Wire shapes (snake_case, tagged unions exactly as Core serializes them) ──

interface ScheduleWire {
	expr?: string;
	interval?: string;
	kind: "cron" | "every";
}

// Core also serializes internal targets ("monitor", "quest", "identity_health",
// "learning_cycle") through this shape, so `type` stays an open string.
interface TargetWire {
	agent_id?: string;
	input?: Record<string, string>;
	prompt?: string;
	type: string;
	workflow_id?: string;
}

/**
 * Wire target types of Core's startup-ensured maintenance jobs
 * (`JobTarget::IdentityHealth` / `JobTarget::LearningCycle` in
 * `apps/core/src/scheduler/store.rs`). These are never user-created, so the
 * UI treats them as system jobs.
 */
const SYSTEM_TARGET_TYPES = new Set(["identity_health", "learning_cycle"]);

interface ExecRecordWire {
	error?: string | null;
	finished_at: string;
	outcome: ExecOutcome;
	run_id?: string | null;
	started_at: string;
}

interface JobWire {
	created_at: string;
	enabled?: boolean;
	history?: ExecRecordWire[];
	id: string;
	last_outcome?: ExecOutcome | null;
	last_run_at?: string | null;
	name: string;
	require_approval?: boolean;
	schedule: ScheduleWire;
	target: TargetWire;
	updated_at: string;
}

function toSchedule(s: ScheduleWire): Schedule {
	if (s.kind === "cron") {
		return { kind: "cron", expr: s.expr ?? "" };
	}
	return { kind: "every", interval: s.interval ?? "" };
}

function toTarget(t: TargetWire): JobTarget {
	if (t.type === "workflow") {
		return {
			type: "workflow",
			workflowId: t.workflow_id ?? "",
			input: t.input,
		};
	}
	return { type: "agent", agentId: t.agent_id ?? "", prompt: t.prompt ?? "" };
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
	return {
		id: j.id,
		name: j.name,
		schedule: toSchedule(j.schedule),
		system: SYSTEM_TARGET_TYPES.has(j.target.type),
		target: toTarget(j.target),
		enabled: j.enabled ?? true,
		requireApproval: j.require_approval ?? false,
		createdAt: j.created_at,
		updatedAt: j.updated_at,
		lastRunAt: j.last_run_at ?? null,
		lastOutcome: j.last_outcome ?? null,
		history: (j.history ?? []).map(toRecord),
	};
}

function toScheduleBody(s: Schedule): Record<string, unknown> {
	if (s.kind === "cron") {
		return { kind: "cron", expr: s.expr };
	}
	return { kind: "every", interval: s.interval };
}

function toTargetBody(t: JobTarget): Record<string, unknown> {
	if (t.type === "workflow") {
		return {
			type: "workflow",
			workflow_id: t.workflowId,
			input: t.input ?? {},
		};
	}
	return { type: "agent", agent_id: t.agentId, prompt: t.prompt };
}

/** List all scheduled jobs on the active node. */
export async function fetchJobs(target: ApiTarget): Promise<ScheduledJob[]> {
	const json = await request<{ jobs?: JobWire[] }>(target, "/heartbeat/jobs");
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
	const resp = await fetch(apiUrl(target, "/heartbeat/jobs"), {
		method: "POST",
		headers: makeHeaders(target.token),
		body: JSON.stringify({
			name: input.name,
			schedule: toScheduleBody(input.schedule),
			target: toTargetBody(input.target),
			enabled: input.enabled,
			require_approval: input.requireApproval ?? false,
		}),
	});
	const text = await resp.text();
	const json = text ? JSON.parse(text) : {};
	if (!resp.ok) {
		const message =
			typeof json?.error === "string"
				? json.error
				: `Failed to create job (${resp.status})`;
		throw new Error(message);
	}
	return toJob(json.job as JobWire);
}

/** Delete a scheduled job by id. */
export async function deleteJob(target: ApiTarget, id: string): Promise<void> {
	await request<void>(target, `/heartbeat/jobs/${id}`, { method: "DELETE" });
}
