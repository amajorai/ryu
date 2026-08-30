/**
 * Shared, secret-free runtime contract for Ryu Companion apps.
 *
 * The host owns the implementation. Apps only receive projections and invoke
 * typed, grant-gated capabilities through `window.ryu`; this file is the
 * cross-package type seam so every app does not invent its own provider shape.
 */

export interface RyuProviderAccount {
	accountId: string;
	active: boolean;
	kind: string;
	label: string;
	updatedAt?: number;
}

export interface RyuProvider {
	accounts?: RyuProviderAccount[];
	active?: boolean;
	api: string;
	authKind: string;
	configured: boolean;
	custom?: boolean;
	id: string;
	label: string;
	managed?: boolean;
	modelOverrides?: Record<string, boolean>;
	routing?: string;
	routingLocked?: boolean;
	suggestedModels?: string[];
	supportsDiscovery?: boolean;
}

export interface RyuAgent {
	description?: string | null;
	enabled?: boolean | null;
	engine?: string | null;
	gatewayBypass?: boolean | null;
	id: string;
	installed?: boolean | null;
	model?: string | null;
	name: string;
	recommended?: boolean | null;
	title?: string | null;
	transport?: string | null;
}

export interface RyuPluginSummary {
	compatibility?: RyuCompatibilityVerdict;
	compatible: boolean;
	enabled: boolean;
	hasCompanion: boolean;
	hookCount: number;
	hookEventCount: number;
	id: string;
	name: string;
	runnableCount: number;
	source?: string;
	version: string;
}

export interface RyuCompatibilityVerdict {
	compatible: boolean;
	unmet?: unknown[];
}

export interface RyuHookSummary {
	enabled: boolean;
	hookId: string;
	on: string;
	pluginId: string;
	priority: number;
}

export interface RyuHookEventSummary {
	description?: string | null;
	enabled: boolean;
	id: string;
	payloadExample?: unknown;
	pluginId: string;
	title: string;
}

/** A persisted, secret-free runtime choice an app can attach to its own data. */
export type RyuRuntimeSelection =
	| { agentId: string; kind: "agent" }
	| { kind: "model"; modelId: string; providerId: string };

export interface RyuCatalogCurrent {
	model?: string | null;
	provider: string;
	providerRouting: Record<string, string>;
	routing: string;
	thinkingLevel?: string | null;
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
	name?: string;
}

export interface RyuCatalogModels {
	models: RyuCatalogModel[];
	providerId: string;
	source: string;
}

/** A reachable URL projection for the active node. No credential crosses this seam. */
export interface RyuNodeShareOrigin {
	origin: string;
	reachable: true;
	source: "active" | "mesh";
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
	listAgents?: () => Promise<unknown>;
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
}
