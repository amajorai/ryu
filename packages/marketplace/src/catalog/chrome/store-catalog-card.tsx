// packages/marketplace/src/catalog/chrome/store-catalog-card.tsx
//
// The one card every Store catalog list renders: borderless, no background at
// rest (just a hover/selected wash), a muted-background icon on the left, the
// name + a one-line description beside it, and the lifecycle action on the right.
// Shared so Apps, Plugins, Models, Skills, MCP, and Agents look identical.
//
// The row is NOT a single <button> (that would nest the action button inside it).
// It is a positioned container with a STRETCHED, transparent click target
// (`absolute inset-0`) as its first child, and every interactive control — the
// heart, the lifecycle action — painted above it with `relative z-10`.
//
// That shape is what lets the heart sit BESIDE THE TITLE. The title lives in the
// text column, so an inline heart inside the old icon+text <button> would have
// been a <button> inside a <button>: invalid HTML that browsers "repair" by
// dropping the inner one, so the control simply vanishes with no type error and
// no failing build. The overlay dissolves the nesting entirely — nothing is
// inside the click target, everything is on top of it.
//
// The stretched target is an <a href> when the surface has a real destination
// (the web store's crawlable /marketplace/... and /store/... detail routes) and a
// <button> when the click only opens an in-app preview panel (the desktop). Do
// not collapse the anchor branch into an onClick: the web marketplace's item
// links are its SEO surface.
//
// The card carries the MINIMUM that distinguishes one listing from another: icon,
// name, one-line description, and a stability badge when the listing is unfinished.
// The platform-surface badges used to sit here too and were the one thing that made
// a two-column grid of rows look busy — six chips under every app, mostly identical.
// They now live in the preview's stat strip (`ListingStatStrip`), which is where the
// rest of the "will this work for me?" metadata already is.
//
// The icon square is NOT rendered here: it is `AppIcon`, the one component every
// surface that shows an app uses. This file used to carry its own copy of that
// square AND its own copy of the untrusted-dither validator, which is how it drifted
// out from under the legibility rule the shared code already enforced — the copy
// here painted a hardcoded white glyph on any valid dither, and every packaged
// manifest now declares a wash that DISSOLVES to transparent, so on a light theme
// the far end of the square is nearly white and the glyph vanished on it. One
// component means a surface cannot ship without that branch again.

import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { MarketplaceAccessBadge } from "@ryu/ui/components/marketplace-access-badge.tsx";
import { UNAVAILABLE_ROW_CLASS } from "@ryu/ui/components/status-badge.tsx";
import type { VerificationDetails } from "@ryu/ui/components/verification-popover.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { PublisherTrustLevel } from "@ryuhq/protocol/publisher-trust";
import { createContext, type ReactNode, useContext } from "react";
import ItemLikeButton from "../../likes/like-button.tsx";
import type { MarketplaceCommunityStats } from "../bundle-types.ts";
import { stabilityLabel } from "../stability.ts";
import {
	type CardDither,
	type CardThemePreview,
	type CatalogLayer,
	catalogLayerBadges,
} from "../types.ts";
import AppIcon from "./app-icon.tsx";
import VerifiedBadge from "./verified-badge.tsx";

export interface StoreCardLinkProps {
	ariaLabel: string;
	className: string;
	href: string;
	onClick?: () => void;
}

export type StoreCardLinkRenderer = (props: StoreCardLinkProps) => ReactNode;

const StoreCardLinkContext = createContext<StoreCardLinkRenderer | null>(null);

/** Let a host preserve its router semantics without making this package import
 * a framework-specific Link component. The web host supplies Next Link so its
 * card anchors participate in intercepting routes; desktop falls back to the
 * plain anchor below. */
export function StoreCardLinkProvider({
	children,
	renderLink,
}: {
	children: ReactNode;
	renderLink: StoreCardLinkRenderer;
}) {
	return (
		<StoreCardLinkContext.Provider value={renderLink}>
			{children}
		</StoreCardLinkContext.Provider>
	);
}

