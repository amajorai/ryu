import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import visualStyles from "../../marketplace-visual.module.css";
import AppIcon from "../chrome/app-icon.tsx";
import DitherBanner from "../chrome/dither-banner.tsx";
import type { CardDither, CatalogBanner } from "../types.ts";

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

/** What the hero paints for a listing with no banner, no paintable dither, no
 *  icon background and no caller fallback. A fixed dark ramp rather than a theme
 *  token, because the copy over it is fixed white in BOTH themes: `bg-muted` (the
 *  banner's own last resort) is near-white in light theme, which put the title at
 *  roughly 2:1 contrast on every art-less listing. */
export const LISTING_HERO_NO_ART_BACKGROUND =
	"linear-gradient(160deg, oklch(0.36 0 0), oklch(0.2 0 0))";

export function ListingHero({
	name,
	nameBadge,
	actions,
	tagline,
	badges,
	statusIcons,
	cacheKey,
	icon,
	iconId,
	iconName,
	iconPadding,
	iconAppearance,
	iconUrl,
	iconUrlDark,
	seedId,
	banner,
	dither,
	iconBackground,
	fallback,
	plain = false,
	titleAs = "h2",
}: {
	name: ReactNode;
	/** The primary controls — Add/Remove, the like heart — right-aligned on the
	 *  TITLE's row, inside the hero.
	 *
	 *  They used to sit on a separate solid band under the hero. Putting them here
	 *  is not decoration: the dialog exists so the user can decide about this
	 *  listing, and the decision control belongs against the listing's name rather
	 *  than a strip of chrome further down. `items-end` on the row keeps them on
	 *  the title's baseline while the tagline and chips flow below.
	 *
	 *  They render over the hero's bottom-weighted scrim, so a real Button keeps
	 *  its own fill and does not have to fake a surface. */
	actions?: ReactNode;
	/** A small marker rendered immediately after the title — today the publisher
	 *  verification check.
	 *
	 *  It is a SEPARATE slot rather than something a caller composes into `name`
	 *  (which is a `ReactNode`, so composing type-checks) because the title span
	 *  truncates: a badge appended inside it is clipped off the end for exactly the
	 *  long names nobody tests with, and reads fine for every short one.
	 *
	 *  It is also NOT a `badges` entry: those are `string[]` chips describing the
	 *  LISTING ("Built-in", "Community", "BETA"), and a claim about the publisher
	 *  rendered among them would be read as a claim about the listing. */
	nameBadge?: ReactNode;
	tagline?: ReactNode;
	/** Kind/tag pills — "Companion", "BETA", a category, a transport. Rendered on
	 *  the wash, so they get a translucent chip treatment rather than the page's
	 *  Badge variants, which assume a neutral surface.
	 *
	 *  STATUS attributes do not belong here: see {@link statusIcons}. */
	badges?: string[];
	/** The listing's STATUS attributes (Active / Unavailable / Built-in / Default)
	 *  as `StatusBadge` glyphs, rendered at the head of the chip row.
	 *
	 *  A separate slot rather than more `badges` strings, for the same reason
	 *  `nameBadge` is separate: `badges` is `string[]`, keyed on the string, and
	 *  thirteen call sites pass legitimate prose chips through it. Widening it to
	 *  `ReactNode[]` would make every one of those a candidate for accidental
	 *  status treatment, and there would be nothing left to tell a status apart
	 *  from a category at a glance — which was the original problem. */
	statusIcons?: ReactNode;
	/** Persist the icon bytes under `<id>@<version>` — set it for anything
	 *  INSTALLED, leave it unset while browsing a catalog. Forwarded verbatim to
	 *  {@link AppIcon}. */
	cacheKey?: string | null;
	/**
	 * @deprecated Pass the icon DATA (`iconId`/`iconUrl`/`seedId`/`iconName`)
	 * instead, so the hero resolves the listing's art through the same rules as its
	 * card. Kept as an escape hatch for the callers that hand-build a REAL mark (a
	 * realm-specific logo component): a node given here renders INSIDE the hero
	 * tile, as {@link AppIcon}'s `fallback`, and therefore suppresses the
	 * generative tile the way an `iconId`/`iconUrl` does — the same role
	 * `brandIcon` plays on `StoreCatalogCard`.
	 *
	 * So do NOT migrate a generic glyph into it. A stock `BotIcon` here is worse
	 * than nothing: the card drops exactly that glyph in favour of the tile seeded
	 * from the item's id, and a hero that keeps it becomes the one surface showing
	 * a listing as a stock symbol instead of as itself.
	 *
	 * It is also not a second tile. Passing an `<AppIcon>` here stacks two of them
	 * — which is exactly what two Installed-tab heroes shipped before the `hero`
	 * variant existed.
	 */
	icon?: ReactNode;
	/** Icon-primitive id (Iconify `prefix:name`, bare Hugeicons name, `svgl:<slug>`)
	 *  — the manifest's `icon`, straight through. */
	iconId?: string | null;
	/** Display name for the icon's alt text and as its seed of last resort. A
	 *  STRING, unlike `name`, which is a ReactNode the title row may decorate. */
	iconName?: string | null;
	/** The listing's declared inset for its logo (manifest `iconPadding`). */
	iconPadding?: string | null;
	iconAppearance?: "bare" | "monochrome";
	/** Raster logo URL — the manifest's `iconUrl`, straight through. */
	iconUrl?: string | null;
	iconUrlDark?: string | null;
	/** Stable seed for the generative tile: ALWAYS the item's unique id, so the
	 *  hero and the card tile the same app identically. */
	seedId?: string | null;
	banner?: CatalogBanner | null;
	dither?: CardDither | null;
	iconBackground?: string | null;
	/** Flat CSS background when there is neither a banner nor a dither. When it
	 *  and `iconBackground` are both absent the hero paints
	 *  {@link LISTING_HERO_NO_ART_BACKGROUND}, never the theme's `bg-muted`: the
	 *  title and tagline are fixed white, and in light theme `bg-muted` is
	 *  near-white. */
	fallback?: string | null;
	/** The title's element. `h2` inside a dialog, which owns its own `h1`/title;
	 *  `h1` when the hero IS the page (the web's crawlable listing routes), so the
	 *  listing's name is that page's top-level heading. */
	titleAs?: "h1" | "h2";
	/** The public web's quiet hero: chips are solid outlines (no translucent
	 *  wash, no blur), and with no `banner` the band paints nothing generated —
	 *  the title sits on the page background in the foreground colour. Off by
	 *  default, so the desktop hero renders exactly as before. */
	plain?: boolean;
}) {
	const Title = titleAs;
	// No generated wash when there is nothing to paint: plain heroes without a
	// banner, and any listing with no banner, dither, icon background or caller
	// fallback. The dark default ramp was decoration standing in for missing art;
	// an art-less listing now sets its title on the page in theme colours.
	const artless = !(banner || dither || iconBackground || fallback);
	const bare = (plain && !banner) || artless;
	// The tile is `AppIcon`'s `hero` variant, not a square painted here. It used to
	// be the latter, and the cost was structural rather than cosmetic: taking the
	// art as an opaque ReactNode meant every caller resolved its own icon, so 13 of
	// 15 heroes never ran the resolution rules their own cards run, and the 2 that
	// passed an `<AppIcon>` painted its tile INSIDE this one. The variant keeps the
	// treatment that made this square different — the opaque wash, the fixed white
	// glyph, the ring and the counter-direction ramp — while the resolution order,
	// the dither validation and the icon cache come from the one component.
	return (
		// A MINIMUM height, with the copy in flow, rather than a fixed band with the
		// copy absolutely pinned inside it: on a phone the title row wraps (below),
		// and a fixed band would clip the top of a taller stack — the listing's name
		// first. At every width where the stack fits, the band is the same size.
		<div
			className={cn(
				"relative flex shrink-0 flex-col justify-end overflow-hidden bg-background",
				bare ? null : "min-h-56 sm:min-h-64"
			)}
		>
			{/* `live` — the ONE opt-in to a WebGL context in the catalog. A hero is a
			    single band per open detail pane, which is the only place an
			    `animated-gradient` banner can animate without instances evicting each
			    other's contexts; see the tier + budget note in `dither-banner.tsx`.
			    Cards and rows call the same component without this prop and get the
			    static paint. */}
			{bare ? null : (
				<>
					<DitherBanner
						banner={banner}
						dither={dither}
						fallback={
							fallback ?? iconBackground ?? LISTING_HERO_NO_ART_BACKGROUND
						}
						live
					/>
					{/* One ramp keeps white copy readable, then feathers the wash
					    directly into the detail body's background token at the
					    bottom edge. */}
					<div
						aria-hidden="true"
						className={cn(
							"pointer-events-none absolute inset-0",
							visualStyles.heroScrim
						)}
						data-testid="listing-hero-scrim"
					/>
				</>
			)}
			<div
				className={cn(
					"relative flex items-end gap-4",
					bare
						? plain
							? "py-2"
							: "px-5 pt-12 pb-4 lg:px-7"
						: "px-5 pt-5 pb-16 lg:px-7"
				)}
			>
				<AppIcon
					cacheKey={cacheKey}
					className="size-16 sm:size-20"
					dither={dither}
					fallback={icon}
					iconAppearance={iconAppearance}
					iconBackground={iconBackground}
					iconId={iconId}
					iconPadding={iconPadding}
					iconUrl={iconUrl}
					iconUrlDark={iconUrlDark}
					name={iconName}
					seedId={seedId}
					size={34}
					variant="hero"
				/>
				<div className="min-w-0 flex-1 pb-0.5">
					{/* `truncate` sits on the INNER span, not the heading: the row has to
					    be a flex line so `nameBadge` keeps its width while the title alone
					    gives way. With `truncate` on the heading the badge was clipped
					    along with the overflowing name.

					    From `sm` up the CTA cluster shares this line and is `shrink-0`, so
					    a long name truncates and the button the dialog exists for never
					    does. Below `sm` the heading takes the whole line and the cluster
					    wraps under it: on a 375px phone the cluster alone is ~185px of a
					    ~223px text column, which left the listing's name 2-3 characters
					    and an ellipsis. */}
					<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 sm:flex-nowrap">
						<Title
							className={cn(
								"flex min-w-0 grow basis-full items-center gap-2 font-semibold text-xl tracking-tight sm:basis-0",
								bare ? "text-foreground" : "text-white drop-shadow-md"
							)}
						>
							<span
								className="truncate"
								title={typeof name === "string" ? name : undefined}
							>
								{name}
							</span>
							{nameBadge}
						</Title>
						{actions ? (
							<div className="flex shrink-0 items-center gap-1.5">
								{actions}
							</div>
						) : null}
					</div>
					{tagline ? (
						<p
							className={cn(
								"sm:text-(length:--text-comfortable) line-clamp-2 text-sm",
								bare
									? "mt-1 text-muted-foreground"
									: "text-white/85 drop-shadow"
							)}
						>
							{tagline}
						</p>
					) : null}
					{statusIcons || (badges && badges.length > 0) ? (
						<div className="mt-2 flex flex-wrap items-center gap-1.5">
							{statusIcons}
							{(badges ?? []).map((badge) => (
								<span
									className={cn(
										"rounded-full px-2 py-0.5 text-xs",
										plainChipClass(plain, bare)
									)}
									key={badge}
								>
									{badge}
								</span>
							))}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

export function plainChipClass(plain: boolean, bare: boolean): string {
	if (bare) {
		return "border border-border text-muted-foreground";
	}
	if (plain) {
		return "border border-white/50 text-white";
	}
	return "bg-white/15 text-white/90 backdrop-blur-sm";
}
