// Build a single ApiTarget for the running Ryu Core node from the environment.
//
// RYU_CORE_URL   - base URL of the Core node (default http://127.0.0.1:7980)
// RYU_CORE_TOKEN - optional bearer token; pass null (no header) when unset
//
// buildTarget() is env-only and mirrors apps/mcp/src/target.ts; it serves the
// process-level seams (auto-update, identity broker, referral). Which node a
// command or the TUI actually talks to goes through the saved node registry in
// nodeTarget.ts, which buildInteractiveTarget delegates to.

import type { ApiTarget } from "@ryuhq/core-client/client";
import { withCoreIdentityCheck } from "./coreIdentity.ts";
import { DEFAULT_CORE_URL } from "./defaultCoreUrl.ts";
import { loadNodes, type NodesConfig } from "./nodes.ts";
import { resolveNodeTarget } from "./nodeTarget.ts";

export { DEFAULT_CORE_URL } from "./defaultCoreUrl.ts";

export const buildTarget = (): ApiTarget => {
	const url = process.env.RYU_CORE_URL?.trim() || DEFAULT_CORE_URL;
	const token = process.env.RYU_CORE_TOKEN?.trim() || null;
	return withCoreIdentityCheck({ url, token });
};

/**
 * The node the interactive TUI opens on: `--node <name|url>` when given, else
 * RYU_CORE_URL, else the active node saved by `ryu node use` / the node picker.
 * Throws {@link UnknownNodeError} for a `--node` value that is neither.
 */
export function buildInteractiveTarget(
	nodeRef: string | null,
	config: NodesConfig = loadNodes()
): ApiTarget {
	return resolveNodeTarget(nodeRef, config);
}
