import { Link01Icon } from "@hugeicons/core-free-icons";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppList } from "./apps-catalog-section-app-list.tsx";
import {
	InstallFromUrl,
	PluginSourcePicker,
	TagFilter,
} from "./apps-catalog-section-controls.tsx";
import { AppDetailPanel } from "./apps-catalog-section-detail-panel.tsx";
import {
	type AppsCatalogVariant,
	communityInstallUrl,
	dedupeById,
	filterAppsByStability,
	isCommunityEntry,
	isCompanionApp,
	matchesCatalogTag,
} from "./apps-catalog-section-filters.ts";
import { VARIANT_COPY } from "./apps-catalog-section-variant-copy.ts";
import StoreCatalogLayout from "./chrome/store-catalog-layout.tsx";
import {
	useAllAppListingsAllowed,
	useCatalogHost,
	useNoInstallingLookup,
	useNoSettingsOpener,
} from "./host.tsx";
import { useInstalledOnly } from "./installed-filter.tsx";
import { REALM_ICONS } from "./realm-icons.ts";
import { ALL_PLUGIN_SOURCES_ID, type AppCatalogItem } from "./types.ts";

export {
	isMandatoryListing,
	pluginDownloadTaskId,
	priceLabel,
} from "./apps-catalog-section-card.tsx";
export { runnableKindLabel } from "./apps-catalog-section-detail-aside.tsx";
// biome-ignore lint/performance/noReExportAll: this module's public, tested surface.
export * from "./apps-catalog-section-filters.ts";
export { AuthBridgeConsent } from "./apps-catalog-section-primary-action.tsx";

/**
 * Plugins catalog Store section, shared by desktop and web. Browses the active
 * catalog source (Ryu Marketplace by default, or integrations.sh) joined with
 * live lifecycle records, and drives install → enable → disable for signed
 * plugins. Integration descriptors are browse-only with an outbound link.
 *
 * Desktop mounts it twice — variant "apps" (companion-UI apps) and "plugins"
 * (everything else) — while web keeps the unsplit "all" default. A third mount,
 * variant "community", browses GitHub topic-discovered third-party listings; it
 * is a SEPARATE fetch (Core keeps unreviewed listings out of the first-party
 * catalog) and always renders the "not reviewed by Ryu" notice.
 *
 * Desktop injects its real Core-node catalog hook + install layer through the
 * {@link CatalogHost}; web injects a federated adapter with `install: null`, so
 * the install/enable/source touchpoints collapse to an "Open in Ryu" affordance.
 */
