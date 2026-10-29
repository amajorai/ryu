// apps/desktop/src/lib/api/engines.ts
//
// Typed client for Core's engine endpoints (`/api/engines`, `/api/engine/active`).
// An engine is the built-in runtime an agent binds to; the "active" engine is the
// one currently resident in Core. Used by the agents page and the system-status
// spine (active-engine indicator).

import { z } from "zod";
import {
	appJsonValueSchema,
	appResponseValueSchema,
} from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

/** A selectable chat model (id + display name). Mirrors the desktop UI option
 * shape; defined locally so the shared client has no presentational dependency. */
export interface ModelOption {
	id: string;
	name: string;
}

/** A built-in engine (runtime) an agent can be bound to. */
export interface Engine {
	description: string | null;
	id: string;
	installed: boolean | null;
	installHint: string | null;
	name: string;
}

/**
 * The currently resident local engine plus the engines available to swap to.
 * `active` is the resident engine id (or null when none); `running` reflects
 * whether that engine's process is live.
 */
export interface ActiveEngine {
	active: string | null;
	available: string[];
	running: boolean;
}

// Full AgentInfo native publisher, including fields not displayed by the picker.
// Nullable/optional additions retain the existing older-node normalization.
function engineResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
export const engineInfoResponseSchema = engineResponse(
	z.object({
		id: z.string(),
		name: z.string(),
		title: z.string().nullish(),
		description: z.string().nullish(),
		install_hint: z.string().nullish(),
		installed: z.boolean().nullish(),
		model: z.string().nullish(),
		system_prompt: z.string().nullish(),
		created_at: z.string().nullish(),
		engine: z.string().nullish(),
		transport: z.string().nullish(),
		recommended: z.boolean().nullish(),
		version: z.string().nullish(),
		latest_version: z.string().nullish(),
		version_status: z.string().nullish(),
		locked: z.boolean().nullish(),
		enabled: z.boolean().nullish(),
		gateway_bypass: z.boolean().nullish(),
		avatar_url: z.string().nullish(),
		avatar_glyph: appJsonValueSchema.optional(),
		lifecycle_status: z.string().nullish(),
		safety_profile: z.string().nullish(),
	})
);
const enginesResponseSchema = engineResponse(
	z.object({ engines: z.array(engineInfoResponseSchema).nullish() })
);
const engineModelResponseSchema = engineResponse(
	z.object({ id: z.string(), name: z.string() })
);
const modelOptionsSchema = z.array(engineModelResponseSchema);
const modelsMapFieldsSchema = z.record(z.string(), modelOptionsSchema);
// Zod records skip __proto__; validate every actual own native map entry too.
const modelsMapSchema = z.custom<z.output<typeof modelsMapFieldsSchema>>(
	(value) =>
		modelsMapFieldsSchema.safeParse(value).success &&
		Object.values(new Object(value)).every(
			(options) => modelOptionsSchema.safeParse(options).success
		)
);
export const engineModelsResponseSchema = engineResponse(
	z.object({ models: modelsMapSchema.nullish() })
);
export const activeEngineResponseSchema = engineResponse(
	z.object({
		active: z.string().nullish(),
		running: z.boolean().optional(),
		available: z.array(z.string()).nullish(),
		llamacpp_variant: z.string().nullish(),
	})
);
const engineSwapResponseSchema = engineResponse(
	z.object({
		success: z.boolean().optional(),
		error: z.string().optional(),
		active: z.string().nullish(),
		stopped: z.string().nullish(),
		running: z.boolean().optional(),
		unchanged: z.boolean().optional(),
		gateway_refreshed: z.boolean().optional(),
	})
);

export async function fetchEngines(target: ApiTarget): Promise<Engine[]> {
	const json = await request(target, "/api/engines", {}, enginesResponseSchema);
	return (json.engines ?? []).map(
		(e): Engine => ({
			id: e.id,
			name: e.name,
			description: e.description ?? null,
			installHint: e.install_hint ?? null,
			installed: e.installed ?? null,
		})
	);
}

/**
 * Per-engine chat-model options, owned by Core (`GET /api/engines/models`) so
 * every client shows the same swappable defaults instead of each hardcoding its
 * own list. Keyed by engine id (e.g. "claude" → Opus/Sonnet/Haiku).
 */
export async function fetchEngineModels(
	target: ApiTarget
): Promise<Record<string, ModelOption[]>> {
	const json = await request(
		target,
		"/api/engines/models",
		{},
		engineModelsResponseSchema
	);
	return json.models ?? {};
}

export async function fetchActiveEngine(
	target: ApiTarget
): Promise<ActiveEngine> {
	const json = await request(
		target,
		"/api/engine/active",
		{},
		activeEngineResponseSchema
	);
	return {
		active: json.active ?? null,
		running: json.running ?? false,
		available: json.available ?? [],
	};
}

/**
 * The outcome of swapping the resident local engine via
 * `POST /api/engine/active`. Core stops whatever engine was resident and starts
 * the requested one, then re-points the gateway's `local` provider at it.
 * `gatewayRefreshed` is `false` when the swap succeeded but the follow-up
 * gateway refresh failed — the engine is active, but routing may be stale until
 * the gateway recovers. `unchanged` is `true` when the requested engine was
 * already resident (a no-op swap).
 */
export interface EngineSwap {
	active: string | null;
	gatewayRefreshed: boolean;
	running: boolean;
	stopped: string | null;
	unchanged: boolean;
}

/** Swap the resident local engine to `name`. */
export async function setActiveEngine(
	target: ApiTarget,
	name: string
): Promise<EngineSwap> {
	const json = await request(
		target,
		"/api/engine/active",
		{ method: "POST", body: { name } },
		engineSwapResponseSchema
	);
	if (json.success === false) {
		throw new Error(json.error ?? `Failed to activate engine "${name}"`);
	}
	return {
		active: json.active ?? null,
		stopped: json.stopped ?? null,
		running: json.running ?? false,
		unchanged: json.unchanged ?? false,
		gatewayRefreshed: json.gateway_refreshed ?? true,
	};
}
