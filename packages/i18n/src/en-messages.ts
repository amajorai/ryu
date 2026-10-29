import { EN_SHELL_MESSAGES } from "./en-messages-shell.ts";
import { EN_SURFACE_MESSAGES } from "./en-messages-surfaces.ts";

/**
 * The canonical source catalog. Keep message ids stable: language packs are
 * data-only overlays keyed by these ids, so changing an id strands community
 * translations even when the English wording did not change.
 *
 * This module carries no translations, so the runtime and React hooks can use
 * it without pulling the built-in language packs into a bundle.
 */
export const EN_MESSAGES = {
	...EN_SHELL_MESSAGES,
	...EN_SURFACE_MESSAGES,
} as const;

/** A type-safe id union for code that uses the canonical catalog. */
export type MessageId = keyof typeof EN_MESSAGES;
