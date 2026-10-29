import { piConfigResponseSchema } from "@ryuhq/core-client/pi-config.ts";
import { z } from "zod";
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

import type { PiProvider as CorePiProvider } from "@ryuhq/core-client/pi-config.ts";
import { openSse, type SseMessage } from "@ryuhq/protocol/sse";
import { piLoginEventSchema } from "./billing-login-stream-contracts.ts";
import { type ApiTarget, apiUrl, request } from "./client.ts";

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
	/** Core-advertised selection modes and account kinds for new conversations. */
	accountRouting?: {
		credentialKinds: ("api_key" | "oauth")[];
		quotaObservations: boolean;
		strategies: OAuthAccountStrategy[];
	} | null;
	/** Every account this provider holds in the sealed vault (labels only —
	 *  never a credential). Lets the picker list + switch sign-ins. */
	accounts?: PiAccount[];
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
	connectionState?:
		| "authorized"
		| "identity-only"
		| "reconnect-required"
		| "unavailable"
		| "disconnected"
		| null;
	/** The credit pool this provider's spend attributes to, or `""` for BYOK.
	 *
	 *  A SEGREGATED pool (`cloudflare`, `bedrock`) is where grants land — a
	 *  free-tier or referral grant is spendable on it with no plan at all. The
	 *  residual `openrouter` pool is the one that genuinely needs a subscription,
	 *  because it has no donated allowance behind it. Anything that gates on
	 *  "managed" ALONE will upsell a subscription for credit the user already
	 *  holds. */
	creditPool?: string;
	/** True for user-defined custom providers from models.json. */
	custom: boolean;
	/** Ryu Router models free credit pays for (the picker's "Free" tag). Core
	 *  reads them from the Gateway router's equivalence table, the same table
	 *  the Gateway routes on. Empty/absent on every other row. */
	freeModels?: string[];
	id: string;
	label: string;
	/** True for any Ryu-managed provider (Ryu supplies the capacity, no key
	 *  needed). No longer implies "included with a paid plan" — see
	 *  {@link Provider.creditPool}. */
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
	/** Whether the managed Pi engine exposes an OAuth sign-in for this provider. */
	supportsOAuth?: boolean;
}

export interface PiCatalog {
	/**
	 * Per-AGENT model visibility, keyed by agent id then model id. An external
	 * agent advertises its own models over ACP rather than through a provider, so
	 * its toggles live here instead of on a {@link PiProvider}. Same rule: an id
	 * absent from the map is enabled.
	 */
	agentModelOverrides?: Record<string, Record<string, boolean>>;
	apiTypes: string[];
	providers: PiProvider[];
	sessionRevocationStatus?: "confirmed" | "not-required" | "unconfirmed";
	thinkingLevels: string[];
}

/** A missing override is enabled; only an explicit false hides a model. */
export function isPiModelEnabled(
	modelOverrides: Record<string, boolean> | undefined,
	modelId: string
): boolean {
	return modelOverrides?.[modelId] !== false;
}

/**
 * One account a Pi provider holds in the sealed vault (labels only — never a
 * credential): `accountId`, `label` (email, provider label, or "Account N"),
 * `kind` ("api_key" | "oauth" | "opaque"), `active` (the account Pi uses this
 * turn), `gatewayActive`, `updatedAt` (epoch millis), and optional
 * `needsReauth` / `connectionState`. The shape is Core-client's catalog schema,
 * so desktop and every other surface validate the same contract.
 */
export type PiAccount = NonNullable<CorePiProvider["accounts"]>[number];

export type ProviderAccountTarget = "gateway" | "self";

export type OAuthAccountStrategy =
	| "manual"
	| "round_robin"
	| "quota_first"
	| "fill_first"
	| "reset_first";

export interface OAuthAccountPoolPolicy {
	accounts: Record<
		string,
		{
			enabled: boolean;
			priority: number;
			drainThresholdPercent?: number | null;
		}
	>;
	drainThresholdPercent: number;
	strategy: OAuthAccountStrategy;
}

/** Routing for new sessions of supported provider account pools. */
export async function fetchOAuthAccountPoolPolicy(
	target: ApiTarget,
	providerId: string
): Promise<OAuthAccountPoolPolicy> {
	return await request<OAuthAccountPoolPolicy>(
		target,
		`/api/pi-config/providers/${encodeURIComponent(providerId)}/account-pool`,
		{},
		oAuthAccountPoolPolicyResponseSchema
	);
}

