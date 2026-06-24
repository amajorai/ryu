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
	/** "gateway" | "direct". */
	routing: string;
	thinkingLevel: string | null;
}

/** A provider Pi supports, as surfaced by the catalog endpoint. */
export interface PiProvider {
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
	/** "gateway" | "direct". */
	routing: string;
	suggestedModels: string[];
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
