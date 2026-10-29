/**
 * The Everyday/Developer response mode picks which operating contract Core
 * folds into the flagship Ryu assistant's system prompt
 * (`ryu_platform::operating_contract`). Desktop derives the mode from the
 * interface level (Ryu Work → everyday, Code → developer), so anything that
 * moves the level between those two is a one-time prompt-cache miss for every
 * Ryu assistant thread. These helpers decide whether a level change needs the
 * confirmation, using the same copy as every other prompt-layer editor.
 */

import { promptEditCacheWarning } from "@ryu/blocks/desktop/agent-elements/prompt-cache.ts";
import { responseModeForInterface } from "@/src/lib/chat-routing.ts";
import type { InterfaceLevel } from "@/src/lib/interface-level.ts";
import type { ProductMode } from "@/src/lib/product-mode.ts";

/** UI label for the prompt layer the response mode controls. */
export const RESPONSE_MODE_FIELD = "The response mode";

/**
 * The interface level a product mode implies. Bot is the everyday surface;
 * the workspace and Console are the full Code surface.
 */
export function interfaceLevelForProductMode(
	mode: ProductMode
): InterfaceLevel {
	return mode === "bot" ? "simple" : "expert";
}

/**
 * The confirmation shown before moving the interface level, or null when the
 * response mode Core receives stays the same.
 */
export function responseModeCacheWarning(
	current: InterfaceLevel,
	next: InterfaceLevel
): { description: string; title: string } | null {
	const changed =
		responseModeForInterface(current) !== responseModeForInterface(next);
	return promptEditCacheWarning(
		changed ? [RESPONSE_MODE_FIELD] : [],
		"ryu-agent"
	);
}
