// apps/desktop/src/lib/api/pi-config.ts
//
// Typed client for Core's Ryu-managed Pi configuration endpoints
// (`/api/pi-config`). The Ryu agent runs Core's OWN Pi binary against an
// ISOLATED config directory (`PI_CODING_AGENT_DIR`), separate from any Pi the
// user has on their PATH. These endpoints read/write that config so the desktop
// can pick the provider + model from the set Pi supports (per pi.dev docs).
//
// "gateway" provider => Gateway-routed (governed egress, no keys stored in Pi).
// Any other provider  => direct egress to that provider (a deliberate bypass).

import { type ApiTarget, request } from "./client.ts";

/** The current Pi configuration. Never contains secrets. */
export interface PiConfig {
	/** The isolated config directory Core writes (`PI_CODING_AGENT_DIR`). */
	configDir: string;
	model: string | null;
	/** Logical provider id ("gateway" or a built-in/custom provider id). */
	provider: string;
	/** Per-provider routing overrides, keyed by provider id. */
	providerRouting?: Record<string, string>;
	/** "gateway" | "direct" — the ACTIVE provider's effective routing. */
	routing: string;
	thinkingLevel: string | null;
}

/** A provider Pi supports, as surfaced by the catalog endpoint. */
export interface PiProvider {
	/** Whether this provider is the currently-active one. */
	active?: boolean;
	/** Pi `api` type (openai-completions / anthropic-messages / ...). */
	api: string;
	/** Environment variable Pi reads for this provider's key (may be empty). */
	authEnv: string;
	/** "subscription" | "api-key" | "none" (gateway). */
	authKind: string;
	/** Whether a usable credential is already available (auth.json/env/models.json). */
	configured: boolean;
	/** True for user-defined custom providers from models.json. */
	custom: boolean;
	id: string;
	label: string;
	/** True for the Ryu-managed provider (included with the plan, no key needed). */
	managed?: boolean;
	/**
	 * Per-model enable overrides keyed by model id. An id absent from this map
	 * is enabled by default; only explicitly-toggled models appear.
	 */
	modelOverrides?: Record<string, boolean>;
	/** "gateway" | "direct". */
	routing: string;
	/** When true, the routing toggle is fixed (managed/gateway) and disabled. */
	routingLocked?: boolean;
	suggestedModels: string[];
	/** Whether Core can dynamically discover this provider's model list. */
	supportsDiscovery?: boolean;
}

export interface PiCatalog {
	apiTypes: string[];
	providers: PiProvider[];
	thinkingLevels: string[];
}

/** The desired configuration to apply. */
export interface PiConfigInput {
	/** Pi `api` type for a custom provider (defaults to openai-completions). */
	api?: string | null;
	/** Optional api-key credential (written to the isolated auth.json/models.json). */
	apiKey?: string | null;
	/** Optional base URL for a custom OpenAI-compatible provider (Ollama, vLLM, ...). */
	baseUrl?: string | null;
	model?: string | null;
	provider: string;
	thinkingLevel?: string | null;
}

export async function fetchPiConfig(target: ApiTarget): Promise<PiConfig> {
	const data = await request<{ config: PiConfig }>(target, "/api/pi-config");
	return data.config;
}

export async function fetchPiCatalog(target: ApiTarget): Promise<PiCatalog> {
	return await request<PiCatalog>(target, "/api/pi-config/catalog");
}

export async function updatePiConfig(
	target: ApiTarget,
	input: PiConfigInput
): Promise<PiConfig> {
	const data = await request<{ config: PiConfig }>(target, "/api/pi-config", {
		method: "PUT",
		body: input,
	});
	return data.config;
}

/** Credentials/routing to store for a provider WITHOUT making it active. */
export interface ProviderConfigInput {
	/** Pi `api` type for a custom provider (defaults to openai-completions). */
	api?: string | null;
	/** Optional api-key credential (written to the isolated auth.json/models.json). */
	apiKey?: string | null;
	/** Optional base URL for a custom OpenAI-compatible provider. */
	baseUrl?: string | null;
	provider: string;
	/** "gateway" | "direct" — per-provider routing override. */
	routing?: string | null;
}

/**
 * Store credentials/routing for a provider without activating it. Returns the
 * refreshed catalog (the `configured`/`routing` flags may flip).
 */
export async function configureProvider(
	target: ApiTarget,
	input: ProviderConfigInput
): Promise<PiCatalog> {
	return await request<PiCatalog>(target, "/api/pi-config/providers", {
		method: "POST",
		body: input,
	});
}

/** Remove a stored credential / custom provider. Returns the refreshed catalog. */
export async function deleteProvider(
	target: ApiTarget,
	id: string
): Promise<PiCatalog> {
	return await request<PiCatalog>(
		target,
		`/api/pi-config/providers/${encodeURIComponent(id)}`,
		{ method: "DELETE" }
	);
}

/** A model surfaced by dynamic discovery. */
export interface DiscoveredModel {
	id: string;
	name?: string;
}

export interface DiscoverModelsInput {
	/** Pi `api` type of an unsaved custom provider (e.g. "anthropic-messages"). */
	api?: string | null;
	apiKey?: string | null;
	baseUrl?: string | null;
	provider?: string | null;
}

export interface DiscoverModelsResult {
	models: DiscoveredModel[];
	/** "discovery" when the list came from the provider, "fallback" otherwise. */
	source: string;
}

/** Ask Core to enumerate a provider's models (live, with a suggested fallback). */
export async function discoverModels(
	target: ApiTarget,
	input: DiscoverModelsInput
): Promise<DiscoverModelsResult> {
	return await request<DiscoverModelsResult>(
		target,
		"/api/pi-config/discover-models",
		{ method: "POST", body: input }
	);
}

export interface CheckProviderInput {
	/** Pi `api` type of an unsaved custom provider (e.g. "anthropic-messages"). */
	api?: string | null;
	apiKey?: string | null;
	baseUrl?: string | null;
	provider?: string | null;
}

export interface CheckProviderResult {
	error?: string;
	latencyMs: number;
	modelCount: number;
	ok: boolean;
}

/**
 * Live-check a provider's connectivity (one authenticated GET to its models
 * endpoint). Persists nothing; keys are sent to Core only for the probe.
 */
export async function checkProvider(
	target: ApiTarget,
	input: CheckProviderInput
): Promise<CheckProviderResult> {
	return await request<CheckProviderResult>(
		target,
		"/api/pi-config/providers/check",
		{ method: "POST", body: input }
	);
}

export interface SetModelEnabledInput {
	enabled: boolean;
	model: string;
	provider: string;
}

/**
 * Enable/disable a single model within a provider. Returns the refreshed catalog
 * so the model's `modelOverrides` entry reflects the new state.
 */
export async function setModelEnabled(
	target: ApiTarget,
	input: SetModelEnabledInput
): Promise<PiCatalog> {
	return await request<PiCatalog>(
		target,
		"/api/pi-config/providers/model-enabled",
		{ method: "POST", body: input }
	);
}
