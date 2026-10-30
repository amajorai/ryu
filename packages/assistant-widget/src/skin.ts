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
