import { acpConfigResponseSchema } from "@ryuhq/core-client/acp.ts";
import { z } from "zod";
// apps/desktop/src/lib/api/acp.ts
//
// Typed client for Core's ACP session-config endpoints. These expose, per
// active agent, exactly what the ACP agent advertises at `session/new`:
//   - permission **modes** (default / acceptEdits / plan / bypassPermissions /
//     read-only, …) — agent-reported strings, NOT hardcoded by Ryu;
//   - **config options** (e.g. a reasoning-effort / `thoughtLevel` selector);
//   - **models** (unstable ACP capability; null when unsupported).
//
// This is the same data-driven contract Zed uses: the desktop renders a picker
// only for what the agent reports, and applies a choice by sending it on the
// next chat turn (Core re-applies it to that turn's session). The interactive
// permission prompt (when an agent in a gating mode asks to run a tool) is
// resolved via `respondPermission`.

import type {
	AcpConfig,
	AcpConfigOption,
	AcpConfigSelectOption,
} from "@ryuhq/core-client/acp.ts";
import { type ApiTarget, request } from "./client.ts";

export type {
	AcpAgentCapabilities,
	AcpAgentSettingsSupport,
	AcpAuthMethod,
	AcpConfig,
	AcpConfigOption,
	AcpConfigSelectOption,
	AcpModelInfo,
	AcpPermissionOption,
	AcpSessionMode,
	AcpSessionModelState,
	AcpSessionModeState,
} from "@ryuhq/core-client/acp.ts";

/**
 * A session config option. The common case (and the only `kind` Ryu surfaces a
 * picker for) is `type: "select"` — a dropdown with `currentValue` + `options`.
 * `category` is a UX hint: `"mode"` | `"model"` | `"thoughtLevel"` (reasoning
 * effort) | any agent-defined string.
 */

/** One agent-persisted session (external agents that track sessions). */
export interface AcpSession {
	cwd: string;
	sessionId: string;
	title?: string | null;
	updatedAt?: string | null;
}

/**
 * The agent's tracked session list. `unsupported` is true for agents that don't
 * persist sessions (the flagship Pi returns `unsupported`/empty — expected).
 */
export interface AcpSessionList {
	nextCursor?: string | null;
	sessions: AcpSession[];
	unsupported?: boolean;
}

/**
 * Config-option picks to apply to the probe session before reading what the
 * agent advertises, as Core's `?selections=` query param (empty string for none).
 *
 * An agent's option SET can depend on the values already selected — ACP's
 * `session/set_config_option` answers with the whole refreshed list precisely so
 * a client can see that. opencode advertises its reasoning-`effort` option only
 * while the session's model has effort levels, so probing with no model pick
 * reports an option set that is real but incomplete. Passing the picks is what
 * makes the composer show the controls that exist FOR THE CHOSEN MODEL.
 *
 * Keys are sorted so the same picks always produce the same URL — Core's probe
 * cache is keyed by this, and an unstable order would fragment it.
 */
export function acpSelectionsParam(
	selections?: Record<string, string> | null
): string {
	const entries = Object.entries(selections ?? {})
		.filter(([id, value]) => id.length > 0 && value.length > 0)
		.sort(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) {
		return "";
	}
	const encoded = encodeURIComponent(
		JSON.stringify(Object.fromEntries(entries))
	);
	return `?selections=${encoded}`;
}

/**
 * Fetch the agent's advertised ACP session config. Returns all-null for non-ACP
 * agents (they have no `session/new` advertisement). Core caches per agent (and
 * per `selections`), so this is cheap to call on agent selection.
 */
const acpAuthResultResponseCodec: z.ZodType<AcpAuthResult> = z
	.object({
		agentAccepted: z.boolean().optional(),
		authenticated: z.boolean(),
		changed: z.boolean().optional(),
		code: z.string().optional(),
		error: z.string().optional(),
		nativeAccounts: z.boolean().optional(),
		verificationRequired: z.boolean().optional(),
		verified: z.boolean().optional(),
	})
	.passthrough();
const acpSessionResponseCodec: z.ZodType<AcpSession> = z
	.object({
		cwd: z.string(),
		sessionId: z.string(),
		title: z.union([z.string(), z.null()]).optional(),
		updatedAt: z.union([z.string(), z.null()]).optional(),
	})
	.passthrough();
const acpSessionListResponseCodec: z.ZodType<AcpSessionList> = z
	.object({
		nextCursor: z.union([z.string(), z.null()]).optional(),
		sessions: z.array(acpSessionResponseCodec),
		unsupported: z.boolean().optional(),
	})
	.passthrough();
