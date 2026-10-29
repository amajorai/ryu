import { z } from "zod";
import { pluginDocumentSchema } from "./plugin-wire-values.ts";

/** Complete scheduler wire records. Optional/null legacy fields are normalized
 * by the client; Core owns cron validation and target authorization. */
function scheduledWireRecord<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			pluginDocumentSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const schedulerStringMapFieldsSchema = z.record(z.string(), z.string());
const schedulerStringMapSchema = z.custom<
	z.output<typeof schedulerStringMapFieldsSchema>
>((value) => {
	const parsed = pluginDocumentSchema.safeParse(value);
	return (
		parsed.success &&
		Object.values(parsed.data).every(
			(entry) => z.string().safeParse(entry).success
		)
	);
});
const scheduleFieldsSchema = z.object({
	expr: z.string().nullish(),
	interval: z.string().nullish(),
	kind: z.string(),
	tz: z.string().nullish(),
});
export const scheduleWireSchema = scheduledWireRecord(scheduleFieldsSchema);
/** App-job (`plugin_id` / `job_id`), legacy monitor/quest, maintenance and
 * future targets retain their original fields. The desktop projects
 * non-workflow targets as agent rows and flags Core-owned ones as `system`. */
export const scheduledTargetWireSchema = scheduledWireRecord(
	z.object({
		account_id: z.string().nullish(),
		agent_id: z.string().nullish(),
		conversation_id: z.string().nullish(),
		input: schedulerStringMapSchema.optional(),
		job_id: z.string().optional(),
		model: z.string().nullish(),
		monitor_id: z.string().optional(),
		plugin_id: z.string().optional(),
		prompt: z.string().nullish(),
		provider_id: z.string().nullish(),
		quest_id: z.string().optional(),
		type: z.string(),
		workflow_id: z.string().nullish(),
	})
);
export const scheduledExecutionWireSchema = scheduledWireRecord(
	z.object({
		error: z.string().nullish(),
		finished_at: z.string(),
		outcome: z.enum(["success", "failure"]),
		run_id: z.string().nullish(),
		started_at: z.string(),
	})
);
export const scheduledJobWireSchema = scheduledWireRecord(
	z.object({
		created_at: z.string(),
		enabled: z.boolean().nullish(),
		history: z.array(scheduledExecutionWireSchema).nullish(),
		id: z.string(),
		last_outcome: z.enum(["success", "failure"]).nullish(),
		last_run_at: z.string().nullish(),
		name: z.string(),
		org_id: z.string().nullish(),
		owner_app: z.string().nullish(),
		owner_user_id: z.string().nullish(),
		require_approval: z.boolean().nullish(),
		schedule: scheduleWireSchema,
		target: scheduledTargetWireSchema,
		updated_at: z.string(),
	})
);
export type ScheduleWire = z.output<typeof scheduleWireSchema>;
export type TargetWire = z.output<typeof scheduledTargetWireSchema>;
export type ExecRecordWire = z.output<typeof scheduledExecutionWireSchema>;
export type JobWire = z.output<typeof scheduledJobWireSchema>;
export const scheduledJobsResponseSchema = z.object({
	jobs: z.array(scheduledJobWireSchema).nullish(),
});
export const scheduledJobResponseSchema = z.object({
	job: scheduledJobWireSchema,
});
export const scheduledRunResponseSchema = z.object({
	error: z.string().nullish(),
	run_id: z.string().nullish(),
	success: z.boolean().optional(),
});
export const scheduledErrorResponseSchema = z.object({ error: z.string() });

export const scheduleBodySchema = z.union([
	z.object({
		kind: z.literal("cron"),
		expr: z.string(),
		tz: z.string().optional(),
	}),
	z.object({ kind: z.literal("every"), interval: z.string() }),
]);
export const scheduledTargetBodySchema = z.union([
	z.object({
		type: z.literal("workflow"),
		workflow_id: z.string(),
		input: schedulerStringMapSchema,
	}),
	z.object({
		type: z.literal("agent"),
		agent_id: z.string(),
		conversation_id: z.string().nullable().optional(),
		prompt: z.string(),
		model: z.string().optional(),
	}),
	z.object({
		type: z.literal("provider_account"),
		provider_id: z.string(),
		account_id: z.string(),
		prompt: z.string(),
		model: z.string(),
	}),
]);
export const scheduledJobCreateBodySchema = z.object({
	name: z.string(),
	schedule: scheduleBodySchema,
	target: scheduledTargetBodySchema,
	enabled: z.boolean(),
	require_approval: z.boolean(),
	quick_routine: z.boolean().optional(),
	owner_app: z.string().optional(),
});
export const scheduledJobUpdateBodySchema = scheduledJobCreateBodySchema
	.omit({ quick_routine: true, owner_app: true })
	.partial();
export type ScheduleBody = z.output<typeof scheduleBodySchema>;
export type ScheduledTargetBody = z.output<typeof scheduledTargetBodySchema>;
export type ScheduledAgentTargetBody = Extract<
	ScheduledTargetBody,
	{ type: "agent" }
>;
export type ScheduledProviderAccountTargetBody = Extract<
	ScheduledTargetBody,
	{ type: "provider_account" }
>;
export type ScheduledJobCreateBody = z.output<
	typeof scheduledJobCreateBodySchema
>;
export type ScheduledJobUpdateBody = z.output<
	typeof scheduledJobUpdateBodySchema
>;
