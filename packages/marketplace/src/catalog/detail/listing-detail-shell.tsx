// packages/marketplace/src/catalog/detail/listing-detail-shell.tsx
//
// THE store listing preview. One layout, every realm, both hosts.
//
// The shape is the one every app store converged on, top to bottom:
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ HERO — full-bleed wash, icon tile, name + CTA on one row     │
//   ├──────────────────────────────────────────────────────────────┤
//   │ STAT STRIP — cells: rating · version · category · …          │
//   ├──────────────────────────────────────────────────────────────┤
//   │ GALLERY — screenshot rail (only when the listing ships one)  │
//   ├───────────────────────────────┬──────────────────────────────┤
//   │ MAIN — description, tabs      │ ASIDE — Information, links   │
//   └───────────────────────────────┴──────────────────────────────┘
//
// THE CTA LIVES IN THE HERO. It used to sit on its own solid band below, on the
// stated reasoning that a button on a saturated dither "loses its own surface
// colour". That is true of a bare button and false of the arrangement here: the
// hero already paints a bottom-weighted scrim for the title, the CTA rides the
// same baseline as the title inside it, and a real Button keeps its own fill on
// top of both. What the separate band actually cost was a whole strip of chrome
// between the listing's identity and the one thing the user opened the dialog to
// do — and, on a short listing, it was the widest empty row on the page.
//
// NO BORDERS INSIDE. Every panel below the hero is a `bg-muted` plate on the
// dialog's background, never an outlined box: at this density a dialog of
// bordered cards inside a bordered dialog reads as a form, and the borders were
// doing no work the fill does not already do.
//
// WHY A SHELL AND NOT TEN PANELS. Every realm grew its own detail body, and each
// one was authored for the 26rem side pane that `StoreCatalogLayout` used to open
// (`previewMode: "auto"`). That pane is unreachable — no caller passes the prop —
// so all ten now render as a centred modal, and a single 416px-wide column of
// stacked sections in a 1200px dialog is what "it feels so narrow" describes: the
// dialog was wide, the content never widened with it. Ten panels each inventing a
// wide layout would diverge again within a release, so the layout lives here once
// and each realm supplies only its own content.
//
// TWO COLUMNS, VIEWPORT-KEYED. `lg:` is a viewport breakpoint, not a container
// one, which is correct here rather than approximate: the dialog is
// `min(80rem,94vw)`, so it is only ever wide enough for two columns when the
// viewport itself is, and the two thresholds move together.
//
// NO HORIZONTAL SCROLL. A wide dialog must never scroll the page sideways — the
// gallery rail and the stat strip carry their own `overflow-x-auto` so a long
// screenshot set or a nine-cell strip scrolls INSIDE its band.

