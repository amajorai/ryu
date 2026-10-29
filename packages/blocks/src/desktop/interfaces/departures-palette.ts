/**
 * Departures board art. The board is a split-flap display, so it gets its own
 * small palette, but every color is mixed from the user's theme tokens: the
 * board is the theme's ink, tinted with a tenth of its primary and deepened
 * toward black (a charcoal under a light theme, a well below the page under a
 * dark one), the characters are
 * the theme's paper, and the status lamps take the theme's success, warning,
 * and destructive signals, lifted toward the ink so they read on the board.
 *
 * The values are custom properties set by class (so `dark:` can swap them)
 * and read through Tailwind's `(--var)` shorthand. Chrome around the board
 * never uses them; it uses the theme's semantic tokens directly.
 *
 * Mixes are in OKLab so neutrals stay neutral.
 */
export const BOARD_PALETTE = [
	// The theme's hue: a tenth of its primary, so Nord reads slate-blue and a
	// green theme green-black, while the lightness (and contrast) is unchanged.
	"[--dep-hue:color-mix(in_oklab,var(--foreground)_90%,var(--primary))]",
	// Board, light themes: the tinted ink set to one charcoal lightness, so
	// every light theme gets a display set into the page (not a black hole in
	// it) with the same contrast against the characters.
	"[--dep-board:oklch(from_var(--dep-hue)_0.27_c_h)]",
	"[--dep-ink:color-mix(in_oklab,var(--background)_90%,white)]",
	// Board, dark themes: the page taken further down, tinted the same way.
	"dark:[--dep-hue:color-mix(in_oklab,var(--background)_90%,var(--primary))]",
	"dark:[--dep-board:color-mix(in_oklab,var(--dep-hue)_62%,black)]",
	"dark:[--dep-ink:color-mix(in_oklab,var(--foreground)_88%,white)]",
	// Derived from the two above.
	"[--dep-ink-dim:color-mix(in_oklab,var(--dep-ink)_62%,var(--dep-board))]",
	"[--dep-ink-faint:color-mix(in_oklab,var(--dep-ink)_38%,var(--dep-board))]",
	"[--dep-rule:color-mix(in_oklab,var(--dep-ink)_11%,var(--dep-board))]",
	"[--dep-row-alt:color-mix(in_oklab,var(--dep-ink)_3%,var(--dep-board))]",
	"[--dep-row-hover:color-mix(in_oklab,var(--dep-ink)_7%,var(--dep-board))]",
	"[--dep-row-active:color-mix(in_oklab,var(--dep-ink)_10%,var(--dep-board))]",
	// A flap: lit a touch on its upper leaf, shaded on its lower one.
	"[--dep-tile-top:color-mix(in_oklab,var(--dep-ink)_17%,var(--dep-board))]",
	"[--dep-tile-bottom:color-mix(in_oklab,var(--dep-ink)_13%,var(--dep-board))]",
	// The hinge sits between the two leaves' shades, nearer the board, so it
	// reads as a seam without striking through the characters.
	"[--dep-tile-seam:color-mix(in_oklab,var(--dep-board)_45%,var(--dep-tile-bottom))]",
	// Keyboard position on the board: the board's own ink, clearly visible.
	"[--dep-focus:color-mix(in_oklab,var(--dep-ink)_68%,var(--dep-board))]",
	// Lamps and status words.
	"[--dep-go:color-mix(in_oklab,var(--success)_80%,var(--dep-ink))]",
	"[--dep-hold:color-mix(in_oklab,var(--warning)_86%,var(--dep-ink))]",
	"[--dep-alert:color-mix(in_oklab,var(--destructive)_78%,var(--dep-ink))]",
	"[--dep-edge:color-mix(in_oklab,var(--foreground)_14%,transparent)]",
].join(" ");
