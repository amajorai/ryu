import { z } from "zod";
import {
	jsonResponseDocumentSchema,
	jsonResponseValueSchema,
} from "./json-values.ts";

/** Native and Desktop normalize the same catalogs, with Desktop exposing
 * additional host metadata. Validate declared fields and retain original rows. */
function preservePickerRecord<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>((value) => {
		if (
			!fields.catchall(jsonResponseValueSchema.optional()).safeParse(value)
				.success
		) {
			return false;
		}
		const prototypeEntry = Object.getOwnPropertyDescriptor(value, "__proto__");
		return (
			!prototypeEntry ||
			jsonResponseValueSchema.optional().safeParse(prototypeEntry.value).success
		);
	});
}
function preservePickerRows<S extends z.ZodType>(row: S) {
	return z.custom<z.output<S>[]>(
		(value) => z.array(row).safeParse(value).success
	);
}
const installedSkillRecordSchema = preservePickerRecord(
	z.object({
		allowedTools: z.array(z.string()),
		description: z.string().nullable(),
		enabled: z.boolean(),
		id: z.string(),
		name: z.string(),
	})
);
export const workflowSkillsRecordsSchema = preservePickerRows(
	installedSkillRecordSchema
);
export type WorkflowSkillsRecords = z.output<
	typeof workflowSkillsRecordsSchema
>;

const mentionTargetRecordSchema = preservePickerRecord(
	z.object({
		email: z.string().nullable(),
		id: z.string(),
		image: z.string().nullable(),
		name: z.string(),
		role: z.string().nullable(),
	})
);
export const workflowNotifyTargetsRecordsSchema = preservePickerRows(
	mentionTargetRecordSchema
);
export type WorkflowNotifyTargetsRecords = z.output<
	typeof workflowNotifyTargetsRecordsSchema
>;

const hookEventRecordSchema = preservePickerRecord(
	z.object({
		description: z.string().optional(),
		id: z.string(),
		payload_example: jsonResponseDocumentSchema.optional(),
		plugin: z.string().optional(),
		title: z.string(),
	})
);
export const workflowHookEventsRecordsSchema = preservePickerRows(
	hookEventRecordSchema
);
export type WorkflowHookEventsRecords = z.output<
	typeof workflowHookEventsRecordsSchema
>;

const mcpServerRecordSchema = preservePickerRecord(
	z.object({
		args: z.array(z.string()),
		authConfigured: z.boolean().optional(),
		authRequired: z.boolean().optional(),
		authType: z.enum(["env", "header", "oauth"]).nullable().optional(),
		available: z.boolean().nullable(),
		command: z.string(),
		description: z.string().nullable(),
		enabled: z.boolean(),
		envKeys: z.array(z.string()).optional(),
		headerNames: z.array(z.string()).optional(),
		name: z.string(),
		ownerPluginId: z.string().nullable().optional(),
		ownerServerName: z.string().nullable().optional(),
		transport: z.string().nullable().optional(),
		url: z.string().nullable().optional(),
	})
);
const mcpToolRecordSchema = preservePickerRecord(
	z.object({
		description: z.string().nullable(),
		id: z.string(),
		inputSchema: jsonResponseValueSchema,
		meta: jsonResponseValueSchema.optional(),
		name: z.string(),
		server: z.string(),
	})
);
export const workflowMcpRecordSchema = preservePickerRecord(
	z.object({
		servers: preservePickerRows(mcpServerRecordSchema),
		tools: preservePickerRows(mcpToolRecordSchema),
	})
);
export type WorkflowMcpRecord = z.output<typeof workflowMcpRecordSchema>;