import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import AppIcon from "../chrome/app-icon.tsx";
import DitherBanner from "../chrome/dither-banner.tsx";
import { safeHttpUrl } from "../safe-url.ts";
import type { CardDither, CatalogBanner } from "../types.ts";

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function ListingDetailShell({
	hero,
	actions,
	stats,
	gallery,
	notice,
	aside,
	children,
}: {
	/** {@link ListingHero}. Omitted only by a listing with no presentation at all. */
	hero?: ReactNode;
	/** Secondary controls that did not fit the hero's CTA row.
	 *
	 *  The PRIMARY install/enable/open control belongs in the hero itself
	 *  ({@link ListingHero.actions}) — it is the reason the dialog is open, so it
	 *  sits with the listing's name, not on a strip below it. This slot is the
	 *  overflow: a channel picker, a long grant summary, anything that would turn
	 *  the title row into a toolbar. It renders on a solid band and, when a
	 *  listing has nothing of the sort, renders nothing at all. */
	actions?: ReactNode;
	/** {@link ListingStatStrip}. */
	stats?: ReactNode;
	/** {@link ListingGalleryRail}. */
	gallery?: ReactNode;
	/** Full-width callout ahead of the fold — the community-trust notice. Placed
	 *  above the action bar so it is unavoidable BEFORE any install control. */
	notice?: ReactNode;
	/** The right rail: Information, external links, anything reference-shaped. */
	aside?: ReactNode;
	/** The main column: description, permissions, the tab set. */
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col">
			{hero}
			{notice ? <div className="px-5 pt-4 lg:px-7">{notice}</div> : null}
			{actions ? (
				<div className="flex flex-wrap items-center gap-2 px-5 py-3 lg:px-7">
					{actions}
				</div>
			) : null}
			{stats}
			<div className="flex flex-col gap-6 px-5 py-6 lg:px-7">
				{gallery}
				<div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-10">
					<div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
					{aside ? (
						<aside className="flex w-full shrink-0 flex-col gap-4 lg:w-72 xl:w-80">
							{aside}
						</aside>
					) : null}
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

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
	iconUrl,
	seedId,
	banner,
	dither,
	iconBackground,
	fallback,
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
	/** Raster logo URL — the manifest's `iconUrl`, straight through. */
	iconUrl?: string | null;
	/** Stable seed for the generative tile: ALWAYS the item's unique id, so the
	 *  hero and the card tile the same app identically. */
	seedId?: string | null;
	banner?: CatalogBanner | null;
	dither?: CardDither | null;
	iconBackground?: string | null;
	/** Flat CSS background when there is neither a banner nor a dither. */
	fallback?: string | null;
}) {
	// The tile is `AppIcon`'s `hero` variant, not a square painted here. It used to
	// be the latter, and the cost was structural rather than cosmetic: taking the
	// art as an opaque ReactNode meant every caller resolved its own icon, so 13 of
	// 15 heroes never ran the resolution rules their own cards run, and the 2 that
	// passed an `<AppIcon>` painted its tile INSIDE this one. The variant keeps the
	// treatment that made this square different — the opaque wash, the fixed white
	// glyph, the ring and the counter-direction ramp — while the resolution order,
	// the dither validation and the icon cache come from the one component.
	return (
		<div className="relative h-56 shrink-0 overflow-hidden sm:h-64">
			{/* `live` — the ONE opt-in to a WebGL context in the catalog. A hero is a
			    single band per open detail pane, which is the only place an
			    `animated-gradient` banner can animate without instances evicting each
			    other's contexts; see the tier + budget note in `dither-banner.tsx`.
			    Cards and rows call the same component without this prop and get the
			    static paint. */}
			<DitherBanner
				banner={banner}
				dither={dither}
				fallback={fallback ?? iconBackground ?? null}
				live
			/>
			{/* Scrim: the wash is author-supplied and can land anywhere on the
			    lightness range, so the title needs a floor it can read against
			    rather than relying on the colour being dark. Weighted toward the
			    BOTTOM two thirds — that is where the title, tagline and chips sit —
			    so the listing's own art still reads across the top of the band. */}
			<div
				aria-hidden="true"
				className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/45 to-transparent"
			/>
			<div className="absolute inset-0 flex items-end gap-4 p-5 lg:px-7">
				<AppIcon
					cacheKey={cacheKey}
					className="size-16 sm:size-20"
					dither={dither}
					fallback={icon}
					iconBackground={iconBackground}
					iconId={iconId}
					iconPadding={iconPadding}
					iconUrl={iconUrl}
					name={iconName}
					seedId={seedId}
					size={34}
					variant="hero"
				/>
				<div className="min-w-0 flex-1 pb-0.5">
					{/* `truncate` sits on the INNER span, not the h2: the row has to be a
					    flex line so `nameBadge` keeps its width while the title alone
					    gives way. With `truncate` on the h2 the badge was clipped along
					    with the overflowing name.

					    The CTA cluster shares this line and is `shrink-0`, so a long name
					    truncates and the button the dialog exists for never does. */}
					<div className="flex min-w-0 items-center gap-3">
						<h2 className="flex min-w-0 flex-1 items-center gap-2 font-medium text-white text-xl drop-shadow-md sm:text-2xl">
							<span className="truncate">{name}</span>
							{nameBadge}
						</h2>
						{actions ? (
							<div className="flex shrink-0 items-center gap-1.5">
								{actions}
							</div>
						) : null}
					</div>
					{tagline ? (
						<p className="line-clamp-2 text-sm text-white/85 drop-shadow sm:text-[0.9375rem]">
							{tagline}
						</p>
					) : null}
					{statusIcons || (badges && badges.length > 0) ? (
						<div className="mt-2 flex flex-wrap items-center gap-1.5">
							{statusIcons}
							{(badges ?? []).map((badge) => (
								<span
									className="rounded-full bg-white/15 px-2 py-0.5 font-medium text-[11px] text-white/90 leading-4 backdrop-blur-sm"
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

// ---------------------------------------------------------------------------
// Stat strip
// ---------------------------------------------------------------------------

export interface ListingStat {
	icon?: IconSvgElement;
	/** Tiny uppercase caption — "VERSION", "DEVELOPER", "RATING". */
	label: string;
	/** Makes the whole cell a button — the rating cell jumps to the Reviews tab,
	 *  the health cell to Health. */
	onClick?: () => void;
	/** Optional second line under the value ("Ratings", "Updated 3d ago"). */
	sub?: ReactNode;
	/** The headline value. Kept short; a long one truncates rather than reflows. */
	value: ReactNode;
}

/** The divided meta row every app store puts directly under the hero. Replaces the
 *  inline flex-wrap `DetailMetaStrip` for the detail view: at 400px those items
 *  wrapped into an unreadable ribbon, and at 1200px they were a lonely single line
 *  of grey text where the store's headline facts should be. */
export function ListingStatStrip({ items }: { items: ListingStat[] }) {
	if (items.length === 0) {
		return null;
	}
	return (
		<div className="overflow-x-auto bg-muted">
			{/* No `min-w-max`: with it the row always took its NATURAL width, so a
			    long cell ("Runs on: Desktop, Island, Mobile") pushed the strip past
			    the dialog and clipped itself even at 1600px. Each cell keeps a
			    `min-w` floor instead — they share the space when there is room, and
			    the band scrolls only once the floors no longer fit. */}
			{/* The cell dividers STAY. Dropping the strip's outer border was the point
			    (it was a box inside a box), but without the `divide-x` the row's cells
			    merge into one grey band and the strip loses the only structure that
			    made nine facts readable at a glance. */}
			<div className="flex divide-x divide-border/60">
				{items.map((stat) => {
					const body = (
						<>
							<span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
								{stat.label}
							</span>
							{/* The value gets its OWN truncating span rather than `truncate`
							    on this flex row: a bare text node inside a flex container is
							    an anonymous flex item and will not shrink below its
							    min-content width, so `truncate` on the row clipped nothing
							    and a long value ("Desktop, Island, Mobile") ran straight past
							    the dialog edge. */}
							<span className="flex w-full min-w-0 items-center justify-center gap-1 font-medium text-foreground text-sm">
								{stat.icon ? (
									<HugeiconsIcon
										className="size-3.5 shrink-0"
										icon={stat.icon}
									/>
								) : null}
								<span className="truncate">{stat.value}</span>
							</span>
							{stat.sub ? (
								<span className="truncate text-[11px] text-muted-foreground">
									{stat.sub}
								</span>
							) : null}
						</>
					);
					const className =
						"flex min-w-[7.5rem] flex-1 flex-col items-center justify-center gap-0.5 overflow-hidden px-4 py-3 text-center";
					return stat.onClick ? (
						<button
							className={cn(className, "transition-colors hover:bg-accent/60")}
							key={stat.label}
							onClick={stat.onClick}
							type="button"
						>
							{body}
						</button>
					) : (
						<div className={className} key={stat.label}>
							{body}
						</div>
					);
				})}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

/** The screenshot rail. Renders NOTHING when the listing ships no screenshots —
 *  which today is all but one packaged manifest — so a wide dialog never opens on
 *  an empty band where a gallery is implied. */
export function ListingGalleryRail({
	screenshots,
	name,
	onOpen,
}: {
	screenshots?: string[] | null;
	name: string;
	/** Opens the lightbox. Host-injected: the desktop ships one, web does not. */
	onOpen?: (index: number) => void;
}) {
	const safe = (screenshots ?? [])
		.map((url) => safeHttpUrl(url))
		.filter((url): url is string => Boolean(url));
	if (safe.length === 0) {
		return null;
	}
	return (
		<div className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-1">
			{safe.map((url, index) => {
				const frame = (
					<img
						alt={`${name} screenshot ${index + 1}`}
						className="h-48 w-auto max-w-none rounded-xl bg-muted object-cover sm:h-60"
						loading="lazy"
						src={url}
					/>
				);
				return onOpen ? (
					<button
						className="shrink-0 snap-start transition-opacity hover:opacity-90"
						key={url}
						onClick={() => onOpen(index)}
						type="button"
					>
						{frame}
					</button>
				) : (
					<span className="shrink-0 snap-start" key={url}>
						{frame}
					</span>
				);
			})}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Body pieces
// ---------------------------------------------------------------------------

/** A titled block in either column. One heading treatment for all ten realms. */
export function ListingSection({
	title,
	icon,
	action,
	children,
}: {
	title: ReactNode;
	icon?: IconSvgElement;
	/** Trailing control on the heading row (a "see all", a toggle). */
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-2">
				<h3 className="flex items-center gap-1.5 font-medium text-sm">
					{icon ? (
						<HugeiconsIcon
							className="size-4 text-muted-foreground"
							icon={icon}
						/>
					) : null}
					{title}
				</h3>
				{action}
			</div>
			{children}
		</section>
	);
}

/** A card in the right rail. Filled rather than bare so the rail reads as
 *  reference material sitting beside the main column, not as a second body.
 *
 *  The distinction is carried by the FILL (`bg-muted` on the dialog's own
 *  background), not by an outline: a bordered card inside a bordered dialog
 *  inside a bordered pane is three rectangles saying the same thing. */
export function ListingAsideCard({
	title,
	children,
}: {
	title?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="rounded-2xl bg-muted p-4">
			{title ? (
				<h3 className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wider">
					{title}
				</h3>
			) : null}
			{children}
		</div>
	);
}

export interface ListingInfoRow {
	label: string;
	value: ReactNode;
}

/** The Information table. A label/value grid rather than the old two-column flex
 *  row, so a long value (a licence name, a homepage host) wraps under its label
 *  instead of squeezing it to two characters. */
export function ListingInfoGrid({ rows }: { rows: ListingInfoRow[] }) {
	if (rows.length === 0) {
		return null;
	}
	return (
		<dl className="flex flex-col text-sm">
			{rows.map((row) => (
				<div
					className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0"
					key={row.label}
				>
					<dt className="shrink-0 text-muted-foreground text-xs">
						{row.label}
					</dt>
					<dd className="min-w-0 truncate text-right font-medium text-xs">
						{row.value}
					</dd>
				</div>
			))}
		</dl>
	);
}
