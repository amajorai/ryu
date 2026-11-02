/**
 * English source for the Ghost cursor chip: the short label Island shows beside
 * the agent's cursor while Ghost clicks, types or scrolls. Ghost sends a stable
 * intent kind (`apps/ghost/src/tools/overlay_events.rs`, `INTENT_KINDS`) and
 * the Island main process (`src/main/ghost-cursor-label.ts`) renders it here in
 * the user's language.
 *
 * The table lives under `src/renderer` so `tools/i18n-extract` collects each
 * label into the catalogs; `tl()` is only an identity marker for it. The main
 * process imports this module, nothing in the renderer does.
 */

const tl = (source: string): string => source;

/** Every intent kind Ghost emits, with its English label. */
export const GHOST_INTENT_COPY = {
	click: tl("Click"),
	clicking: tl("Clicking"),
	typing: tl("Typing"),
	scrolling: tl("Scrolling"),
	dragging: tl("Dragging"),
	hovering: tl("Hovering"),
	holding: tl("Holding"),
	working: tl("Working"),
	done: tl("Done"),
} as const;

export type GhostIntentKind = keyof typeof GHOST_INTENT_COPY;

/** A click on a named element; `{target}` is the element's own label. */
export const GHOST_CLICK_TARGET_COPY = tl("Click “{target}”");