export default function AppsCatalogSection({
	initialQuery = "",
	initialSelectedId,
	variant = "all",
}: {
	/** Seed the search box (e.g. carried over from the store-wide search). */
	initialQuery?: string;
	/** Open this item's preview on arrival — the id of a card clicked on the
	 *  Store's Home shelves. */
	initialSelectedId?: string;
	/** Catalog slice: companion "apps", non-companion "plugins", or "all". */
	variant?: AppsCatalogVariant;
} = {}) {
	const host = useCatalogHost();
	const usePluginSettingsOpener =
		host.usePluginSettingsOpener ?? useNoSettingsOpener;
	const settingsOpener = usePluginSettingsOpener();
	// One reader of the surface's shared install state, for the same reason: the
	// answer has to be identical on the card and in the detail dialog, and this
	// section mounts TWO catalog hooks whose private flags cannot see each other.
	const useInstallingLookup =
		host.install?.useInstallingLookup ?? useNoInstallingLookup;
	const sharedInstalling = useInstallingLookup();
	const {
		items,
		loading,
		loadingMore,
		error,
		fetchNextPage,
		hasNextPage,
		query,
		setQuery,
		selectedId,
		select,
		selectedItem: catalogSelectedItem,
		detail,
		detailLoading,
		detailError,
		install,
		installVersion,
		installing,
		setEnabled,
		lifecyclePending,
		installFromUrl,
		installUrlError,
		switchChannel,
		sources,
		activeSource,
		selectSource,
		selectingSource,
		addMarketplace,
		addingMarketplace,
	} = host.useAppsCatalog(initialQuery);

	// Community listings ride the SAME tab, from a second fetch. Core keeps
	// unreviewed topic-discovered listings out of the first-party catalog, so they
	// cannot be filtered INTO this page — `origin: "community"` addresses that feed
	// directly. They then render as a trailing shelf under their own heading and
	// trust notice, instead of the separate Store tab they used to need.
	const community = host.useAppsCatalog(initialQuery, { origin: "community" });

	// One search box, two feeds. The community hook owns its own debounce, so it is
	// driven from the primary query rather than given its own input.
	const communitySetQuery = community.setQuery;
	useEffect(() => {
		communitySetQuery(query);
	}, [query, communitySetQuery]);

	// The apps/plugins split is presentational: one shared catalog fetch, filtered
	// per variant. Integration descriptors (integrations.sh) stay on the plugins side.
	//
	// The `isCommunityEntry` guard on the first-party list is belt-and-braces: those
	// rows come from the community fetch below, so one appearing here would mean a
	// source leaked it — and it must not render without its trust notice.
	const splitForVariant = (it: AppCatalogItem) => {
		if (variant === "all") {
			return true;
		}
		return variant === "apps" ? isCompanionApp(it) : !isCompanionApp(it);
	};
	// The shell's "installed only" switch (the retired "Added" tab, inverted). Off
	// on any surface that does not mount the provider — the web marketplace, where
	// nothing is installed — so this is safe to apply unconditionally.
	const installedOnly = useInstalledOnly();
	const [showUnstable, setShowUnstable] = host.usePersistedToggle(
		"marketplace-show-unstable-releases",
		false
	);
	const passesInstalledFilter = (it: AppCatalogItem) =>
		!installedOnly || it.installed;
	// Rollout discovery gate: an app held behind a rollout flag is not listed
	// until the reader's rollout reaches it. An installed copy always shows —
	// installing was the opt-in, and the app itself is not flag-aware.
	const useHostAppListingAllowed =
		host.useAppListingAllowed ?? useAllAppListingsAllowed;
	const appListingAllowed = useHostAppListingAllowed();
	const passesRolloutFilter = (it: AppCatalogItem) =>
		it.installed || appListingAllowed(it.entry.id);
	// The same gate on the resolved selection: a gated, uninstalled id that
	// arrives from outside the list (a Home card, a deep link) selects nothing.
	const selectedItem =
		catalogSelectedItem && passesRolloutFilter(catalogSelectedItem)
			? catalogSelectedItem
			: null;
	const candidateItems = dedupeById(
		items.filter(
			(it) =>
				!isCommunityEntry(it) &&
				splitForVariant(it) &&
				passesInstalledFilter(it) &&
				passesRolloutFilter(it)
		)
	);
	const candidateCommunityItems = dedupeById(
		community.items
			.filter(isCommunityEntry)
			.filter(splitForVariant)
			.filter(passesInstalledFilter)
			.filter(passesRolloutFilter)
	);
	const visibleItems = filterAppsByStability(candidateItems, showUnstable);
	const communityItems = filterAppsByStability(
		candidateCommunityItems,
		showUnstable
	);
	const stabilityFiltered =
		!showUnstable &&
		candidateItems.length + candidateCommunityItems.length > 0 &&
		visibleItems.length + communityItems.length === 0;
	const [selectedTag, setSelectedTag] = useState<string | null>(null);
	const availableTags = useMemo(() => {
		const tags = new Set<string>();
		for (const item of [...visibleItems, ...communityItems]) {
			for (const tag of item.entry.tags) {
				const normalized = tag.trim();
				if (normalized) {
					tags.add(normalized);
				}
			}
		}
		return [...tags].sort((a, b) => a.localeCompare(b));
	}, [communityItems, visibleItems]);
	useEffect(() => {
		if (selectedTag && !availableTags.includes(selectedTag)) {
			setSelectedTag(null);
		}
	}, [availableTags, selectedTag]);
	const filteredVisibleItems = visibleItems.filter((item) =>
		matchesCatalogTag(item, selectedTag)
	);
	const filteredCommunityItems = communityItems.filter((item) =>
		matchesCatalogTag(item, selectedTag)
	);
	const copy = VARIANT_COPY[variant];

	// Which feed owns the current selection. The two hooks each track their own
	// `selectedId`, so opening a community listing must both point the preview at
	// the community hook AND clear the first-party one — otherwise two rows would
	// render as selected and the preview would show whichever hook won.
	const [communitySelected, setCommunitySelected] = useState(false);
	const active = communitySelected ? community : null;
	const selectFirstParty = (id: string) => {
		setCommunitySelected(false);
		community.select("");
		select(id);
	};
	const selectCommunity = (id: string) => {
		setCommunitySelected(true);
		select("");
		community.select(id);
	};
	const closeDetail = () => {
		setCommunitySelected(false);
		community.select("");
		select("");
	};

	// A Home shelf card opens this section with its item already selected. One
	// shot, latched: the prop is an arrival instruction, not a controlled value, so
	// re-running it would fight the user's own next click (and `selectFirstParty`
	// closes over hook callbacks that change identity on every refetch, which is
	// exactly what would make a plain dep array re-fire).
	//
	// `selectFirstParty`, never bare `select`: it also clears the COMMUNITY hook's
	// selection, and with both set two rows read as selected and the preview shows
	// whichever hook won.
	const preselected = useRef(false);
	useEffect(() => {
		if (!initialSelectedId || preselected.current) {
			return;
		}
		preselected.current = true;
		selectFirstParty(initialSelectedId);
		// `selectFirstParty`
		// is re-created on every catalog refetch; depending on it would re-assert the
		// arrival selection over whatever the user picked next. The latch above is
		// the guard, and the id is the only real input.
	}, [initialSelectedId]);

	// This section — alone among the six — gates its preview on the RESOLVED item
	// (`hasSelection` below, and `AppDetailPanel` hard-requires it), while its list
	// pages 40 at a time. A preselected id from a shelf card can therefore sit
	// beyond the first page, and the panel would open on an empty state. Page
	// forward until the item resolves; bounded by `hasNextPage`, so it terminates
	// on a miss rather than looping.
	useEffect(() => {
		if (!initialSelectedId || selectedItem || !hasNextPage || loadingMore) {
			return;
		}
		fetchNextPage();
	}, [
		initialSelectedId,
		selectedItem,
		hasNextPage,
		loadingMore,
		fetchNextPage,
	]);

	// Installing a community row. Not `install(id)`: Core keeps unreviewed
	// listings out of the first-party catalog, so there is no id for it to
	// resolve — the repository URL is the only handle, and `installFromUrl` is the
	// request the store's own "Install from URL" field already makes.
	//
	// The busy id is local because it is not one of the catalog hooks' ids: the
	// call is keyed on a URL, so neither hook's `installing` (keyed on a listing
	// id) can ever report it.
	const [communityInstallingId, setCommunityInstallingId] = useState<
		string | null
	>(null);
	const [communityInstallError, setCommunityInstallError] = useState<
		string | null
	>(null);
	const installCommunity = async (item: AppCatalogItem) => {
		const url = communityInstallUrl(item);
		if (!url || communityInstallingId) {
			return;
		}
		setCommunityInstallError(null);
		setCommunityInstallingId(item.entry.id);
		try {
			await installFromUrl(url);
		} catch (cause) {
			setCommunityInstallError(
				cause instanceof Error
					? cause.message
					: "Failed to install community listing"
			);
		} finally {
			setCommunityInstallingId(null);
		}
	};
	const onInstallCommunity = (item: AppCatalogItem) => {
		void installCommunity(item);
	};

	// Is THIS listing busy? One question, one answer, everywhere on the page.
	//
	// The shared store is the authority (it spans both catalog hook instances and
	// the other store sections); the two hooks' own `installing` ids are folded in
	// so a host that provides no shared state — or a test host — still gets a
	// correct per-instance answer instead of a dead flag.
	const isInstalling = (id: string) =>
		sharedInstalling(id) ||
		installing === id ||
		community.installing === id ||
		communityInstallingId === id;

	// Per-card lifecycle without a per-id hook: the hook's setEnabled() acts on the
	// SELECTED item, so a card's Disable selects its item and defers the call until
	// the selection lands (non-racy — the effect fires only once selectedId
	// matches). Add runs inline against an explicit id. Enable routes to the
	// preview so its grant-confirmation dialog is never bypassed.
	//
	// This latch is ONLY that deferral; it is deliberately not the busy flag. It
	// was both once, and it cleared synchronously on the line after the call was
	// FIRED — so a card's spinner lasted a single render and the row re-armed
	// itself while its add was still running, which is how a second click reached
	// Core's 409 "already installed" on an add that was actually succeeding. It
	// still clears synchronously, because holding it past the fire would re-run
	// this effect the next time `setEnabled` changes identity (it is a useCallback
	// over `items`, which re-creates on every catalog refetch) and disable twice.
	const [pendingDisableId, setPendingDisableId] = useState<string | null>(null);

	useEffect(() => {
		if (pendingDisableId === null || selectedId !== pendingDisableId) {
			return;
		}
		setEnabled(false).catch(() => {
			// Errors surface through the hook's error state in the detail panel.
		});
		setPendingDisableId(null);
	}, [pendingDisableId, selectedId, setEnabled]);

	// Add takes the id directly, so the call no longer waits on a selection to
	// land. The preview still opens — that is where this listing's action error
	// renders, and an add that fails silently on a card is worse than a dialog.
	const cardInstall = (id: string) => {
		selectFirstParty(id);
		install(id).catch(() => {
			// Errors surface through the hook's error state in the detail panel.
		});
	};
	const cardDisable = (id: string) => {
		setPendingDisableId(id);
		selectFirstParty(id);
	};

	const filter = {
		label: availableTags.length > 0 ? "Filters" : "Source & install",
		icon: Link01Icon,
		activeCount: (selectedTag ? 1 : 0) + (showUnstable ? 1 : 0),
		panel: (
			<div className="flex flex-col gap-4 p-4">
				<div className="flex items-center gap-2">
					<Checkbox
						aria-label="Show unstable releases"
						checked={showUnstable}
						id="show-unstable-releases"
						onCheckedChange={(checked) => setShowUnstable(checked === true)}
					/>
					<Label className="cursor-pointer" htmlFor="show-unstable-releases">
						Show unstable releases
					</Label>
				</div>
				{availableTags.length > 0 ? (
					<TagFilter
						onChange={setSelectedTag}
						tags={availableTags}
						value={selectedTag}
					/>
				) : null}
				{host.install ? (
					<>
						<PluginSourcePicker
							activeSource={activeSource}
							addingMarketplace={addingMarketplace}
							addMarketplace={addMarketplace}
							selectingSource={selectingSource}
							selectSource={selectSource}
							sources={sources}
						/>
						<InstallFromUrl
							error={installUrlError ?? null}
							install={installFromUrl}
						/>
					</>
				) : null}
			</div>
		),
	};
	const activeCommunityItem =
		active?.selectedItem && isCommunityEntry(active.selectedItem)
			? active.selectedItem
			: null;
	const detailInstall = activeCommunityItem
		? () => installCommunity(activeCommunityItem)
		: (active?.install ?? install);

	return (
		<StoreCatalogLayout
			detail={
				<AppDetailPanel
					detail={active ? active.detail : detail}
					detailError={active ? active.detailError : detailError}
					detailLoading={active ? active.detailLoading : detailLoading}
					error={active ? active.error : error}
					install={detailInstall}
					installLayer={host.install}
					installVersion={active ? undefined : installVersion}
					isInstalling={isInstalling}
					item={active ? active.selectedItem : selectedItem}
					lifecyclePending={active ? active.lifecyclePending : lifecyclePending}
					noun={copy.noun}
					renderAffordance={host.renderAffordance}
					selectedId={active ? active.selectedId : selectedId}
					setEnabled={active ? active.setEnabled : setEnabled}
					settingsOpener={settingsOpener}
					switchChannel={active ? active.switchChannel : switchChannel}
				/>
			}
			detailTitle={
				(active ? active.selectedItem : selectedItem)?.entry.name ?? copy.noun
			}
			filter={filter}
			hasSelection={(active ? active.selectedItem : selectedItem) != null}
			list={
				<AppList
					canInstall={host.install != null}
					communityFetchNextPage={community.fetchNextPage}
					communityHasNextPage={community.hasNextPage}
					communityInstallError={communityInstallError}
					communityInstallingId={communityInstallingId}
					communityItems={filteredCommunityItems}
					communityLoadedCount={community.items.length}
					// The shelf's sentinel needs the NEXT-page flag: `loading` is the
					// initial-load flag and stays false through `fetchNextPage`, which
					// left its request latch set after one extra page.
					communityLoading={community.loading || community.loadingMore}
					communitySelectedId={communitySelected ? community.selectedId : null}
					error={error}
					fallbackIcon={REALM_ICONS[variant === "plugins" ? "plugins" : "apps"]}
					fetchNextPage={fetchNextPage}
					groupBySource={activeSource === ALL_PLUGIN_SOURCES_ID}
					hasNextPage={hasNextPage}
					isInstalling={isInstalling}
					items={filteredVisibleItems}
					loadedCount={items.length}
					loading={loading}
					loadingMore={loadingMore}
					nounPlural={copy.nounPlural}
					onClearSearch={() => setQuery("")}
					onDisable={cardDisable}
					onInstall={cardInstall}
					onInstallCommunity={onInstallCommunity}
					onRetry={fetchNextPage}
					onSelect={selectFirstParty}
					onSelectCommunity={selectCommunity}
					searching={query.trim().length > 0}
					selectedId={communitySelected ? null : selectedId}
					settingsOpener={settingsOpener}
					stabilityFiltered={stabilityFiltered}
				/>
			}
			onCloseDetail={closeDetail}
			search={{
				value: query,
				onChange: setQuery,
				// The integrations.sh placeholder describes THAT feed's contents, so it
				// only applies while that source is the whole page. In the all view the
				// search spans every marketplace, and naming one of them would
				// mis-describe what is about to be searched.
				placeholder:
					activeSource === "integrations-sh"
						? "Search integrations (MCP, OpenAPI, GraphQL, CLI)…"
						: copy.searchPlaceholder,
			}}
		/>
	);
}
