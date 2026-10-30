import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import CommunityTrustNotice from "../chrome/community-trust-notice.tsx";
import InfiniteSentinel from "../chrome/infinite-sentinel.tsx";
import StoreCatalogCard from "../chrome/store-catalog-card.tsx";
import { StoreCardGrid } from "../chrome/store-catalog-layout.tsx";
import StoreShelfHeading from "../chrome/store-shelf-heading.tsx";
import { isDeprecated } from "../deprecation.ts";
import type { AppCatalogItem } from "../types.ts";
import { AppCardAction } from "./app-card-actions.tsx";
import {
	communityInstallUrl,
	groupCommunityMarketplaces,
} from "./apps-helpers.ts";

/**
 * The trailing "From the community" shelf: third-party apps and plugins Ryu
 * discovered from the public GitHub topics, shown inside the Apps and Plugins
 * tabs instead of in a tab of their own.
 *
 * It renders NOTHING at all when the feed is empty — an always-present heading
 * over a blank grid would just be a permanent reminder of a section that has no
 * content, which is the failure mode a merged shelf is supposed to avoid.
 *
 * The trust notice is part of the shelf rather than the page, which is the whole
 * reason a merge is safe: an unreviewed listing can never appear beside a
 * first-party one without the disclosure travelling with it.
 */
