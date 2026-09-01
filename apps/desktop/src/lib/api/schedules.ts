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

import { type ApiTarget, authenticatedFetch, request } from "./client.ts";

/** How a job is scheduled: a cron expression or a fixed interval. */
export type Schedule =
	| {
			kind: "cron";
			expr: string;
			/**
			 * IANA zone the expression is read in (`"Europe/Lisbon"`). Absent means
			 * UTC, which is how every schedule behaved before zones existed — so a
			 * wall-clock time chosen by a human ("05:00") must carry one, or it
			 * drifts an hour at each DST transition.
			 */
			tz?: string | null;
	  }
	| { kind: "every"; interval: string };

/** What a job runs when it fires: a workflow or a one-shot agent prompt. */
export type JobTarget =
	| { type: "workflow"; workflowId: string; input?: Record<string, string> }
	| {
			type: "agent";
			agentId: string;
			/**
			 * Pins the model for this turn only, as the composer's picker does.
			 * Absent runs the agent on its configured model.
			 */
			model?: string | null;
			/** Append each firing to this existing persistent chat when set. */
			conversationId?: string | null;
			prompt: string;
	  };

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
	/**
	 * Manifest id of the App that created this job, when one did. Core's tick
	 * loop refuses to fire an App-owned job while that App is disabled, so this
	 * is also what makes "turn the App off" stop its automations.
	 */
	ownerApp: string | null;
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
	/** Manifest id of the App creating this job; omit for Core/desktop jobs. */
	ownerApp?: string | null;
	requireApproval?: boolean;
	schedule: Schedule;
	target: JobTarget;
}

/** Mutable fields for an existing routine. Omitted fields remain unchanged. */
export interface JobUpdateInput {
	enabled?: boolean;
	name?: string;
	requireApproval?: boolean;
	schedule?: Schedule;
	target?: JobTarget;
}

// ── Wire shapes (snake_case, tagged unions exactly as Core serializes them) ──

interface ScheduleWire {
	expr?: string;
	interval?: string;
	kind: "cron" | "every";
	tz?: string | null;
}

// Core also serializes internal targets ("monitor", "quest", "identity_health",
// "learning_cycle") through this shape, so `type` stays an open string.
interface TargetWire {
	agent_id?: string;
	conversation_id?: string | null;
	input?: Record<string, string>;
	model?: string | null;
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
	owner_app?: string | null;
	require_approval?: boolean;
	schedule: ScheduleWire;
	target: TargetWire;
	updated_at: string;
}

function toSchedule(s: ScheduleWire): Schedule {
	if (s.kind === "cron") {
		return { kind: "cron", expr: s.expr ?? "", tz: s.tz ?? null };
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
	return {
		type: "agent",
		agentId: t.agent_id ?? "",
		conversationId: t.conversation_id ?? null,
		prompt: t.prompt ?? "",
		model: t.model ?? null,
	};
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
		ownerApp: j.owner_app ?? null,
		createdAt: j.created_at,
		updatedAt: j.updated_at,
		lastRunAt: j.last_run_at ?? null,
		lastOutcome: j.last_outcome ?? null,
		history: (j.history ?? []).map(toRecord),
	};
}

function toScheduleBody(s: Schedule): Record<string, unknown> {
	if (s.kind === "cron") {
		// Omitted rather than sent as null when absent, so a zoneless job's body
		// is byte-identical to what it was before zones existed.
		return s.tz
			? { kind: "cron", expr: s.expr, tz: s.tz }
			: { kind: "cron", expr: s.expr };
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
	return t.model
		? {
				type: "agent",
				agent_id: t.agentId,
				...(t.conversationId ? { conversation_id: t.conversationId } : {}),
				prompt: t.prompt,
				model: t.model,
			}
		: {
				type: "agent",
				agent_id: t.agentId,
				...(t.conversationId ? { conversation_id: t.conversationId } : {}),
				prompt: t.prompt,
			};
}

function toJobUpdateBody(input: JobUpdateInput): Record<string, unknown> {
	return {
		...(input.name === undefined ? {} : { name: input.name }),
		...(input.schedule === undefined
			? {}
			: { schedule: toScheduleBody(input.schedule) }),
		...(input.target === undefined
			? {}
			: { target: toTargetBody(input.target) }),
		...(input.enabled === undefined ? {} : { enabled: input.enabled }),
		...(input.requireApproval === undefined
			? {}
			: { require_approval: input.requireApproval }),
	};
}

/**
 * Run a scheduled job now, outside its schedule
 * (`POST /heartbeat/jobs/:id/run`).
 *
 * Core answers 200 for both outcomes — the request succeeded either way; what
 * differs is whether the *job* did. A failed run therefore throws with Core's
 * own error message rather than being reported as a successful call.
 */
export async function runJobNow(
	target: ApiTarget,
	id: string
): Promise<string | null> {
	const json = await request<{
		error?: string;
		run_id?: string | null;
		success?: boolean;
	}>(target, `/heartbeat/jobs/${encodeURIComponent(id)}/run`, {
		method: "POST",
	});
	if (json.success === false) {
		throw new Error(json.error ?? "The job failed to run.");
	}
	return json.run_id ?? null;
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
	const resp = await authenticatedFetch(target, "/heartbeat/jobs", {
		method: "POST",
		body: JSON.stringify({
			name: input.name,
			schedule: toScheduleBody(input.schedule),
			target: toTargetBody(input.target),
			enabled: input.enabled,
			require_approval: input.requireApproval ?? false,
			...(input.ownerApp ? { owner_app: input.ownerApp } : {}),
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

/** Update a saved routine and return Core's canonical record. */
export async function updateJob(
	target: ApiTarget,
	id: string,
	input: JobUpdateInput
): Promise<ScheduledJob> {
	const resp = await authenticatedFetch(
		target,
		`/heartbeat/jobs/${encodeURIComponent(id)}`,
		{
			method: "PUT",
			body: JSON.stringify(toJobUpdateBody(input)),
		}
	);
	const text = await resp.text();
	const json = text ? JSON.parse(text) : {};
	if (!resp.ok) {
		const message =
			typeof json?.error === "string"
				? json.error
				: `Failed to update job (${resp.status})`;
		throw new Error(message);
	}
	return toJob(json.job as JobWire);
}

/** Delete a scheduled job by id. */
export async function deleteJob(target: ApiTarget, id: string): Promise<void> {
	await request<void>(target, `/heartbeat/jobs/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
}