const scheduleSchema = z.union([
	preservePickerRecord(
		z.object({
			kind: z.literal("cron"),
			expr: z.string(),
			tz: z.string().nullish(),
		})
	),
	preservePickerRecord(
		z.object({ kind: z.literal("every"), interval: z.string() })
	),
]);
const stringMapFieldsSchema = z.record(z.string(), z.string());
const stringMapSchema = z.custom<z.output<typeof stringMapFieldsSchema>>(
	(value) => {
		if (!stringMapFieldsSchema.safeParse(value).success) {
			return false;
		}
		const prototypeEntry = Object.getOwnPropertyDescriptor(value, "__proto__");
		return (
			!prototypeEntry || z.string().safeParse(prototypeEntry.value).success
		);
	}
);
const targetSchema = z.union([
	preservePickerRecord(
		z.object({
			input: stringMapSchema.optional(),
			type: z.literal("workflow"),
			workflowId: z.string(),
		})
	),
	preservePickerRecord(
		z.object({
			agentId: z.string(),
			conversationId: z.string().nullish(),
			model: z.string().nullish(),
			prompt: z.string(),
			type: z.literal("agent"),
		})
	),
]);
const executionRecordSchema = preservePickerRecord(
	z.object({
		error: z.string().nullable(),
		finishedAt: z.string(),
		outcome: z.enum(["success", "failure"]),
		runId: z.string().nullable(),
		startedAt: z.string(),
	})
);
const scheduledJobRecordSchema = preservePickerRecord(
	z.object({
		createdAt: z.string(),
		enabled: z.boolean(),
		history: preservePickerRows(executionRecordSchema),
		id: z.string(),
		lastOutcome: z.enum(["success", "failure"]).nullable(),
		lastRunAt: z.string().nullable(),
		name: z.string(),
		ownerApp: z.string().nullable().optional(),
		requireApproval: z.boolean().optional(),
		schedule: scheduleSchema,
		system: z.boolean().optional(),
		target: targetSchema,
		updatedAt: z.string(),
	})
);
export const workflowSchedulesRecordsSchema = preservePickerRows(
	scheduledJobRecordSchema
);
export type WorkflowSchedulesRecords = z.output<
	typeof workflowSchedulesRecordsSchema
>;

