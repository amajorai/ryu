import { type ApiTarget, request } from "./client.ts";
import type { GatewayProviderAccount } from "./gateway.ts";
import type { GatewayApiKey } from "./gateway-budget-config.ts";
import {
	fetchGatewayConfig,
	updateGatewayConfig,
} from "./gateway-config-api.ts";
import type { GatewaySdkContext } from "./gateway-provider-config.ts";
import { gatewayProviderEditResultResponseSchema } from "./gateway-status-response-contracts.ts";

// ── BYOK provider-key vault helpers (Unit U026) ──────────────────────────────
//
// These call Core's `PUT /api/gateway/providers`, which writes the key to
// gateway.toml and restarts the gateway so the change takes effect immediately.
// The key value travels over the loopback interface only (desktop → Core); it
// is not stored in renderer state after the save completes.

// "gemini" is a BYOK slug rather than a gateway ProviderKind: the key is stored
// in the genai backend's nested keys table ([providers.genai].keys.gemini) by
// Core, so the gemini key flows to the `genai` provider.
export type ByokProvider =
	| "openai"
	| "anthropic"
	| "openrouter"
	| "gemini"
	| "voyage"
	| "jina"
	| "mistral"
	| "huggingface"
	| "nvidia"
	| "together"
	| "fireworks"
	| "qwen"
	| "cohere"
	| "deepgram"
	| "assemblyai"
	| "elevenlabs"
	| "inworld"
	| "modal"
	| "replicate"
	| "fal"
	| "recraft"
	| "stability"
	| "bfl"
	| "minimax"
	| "runway"
	| "topaz"
	| `genai-${string}`;

export type GatewayProviderApplication =
	| {
			status: "applied" | "already_applied";
			requestedRevision: string;
			appliedRevision: string;
			epoch: { boot: string; sequence: number };
	  }
	| { status: "superseded"; requestedRevision: string; currentRevision: string }
	| {
			status: "failed";
			requestedRevision: string;
			activeRevision?: string | null;
			code: string;
	  }
	| { status: "offline" | "unmanaged"; requestedRevision: string };

export interface GatewayProviderEditResult {
	accountsApplied?: boolean;
	configRevision?: string;
	gateway_application?: GatewayProviderApplication;
	gateway_outcome?: string;
	gateway_restarted: boolean;
	persisted?: boolean;
	success: boolean;
}

export function applySavedGatewayProviderConnections(
	target: ApiTarget,
	revision: string
): Promise<GatewayProviderEditResult> {
	return request<GatewayProviderEditResult>(
		target,
		"/api/gateway/providers/apply",
		{
			method: "POST",
			body: { revision },
		},
		gatewayProviderEditResultResponseSchema
	);
}

export async function configureGatewayProviderAccount(
	target: ApiTarget,
	provider: ByokProvider,
	account: GatewayProviderAccount,
	expectedRevision?: string
): Promise<void> {
	const result = await request<GatewayProviderEditResult>(
		target,
		"/api/gateway/providers",
		{
			method: "PUT",
			body: {
				provider,
				account_action: "configure",
				expectedRevision,
				accountId: account.id,
				accountPolicy: {
					drain_threshold_percent: account.drainThresholdPercent ?? null,
					name: account.name,
					enabled: account.enabled,
					priority: account.priority,
				},
			},
		},
		gatewayProviderEditResultResponseSchema
	);
	requireGatewayProviderReload(result);
}

export async function setGatewaySdkConnection(
	target: ApiTarget,
	provider: ByokProvider,
	options: {
		apiKey?: string;
		context?: GatewaySdkContext;
		allowEnvironment?: boolean;
		accountId?: string;
		expectedRevision?: string;
	}
): Promise<void> {
	const result = await request<GatewayProviderEditResult>(
		target,
		"/api/gateway/providers",
		{
			method: "PUT",
			body: {
				provider,
				account_action: options.accountId ? "replace" : "set",
				api_key: options.apiKey,
				sdkContext: options.context,
				allowEnvironment: options.allowEnvironment,
				accountId: options.accountId,
				expectedRevision: options.expectedRevision,
			},
		},
		gatewayProviderEditResultResponseSchema
	);
	requireGatewayProviderReload(result);
}

export function requireGatewayProviderReload(
	result: GatewayProviderEditResult
): void {
	const application = result.gateway_application;
	if (application) {
		switch (application.status) {
			case "applied":
			case "already_applied":
				if (
					application.requestedRevision !== application.appliedRevision ||
					(result.configRevision &&
						result.configRevision !== application.appliedRevision)
				) {
					throw new Error(
						"Connection saved, but Gateway acknowledged a different configuration. Refresh the node before editing again."
					);
				}
				return;
			case "superseded":
				throw new Error(
					"Connection saved, but a newer configuration replaced it. Refresh the node before editing again."
				);
			case "offline":
				throw new Error(
					"Connection saved. Start your Gateway and refresh the node to apply it."
				);
			case "unmanaged":
				throw new Error(
					"Connection saved. Restart your externally managed Gateway to apply it."
				);
			case "failed":
				throw new Error(
					"Connection saved, but Gateway could not apply it. Refresh the node and check its status before retrying."
				);
			default: {
				const exhaustive: never = application;
				void exhaustive;
				throw new Error(
					"Gateway returned an unknown application result. Refresh the node before editing again."
				);
			}
		}
	}
	if (result.gateway_restarted || result.accountsApplied) {
		return;
	}
	if (result.gateway_outcome === "unmanaged") {
		throw new Error(
			"Connection saved. Restart your externally managed Gateway to apply it."
		);
	}
	throw new Error(
		"Connection saved, but Gateway restart did not finish. Check its status before retrying."
	);
}

