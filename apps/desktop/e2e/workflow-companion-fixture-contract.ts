import { z } from "zod";
import type { ProofJsonValue } from "./fixture-json.ts";
import {
	parseWorkflowFixtureArgs,
	parseWorkflowFixtureDefinition,
} from "./workflow-fixture-contract.ts";

const JsonRecordSchema = z.record(z.string(), z.json());
const WorkflowSchema = JsonRecordSchema.transform(
	parseWorkflowFixtureDefinition
);
export const FixtureBindingSchema = z
	.object({ id: z.string(), triggerId: z.string(), triggerSlug: z.string() })
	.catchall(z.json());
export type FixtureBinding = z.infer<typeof FixtureBindingSchema>;
export const FixtureRunInputSchema = z.record(z.string(), z.string());
const FixtureRunSchema = z
	.object({
		awaitingNode: z.string().nullable(),
		dryRun: z.boolean(),
		input: FixtureRunInputSchema,
		nodes: z.record(
			z.string(),
			z
				.object({ output: z.string().optional(), status: z.string() })
				.catchall(z.json())
		),
		output: z.record(z.string(), z.string()),
		runId: z.string(),
		status: z.enum(["awaiting_input", "completed", "failed"]),
		workflowId: z.string(),
	})
	.catchall(z.json());
export type FixtureRun = z.infer<typeof FixtureRunSchema>;
const FixtureVersionSchema = z
	.object({
		createdAt: z.number(),
		definition: WorkflowSchema,
		id: z.string(),
		label: z.string().nullable(),
		name: z.string(),
		workflowId: z.string(),
	})
	.catchall(z.json());
export type FixtureVersion = z.infer<typeof FixtureVersionSchema>;
export const FixtureRecipesSchema = z.array(JsonRecordSchema);
const CompanionSnapshotSchema = z
	.object({
		bindings: z.record(z.string(), z.array(FixtureBindingSchema)),
		calls: z.array(
			z
				.object({ args: JsonRecordSchema, method: z.string() })
				.catchall(z.json())
		),
		runs: z.record(z.string(), FixtureRunSchema),
		versions: z.record(z.string(), z.array(FixtureVersionSchema)),
		workflows: z.array(WorkflowSchema),
	})
	.catchall(z.json());
export type CompanionSnapshot = z.infer<typeof CompanionSnapshotSchema>;
export function parseWorkflowCompanionSnapshot(raw: string): CompanionSnapshot {
	const input = parseWorkflowFixtureArgs(raw);
	CompanionSnapshotSchema.parse(input);
	// SAFETY: the schema validated binding, run, version, workflow, and call contracts; retaining the checked original preserves captured own JSON keys.
	return input as CompanionSnapshot;
}

const RunInputEntriesSchema = z.array(z.tuple([z.string(), z.string()]));
export function parseCompanionRunInput(
	input: ProofJsonValue | undefined
): z.infer<typeof FixtureRunInputSchema> {
	const value = input ?? {};
	FixtureRunInputSchema.parse(value);
	RunInputEntriesSchema.parse(Object.entries(value));
	// SAFETY: the record schema and every own entry validated string values; preserve original own keys for deterministic fixture input echoing.
	return value as z.infer<typeof FixtureRunInputSchema>;
}
export function parseCompanionBinding(
	input: ProofJsonValue | undefined
): FixtureBinding {
	FixtureBindingSchema.parse(input);
	// SAFETY: the binding schema checked id, trigger ID, slug, and JSON metadata; retain the checked object to preserve captured own fields.
	return input as FixtureBinding;
}
export function parseCompanionRecipes(
	input: ProofJsonValue | undefined
): z.infer<typeof FixtureRecipesSchema> {
	const value = input ?? [];
	FixtureRecipesSchema.parse(value);
	// SAFETY: the schema checked the recipe array and each JSON record; retain the checked original opaque recipe metadata.
	return value as z.infer<typeof FixtureRecipesSchema>;
}
