// apps/desktop/src/components/settings/ModelParametersSettings-model-selection.ts
//
// Model selection types and shared helpers for the model parameters settings.

/** Engine ids Core resolves to a local runtime (`Engine::from_name`). */
export const LOCAL_ENGINE_IDS = new Set([
	"llamacpp",
	"ollama",
	"vllm",
	"sglang",
	"mlx",
	"mlx-vlm",
	"mlx-serve",
	"omlx",
	"apfel",
	"mesh-llm",
]);

export type ModelKind = "local" | "cloud";

export interface SelectedModel {
	/** Local engine id, for local models. */
	engine?: string;
	id: string;
	kind: ModelKind;
	label: string;
	/** Catalog provider id, for cloud models. */
	provider?: string;
}

export function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}
