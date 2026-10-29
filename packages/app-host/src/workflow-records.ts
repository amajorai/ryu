import { z } from "zod";
import {
	jsonResponseDocumentSchema,
	jsonResponseValueSchema,
} from "./json-values.ts";

/** These are the host client's complete normalized workflow DTOs. Core owns
 * graph validation; node types and their additive configuration remain extensible. */
function preserveWorkflowRecord<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			jsonResponseDocumentSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
function preserveWorkflowArray<S extends z.ZodType>(item: S) {
	const items = z.array(item);
	return z.custom<z.output<typeof items>>(
		(value) => items.safeParse(value).success
	);
}

function preserveWorkflowMap<S extends z.ZodType>(item: S) {
	const items = z.record(z.string(), item);
	return z.custom<z.output<typeof items>>((value) => {
		if (!items.safeParse(value).success) {
			return false;
		}
		const prototypeEntry = Object.getOwnPropertyDescriptor(value, "__proto__");
		return !prototypeEntry || item.safeParse(prototypeEntry.value).success;
	});
}

export const workflowDefinitionInputSchema = jsonResponseDocumentSchema;
export type WorkflowDefinitionInput = z.output<
	typeof workflowDefinitionInputSchema
>;
export const workflowNodeRecordSchema = preserveWorkflowRecord(
	z
		.object({
			id: z.string(),
			type: z.string(),
		})
		.catchall(jsonResponseValueSchema)
);
export type WorkflowNodeRecord = z.output<typeof workflowNodeRecordSchema>;
export const workflowEdgeRecordSchema = preserveWorkflowRecord(
	z.object({
		branch: z.string().nullable().optional(),
		from: z.string(),
		to: z.string(),
	})
);
const workflowTriggerFields = z.discriminatedUnion("type", [
	z.object({ type: z.literal("manual") }),
	z.object({
		type: z.literal("schedule"),
		cron: z.string().nullable().optional(),
		every: z.string().nullable().optional(),
		require_approval: z.boolean().optional(),
	}),
	z.object({
		type: z.literal("webhook"),
		secret: z.string().nullable().optional(),
	}),
	z.object({
		type: z.literal("composio"),
		toolkit: z.string(),
		trigger_slug: z.string(),
		connected_account_id: z.string().nullable().optional(),
	}),
	z.object({ type: z.literal("event"), event: z.string() }),
]);
export const workflowTriggerRecordSchema = z.custom<
	z.output<typeof workflowTriggerFields>
>(
	(value) =>
		jsonResponseDocumentSchema.safeParse(value).success &&
		workflowTriggerFields.safeParse(value).success
);
export const workflowRecordSchema = preserveWorkflowRecord(
	z.object({
		chatInput: z.boolean(),
		createdAt: z.string().nullable().optional(),
		description: z.string().nullable().optional(),
		edges: z.array(workflowEdgeRecordSchema),
		id: z.string(),
		name: z.string(),
		nodes: z.array(workflowNodeRecordSchema),
		triggers: z.array(workflowTriggerRecordSchema),
		updatedAt: z.string().nullable().optional(),
	})
);
export type WorkflowRecord = z.output<typeof workflowRecordSchema>;
export const workflowRecordsSchema =
	preserveWorkflowArray(workflowRecordSchema);

const nodeRunStateSchema = preserveWorkflowRecord(
	z.object({
		error: z.string().nullable().optional(),
		output: z.string().nullable().optional(),
		status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
	})
);
export const workflowRunRecordSchema = preserveWorkflowRecord(
	z.object({
		awaitingNode: z.string().nullable().optional(),
		createdAt: z.string(),
		dryRun: z.boolean(),
		error: z.string().nullable().optional(),
		input: preserveWorkflowMap(z.string()),
		nodes: preserveWorkflowMap(nodeRunStateSchema),
		output: preserveWorkflowMap(z.string()),
		resumeAt: z.string().nullable().optional(),
		runId: z.string(),
		status: z.enum([
			"running",
			"completed",
			"failed",
			"awaiting_input",
			"waiting",
		]),
		updatedAt: z.string(),
		waitReason: z.string().nullable().optional(),
		workflowId: z.string(),
	})
);
export type WorkflowRunRecord = z.output<typeof workflowRunRecordSchema>;

const workflowTemplateFields = z.object({
	category: z.enum(["research", "orchestration", "quality", "automation"]),
	description: z.string(),
	icon: z.string().nullable(),
	id: z.string(),
	name: z.string(),
	nodeCount: z.number(),
	pattern: z.string(),
	sourceUrl: z.string().nullable(),
	tags: z.array(z.string()),
});
export const workflowTemplateRecordSchema = preserveWorkflowRecord(
	workflowTemplateFields
);
export const workflowTemplateRecordsSchema = preserveWorkflowArray(
	workflowTemplateRecordSchema
);
export const workflowTemplateDetailRecordSchema = preserveWorkflowRecord(
	workflowTemplateFields.extend({
		edges: z.array(workflowEdgeRecordSchema),
		nodes: z.array(workflowNodeRecordSchema),
	})
);
export type WorkflowTemplateRecord = z.output<
	typeof workflowTemplateRecordSchema
>;
export type WorkflowTemplateDetailRecord = z.output<
	typeof workflowTemplateDetailRecordSchema
>;

export const workflowVersionRecordSchema = preserveWorkflowRecord(
	z.object({
		createdAt: z.number(),
		id: z.string(),
		label: z.string().nullable(),
		name: z.string(),
		workflowId: z.string(),
	})
);
export const workflowVersionRecordsSchema = preserveWorkflowArray(
	workflowVersionRecordSchema
);
export type WorkflowVersionRecord = z.output<
	typeof workflowVersionRecordSchema
>;
