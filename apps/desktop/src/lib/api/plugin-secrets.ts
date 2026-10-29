import { z } from "zod";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
// apps/desktop/src/lib/api/plugin-secrets.ts
//
// Typed client for a plugin's WRITE-ONLY secret store (`/api/plugins/:id/secrets`).
//
// This closes the BYOK gap: a provider plugin declares an API key it needs
// (`"secret_headers": {"Authorization": "Bearer env:RYU_EXA_API_KEY"}`) but the
// declarative settings fields persist to PREFERENCES, which are readable plain
// strings — the wrong substrate for a credential. Core keeps secrets in a
// separate store and NEVER returns a stored value; the only readable state is
// "is it set, and when was it last written". Every affordance in the desktop is
// built around that: a masked input, a Save, a Clear, and a "Set · <when>"
// label. There is no reveal, because there is nothing to reveal.
//
// Field names are snake_case to match Core's serde shapes, as in every other
// client module here. Distinct from `secrets.ts`, which is the Tauri OS-keychain
// vault for first-party LLM provider keys — this one is per-plugin and lives on
// the node.

import { type ApiTarget, request } from "./client.ts";

/** One secret slot's state. The value itself is never sent to a client. */
export interface PluginSecretState {
	/** The slot id — see {@link secretKeyForField} for what the desktop sends. */
	key: string;
	/**
	 * Whether the owning plugin is even allowed to read this name. Core gates a
	 * plugin to its own namespace (or the operator allowlist), so a stored name
	 * outside that gate can never be read back and must not read as working.
	 */
	readable?: boolean;
	/** Whether a value is currently stored. */
	set: boolean;
	/**
	 * An environment variable of the same name is exported in Core's process, and
	 * the resolver prefers it. The stored value is real but inert — surfacing this
	 * is what stops a user debugging a "wrong key" that is not the key in use.
	 */
	shadowed_by_env?: boolean;
	/** Unix millis of the last write, when the store recorded one. */
	updated_at?: number;
}

/**
 * The `:key` path segment a settings field maps to.
 *
 * SINGLE SOURCE OF TRUTH for the desktop's half of the key scheme, deliberately
 * one function.
 *
 * The contract is settled: a `secret` field's `pref_key` IS the env var name the
 * plugin's `secret_headers` already interpolates (`RYU_EXA_API_KEY`), and Core
 * keys the store by that same name — which is exactly what lets an `env:` token
 * fall back to the store with no second grammar. Core enforces it at manifest
 * import (a `secret` field whose `pref_key` is not env-var-shaped is rejected),
 * so this function is an identity by design rather than by coincidence.
 */
export function secretKeyForField(prefKey: string): string {
	return prefKey;
}

/**
 * Any unix timestamp in millis has been above this since 2001; any timestamp in
 * seconds stays below it until the year 33 658. So it cleanly separates the two.
 */
const MILLIS_FLOOR = 1e12;

/**
 * Normalize a slot's `updated_at` to unix MILLIS.
 *
 * Core writes millis today (`plugin_secrets::now_millis`), so the seconds branch
 * is defensive rather than reachable. It is kept because the cost is one
 * comparison and the failure it guards against is silent and ugly: a store that
 * ever reached for Rust's `DateTime::timestamp()` (which yields SECONDS) would
 * render "Set · 56 years ago" the instant the optimistic label was replaced by a
 * refetch, with nothing else to hint at the cause.
 */
export function secretUpdatedAtMillis(updatedAt: number): number {
	return updatedAt < MILLIS_FLOOR ? updatedAt * 1000 : updatedAt;
}

/** List every secret slot's state for a plugin. Never includes values. */
export async function listPluginSecrets(
	target: ApiTarget,
	pluginId: string
): Promise<PluginSecretState[]> {
	const resp = await request(
		target,
		`/api/plugins/${encodeURIComponent(pluginId)}/secrets`,
		undefined,
		pluginSecretsResponseSchema
	);
	return resp?.secrets ?? [];
}

/**
 * Read one slot's state, or `null` when the plugin has no such slot.
 *
 * Resolves rather than throws when the node cannot answer (an older Core with no
 * such route, an offline node): an unreadable store is indistinguishable from an
 * unset one from the UI's point of view, and a settings panel must still render.
 */
export async function getPluginSecretState(
	target: ApiTarget,
	pluginId: string,
	key: string
): Promise<PluginSecretState | null> {
	try {
		const secrets = await listPluginSecrets(target, pluginId);
		return secrets.find((entry) => entry.key === key) ?? null;
	} catch {
		return null;
	}
}

/**
 * Why a write failed, when the reason is actionable by the user.
 *
 * Collapsing every failure into `false` renders Core's two REAL problems — the
 * at-rest encryption key could not be loaded (503), and this key name is not one
 * the plugin may use (400) — as "check your connection and try again", which sends
 * the user to fix the wrong thing. Neither is transient and neither is retryable.
 */
export function describeSecretFailure<TError>(
	error: TError,
	fallback: string
): string {
	const message =
		error instanceof Error && error.message.trim().length > 0
			? error.message.trim()
			: "";
	if (!message) {
		return fallback;
	}
	if (/encryption key/i.test(message)) {
		return "This node cannot store secrets: its at-rest encryption key could not be loaded.";
	}
	if (/env var|environment variable|invalid|not a valid/i.test(message)) {
		return message;
	}
	return fallback;
}

/**
 * Store (or overwrite) a secret.
 *
 * Throws on failure rather than returning a boolean, so the caller can tell an
 * actionable refusal from a transient one via {@link describeSecretFailure}. The
 * previous boolean shape made that impossible by construction.
 */
export async function setPluginSecret(
	target: ApiTarget,
	pluginId: string,
	key: string,
	value: string
): Promise<void> {
	await request(
		target,
		`/api/plugins/${encodeURIComponent(pluginId)}/secrets/${encodeURIComponent(key)}`,
		{ method: "PUT", body: { value } },
		gatewayJsonValueSchema
	);
}

/** Delete a stored secret. Throws on failure, like {@link setPluginSecret}. */
export async function clearPluginSecret(
	target: ApiTarget,
	pluginId: string,
	key: string
): Promise<void> {
	await request(
		target,
		`/api/plugins/${encodeURIComponent(pluginId)}/secrets/${encodeURIComponent(key)}`,
		{ method: "DELETE" },
		gatewayJsonValueSchema
	);
}

const pluginSecretStateResponseSchema = z
	.object({
		key: z.string(),
		readable: z.boolean().optional(),
		set: z.boolean(),
		shadowed_by_env: z.boolean().optional(),
		updated_at: z.number().optional(),
	})
	.passthrough();

const pluginSecretsResponseSchema = z
	.object({ secrets: z.array(pluginSecretStateResponseSchema).optional() })
	.passthrough();