export async function updateOAuthAccountPoolPolicy(
	target: ApiTarget,
	providerId: string,
	policy: OAuthAccountPoolPolicy
): Promise<OAuthAccountPoolPolicy> {
	return await request<OAuthAccountPoolPolicy>(
		target,
		`/api/pi-config/providers/${encodeURIComponent(providerId)}/account-pool`,
		{ method: "PUT", body: policy },
		oAuthAccountPoolPolicyResponseSchema
	);
}

/** Map a Pi provider id to the local Gateway provider-key slot, when supported. */
export function gatewayProviderSlug(
	providerId: string
): "anthropic" | "gemini" | "openai" | "openrouter" | null {
	switch (providerId) {
		case "anthropic":
		case "openai":
		case "openrouter":
			return providerId;
		case "google":
			return "gemini";
		default:
			return null;
	}
}

/** Switch a provider account for yourself or install it in the Gateway. */
export async function switchProviderAccount(
	target: ApiTarget,
	providerId: string,
	accountId: string,
	accountTarget: ProviderAccountTarget = "self"
): Promise<PiCatalog> {
	return await request<PiCatalog>(
		target,
		`/api/pi-config/providers/${encodeURIComponent(providerId)}/accounts/switch`,
		{
			method: "POST",
			body: { accountId, target: accountTarget },
		},
		piCatalogResponseSchema
	);
}

/** Remove an account from a provider. Returns the refreshed catalog. */
export async function removeProviderAccount(
	target: ApiTarget,
	providerId: string,
	accountId: string
): Promise<PiCatalog> {
	return await request<PiCatalog>(
		target,
		`/api/pi-config/providers/${encodeURIComponent(providerId)}/accounts/remove`,
		{
			method: "POST",
			body: { accountId },
		},
		piCatalogResponseSchema
	);
}

/** Rename a saved provider account without exposing its credential. */
export async function renameProviderAccount(
	target: ApiTarget,
	providerId: string,
	accountId: string,
	label: string
): Promise<PiCatalog> {
	return await request<PiCatalog>(
		target,
		`/api/pi-config/providers/${encodeURIComponent(providerId)}/accounts/rename`,
		{
			method: "POST",
			body: { accountId, label },
		},
		piCatalogResponseSchema
	);
}

/**
 * The `provider` value that scopes a model toggle to an AGENT rather than a
 * provider (mirrors Core's `AGENT_OVERRIDE_PREFIX`). Core stores both in one
 * place and keeps the agent scopes out of the provider catalog.
 */
export function agentModelScope(agentId: string): string {
	return `agent:${agentId}`;
}

/**
 * Drop the models an agent has toggled off, but never drop `keep` — the model
 * the surface is CURRENTLY set to. Hiding the active selection would leave a
 * picker with no visible value and no way to see what is running; the settings
 * list is where a user turns it back on.
 */
export function filterEnabledModels<T extends { id: string }>(
	items: T[],
	overrides: Record<string, boolean> | undefined,
	keep?: string | null
): T[] {
	if (!overrides) {
		return items;
	}
	return items.filter(
		(item) => item.id === keep || isPiModelEnabled(overrides, item.id)
	);
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
	const data = await request<{ config: PiConfig }>(
		target,
		"/api/pi-config",
		{},
		updatePiConfigResponseSchema
	);
	return data.config;
}

export async function fetchPiCatalog(target: ApiTarget): Promise<PiCatalog> {
	return await request<PiCatalog>(
		target,
		"/api/pi-config/catalog",
		{},
		piCatalogResponseSchema
	);
}

export async function updatePiConfig(
	target: ApiTarget,
	input: PiConfigInput
): Promise<PiConfig> {
	const data = await request<{ config: PiConfig }>(
		target,
		"/api/pi-config",
		{
			method: "PUT",
			body: input,
		},
		updatePiConfigResponseSchema
	);
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
	return await request<PiCatalog>(
		target,
		"/api/pi-config/providers",
		{
			method: "POST",
			body: input,
		},
		piCatalogResponseSchema
	);
}

