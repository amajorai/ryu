/**
 * The Ask Ryu surface: the host's popover token at 95% with a light backdrop blur,
 * a hairline `ring-border`, and the floating-layer shadow the Dialog primitive
 * uses. Desktop's launcher, floating window, and every public-site widget wear
 * these exact classes so the assistant reads as one surface everywhere.
 *
 * Every colour is a theme token, so the surface follows the host's resolved theme
 * (its `.dark` class and token values) with no gradient or raw palette colour.
 * Under `prefers-reduced-transparency` the fill turns solid and the blur drops.
 */

/** Surface fill and text colour. Use as the surface background. */
export const ASSISTANT_GLASS_FILL =
	"bg-popover/95 text-popover-foreground [@media(prefers-reduced-transparency:reduce)]:bg-popover";

/** Surface chrome: hairline ring, backdrop blur, and the floating shadow. */
export const ASSISTANT_GLASS_CHROME =
	"shadow-xl ring-1 ring-border backdrop-blur-xl [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none";

/**
 * Public-site launchers sit in a very high stacking layer so host page chrome cannot
 * cover them. Popovers portal to `<body>`, outside that layer, so they sit one step
 * above it.
 */
export const ASSISTANT_POPUP_LAYER = "z-[1000000002]";

/**
 * The closed launcher wears the Island's logo circle rather than the panel glass:
 * the same hairline ring, floating shadow and heavy blur as the Island's
 * Translucent skin (`apps/island/.../island-shell-geometry.ts`), around a
 * Liquid Glass body. Token colours only, so it follows light and dark.
 */
export const ASSISTANT_ISLAND_LAUNCHER_SKIN =
	"isolate overflow-hidden text-foreground shadow-2xl ring-1 ring-border backdrop-blur-2xl [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none";

/** The Island's Translucent scrim: a popover tint, solid under reduced transparency. */
export const ASSISTANT_ISLAND_LAUNCHER_SCRIM =
	"bg-popover/85 bg-none! [@media(prefers-reduced-transparency:reduce)]:bg-popover";
