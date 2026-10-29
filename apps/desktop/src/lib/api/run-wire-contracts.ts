import { z } from "zod";
import type { RunSummary } from "@/src/hooks/useRuns.ts";
import { pluginValueSchema } from "./plugin-wire-values.ts";
import type { RunStreamFrame } from "./runStream.ts";

function runWireSchema<T>(fields: z.ZodType<T>) {
	return z.custom<T>(
		(value) =>
			pluginValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}

// ConversationSummary/ThreadHierarchy in Core's conversations.rs serialize the
// run list and stream. The additional metadata fields are optional for older
// nodes; validate them when present without closing their future string values.
export const runSummarySchema = runWireSchema(
	z
		.object({
			agent_id: z.string().nullable(),
			branch: z.string().nullable(),
			created_at: z.number(),
			folder_path: z.string().nullable(),
			id: z.string(),
			message_count: z.number(),
			run_status: z.string().nullable(),
			title: z.string().nullable(),
			updated_at: z.number(),
			worktree_path: z.string().nullable(),
			archived: z.boolean().optional(),
			pinned: z.boolean().optional(),
			visibility: z.string().optional(),
			thread_role: z.string().optional(),
			participants: z.array(z.string()).optional(),
			icon: pluginValueSchema.optional(),
			last_message: z.string().nullish(),
			last_message_at: z.number().nullish(),
			last_message_role: z.string().nullish(),
			project_id: z.string().nullish(),
			owner_id: z.string().nullish(),
			owner_kind: z.string().nullish(),
			coordination: z.string().nullish(),
			spawned_by_conversation_id: z.string().nullish(),
			spawned_by_message_id: z.string().nullish(),
		})
		.catchall(pluginValueSchema) satisfies z.ZodType<RunSummary>
);

export const runStreamFrameSchema = runWireSchema(
	z.discriminatedUnion("type", [
		z
			.object({ type: z.literal("snapshot"), runs: z.array(runSummarySchema) })
			.catchall(pluginValueSchema),
		z
			.object({ type: z.literal("run"), run: runSummarySchema })
			.catchall(pluginValueSchema),
	]) satisfies z.ZodType<RunStreamFrame>
);

export const runSnapshotInputSchema = z.object({
	runs: z.array(z.unknown()).optional().catch([]),
});
