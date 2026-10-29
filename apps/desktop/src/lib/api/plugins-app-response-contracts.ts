// Response schemas for the app records, lifecycle, doctor and eval endpoints
// that `plugins.ts` reads. Split out of `plugins.ts`; the public client API
// stays there.

import type {
	CardDither,
	CatalogLayer,
	CatalogSurfaceSupport,
} from "@ryu/marketplace/catalog/types";
import type { AppLifecycleAction } from "@ryuhq/core-client/plugins.ts";
import { z } from "zod";
import { pluginValueSchema } from "./plugin-wire-values.ts";
import type {
	AppDependencyWire,
	AppLifecyclePreview,
	AppManifestWire,
	AppRecordWire,
	ManifestTarget,
	PluginDoctorFinding,
	PluginDoctorInventoryItem,
	PluginDoctorReport,
	PluginEvalAttempt,
	PluginEvalCaseResult,
	PluginEvalCaseSummary,
	PluginEvalGraderResult,
	PluginEvalIssue,
	PluginEvalOverview,
	PluginEvalRunResult,
	PluginEvalSuite,
	RequiresWire,
	RunnableEntryWire,
} from "./plugins.ts";

export const cardDitherResponseSchema = z
	.object({
		direction: z.union([z.string(), z.null()]).optional(),
		from: z.union([z.string(), z.number(), z.null()]).optional(),
		to: z.union([z.string(), z.number(), z.null()]).optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<CardDither>;

export const catalogLayerResponseSchema = z
	.object({
		capability: z.string(),
		selectable: z.boolean().optional(),
		target: z.union([z.string(), z.null()]).optional(),
		title: z.union([z.string(), z.null()]).optional(),
		toolkit: z.boolean().optional(),
		verbs: z.array(z.string()).optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<CatalogLayer>;

const appDependencyWireResponseSchema = z
	.object({
		id: z.string(),
		min_version: z.union([z.string(), z.null()]).optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<AppDependencyWire>;

const requiresWireResponseSchema = z
	.object({
		apps: z.array(appDependencyWireResponseSchema).optional(),
		grants: z.array(z.string()).optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<RequiresWire>;

const runnableEntryWireResponseSchema = z
	.object({
		config: pluginValueSchema.optional(),
		id: z.string(),
		kind: z.string(),
		name: z.string(),
		publisher_trust: z
			.union([
				z.literal("gold"),
				z.literal("blue"),
				z.literal("dotted"),
				z.null(),
			])
			.optional(),
		publisher_trust_source: z
			.union([
				z.literal("ryu_staff"),
				z.literal("paid_plan"),
				z.literal("stripe_connect"),
				z.literal("none"),
				z.null(),
			])
			.optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<RunnableEntryWire>;

export const catalogSurfaceSupportResponseSchema = z
	.object({
		inheritedFrom: z.union([z.string(), z.null()]).optional(),
		support: z.union([z.string(), z.null()]).optional(),
		surface: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<CatalogSurfaceSupport>;

const manifestTargetResponseSchema = z.enum([
	"gateway",
	"core",
	"desktop",
	"island",
	"mobile",
	"extension",
	"web",
	"cli",
	"unknown",
]) satisfies z.ZodType<ManifestTarget>;

const appManifestWireResponseSchema = z
	.object({
		accentColor: z.union([z.string(), z.null()]).optional(),
		approved_grants: z.array(z.string()).optional(),
		built_in: z.boolean(),
		category: z.union([z.string(), z.null()]).optional(),
		channel: z.union([z.string(), z.null()]).optional(),
		companion: z
			.union([
				z
					.object({
						label: z.string(),
						icon: z.union([z.string(), z.null()]).optional(),
						shortcut: z.union([z.string(), z.null()]).optional(),
					})
					.catchall(pluginValueSchema),
				z.null(),
			])
			.optional(),
		description: z.union([z.string(), z.null()]).optional(),
		developer: z.union([z.string(), z.null()]).optional(),
		enabled: z.boolean(),
		external: z.boolean().optional(),
		icon: z.union([z.string(), z.null()]).optional(),
		iconBackground: z.union([z.string(), z.null()]).optional(),
		iconDither: z.union([cardDitherResponseSchema, z.null()]).optional(),
		iconPadding: z.union([z.string(), z.null()]).optional(),
		iconUrl: z.union([z.string(), z.null()]).optional(),
		id: z.string(),
		installed: z.boolean(),
		installed_version: z.union([z.string(), z.null()]),
		layers: z.array(catalogLayerResponseSchema).optional(),
		local_only: z.boolean(),
		mandatory: z.boolean().optional(),
		system: z.boolean().optional(),
		mcp_servers: z
			.record(
				z.string(),
				z
					.object({
						auth: z
							.union([
								z
									.object({
										type: z.string().optional(),
										client_id: z.union([z.string(), z.null()]).optional(),
									})
									.catchall(pluginValueSchema),
								z.null(),
							])
							.optional(),
						url: z.union([z.string(), z.null()]).optional(),
					})
					.catchall(pluginValueSchema)
			)
			.optional(),
		name: z.string(),
		optional_permission_grants: z.array(z.string()).optional(),
		permission_grants: z.array(z.string()),
		requires: z.union([requiresWireResponseSchema, z.null()]).optional(),
		runnables: z.array(runnableEntryWireResponseSchema),
		sidecar_name: z.union([z.string(), z.null()]),
		stability: z.union([z.string(), z.null()]).optional(),
		deprecated: z
			.union([
				z.object({
					message: z.union([z.string(), z.null()]).optional(),
					replacement: z.union([z.string(), z.null()]).optional(),
				}),
				z.null(),
			])
			.optional()
			.catch(null),
		suppressed_by_safe_mode: z.boolean().optional(),
		surface_support: z.array(catalogSurfaceSupportResponseSchema).optional(),
		tagline: z.union([z.string(), z.null()]).optional(),
		targets: z.array(manifestTargetResponseSchema).optional(),
		tier: pluginValueSchema.optional(),
		version: z.string(),
		windows_first: z.boolean(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<AppManifestWire>;

const appRecordWireResponseSchema = z
	.object({
		approved_grants: z.array(z.string()),
		created_at: z.union([z.string(), z.null()]),
		enabled: z.boolean(),
		id: z.string(),
		updated_at: z.union([z.string(), z.null()]),
		version: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<AppRecordWire>;

const appLifecycleActionResponseSchema = z.enum([
	"install",
	"enable",
	"disable",
	"uninstall",
	"update",
]) satisfies z.ZodType<AppLifecycleAction>;

export const appLifecyclePreviewResponseSchema = z
	.object({
		action: appLifecycleActionResponseSchema,
		dryRun: z.literal(true),
		success: z.boolean(),
	})
	.catchall(
		z.union([pluginValueSchema, z.undefined()])
	) satisfies z.ZodType<AppLifecyclePreview>;

const pluginDoctorFindingResponseSchema = z
	.object({
		canAutoFix: z.boolean(),
		category: z.string(),
		checkId: z.string(),
		detail: z.string(),
		evidence: pluginValueSchema.optional(),
		pluginId: z.string(),
		recommendedAction: z.string(),
		severity: z.union([
			z.literal("error"),
			z.literal("warning"),
			z.literal("info"),
			z.string(),
		]),
		source: z.string(),
		summary: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginDoctorFinding>;

const pluginEvalCaseSummaryResponseSchema = z
	.object({
		graderCount: z.number(),
		id: z.string(),
		maxTurns: z.number(),
		name: z.string(),
		path: z.string(),
		runnable: z.union([z.string(), z.null()]).optional(),
		runs: z.number(),
		tags: z.array(z.string()),
		timeoutSeconds: z.number(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginEvalCaseSummary>;

const pluginEvalIssueResponseSchema = z
	.object({
		code: z.string(),
		message: z.string(),
		path: z.string(),
		severity: z.union([
			z.literal("error"),
			z.literal("warning"),
			z.literal("info"),
			z.string(),
		]),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginEvalIssue>;

const pluginEvalSuiteResponseSchema = z
	.object({
		caseCount: z.number(),
		cases: z.array(pluginEvalCaseSummaryResponseSchema),
		directory: z.string(),
		graderCount: z.number(),
		issues: z.array(pluginEvalIssueResponseSchema),
		rulesetVersion: z.string(),
		schemaVersion: z.string(),
		status: z.union([
			z.literal("not_configured"),
			z.literal("empty"),
			z.literal("ready"),
			z.literal("ready_with_warnings"),
			z.literal("invalid"),
			z.string(),
		]),
		supportedGraders: z.array(z.string()),
		unsupportedGraders: z.array(z.string()),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginEvalSuite>;

const pluginDoctorInventoryItemResponseSchema = z
	.object({
		evals: pluginEvalSuiteResponseSchema.optional(),
		findingCount: z.number(),
		id: z.string(),
		name: z.string(),
		status: z.union([
			z.literal("healthy"),
			z.literal("warning"),
			z.literal("error"),
			z.string(),
		]),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginDoctorInventoryItem>;

export const pluginDoctorReportResponseSchema = z
	.object({
		counts: z
			.object({
				errors: z.number(),
				info: z.number(),
				plugins: z.number(),
				warnings: z.number(),
			})
			.catchall(pluginValueSchema),
		findings: z.array(pluginDoctorFindingResponseSchema),
		generatedAt: z.string(),
		plugins: z.array(pluginDoctorInventoryItemResponseSchema),
		profile: z.union([z.literal("lint"), z.string()]),
		readOnly: z.boolean(),
		rulesetVersion: z.string(),
		schemaVersion: z.string(),
		scope: z.string(),
		score: z.number(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginDoctorReport>;

const pluginEvalOverviewResponseSchema = z
	.object({
		artifactKind: z.union([z.literal("plugin"), z.literal("app"), z.string()]),
		pluginId: z.string(),
		suite: pluginEvalSuiteResponseSchema,
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginEvalOverview>;

const pluginEvalGraderResultResponseSchema = z
	.object({
		detail: z.string(),
		executed: z.boolean(),
		id: z.string(),
		score: z.union([z.number(), z.null()]),
		status: z.union([
			z.literal("pass"),
			z.literal("fail"),
			z.literal("skipped"),
			z.string(),
		]),
		type: z.string(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginEvalGraderResult>;

const pluginEvalAttemptResponseSchema = z
	.object({
		durationMs: z.number(),
		error: z.union([z.string(), z.null()]),
		graders: z.array(pluginEvalGraderResultResponseSchema),
		id: z.string(),
		responsePreview: z.union([z.string(), z.null()]),
		score: z.union([z.number(), z.null()]),
		status: z.union([
			z.literal("passed"),
			z.literal("failed"),
			z.literal("unavailable"),
			z.literal("error"),
			z.literal("skipped"),
			z.string(),
		]),
		toolCalls: z.array(z.string()),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginEvalAttempt>;

const pluginEvalCaseResultResponseSchema = z
	.object({
		failed: z.number(),
		id: z.string(),
		name: z.string(),
		passed: z.number(),
		runs: z.array(pluginEvalAttemptResponseSchema),
		score: z.union([z.number(), z.null()]),
		skipped: z.number(),
		status: z.union([
			z.literal("passed"),
			z.literal("failed"),
			z.literal("unavailable"),
			z.string(),
		]),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginEvalCaseResult>;

export const pluginEvalRunResultResponseSchema = z
	.object({
		artifactKind: z.union([z.literal("plugin"), z.literal("app"), z.string()]),
		baseline: z
			.object({ reason: z.string(), status: z.string() })
			.catchall(pluginValueSchema),
		cases: z.array(pluginEvalCaseResultResponseSchema),
		evidenceLevel: z.string(),
		finishedAt: z.string().optional(),
		pluginId: z.string(),
		runId: z.union([z.string(), z.null()]),
		schemaVersion: z.string(),
		score: z.union([z.number(), z.null()]),
		startedAt: z.string().optional(),
		status: z.union([
			z.literal("passed"),
			z.literal("failed"),
			z.literal("partial"),
			z.literal("unavailable"),
			z.literal("invalid"),
			z.literal("not_configured"),
			z.string(),
		]),
		suite: pluginEvalSuiteResponseSchema,
		threshold: z.number().optional(),
	})
	.catchall(pluginValueSchema) satisfies z.ZodType<PluginEvalRunResult>;

export const appsEnvelopeSchema = z
	.object({ apps: z.array(appManifestWireResponseSchema).optional() })
	.catchall(pluginValueSchema);

export const appRecordEnvelopeSchema = z
	.object({
		app: appRecordWireResponseSchema,
		externally_managed: z.boolean().optional(),
		notice: z.string().optional(),
	})
	.catchall(pluginValueSchema);

export const evalsOverviewSchema = z.union([
	pluginEvalOverviewResponseSchema,
	z
		.object({ plugins: z.array(pluginEvalOverviewResponseSchema) })
		.catchall(pluginValueSchema),
]);

export const grantsEnvelopeSchema = z
	.object({ approved_grants: z.array(z.string()).optional() })
	.catchall(pluginValueSchema);

export const uninstallEnvelopeSchema = z
	.object({
		disabled: z.array(z.string()).optional(),
		externally_managed: z.boolean().optional(),
		notice: z.string().optional(),
		removed: z.string().optional(),
		success: z.boolean().optional(),
	})
	.catchall(pluginValueSchema);

export function parsePluginResponse<S extends z.ZodType>(
	schema: S,
	value: Parameters<S["parse"]>[0]
): z.output<S> {
	return z
		.custom<z.output<S>>(
			(candidate) =>
				pluginValueSchema.safeParse(candidate).success &&
				schema.safeParse(candidate).success
		)
		.parse(value);
}
