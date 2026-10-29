import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
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
import { pluginValueSchema } from "./plugin-wire-values.ts";
import {
	type ExecRecordWire,
	type JobWire,
	type ScheduleBody,
	type ScheduledAgentTargetBody,
	type ScheduledJobCreateBody,
	type ScheduledJobUpdateBody,
	type ScheduledProviderAccountTargetBody,
	type ScheduledTargetBody,
	type ScheduleWire,
	scheduledErrorResponseSchema,
	scheduledJobResponseSchema,
	scheduledJobsResponseSchema,
	scheduledRunResponseSchema,
	type TargetWire,
} from "./schedule-wire-contracts.ts";

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

/**
 * A ping pinned to one saved subscription account of a provider pool
 * (`JobTarget::ProviderAccount`). Kept beside {@link JobTarget} rather than in
 * it: generic schedule surfaces project it as an agent row, exactly as they do
 * monitor and quest targets, and only the apps that create these read it.
 */
export interface ProviderAccountTarget {
	accountId: string;
	model: string;
	prompt: string;
	providerId: string;
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
	/**
	 * Manifest id of the app whose job this is, for a job Core reconciles from
	 * an app's `jobs.list` (`app_job` target). Attribute the row to the app with
	 * this id, never with the job name (the app writes the name).
	 */
	appId: string | null;
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
	/** Set when the job pings one provider account; see {@link ProviderAccountTarget}. */
	providerAccount?: ProviderAccountTarget | null;
	requireApproval: boolean;
	schedule: Schedule;
	/**
	 * True for jobs Core owns rather than the user: its maintenance jobs
	 * (identity-vault health sweep, continual-learning cycle) and the jobs it
	 * reconciles for apps (app jobs, legacy monitor/quest checks). Derived from
	 * the wire target type, so surfaces can hide them by default without losing
	 * user-created automations.
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
	/** Atomic canonical quick routine slot; ordinary jobs omit this field. */
	quickRoutine?: boolean;
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

/**
 * Wire target types of the jobs Core owns (`JobTarget` in
 * `apps/core/src/scheduler/store.rs`): its startup-ensured maintenance jobs
 * (`identity_health` / `learning_cycle`), the app jobs it reconciles from an
 * app's `jobs.list` (`app_job`), and the legacy per-app targets an older Core
 * still serves (`monitor` / `quest`). None is user-created, so the UI treats
 * them as system jobs.
 */
const SYSTEM_TARGET_TYPES = new Set([
	"identity_health",
	"learning_cycle",
	"app_job",
	"monitor",
	"quest",
]);

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

function toProviderAccount(t: TargetWire): ProviderAccountTarget | null {
	if (t.type !== "provider_account") {
		return null;
	}
	return {
		providerId: t.provider_id ?? "",
		accountId: t.account_id ?? "",
		model: t.model ?? "",
		prompt: t.prompt ?? "",
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
		appId: j.target.type === "app_job" ? (j.target.plugin_id ?? null) : null,
		id: j.id,
		name: j.name,
		schedule: toSchedule(j.schedule),
		system: SYSTEM_TARGET_TYPES.has(j.target.type),
		target: toTarget(j.target),
		enabled: j.enabled ?? true,
		requireApproval: j.require_approval ?? false,
		ownerApp: j.owner_app ?? null,
		providerAccount: toProviderAccount(j.target),
		createdAt: j.created_at,
		updatedAt: j.updated_at,
		lastRunAt: j.last_run_at ?? null,
		lastOutcome: j.last_outcome ?? null,
		history: (j.history ?? []).map(toRecord),
	};
}

function toScheduleBody(s: Schedule): ScheduleBody {
	if (s.kind === "cron") {
		// Omitted rather than sent as null when absent, so a zoneless job's body
		// is byte-identical to what it was before zones existed.
		return s.tz
			? { kind: "cron", expr: s.expr, tz: s.tz }
			: { kind: "cron", expr: s.expr };
	}
	return { kind: "every", interval: s.interval };
}

function toTargetBody(t: JobTarget): ScheduledTargetBody {
	if (t.type === "workflow") {
		return {
			type: "workflow",
			workflow_id: t.workflowId,
			input: t.input ?? {},
		};
	}
	const conversationFields: Pick<ScheduledAgentTargetBody, "conversation_id"> =
		{};
	if (t.conversationId !== undefined) {
		conversationFields.conversation_id = t.conversationId;
	}
	const body: ScheduledAgentTargetBody = {
		type: "agent",
		agent_id: t.agentId,
		...conversationFields,
		prompt: t.prompt,
	};
	if (t.model) {
		body.model = t.model;
	}
	return body;
}
function toJobUpdateBody(input: JobUpdateInput): ScheduledJobUpdateBody {
	const body: ScheduledJobUpdateBody = {};
	if (input.name !== undefined) {
		body.name = input.name;
	}
	if (input.schedule !== undefined) {
		body.schedule = toScheduleBody(input.schedule);
	}
	if (input.target !== undefined) {
		body.target = toTargetBody(input.target);
	}
	if (input.enabled !== undefined) {
		body.enabled = input.enabled;
	}
	if (input.requireApproval !== undefined) {
		body.require_approval = input.requireApproval;
	}
	return body;
}
function toJobCreateBody(input: JobInput): ScheduledJobCreateBody {
	const body: ScheduledJobCreateBody = {
		name: input.name,
		schedule: toScheduleBody(input.schedule),
		target: toTargetBody(input.target),
		enabled: input.enabled,
		require_approval: input.requireApproval ?? false,
	};
	if (input.quickRoutine !== undefined) {
		body.quick_routine = input.quickRoutine;
	}
	if (input.ownerApp) {
		body.owner_app = input.ownerApp;
	}
	return body;
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
	const json = scheduledRunResponseSchema.parse(
		await request(
			target,
			`/heartbeat/jobs/${encodeURIComponent(id)}/run`,
			{
				method: "POST",
			},
			gatewayJsonValueSchema
		)
	);
	if (json.success === false) {
		throw new Error(json.error ?? "The job failed to run.");
	}
	return json.run_id ?? null;
}

/** Parse and normalize a `{ jobs }` reply in Core's snake_case job shape (the
 *  `/heartbeat/jobs` route and the `warmup.list` kernel operation). */
export function toScheduledJobs(value: unknown): ScheduledJob[] {
	return (scheduledJobsResponseSchema.parse(value).jobs ?? []).map(toJob);
}

/**
 * List all scheduled jobs on the active node, including the jobs Core reconciles
 * for apps (`include=app_jobs`; an older Core ignores the parameter). Pings
 * pinned to one saved subscription account stay out: Warmup lists its own
 * through `warmup.list`, and this view would show them as blank agent jobs.
 */
export async function fetchJobs(target: ApiTarget): Promise<ScheduledJob[]> {
	return toScheduledJobs(
		await request(
			target,
			"/heartbeat/jobs?include=app_jobs",
			undefined,
			gatewayJsonValueSchema
		)
	);
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
		body: JSON.stringify(toJobCreateBody(input)),
	});
	const text = await resp.text();
	const json = pluginValueSchema.parse(text ? JSON.parse(text) : {});
	if (!resp.ok) {
		const message = scheduledErrorResponseSchema.safeParse(json).success
			? scheduledErrorResponseSchema.parse(json).error
			: `Failed to create job (${resp.status})`;
		throw new Error(message);
	}
	return toJob(scheduledJobResponseSchema.parse(json).job);
}

