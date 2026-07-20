/**
 * Which page routes let their content scroll UNDER the frosted, transparent
 * titlebar (as opposed to reserving the bar's height and sitting below a solid
 * bar). Chat has always done this; the Store shell (all of its section routes)
 * and the Library join it so those pages read as one continuous glass surface
 * too.
 *
 * The Store's section pills switch in-place (the route stays fixed), so this
 * must list EVERY route that renders `StorePage` — otherwise a section opened as
 * its own tab (Plugins → `/apps`, Models → `/models`, …) would fall back to
 * the solid bar while `/engines` scrolls under, which is exactly the
 * inconsistency this list prevents. Keep it in sync with the `StorePage`
 * branches in `Layout.tsx`.
 *
 * Shared by {@link ../TitleBar} (picks the transparent `ProgressiveBlur` bar
 * over the solid one) and {@link ../Layout} (omits the `pt-12` top clearance so
 * the page starts at the true top, under the bar). Keep the two in lock-step by
 * routing both through this single predicate.
 */
const SCROLL_UNDER_TITLEBAR_PREFIXES = [
	"/chat",
	// Tasks (Quests) — content scrolls under the bar; its add-task composer +
	// detection settings live in a floating bottom toolbar (like chat / the Store).
	"/quests",
	// Library shell
	"/library",
	// Store shell — every route that renders StorePage (see Layout.tsx)
	"/store",
	"/marketplace",
	"/engines",
	"/models",
	"/skills",
	"/apps",
	"/extensions",
	"/fleet",
] as const;

export function pathScrollsUnderTitlebar(path: string): boolean {
	return SCROLL_UNDER_TITLEBAR_PREFIXES.some((prefix) =>
		path.startsWith(prefix)
	);
}