export const workflowComposioKindSchema = z.enum([
	"status",
	"toolkits",
	"triggers",
	"connections",
]);
export type WorkflowComposioKind = z.output<typeof workflowComposioKindSchema>;
const composioStatusRecordSchema = preservePickerRecord(
	z.object({
		baseUrl: z.string(),
		configured: z.boolean(),
		executionOwner: z.literal("connect").optional(),
	})
);
const composioToolkitRowsSchema = preservePickerRows(
	preservePickerRecord(
		z.object({
			description: z.string().nullable(),
			logo: z.string().nullable(),
			name: z.string(),
			slug: z.string(),
		})
	)
);
const composioTriggerRowsSchema = preservePickerRows(
	preservePickerRecord(
		z.object({
			config: jsonResponseDocumentSchema.nullish(),
			description: z.string().nullable(),
			displayName: z.string(),
			name: z.string(),
			toolkit: z.string(),
		})
	)
);
const composioConnectionRowsSchema = preservePickerRows(
	preservePickerRecord(
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

// Glyph descriptors remain data for the receiving renderer. Validate their full
// transport shapes without importing a desktop-only rendering package into Native.
const glyphDitherSchema = preservePickerRecord(
	z.object({
		direction: z.enum(["up", "down", "left", "right"]),
		from: z.string(),
		to: z.string().nullable(),
	})
);
const glyphRecordSchema = z.union([
	z.null(),
	preservePickerRecord(
		z.object({ kind: z.literal("avatar"), dataUrl: z.string() })
	),
	preservePickerRecord(
		z.object({
			kind: z.literal("icon"),
			id: z.string(),
			color: z.string().optional(),
			dither: glyphDitherSchema.optional(),
		})
	),
	preservePickerRecord(
		z.object({
			kind: z.literal("emoji"),
			emoji: z.string(),
			dither: glyphDitherSchema.optional(),
		})
	),
	preservePickerRecord(
		z.object({
			kind: z.literal("dicebear"),
			seed: z.string(),
			style: z.string(),
		})
	),
	preservePickerRecord(
		z.object({ kind: z.literal("dither"), dither: glyphDitherSchema })
	),
	preservePickerRecord(
		z.object({
			animated: z.boolean().optional(),
			animation: z.string().optional(),
			animationDuration: z.number().optional(),
			behavior: z.enum(["custom", "conversation"]).optional(),
			bodyStyle: z.enum(["solid", "orb"]).optional(),
			colors: preservePickerRecord(
				z.object({
					bg: z.string().optional(),
					c1: z.string().optional(),
					c2: z.string().optional(),
					c3: z.string().optional(),
				})
			).optional(),
			expression: z.string(),
			eyeScale: z.number().optional(),
			kind: z.literal("expressive"),
			variant: z
				.enum(["3d", "outline", "outline-muted", "default", "expressive"])
				.optional(),
		})
	),
]);
const agentSummaryRecordSchema = preservePickerRecord(
	z.object({
		avatarGlyph: glyphRecordSchema.optional(),
		avatarUrl: z.string().nullable().optional(),
		builtIn: z.boolean(),
		createdAt: z.string().nullable(),
		description: z.string().nullable(),
		engine: z.string().nullable(),
		gatewayBypass: z.boolean().optional(),
		id: z.string(),
		installed: z.boolean().nullable(),
		installHint: z.string().nullable(),
		latestVersion: z.string().nullable().optional(),
		lifecycleStatus: z.enum(["draft", "trial", "active"]).optional(),
		locked: z.boolean(),
		model: z.string().nullable(),
		name: z.string(),
		recommended: z.boolean().optional(),
		safetyProfile: z
			.enum([
				"read_only",
				"approval_required",
				"verified_plan_only",
				"autonomous",
			])
			.optional(),
		systemPrompt: z.string().nullable(),
		title: z.string(),
		transport: z.string().nullable(),
		version: z.string().nullable(),
		versionStatus: z.string().nullable().optional(),
	})
);
export const workflowAgentsRecordsSchema = preservePickerRows(
	agentSummaryRecordSchema
);
export type WorkflowAgentsRecords = z.output<
	typeof workflowAgentsRecordsSchema
>;

const appSurfaceSchema = z.enum([
	"gateway",
	"core",
	"desktop",
	"island",
	"mobile",
	"extension",
	"web",
	"cli",
	"unknown",
]);
const appCompanionSchema = preservePickerRecord(
	z.object({
		icon: z.string().nullable(),
		label: z.string(),
		shortcut: z.string().nullable(),
	})
);
const appRequiresSchema = preservePickerRecord(
	z.object({
		apps: preservePickerRows(
			preservePickerRecord(
				z.object({ id: z.string(), minVersion: z.string().nullable() })
			)
		),
		grants: z.array(z.string()),
	})
);
const appRunnableSchema = preservePickerRecord(
	z.object({
		config: jsonResponseValueSchema,
		id: z.string(),
		kind: z.string(),
		name: z.string(),
	})
);
const appLayerSchema = preservePickerRecord(
	z.object({
		capability: z.string(),
		selectable: z.boolean().optional(),
		target: z.string().nullish(),
		title: z.string().nullish(),
		toolkit: z.boolean().optional(),
		verbs: z.array(z.string()).optional(),
	})
);
const appSupportSchema = preservePickerRecord(
	z.object({
		inheritedFrom: z.string().nullish(),
		support: z.string().nullish(),
		surface: z.string(),
	})
);
const cardDitherSchema = preservePickerRecord(
	z.object({
		direction: z.string().nullish(),
		from: z.union([z.string(), z.number(), z.null()]).optional(),
		to: z.union([z.string(), z.number(), z.null()]).optional(),
	})
);
const appInfoRecordSchema = preservePickerRecord(
	z.object({
		accentColor: z.string().nullish(),
		approvedGrants: z.array(z.string()).optional(),
		builtIn: z.boolean(),
		category: z.string().nullable().optional(),
		channel: z.string().nullable().optional(),
		commands: preservePickerRows(
			preservePickerRecord(
				z.object({
					method: z.string(),
					name: z.string(),
					path: z.string(),
					summary: z.string().nullable(),
				})
			)
		).optional(),
		companion: appCompanionSchema.nullable(),
		description: z.string().nullable().optional(),
		enabled: z.boolean(),
		external: z.boolean().optional(),
		icon: z.string().nullable().optional(),
		iconBackground: z.string().nullable().optional(),
		iconDither: cardDitherSchema.nullable().optional(),
		iconPadding: z.string().nullable().optional(),
		iconUrl: z.string().nullable().optional(),
		id: z.string(),
		installed: z.boolean(),
		installedVersion: z.string().nullable(),
		layers: preservePickerRows(appLayerSchema).optional(),
		localOnly: z.boolean(),
		mandatory: z.boolean().optional(),
		mcpOAuthServers: preservePickerRows(
			preservePickerRecord(
				z.object({
					clientId: z.string().nullable(),
					name: z.string(),
					resource: z.string(),
				})
			)
		).optional(),
		name: z.string(),
		optionalPermissionGrants: z.array(z.string()).optional(),
		permissionGrants: z.array(z.string()),
		requires: appRequiresSchema.nullable(),
		runnables: preservePickerRows(appRunnableSchema),
		sidecarName: z.string().nullable(),
		stability: z.string().nullable().optional(),
		suppressedBySafeMode: z.boolean().optional(),
		surfaceSupport: preservePickerRows(appSupportSchema),
		tagline: z.string().nullable().optional(),
		targets: z.array(appSurfaceSchema),
		tier: z.enum(["core", "community"]).nullable().optional(),
		version: z.string(),
		windowsFirst: z.boolean(),
	})
);
export const workflowAppsRecordsSchema =
	preservePickerRows(appInfoRecordSchema);
export type WorkflowAppsRecords = z.output<typeof workflowAppsRecordsSchema>;
