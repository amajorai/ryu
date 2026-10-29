/**
 * The Ask Ryu glass: a vertical gradient that fades toward transparent, a hairline
 * ring, and a heavy backdrop blur, matching the island's translucent skin. Desktop's
 * launcher, floating window, and every public-site widget wear these exact classes so
 * the assistant reads as one surface everywhere.
 *
 * The palette follows the host theme through the class-based `dark:` variant: light
 * glass in light mode, near-black glass in dark mode. Content inside keeps using the
 * host's shadcn tokens, so nothing needs re-scoping to a forced theme.
 */

/** Glass gradient fill and text colour. Use as the surface background. */
export const ASSISTANT_GLASS_FILL =
	"bg-gradient-to-b from-white/85 via-white/65 to-neutral-100/35 text-neutral-900 dark:from-neutral-950/85 dark:via-neutral-950/65 dark:to-neutral-900/35 dark:text-neutral-100";

/** Glass chrome: themed hairline ring, backdrop blur, and drop shadow. */
export const ASSISTANT_GLASS_CHROME =
	"ring-1 ring-black/10 shadow-2xl backdrop-blur-2xl dark:ring-white/10";

/**
 * Public-site launchers sit in a very high stacking layer so host page chrome cannot
 * cover them. Popovers portal to `<body>`, outside that layer, so they sit one step
 * above it.
 */
export const ASSISTANT_POPUP_LAYER = "z-[1000000002]";
