import type { VerificationDetails } from "@ryu/ui/components/verification-popover.tsx";
import type { PublisherTrustLevel } from "@ryuhq/protocol/publisher-trust";
import type { ReactNode } from "react";
import type { MarketplaceCommunityStats } from "../bundle-types.ts";
import type { CardDither, CardThemePreview, CatalogLayer } from "../types.ts";

/** Props of {@link StoreCatalogCard}, the one card every Store catalog list renders. */
export interface StoreCatalogCardProps {
	/** The right-hand lifecycle control (see {@link StoreItemAction}). */
	action?: ReactNode;
	/** A ready-made brand-mark node (e.g. `AgentCatalogLogo`, themed + its own
	 *  fallback). Wins over the generative dither avatar the way `iconId`/`iconUrl`
	 *  do, so a card with a real logo shows it instead of a placeholder tile. */
	brandIcon?: ReactNode;
	/** Number of child listings for a bundle. */
	bundleMemberCount?: number;
	/** Persist this card's icon bytes under `<id>@<version>` (see `iconCacheKey`),
	 *  so it paints offline and re-fetches only when the app updates. Set it for
	 *  INSTALLED items; leave it unset when browsing a catalog, where a listing has
	 *  no installed version to key on and the cache would fill with art for items
	 *  the user only scrolled past. */
	cacheKey?: string | null;
	/** The published listing remains community-published until Ryu reviews it. */
	communityApp?: boolean;
	/** Anonymous community totals; no identity or content is included. */
	communityStats?: MarketplaceCommunityStats | null;
	/** Optional right-click context menu content for the card. */
	contextMenu?: ReactNode;
	/** "catalog" is the calm public-web grid: every card has the same height, a
	 *  one-line title, a two-line description and at most ONE chip, chosen by
	 *  priority (deprecated, then community app, then the publisher check). The
	 *  heart, layer chips, access badge, bundle line and community stats are left
	 *  to the detail page. Unset (the desktop) renders exactly as before. */
	density?: "catalog";
	/** The listing's manifest marks it deprecated. Renders a "Deprecated" badge;
	 *  the reason lives on the detail page. */
	deprecated?: boolean;
	description?: string | null;
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
	/** Optional dithered-gradient background for the icon square. Validated before
	 *  paint; a malformed spec is ignored and the flat/`img` path is used. Wins over
	 *  `iconBackground` when valid. */
	dither?: CardDither | null;
	/** Mark a hosted provider and its public swappable capability layers. */
	external?: boolean;
	/** A real destination for the row. Set it and the stretched click target is an
	 *  <a href>, which is what keeps the web store's listings crawlable — the web
	 *  cards this replaced were anchors, and swapping them for JS navigation would
	 *  have stripped every item link off /marketplace. Unset (the desktop, whose
	 *  click opens an in-process preview panel) and the target is a <button>. */
	href?: string | null;
	/** Legacy fallback glyph. Accepted so the ~15 call sites that pass one keep
	 *  compiling, but NOT rendered: an item with no `iconId`/`iconUrl`/`brandIcon`
	 *  gets the generative tile seeded from its id, which is specific to the item
	 *  where a generic glyph is not. It has never rendered — the old inline square
	 *  reached for it only in the branch where the avatar already won. Optional now
	 *  rather than required, so a new call site is not made to hand over a node that
	 *  goes nowhere; the existing callers that pass one still compile. */
	icon?: ReactNode;
	iconAppearance?: "bare" | "monochrome";
	/** Optional CSS background for the icon square (e.g. a solid/gradient colour). */
	iconBackground?: string;
	/** An Icon-primitive id (Iconify `prefix:name`, bare Hugeicons name). Wins over
	 *  `iconUrl` and `icon`; painted with the current text colour. */
	iconId?: string | null;
	/** The listing's declared inset for its logo (manifest `iconPadding`). */
	iconPadding?: string | null;
	/** A resolvable icon image (Iconify/icons0.dev/remote logo). Wins over `icon`. */
	iconUrl?: string | null;
	iconUrlDark?: string | null;
	layers?: CatalogLayer[] | null;
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
	/** The signed-in viewer already has pass-equivalent access. */
	membershipEntitled?: boolean;
	/** The listing is covered by the A Major Pass eligibility pool. */
	membershipIncluded?: boolean;
	name: string;
	/** Fires on activation. Required when there is no {@link href}; alongside one it
	 *  is an extra side effect (analytics, tab state) and must not preventDefault. */
	onClick?: () => void;
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
	/** Optional publisher identity/action row, supplied by the host surface. */
	publisher?: ReactNode;
	/** Complete publisher identity mark. When present, dotted is rendered as an
	 * intentional community disclosure rather than hidden. */
	publisherTrust?: PublisherTrustLevel | null;
	/** Public evidence behind the publisher mark, when the catalog provides it. */
	publisherVerification?: VerificationDetails | null;
	/** Ryu's human code review of an app listing; independent of org identity. */
	reviewed?: boolean;
	/** Stable seed for the placeholder dither avatar — the item's unique id
	 *  (`namespace/name`, a model/skill id, …) when available, else the name. */
	seedId?: string | null;
	/** Paint the seeded generative tile behind the item's art when it declares no
	 *  plate of its own. Set on community listings, whose repos rarely declare a
	 *  wash — see {@link AppIcon.seedPlate}. */
	seedPlate?: boolean;
	selected?: boolean;
	/** How finished this listing is ("alpha", "beta", …). Absent/stable renders
	 *  nothing — a finished listing must not sprout a badge. */
	stability?: string | null;
	/** A theme listing's own palette. Painted as the icon square (bg/surface/primary
	 *  bars) instead of a dither avatar when the item ships no art — the same swatch
	 *  the Appearance tab's preset picker shows. */
	themePreview?: CardThemePreview | null;
}