/** Set (or overwrite) a provider API key in the gateway config. */
export async function setGatewayProvider(
	target: ApiTarget,
	provider: ByokProvider,
	apiKey: string,
	signal?: AbortSignal,
	expectedRevision?: string
): Promise<GatewayProviderEditResult> {
	return request<GatewayProviderEditResult>(
		target,
		"/api/gateway/providers",
		{
			method: "PUT",
			body: { provider, api_key: apiKey, expectedRevision },
			signal,
		},
		gatewayProviderEditResultResponseSchema
	);
}

/** Remove a provider key from the gateway config. */
export async function clearGatewayProvider(
	target: ApiTarget,
	provider: ByokProvider,
	signal?: AbortSignal,
	expectedRevision?: string
): Promise<GatewayProviderEditResult> {
	return request<GatewayProviderEditResult>(
		target,
		"/api/gateway/providers",
		{
			method: "PUT",
			body: { provider, api_key: null, expectedRevision },
			signal,
		},
		gatewayProviderEditResultResponseSchema
	);
}

/** Replace the stored credential identified by its stable account ID. */
export function replaceGatewayProviderAccount(
	target: ApiTarget,
	provider: ByokProvider,
	accountId: string,
	apiKey: string,
	expectedRevision?: string
): Promise<GatewayProviderEditResult> {
	return request<GatewayProviderEditResult>(
		target,
		"/api/gateway/providers",
		{
			method: "PUT",
			body: {
				provider,
				account_action: "replace",
				accountId,
				api_key: apiKey,
				expectedRevision,
			},
		},
		gatewayProviderEditResultResponseSchema
	);
}

/** Add another credential to a provider's Gateway rotation set. */
export async function addGatewayProviderAccount(
	target: ApiTarget,
	provider: ByokProvider,
	apiKey: string,
	expectedRevision?: string
): Promise<GatewayProviderEditResult> {
	return request<GatewayProviderEditResult>(
		target,
		"/api/gateway/providers",
		{
			method: "PUT",
			body: {
				provider,
				api_key: apiKey,
				account_action: "add",
				expectedRevision,
			},
		},
		gatewayProviderEditResultResponseSchema
	);
}

/** Remove one credential by its index in the redacted Gateway account list. */
export async function removeGatewayProviderAccount(
	target: ApiTarget,
	provider: ByokProvider,
	accountIndex: number,
	accountId?: string,
	expectedRevision?: string
): Promise<GatewayProviderEditResult> {
	return request<GatewayProviderEditResult>(
		target,
		"/api/gateway/providers",
		{
			method: "PUT",
			body: {
				provider,
				account_action: "remove",
				expectedRevision,
				...(accountId ? { accountId } : { account_index: accountIndex }),
			},
		},
		gatewayProviderEditResultResponseSchema
	);
}

// ── BYOA key management (U027) ────────────────────────────────────────────────
//
// BYOA = "bring your own agent". An existing OpenAI-compatible agent (OpenClaw,
// Hermes, any framework) is pointed at the Ryu gateway as its OpenAI base URL.
// It authenticates using an API key generated here, with `trusted_forwarder: true`
// so the gateway honours the `x-ryu-agent-id` header for per-agent budgets.
//
// Interpretation: the EXTERNAL AGENT points TO the gateway (it becomes a gateway
// client). This is NOT about Core routing OUT to dynamic per-agent upstreams —
// that is a separate, deferred spike.
//
// The 'migrate to the lean Ryu agent' flow (replacing the external agent with
// Pi or a native Ryu agent) is also distinct from BYOA and tracked separately.

/**
 * Generate a cryptographically random gateway API key value.
 * The key is a 32-byte hex string (256 bits of entropy), prefixed with `sk-ryu-`
 * so it is visually distinct from other API keys.
 */
export function generateGatewayKey(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
		""
	);
	return `sk-ryu-${hex}`;
}

/**
 * Register a new BYOA gateway key by merging it into the existing `api_keys`
 * list. Fetches the current config, appends (or replaces by name) the new entry,
 * and persists via `PUT /api/gateway/config`.
 *
 * The returned `key` is the plaintext value — save it before returning to the
 * user; GET /v1/config always redacts it to `"***"`.
 */
export async function registerByoaKey(
	target: ApiTarget,
	entry: GatewayApiKey
): Promise<{ ok: boolean }> {
	const cfg = await fetchGatewayConfig(target);
	const existingKeys = cfg.auth?.api_keys ?? [];
	const filtered = existingKeys.filter((k) => k.name !== entry.name);
	const next = [...filtered, entry];
	return updateGatewayConfig(target, {
		auth: { api_keys: next },
		expectedRevision: cfg.configRevision ?? undefined,
	});
}

/**
 * Remove a BYOA gateway key by name.
 */
export async function removeByoaKey(
	target: ApiTarget,
	name: string
): Promise<{ ok: boolean }> {
	const cfg = await fetchGatewayConfig(target);
	const next = (cfg.auth?.api_keys ?? []).filter((k) => k.name !== name);
	return updateGatewayConfig(target, {
		auth: { api_keys: next },
		expectedRevision: cfg.configRevision ?? undefined,
	});
}