/** Fields sent when creating a {@link ProviderAccountTarget} job. */
export interface ProviderAccountJobInput {
	enabled: boolean;
	name: string;
	ownerApp: string;
	providerAccount: ProviderAccountTarget;
	schedule: Schedule;
}

/**
 * Create a job that pings one provider account. Core validates that the
 * provider supports per-account pings and that the account is a saved login,
 * and answers 400 with that message otherwise.
 */
export async function createProviderAccountJob(
	target: ApiTarget,
	input: ProviderAccountJobInput
): Promise<ScheduledJob> {
	const accountTarget: ScheduledProviderAccountTargetBody = {
		type: "provider_account",
		provider_id: input.providerAccount.providerId,
		account_id: input.providerAccount.accountId,
		prompt: input.providerAccount.prompt,
		model: input.providerAccount.model,
	};
	const body: ScheduledJobCreateBody = {
		name: input.name,
		schedule: toScheduleBody(input.schedule),
		target: accountTarget,
		enabled: input.enabled,
		require_approval: false,
		owner_app: input.ownerApp,
	};
	const resp = await authenticatedFetch(target, "/heartbeat/jobs", {
		method: "POST",
		body: JSON.stringify(body),
	});
	const text = await resp.text();
	const json = pluginValueSchema.parse(text ? JSON.parse(text) : {});
	if (!resp.ok) {
		const message = scheduledErrorResponseSchema.safeParse(json).success
			? scheduledErrorResponseSchema.parse(json).error
			: `Failed to create job (${resp.status})`;
		throw new Error(message);
	}
	return toJob(scheduledJobResponseSchema.parse(json).job);
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
	const json = pluginValueSchema.parse(text ? JSON.parse(text) : {});
	if (!resp.ok) {
		const message = scheduledErrorResponseSchema.safeParse(json).success
			? scheduledErrorResponseSchema.parse(json).error
			: `Failed to update job (${resp.status})`;
		throw new Error(message);
	}
	return toJob(scheduledJobResponseSchema.parse(json).job);
}

/** Delete a scheduled job by id. */
export async function deleteJob(target: ApiTarget, id: string): Promise<void> {
	await request(
		target,
		`/heartbeat/jobs/${encodeURIComponent(id)}`,
		{
			method: "DELETE",
		},
		gatewayJsonValueSchema
	);
}
