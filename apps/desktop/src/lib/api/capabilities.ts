import { z } from "zod";
// apps/desktop/src/lib/api/capabilities.ts
//
// Typed client for Core's per-agent capability endpoints. Capabilities (tool
// calling / reasoning / vision) are detected per agent the same way Jan does it:
// an ACP agent's reasoning support is read from its `session/new` config options
// (tools always supported via the MCP bridge); a local / openai-compat agent's
// flags are read from the bound model's GGUF chat template. The auto-detected
// result is the default; a per-agent override (set on the edit page) wins.
//
// The desktop gates its composer controls and edit-page sections on the
// effective flags, so a model that can't call tools never shows a tools
// affordance, and a non-reasoning model never shows a thinking control.

import { type ApiTarget, request } from "./client.ts";

/** Auto-detected capability flags, before any user override. */
export interface DetectedCaps {
	reasoning: boolean;
	tools: boolean;
	vision: boolean;
}

/** Tri-state overrides: null/absent = auto-detect, true/false = forced. */
export interface CapabilityOverrides {
	reasoning?: boolean | null;
	tools?: boolean | null;
	vision?: boolean | null;
}

/**
 * The agent's effective capabilities plus provenance. `tools`/`reasoning`/
 * `vision` are the effective flags (detected, then override) the UI gates on.
 * `source` is `"acp_probe"` | `"acp_probe+gguf"` | `"gguf"` | `"default"`.
 */
export interface CapabilityReport {
	detected: DetectedCaps;
	overrides: CapabilityOverrides;
	reasoning: boolean;
	source: string;
	tools: boolean;
	vision: boolean;
}

/**
 * Normalize a raw capability report so every field the UI dereferences is always
 * present. Mirrors the defensive `toAgent`/`toTool` convention the rest of this
 * domain uses: Core may omit `overrides` (or nested flags) when empty, and the
 * capabilities panel reads `report.detected[key]` / `report.overrides[key]`
 * directly — an absent nested object would throw "Cannot read properties of
 * undefined" and crash the whole agent-edit page. Defaulting here (rather than
 * guarding at every deref) keeps the boundary the single source of truth.
 */
const detectedCapsSchema = z.object({
	reasoning: z
		.boolean()
		.nullish()
		.transform((value) => value ?? false),
	tools: z
		.boolean()
		.nullish()
		.transform((value) => value ?? false),
	vision: z
		.boolean()
		.nullish()
		.transform((value) => value ?? false),
});
const capabilityOverridesSchema = z.object({
	reasoning: z
		.boolean()
		.nullish()
		.transform((value) => value ?? null),
	tools: z
		.boolean()
		.nullish()
		.transform((value) => value ?? null),
	vision: z
		.boolean()
		.nullish()
		.transform((value) => value ?? null),
});
const capabilityReportSchema = detectedCapsSchema.extend({
	detected: detectedCapsSchema
		.nullish()
		.transform((value) => value ?? detectedCapsSchema.parse({})),
	overrides: capabilityOverridesSchema
		.nullish()
		.transform((value) => value ?? capabilityOverridesSchema.parse({})),
	source: z
		.string()
		.nullish()
		.transform((value) => value ?? "default"),
});
const toReport = z.preprocess(
	(value) => value ?? {},
	capabilityReportSchema
).parse;

/**
 * Fetch an agent's effective capabilities. Cheap to call on agent selection —
 * Core caches ACP probes per agent and a GGUF read only touches the file header.
 */
export async function fetchAgentCapabilities(
	target: ApiTarget,
	agentId: string,
	modelId?: string | null,
	/**
	 * The caller's ACP config-option picks, same shape as `fetchAcpConfig`'s.
	 *
	 * Load-bearing, not an optimisation: `reasoning` is true when the agent's
	 * probe reported a thought-level option, and an agent whose reasoning option
	 * only exists for some models advertises none on its default one. The
	 * composer HIDES a reasoning option whenever this says false, so probing the
	 * two endpoints with different selections makes them contradict each other —
	 * the option is advertised and then suppressed.
	 */
	selections?: Record<string, string> | null
): Promise<CapabilityReport> {
	const params = new URLSearchParams();
	if (modelId && modelId.trim().length > 0) {
		params.set("model", modelId);
	}
	const picks = Object.entries(selections ?? {})
		.filter(([id, value]) => id.length > 0 && value.length > 0)
		.sort(([a], [b]) => a.localeCompare(b));
	if (picks.length > 0) {
		params.set("selections", JSON.stringify(Object.fromEntries(picks)));
	}
	const query = params.size > 0 ? `?${params.toString()}` : "";
	return toReport(
		await request<CapabilityReport>(
			target,
			`/api/agents/${encodeURIComponent(agentId)}/capabilities${query}`,
			undefined,
			capabilityReportSchema
		)
	);
}

/**
 * Persist an agent's capability overrides (tri-state). Pass `null` for a field
 * to reset it to auto-detection. Returns the recomputed effective report.
 */
export async function setAgentCapabilities(
	target: ApiTarget,
	agentId: string,
	overrides: CapabilityOverrides
): Promise<CapabilityReport> {
	return toReport(
		await request<CapabilityReport>(
			target,
			`/api/agents/${encodeURIComponent(agentId)}/capabilities`,
			{ method: "PUT", body: overrides },
			capabilityReportSchema
		)
	);
}
