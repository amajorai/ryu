import {
	workflowDefinitionInputSchema,
	workflowEdgeRecordSchema,
	workflowNodeRecordSchema,
	workflowRecordSchema,
	workflowRunRecordSchema,
	workflowTemplateDetailRecordSchema,
	workflowTemplateRecordSchema,
	workflowTriggerRecordSchema,
	workflowVersionRecordSchema,
} from "@ryu/app-host/rpc";
import { z } from "zod";
import { pluginDocumentSchema } from "./plugin-wire-values.ts";

/** Pure wire validation retains nested graph/configuration and map identity. */
function workflowWireRecord<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			pluginDocumentSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const workflowWireSchema = workflowWireRecord(
	z.object({
		chat_input: z.boolean().nullish(),
		created_at: z.string().nullish(),
		description: z.string().nullish(),
		edges: z.array(workflowEdgeRecordSchema).nullish(),
		id: z.string(),
		name: z.string(),
		nodes: z.array(workflowNodeRecordSchema).nullish(),
		triggers: z.array(workflowTriggerRecordSchema).nullish(),
		updated_at: z.string().nullish(),
	})
).transform((w) =>
	workflowRecordSchema.parse({
		id: w.id,
		name: w.name,
		description: w.description ?? null,
		nodes: w.nodes ?? [],
		edges: w.edges ?? [],
		triggers: w.triggers ?? [],
		chatInput: w.chat_input ?? false,
		createdAt: w.created_at ?? null,
		updatedAt: w.updated_at ?? null,
	})
);
export const workflowEnvelopeSchema = z.object({
	workflow: workflowWireSchema,
});
export const workflowListEnvelopeSchema = z
	.object({ workflows: z.array(workflowWireSchema).nullish() })
	.transform((v) => ({ workflows: v.workflows ?? [] }));
const nodeRunWireSchema = workflowWireRecord(
	z.object({
		status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
		error: z.string().nullish(),
		output: z.string().nullish(),
	})
);
function workflowWireMap<S extends z.ZodType>(item: S) {
	const fields = z.record(z.string(), item);
	return z.custom<z.output<typeof fields>>((value) => {
		if (
			!(
				pluginDocumentSchema.safeParse(value).success &&
				fields.safeParse(value).success
			)
		) {
			return false;
		}
		const entry = Object.getOwnPropertyDescriptor(value, "__proto__");
		return !entry || item.safeParse(entry.value).success;
	});
}
const runWireSchema = workflowWireRecord(
	z.object({
		awaiting_node: z.string().nullish(),
		created_at: z.string(),
		dry_run: z.boolean().nullish(),
		dryRun: z.boolean().nullish(),
		error: z.string().nullish(),
		input: workflowWireMap(z.string()).nullish(),
		output: workflowWireMap(z.string()).nullish(),
		nodes: workflowWireMap(nodeRunWireSchema).nullish(),
		resume_at: z.string().nullish(),
		run_id: z.string(),
		status: z.enum([
			"running",
			"completed",
			"failed",
			"awaiting_input",
			"waiting",
		]),
		updated_at: z.string(),
		wait_reason: z.string().nullish(),
		workflow_id: z.string(),
	})
).transform((r) =>
	workflowRunRecordSchema.parse({
		runId: r.run_id,
		workflowId: r.workflow_id,
		status: r.status,
		dryRun: r.dryRun ?? r.dry_run ?? false,
		input: r.input ?? {},
		output: r.output ?? {},
		nodes: r.nodes ?? {},
		error: r.error ?? null,
		awaitingNode: r.awaiting_node ?? null,
		resumeAt: r.resume_at ?? null,
		waitReason: r.wait_reason ?? null,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	})
);
export const workflowRunEnvelopeSchema = z.object({ run: runWireSchema });
const templateCategorySchema = z.enum([
	"research",
	"orchestration",
	"quality",
	"automation",
]);
const templateWireFields = z.object({
	category: z.string().nullish(),
	description: z.string().nullish(),
	icon: z.string().nullish(),
	id: z.string(),
	name: z.string(),
	node_count: z.number().nullish(),
	pattern: z.string(),
	source_url: z.string().nullish(),
	tags: z.array(z.string()).nullish(),
});
function normalizeTemplate(w: z.output<typeof templateWireFields>) {
	const category = templateCategorySchema.safeParse(w.category);
	return workflowTemplateRecordSchema.parse({
		id: w.id,
		name: w.name,
		description: w.description ?? "",
		category: category.success ? category.data : "orchestration",
		pattern: w.pattern,
		icon: w.icon ?? null,
		nodeCount: w.node_count ?? 0,
		tags: w.tags ?? [],
		sourceUrl: w.source_url ?? null,
	});
}
const templateWireSchema =
	workflowWireRecord(templateWireFields).transform(normalizeTemplate);
export const workflowTemplateListEnvelopeSchema = z
	.object({ templates: z.array(templateWireSchema).nullish() })
	.transform((v) => ({ templates: v.templates ?? [] }));
const templateDetailWireSchema = workflowWireRecord(
	templateWireFields.extend({
		edges: z.array(workflowEdgeRecordSchema).nullish(),
		nodes: z.array(workflowNodeRecordSchema).nullish(),
	})
).transform((w) =>
	workflowTemplateDetailRecordSchema.parse({
		...normalizeTemplate(w),
		nodes: w.nodes ?? [],
		edges: w.edges ?? [],
	})
);
export const workflowTemplateEnvelopeSchema = z.object({
	template: templateDetailWireSchema,
});
const versionWireSchema = workflowWireRecord(
	z.object({
		created_at: z.number(),
		id: z.string(),
		label: z.string().nullish(),
		name: z.string(),
		workflow_id: z.string(),
	})
).transform((w) =>
	workflowVersionRecordSchema.parse({
		createdAt: w.created_at,
		id: w.id,
		label: w.label ?? null,
		name: w.name,
		workflowId: w.workflow_id,
	})
);
export const workflowVersionListEnvelopeSchema = z
	.object({ versions: z.array(versionWireSchema).nullish() })
	.transform((v) => ({ versions: v.versions ?? [] }));
export const workflowVersionDefinitionEnvelopeSchema = z.object({
	version: z
		.object({ workflow: workflowDefinitionInputSchema.nullish() })
		.nullish(),
});
export const workflowInstallResultSchema = z.object({
	workflow_id: z.string(),
});
export const workflowInstallPreviewSchema = workflowWireRecord(
	z
		.object({
			action: z.literal("install"),
			dryRun: z.literal(true),
			success: z.boolean(),
		})
		.catchall(z.json())
);
export const workflowErrorSchema = z.object({ error: z.string().optional() });
