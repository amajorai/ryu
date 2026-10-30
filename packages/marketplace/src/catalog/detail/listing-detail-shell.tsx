// packages/marketplace/src/catalog/detail/listing-detail-shell.tsx
//
// THE store listing preview. One layout, every realm, both hosts.
//
// The shape is the one every app store converged on, top to bottom:
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ HERO — full-bleed wash, icon tile, name + CTA (one row ≥ sm) │
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

import type { ReactNode } from "react";
import { ListingHero } from "./listing-hero.tsx";
import { ListingGalleryRail, ListingStatStrip } from "./listing-stat-strip.tsx";

export {
	ListingAsideCard,
	ListingInfoGrid,
	type ListingInfoRow,
	ListingSection,
} from "./listing-body.tsx";
export {
	LISTING_HERO_NO_ART_BACKGROUND,
	ListingHero,
} from "./listing-hero.tsx";
export {
	ListingGalleryRail,
	type ListingStat,
	ListingStatStrip,
} from "./listing-stat-strip.tsx";

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