export async function fetchAcpConfig(
	target: ApiTarget,
	agentId: string,
	selections?: Record<string, string> | null
): Promise<AcpConfig> {
	return await request<AcpConfig>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/acp-config${acpSelectionsParam(selections)}`,
		{},
		acpConfigResponseSchema
	);
}

/**
 * Resolve an interactive tool-permission prompt raised mid-turn. Pass the
 * `requestId` from the `data-ryu-permission` stream part and the chosen
 * `optionId` (or `null` to reject/cancel). Unblocks the awaiting agent turn.
 */
export async function respondPermission(
	target: ApiTarget,
	requestId: string,
	optionId: string | null
): Promise<{ resolved: boolean }> {
	return await request<{ resolved: boolean }>(
		target,
		"/api/chat/permission",
		{
			method: "POST",
			body: { request_id: requestId, option_id: optionId },
		},
		z.object({ resolved: z.boolean() }).passthrough()
	);
}

/**
 * Answer a blocking Question card. `resolved: false` means no turn is waiting
 * on it any more (it was async, timed out, or the user went away), and the
 * caller should deliver the answer as a normal user message instead.
 */
export async function respondQuestion(
	target: ApiTarget,
	conversationId: string,
	toolCallId: string,
	answers: unknown[]
): Promise<{ resolved: boolean }> {
	return await request<{ resolved: boolean }>(
		target,
		"/api/chat/question",
		{
			method: "POST",
			body: {
				conversation_id: conversationId,
				tool_call_id: toolCallId,
				answers,
			},
		},
		z.object({ resolved: z.boolean() }).passthrough()
	);
}

/** Outcome of {@link authenticateAgent}, as OBSERVED by Core. */
export interface AcpAuthResult {
	/** The ACP `authenticate` request itself returned without error. */
	agentAccepted?: boolean;
	/** A credential is actually present now. The only field worth celebrating. */
	authenticated: boolean;
	/** True when THIS call is what connected it (vs already being connected). */
	changed?: boolean;
	/**
	 * Machine-readable outcome: `auth_verification_required` (accepted, but Core
	 * cannot check the credential) or `native_account_login_required`.
	 */
	code?: string;
	error?: string;
	/** The agent signs in through isolated native accounts instead. */
	nativeAccounts?: boolean;
	/**
	 * The agent accepted the request, but Core had no credential store to check,
	 * so the login has to be finished (and confirmed) outside the app.
	 */
	verificationRequired?: boolean;
	/**
	 * Whether Core had ground truth to check. `false` means `authenticated` is
	 * just the RPC result — an agent can accept the request having done nothing,
	 * so callers must NOT word an unverified result as "signed in".
	 */
	verified?: boolean;
}

/**
 * Whether the agent accepted a login that Core could not verify. That is not a
 * failure: the vendor login may be running in a browser or terminal. It is not
 * a sign-in either, so callers word it as "finish it there".
 */
export function acpAuthAwaitsVerification(result: AcpAuthResult): boolean {
	return (
		!result.authenticated &&
		result.agentAccepted === true &&
		(result.verificationRequired === true ||
			result.code === "auth_verification_required")
	);
}

/**
 * Run an agent-advertised authentication method (e.g. "Login with ChatGPT").
 * Core drives the ACP `authenticate` call and — when `providerId` names a
 * subscription provider — verifies the outcome against Pi's stored credentials
 * rather than trusting the RPC. Always pass `providerId` where one exists;
 * without it the result is unverified and cannot be reported as a login.
 */
export async function authenticateAgent(
	target: ApiTarget,
	agentId: string,
	methodId: string,
	providerId?: string
): Promise<AcpAuthResult> {
	return await request<AcpAuthResult>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/authenticate`,
		{ method: "POST", body: { method_id: methodId, provider_id: providerId } },
		acpAuthResultResponseCodec
	);
}

/**
 * End an ACP agent's authenticated session (ACP `logout`) — the inverse of
 * {@link authenticateAgent}. Only meaningful for agents that advertise the
 * logout capability; returns `{ loggedOut }` plus an optional `error`.
 */
export async function logoutAgent(
	target: ApiTarget,
	agentId: string
): Promise<{ loggedOut: boolean; error?: string }> {
	return await request<{ loggedOut: boolean; error?: string }>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/logout`,
		{ method: "POST" },
		z
			.object({ loggedOut: z.boolean(), error: z.string().optional() })
			.passthrough()
	);
}

/** List the sessions an ACP agent persists (empty/`unsupported` for most). */
export async function fetchAcpSessions(
	target: ApiTarget,
	agentId: string
): Promise<AcpSessionList> {
	return await request<AcpSessionList>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/sessions`,
		{},
		acpSessionListResponseCodec
	);
}

/** Delete one agent-tracked session by id. Returns `{ deleted }` + optional error. */
export async function deleteAcpSession(
	target: ApiTarget,
	agentId: string,
	sessionId: string
): Promise<{ deleted: boolean; error?: string }> {
	return await request<{ deleted: boolean; error?: string }>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
		{ method: "DELETE" },
		z
			.object({ deleted: z.boolean(), error: z.string().optional() })
			.passthrough()
	);
}

/** Flatten a select option's `options` (ungrouped or grouped) to a flat list. */
export function flattenConfigOptions(
	option: AcpConfigOption
): AcpConfigSelectOption[] {
	const raw = option.options ?? [];
	if (raw.length === 0) {
		return [];
	}
	// Grouped form: `[{ options: [...] }, ...]`.
	if ("options" in raw[0]) {
		// SAFETY: The actual ACP 0.12 SessionConfigSelectOptions owner publishes
		// homogeneous Grouped or Ungrouped arrays. This existing first-entry
		// branch selects Grouped; TypeScript cannot refine the whole array from
		// that entry. Keep native references and every original read unchanged.
		return (raw as { options: AcpConfigSelectOption[] }[]).flatMap(
			(g) => g.options
		);
	}
	// SAFETY: The same actual homogeneous ACP array owner is nonempty here;
	// the existing first-entry branch excludes Grouped. This cast returns the
	// original Ungrouped array without reconstructing any native SDK fields.
	return raw as AcpConfigSelectOption[];
}
