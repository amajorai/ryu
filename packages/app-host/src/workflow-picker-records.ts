import { z } from "zod";
import { allowlistRecord, allowlistRows } from "./allowlist-projection.ts";
import { jsonResponseDocumentSchema } from "./json-values.ts";

// Picker catalogs under the workflows:catalogs grant, which the Gateway approves
// for any app id. A frame gets what a picker shows and stores (an id and a
// label, with a state flag or two), built as a new object by allowlistRecord.
// Launch configuration (an MCP server's command, arguments and URL), prompts,
// conversation ids, addresses, grants and whatever Core adds later stay on the
// host. Native and Desktop rows differ; both reduce to the same picker rows.
const installedSkillRecordSchema = allowlistRecord(
	z.object({
		description: z.string().nullable(),
		enabled: z.boolean(),
		id: z.string(),
		name: z.string(),
	})
);
export const workflowSkillsRecordsSchema = allowlistRows(
	installedSkillRecordSchema
);
export type WorkflowSkillsRecords = z.output<
	typeof workflowSkillsRecordsSchema
>;

// Shipped Workflows bundles parse this row with `email` and `role` as required
// nullable keys, so both keys stay and are always null: the roster's addresses
// and roles do not cross the bridge.
const mentionTargetRecordSchema = allowlistRecord(
	z.object({
		id: z.string(),
		image: z.string().nullable(),
		name: z.string(),
	})
).transform((row) => ({ ...row, email: null, role: null }));
export const workflowNotifyTargetsRecordsSchema = allowlistRows(
	mentionTargetRecordSchema
);
export type WorkflowNotifyTargetsRecords = z.output<
	typeof workflowNotifyTargetsRecordsSchema
>;

// `payload_example` is the example an app declares for its own event; it passes
// whole. Fields outside this list do not.
const hookEventRecordSchema = allowlistRecord(
	z.object({
		description: z.string().optional(),
		id: z.string(),
		payload_example: jsonResponseDocumentSchema.optional(),
		plugin: z.string().optional(),
		title: z.string(),
	})
);
export const workflowHookEventsRecordsSchema = allowlistRows(
	hookEventRecordSchema
);
export type WorkflowHookEventsRecords = z.output<
	typeof workflowHookEventsRecordsSchema
>;

const mcpServerRecordSchema = allowlistRecord(
	z.object({
		available: z.boolean().nullable(),
		description: z.string().nullable(),
		enabled: z.boolean(),
		name: z.string(),
		ownerPluginId: z.string().nullable().optional(),
		transport: z.string().nullable().optional(),
	})
);
const mcpToolRecordSchema = allowlistRecord(
	z.object({
		description: z.string().nullable(),
		id: z.string(),
		name: z.string(),
		server: z.string(),
	})
);
export const workflowMcpRecordSchema = allowlistRecord(
	z.object({
		servers: allowlistRows(mcpServerRecordSchema),
		tools: allowlistRows(mcpToolRecordSchema),
	})
);
export type WorkflowMcpRecord = z.output<typeof workflowMcpRecordSchema>;

const scheduleSchema = z.union([
	allowlistRecord(
		z.object({
			kind: z.literal("cron"),
			expr: z.string(),
			tz: z.string().nullish(),
		})
	),
	allowlistRecord(z.object({ kind: z.literal("every"), interval: z.string() })),
]);
const scheduledJobRecordSchema = allowlistRecord(
	z.object({
		enabled: z.boolean(),
		id: z.string(),
		lastOutcome: z.enum(["success", "failure"]).nullable(),
		lastRunAt: z.string().nullable(),
		name: z.string(),
		schedule: scheduleSchema,
	})
);
export const workflowSchedulesRecordsSchema = allowlistRows(
	scheduledJobRecordSchema
);
export type WorkflowSchedulesRecords = z.output<
	typeof workflowSchedulesRecordsSchema
>;

const agentSummaryRecordSchema = allowlistRecord(
	z.object({
		description: z.string().nullable(),
		engine: z.string().nullable(),
		id: z.string(),
		installed: z.boolean().nullable(),
		model: z.string().nullable(),
		name: z.string(),
		title: z.string(),
		transport: z.string().nullable(),
	})
);
export const workflowAgentsRecordsSchema = allowlistRows(
	agentSummaryRecordSchema
);
export type WorkflowAgentsRecords = z.output<
	typeof workflowAgentsRecordsSchema
>;

const appRunnableSchema = allowlistRecord(
	z.object({ id: z.string(), kind: z.string(), name: z.string() })
);
const appInfoRecordSchema = allowlistRecord(
	z.object({
		description: z.string().nullable().optional(),
		enabled: z.boolean(),
		id: z.string(),
		installed: z.boolean(),
		name: z.string(),
		runnables: allowlistRows(appRunnableSchema),
	})
);
export const workflowAppsRecordsSchema = allowlistRows(appInfoRecordSchema);
export type WorkflowAppsRecords = z.output<typeof workflowAppsRecordsSchema>;

export const workflowComposioKindSchema = z.enum([
	"status",
	"toolkits",
	"triggers",
	"connections",
]);
export type WorkflowComposioKind = z.output<typeof workflowComposioKindSchema>;
// The Connect service address (`baseUrl`) stays on the host.
const composioStatusRecordSchema = allowlistRecord(
	z.object({
		configured: z.boolean(),
		executionOwner: z.literal("connect").optional(),
	})
);
const composioToolkitRowsSchema = allowlistRows(
	allowlistRecord(
		z.object({
			description: z.string().nullable(),
			logo: z.string().nullable(),
			name: z.string(),
			slug: z.string(),
		})
	)
);
// `config` is the trigger's own form description from the Composio catalog.
const composioTriggerRowsSchema = allowlistRows(
	allowlistRecord(
		z.object({
			config: jsonResponseDocumentSchema.nullish(),
			description: z.string().nullable(),
			displayName: z.string(),
			name: z.string(),
			toolkit: z.string(),
		})
	)
);
const composioConnectionRowsSchema = allowlistRows(
	allowlistRecord(
		z.object({
			accessLevel: z.enum(["risk_based", "read_only", "write", "full"]),
			active: z.boolean(),
			id: z.string(),
			status: z.string(),
			toolkit: z.string(),
		})
	)
);

/** The request kind selects the complete reply family; arrays of another
 * catalog must not pass simply because they share name/description fields. */
const composioResponseSchemas = {
	status: composioStatusRecordSchema,
	toolkits: composioToolkitRowsSchema,
	triggers: composioTriggerRowsSchema,
	connections: composioConnectionRowsSchema,
};
export function workflowComposioResponseSchema<K extends WorkflowComposioKind>(
	kind: K
) {
	if (!workflowComposioKindSchema.safeParse(kind).success) {
		throw new Error(`Unknown Composio catalog kind: ${kind}`);
	}
	return composioResponseSchemas[kind];
}
export type WorkflowComposioResponse = z.output<
	ReturnType<typeof workflowComposioResponseSchema>
>;
