// apps/desktop/src/lib/api/engines.ts
//
// Typed client for Core's engine endpoints (`/api/engines`, `/api/engine/active`).
// An engine is the built-in runtime an agent binds to; the "active" engine is the
// one currently resident in Core. Used by the agents page and the system-status
// spine (active-engine indicator).

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

interface EngineWire {
	description?: string | null;
	id: string;
	install_hint?: string | null;
	installed?: boolean | null;
	name: string;
}

export async function fetchEngines(target: ApiTarget): Promise<Engine[]> {
	const json = await request<{ engines?: EngineWire[] }>(
		target,
		"/api/engines"
	);
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
	const json = await request<{
		models?: Record<string, { id: string; name: string }[]>;
	}>(target, "/api/engines/models");
	return json.models ?? {};
}

export async function fetchActiveEngine(
	target: ApiTarget
): Promise<ActiveEngine> {
	const json = await request<{
		active?: string | null;
		running?: boolean;
		available?: string[];
	}>(target, "/api/engine/active");
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
	const json = await request<{
		success?: boolean;
		error?: string;
		active?: string | null;
		stopped?: string | null;
		running?: boolean;
		unchanged?: boolean;
		gateway_refreshed?: boolean;
	}>(target, "/api/engine/active", { method: "POST", body: { name } });
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
