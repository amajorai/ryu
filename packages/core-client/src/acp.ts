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

import { z } from "zod";
import {
	appJsonValueSchema,
	appResponseValueSchema,
} from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

// Native probe envelopes plus the ACP schema 0.12.0 serde models enabled in Core.
function acpResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const acpMetaFields = z.record(z.string(), appJsonValueSchema);
const acpMetaSchema = z.custom<z.output<typeof acpMetaFields>>(
	(value) =>
		acpMetaFields.safeParse(value).success &&
		Object.entries(Object.call(undefined, value)).every(
			([, entry]) => appJsonValueSchema.safeParse(entry).success
		)
);
const acpDescription = z.string().nullable().optional();
const acpMeta = acpMetaSchema.nullable().optional();
const acpModeSchema = acpResponse(
	z.object({
		id: z.string(),
		name: z.string(),
		description: acpDescription,
		_meta: acpMeta,
	})
);
const acpModeStateSchema = acpResponse(
	z.object({
		currentModeId: z.string(),
		availableModes: z.array(acpModeSchema),
		_meta: acpMeta,
	})
);
const acpModelSchema = acpResponse(
	z.object({
		modelId: z.string(),
		name: z.string(),
		description: acpDescription,
		_meta: acpMeta,
	})
);
const acpModelStateSchema = acpResponse(
	z.object({
		currentModelId: z.string(),
		availableModels: z.array(acpModelSchema),
		_meta: acpMeta,
	})
);
const acpSelectOptionSchema = acpResponse(
	z.object({
		value: z.string(),
		name: z.string(),
		description: acpDescription,
		_meta: acpMeta,
	})
);
const acpSelectGroupSchema = acpResponse(
	z.object({
		group: z.string(),
		name: z.string(),
		options: z.array(acpSelectOptionSchema),
		_meta: acpMeta,
	})
);
const acpOptionBase = {
	id: z.string(),
	name: z.string(),
	description: acpDescription,
	category: z.string().nullable().optional(),
	_meta: acpMeta,
};
const acpConfigOptionSchema = acpResponse(
	z.discriminatedUnion("type", [
		z.object({
			...acpOptionBase,
			type: z.literal("select"),
			currentValue: z.string(),
			options: z.union([
				z.array(acpSelectOptionSchema),
				z.array(acpSelectGroupSchema),
			]),
		}),
		z.object({
			...acpOptionBase,
			type: z.literal("boolean"),
			currentValue: z.boolean(),
		}),
	])
);
const acpAuthMethodSchema = acpResponse(
	z.object({
		id: z.string(),
		name: z.string(),
		description: acpDescription,
		type: z.string().optional(),
		_meta: acpMeta,
	})
);
// Optional capability fields preserve the client's documented older partial advertisement.
// Every capability known to Core's agent_caps_json is validated when present.
const acpCapabilitiesSchema = acpResponse(
	z.object({
		loadSession: z.boolean().optional(),
		promptCapabilities: acpResponse(
			z.object({
				image: z.boolean().optional(),
				audio: z.boolean().optional(),
				embeddedContext: z.boolean().optional(),
			})
		).optional(),
		mcpCapabilities: acpResponse(
			z.object({ http: z.boolean().optional(), sse: z.boolean().optional() })
		).optional(),
		sessionCapabilities: acpResponse(
			z.object({
				list: z.boolean().optional(),
				resume: z.boolean().optional(),
				close: z.boolean().optional(),
			})
		).optional(),
	})
);
export const acpConfigResponseSchema = acpResponse(
	z.object({
		modes: acpModeStateSchema.nullable(),
		models: acpModelStateSchema.nullable(),
		configOptions: z.array(acpConfigOptionSchema).nullable(),
		authMethods: z.array(acpAuthMethodSchema).nullable().optional(),
		agentCapabilities: acpCapabilitiesSchema.nullable().optional(),
		authenticationRequired: z.boolean().optional(),
		ryuToolAccess: z.string().optional(),
	})
);
export const acpPermissionResponseSchema = acpResponse(
	z.object({ resolved: z.boolean() })
);

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
	currentValue?: string | boolean;
	description?: string | null;
	id: string;
	name: string;
	/** Flat list for ungrouped selects; grouped selects expose `{ options }`. */
	options?: AcpConfigSelectOption[] | { options: AcpConfigSelectOption[] }[];
	type?: string;
}

/** A login method advertised by the agent during initialize. */
export interface AcpAuthMethod {
	description?: string | null;
	id: string;
	name: string;
	type?: string;
}

/** Normalized capabilities advertised by the agent. Missing fields are unknown. */
export interface AcpAgentCapabilities {
	loadSession?: boolean;
	mcpCapabilities?: { http?: boolean; sse?: boolean };
	promptCapabilities?: {
		audio?: boolean;
		embeddedContext?: boolean;
		image?: boolean;
	};
	sessionCapabilities?: { close?: boolean; list?: boolean; resume?: boolean };
}

/**
 * Which agent-specific launch settings Core maps for this agent (see Core's
 * `acp_agent_settings`), from `GET /api/agents/:id/acp-settings`. Generic
 * command/args/env/session defaults always apply.
 */
export interface AcpAgentSettingsSupport {
	autoCompactToggle: boolean;
	autoCompactTokens: boolean;
	cliPath: boolean;
	configDir: boolean;
	/** The agent has a config dir, but Ryu manages it (Codex's safety home). */
	configDirManaged: boolean;
}

/** Session controls and initialized login metadata, including signed-out agents. */
export interface AcpConfig {
	agentCapabilities?: AcpAgentCapabilities | null;
	authenticationRequired?: boolean;
	authMethods?: AcpAuthMethod[] | null;
	configOptions: AcpConfigOption[] | null;
	models: AcpSessionModelState | null;
	modes: AcpSessionModeState | null;
}

/** A permission option offered by the agent when it asks to run a tool. */
export interface AcpPermissionOption {
	/** allow_once | allow_always | reject_once | reject_always. */
	kind: string;
	name: string;
	optionId: string;
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
export async function fetchAcpConfig(
	target: ApiTarget,
	agentId: string,
	selections?: Record<string, string> | null
): Promise<AcpConfig> {
	return await request(
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
	return await request(
		target,
		"/api/chat/permission",
		{
			method: "POST",
			body: { request_id: requestId, option_id: optionId },
		},
		acpPermissionResponseSchema
	);
}

/** Flatten a select option's `options` (ungrouped or grouped) to a flat list. */
export function flattenConfigOptions(
	option: AcpConfigOption
): AcpConfigSelectOption[] {
	const raw = option.options ?? [];
	const first = raw[0];
	if (!first) {
		return [];
	}
	// Grouped form: `[{ options: [...] }, ...]`.
	if ("options" in first) {
		// SAFETY: Core serializes ACP schema 0.12.0 SessionConfigSelectOptions,
		// a uniform Ungrouped/Grouped array union. Only the Grouped variant
		// publishes `options` on each entry; TypeScript cannot narrow the whole
		// array from its first entry. This preserves the native option references.
		return (raw as { options: AcpConfigSelectOption[] }[]).flatMap(
			(g) => g.options
		);
	}
	// SAFETY: The same native uniform-array union above is nonempty here.
	// Its Ungrouped entries have value/name/description/_meta, no `options`.
	// Return the original array rather than reconstructing its SDK values.
	return raw as AcpConfigSelectOption[];
}
