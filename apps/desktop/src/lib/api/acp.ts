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

import { type ApiTarget, request } from "./client.ts";

/** A single permission/session mode the agent supports. */
export interface AcpSessionMode {
	description?: string | null;
	id: string;
	name: string;
}

/** The agent's mode set + currently active mode (from `session/new`). */
export interface AcpSessionModeState {
	availableModes: AcpSessionMode[];
	currentModeId: string;
}

/** A selectable model the agent advertises (unstable ACP capability). */
export interface AcpModelInfo {
	description?: string | null;
	modelId: string;
	name: string;
}

export interface AcpSessionModelState {
	availableModels: AcpModelInfo[];
	currentModelId: string;
}

/** One selectable value for a `select` config option. */
export interface AcpConfigSelectOption {
	description?: string | null;
	name: string;
	value: string;
}

/**
 * A session config option. The common case (and the only `kind` Ryu surfaces a
 * picker for) is `type: "select"` — a dropdown with `currentValue` + `options`.
 * `category` is a UX hint: `"mode"` | `"model"` | `"thoughtLevel"` (reasoning
 * effort) | any agent-defined string.
 */
export interface AcpConfigOption {
	category?: string | null;
	currentValue?: string;
	description?: string | null;
	id: string;
	name: string;
	/** Flat list for ungrouped selects; grouped selects expose `{ options }`. */
	options?: AcpConfigSelectOption[] | { options: AcpConfigSelectOption[] }[];
	type?: string;
}

/**
 * An authentication method the ACP agent advertises at `session/new` — the
 * "Login with ChatGPT / Claude subscription"-style external sign-in an agent
 * needs before it can serve turns. Empty for agents that need no login.
 */
export interface AcpAuthMethod {
	description?: string | null;
	id: string;
	name: string;
	/** Agent-defined method type (e.g. "oauth"); a UX hint, not switched on. */
	type: string;
}

/** The agent's own advertised capabilities (ACP `agentCapabilities`). */
export interface AcpAgentCapabilities {
	/** Agent can warm-resume a prior session via `session/load`. */
	loadSession?: boolean;
	mcpCapabilities?: { http?: boolean; sse?: boolean };
	promptCapabilities?: {
		audio?: boolean;
		embeddedContext?: boolean;
		image?: boolean;
	};
}

/** The full agent-reported session config (each field null when unsupported). */
export interface AcpConfig {
	/** The agent's own capabilities, so the UI can gate features it supports. */
	agentCapabilities?: AcpAgentCapabilities | null;
	/** Sign-in methods the agent advertises (empty when none are required). */
	authMethods?: AcpAuthMethod[] | null;
	configOptions: AcpConfigOption[] | null;
	models: AcpSessionModelState | null;
	modes: AcpSessionModeState | null;
}

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

/** A permission option offered by the agent when it asks to run a tool. */
export interface AcpPermissionOption {
	/** allow_once | allow_always | reject_once | reject_always. */
	kind: string;
	name: string;
	optionId: string;
}

/**
 * Fetch the agent's advertised ACP session config. Returns all-null for non-ACP
 * agents (they have no `session/new` advertisement). Core caches per agent, so
 * this is cheap to call on agent selection.
 */
export async function fetchAcpConfig(
	target: ApiTarget,
	agentId: string
): Promise<AcpConfig> {
	return await request<AcpConfig>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/acp-config`
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
	return await request<{ resolved: boolean }>(target, "/api/chat/permission", {
		method: "POST",
		body: { request_id: requestId, option_id: optionId },
	});
}

/**
 * Run an agent-advertised authentication method (e.g. "Login with ChatGPT").
 * Core drives the ACP `authenticate` call; a subscription/OAuth agent then
 * becomes usable. Returns `{ authenticated }` plus an optional `error` string.
 */
export async function authenticateAgent(
	target: ApiTarget,
	agentId: string,
	methodId: string
): Promise<{ authenticated: boolean; error?: string }> {
	return await request<{ authenticated: boolean; error?: string }>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/authenticate`,
		{ method: "POST", body: { method_id: methodId } }
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
		{ method: "POST" }
	);
}

/** List the sessions an ACP agent persists (empty/`unsupported` for most). */
export async function fetchAcpSessions(
	target: ApiTarget,
	agentId: string
): Promise<AcpSessionList> {
	return await request<AcpSessionList>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/sessions`
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
		{ method: "DELETE" }
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
		return (raw as { options: AcpConfigSelectOption[] }[]).flatMap(
			(g) => g.options
		);
	}
	return raw as AcpConfigSelectOption[];
}
