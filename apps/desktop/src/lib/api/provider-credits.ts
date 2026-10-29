import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
// apps/desktop/src/lib/api/provider-credits.ts
//
// Remaining prepaid API credit on a BYOK provider key ("how many dollars are
// left on the OpenRouter key I pasted"). Sibling to `api/usage.ts`: that one
// meters a subscription agent's rolling windows, this one reads a provider's
// balance. Both come back as the same `UsageMeter` rows, so the same components
// render them.
//
// Core owns the provider logic AND the credential lookup — the key never leaves
// the node — so this is a thin typed reader. Always 200: refusals carry
// `available: false` + a `reason`.

import type { ApiTarget } from "@/src/lib/api/client.ts";
import { request } from "@/src/lib/api/client.ts";
import type { UsageMeter, UsageReason } from "@/src/lib/api/usage.ts";

/** A provider's prepaid API credit balance. */
export interface ProviderCreditsSnapshot {
	available: boolean;
	meters: UsageMeter[];
	providerId: string;
	reason: UsageReason | null;
	retryAfterSeconds: number | null;
}

interface WireValue {
	kind: "percent" | "dollars" | "count";
	number: number;
	unit?: string | null;
}

interface WireMeter {
	expires_at?: string[] | null;
	label: string;
	resets_at?: string | null;
	values: WireValue[];
}

interface WireSnapshot {
	available: boolean;
	meters?: WireMeter[] | null;
	provider_id: string;
	reason?: UsageReason | null;
	retry_after_seconds?: number | null;
}

/**
 * The providers that expose a balance to the inference key you already hold —
 * mirrors Core's `supports_provider_credits`.
 *
 * Deliberately short, and the reason matters: OpenAI has no endpoint for an
 * `sk-` key (its credit-grants route wants a browser session), Anthropic's cost
 * reports need a separate Admin key, and Groq/Mistral are only readable from a
 * signed-in browser session. Polling those would spend a request per picker open
 * to be told "unsupported", so this list is what gates the query — the picker
 * lists ~16 providers and a badge per row must not mean a request per row.
 */
const CREDIT_PROVIDERS = new Set(["openrouter", "deepseek", "moonshot"]);

export function supportsProviderCredits(
	providerId: string | null | undefined
): boolean {
	return providerId ? CREDIT_PROVIDERS.has(providerId.toLowerCase()) : false;
}

function toSnapshot(wire: WireSnapshot): ProviderCreditsSnapshot {
	return {
		providerId: wire.provider_id,
		available: wire.available,
		reason: wire.reason ?? null,
		meters: (wire.meters ?? []).map((m) => ({
			label: m.label,
			values: m.values.map((v) => ({
				number: v.number,
				kind: v.kind,
				unit: v.unit ?? null,
			})),
			expiresAt: m.expires_at ?? [],
			resetsAt: m.resets_at ?? null,
		})),
		retryAfterSeconds: wire.retry_after_seconds ?? null,
	};
}

/** Fetch one provider's remaining API credit. */
export async function fetchProviderCredits(
	target: ApiTarget,
	providerId: string,
	signal?: AbortSignal
): Promise<ProviderCreditsSnapshot> {
	const wire = await request<WireSnapshot>(
		target,
		`/api/providers/${encodeURIComponent(providerId)}/credits`,
		{ signal },
		wireSnapshotResponseCodec
	);
	return toSnapshot(wire);
}

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
const wireValueResponseCodec = z
	.object({
		kind: z.union([
			z.literal("percent"),
			z.literal("dollars"),
			z.literal("count"),
		]),
		number: z.number(),
		unit: z.union([z.string(), z.null()]).optional(),
	})
	.catchall(gatewayJsonValueSchema);
const wireMeterResponseCodec = z
	.object({
		expires_at: z.union([z.array(z.string()), z.null()]).optional(),
		label: z.string(),
		resets_at: z.union([z.string(), z.null()]).optional(),
		values: z.array(wireValueResponseCodec),
	})
	.catchall(gatewayJsonValueSchema);
const usageReasonResponseCodec = z.union([
	z.literal("unsupported"),
	z.literal("not_logged_in"),
	z.literal("token_expired"),
	z.literal("missing_scope"),
	z.literal("no_plan"),
	z.literal("rate_limited"),
	z.literal("error"),
]);
const wireSnapshotResponseCodec = z
	.object({
		available: z.boolean(),
		meters: z.union([z.array(wireMeterResponseCodec), z.null()]).optional(),
		provider_id: z.string(),
		reason: z.union([usageReasonResponseCodec, z.null()]).optional(),
		retry_after_seconds: z.union([z.number(), z.null()]).optional(),
	})
	.catchall(gatewayJsonValueSchema);