export function CommunityShelf({
	items,
	loadedCount,
	loading,
	installError,
	selectedId,
	onSelect,
	onInstallCommunity,
	installingId,
	fallbackIcon,
	hasNextPage,
	fetchNextPage,
	root,
}: {
	fallbackIcon: IconSvgElement;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	installError: string | null;
	/** The row whose install is in flight, if any. */
	installingId: string | null;
	items: AppCatalogItem[];
	/** Community rows loaded BEFORE this tab's filters (see `AppList`). */
	loadedCount: number;
	loading: boolean;
	/** Install a community row from its repository (see the card's `action`). */
	onInstallCommunity: (item: AppCatalogItem) => void;
	onSelect: (id: string) => void;
	root: HTMLElement | null;
	selectedId: string | null;
}) {
	if (items.length === 0) {
		return null;
	}
	// Community MARKETPLACE entries (tagged `ryu-marketplace`, hosting a
	// `marketplace.json`) render grouped under their own sub-headings inside the
	// "Community Marketplaces" section; standalone topic-discovered repos keep the
	// flat "From the community" shelf. Both are unreviewed, so ONE trust notice
	// sits at the top of the whole community area — see `groupCommunityMarketplaces`.
	const { marketplaces, standalone } = groupCommunityMarketplaces(items);

	// One card renderer for every grid in this section: a marketplace entry and a
	// standalone repo are the SAME kind of row (unreviewed, install via its own
	// repo URL), so the card must not differ between the two shelves.
	const card = (it: AppCatalogItem) => (
		<StoreCatalogCard
			action={
				// Install, like every other card in the store. A community row is
				// not a different KIND of listing — it is an app or plugin nobody
				// at Ryu reviewed — so giving it a "Details" button while its
				// neighbours say "Install" made provenance look like a capability
				// difference, and left the shelf's one useful action two clicks
				// away behind a preview.
				//
				// It routes through `installFromUrl` (the listing's repository)
				// rather than the catalog install path, because Core will not
				// install an unreviewed listing BY ID. That is not a way around
				// the gate: it is the same request the store's own "Install from
				// URL" field already makes, with the URL filled in from the row
				// the user is looking at instead of pasted by hand. The
				// unreviewed-code disclosure is unchanged — every row here still
				// sits under the trust notice at the top of the section.
				//
				// A row Core gave no repository for keeps the old browse-only
				// affordance: there is nothing to install from.
				<AppCardAction
					canInstall={Boolean(communityInstallUrl(it))}
					downloadCount={it.entry.downloads}
					item={it}
					onDisable={() => undefined}
					onInstall={() => onInstallCommunity(it)}
					onOpen={() => onSelect(it.entry.id)}
					pending={installingId === it.entry.id}
				/>
			}
			communityApp={
				it.entry.origin === "community" || it.entry.reviewed === false
			}
			deprecated={isDeprecated(it.entry.deprecated)}
			description={it.entry.description}
			dither={it.entry.icon_dither}
			external={it.entry.external}
			icon={<HugeiconsIcon className="size-5" icon={fallbackIcon} />}
			iconBackground={it.entry.icon_background ?? undefined}
			iconId={it.entry.icon}
			iconPadding={it.entry.icon_padding}
			iconUrl={it.entry.icon_url}
			key={it.entry.id}
			layers={it.entry.layers}
			// A community listing has no marketplace document — the namespace
			// key is the whole reason it can be liked at all. See the model.
			likeNamespace={it.entry.id}
			name={it.entry.name}
			onClick={() => onSelect(it.entry.id)}
			// The check rides on the COMMUNITY shelf too, and that is exactly
			// why publisher identity and listing review are kept as separate
			// axes rather than one "trusted" flag: these rows sit under a "Not
			// reviewed by Ryu" alert (nobody read the code) and a verified
			// publisher among them is still a verified publisher (we know who
			// to hold responsible). Wiring only the first-party grid would
			// leave the one case the split exists to express unmarked.
			orgVerified={it.entry.org_verified}
			orgVerifiedTier={it.entry.org_verified_tier}
			publisherTrust={it.entry.publisher_trust}
			publisherVerification={it.entry.publisher_verification}
			reviewed={it.entry.reviewed}
			seedId={it.entry.id}
			// A GitHub repo rarely declares a wash, so without this its card
			// was a bare glyph on flat `bg-muted` in a grid of painted plates.
			seedPlate
			selected={it.entry.id === selectedId}
			stability={it.entry.stability}
			themePreview={it.entry.theme_preview}
		/>
	);

	return (
		<section className="mt-6 flex flex-col gap-3 border-t pt-6">
			{installError ? (
				<p className="text-sm text-status-destructive" role="alert">
					{installError}
				</p>
			) : null}
			{marketplaces.length > 0 ? (
				<>
					{/* The section's BIG header. The SHARED shelf heading primitive,
					    not a hand-rolled copy — the same one the Agents tab's
					    community shelf and every category shelf above use. */}
					<StoreShelfHeading
						className="mb-0"
						description="Community-maintained marketplaces discovered from the ryu-marketplace GitHub topic."
					>
						Community Marketplaces
					</StoreShelfHeading>
					<CommunityTrustNotice tone="banner" />
					{marketplaces.map((marketplace) => (
						<div className="flex flex-col gap-3" key={marketplace.id}>
							{/* Each marketplace's SMALLER sub-heading — the category
							    treatment at one size down, so it reads as nested under
							    "Community Marketplaces". */}
							<h3 className="px-1 font-medium text-sm tracking-tight">
								{marketplace.name}
							</h3>
							<StoreCardGrid>{marketplace.items.map(card)}</StoreCardGrid>
						</div>
					))}
				</>
			) : null}
			{standalone.length > 0 ? (
				<>
					<StoreShelfHeading
						className="mb-0"
						description="Discovered from public GitHub topics."
					>
						From the community
					</StoreShelfHeading>
					{/* One notice for the whole community area: when marketplaces are
					    present it already sits above them, so the standalone shelf
					    does not repeat it. */}
					{marketplaces.length === 0 ? (
						<CommunityTrustNotice tone="banner" />
					) : null}
					<StoreCardGrid>{standalone.map(card)}</StoreCardGrid>
				</>
			) : null}
			<InfiniteSentinel
				hasMore={hasNextPage}
				itemCount={loadedCount}
				loading={loading}
				onLoadMore={fetchNextPage}
				root={root}
			/>
		</section>
	);
}
