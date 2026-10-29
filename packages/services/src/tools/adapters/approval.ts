// packages/services/src/tools/adapters/approval.ts
//
// Which tools an adapter marks as needing a human's approval before they run.

import type { AnyRyuTool } from "../types.ts";

/**
 * `true`/`false` for every tool, or a function deciding per tool. Default:
 * every tool that is not read-only, so a write a host enabled with
 * `readOnly: false` still asks first, and every open-world tool, so a
 * read that reaches outside Ryu with model-chosen arguments
 * (`passport_fetch`, which sends a stored login to an external site) asks
 * too.
 */
export type RyuToolApprovalOption = boolean | ((tool: AnyRyuTool) => boolean);

/** The default: not read-only, or open-world. */
export function defaultNeedsApproval(tool: AnyRyuTool): boolean {
	return !tool.annotations.readOnlyHint || tool.annotations.openWorldHint;
}

/** Resolves {@link RyuToolApprovalOption} for one tool. */
export function needsApproval(
	tool: AnyRyuTool,
	option: RyuToolApprovalOption | undefined
): boolean {
	if (typeof option === "function") {
		return option(tool);
	}
	return option ?? defaultNeedsApproval(tool);
}
