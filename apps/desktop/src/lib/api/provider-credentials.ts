// apps/desktop/src/lib/api/provider-credentials.ts
//
// Typed client for a provider's credential list
// (`/api/pi-config/providers/{id}/credentials`) and for the notice that a paid
// API key is in use (`/api/conversations/{id}/paid-key-notice`).
//
// The list carries labels, kinds and the last characters of each API key. It
// never carries a credential.

import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

const credentialSchema = z.looseObject({
	accountId: z.string(),
	label: z.string(),
	kind: z.string(),
	enabled: z.boolean().catch(true),
	needsReauth: z.boolean().catch(false),
	hint: z.string().nullish(),
	resting: z.enum(["limited", "rejected"]).nullish().catch(null),
});

const credentialsSchema = z.looseObject({
	providerId: z.string(),
	credentials: z.array(credentialSchema).catch(() => []),
	apiKeyFallback: z
		.looseObject({
			supported: z.boolean().catch(false),
			enabled: z.boolean().catch(false),
			keyProviderId: z.string().nullish(),
			keys: z.array(credentialSchema).catch(() => []),
		})
		.catch(() => ({
			supported: false,
			enabled: false,
			keyProviderId: null,
			keys: [],
		})),
});

const paidKeyNoticeSchema = z.looseObject({
	notice: z
		.looseObject({
			providerId: z.string(),
			keyProviderId: z.string(),
			accountId: z.string(),
			label: z.string(),
		})
		.nullish(),
});

/** One row of a provider's credential list. */
export interface ProviderCredential {
	accountId: string;
	/** Whether the account routing lets new work use it. */
	enabled: boolean;
	/** Last characters of an API key, or null for a sign-in or a short key. */
	hint: string | null;
	/** "api_key" | "oauth" | "opaque". */
	kind: string;
	label: string;
	needsReauth: boolean;
	/** Why a fallback key is not tried right now, or null when it is ready. */
	resting: "limited" | "rejected" | null;
}

/** The setting that lets an API key take over from subscription accounts. */
export interface ApiKeyFallback {
	enabled: boolean;
	/** The provider whose API keys would take over, when supported. */
	keyProviderId: string | null;
	/** Those keys, first to try first. */
	keys: ProviderCredential[];
	/** False for providers Core cannot switch to an API key. */
	supported: boolean;
}

export interface ProviderCredentials {
	apiKeyFallback: ApiKeyFallback;
	credentials: ProviderCredential[];
	providerId: string;
}

/** Shown once per conversation when a paid API key starts serving it. */
export interface PaidKeyNotice {
	accountId: string;
	keyProviderId: string;
	/** The saved label of the key. Never the key. */
	label: string;
	providerId: string;
}

function toCredential(
	row: z.output<typeof credentialSchema>
): ProviderCredential {
	return {
		accountId: row.accountId,
		enabled: row.enabled,
		hint: row.hint ?? null,
		kind: row.kind,
		label: row.label,
		needsReauth: row.needsReauth,
		resting: row.resting ?? null,
	};
}

function toCredentials(
	parsed: z.output<typeof credentialsSchema>
): ProviderCredentials {
	return {
		providerId: parsed.providerId,
		credentials: parsed.credentials.map(toCredential),
		apiKeyFallback: {
			supported: parsed.apiKeyFallback.supported,
			enabled: parsed.apiKeyFallback.enabled,
			keyProviderId: parsed.apiKeyFallback.keyProviderId ?? null,
			keys: parsed.apiKeyFallback.keys.map(toCredential),
		},
	};
}

function credentialsPath(providerId: string): string {
	return `/api/pi-config/providers/${encodeURIComponent(providerId)}/credentials`;
}

export const providerCredentialKeys = {
	list: (target: ApiTarget, providerId: string) =>
		[
			"provider-credentials",
			target.url,
			target.token,
			target.userJwt ?? null,
			providerId,
		] as const,
};

/** A provider's credentials in priority order, and its fallback setting. */
export async function fetchProviderCredentials(
	target: ApiTarget,
	providerId: string,
	signal?: AbortSignal
): Promise<ProviderCredentials> {
	const parsed = await request(
		target,
		credentialsPath(providerId),
		{ signal },
		credentialsSchema
	);
	return toCredentials(parsed);
}

/** Turn "use API keys when subscription accounts run out" on or off. */
export async function setApiKeyFallback(
	target: ApiTarget,
	providerId: string,
	enabled: boolean
): Promise<ProviderCredentials> {
	const parsed = await request(
		target,
		credentialsPath(providerId),
		{ method: "PUT", body: { apiKeyFallback: enabled } },
		credentialsSchema
	);
	return toCredentials(parsed);
}

/**
 * Collect the notice that a paid API key now serves `conversationId`. Core
 * hands it out once, so the second call for the same conversation is null.
 */
export async function claimPaidKeyNotice(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<PaidKeyNotice | null> {
	const parsed = await request(
		target,
		`/api/conversations/${encodeURIComponent(conversationId)}/paid-key-notice`,
		{ method: "POST", signal },
		paidKeyNoticeSchema
	);
	const notice = parsed.notice;
	if (!notice) {
		return null;
	}
	return {
		accountId: notice.accountId,
		keyProviderId: notice.keyProviderId,
		label: notice.label,
		providerId: notice.providerId,
	};
}
