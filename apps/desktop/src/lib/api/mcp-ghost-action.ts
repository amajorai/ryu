import type { GhostActionInput } from "@ryuhq/core-client/mcp.ts";

/**
 * Map a named Ghost action to its fully-qualified tool id and arguments.
 * Returns `null` when required parameters are missing.
 */
export function ghostActionToCall(
	input: GhostActionInput
): { arguments: unknown; tool: string } | null {
	switch (input.kind) {
		case "focus": {
			if (!input.target) {
				return null;
			}
			return {
				tool: "ghost.ghost_focus",
				arguments: { app: input.target },
			};
		}
		case "click": {
			if (!input.target) {
				return null;
			}
			return {
				tool: "ghost.ghost_click",
				arguments: { query: input.target },
			};
		}
		case "screenshot": {
			return {
				tool: "ghost.ghost_screenshot",
				arguments: {},
			};
		}
		default: {
			// Exhaustive check — TypeScript ensures all GhostActionKind variants
			// are handled above; this branch is unreachable at runtime.
			return null;
		}
	}
}
