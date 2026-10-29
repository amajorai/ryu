/**
 * Shared, secret-free runtime contract for Ryu Companion apps.
 *
 * The host owns the implementation. Apps only receive projections and invoke
 * typed, grant-gated capabilities through `window.ryu`; this file is the
 * cross-package type seam so every app does not invent its own provider shape.
 */

import {
	type ProviderUsageReading,
	providerUsageReadingSchema,
	type SubscriptionsSnapshot,
	subscriptionsSnapshotSchema,
} from "@ryuhq/core-client/usage";
import { z } from "zod";

/**
 * A catalog provider. It never carries saved accounts: account identity (labels
 * are often email addresses) is only reachable through the separately consented
 * `subscriptions.*` capability ({@link RyuAppBridge.subscriptions}).
 */
export interface RyuProvider {
	active?: boolean | undefined;
	api: string;
	authKind: string;
	configured: boolean;
	custom?: boolean | undefined;
	id: string;
	label: string;
	managed?: boolean | undefined;
	modelOverrides?: Record<string, boolean> | undefined;
	routing?: string | undefined;
	routingLocked?: boolean | undefined;
	suggestedModels?: string[] | undefined;
	supportsDiscovery?: boolean | undefined;
}

export interface RyuAgent {
	description?: string | null | undefined;
	enabled?: boolean | null | undefined;
	engine?: string | null | undefined;
	gatewayBypass?: boolean | null | undefined;
	id: string;
	installed?: boolean | null | undefined;
	model?: string | null | undefined;
	name: string;
	recommended?: boolean | null | undefined;
	title?: string | null | undefined;
	transport?: string | null | undefined;
}

export interface RyuPluginSummary {
	compatibility?: RyuCompatibilityVerdict | undefined;
	compatible: boolean;
	enabled: boolean;
	hasCompanion: boolean;
	hookCount: number;
	hookEventCount: number;
	id: string;
	name: string;
	runnableCount: number;
	source?: string | undefined;
	version: string;
}

export interface RyuCompatibilityVerdict {
	compatible: boolean;
	unmet?: unknown[] | undefined;
}

export interface RyuHookSummary {
	enabled: boolean;
	hookId: string;
	on: string;
	pluginId: string;
	priority: number;
}

export interface RyuHookEventSummary {
	description?: string | null | undefined;
	enabled: boolean;
	id: string;
	payloadExample?: unknown | undefined;
	pluginId: string;
	title: string;
}

/** A persisted, secret-free runtime choice an app can attach to its own data. */
export type RyuRuntimeSelection =
	| { agentId: string; kind: "agent" }
	| { kind: "model"; modelId: string; providerId: string };

export interface RyuCatalogCurrent {
	model?: string | null | undefined;
	provider: string;
	providerRouting: Record<string, string>;
	routing: string;
	thinkingLevel?: string | null | undefined;
}

export interface RyuCatalogSnapshot {
	agents: RyuAgent[];
	apiTypes: string[];
	current: RyuCatalogCurrent;
	hookEvents: RyuHookEventSummary[];
	hooks: RyuHookSummary[];
	plugins: RyuPluginSummary[];
	providers: RyuProvider[];
	thinkingLevels: string[];
	version: number;
}

export interface RyuCatalogModel {
	id: string;
	name?: string | undefined;
}

export interface RyuCatalogModels {
	models: RyuCatalogModel[];
	providerId: string;
	source: string;
}

const catalogProviderSchema = z.looseObject({
	active: z.boolean().optional(),
	api: z.string(),
	authKind: z.string(),
	configured: z.boolean(),
	custom: z.boolean().optional(),
	id: z.string(),
	label: z.string(),
	managed: z.boolean().optional(),
	modelOverrides: z.record(z.string(), z.boolean()).optional(),
	routing: z.string().optional(),
	routingLocked: z.boolean().optional(),
	suggestedModels: z.array(z.string()).optional(),
	supportsDiscovery: z.boolean().optional(),
});
const catalogAgentSchema = z.looseObject({
	id: z.string(),
	name: z.string(),
	description: z.string().nullable().optional(),
	enabled: z.boolean().nullable().optional(),
	engine: z.string().nullable().optional(),
	gatewayBypass: z.boolean().nullable().optional(),
	installed: z.boolean().nullable().optional(),
	model: z.string().nullable().optional(),
	recommended: z.boolean().nullable().optional(),
	title: z.string().nullable().optional(),
	transport: z.string().nullable().optional(),
});
const catalogPluginSchema = z.looseObject({
	compatibility: z
		.looseObject({
			compatible: z.boolean(),
			unmet: z.array(z.json()).optional(),
		})
		.optional(),
	compatible: z.boolean(),
	enabled: z.boolean(),
	hasCompanion: z.boolean(),
	hookCount: z.number(),
	hookEventCount: z.number(),
	id: z.string(),
	name: z.string(),
	runnableCount: z.number(),
	source: z.string().optional(),
	version: z.string(),
});

