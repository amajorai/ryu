/**
 * The true model behind the Core engines figure. Every name, count and number the
 * figure shows comes from here, and every one is traced to Ryu's source:
 *
 * - 15 local chat engines, in this order: `LOCAL_ENGINES` in
 *   apps/core/src/sidecar/active_engine.rs:20-36. The drawn shelf is illustrative: it
 *   shows `SHELF_SLOTS` cartridges (view.ts), not one per engine; the real count is
 *   stated only in the accessible text and slider values.
 * - At most one is resident at a time; switching stops the resident engine, then
 *   starts the new one, and the choice is persisted across restarts:
 *   apps/core/src/sidecar/active_engine.rs:1-11 and
 *   apps/core/src/sidecar/manager.rs:533-614 (`set_active_local_engine`, which holds
 *   one mutex across the whole stop-then-start, so swaps never overlap).
 * - Display names: `display_name` in apps/core/src/catalog/registry.rs:366-536
 *   ("LlamaCpp" is written llama.cpp, as in active_engine.rs:4).
 * - Roles: shortened from each entry's `description` in the same lines.
 * - Voice, image/video and embedding engines run alongside the chat engine and are
 *   never part of the swap: apps/core/src/catalog/registry.rs:14-27.
 * - Default chat engine llama.cpp: apps/core/src/catalog/registry.rs:369.
 *   Default chat model Gemma 4 E2B: apps/core/src/registry/mod.rs:294. It is a
 *   download pinned to a SHA-256 digest (registry/mod.rs:315-321), fetched on first
 *   run, not bundled.
 * - Default embeddings nomic-embed-text v1.5, 768 dimensions:
 *   apps/core/src/registry/mod.rs:149-154.
 * - Default speech recognition Parakeet: crates/core/stt/src/lib.rs:214-228.
 * - Default voice Kokoro: apps/core/src/sidecar/providers/ryutts/mod.rs:32-37.
 * - Image engine Stable Diffusion (stable-diffusion.cpp), an optional install:
 *   apps/core/src/catalog/registry.rs:609-612.
 * - Health checks every 30 s: `HEALTH_INTERVAL` in
 *   apps/core/src/sidecar/manager.rs:11; crash check first, then a probe that rates
 *   Healthy, Degraded or Unhealthy: manager.rs:1855-1866 and
 *   apps/core/src/sidecar/mod.rs:152-156.
 */

export interface Engine {
	id: string;
	name: string;
	role: string;
}

/** `LOCAL_ENGINES`, apps/core/src/sidecar/active_engine.rs:20-36. */
export const ENGINES: readonly Engine[] = [
	{ id: "llamacpp", name: "llama.cpp", role: "default · CPU or GPU" },
	{ id: "ollama", name: "Ollama", role: "wraps llama.cpp" },
	{ id: "lemonade", name: "Lemonade Server", role: "connects to your server" },
	{ id: "magnitude", name: "Magnitude", role: "self-tuning kernels" },
	{ id: "llama-swap", name: "llama-swap", role: "on-demand model switching" },
	{ id: "freetoken", name: "FreeToken", role: "MoE on NVIDIA GPUs" },
	{ id: "vllm", name: "vLLM", role: "high-throughput GPU serving" },
	{ id: "sglang", name: "SGLang", role: "fast serving runtime" },
	{ id: "mlx", name: "MLX (text)", role: "Apple Silicon, text" },
	{ id: "mlx-vlm", name: "MLX (vision)", role: "Apple Silicon, vision" },
	{ id: "mlx-serve", name: "MLX Serve", role: "native Apple Silicon" },
	{ id: "omlx", name: "oMLX", role: "Apple Silicon, batching" },
	{
		id: "docker-model-runner",
		name: "Docker Model Runner",
		role: "models via Docker",
	},
	{ id: "apfel", name: "Apple Intelligence", role: "on-device models" },
	{ id: "mesh-llm", name: "Mesh LLM", role: "distributed inference" },
];

export const ENGINE_COUNT = ENGINES.length;

/** llama.cpp, apps/core/src/catalog/registry.rs:369. */
export const DEFAULT_ENGINE = 0;

/** apps/core/src/registry/mod.rs:294 (`gemma-4-E2B-it-Q4_K_M`). */
export const DEFAULT_MODEL = "Gemma 4 E2B";

export interface Alongside {
	detail: string;
	id: "voice" | "image" | "embeddings";
	name: string;
}

/** Categories that run alongside the chat engine, catalog/registry.rs:14-27. */
export const ALONGSIDE: readonly Alongside[] = [
	{ id: "voice", name: "Voice", detail: "Parakeet + Kokoro" },
	{ id: "image", name: "Image", detail: "Stable Diffusion, optional" },
	{ id: "embeddings", name: "Embeddings", detail: "nomic v1.5, 768-dim" },
];

/** `HEALTH_INTERVAL`, apps/core/src/sidecar/manager.rs:11. */
export const HEALTH_INTERVAL_S = 30;

/** The figure plays the sweep this many times faster than real time. */
export const SWEEP_SPEEDUP = 5;

export const SWEEP_SHOWN_S = HEALTH_INTERVAL_S / SWEEP_SPEEDUP;

export const engineAt = (index: number): Engine =>
	ENGINES[Math.min(ENGINE_COUNT - 1, Math.max(0, index))] ?? {
		id: "",
		name: "",
		role: "",
	};

export type Phase = "loaded" | "unloading" | "loading";

export function spokenOf(loaded: number | null, phase: Phase, moving: number) {
	if (phase !== "loaded") {
		return `${phase === "unloading" ? "Unloading" : "Loading"} ${engineAt(moving).name}`;
	}
	if (loaded === null) {
		return "No chat engine loaded";
	}
	const engine = engineAt(loaded);
	return `${engine.name} loaded, engine ${loaded + 1} of ${ENGINE_COUNT}: ${engine.role}`;
}

export const RESTING_SPOKEN = spokenOf(
	DEFAULT_ENGINE,
	"loaded",
	DEFAULT_ENGINE
);
