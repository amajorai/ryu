// apps/desktop/src/lib/api/security-key.ts
//
// Typed client for the security-key relay. A browser on a remote node, VM or
// hidden Bot lane asks its Core to use the hardware security key plugged into
// this desktop. Core holds the request; the desktop lists it
// (`GET /api/security-key/requests`), asks the user, runs the ceremony against
// the key through native Tauri commands, and answers
// (`POST /api/security-key/requests/:id/response`). The wire shapes mirror the
// `ryu-webauthn-relay` crate: snake_case JSON, binary as unpadded base64url.

import { z } from "zod";
import { invokeWhenReady } from "@/src/lib/tauri-ready.ts";
import { type ApiTarget, request } from "./client.ts";

export const securityKeyCeremonySchema = z.enum(["get", "create"]);
export type SecurityKeyCeremony = z.infer<typeof securityKeyCeremonySchema>;

/** A relay request waiting for the user (Rust `PendingRelayRequest`). */
export const pendingSecurityKeyRequestSchema = z.object({
	agent_id: z.string().nullish(),
	client_data_json: z.string(),
	created_at_ms: z.number(),
	expires_at_ms: z.number(),
	id: z.string().min(1),
	kind: securityKeyCeremonySchema,
	options: z.unknown(),
	origin: z.string(),
	page_url: z.string(),
	rp_id: z.string(),
});
export type PendingSecurityKeyRequest = z.infer<
	typeof pendingSecurityKeyRequestSchema
>;

const requestListSchema = z.object({
	requests: z.array(z.unknown()).catch(() => []),
});

const credentialResponseSchema = z.discriminatedUnion("kind", [
	z.object({
		authenticator_data: z.string(),
		kind: z.literal("assertion"),
		signature: z.string(),
		user_handle: z.string().nullish(),
	}),
	z.object({
		attestation_object: z.string(),
		kind: z.literal("attestation"),
		transports: z.array(z.string()).catch(() => []),
	}),
]);

/** The key's answer (Rust `RelayCredential`). */
export const securityKeyCredentialSchema = z.object({
	id: z.string().min(1),
	response: credentialResponseSchema,
});
export type SecurityKeyCredential = z.infer<typeof securityKeyCredentialSchema>;

/** The user's answer (Rust `RelayDecision`). */
export type SecurityKeyDecision =
	| { credential: SecurityKeyCredential; decision: "approve" }
	| { decision: "deny"; reason?: string };

const answerResultSchema = z
	.object({ ok: z.boolean().optional() })
	.passthrough();

const availabilitySchema = z.object({
	available: z.boolean(),
	platform: z.string().catch("unknown"),
	reason: z.string().nullish(),
});
export type SecurityKeyAvailability = z.infer<typeof availabilitySchema>;

/**
 * The requests Core holds for this user, oldest first. Malformed entries are
 * skipped instead of failing the whole list, so one bad row never hides the
 * others.
 */
export async function listSecurityKeyRequests(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<PendingSecurityKeyRequest[]> {
	const body = await request(
		target,
		"/api/security-key/requests",
		{ signal },
		requestListSchema
	);
	const requests: PendingSecurityKeyRequest[] = [];
	for (const entry of body.requests) {
		const parsed = pendingSecurityKeyRequestSchema.safeParse(entry);
		if (parsed.success) {
			requests.push(parsed.data);
		}
	}
	return requests.sort(
		(left, right) => left.created_at_ms - right.created_at_ms
	);
}

/** Longest a relayed request may wait (Rust `MAX_TIMEOUT_MS`). */
export const SECURITY_KEY_MAX_WAIT_MS = 120_000;

/**
 * Move a request's deadline onto this device's clock.
 *
 * Core stamps `created_at_ms` and `expires_at_ms` with the clock of the node
 * that runs the browser, usually another machine (a VM or cloud node) whose
 * clock can be minutes off. Comparing those against `Date.now()` would hide
 * the request, or fail it as expired, whenever the clocks disagree. Only the
 * window between the two stamps is meaningful here, so the deadline becomes
 * `receivedAtMs` plus that window (capped at the relay maximum). Core's own
 * deadline check stays the authority: it stops listing an expired request and
 * refuses a late answer.
 */
export function withLocalDeadline(
	pending: PendingSecurityKeyRequest,
	receivedAtMs: number
): PendingSecurityKeyRequest {
	const window = Math.min(
		Math.max(pending.expires_at_ms - pending.created_at_ms, 0),
		SECURITY_KEY_MAX_WAIT_MS
	);
	return { ...pending, expires_at_ms: receivedAtMs + window };
}

/** Send the user's decision for one request. */
export async function answerSecurityKeyRequest(
	target: ApiTarget,
	id: string,
	decision: SecurityKeyDecision
): Promise<void> {
	await request(
		target,
		`/api/security-key/requests/${encodeURIComponent(id)}/response`,
		{ body: decision, method: "POST" },
		answerResultSchema
	);
}

/** Whether this desktop can reach a roaming security key at all. */
export async function securityKeyAvailability(): Promise<SecurityKeyAvailability> {
	try {
		const raw = await invokeWhenReady<unknown>("security_key_available");
		return availabilitySchema.parse(raw);
	} catch (error) {
		return {
			available: false,
			platform: "unknown",
			reason: errorText(error),
		};
	}
}

/**
 * Run the ceremony against the plugged-in key. Resolves once the key is
 * touched; rejects with the native error string (`pin_required…`,
 * `timeout: …`, …) otherwise. Pass `pin` to answer a `pin_required` error.
 * `pending.expires_at_ms` must be on this device's clock (see
 * {@link withLocalDeadline}); the native side compares it with its own clock.
 */
export async function performSecurityKeyRequest(
	pending: PendingSecurityKeyRequest,
	pin?: string
): Promise<SecurityKeyCredential> {
	const raw =
		pin === undefined
			? await invokeWhenReady<unknown>("security_key_perform", {
					request: pending,
				})
			: await invokeWhenReady<unknown>("security_key_perform_with_pin", {
					pin,
					request: pending,
				});
	return securityKeyCredentialSchema.parse(raw);
}

/** The text of a native or transport failure, whatever shape it arrived in. */
export function errorText(error: unknown): string {
	if (typeof error === "string") {
		return error;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/** The leading snake_case code of a native key error (`pin_required`, …). */
export function securityKeyErrorCode(error: unknown): string {
	const text = errorText(error).trim();
	const match = /^([a-z_]+)(?::|$)/u.exec(text);
	return match?.[1] ?? "device";
}

/** Whether the key is asking for its PIN (first time or after a wrong one). */
export function isPinRequired(error: unknown): boolean {
	return securityKeyErrorCode(error) === "pin_required";
}

/** The detail after the code (`wrong PIN (2 attempts left)`), if any. */
export function securityKeyErrorDetail(error: unknown): string | null {
	const text = errorText(error).trim();
	const separator = text.indexOf(":");
	if (separator < 0) {
		return null;
	}
	const detail = text.slice(separator + 1).trim();
	return detail.length > 0 ? detail : null;
}

/**
 * Errors the user can fix and retry (plug the key in, touch it in time).
 * Anything else ends the request: the page is told no.
 */
const RETRYABLE_CODES = new Set([
	"cancelled",
	"device",
	"timeout",
	"unavailable",
]);

export function isRetryableSecurityKeyError(error: unknown): boolean {
	return RETRYABLE_CODES.has(securityKeyErrorCode(error));
}
