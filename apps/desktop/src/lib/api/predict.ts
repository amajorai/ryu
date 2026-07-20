// apps/desktop/src/lib/api/predict.ts
//
// Typed client for Core's predictive-typing config (`/api/predict/config`). This
// is the SYSTEM-WIDE inline autocomplete (the `apps-store/predict` overlay): the model
// / agent behind it, the per-app allowlist, and the debounce. Core applies the
// secure-field denylist + the app allowlist server-side and routes the
// prediction through the Gateway — nothing is hardcoded.
//
// The in-editor copilot ghost text (PlateJS, inside Spaces docs) is a SEPARATE
// surface configured by Settings → Editor & Embeddings ("Inline AI editing").

import { type ApiTarget, request } from "./client.ts";

/**
 * Manifest id of the built-in **Predict** plugin. Installing/enabling it is the
 * single on/off switch for system-wide predictive typing; this config only tunes
 * the model / allowlist / debounce once it is on. The settings tab is gated on
 * this plugin being enabled (see `SettingsDialog`).
 */
export const PREDICT_PLUGIN_ID = "predict";

/** Persisted predictive-typing config (mirrors Core's `PredictConfig`). */
export interface PredictConfig {
	/** Optional agent backing predictions (its bound model wins over `model`). */
	agentId?: string;
	/** Per-app process-name allowlist; empty = every app allowed. */
	appAllowlist: string[];
	/** Debounce (ms) the overlay waits after the caret settles. */
	debounceMs: number;
	/** `reasoning_effort` passthrough; blank → omitted. */
	effort: string;
	/** Max characters of a returned suggestion. */
	maxChars: number;
	/** Gateway-routable model id; blank → resolved from agent / env / default. */
	model: string;
}

export const DEFAULT_PREDICT_CONFIG: PredictConfig = {
	model: "",
	effort: "",
	appAllowlist: [],
	debounceMs: 400,
	maxChars: 240,
};

/** Read the predictive-typing config (defaults applied), or defaults on error. */
export async function getPredictConfig(
	target: ApiTarget
): Promise<PredictConfig> {
	try {
		return await request<PredictConfig>(target, "/api/predict/config");
	} catch {
		return { ...DEFAULT_PREDICT_CONFIG };
	}
}

/** Persist the predictive-typing config. Returns success. */
export async function setPredictConfig(
	target: ApiTarget,
	config: PredictConfig
): Promise<boolean> {
	try {
		await request(target, "/api/predict/config", {
			method: "PUT",
			body: config,
		});
		return true;
	} catch {
		return false;
	}
}
