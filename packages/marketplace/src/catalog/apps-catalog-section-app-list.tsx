import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	STORE_LOAD_ERROR_SENTENCE,
	StoreErrorDetails,
} from "@ryu/blocks/desktop/store-error-details.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useState } from "react";
import {
	AppCardAction,
	AppCardContextMenu,
} from "./apps-catalog-section-card.tsx";
import { CommunityShelf } from "./apps-catalog-section-community-shelf.tsx";
import { groupByCatalogSource } from "./apps-catalog-section-filters.ts";
import { groupByCategory } from "./categories.ts";
import InfiniteSentinel from "./chrome/infinite-sentinel.tsx";
import StoreCatalogCard from "./chrome/store-catalog-card.tsx";
import { StoreCardGrid } from "./chrome/store-catalog-layout.tsx";
import StoreCategoryPage from "./chrome/store-category-page.tsx";
import StoreShelf from "./chrome/store-shelf.tsx";
import StoreShelfHeading from "./chrome/store-shelf-heading.tsx";
import { isDeprecated } from "./deprecation.ts";
import { formatCount } from "./detail/detail-panels.tsx";
import { type PluginSettingsOpener, useCatalogHost } from "./host.tsx";
import { describeIncompatibility } from "./surface-labels.ts";
import { type AppCatalogItem, evaluateCompatibility } from "./types.ts";

