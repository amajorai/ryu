import { z } from "zod";
// apps/desktop/src/lib/api/engines.ts
//
// Typed client for Core's engine endpoints (`/api/engines`, `/api/engine/active`).
// An engine is the built-in runtime an agent binds to; the "active" engine is the
// one currently resident in Core. Used by the agents page and the system-status
// spine (active-engine indicator).

import type { ModelOption } from "@/components/agent-elements/types.ts";
import { track } from "@/src/lib/analytics.ts";
import { type ApiTarget, request } from "./client.ts";

const enginesResponseSchema = z.looseObject({
	description: z.union([z.null(), z.string()]).optional(),
	id: z.string(),
	install_hint: z.union([z.null(), z.string()]).optional(),
	installed: z.union([z.null(), z.literal(false), z.literal(true)]).optional(),
	name: z.string(),
});
const jsonResponseSchema = z.looseObject({
	engines: z.array(enginesResponseSchema).optional(),
});
const modelsResponseSchema = z.looseObject({
	id: z.string(),
	name: z.string(),
});
const jsonResponseSchema2 = z.looseObject({
	models: z.record(z.string(), z.array(modelsResponseSchema)).optional(),
});
const jsonResponseSchema3 = z.looseObject({
	active: z.union([z.null(), z.string()]).optional(),
	running: z.boolean().optional(),
	available: z.array(z.string()).optional(),
	llamacpp_variant: z.union([z.null(), z.string()]).optional(),
});
const optionsResponseSchema = z.looseObject({
	available: z.boolean().optional(),
	description: z.string().optional(),
	id: z.string(),
	label: z.string().optional(),
	unavailable_reason: z.union([z.null(), z.string()]).optional(),
});
const jsonResponseSchema4 = z.looseObject({
	selected: z.string().optional(),
	resolved: z.string().optional(),
	resolved_label: z.string().optional(),
	installed: z.union([z.null(), z.string()]).optional(),
	has_gpu: z.boolean().optional(),
	gpu_name: z.union([z.null(), z.string()]).optional(),
	vram: z.string().optional(),
	options: z.array(optionsResponseSchema).optional(),
});
const jsonResponseSchema5 = z.looseObject({
	success: z.boolean().optional(),
	error: z.string().optional(),
});
const jsonResponseSchema6 = z.looseObject({
	success: z.boolean().optional(),
	error: z.string().optional(),
	active: z.union([z.null(), z.string()]).optional(),
	stopped: z.union([z.null(), z.string()]).optional(),
	running: z.boolean().optional(),
	unchanged: z.boolean().optional(),
	gateway_refreshed: z.boolean().optional(),
});

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
	/** Which llama.cpp build is installed ("cpu" / "metal" / "cuda" / "vulkan"). */
	llamacppVariant: string | null;
	running: boolean;
}

/**
 * One llama.cpp build the node could run. `available` is Core's answer for THIS
 * machine — a GPU build on a machine with no usable graphics card comes back
 * `available: false` with a plain-language `unavailableReason`, and Core refuses
 * to install it even if asked directly.
 */
export interface AccelerationOption {
	available: boolean;
	description: string;
	id: string;
	label: string;
	unavailableReason: string | null;
}

/**
 * Which llama.cpp build runs. `selected` is the user's choice — `"auto"` by
 * default, which is what almost everyone should stay on; `resolved` is what
 * that actually means on this machine, so the UI can say "Automatic (using your
 * graphics card)" without the user knowing what CUDA or Vulkan is.
 */
export interface LlamacppAcceleration {
	gpuName: string | null;
	hasGpu: boolean;
	installed: string | null;
	options: AccelerationOption[];
	resolved: string;
	resolvedLabel: string;
	selected: string;
	vram: string;
}

export async function fetchEngines(target: ApiTarget): Promise<Engine[]> {
	const json = await request(
		target,
		"/api/engines",
		undefined,
		jsonResponseSchema
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
	const json = await request(
		target,
		"/api/engines/models",
		undefined,
		jsonResponseSchema2
	);
	return json.models ?? {};
}

export async function fetchActiveEngine(
	target: ApiTarget
): Promise<ActiveEngine> {
	const json = await request(
		target,
		"/api/engine/active",
		undefined,
		jsonResponseSchema3
	);
	return {
		active: json.active ?? null,
		running: json.running ?? false,
		available: json.available ?? [],
		llamacppVariant: json.llamacpp_variant ?? null,
	};
}

/** Read the llama.cpp acceleration choice and what this machine supports. */
export async function fetchLlamacppAcceleration(
	target: ApiTarget
): Promise<LlamacppAcceleration> {
	const json = await request(
		target,
		"/api/engine/llamacpp/acceleration",
		undefined,
		jsonResponseSchema4
	);
	return {
		selected: json.selected ?? "auto",
		resolved: json.resolved ?? "cpu",
		resolvedLabel: json.resolved_label ?? "CPU only",
		installed: json.installed ?? null,
		hasGpu: json.has_gpu ?? false,
		gpuName: json.gpu_name ?? null,
		vram: json.vram ?? "",
		options: (json.options ?? []).map(
			(o): AccelerationOption => ({
				id: o.id,
				label: o.label ?? o.id,
				description: o.description ?? "",
				available: o.available ?? false,
				unavailableReason: o.unavailable_reason ?? null,
			})
		),
	};
}

/**
 * Pin the llama.cpp build, or pass `"auto"` to hand the choice back to
 * hardware detection. Core installs the new build before returning, so a
 * resolved promise means the engine really is running that backend.
 */
export async function setLlamacppAcceleration(
	target: ApiTarget,
	variant: string
): Promise<void> {
	const json = await request(
		target,
		"/api/engine/llamacpp/acceleration",
		{ method: "POST", body: { variant } },
		jsonResponseSchema5
	);
	if (json.success === false) {
		throw new Error(json.error ?? `Failed to switch to "${variant}"`);
	}
	track({ event: "engine_swapped", engine: `llamacpp-${variant}` });
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
		jsonResponseSchema6
	);
	if (json.success === false) {
		throw new Error(json.error ?? `Failed to activate engine "${name}"`);
	}
	if (json.unchanged !== true) {
		track({ event: "engine_swapped", engine: name });
	}
	return {
		active: json.active ?? null,
		stopped: json.stopped ?? null,
		running: json.running ?? false,
		unchanged: json.unchanged ?? false,
		gatewayRefreshed: json.gateway_refreshed ?? true,
	};
}
