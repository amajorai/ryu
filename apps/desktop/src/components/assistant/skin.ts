/**
 * The Ask Ryu surfaces (launcher eyes, floating window, docked sidebar) wear a
 * "Siri glass" vertical gradient that fades toward transparent, a hairline ring,
 * and a heavy backdrop blur — the same shape as the island's `TRANSLUCENT_SKIN` /
 * `SHAPE_BASE` (apps/island/src/renderer/components/Island.tsx).
 *
 * Unlike the island (which is always dark), the desktop surfaces **follow the
 * app theme**: a light glass in light mode, the near-black glass in dark mode.
 * The gradient shape is preserved in both — only the palette flips via the
 * class-based `dark:` variant (keyed off the `.dark` class on
 * `<html>`; see globals.css `@custom-variant dark`). Because the surfaces track
 * the theme, their content no longer needs to be re-scoped to dark tokens — the
 * shadcn tokens already resolve to the active theme.
 */

/** The themed glass gradient fill + text. Use as the surface background. */
export const ISLAND_FILL =
	"bg-gradient-to-b from-white/85 via-white/65 to-neutral-100/35 text-neutral-900 dark:from-neutral-950/85 dark:via-neutral-950/65 dark:to-neutral-900/35 dark:text-neutral-100";

/** The glass chrome: hairline ring (themed), backdrop blur, drop shadow. */
export const ISLAND_CHROME =
	"ring-1 ring-black/10 shadow-2xl backdrop-blur-2xl dark:ring-white/10";

/** Wrap surface content in this. Content follows the app theme (no forced dark). */
export const ASSISTANT_SURFACE_CONTENT = "flex h-full w-full flex-col";