/** Validate Core's catalog projection while retaining its additional public metadata. */
export const ryuCatalogSnapshotSchema = z.looseObject({
	agents: z.array(catalogAgentSchema),
	apiTypes: z.array(z.string()),
	current: z.looseObject({
		model: z.string().nullable().optional(),
		provider: z.string(),
		providerRouting: z.record(z.string(), z.string()),
		routing: z.string(),
		thinkingLevel: z.string().nullable().optional(),
	}),
	hookEvents: z.array(
		z.looseObject({
			description: z.string().nullable().optional(),
			enabled: z.boolean(),
			id: z.string(),
			payloadExample: z.json().optional(),
			pluginId: z.string(),
			title: z.string(),
		})
	),
	hooks: z.array(
		z.looseObject({
			enabled: z.boolean(),
			hookId: z.string(),
			on: z.string(),
			pluginId: z.string(),
			priority: z.number(),
		})
	),
	plugins: z.array(catalogPluginSchema),
	providers: z.array(catalogProviderSchema),
	thinkingLevels: z.array(z.string()),
	version: z.number(),
}) satisfies z.ZodType<RyuCatalogSnapshot>;

/** Validate the provider discovery response without dropping model metadata. */
export const ryuCatalogModelsSchema = z.looseObject({
	models: z.array(
		z.looseObject({ id: z.string(), name: z.string().optional() })
	),
	providerId: z.string(),
	source: z.string(),
}) satisfies z.ZodType<RyuCatalogModels>;

/** Every subscription provider with its saved accounts and usage (`subscriptions.list`). */
export type RyuSubscriptions = SubscriptionsSnapshot;
/** One account's usage reading (`subscriptions.usage`). */
export type RyuProviderUsageReading = ProviderUsageReading;

/** `subscriptions.list` arguments. `usage` defaults to `cached` (never waits on a
 *  vendor; cold accounts read `pending`). `force` is not available to apps. */
export interface RyuSubscriptionsListArgs {
	providerId?: string | undefined;
	usage?: "none" | "cached" | "refresh" | undefined;
}

/** `subscriptions.usage` arguments. Omitting `accountId` reads the active account. */
export interface RyuSubscriptionUsageArgs {
	accountId?: string | undefined;
	providerId: string;
}

/** Validate Core's subscriptions snapshot (shared with `@ryuhq/core-client`). */
export const ryuSubscriptionsSchema = subscriptionsSnapshotSchema;
/** Validate one Core usage reading (shared with `@ryuhq/core-client`). */
export const ryuProviderUsageReadingSchema = providerUsageReadingSchema;

/** A reachable URL projection for the active node. No credential crosses this seam. */
export interface RyuNodeShareOrigin {
	origin: string;
	reachable: true;
	source: "active" | "lan" | "mesh";
}

/** The host-installed bridge surface consumed by full-page Companion apps. */
export interface RyuAppBridge {
	agent?: {
		run(input: {
			agent_id?: string;
			task: string;
			max_tokens?: number;
			preset?: string;
			wall_time_secs?: number;
		}): Promise<string>;
	};
	catalog?: {
		models(input: { providerId: string }): Promise<RyuCatalogModels>;
		snapshot(): Promise<RyuCatalogSnapshot>;
	};
	files?: {
		read(input: {
			uri: string;
		}): Promise<import("./opened-file.ts").OpenedFileSnapshot>;
		write(
			input: { uri: string; expectedRevision: string } & (
				| { text: string; blob?: never }
				| { blob: string; text?: never }
			)
		): Promise<import("./opened-file.ts").OpenedFileSnapshot>;
	};
	listAgents?: (() => Promise<Pick<RyuAgent, "id" | "name">[]>) | undefined;
	model?: {
		complete(input: {
			effort?: string;
			model?: string;
			model_pref_key?: string;
			provider?: string;
			prompt: string;
			system?: string;
		}): Promise<string>;
	};
	node?: {
		shareOrigins(): Promise<RyuNodeShareOrigin[]>;
	};
	/**
	 * Saved subscription accounts and their usage (grant `subscriptions:read`,
	 * node owner/admin only). Labels may be email addresses: show them, never
	 * persist them. Absent on hosts older than host API 1.19 — feature-detect.
	 */
	subscriptions?: {
		list(input?: RyuSubscriptionsListArgs): Promise<RyuSubscriptions>;
		usage(input: RyuSubscriptionUsageArgs): Promise<RyuProviderUsageReading>;
	};
}
