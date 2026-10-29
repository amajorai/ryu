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

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

// Entire PiConfigView and catalog publishers (pi_config/mod.rs), including
// complete redacted native account views and account-pool capabilities.
function piResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
function piRecord<S extends z.ZodType>(valueFields: S) {
	const fields = z.record(z.string(), valueFields);
	return z.custom<z.output<typeof fields>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success &&
			Object.entries(Object.call(undefined, value)).every(
				([, entry]) => valueFields.safeParse(entry).success
			)
	);
}
const piNumber = z.union([
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const piRoutingMap = piRecord(z.string());
const piModelOverrideMap = piRecord(z.boolean());
const piAgentModelOverrides = piRecord(piModelOverrideMap);
export const piConfigResponseSchema = piResponse(
	z.object({
		provider: z.string(),
		model: z.string().nullable(),
		thinkingLevel: z.string().nullable(),
		routing: z.string(),
		configDir: z.string(),
		providerRouting: piRoutingMap.optional(),
	})
);
const piConfigEnvelopeSchema = piResponse(
	z.object({ config: piConfigResponseSchema })
);
const piAccountSchema = piResponse(
	z.object({
		accountId: z.string(),
		label: z.string(),
		kind: z.string(),
		active: z.boolean(),
		gatewayActive: z.boolean(),
		updatedAt: piNumber,
		needsReauth: z.boolean().optional(),
		connectionState: z.string().optional(),
	})
);
const piAccountRoutingSchema = piResponse(
	z.object({
		strategies: z.array(
			z.enum([
				"manual",
				"round_robin",
				"quota_first",
				"fill_first",
				"reset_first",
			])
		),
		credentialKinds: z.array(z.string()),
		quotaObservations: z.boolean(),
	})
);
export const piProviderResponseSchema = piResponse(
	z.object({
		id: z.string(),
		label: z.string(),
		api: z.string(),
		authKind: z.string(),
		authEnv: z.string(),
		routing: z.string(),
		configured: z.boolean(),
		custom: z.boolean(),
		suggestedModels: z.array(z.string()),
		supportsOAuth: z.boolean().optional(),
		routingLocked: z.boolean().optional(),
		managed: z.boolean().optional(),
		creditPool: z.string().optional(),
		active: z.boolean().optional(),
		credentialLabel: z.string().nullable().optional(),
		transport: z.string().nullable().optional(),
		cliAvailable: z.boolean().nullable().optional(),
		inputModalities: z.array(z.string()).nullable().optional(),
		supportsDiscovery: z.boolean().optional(),
		modelOverrides: piModelOverrideMap.optional(),
		accounts: z.array(piAccountSchema).optional(),
		accountRouting: piAccountRoutingSchema.nullable().optional(),
		connectionState: z.string().nullable().optional(),
	})
);
export const piCatalogResponseSchema = piResponse(
	z.object({
		providers: z.array(piProviderResponseSchema),
		agentModelOverrides: piAgentModelOverrides.optional(),
		thinkingLevels: z.array(z.string()),
		apiTypes: z.array(z.string()),
	})
);

/** The current Pi configuration. Never contains secrets. */
export type PiConfig = z.output<typeof piConfigResponseSchema>;

/** A provider Pi supports, as surfaced by the catalog endpoint. */
export type PiProvider = z.output<typeof piProviderResponseSchema>;

export type PiCatalog = z.output<typeof piCatalogResponseSchema>;

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
	const data = await request(
		target,
		"/api/pi-config",
		{},
		piConfigEnvelopeSchema
	);
	return data.config;
}

export async function fetchPiCatalog(target: ApiTarget): Promise<PiCatalog> {
	return await request(
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
	const data = await request(
		target,
		"/api/pi-config",
		{
			method: "PUT",
			body: input,
		},
		piConfigEnvelopeSchema
	);
	return data.config;
}