export default function StoreCatalogCard({
	cacheKey,
	brandIcon,
	iconId,
	iconUrl,
	iconBackground,
	iconPadding,
	dither,
	themePreview,
	name,
	seedId,
	seedPlate,
	description,
	bundleMemberCount,
	communityStats,
	publisher,
	external = false,
	layers,
	stability,
	orgVerified,
	orgVerifiedTier,
	publisherTrust,
	publisherVerification,
	membershipEntitled = false,
	membershipIncluded = false,
	selected = false,
	dimmed = false,
	href,
	onClick,
	action,
	contextMenu,
	likeNamespace,
	likeSeed,
}: {
	/** Persist this card's icon bytes under `<id>@<version>` (see `iconCacheKey`),
	 *  so it paints offline and re-fetches only when the app updates. Set it for
	 *  INSTALLED items; leave it unset when browsing a catalog, where a listing has
	 *  no installed version to key on and the cache would fill with art for items
	 *  the user only scrolled past. */
	cacheKey?: string | null;
	/** Legacy fallback glyph. Accepted so the ~15 call sites that pass one keep
	 *  compiling, but NOT rendered: an item with no `iconId`/`iconUrl`/`brandIcon`
	 *  gets the generative tile seeded from its id, which is specific to the item
	 *  where a generic glyph is not. It has never rendered — the old inline square
	 *  reached for it only in the branch where the avatar already won. Optional now
	 *  rather than required, so a new call site is not made to hand over a node that
	 *  goes nowhere; the existing callers that pass one still compile. */
	icon?: ReactNode;
	/** A ready-made brand-mark node (e.g. `AgentCatalogLogo`, themed + its own
	 *  fallback). Wins over the generative dither avatar the way `iconId`/`iconUrl`
	 *  do, so a card with a real logo shows it instead of a placeholder tile. */
	brandIcon?: ReactNode;
	/** An Icon-primitive id (Iconify `prefix:name`, bare Hugeicons name). Wins over
	 *  `iconUrl` and `icon`; painted with the current text colour. */
	iconId?: string | null;
	/** A resolvable icon image (Iconify/icons0.dev/remote logo). Wins over `icon`. */
	iconUrl?: string | null;
	/** Optional CSS background for the icon square (e.g. a solid/gradient colour). */
	iconBackground?: string;
	/** The listing's declared inset for its logo (manifest `iconPadding`). */
	iconPadding?: string | null;
	/** Optional dithered-gradient background for the icon square. Validated before
	 *  paint; a malformed spec is ignored and the flat/`img` path is used. Wins over
	 *  `iconBackground` when valid. */
	dither?: CardDither | null;
	/** A theme listing's own palette. Painted as the icon square (bg/surface/primary
	 *  bars) instead of a dither avatar when the item ships no art — the same swatch
	 *  the Appearance tab's preset picker shows. */
	themePreview?: CardThemePreview | null;
	name: string;
	/** Stable seed for the placeholder dither avatar — the item's unique id
	 *  (`namespace/name`, a model/skill id, …) when available, else the name. */
	seedId?: string | null;
	/** Paint the seeded generative tile behind the item's art when it declares no
	 *  plate of its own. Set on community listings, whose repos rarely declare a
	 *  wash — see {@link AppIcon.seedPlate}. */
	seedPlate?: boolean;
	description?: string | null;
	/** Optional publisher identity/action row, supplied by the host surface. */
	publisher?: ReactNode;
	/** Number of child listings for a bundle. */
	bundleMemberCount?: number;
	/** Anonymous community totals; no identity or content is included. */
	communityStats?: MarketplaceCommunityStats | null;
	/** Mark a hosted provider and its public swappable capability layers. */
	external?: boolean;
	layers?: CatalogLayer[] | null;
	/** How finished this listing is ("alpha", "beta", …). Absent/stable renders
	 *  nothing — a finished listing must not sprout a badge. */
	stability?: string | null;
	/** The PUBLISHING ORGANIZATION is identity-verified — the blue check beside the
	 *  name. One of THREE separate axes, never to be merged: `reviewed` is "did Ryu
	 *  vet this listing's CODE" (the amber "Not reviewed by Ryu" notice),
	 *  `verification` is "did the manifest SIGNATURE verify" (install trust, and
	 *  the field that owns the bare word `verified` on the web marketplace's wire),
	 *  and this is "do we know who published it". A verified org can publish an
	 *  unreviewed listing and both signals then render together. Optional and
	 *  absent-renders-nothing, because ~15 out-of-package call sites build this
	 *  card and only the ones whose feed carries the flag pass it. */
	orgVerified?: boolean;
	/** The org's verification tier, used only as a qualifier in the badge's label.
	 *  Camel-cased like every other prop even though the card payload spells it
	 *  `org_verified_tier` — props are camelCase regardless of the wire's casing. */
	orgVerifiedTier?: string | null;
	/** Complete publisher identity mark. When present, dotted is rendered as an
	 * intentional community disclosure rather than hidden. */
	publisherTrust?: PublisherTrustLevel | null;
	/** Public evidence behind the publisher mark, when the catalog provides it. */
	publisherVerification?: VerificationDetails | null;
	/** The listing is covered by the A Major Pass eligibility pool. */
	membershipIncluded?: boolean;
	/** The signed-in viewer already has pass-equivalent access. */
	membershipEntitled?: boolean;
	selected?: boolean;
	/** Dim the whole row — the listing exists but cannot be installed here (wrong
	 *  platform, unmet requirement).
	 *
	 *  Dimmed, never HIDDEN. Dropping the row answers "why can I not find X?" with
	 *  silence, and the platform-support answer is exactly what the user is looking
	 *  for; the reason itself rides the row's status glyph in `action`.
	 *
	 *  A boolean rather than a `className` passthrough on purpose: three card
	 *  components dim for this reason and they must dim by the same amount, so the
	 *  value lives once in `UNAVAILABLE_ROW_CLASS`. There is also no `className`
	 *  prop here to widen — the row's geometry is the component's, not a caller's.
	 *
	 *  It does NOT gate pointer events: an unavailable listing is still worth
	 *  opening to read why. */
	dimmed?: boolean;
	/** The listing's NAMESPACE (`@ryu/crm`, `owner/repo`) — its public scoped id.
	 *  Set it to give the row the heart control. Deliberately a separate prop from
	 *  `seedId` (which only seeds the generative avatar) and NOT derived from any
	 *  internal row id: likes are keyed on the namespace so a community/GitHub
	 *  listing, which has no marketplace document at all, is likeable too.
	 *
	 *  Omitted ⇒ no heart, which is why the ~8 call sites that browse installed
	 *  rows rather than listings are unchanged. */
	likeNamespace?: string | null;
	/** `likeCount` / `likedByMe` off the LIST response, when the surface's feed
	 *  carries them. Seeding is what stops a grid flashing unliked→liked; a feed
	 *  without them (the desktop's Core-adapter catalog) omits this and the shared
	 *  provider resolves the page in one batched request instead. */
	likeSeed?: { count: number; liked?: boolean | null } | null;
	/** A real destination for the row. Set it and the stretched click target is an
	 *  <a href>, which is what keeps the web store's listings crawlable — the web
	 *  cards this replaced were anchors, and swapping them for JS navigation would
	 *  have stripped every item link off /marketplace. Unset (the desktop, whose
	 *  click opens an in-process preview panel) and the target is a <button>. */
	href?: string | null;
	/** Fires on activation. Required when there is no {@link href}; alongside one it
	 *  is an extra side effect (analytics, tab state) and must not preventDefault. */
	onClick?: () => void;
	/** The right-hand lifecycle control (see {@link StoreItemAction}). */
	action?: ReactNode;
	/** Optional right-click context menu content for the card. */
	contextMenu?: ReactNode;
}) {
	const renderLink = useContext(StoreCardLinkContext);
	const layerBadges = catalogLayerBadges(layers, external);
	// The stretched, transparent click target. First child so every control that
	// follows paints over it, and `absolute inset-0` so the WHOLE row is the hit
	// area — the icon, the name and the description are all inert (their column
	// carries `pointer-events-none`) and the click lands here instead.
	const linkProps = href
		? {
				ariaLabel: name,
				className:
					"absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				href,
				onClick,
			}
		: null;
	const target = linkProps ? (
		(renderLink?.(linkProps) ?? (
			// biome-ignore lint/a11y/useAnchorContent: the row's visible text is the
			// accessible content; the overlay carries it as an aria-label so a screen
			// reader announces one link, not a link plus a duplicate text node.
			<a
				aria-label={linkProps.ariaLabel}
				className={linkProps.className}
				href={linkProps.href}
				onClick={linkProps.onClick}
			/>
		))
	) : (
		<button
			aria-label={name}
			className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			onClick={onClick}
			type="button"
		/>
	);

	const card = (
		<div
			className={cn(
				"group relative flex items-center gap-3 rounded-xl py-2.5 pr-2 pl-2.5 transition-colors",
				selected ? "bg-accent" : "hover:bg-accent/50",
				dimmed && UNAVAILABLE_ROW_CLASS
			)}
		>
			{target}
			{/* `brandIcon` is the ONLY node forwarded as AppIcon's `fallback`: it is a
			    real logo, so it must suppress the generative tile the way an
			    `iconId`/`iconUrl` does. The legacy `icon` prop is deliberately not
			    forwarded — it never rendered here either (the generative avatar
			    always won that branch), and honouring it now would swap a tile
			    specific to the app for a generic glyph on every art-less listing. */}
			<AppIcon
				cacheKey={cacheKey}
				className="pointer-events-none size-10 shrink-0"
				dither={dither}
				fallback={brandIcon}
				iconBackground={iconBackground}
				iconId={iconId}
				iconPadding={iconPadding}
				iconUrl={iconUrl}
				name={name}
				seedId={seedId}
				seedPlate={seedPlate}
				themePreview={themePreview}
			/>
			<span className="pointer-events-none min-w-0 flex-1">
				<span className="flex items-center gap-1.5">
					<span className="min-w-0 flex-1 truncate font-medium text-sm">
						{name}
					</span>
					{/* Beside the NAME, not on the icon: the icon is the app's own
					    identity, the check is a claim about who published it. `shrink-0`
					    so a long name truncates and the badge survives. */}
					<VerifiedBadge
						orgVerified={orgVerified}
						publisherTrust={publisherTrust}
						tier={orgVerifiedTier}
						verificationDetails={publisherVerification}
					/>
					<MarketplaceAccessBadge
						membershipEntitled={membershipEntitled}
						membershipIncluded={membershipIncluded}
					/>
					{stabilityLabel(stability) ? (
						<span className="shrink-0 rounded-sm border border-amber-500/40 px-1 py-px text-[10px] text-amber-600 leading-tight">
							{stabilityLabel(stability)}
						</span>
					) : null}
					{layerBadges.slice(0, 2).map((label, index) => (
						<span
							className="shrink-0 rounded-sm border border-border/70 px-1 py-px text-[10px] text-muted-foreground leading-tight"
							key={`${label}-${index}`}
						>
							{label}
						</span>
					))}
					{/* The heart rides WITH THE TITLE, not out in the right-hand cluster:
					    a like is a statement about this listing, so it belongs against
					    the listing's name, and the right edge is reserved for the one
					    thing the user came to do (Add / the lifecycle menu). It needs
					    `pointer-events-auto` to opt back out of the inert text column,
					    and `relative z-10` to sit above the stretched target. */}
					{likeNamespace ? (
						<ItemLikeButton
							className="pointer-events-auto relative z-10 shrink-0"
							namespace={likeNamespace}
							seed={likeSeed}
						/>
					) : null}
				</span>
				{publisher ? (
					<span className="pointer-events-auto relative z-10 mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
						{publisher}
					</span>
				) : null}
				<span className="block truncate text-muted-foreground text-xs">
					{description || "No description provided."}
				</span>
				{bundleMemberCount ? (
					<span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
						Bundle · {bundleMemberCount} items · one-click install
					</span>
				) : null}
				{communityStats &&
				(communityStats.downloads > 0 || communityStats.runs > 0) ? (
					<span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
						Community · {formatCount(communityStats.downloads)} installs ·{" "}
						{formatCount(communityStats.runs)} runs
					</span>
				) : null}
			</span>
			{action ? <div className="relative z-10 shrink-0">{action}</div> : null}
		</div>
	);

	if (!contextMenu) {
		return card;
	}

	return (
		<ContextMenu>
			<ContextMenuTrigger render={card} />
			<ContextMenuContent align="end">{contextMenu}</ContextMenuContent>
		</ContextMenu>
	);
}
