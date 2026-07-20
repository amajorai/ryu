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
 * Fetch an agent's effective capabilities. Cheap to call on agent selection —
 * Core caches ACP probes per agent and a GGUF read only touches the file header.
 */
export async function fetchAgentCapabilities(
	target: ApiTarget,
	agentId: string,
	modelId?: string | null
): Promise<CapabilityReport> {
	const query =
		modelId && modelId.trim().length > 0
			? `?model=${encodeURIComponent(modelId)}`
			: "";
	return await request<CapabilityReport>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/capabilities${query}`
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
	return await request<CapabilityReport>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/capabilities`,
		{ method: "PUT", body: overrides }
	);
}