/** Remove a stored credential / custom provider. Returns the refreshed catalog. */
export async function deleteProvider(
	target: ApiTarget,
	id: string
): Promise<PiCatalog> {
	return await request<PiCatalog>(
		target,
		`/api/pi-config/providers/${encodeURIComponent(id)}`,
		{ method: "DELETE" },
		piCatalogResponseSchema
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
	/** "discovery" for the live provider, "saved" for previously discovered custom models,
	 * "pi" for the installed engine, "models.dev" for the cached registry,
	 * or "fallback" for static suggestions. */
	source: string;
}

/** Ask Core to enumerate a provider's models with local and remote fallbacks. */
export async function discoverModels(
	target: ApiTarget,
	input: DiscoverModelsInput
): Promise<DiscoverModelsResult> {
	return await request<DiscoverModelsResult>(
		target,
		"/api/pi-config/discover-models",
		{ method: "POST", body: input },
		oAuthAccountPoolPolicyResponseSchema1
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
		{ method: "POST", body: input },
		oAuthAccountPoolPolicyResponseSchema2
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
		{ method: "POST", body: input },
		piCatalogResponseSchema
	);
}

// ── Subscription OAuth login (ChatGPT / Claude / Copilot) ────────────────────
//
// A subscription provider is connected by completing a real OAuth flow, not by
// storing a key. Core drives pi-ai's own flow modules and streams what they
// produce — an authorization URL, a device code, a prompt awaiting an answer —
// so the login happens in this app instead of a terminal the user never sees.

/** A question the flow is blocked on until {@link answerProviderLogin}. */
export interface PiLoginPrompt {
	message: string;
	/**
	 * Present for a `select` prompt. The answer must be the chosen option's
	 * `id` — the flow matches on the id, not on the label or an index.
	 */
	options?: { id: string; label: string }[];
	placeholder?: string;
	/** "text" | "select" | "manual_code" | … — anything but `select` is free text. */
	type: string;
}

/** One frame of a login flow. `success` and `error` are terminal. */
export interface PiLoginEvent {
	accountId?: string;
	/** `prompt`: the id to quote when answering. */
	id?: string;
	/** `auth_url`: extra guidance from the provider's flow. */
	instructions?: string;
	/** `error`: what went wrong. `progress`/`info`: a status line. */
	message?: string;
	planUseAuthorized?: boolean;
	prompt?: PiLoginPrompt;
	/** `success`: the auth.json key that now holds a credential. */
	provider?: string;
	type: string;
	/** `auth_url`: open this to authorize. */
	url?: string;
	/** `device_code`: the code to type on the verification page. */
	userCode?: string;
	/** `device_code`: open this, then enter `userCode`. */
	verificationUri?: string;
}

/**
 * Begin a subscription login. Returns the session id to stream from. Starting a
 * second login for the same provider retires the first — these flows bind fixed
 * localhost callback ports, so two at once cannot both work.
 */
export async function startProviderLogin(
	target: ApiTarget,
	providerId: string,
	options?: { accountId?: string; enablePlanUse?: boolean }
): Promise<{ sessionId: string }> {
	const query = new URLSearchParams();
	if (options?.accountId) {
		query.set("accountId", options.accountId);
	}
	if (options?.enablePlanUse) {
		query.set("enablePlanUse", "true");
	}
	const suffix = query.size > 0 ? `?${query.toString()}` : "";
	return await request<{ sessionId: string }>(
		target,
		`/api/pi-config/providers/${encodeURIComponent(providerId)}/login${suffix}`,
		{ method: "POST" },
		oAuthAccountPoolPolicyResponseSchema4
	);
}

/**
 * Stream a login's events. Events emitted before this attaches are replayed
 * first, so the opening URL or prompt is never missed.
 */
export function openProviderLoginStream(
	target: ApiTarget,
	sessionId: string,
	signal: AbortSignal
): AsyncGenerator<SseMessage<PiLoginEvent>> {
	return openSse<PiLoginEvent>(
		apiUrl(
			target,
			`/api/pi-config/login/${encodeURIComponent(sessionId)}/events`
		),
		{ token: target.token, signal, decode: piLoginEventSchema.parse }
	);
}

/** Answer the prompt the flow is waiting on. */
export async function answerProviderLogin(
	target: ApiTarget,
	sessionId: string,
	promptId: string,
	value: string
): Promise<{ accepted: boolean; error?: string }> {
	return await request<{ accepted: boolean; error?: string }>(
		target,
		`/api/pi-config/login/${encodeURIComponent(sessionId)}/answer`,
		{ method: "POST", body: { prompt_id: promptId, value } },
		oAuthAccountPoolPolicyResponseSchema5
	);
}

/**
 * Abandon a login and kill its flow. Always call this when the dialog closes:
 * a flow left running keeps its callback port bound, and the next attempt then
 * fails to bind.
 */
export async function cancelProviderLogin(
	target: ApiTarget,
	sessionId: string
): Promise<{ cancelled: boolean }> {
	return await request<{ cancelled: boolean }>(
		target,
		`/api/pi-config/login/${encodeURIComponent(sessionId)}/cancel`,
		{ method: "POST" },
		oAuthAccountPoolPolicyResponseSchema6
	);
}

const oAuthAccountPoolPolicyResponseSchema: z.ZodType<OAuthAccountPoolPolicy> =
	retainValidatedResponse(
		z
			.object({
				accounts: z.record(
					z.string(),
					z
						.object({
							enabled: z.boolean(),
							priority: z.number(),
							drainThresholdPercent: z.union([z.number(), z.null()]).optional(),
						})
						.passthrough()
				),
				drainThresholdPercent: z.number(),
				strategy: z.union([
					z.literal("manual"),
					z.literal("round_robin"),
					z.literal("quota_first"),
					z.literal("fill_first"),
					z.literal("reset_first"),
				]),
			})
			.passthrough()
	);
const piCatalogResponseSchema: z.ZodType<PiCatalog> = retainValidatedResponse(
	z
		.object({
			agentModelOverrides: z
				.record(z.string(), z.record(z.string(), z.boolean()))
				.optional(),
			apiTypes: z.array(z.string()),
			providers: z.array(
				z
					.object({
						accountRouting: z
							.union([
								z
									.object({
										credentialKinds: z.array(
											z.union([z.literal("api_key"), z.literal("oauth")])
										),
										quotaObservations: z.boolean(),
										strategies: z.array(
											z.union([
												z.literal("manual"),
												z.literal("round_robin"),
												z.literal("quota_first"),
												z.literal("fill_first"),
												z.literal("reset_first"),
											])
										),
									})
									.passthrough(),
								z.null(),
							])
							.optional(),
						accounts: z
							.array(
								z
									.object({
										accountId: z.string(),
										active: z.boolean(),
										connectionState: z
											.union([
												z.literal("authorized"),
												z.literal("identity-only"),
												z.literal("reconnect-required"),
												z.literal("unavailable"),
											])
											.optional(),
										// Absent from older Core: not installed in the Gateway.
										gatewayActive: z
											.boolean()
											.optional()
											.transform((active) => active ?? false),
										kind: z.string(),
										label: z.string(),
										needsReauth: z.boolean().optional(),
										updatedAt: z.number(),
									})
									.passthrough()
							)
							.optional(),
						active: z.boolean().optional(),
						api: z.string(),
						authEnv: z.string(),
						authKind: z.string(),
						configured: z.boolean(),
						connectionState: z
							.union([
								z.literal("authorized"),
								z.literal("identity-only"),
								z.literal("reconnect-required"),
								z.literal("unavailable"),
								z.literal("disconnected"),
								z.null(),
							])
							.optional(),
						creditPool: z.string().optional(),
						custom: z.boolean(),
						id: z.string(),
						label: z.string(),
						managed: z.boolean().optional(),
						modelOverrides: z.record(z.string(), z.boolean()).optional(),
						routing: z.string(),
						routingLocked: z.boolean().optional(),
						suggestedModels: z.array(z.string()),
						supportsDiscovery: z.boolean().optional(),
						supportsOAuth: z.boolean().optional(),
					})
					.passthrough()
			),
			sessionRevocationStatus: z
				.union([
					z.literal("confirmed"),
					z.literal("not-required"),
					z.literal("unconfirmed"),
				])
				.optional(),
			thinkingLevels: z.array(z.string()),
		})
		.passthrough()
);
const updatePiConfigResponseSchema: z.ZodType<{ config: PiConfig }> =
	retainValidatedResponse(
		z.object({ config: piConfigResponseSchema }).passthrough()
	);
const oAuthAccountPoolPolicyResponseSchema1: z.ZodType<DiscoverModelsResult> =
	retainValidatedResponse(
		z
			.object({
				models: z.array(
					z
						.object({ id: z.string(), name: z.string().optional() })
						.passthrough()
				),
				source: z.string(),
			})
			.passthrough()
	);
const oAuthAccountPoolPolicyResponseSchema2: z.ZodType<CheckProviderResult> =
	retainValidatedResponse(
		z
			.object({
				error: z.string().optional(),
				latencyMs: z.number(),
				modelCount: z.number(),
				ok: z.boolean(),
			})
			.passthrough()
	);
const oAuthAccountPoolPolicyResponseSchema4: z.ZodType<{ sessionId: string }> =
	retainValidatedResponse(z.object({ sessionId: z.string() }).passthrough());
const oAuthAccountPoolPolicyResponseSchema5: z.ZodType<{
	accepted: boolean;
	error?: string;
}> = retainValidatedResponse(
	z
		.object({ accepted: z.boolean(), error: z.string().optional() })
		.passthrough()
);
const oAuthAccountPoolPolicyResponseSchema6: z.ZodType<{ cancelled: boolean }> =
	retainValidatedResponse(z.object({ cancelled: z.boolean() }).passthrough());

function retainValidatedResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>((value) => fields.safeParse(value).success);
}
