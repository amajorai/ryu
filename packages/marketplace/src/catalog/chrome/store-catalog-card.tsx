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
// name with at most one trust mark, one muted meta line, and at most one badge for
// an exceptional state (deprecated, unstable, community, membership). Layer
// chips, bundle sizes and community stats live in the detail pane.
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
import { UNAVAILABLE_ROW_CLASS } from "@ryu/ui/components/status-badge.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import ItemLikeButton from "../../likes/like-button.tsx";
import AppIcon from "./app-icon.tsx";
import { RyuReviewedBadge } from "./ryu-reviewed-badge.tsx";
import { useStoreCardLinkRenderer } from "./store-card-link.tsx";
import {
	exceptionalCardBadge,
	hasPublisherMark,
} from "./store-catalog-card-chip.tsx";
import type { StoreCatalogCardProps } from "./store-catalog-card-props.ts";
import VerifiedBadge from "./verified-badge.tsx";

export {
	type StoreCardLinkProps,
	StoreCardLinkProvider,
	type StoreCardLinkRenderer,
} from "./store-card-link.tsx";
export type { StoreCatalogCardProps } from "./store-catalog-card-props.ts";

export default function StoreCatalogCard({
	cacheKey,
	brandIcon,
	iconId,
	iconUrl,
	iconUrlDark,
	iconBackground,
	iconPadding,
	iconAppearance,
	dither,
	themePreview,
	name,
	seedId,
	seedPlate,
	description,
	publisher,
	stability,
	deprecated = false,
	orgVerified,
	orgVerifiedTier,
	reviewed,
	communityApp = false,
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
	density,
	likeNamespace,
	likeSeed,
}: StoreCatalogCardProps) {
	const renderLink = useStoreCardLinkRenderer();
	const catalog = density === "catalog";
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
			// the row's visible text is the
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

	// One trust mark beside the name: the publisher check when there is one,
	// otherwise Ryu's review mark. Never both.
	const trustMark = hasPublisherMark({ orgVerified, publisherTrust }) ? (
		<VerifiedBadge
			orgVerified={orgVerified}
			publisherTrust={publisherTrust}
			tier={orgVerifiedTier}
			verificationDetails={publisherVerification}
		/>
	) : (
		<RyuReviewedBadge reviewed={reviewed} />
	);
	// At most one exceptional badge. Layer chips, bundle sizes and community
	// stats live in the detail pane, not on the row.
	const exceptional = exceptionalCardBadge({
		communityApp,
		deprecated,
		membershipEntitled,
		membershipIncluded,
		stability,
	});
	// One meta line: the description, else the publisher. No filler copy. A
	// description stays inert so a click on it reaches the stretched target; a
	// publisher may be a link, so it opts back into pointer events above it.
	const meta = description || publisher;
	const metaIsPublisher = !description && Boolean(publisher);

	const card = (
		<div
			className={cn(
				"group relative flex items-center gap-3 rounded-xl p-2 transition-colors duration-(--duration-fast) hover:duration-0",
				catalog && "h-24 overflow-hidden",
				selected ? "bg-accent" : "hover:bg-accent/50",
				dimmed && UNAVAILABLE_ROW_CLASS
			)}
		>
			{target}
			{/* `brandIcon` is the ONLY node forwarded as AppIcon's `fallback`: it is a
			    real logo, so it must suppress the generative tile the way an
			    `iconId`/`iconUrl` does. */}
			<AppIcon
				cacheKey={cacheKey}
				className="pointer-events-none size-10 shrink-0"
				dither={dither}
				fallback={brandIcon}
				iconAppearance={iconAppearance}
				iconBackground={iconBackground}
				iconId={iconId}
				iconPadding={iconPadding}
				iconUrl={iconUrl}
				iconUrlDark={iconUrlDark}
				name={name}
				seedId={seedId}
				seedPlate={seedPlate}
				themePreview={themePreview}
			/>
			<span className="pointer-events-none min-w-0 flex-1">
				<span className="flex items-center gap-1.5">
					<span className="min-w-0 truncate font-medium text-sm">{name}</span>
					{/* Beside the NAME, not on the icon: the icon is the app's own
					    identity, the check is a claim about who published it. */}
					<span className="pointer-events-auto relative z-10 flex shrink-0 items-center">
						{trustMark}
					</span>
					{exceptional}
					<span className="flex-1" />
					{/* The heart rides with the title; it opts back into pointer
					    events and sits above the stretched target. */}
					{likeNamespace && !catalog ? (
						<ItemLikeButton
							className="pointer-events-auto relative z-10 shrink-0"
							namespace={likeNamespace}
							seed={likeSeed}
						/>
					) : null}
				</span>
				{meta ? (
					<span
						className={cn(
							"block text-muted-foreground text-xs",
							metaIsPublisher && "pointer-events-auto relative z-10",
							catalog ? "mt-0.5 line-clamp-2" : "truncate"
						)}
					>
						{meta}
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