export function AppList({
	items,
	loadedCount,
	loading,
	loadingMore,
	error,
	selectedId,
	onSelect,
	onInstall,
	onDisable,
	isInstalling,
	canInstall,
	fetchNextPage,
	hasNextPage,
	nounPlural,
	fallbackIcon,
	stabilityFiltered,
	searching,
	communityItems,
	communityLoadedCount,
	communityLoading,
	communityHasNextPage,
	communityFetchNextPage,
	communitySelectedId,
	communityInstallingId,
	communityInstallError,
	onSelectCommunity,
	onInstallCommunity,
	onClearSearch,
	onRetry,
	settingsOpener,
	groupBySource,
}: {
	items: AppCatalogItem[];
	/** Rows loaded from the feed BEFORE client-side filtering; its growth tells
	 *  the sentinel a page landed even when it added no visible row. */
	loadedCount: number;
	loading: boolean;
	loadingMore: boolean;
	error: string | null;
	selectedId: string | null;
	onSelect: (id: string) => void;
	onInstall: (id: string) => void;
	onDisable: (id: string) => void;
	/** Shared "this listing has a call in flight" predicate — the same one the
	 *  detail panel reads, so a row and its preview can never disagree. */
	isInstalling: (id: string) => boolean;
	canInstall: boolean;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	nounPlural: string;
	/** True when the stable-only predicate removed every candidate row. */
	stabilityFiltered?: boolean;
	/** Realm glyph shown when an item has no icon of its own (apps→grid,
	 *  plugins→plug socket), sourced from the shared REALM_ICONS so it matches the tab.
	 */
	fallbackIcon: IconSvgElement;
	/** Unreviewed GitHub topic-discovered listings, already narrowed to this tab's
	 *  apps/plugins slice. Rendered as a trailing shelf under their own heading and
	 *  trust notice — see {@link CommunityShelf}. */
	communityItems: AppCatalogItem[];
	/** Community rows loaded BEFORE this tab's filters (see `loadedCount`). */
	communityLoadedCount: number;
	communityLoading: boolean;
	communityHasNextPage: boolean;
	communityFetchNextPage: () => void;
	/** Selected community row, or null when the selection belongs to the
	 *  first-party feed (the two feeds each track their own selection). */
	communitySelectedId: string | null;
	/** The community row whose install is in flight, if any. */
	communityInstallingId: string | null;
	communityInstallError: string | null;
	onSelectCommunity: (id: string) => void;
	/** Install a community row from its repository — see {@link communityInstallUrl}. */
	onInstallCommunity: (item: AppCatalogItem) => void;
	onClearSearch: () => void;
	onRetry: () => void;
	/** True while the user has a search query typed. Suppresses category shelves —
	 *  a result list is ranked by relevance, and slicing it into headed sections
	 *  fights that. */
	searching?: boolean;
	/** Resolves a listing to its "open settings" action (see the host seam). */
	settingsOpener: PluginSettingsOpener;
	/** True in the all-marketplaces view, where rows carry a marketplace stamp and
	 *  are shelved by it rather than by category. */
	groupBySource?: boolean;
}) {
	const tl = useLiteralMessages();
	const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
	const [openCategory, setOpenCategory] = useState<string | null>(null);
	// Resolved HERE, not inside `card`: `card` is a plain render function, not a
	// component, so a hook inside it would run a variable number of times per
	// render. The host's floors are one value for the whole grid anyway.
	const host = useCatalogHost();
	const { hostVersions } = host;
	const incompatibilityOf = (it: AppCatalogItem) =>
		describeIncompatibility(
			evaluateCompatibility(
				it.entry.engines,
				hostVersions ?? {},
				it.entry.compatibility
			)
		);

	const card = (it: AppCatalogItem) => (
		<StoreCatalogCard
			action={
				<AppCardAction
					canInstall={canInstall}
					downloadCount={it.entry.downloads}
					item={it}
					onDisable={() => onDisable(it.entry.id)}
					onInstall={() => onInstall(it.entry.id)}
					onOpen={() => onSelect(it.entry.id)}
					// Settings are keyed by the MANIFEST id, and `entry.id` IS that id
					// for any installed listing: the catalog↔record join matches on
					// it, which is what makes the row read "installed" at all.
					onOpenSettings={settingsOpener(it.entry.id)}
					pending={isInstalling(it.entry.id)}
				/>
			}
			communityApp={
				it.entry.origin === "community" || it.entry.reviewed === false
			}
			contextMenu={
				// Mirrors the card's OWN control, installed states included — the
				// right-click used to reach only listings you had not adopted yet,
				// which is the half with the least to do to it.
				//
				// Same guard `AppCardAction` uses to withhold the install verb: a
				// descriptor-only listing (and every listing on the read-only web
				// store) renders a "Details" affordance, not an Add button, so a menu
				// offering Add would contradict the card it sits on.
				canInstall && !it.entry.descriptor_only ? (
					<AppCardContextMenu
						item={it}
						onDisable={() => onDisable(it.entry.id)}
						onInstall={() => onInstall(it.entry.id)}
						onOpen={() => onSelect(it.entry.id)}
						onOpenSettings={settingsOpener(it.entry.id)}
					/>
				) : undefined
			}
			deprecated={isDeprecated(it.entry.deprecated)}
			description={it.entry.description}
			// A listing this node cannot run is DIMMED, never hidden: it used to
			// vanish from the catalog entirely, leaving no way to learn that updating
			// Ryu would bring it back. The reason rides the row's action slot.
			dimmed={Boolean(incompatibilityOf(it))}
			dither={it.entry.icon_dither}
			external={it.entry.external}
			icon={<HugeiconsIcon className="size-5" icon={fallbackIcon} />}
			iconBackground={it.entry.icon_background ?? undefined}
			iconId={it.entry.icon}
			iconPadding={it.entry.icon_padding}
			iconUrl={it.entry.icon_url}
			key={it.entry.id}
			layers={it.entry.layers}
			// The heart, keyed by the listing's NAMESPACE. `entry.id` IS that
			// namespace (`@ryu/crm`) — the same string the install path and the
			// settings join already key on — so a community listing discovered
			// from a GitHub topic, which has no marketplace document at all,
			// carries the same count as a published one.
			likeNamespace={it.entry.id}
			membershipIncluded={Boolean(it.entry.membership_included)}
			name={it.entry.name}
			onClick={() => onSelect(it.entry.id)}
			orgVerified={it.entry.org_verified}
			orgVerifiedTier={it.entry.org_verified_tier}
			publisher={
				host.renderPublisher &&
				it.entry.publisher_org_id &&
				it.entry.publisher_org_name
					? host.renderPublisher({
							id: it.entry.publisher_org_id,
							logo: it.entry.publisher_org_logo ?? null,
							name: it.entry.publisher_org_name,
							slug: it.entry.publisher_org_slug ?? null,
						})
					: undefined
			}
			publisherTrust={it.entry.publisher_trust}
			publisherVerification={it.entry.publisher_verification}
			reviewed={it.entry.reviewed}
			seedId={it.entry.id}
			selected={it.entry.id === selectedId}
			stability={it.entry.stability}
			themePreview={it.entry.theme_preview}
		/>
	);

	// The community shelf is rendered in EVERY state below, including the empty and
	// error ones: the first-party feed failing or matching nothing is not a reason
	// to hide the listings that DID match — that was the practical cost of the old
	// separate tab, where a miss here meant the user never learned the community
	// feed had the thing.
	const communityShelf = (
		<CommunityShelf
			fallbackIcon={fallbackIcon}
			fetchNextPage={communityFetchNextPage}
			hasNextPage={communityHasNextPage}
			installError={communityInstallError}
			installingId={communityInstallingId}
			items={communityItems}
			loadedCount={communityLoadedCount}
			loading={communityLoading}
			onInstallCommunity={onInstallCommunity}
			onSelect={onSelectCommunity}
			root={scrollEl}
			selectedId={communitySelectedId}
		/>
	);

	if (loading && items.length === 0) {
		return (
			<div className="flex flex-col gap-3" ref={setScrollEl}>
				<div className="flex items-center justify-center p-8 text-muted-foreground">
					<Spinner className="size-5" />
				</div>
				{communityShelf}
			</div>
		);
	}
	if (error && items.length === 0) {
		return (
			<div className="flex flex-col gap-3" ref={setScrollEl}>
				<Empty className="h-full" inset="dense">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={fallbackIcon} />
						</EmptyMedia>
						<EmptyTitle>
							{tl("Couldn't load {nounPlural}", { nounPlural })}
						</EmptyTitle>
						<EmptyDescription>{STORE_LOAD_ERROR_SENTENCE}</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button onClick={onRetry} size="sm" variant="outline">
							Try again
						</Button>
						<StoreErrorDetails message={error} />
					</EmptyContent>
				</Empty>
				{communityShelf}
			</div>
		);
	}
	if (items.length === 0) {
		return (
			<div className="flex flex-col gap-3" ref={setScrollEl}>
				{/* A page can filter to zero visible rows (variant split, installed
				    only, tags) while the feed still has more: keep paging instead of
				    declaring the catalog empty. */}
				{communityItems.length === 0 && !hasNextPage ? (
					<Empty className="h-full" inset="dense">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HugeiconsIcon icon={fallbackIcon} />
							</EmptyMedia>
							<EmptyTitle>
								{stabilityFiltered
									? "No stable releases found"
									: tl("No {nounPlural} found", { nounPlural })}
							</EmptyTitle>
							<EmptyDescription>
								{stabilityFiltered
									? "Turn on “Show unstable releases” to browse experimental versions."
									: "Try a different search."}
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button onClick={onClearSearch} size="sm" variant="ghost">
								Clear search
							</Button>
						</EmptyContent>
					</Empty>
				) : null}
				<InfiniteSentinel
					hasMore={hasNextPage}
					itemCount={loadedCount}
					loading={loadingMore}
					onLoadMore={fetchNextPage}
					root={scrollEl}
				/>
				{communityShelf}
			</div>
		);
	}

	// Shelve the grid by category, the way Home shelves by realm.
	//
	// Two cases deliberately stay FLAT, because a heading would be noise or a lie:
	//
	//  - A search is in progress. The user has already told us what they want; the
	//    answer is a relevance list, and chopping six results across four headed
	//    shelves makes it harder to read, not easier.
	//  - Everything landed on one shelf. A single heading above the whole grid says
	//    nothing that the tab title did not already say.
	//
	// Infinite scroll keeps working across shelves: `items` is the full accumulated
	// page set and is regrouped on every render, so a later page's items file into
	// the shelves that already exist instead of appending a second copy of them.
	// In the all-marketplaces view the FIRST cut is by marketplace, not by category:
	// the question that view exists to answer is "where does this come from", and a
	// row's marketplace decides who published it, who vetted it and where an install
	// is fetched from. Category shelving still applies inside a single-source view.
	//
	// Same single-shelf rule as below, for the same reason: one heading reading "Ryu
	// Marketplace" over the entire grid — which is what a machine with no custom
	// marketplaces added produces — says nothing, so that case falls through to
	// category shelving instead.
	const sourceSections = searching ? [] : groupByCatalogSource(items);
	const sourceShelved = groupBySource && sourceSections.length > 1;
	const sections =
		searching || sourceShelved
			? []
			: groupByCategory(items, (it) => it.entry.category);
	const shelved = sections.length > 1;
	const category = openCategory
		? sections.find((section) => section.label === openCategory)
		: undefined;

	if (category && !searching && !sourceShelved) {
		return (
			<div ref={setScrollEl}>
				<StoreCategoryPage
					category={category.label}
					hasMore={hasNextPage}
					items={category.items}
					loadingMore={loadingMore}
					onBack={() => setOpenCategory(null)}
					onLoadMore={fetchNextPage}
					renderItem={card}
				/>
			</div>
		);
	}

	if (sourceShelved) {
		return (
			<div ref={setScrollEl}>
				<div className="flex flex-col gap-6">
					{sourceSections.map((section) => (
						<section key={section.id}>
							<StoreShelfHeading>{section.label}</StoreShelfHeading>
							<StoreCardGrid>{section.items.map(card)}</StoreCardGrid>
						</section>
					))}
				</div>
				{/* No `InfiniteSentinel`: the all view is a concatenation of N feeds and
				    Core returns no cursor for it (one cursor cannot address a position in
				    every source), so `hasNextPage` is false here by construction. Pick a
				    single marketplace to page through it. */}
				{communityShelf}
			</div>
		);
	}

	return (
		<div ref={setScrollEl}>
			{shelved ? (
				<div className="flex flex-col gap-6">
					{sections.map((section) => (
						<StoreShelf
							description={`${formatCount(section.items.length) ?? "—"} ${section.items.length === 1 ? "listing" : "listings"}`}
							items={section.items}
							key={section.label}
							onOpenCategory={() => setOpenCategory(section.label)}
							renderItem={card}
							title={section.label}
						/>
					))}
				</div>
			) : (
				<StoreCardGrid>{items.map(card)}</StoreCardGrid>
			)}
			<InfiniteSentinel
				hasMore={hasNextPage}
				itemCount={loadedCount}
				loading={loadingMore}
				onLoadMore={fetchNextPage}
				root={scrollEl}
			/>
			{communityShelf}
		</div>
	);
}
