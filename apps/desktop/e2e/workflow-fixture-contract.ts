import { z } from "zod";
import { type ProofJsonRecord, parseProofJsonRecord } from "./fixture-json.ts";

const JsonRecordSchema = z.record(z.string(), z.json());
const WorkflowDefinitionSchema = z
	.object({
		edges: z.array(
			z
				.object({
					from: z.string(),
					to: z.string(),
					branch: z.string().optional(),
				})
				.catchall(z.json())
		),
		id: z.string(),
		name: z.string(),
		nodes: z.array(
			z.object({ id: z.string(), type: z.string() }).catchall(z.json())
		),
		triggers: z.array(JsonRecordSchema),
	})
	.catchall(z.json());

const WorkflowSaveSchema = WorkflowDefinitionSchema.extend({
	id: z.string().nullish(),
});
const FailureCounterEntriesSchema = z.array(z.tuple([z.string(), z.number()]));

const FixtureResetSchema = z
	.object({
		recordStopResult: JsonRecordSchema.nullish(),
		agents: z.array(JsonRecordSchema).nullish(),
		apps: z.array(JsonRecordSchema).nullish(),
		skills: z.array(JsonRecordSchema).nullish(),
		mcp: z
			.object({
				servers: z.array(JsonRecordSchema),
				tools: z.array(JsonRecordSchema),
			})
			.catchall(z.json())
			.nullish(),
		appEvents: z.array(JsonRecordSchema).nullish(),
		composioTriggers: z.array(JsonRecordSchema).nullish(),
		failures: z.record(z.string(), z.number()).nullish(),
		toolkits: z.array(JsonRecordSchema).nullish(),
		workflows: z.array(WorkflowDefinitionSchema).nullish(),
	})
	.catchall(z.json());

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type WorkflowSave = z.infer<typeof WorkflowSaveSchema>;
export type FixtureReset = z.infer<typeof FixtureResetSchema>;

export interface TriggerFixtureState {
	appEvents: ProofJsonRecord[];
	calls: { args: ProofJsonRecord; method: string }[];
	composioTriggers: ProofJsonRecord[];
	failures: NonNullable<FixtureReset["failures"]>;
	nextId: number;
	toolkits: ProofJsonRecord[];
	workflows: WorkflowDefinition[];
}

export function parseWorkflowFixtureArgs(raw: string): ProofJsonRecord {
	return parseProofJsonRecord(raw);
}

export function parseWorkflowFixtureReset(
	input: ProofJsonRecord
): FixtureReset {
	FixtureResetSchema.parse(input);
	FailureCounterEntriesSchema.parse(Object.entries(input.failures ?? {}));
	// SAFETY: the schema checked every typed field above. Retain the original
	// JSON object so captured own keys, including __proto__, remain unchanged.
	return input as FixtureReset;
}

export function parseWorkflowFixtureSave(input: ProofJsonRecord): WorkflowSave {
	WorkflowSaveSchema.parse(input);
	// SAFETY: the schema checked id/name, edges, nodes, and triggers above. Keep
	// the checked original to preserve opaque fixture metadata and own JSON keys.
	return input as WorkflowSave;
}

const TriggerSnapshotSchema = z
	.object({
		calls: z.array(
			z
				.object({ args: JsonRecordSchema, method: z.string() })
				.catchall(z.json())
		),
		recording: JsonRecordSchema.nullish(),
		failures: z.record(z.string(), z.number()).optional(),
		workflows: z.array(WorkflowDefinitionSchema),
	})
	.catchall(z.json());

export type TriggerSnapshot = z.infer<typeof TriggerSnapshotSchema>;

export function parseWorkflowFixtureSnapshot(raw: string): TriggerSnapshot {
	const input = parseWorkflowFixtureArgs(raw);
	TriggerSnapshotSchema.parse(input);
	// SAFETY: the snapshot schema checked every call and workflow above. Return
	// the checked original so captured request arguments keep all own JSON keys.
	return input as TriggerSnapshot;
}

export interface WorkflowCatalogFixtureState {
	agents: NonNullable<FixtureReset["agents"]>;
	apps: NonNullable<FixtureReset["apps"]>;
	calls: TriggerFixtureState["calls"];
	failures: TriggerFixtureState["failures"];
	mcp: NonNullable<FixtureReset["mcp"]>;
	nextId: number;
	skills: NonNullable<FixtureReset["skills"]>;
	workflows: TriggerFixtureState["workflows"];
}

export function parseWorkflowFixtureDefinition(
	input: ProofJsonRecord
): WorkflowDefinition {
	WorkflowDefinitionSchema.parse(input);
	// SAFETY: the schema validated every required workflow field; retain the checked original to preserve own metadata keys.
	return input as WorkflowDefinition;
}
const RevisionSnapshotSchema = TriggerSnapshotSchema.extend({
	versions: z.array(
		z
			.object({ id: z.string(), workflow: WorkflowDefinitionSchema.optional() })
			.catchall(z.json())
	),
});
export type RevisionSnapshot = z.infer<typeof RevisionSnapshotSchema>;
export function parseWorkflowRevisionSnapshot(raw: string): RevisionSnapshot {
	const input = parseWorkflowFixtureArgs(raw);
	RevisionSnapshotSchema.parse(input);
	// SAFETY: the schema validated calls, graphs and version envelopes; keeping the checked original preserves captured request own keys.
	return input as RevisionSnapshot;
}
