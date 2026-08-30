import {
	Add01Icon,
	CheckmarkCircle02Icon,
	Download01Icon,
	GridIcon,
	InformationCircleIcon,
	Link01Icon,
	Package01Icon,
	PotionIcon,
	ServerStack01Icon,
	Settings01Icon,
	SquareLock01Icon,
	Target01Icon,
	WorkflowCircle06Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { MarketplaceAccessBadge } from "@ryu/ui/components/marketplace-access-badge.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import { useSvglIndex } from "@ryu/ui/components/svgl.ts";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useMarketplaceHostOptional } from "../host.tsx";
import ItemLikeButton from "../likes/like-button.tsx";
import { useOptionalReport } from "../report/report-provider.tsx";
import { StarRating } from "../star-rating.tsx";
import { formatPrice } from "../types.ts";
import { groupByCategory } from "./categories.ts";
import BrandOrCoverImage, {
	normalizeIconPadding,
} from "./chrome/brand-image.tsx";
import CommunityTrustNotice from "./chrome/community-trust-notice.tsx";
import InfiniteSentinel from "./chrome/infinite-sentinel.tsx";
import StoreCatalogCard from "./chrome/store-catalog-card.tsx";
import StoreCatalogLayout, {
	StoreCardGrid,
} from "./chrome/store-catalog-layout.tsx";
import StoreCategoryPage from "./chrome/store-category-page.tsx";

import StoreItemAction, {
	PublisherInstallDisclosure,
	StoreItemOverflowMenu,
	storeItemContextMenu,
} from "./chrome/store-item-action.tsx";
import StoreShelf from "./chrome/store-shelf.tsx";
import StoreShelfHeading from "./chrome/store-shelf-heading.tsx";
import VerifiedBadge from "./chrome/verified-badge.tsx";
import {
	ChannelPicker,
	ChannelSwitchSummary,
	channelLabel,
	STABLE_CHANNEL,
	useListingChannels,
} from "./detail/channel-picker.tsx";
import { formatCount, formatDate } from "./detail/detail-panels.tsx";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingGalleryRail,
	ListingHero,
	ListingInfoGrid,
	ListingSection,
	type ListingStat,
	ListingStatStrip,
} from "./detail/listing-detail-shell.tsx";
import { ListingDetailTabs } from "./detail/listing-detail-tabs.tsx";
import { ScorecardBadge } from "./detail/scorecard-panel.tsx";
import { SupportExtensionPanel } from "./detail/support-extension-panel.tsx";
import { grantDescription, grantLabel } from "./grant-labels.ts";
import {
	type CatalogHost,
	type CatalogInstall,
	type PluginSettingsOpener,
	useCatalogHost,
	useEntryIncompatibility,
	useNoInstallingLookup,
	useNoInterfaceLevel,
	useNoSettingsOpener,
} from "./host.tsx";
import { resolveCardIcon } from "./icon-url.ts";
import ImportToolsAction from "./import-tools-action.tsx";
import { useInstalledOnly } from "./installed-filter.tsx";
import { REALM_ICONS } from "./realm-icons.ts";
import { safeHttpUrl } from "./safe-url.ts";
import { runScorecard, type Scorecard } from "./scorecard.ts";
import { isUnstableRelease, stabilityLabel } from "./stability.ts";
import { describeIncompatibility, surfaceLabel } from "./surface-labels.ts";
import {
	type AddMarketplaceParams,
	ALL_PLUGIN_SOURCES_ID,
	type AppCatalogItem,
	type CatalogEntry,
	type CatalogModelProvider,
	type CatalogVersion,
	catalogLayerBadges,
	evaluateCompatibility,
	type PluginCatalogDetail,
	type PluginCatalogSource,
} from "./types.ts";

/** Which slice of the plugin catalog a section instance browses. An "app" claims a
 *  UI DESTINATION — somewhere the user navigates TO that does not exist while the
 *  item is uninstalled: a companion window, a workspace dock tab, or a top-level
 *  route. A "plugin" is everything else — it only modifies surfaces that already
 *  exist (tools/agents/channels/policies, turn hooks, capability providers, settings
 *  tabs, sidebar sections). "all" = the historical unsplit tab, which web still uses.
 *
 *  Notably NOT app-ness: shipping a sidecar (the five `document.parse` providers each
 *  ship one and nobody opens Docling), living under `apps-store/` (that is a
 *  PACKAGING root — items published as their own satellite repo), or declaring a
 *  `category`. The rule is adjudicated server-side by `manifest_declares_destination`
 *  (apps/core/src/server/mod.rs) and arrives here as {@link CatalogEntry.type}.
 *
 *  There is no "community" variant any more. Community listings are not a
 *  different KIND of thing — they are apps and plugins that nobody at Ryu
 *  reviewed — so a whole tab for them split the catalog by provenance and asked
 *  the user to visit two places to answer one question ("is there a Ryu plugin
 *  for X?"). They are now a trailing, clearly-labelled shelf inside these same
 *  tabs; see {@link CommunityShelf}. */
export type AppsCatalogVariant = "apps" | "plugins" | "all";

/** True when a catalog entry is an "app" — i.e. it claims a UI destination (see
 *  {@link AppsCatalogVariant}).
 *
 *  The `type` discriminator is AUTHORITATIVE and the rule lives in exactly one
 *  place: Core's `manifest_declares_destination`, which reads the three keys that
 *  mint a destination (a `companion` runnable, `contributes.dock_panels` in any
 *  panel mode, or a top-level `contributes.sidebar_buttons[].target`). Do not
 *  re-derive it here — a second copy is how Browser/Simulator/CRM/UGC and
 *  Dashboards/Drafts/Mission Control ended up in a different tab than their `type`
 *  said they were in.
 *
 *  The `kinds` fallback is for OLDER WIRES ONLY (a Core that predates the `type`
 *  key). It is deliberately still the narrow companion test rather than the full
 *  rule, because it cannot be anything else: the catalog entry carries `kinds`, but
 *  the projector never puts `dock_panels` or `sidebar_buttons` on it
 *  (`project_manifest`'s allowlist emits `apiSurface`, not the shell contributions),
 *  so the three-key rule is not expressible from entry data. A stale Core therefore
 *  under-reports apps; it never mis-reports one.
 *
 *  Exported for unit tests (the detail-panel helpers below run only inside the
 *  Dialog-portaled preview, which `renderToStaticMarkup` cannot emit). */
export function isCompanionApp(item: AppCatalogItem): boolean {
	if (item.entry.type) {
		return item.entry.type === "app";
	}
	return item.entry.kinds.includes("companion");
}

/** True when a listing was discovered from a public GitHub topic rather than
 *  published to a first-party catalog — i.e. nobody at Ryu reviewed it.
 *
 *  Keys on the snake_case `origin` the Core projector stamps (see
 *  `plugin_marketplace_item_to_entry`); `reviewed === false` is accepted as a
 *  secondary signal so a source that stamps only the trust flag still gets the
 *  notice. Absent/null ⇒ first-party: deliberately fail-safe in that direction so
 *  an older wire never gains a scary label, which makes the notice opt-in from the
 *  producer. Exported for unit tests. */
export function isCommunityEntry(item: AppCatalogItem): boolean {
	return item.entry.origin === "community" || item.entry.reviewed === false;
}

/**
 * The URL a community listing installs from — its repository.
 *
 * Community rows cannot be installed BY ID: Core keeps unreviewed listings out
 * of the first-party catalog, so the catalog install path has nothing to resolve.
 * They install through the same `installFromUrl` request the store's own
 * "Install from URL" field makes, which is why this returns a URL rather than
 * calling anything — the caller pairs it with the host's install layer.
 *
 * `null` when Core stamped no repository on the row, in which case the card
 * keeps its browse-only affordance rather than offering an install that cannot
 * run. Exported for unit tests.
 */
export function communityInstallUrl(item: AppCatalogItem): string | null {
	const url = item.entry.repo_url?.trim();
	return url ? url : null;
}

/**
 * Collapse repeat listings of the same id, keeping the FIRST occurrence.
 *
 * The all-marketplaces view (`?source=all`) is a concatenation of every source's
 * page, so one app published to two marketplaces — or present both as a built-in
 * and as a remote listing — arrives twice. Two copies of one listing is bad
 * enough on its own; worse, the copies need not agree about what they ARE, and a
 * pair that disagrees about `type` lands one row in Apps and the other in
 * Plugins. That is how the same app comes to appear in both tabs at once.
 *
 * First occurrence wins because Core emits the unified first-party view ahead of
 * the federated sources, so the copy that survives is the one Ryu itself
 * publishes — the same precedence `merged_plugin_catalog_entries` applies
 * server-side. Order is otherwise preserved: it is meaningful here.
 *
 * Exported for unit tests.
 */
export function dedupeById(items: readonly AppCatalogItem[]): AppCatalogItem[] {
	const seen = new Set<string>();
	const out: AppCatalogItem[] = [];
	for (const item of items) {
		if (seen.has(item.entry.id)) {
			continue;
		}
		seen.add(item.entry.id);
		out.push(item);
	}
	return out;
}

/** Apply the Marketplace's stable-only default to an already scoped list. */
export function filterAppsByStability(
	items: readonly AppCatalogItem[],
	showUnstable: boolean
): AppCatalogItem[] {
	return showUnstable
		? [...items]
		: items.filter((item) => !isUnstableRelease(item.entry.stability));
}

/** Shared predicate for the Marketplace tag filter and its focused tests. */
export function matchesCatalogTag(
	item: AppCatalogItem,
	selectedTag: string | null
): boolean {
	return selectedTag === null || item.entry.tags.includes(selectedTag);
}

/** One marketplace's slice of the all-marketplaces list. */
export interface CatalogSourceSection {
	id: string;
	items: AppCatalogItem[];
	label: string;
}

/**
 * Group listings by the marketplace they came from, preserving the order Core
 * emitted them in — that order is meaningful (the unified first-party view first,
 * then the federated sources), so it is kept rather than re-sorted alphabetically.
 *
 * Rows with no stamp are folded into a single trailing bucket instead of being
 * dropped: a source Core could not name is still a real listing the user can
 * install, and silently hiding it would be a worse failure than an unlabelled
 * heading. Exported for unit tests.
 */
export function groupByCatalogSource(
	items: readonly AppCatalogItem[]
): CatalogSourceSection[] {
	const sections = new Map<string, CatalogSourceSection>();
	for (const item of items) {
		const id = item.entry.catalog_source_id ?? "";
		const existing = sections.get(id);
		if (existing) {
			existing.items.push(item);
			continue;
		}
		sections.set(id, {
			id,
			label: item.entry.catalog_source_name ?? "Other marketplaces",
			items: [item],
		});
	}
	return [...sections.values()];
}

/** One community marketplace's slice of the community feed, for the
 *  "Community Marketplaces" section — see {@link groupCommunityMarketplaces}. */
export interface CommunityMarketplaceSection {
	id: string;
	items: AppCatalogItem[];
	name: string;
}

/**
 * Group community listings into marketplaces, splitting out the standalone ones.
 *
 * A community MARKETPLACE entry carries a grouping stamp (`catalog_source_id` /
 * `catalog_source_name` — the `ryu-marketplace` repo it was discovered from), so
 * it renders under its marketplace's sub-heading inside the "Community
 * Marketplaces" section. A standalone topic-discovered repo carries no stamp and
 * keeps the flat "From the community" shelf. Exported for unit tests.
 */
export function groupCommunityMarketplaces(items: readonly AppCatalogItem[]): {
	marketplaces: CommunityMarketplaceSection[];
	standalone: AppCatalogItem[];
} {
	const marketplaces = new Map<string, CommunityMarketplaceSection>();
	const standalone: AppCatalogItem[] = [];
	for (const item of items) {
		const id = item.entry.catalog_source_id;
		const name = item.entry.catalog_source_name;
		if (!(id && name)) {
			standalone.push(item);
			continue;
		}
		const existing = marketplaces.get(id);
		if (existing) {
			existing.items.push(item);
			continue;
		}
		marketplaces.set(id, { id, name, items: [item] });
	}
	return { marketplaces: [...marketplaces.values()], standalone };
}

const VARIANT_COPY: Record<
	AppsCatalogVariant,
	{ noun: string; nounPlural: string; searchPlaceholder: string }
> = {
	apps: {
		noun: "app",
		nounPlural: "apps",
		searchPlaceholder: "Search apps…",
	},
	plugins: {
		noun: "plugin",
		nounPlural: "plugins",
		searchPlaceholder: "Search plugins…",
	},
	all: {
		noun: "plugin",
		nounPlural: "plugins",
		searchPlaceholder: "Search plugins…",
	},
};

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
		selectedItem,
		detail,
		detailLoading,
		detailError,
		install,
		installVersion,
		installing,
		setEnabled,
		lifecyclePending,
		installFromUrl,
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
	const candidateItems = dedupeById(
		items.filter(
			(it) =>
				!isCommunityEntry(it) &&
				splitForVariant(it) &&
				passesInstalledFilter(it)
		)
	);
	const candidateCommunityItems = dedupeById(
		community.items
			.filter(isCommunityEntry)
			.filter(splitForVariant)
			.filter(passesInstalledFilter)
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
		// biome-ignore lint/correctness/useExhaustiveDependencies: `selectFirstParty`
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
	const onInstallCommunity = (item: AppCatalogItem) => {
		const url = communityInstallUrl(item);
		if (!url || communityInstallingId) {
			return;
		}
		setCommunityInstallingId(item.entry.id);
		installFromUrl(url).finally(() => setCommunityInstallingId(null));
	};

	// Is THIS listing busy? One question, one answer, everywhere on the page.
	//
	// The shared store is the authority (it spans both catalog hook instances and
	// the other store sections); the two hooks' own `installing` ids are folded in
	// so a host that provides no shared state — or a test host — still gets a
	// correct per-instance answer instead of a dead flag.
	const isInstalling = (id: string) =>
		sharedInstalling(id) || installing === id || community.installing === id;

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
					<Label
						className="cursor-pointer text-sm"
						htmlFor="show-unstable-releases"
					>
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
						<InstallFromUrl install={installFromUrl} />
					</>
				) : null}
			</div>
		),
	};

	return (
		<StoreCatalogLayout
			detail={
				<AppDetailPanel
					detail={active ? active.detail : detail}
					detailError={active ? active.detailError : detailError}
					detailLoading={active ? active.detailLoading : detailLoading}
					error={active ? active.error : error}
					install={active ? active.install : install}
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
					communityInstallingId={communityInstallingId}
					communityItems={filteredCommunityItems}
					communityLoading={community.loading}
					communitySelectedId={communitySelected ? community.selectedId : null}
					error={error}
					fallbackIcon={REALM_ICONS[variant === "plugins" ? "plugins" : "apps"]}
					fetchNextPage={fetchNextPage}
					groupBySource={activeSource === ALL_PLUGIN_SOURCES_ID}
					hasNextPage={hasNextPage}
					isInstalling={isInstalling}
					items={filteredVisibleItems}
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

function TagFilter({
	onChange,
	tags,
	value,
}: {
	onChange: (value: string | null) => void;
	tags: string[];
	value: string | null;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="font-medium text-muted-foreground text-xs">Tag</span>
			<Select
				items={[
					{ value: "__all__", label: "All tags" },
					...tags.map((tag) => ({ value: tag, label: tag })),
				]}
				onValueChange={(next) =>
					onChange(next === "__all__" ? null : (next ?? null))
				}
				value={value ?? "__all__"}
			>
				<SelectTrigger className="h-8 w-full text-sm" size="sm">
					<SelectValue placeholder="All tags" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="__all__">All tags</SelectItem>
					{tags.map((tag) => (
						<SelectItem key={tag} value={tag}>
							{tag}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/**
 * Source dropdown (Ryu Marketplace + any custom Claude plugin marketplaces) plus
 * an "Add marketplace" popover. A marketplace is a repo/URL/local directory
 * pointing at a `marketplace.json` (`.claude-plugin/`, `.ryu-plugin/`, …).
 */
function PluginSourcePicker({
	sources,
	activeSource,
	selectSource,
	selectingSource,
	addMarketplace,
	addingMarketplace,
}: {
	sources: PluginCatalogSource[];
	activeSource: string;
	selectSource: (id: string) => void;
	selectingSource: boolean;
	addMarketplace: (params: AddMarketplaceParams) => Promise<void>;
	addingMarketplace: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [repo, setRepo] = useState("");
	const [name, setName] = useState("");
	const [addError, setAddError] = useState<string | null>(null);

	// "All marketplaces" leads, and is the default the store opens on. The picker is
	// a NARROWING control now, not the thing that decides whether a listing is
	// findable at all: every source is already on screen under its own heading, so
	// choosing one here is for focusing (or for paging through a big federated feed,
	// which the all view cannot cursor across).
	const sourceItems = [
		{ value: ALL_PLUGIN_SOURCES_ID, label: "All marketplaces" },
		...sources.map((s) => ({ value: s.id, label: s.displayName })),
	];

	const submit = async () => {
		const trimmedRepo = repo.trim();
		if (!trimmedRepo) {
			setAddError("Enter a repo, git URL, or local path");
			return;
		}
		const displayName = name.trim() || trimmedRepo;
		// Derive a stable, safe id from the display name / repo.
		const id = `mp-${displayName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")}`;
		setAddError(null);
		try {
			await addMarketplace({ id, displayName, baseUrl: trimmedRepo });
			setRepo("");
			setName("");
			setOpen(false);
		} catch (e) {
			setAddError(e instanceof Error ? e.message : "Failed to add marketplace");
		}
	};

	return (
		<div className="flex flex-col gap-1.5">
			<span className="font-medium text-muted-foreground text-xs">
				Catalog source
			</span>
			{/* One real source still earns the picker: the choice on offer is now
			    "everything" vs "just this one", which is a choice even with a single
			    marketplace registered. It only collapses when there is nothing at all
			    to narrow to. */}
			{sourceItems.length > 1 && (
				<Select
					disabled={selectingSource}
					items={sourceItems}
					onValueChange={(value) => {
						if (value) {
							selectSource(value);
						}
					}}
					value={activeSource}
				>
					<SelectTrigger className="h-8 w-full text-sm" size="sm">
						<SelectValue placeholder="Source" />
					</SelectTrigger>
					<SelectContent>
						{sourceItems.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								{opt.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
			<Popover onOpenChange={setOpen} open={open}>
				<TooltipProvider delay={0}>
					<Tooltip>
						<TooltipTrigger
							render={
								<PopoverTrigger className="inline-flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground">
									<HugeiconsIcon className="size-4" icon={Add01Icon} />
									Add marketplace
								</PopoverTrigger>
							}
						/>
						<TooltipContent>Add a Claude plugin marketplace</TooltipContent>
					</Tooltip>
				</TooltipProvider>
				<PopoverContent className="w-80">
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1">
							<Label htmlFor="plugin-mp-repo">
								Repo, git URL, or local path
							</Label>
							<Input
								id="plugin-mp-repo"
								onChange={(e) => setRepo(e.target.value)}
								placeholder="owner/repo, https://…/marketplace.json, or /path/to/marketplace"
								value={repo}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="plugin-mp-name">Display name (optional)</Label>
							<Input
								id="plugin-mp-name"
								onChange={(e) => setName(e.target.value)}
								placeholder="My Marketplace"
								value={name}
							/>
						</div>
						{addError && <p className="text-destructive text-xs">{addError}</p>}
						<Button
							loading={addingMarketplace}
							onClick={() => {
								submit().catch(() => undefined);
							}}
							size="sm"
						>
							{!addingMarketplace && (
								<HugeiconsIcon className="size-4" icon={Add01Icon} />
							)}
							{addingMarketplace ? "Adding…" : "Add marketplace"}
						</Button>
					</div>
				</PopoverContent>
			</Popover>
		</div>
	);
}

function InstallFromUrl({
	install,
}: {
	install: (url: string) => Promise<void>;
}) {
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false);

	// Fire-and-forget: all errors are handled inside, so the returned promise
	// never rejects and callers can invoke it without awaiting or `void`.
	const submit = () => {
		const trimmed = url.trim();
		if (!trimmed || busy) {
			return;
		}
		setBusy(true);
		install(trimmed)
			.then(() => setUrl(""))
			.catch(() => {
				// Error surfaces via the hook's error state in the detail panel; the
				// input stays populated so the user can correct the URL.
			})
			.finally(() => setBusy(false));
	};

	return (
		<div className="flex items-center gap-2">
			<div className="relative flex-1">
				<HugeiconsIcon
					className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					icon={Link01Icon}
				/>
				<Input
					className="pl-9"
					onChange={(e) => setUrl(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							submit();
						}
					}}
					placeholder="https://…/manifest.json"
					value={url}
				/>
			</div>
			<Button
				disabled={url.trim().length === 0}
				loading={busy}
				onClick={submit}
				size="sm"
				variant="ghost"
			>
				Add from URL
			</Button>
		</div>
	);
}

function AppList({
	items,
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
	communityLoading,
	communityHasNextPage,
	communityFetchNextPage,
	communitySelectedId,
	communityInstallingId,
	onSelectCommunity,
	onInstallCommunity,
	onClearSearch,
	onRetry,
	settingsOpener,
	groupBySource,
}: {
	items: AppCatalogItem[];
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
	communityLoading: boolean;
	communityHasNextPage: boolean;
	communityFetchNextPage: () => void;
	/** Selected community row, or null when the selection belongs to the
	 *  first-party feed (the two feeds each track their own selection). */
	communitySelectedId: string | null;
	/** The community row whose install is in flight, if any. */
	communityInstallingId: string | null;
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
	const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
	const [openCategory, setOpenCategory] = useState<string | null>(null);
	// Resolved HERE, not inside `card`: `card` is a plain render function, not a
	// component, so a hook inside it would run a variable number of times per
	// render. The host's floors are one value for the whole grid anyway.
	const { hostVersions } = useCatalogHost();
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
			publisherTrust={it.entry.publisher_trust}
			publisherVerification={it.entry.publisher_verification}
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
			installingId={communityInstallingId}
			items={communityItems}
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
				<Empty className="h-full p-6">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={fallbackIcon} />
						</EmptyMedia>
						<EmptyTitle>Couldn&apos;t load {nounPlural}</EmptyTitle>
						<EmptyDescription>{error}</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button onClick={onRetry} size="sm" variant="ghost">
							Try again
						</Button>
					</EmptyContent>
				</Empty>
				{communityShelf}
			</div>
		);
	}
	if (items.length === 0) {
		return (
			<div className="flex flex-col gap-3" ref={setScrollEl}>
				{communityItems.length === 0 ? (
					<Empty className="h-full p-6">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<HugeiconsIcon icon={fallbackIcon} />
							</EmptyMedia>
							<EmptyTitle>
								{stabilityFiltered
									? "No stable releases found"
									: `No ${nounPlural} found`}
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
				loading={loadingMore}
				onLoadMore={fetchNextPage}
				root={scrollEl}
			/>
			{communityShelf}
		</div>
	);
}

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
function CommunityShelf({
	items,
	loading,
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
	/** The row whose install is in flight, if any. */
	installingId: string | null;
	items: AppCatalogItem[];
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
							<h3 className="px-1 font-semibold text-sm tracking-tight">
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
				loading={loading}
				onLoadMore={fetchNextPage}
				root={root}
			/>
		</section>
	);
}

/** True when this listing is required for Core and must never be offered a
 *  Disable/Uninstall control.
 *
 *  Gated on `source === "built-in"` as well as the flag. `mandatory` arrives on an
 *  entry that may have come from a remote catalog, and "you cannot turn this off"
 *  is precisely the claim a hostile listing would make about itself; Core only ever
 *  stamps it from its own constant, so a non-built-in entry carrying it is either
 *  lying or a source bug. Trusting it there would let a third-party listing render
 *  itself as un-removable — and the lifecycle would not back that up, so the user
 *  would be stuck looking at an app with no way to remove it and no explanation.
 *
 *  Exported for unit tests. */
export function isMandatoryListing(entry: CatalogEntry): boolean {
	return entry.mandatory === true && entry.source === "built-in";
}

/** The download-center task id Core registers an add under.
 *
 *  One scheme, declared once, shared by every path that adds a plugin — the
 *  catalog resolve, the built-in store write, and the update re-resolve all
 *  register `plugin:<id>`, so a retry dedupes onto the same row and a button can
 *  find its own transfer by id instead of guessing from a label.
 *
 *  Exported for unit tests. */
export function pluginDownloadTaskId(id: string): string {
	return `plugin:${id}`;
}

/** Card action for an app: Add (inline), Enabled↔Disable morph (Disable
 *  inline), or Disabled→Enable which opens the preview so its grant dialog runs.
 *  Descriptor-only rows + read-only surfaces just open the preview. */
/**
 * The right-click rows for an app card — the same decisions {@link AppCardAction}
 * makes, restated for the context-menu primitive.
 *
 * A component rather than a call to `storeItemContextMenu` at the card site
 * because the incompatibility verdict comes from a HOOK, and the card is rendered
 * inside a `.map`. Only reached when `canInstall`, so the read-only web store is
 * untouched: there, the card carries no lifecycle verbs and a menu holding
 * nothing but "Report" would be worse than none.
 */
function AppCardContextMenu({
	item,
	onInstall,
	onDisable,
	onOpen,
	onOpenSettings,
}: {
	item: AppCatalogItem;
	onDisable: () => void;
	onInstall: () => void;
	onOpen: () => void;
	onOpenSettings?: (() => void) | null;
}) {
	const incompatible = useEntryIncompatibility(item.entry);
	const reportCtx = useOptionalReport();
	const target = reportTargetForApp(item);
	const canReport = Boolean(reportCtx && target);
	const onReport = () => reportCtx?.open(target);
	const [communityDialogOpen, setCommunityDialogOpen] = useState(false);
	const publisherTrust = item.entry.publisher_trust;
	const needsCommunityDisclosure =
		!item.installed && publisherTrust === "dotted";
	const guardedInstall = () => {
		if (needsCommunityDisclosure) {
			setCommunityDialogOpen(true);
			return;
		}
		onInstall();
	};
	const communityDisclosure = needsCommunityDisclosure ? (
		<PublisherInstallDisclosure
			onInstall={onInstall}
			onOpenChange={setCommunityDialogOpen}
			open={communityDialogOpen}
			publisherHealth={{
				capabilities: item.entry.capabilities,
				packageChecksum: item.entry.package_checksum,
				reviewed: item.entry.reviewed,
				signatureStatus: "unknown",
			}}
			publisherTrust={publisherTrust ?? "dotted"}
		/>
	) : null;

	// A mandatory listing is un-removable and un-disableable (Core 403s both), so
	// it gets the locked shape: Settings and Report only.
	if (isMandatoryListing(item.entry)) {
		return (
			<>
				{storeItemContextMenu({
					canReport,
					installed: true,
					locked: true,
					onOpenSettings: onOpenSettings ?? undefined,
					onReport,
				})}
				{communityDisclosure}
			</>
		);
	}
	return (
		<>
			{storeItemContextMenu({
				canReport,
				enabled: item.enabled,
				incompatible,
				installed: item.installed,
				onDisable,
				onEnable: onOpen,
				onInstall: guardedInstall,
				onOpenSettings: onOpenSettings ?? undefined,
				onReport,
			})}
			{communityDisclosure}
		</>
	);
}

function AppCardAction({
	item,
	canInstall,
	pending,
	downloadCount,
	onInstall,
	onDisable,
	onOpen,
	onOpenSettings,
}: {
	item: AppCatalogItem;
	canInstall: boolean;
	pending: boolean;
	downloadCount?: number | null;
	onInstall: () => void;
	onDisable: () => void;
	onOpen: () => void;
	/** Reveal this listing's settings tab; absent when it declares none. */
	onOpenSettings?: (() => void) | null;
}) {
	// Called before every early return below — rules of hooks. Re-evaluates the
	// listing's declared floors with THIS client's surface versions overlaid on
	// Core's verdict, which is what makes a desktop/island floor enforceable at all
	// (Core cannot observe those surfaces and reports them as advisory).
	const incompatible = useEntryIncompatibility(item.entry);

	// A mandatory listing gets NO lifecycle control at all — not a disabled one.
	// Core refuses both disable and uninstall for it with a 403 and no force
	// override, so any button here could only ever produce an error toast. A greyed
	// button would still read as "there is something to do here"; the honest UI is a
	// static label saying why the controls are absent.
	if (isMandatoryListing(item.entry)) {
		// It still gets a Settings route, though: "cannot be removed" says nothing
		// about "cannot be configured", and a required app is often the one with the
		// most to configure. The overflow renders nothing when there is no settings
		// destination, so the badge stays alone in that case.
		return (
			<div className="flex shrink-0 items-center gap-1">
				<Badge className="text-xs" variant="secondary">
					Required
				</Badge>
				<StoreItemOverflowMenu onOpenSettings={onOpenSettings ?? undefined} />
			</div>
		);
	}
	if (item.entry.descriptor_only || !canInstall) {
		return (
			<div className="flex items-center gap-1.5">
				<PriceBadge entry={item.entry} />
				<StoreItemAction
					affordance={
						<Button onClick={onOpen} size="sm" variant="ghost">
							Details
						</Button>
					}
					installed={false}
					onOpenSettings={onOpenSettings ?? undefined}
					reportTarget={reportTargetForApp(item)}
				/>
			</div>
		);
	}
	return (
		<div className="flex items-center gap-1.5">
			{/* Price sits beside the action, not inside it: a paid listing the user
			    already owns still installs with the normal button, so the amount is
			    disclosure rather than a call to action. */}
			{item.installed ? null : <PriceBadge entry={item.entry} />}
			<StoreItemAction
				busy={pending}
				downloadCount={downloadCount}
				enabled={item.enabled}
				incompatible={incompatible}
				installed={item.installed}
				onDisable={onDisable}
				onEnable={onOpen}
				onInstall={onInstall}
				onOpenSettings={onOpenSettings ?? undefined}
				publisherHealth={{
					capabilities: item.entry.capabilities,
					packageChecksum: item.entry.package_checksum,
					reviewed: item.entry.reviewed,
					signatureStatus: "unknown",
				}}
				publisherTrust={item.entry.publisher_trust}
				reportTarget={reportTargetForApp(item)}
			/>
		</div>
	);
}

/** The listing's price as a short label, or `null` when it is free.
 *
 *  Exported for unit tests. Free is represented by an ABSENT `pricing` (that is what
 *  the hosted catalog emits), so a zero amount is treated as free too rather than
 *  rendering "$0.00" — a price badge that says nothing costs attention for nothing. */
export function priceLabel(entry: CatalogEntry): string | null {
	const amount = entry.pricing?.amountMinor;
	if (typeof amount !== "number" || amount <= 0) {
		return null;
	}
	return formatPrice(amount, entry.pricing?.currency ?? "usd");
}

/** Paid-listing badge. Rendered on the card and in the detail header, because the
 *  unified first-party view interleaves the free git catalog with the hosted paid
 *  listings — without it the two are indistinguishable until checkout. */
function PriceBadge({ entry }: { entry: CatalogEntry }) {
	const label = priceLabel(entry);
	if (!label) {
		return null;
	}
	return (
		<Badge
			className="shrink-0 font-heading text-xs tabular-nums"
			variant="outline"
		>
			{label}
		</Badge>
	);
}

function reportTargetForApp(item: AppCatalogItem) {
	const origin = item.entry.origin;
	const source =
		origin === "community"
			? ("github-community" as const)
			: item.entry.provenance === "github-topic" ||
					item.entry.source?.includes("github")
				? ("github-curated" as const)
				: ("mongo" as const);
	return {
		id: item.entry.id,
		kind: "plugin",
		itemName: item.entry.name,
		homepage: item.entry.repo_url ?? null,
		installSource: item.entry.source ?? item.entry.repo_url ?? null,
		source,
	};
}

/** The Add / Enable / Disable button — the ONE control the preview dialog exists
 *  for, and therefore the one that rides in the hero, right-aligned on the title's
 *  row (see {@link ListingHero.actions}).
 *
 *  It used to sit on a solid band below the hero, on the reasoning that "a button
 *  on a saturated dither either loses its own surface colour or has to fake one".
 *  That is true of a GHOST button and false of a filled one — but the old
 *  reasoning was still half right, and honouring it is what the move actually
 *  costs: every branch below had to be re-surfaced. The Add button was `ghost`
 *  (no fill), the two link/Disable buttons were `outline` (border only), and two
 *  branches were bare `text-muted-foreground` prose. All four dissolve into an
 *  author-supplied wash. They are `secondary` + {@link HERO_CTA_CLASS}, or a
 *  hero-toned `StatusBadge`, so each keeps a surface the scrim cannot eat.
 *
 *  Split from {@link AppSecondaryActions} along STATE, not along layout: this half
 *  owns the install-time train choice and the enable-grant confirmation, which are
 *  driven by these buttons; the other half owns the post-install train switch and
 *  its confirmation. The two are mutually exclusive (`installed`), so only one of
 *  them ever resolves the channel list and there is still exactly one fetch.
 *
 *  Enable is gated behind a grant-confirmation dialog because enable is where the
 *  Gateway validates (and may deny) the app's declared grants. On a read-only
 *  surface (installLayer === null) this renders the host's affordance (Open in Ryu)
 *  instead of the lifecycle buttons. */
/** Every hero CTA gets an opaque surface of its own.
 *
 *  The hero wash is an author-supplied dither under a black scrim: a `ghost`
 *  button has no fill at all and an `outline` one has only a border, so both
 *  dissolve into whatever colour the listing happens to declare. `secondary`
 *  gives a real plate, and the ring lifts it off a busy wash without inventing a
 *  second button style. */
const HERO_CTA_CLASS = "shadow-sm ring-1 ring-black/10";

function AppPrimaryAction({
	item,
	install,
	installing,
	installTaskId,
	setEnabled,
	lifecyclePending,
	installLayer,
	renderAffordance,
	modelProviders,
}: {
	item: AppCatalogItem;
	install: (
		id?: string,
		options?: { channel?: string | null }
	) => Promise<void>;
	installing: boolean;
	/** Download-center task id this listing's add reports progress on, so the
	 *  button fills from the real transfer instead of guessing by label. */
	installTaskId: string;
	setEnabled: (enabled: boolean) => Promise<void>;
	lifecyclePending: boolean;
	installLayer: CatalogInstall | null;
	renderAffordance: CatalogHost["renderAffordance"];
	/** Provider-backed sidecars need a stronger disclosure than a raw grant list. */
	modelProviders?: CatalogModelProvider[] | null;
}) {
	const host = useCatalogHost();
	const node = host.useActiveNode();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const { entry, grants, installed, enabled } = item;
	const providers = modelProviders ?? [];

	// Which train to ADD. Resolved only before install — the post-install "which
	// train do I follow" question belongs to AppSecondaryActions, and the two are
	// mutually exclusive, so between them the list is fetched once.
	const { channels } = useListingChannels(
		entry.id,
		entry.repo_url,
		installed ? undefined : host.fetchListingChannels
	);
	const [channel, setChannel] = useState<string | null>(null);

	// Rejections are captured into the hook's `error` state (rendered by
	// AppSecondaryActions), so these fire-and-forget handlers swallow them to
	// avoid a floating promise.
	const noop = () => {
		// intentionally empty: error is surfaced via the hook
	};
	const runDisable = () => {
		setEnabled(false).catch(noop);
	};
	const runInstall = () => {
		install(entry.id, channel ? { channel } : undefined).catch(noop);
	};
	const confirmEnable = () => {
		setConfirmOpen(false);
		setEnabled(true).catch(noop);
	};

	let action: ReactNode;
	if (isMandatoryListing(entry)) {
		// Required for Core: no lifecycle buttons, and a sentence saying why rather
		// than a silently empty footer. Checked FIRST so it beats every branch below,
		// including the install/enable ones — a mandatory app is always already
		// installed and enabled, so any other branch could only offer a wrong verb.
		action = (
			// A chip, not a paragraph of muted prose: this renders on the hero's
			// dither under a black scrim, where `text-muted-foreground` is close to
			// unreadable and a sentence competes with the listing's own name.
			<StatusBadge
				kind="builtin"
				label="Part of Ryu — required, and cannot be disabled or removed"
				tone="hero"
			/>
		);
	} else if (entry.descriptor_only) {
		// integrations.sh ships only a docs link, never a runnable config. For an
		// MCP directory entry we can still reach a real one-click install: hand off
		// to the in-app MCP catalog (backed by the official MCP registry),
		// pre-filtered by name, which resolves + installs the server. Desktop only
		// (an install layer + a navigate seam present); web keeps the docs link.
		if (entry.integration_kind === "mcp" && installLayer && host.navigate) {
			const openMcpCatalog = () =>
				host.navigate?.(`/store/mcp/q/${encodeURIComponent(entry.name)}`);
			action = (
				<Button onClick={openMcpCatalog} size="sm">
					<HugeiconsIcon className="size-4" icon={Download01Icon} />
					Find in MCP catalog
				</Button>
			);
		} else if (entry.integration_kind === "openapi" && installLayer) {
			// A REST API directory entry: import its OpenAPI spec as gateway-governed
			// `http` tools (resolved server-side via apis.guru from the entry id).
			action = (
				<ImportToolsAction
					body={{ id: entry.id }}
					endpoint="/api/tools/import/openapi"
					node={node}
				/>
			);
		} else if (
			entry.integration_kind === "graphql" &&
			installLayer &&
			entry.integration_url
		) {
			// A GraphQL endpoint: import it as a single gateway-governed query tool.
			action = (
				<ImportToolsAction
					body={{ name: entry.name, url: entry.integration_url }}
					endpoint="/api/tools/import/graphql"
					node={node}
				/>
			);
		} else {
			const href = safeHttpUrl(entry.integration_url);
			action = href ? (
				<Button
					className={HERO_CTA_CLASS}
					render={<a href={href} rel="noopener noreferrer" target="_blank" />}
					size="sm"
					variant="secondary"
				>
					<HugeiconsIcon className="size-4" icon={Link01Icon} />
					View setup docs
				</Button>
			) : (
				<StatusBadge
					kind="unavailable"
					label="Browse-only descriptor — no install URL on file"
					tone="hero"
				/>
			);
		}
	} else if (!installLayer) {
		// Read-only surface: no local install; deep-link into the Ryu app instead.
		action =
			renderAffordance?.({
				id: entry.id,
				name: entry.name,
				realm: "app",
			}) ?? null;
	} else if (!installed) {
		const InstallButton = installLayer.InstallButton;
		action = (
			<>
				<ChannelPicker
					channels={channels}
					onChange={setChannel}
					value={channel}
				/>
				<InstallButton
					busyLabel="Adding…"
					idleVariant="default"
					installing={installing}
					onClick={runInstall}
					// The exact task id, not just the display name: Core labels a plugin
					// download row with the plugin ID, so a name hint never matched and the
					// button showed whichever single download happened to be running.
					progress={{
						kinds: ["tool", "other"],
						name: entry.id,
						taskId: installTaskId,
					}}
				>
					<HugeiconsIcon className="size-4" icon={Download01Icon} />
					Add
				</InstallButton>
			</>
		);
	} else if (enabled) {
		action = (
			<Button
				className={HERO_CTA_CLASS}
				loading={lifecyclePending}
				onClick={runDisable}
				size="sm"
				variant="secondary"
			>
				Disable
			</Button>
		);
	} else {
		action = (
			<Button
				loading={lifecyclePending}
				onClick={() => setConfirmOpen(true)}
				size="sm"
			>
				Enable
			</Button>
		);
	}

	return (
		<>
			{action}
			{/* Enable confirmation: list grants before enabling. Install-only.
			    Rendered from here because `confirmOpen` is this component's state and
			    the button that sets it is right above; the dialog itself portals out,
			    so living inside the hero costs it nothing. */}
			{installLayer ? (
				<AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Enable {entry.name}?</AlertDialogTitle>
							<AlertDialogDescription>
								{grants.length === 0
									? "This plugin requests no special permissions."
									: "Enabling grants this plugin the following permissions. They are validated by the Gateway."}
							</AlertDialogDescription>
						</AlertDialogHeader>
						{providers.length > 0 ? (
							<AuthBridgeConsent providers={providers} />
						) : null}
						{grants.length > 0 && <GrantList grants={grants} />}
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={confirmEnable}>
								Allow
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			) : null}
		</>
	);
}

/** Consent copy for a provider-backed sidecar. A grant list alone says nothing
 * about credential custody or request visibility, which is the material risk of
 * an auth bridge. */
export function AuthBridgeConsent({
	providers,
}: {
	providers: CatalogModelProvider[];
}) {
	return (
		<div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
			<p className="font-medium">Handles provider credentials and traffic</p>
			<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
				This plugin runs a local process that can handle the listed provider
				login credentials and read requests and responses routed through it.
				Enable it only if you trust the publisher.
			</p>
			<ul className="mt-2 flex flex-col gap-1 text-xs">
				{providers.map((provider) => (
					<li key={provider.id}>
						{provider.label?.trim() || provider.id}
						{provider.models?.length ? ` (${provider.models.join(", ")})` : ""}
					</li>
				))}
			</ul>
		</div>
	);
}

/** Everything the hero's CTA row is NOT: the Settings shortcut, the release-train
 *  switch for an installed listing, the price / installed-state pills, and the
 *  inline action error.
 *
 *  These stay on a solid band under the hero because each of them is prose or a
 *  bordered form control — a `Select` and a sentence do not read on a saturated
 *  dither, and an error message least of all. */
function AppSecondaryActions({
	item,
	error,
	onOpenSettings,
	status,
	switchChannel,
}: {
	item: AppCatalogItem;
	error: string | null;
	/** Reveal this listing's settings tab; absent when it declares none. */
	onOpenSettings?: (() => void) | null;
	/** Price / installed-state pills, pushed to the far end of the band. */
	status?: ReactNode;
	/** Move this INSTALLED listing onto another release train. Absent ⇒ the host
	 *  cannot update, so no switch is offered. */
	switchChannel?: (id: string, channel: string | null) => Promise<void>;
}) {
	const host = useCatalogHost();
	const { entry, installed } = item;

	// Which train an installed listing FOLLOWS. An installed listing the host
	// cannot update is the one case with no choice to make, so it does not pay for
	// the read — and neither does an uninstalled one, whose train choice belongs to
	// AppPrimaryAction.
	const canSwitch = installed && Boolean(switchChannel);
	const { channels } = useListingChannels(
		entry.id,
		entry.repo_url,
		canSwitch ? host.fetchListingChannels : undefined
	);
	// The train a switch is WAITING ON confirmation for. A switch re-resolves and
	// re-installs a different build, can move the version backwards, and is not
	// undone by picking the old train again (that resolves whatever THAT train
	// holds now, not the build you had) — so it is confirmed, like enabling is.
	const [pendingChannel, setPendingChannel] = useState<string | null>(null);
	const [switchOpen, setSwitchOpen] = useState(false);

	// The train this install follows may have no PROMOTED build — that is exactly
	// the case the pin exists for (someone on `canary` while the canary train is
	// empty). The resolved list only carries trains with a build, so the pinned one
	// is added back; without it the selector would render a value matching no
	// option and show blank for a plugin that is very much on a channel.
	const followed = item.channel ?? null;
	const switchOptions =
		followed && !channels.some((c) => c.channel === followed)
			? [...channels, { channel: followed, installable: true, version: null }]
			: channels;

	const noop = () => {
		// intentionally empty: error is surfaced via the hook
	};

	return (
		<div className="flex w-full flex-col gap-2">
			<div className="flex w-full flex-wrap items-center gap-2">
				{/* Configuring an app is not part of installing or disabling it, which
				    is why this is here and not in the hero beside the lifecycle verb —
				    but it is still where a user who just clicked into the listing looks
				    for its API key. */}
				{onOpenSettings ? (
					<Button onClick={onOpenSettings} size="sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={Settings01Icon} />
						Settings
					</Button>
				) : null}
				{/* Which train an INSTALLED listing follows, and how to change it.
				    Rendered as a live control where the host can update, and as a
				    plain badge where it cannot — a picker that could not act on its
				    own selection would be worse than no picker.

				    The badge is skipped for a stable install: that is the
				    unremarkable case, and labelling it would put a chip on every row
				    to say nothing. */}
				{canSwitch && switchOptions.length > 1 ? (
					<ChannelPicker
						channels={switchOptions}
						onChange={(next) => {
							setPendingChannel(next);
							setSwitchOpen(true);
						}}
						value={followed}
					/>
				) : installed && item.channel && item.channel !== STABLE_CHANNEL ? (
					<Badge className="text-xs" variant="outline">
						{channelLabel(item.channel)} channel
					</Badge>
				) : null}
				{status ? (
					<span className="ml-auto flex shrink-0 items-center gap-2">
						{status}
					</span>
				) : null}
			</div>
			{error && <p className="text-destructive text-sm">{error}</p>}

			{/* Channel-switch confirmation. The version delta is the whole point of
			    asking: every prerelease sorts BELOW its stable release, so moving
			    onto a beta routinely installs an OLDER build, and a one-click
			    dropdown would do that silently and unrepeatably (switching back
			    resolves whatever stable holds now, not the build you had). */}
			{canSwitch ? (
				<AlertDialog onOpenChange={setSwitchOpen} open={switchOpen}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								Follow the {channelLabel(pendingChannel ?? STABLE_CHANNEL)}{" "}
								channel?
							</AlertDialogTitle>
							<AlertDialogDescription>
								<ChannelSwitchSummary
									channels={switchOptions}
									installedVersion={item.installedVersion ?? entry.version}
									target={pendingChannel}
								/>
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								onClick={() => {
									setSwitchOpen(false);
									switchChannel?.(entry.id, pendingChannel).catch(noop);
								}}
							>
								Switch
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			) : null}
		</div>
	);
}

/** A list of permission grants in plain English (label + one-line description),
 *  so a non-technical user understands what they're approving. */
function GrantList({ grants }: { grants: string[] }) {
	return (
		<ul className="flex flex-col gap-1.5">
			{grants.map((g) => {
				const description = grantDescription(g);
				return (
					<li className="rounded-md bg-muted px-3 py-1.5" key={g}>
						<div className="font-medium text-sm">{grantLabel(g)}</div>
						{description ? (
							<div className="text-muted-foreground text-xs">{description}</div>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

/** The detail panel's tab set. Overview, Reviews and Health are ALWAYS present
 *  (see the `tabs` array below); the content tabs are conditional on the listing
 *  actually carrying that content. */
type DetailTabId =
	| "overview"
	| "readme"
	| "api"
	| "versions"
	| "dependencies"
	| "reviews"
	| "health";

function AppDetailPanel({
	selectedId,
	item,
	detail,
	detailLoading,
	detailError,
	install,
	isInstalling,
	setEnabled,
	lifecyclePending,
	error,
	installLayer,
	installVersion,
	noun,
	renderAffordance,
	settingsOpener,
	switchChannel,
}: {
	selectedId: string | null;
	item: AppCatalogItem | null;
	detail: PluginCatalogDetail | null;
	detailLoading: boolean;
	detailError: string | null;
	install: (
		id?: string,
		options?: { channel?: string | null }
	) => Promise<void>;
	/** Shared busy predicate — the same one the list rows read. */
	isInstalling: (id: string) => boolean;
	/** Move an installed listing onto another release train; absent when the host
	 *  has no update seam, and the switch control then never renders. */
	switchChannel?: (id: string, channel: string | null) => Promise<void>;
	setEnabled: (enabled: boolean) => Promise<void>;
	lifecyclePending: boolean;
	error: string | null;
	installLayer: CatalogInstall | null;
	installVersion?: (id: string, version: CatalogVersion) => Promise<void>;
	noun: string;
	renderAffordance: CatalogHost["renderAffordance"];
	/** Resolves this listing to its "open settings" action (see the host seam). */
	settingsOpener: PluginSettingsOpener;
}) {
	const host = useCatalogHost();
	const runScan = host.runCatalogScan;
	const { Markdown, fetchVersionDetail: hostFetchVersionDetail } = host;
	// How much of this listing the user has asked to see. Read ONCE here and
	// threaded down as a narrow boolean: a detail panel must not learn the ladder,
	// or every new level becomes an edit in a dozen components. The
	// one-of-two-hooks shape is the file's existing convention (see
	// `useInstallingLookup` / `usePluginSettingsOpener` above) and keeps the render
	// to exactly one hook call either way.
	const useHostInterfaceLevel = host.useInterfaceLevel ?? useNoInterfaceLevel;
	const interfaceLevel = useHostInterfaceLevel();
	// Technical detail = the four dense tabs (API, Versions, Dependencies,
	// Health), the trust/tags rail, raw grant ids and capability strings. NOT the
	// grant LABELS — see `DependenciesPanel.showTechnical`.
	const showTechnical =
		interfaceLevel === "advanced" || interfaceLevel === "expert";
	// Reviews live on the control plane, reached through the money-layer host. Read
	// optionally: a surface that mounts the catalog without the money layer (test
	// harnesses, the storyboard) simply gets no Reviews tab.
	//
	// Community listings are excluded even when the service IS present: they were
	// discovered from a GitHub topic and have no record on the control plane, so a
	// review could never be stored against one. The tab would be permanently empty
	// and any attempt to post would fail with "item not found" — an affordance that
	// cannot work should not be offered.
	const reviewsHost = useMarketplaceHostOptional()?.reviews ?? null;
	const reviewsService = item && isCommunityEntry(item) ? null : reviewsHost;
	const [tab, setTab] = useState<DetailTabId>("overview");
	// Reset to Overview when the selection changes, so opening a second listing
	// never lands on a tab that listing does not have.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetting is keyed
	// on the selection changing, not on the setter.
	useEffect(() => setTab("overview"), [selectedId]);

	// The scan needs the DETAIL payload, not just the card: half its checks read
	// fields only the detail fetch carries (README, licence, timestamps, declared
	// permissions). Grading a card alone would score every listing on a read-only
	// surface as "undocumented, unlicensed" — technically true of the card, and
	// completely misleading about the listing. So no detail ⇒ no grade shown.
	// Memoized so scrolling the panel does not re-run every check per frame.
	const scorecard = useMemo(
		() => (detail ? runScorecard(item?.entry ?? null, detail) : null),
		[item?.entry, detail]
	);

	if (!(selectedId && item)) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={GridIcon} />
					</EmptyMedia>
					<EmptyTitle>No {noun} selected</EmptyTitle>
					<EmptyDescription>
						Pick a {noun} on the left to read what it does, review its
						permissions, and install it.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	const { entry, grants, installed, enabled } = item;
	// The repo a version tag can be read from. `repositoryUrl` is the detail's
	// own field; `repo_url` is the card's — either names the same GitHub repo.
	const versionRepo = detail?.repositoryUrl ?? entry.repo_url ?? null;
	const integrationUrl =
		entry.integration_url ?? detail?.url ?? detail?.descriptor?.url ?? null;
	// The hero band always renders — it is the listing's header. This gates only
	// whether it paints the listing's ART: a descriptor-only entry's `banner` /
	// `icon_dither` describe the UPSTREAM service, so using them would present a
	// third-party brand as this listing's own. Those fall back to the muted band.
	//
	// It used to gate the whole hero, which is why a listing with no presentation
	// metadata opened on a bare heading in mid-air with no header at all.
	const showHero = !entry.descriptor_only;
	// An integrations.sh reference entry is descriptor-only AND carries an
	// integration kind. A community GitHub listing is also descriptor-only but has
	// no integration kind — it is a real plugin with a real manifest, so it gets
	// the full tab set rather than the integration blurb.
	const isIntegrationDescriptor = Boolean(
		entry.descriptor_only && entry.integration_kind
	);

	// The Overview tab is now PROSE + what-you-get. Everything reference-shaped
	// (Information, external links) moved to the shell's right rail, and the meta
	// facts moved to the stat strip — the two things that make a wide dialog read
	// as an app-store listing rather than one tall column with air beside it.
	const overview = (
		<div className="flex flex-col gap-6">
			{entry.description ? (
				<ListingSection icon={InformationCircleIcon} title="About">
					<p className="text-muted-foreground text-sm leading-relaxed">
						{entry.description}
					</p>
				</ListingSection>
			) : null}

			<SupportExtensionPanel detail={detail} entry={entry} />

			{isIntegrationDescriptor ? (
				<DescriptorDetail
					detail={detail}
					detailError={detailError}
					detailLoading={detailLoading}
					integrationUrl={integrationUrl}
				/>
			) : (
				<>
					<AppIncludedSection
						runnables={detail?.runnables ?? entry.runnables}
					/>

					<ListingSection icon={SquareLock01Icon} title="Permissions">
						{grants.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								This plugin requests no special permissions.
							</p>
						) : (
							<GrantList grants={grants} />
						)}
					</ListingSection>
				</>
			)}
		</div>
	);

	// Hero chips: the identity facts (Built-in / Community / Required / kinds).
	// Free-form `tags` stay OUT of the hero — a listing with nine of them turned
	// the header into a tag cloud — and live in the rail instead.
	// STATUS attributes leave the string row and become glyphs; "Community",
	// "Required", the stability word and the kind chips stay prose, because they
	// are facts ABOUT the listing rather than states OF it.
	const heroStatusIcons = entry.built_in ? (
		<StatusBadge kind="builtin" tone="hero" />
	) : null;
	const heroBadges = [
		isCommunityEntry(item) ? "Community" : null,
		stabilityLabel(entry.stability),
		isMandatoryListing(entry) ? "Required" : null,
		// `companion` is deliberately dropped. Every app in the Apps tab IS a
		// companion — that is the definition of the tab (`isCompanionApp` is its
		// filter) — so the chip appeared on essentially every listing and told the
		// reader nothing. The remaining kinds still distinguish one listing from
		// another and stay.
		...entry.kinds.filter((k) => k !== "companion").map((k) => k.toUpperCase()),
		...catalogLayerBadges(
			detail?.layers ?? entry.layers,
			detail?.external ?? entry.external
		),
	].filter((b): b is string => Boolean(b));

	return (
		<ListingDetailShell
			actions={
				<AppSecondaryActions
					error={error}
					item={item}
					onOpenSettings={settingsOpener(entry.id)}
					status={
						<>
							<PriceBadge entry={entry} />
							{entry.descriptor_only ? (
								<Badge variant="outline">
									{entry.integration_kind?.toUpperCase() ?? "Descriptor"}
								</Badge>
							) : (
								<AppStatusBadge enabled={enabled} installed={installed} />
							)}
						</>
					}
					switchChannel={switchChannel}
				/>
			}
			aside={
				<AppDetailAside
					detail={detail}
					entry={entry}
					onOpenHealth={() => setTab("health")}
					scorecard={scorecard}
					showTechnical={showTechnical}
				/>
			}
			gallery={
				<ListingGalleryRail
					name={entry.name}
					screenshots={detail?.screenshots ?? entry.screenshots}
				/>
			}
			hero={
				<AppHero
					actions={
						<>
							<AppPrimaryAction
								install={install}
								installing={isInstalling(entry.id)}
								installLayer={installLayer}
								installTaskId={pluginDownloadTaskId(entry.id)}
								item={item}
								lifecyclePending={lifecyclePending}
								modelProviders={detail?.apiSurface?.modelProviders}
								renderAffordance={renderAffordance}
								setEnabled={setEnabled}
							/>
							{/* Same control, same namespace key as the card it was opened
							    from, so the two can never disagree about the total. It rides
							    the hero's own translucent chip treatment because the button
							    is deliberately chrome-free and inherits a muted foreground
							    that is invisible on a saturated wash. */}
							<ItemLikeButton
								className="rounded-full bg-white/15 px-2 py-1 text-white/85 backdrop-blur-sm hover:text-white"
								namespace={entry.id}
								stopPropagation={false}
							/>
						</>
					}
					badges={heroBadges}
					detail={detail}
					entry={entry}
					showArt={showHero}
					statusIcons={heroStatusIcons}
				/>
			}
			notice={
				/* Load-bearing placement: unavoidable in the reading path BEFORE the
				   action bar, so it cannot be scrolled past on the way to Install. */
				isCommunityEntry(item) ? (
					<CommunityTrustNotice
						tone="inline"
						topic={detail?.discoveredFrom?.topic}
					/>
				) : null
			}
			stats={
				<ListingStatStrip
					items={appStatItems({
						detail,
						entry,
						onOpenHealth: () => setTab("health"),
						onOpenReviews: () => setTab("reviews"),
						scorecard,
						showTechnical,
						showRating: Boolean(reviewsService),
					})}
				/>
			}
		>
			{detailLoading && !isIntegrationDescriptor ? (
				<Spinner className="size-4" />
			) : null}
			{detailError && !isIntegrationDescriptor ? (
				<p className="text-destructive text-sm">{detailError}</p>
			) : null}

			<ListingDetailTabs
				activeTab={tab}
				agentScan={
					scorecard && runScan
						? () =>
								runScan({
									description: detail?.description ?? entry.description,
									id: entry.id,
									kind: "plugin",
									metadata: {
										developer: detail?.developer ?? entry.developer,
										license: detail?.license ?? entry.license,
										origin: detail?.origin ?? entry.origin,
										repositoryUrl: detail?.repositoryUrl ?? entry.repo_url,
										version: detail?.version ?? entry.version,
									},
									name: entry.name,
									readme: detail?.readme,
									scorecard,
								})
						: undefined
				}
				detail={detail}
				entry={entry}
				fetchVersionDetail={
					// Offered only when the host can serve it AND the listing names a repo —
					// without one there is no tag to read from.
					hostFetchVersionDetail && versionRepo
						? (tag: string) => hostFetchVersionDetail(versionRepo, tag)
						: undefined
				}
				installVersion={
					installVersion &&
					installLayer &&
					!entry.descriptor_only &&
					!isCommunityEntry(item)
						? (version) => installVersion(entry.id, version)
						: undefined
				}
				Markdown={Markdown}
				onTabChange={setTab}
				overview={overview}
				reviewsService={reviewsService}
				scorecard={scorecard}
				showTechnical={showTechnical}
			/>
		</ListingDetailShell>
	);
}

/** The stat strip's cells for an app/plugin listing. Built as data rather than
 *  markup so the same facts can be reordered per realm without each realm
 *  re-deriving them — and so an absent fact drops its whole cell rather than
 *  rendering an empty one, which is what makes the strip read as evenly divided
 *  at any listing's level of completeness. */
function appStatItems({
	detail,
	entry,
	onOpenHealth,
	onOpenReviews,
	scorecard,
	showRating,
	showTechnical,
}: {
	detail: PluginCatalogDetail | null;
	entry: CatalogEntry;
	onOpenHealth: () => void;
	onOpenReviews: () => void;
	scorecard: Scorecard | null;
	showRating: boolean;
	/** Include the Health cell. It links to the Health tab, which the same flag
	 *  hides — so the two must move together. */
	showTechnical: boolean;
}): ListingStat[] {
	// Annotated as `(ListingStat | null)[]` so an absent fact contributes `null`
	// rather than widening the array's inferred element union per branch.
	const ratingCount = entry.rating_count ?? 0;
	const version = detail?.version ?? entry.version ?? null;
	const updated = formatDate(detail?.updatedAt);
	const downloads = detail?.downloads ?? null;
	const surfaces = detail?.surfaces ?? entry.surfaces ?? [];
	const developer = detail?.developer ?? entry.developer ?? null;
	const category = detail?.category ?? entry.category ?? null;

	const cells: (ListingStat | null)[] = [
		showRating && ratingCount > 0
			? {
					label: `${formatCount(ratingCount)} Ratings`,
					// Apple's shape exactly: the number is the headline, the stars are
					// the caption. Clicking the cell opens the tab that loads them.
					onClick: onOpenReviews,
					sub: (
						<StarRating
							className="justify-center"
							size="size-3"
							value={entry.rating_average ?? 0}
						/>
					),
					value: (entry.rating_average ?? 0).toFixed(1),
				}
			: null,
		// Gated with the Health TAB it jumps to, not independently: leaving the cell
		// behind a hidden tab is a click that silently does nothing.
		showTechnical && scorecard?.grade && scorecard.score !== null
			? {
					label: "Health",
					onClick: onOpenHealth,
					sub: `${scorecard.score}/100`,
					value: scorecard.grade,
				}
			: null,
		version && !entry.descriptor_only
			? { label: "Version", value: `v${version.replace(/^v/, "")}` }
			: null,
		category ? { label: "Category", sub: "Category", value: category } : null,
		developer ? { label: "Developer", value: developer } : null,
		updated ? { label: "Updated", value: updated } : null,
		typeof downloads === "number"
			? { label: "Downloads", value: formatCount(downloads) }
			: null,
		surfaces.length > 0
			? {
					label: "Runs on",
					value: surfaces.map((s) => surfaceLabel(s)).join(", "),
				}
			: null,
	];
	return cells.filter((item): item is ListingStat => item !== null);
}

/** The detail shell's right rail for an app/plugin: Information, then the
 *  listing's free-form tags. This is the material that used to sit at the BOTTOM
 *  of the Overview tab, below permissions — i.e. below the fold on every listing —
 *  where "who made this, what licence, where's the privacy policy" is exactly what
 *  a store visitor is scanning for before they install. */
function AppDetailAside({
	detail,
	entry,
	onOpenHealth,
	scorecard,
	showTechnical,
}: {
	detail: PluginCatalogDetail | null;
	entry: CatalogEntry;
	onOpenHealth: () => void;
	scorecard: Scorecard | null;
	/** Show the reference material a technical reader wants. The Information grid
	 *  (developer, category, version, licence, links) is NOT gated by it — that is
	 *  exactly what a non-technical buyer scans. */
	showTechnical: boolean;
}) {
	const detailPrompts = detail?.examplePrompts ?? entry.example_prompts ?? [];
	const detailCapabilities = detail?.capabilities ?? entry.capabilities ?? [];
	const keywords = entry.keywords ?? [];
	const showTags = entry.tags.length > 0;
	const showKeywords = keywords.length > 0;
	const showPrompts = detailPrompts.length > 0;
	const showCapabilities = detailCapabilities.length > 0;
	// The Trust card's only control jumps to the Health tab, which is itself hidden
	// at the same level — so gating them together is what stops Simple offering a
	// click that goes nowhere.
	const showTrust = Boolean(scorecard) && showTechnical;
	const hasInfo = appInfoRows({ detail, entry }).length > 0;
	if (
		!(
			hasInfo ||
			showTags ||
			showKeywords ||
			showPrompts ||
			showCapabilities ||
			showTrust
		)
	) {
		return null;
	}
	return (
		<>
			<AppInformationSection detail={detail} entry={entry} />
			{showTrust && scorecard ? (
				<ListingAsideCard title="Trust">
					<ScorecardBadge onClick={onOpenHealth} scorecard={scorecard} />
				</ListingAsideCard>
			) : null}
			{showTags ? (
				<ListingAsideCard title="Tags">
					<div className="flex flex-wrap gap-1">
						{entry.tags.map((t) => (
							<Badge className="font-normal text-xs" key={t} variant="outline">
								{t}
							</Badge>
						))}
					</div>
				</ListingAsideCard>
			) : null}
			{showKeywords ? (
				<ListingAsideCard title="Keywords">
					<div className="flex flex-wrap gap-1">
						{keywords.map((keyword) => (
							<Badge
								className="font-normal text-xs"
								key={keyword}
								variant="secondary"
							>
								{keyword}
							</Badge>
						))}
					</div>
				</ListingAsideCard>
			) : null}
			{showCapabilities ? (
				<ListingAsideCard title="Capabilities">
					<ul className="flex flex-col gap-1 text-muted-foreground text-sm">
						{detailCapabilities.map((capability) => (
							<li key={capability}>{capability}</li>
						))}
					</ul>
				</ListingAsideCard>
			) : null}
			{showPrompts ? (
				<ListingAsideCard title="Example prompts">
					<ul className="flex flex-col gap-2 text-muted-foreground text-sm">
						{detailPrompts.map((prompt) => (
							<li className="rounded-md bg-muted px-2.5 py-2" key={prompt}>
								{prompt}
							</li>
						))}
					</ul>
				</ListingAsideCard>
			) : null}
		</>
	);
}

/** Presentational icon per bundled-runnable kind. Falls back to a package glyph
 *  for unknown kinds so an unrecognized runnable still renders a row. */
const RUNNABLE_KIND_ICONS: Record<string, typeof Package01Icon> = {
	agent: Target01Icon,
	companion: Package01Icon,
	mcp: ServerStack01Icon,
	skill: PotionIcon,
	tool: Wrench01Icon,
	workflow: WorkflowCircle06Icon,
};

/** Short human label per runnable kind (falls back to a capitalized kind). */
const RUNNABLE_KIND_LABELS: Record<string, string> = {
	agent: "Agent",
	companion: "Companion",
	mcp: "MCP",
	skill: "Skill",
	tool: "Tool",
	workflow: "Workflow",
};

function runnableKindIcon(kind: string): typeof Package01Icon {
	return RUNNABLE_KIND_ICONS[kind] ?? Package01Icon;
}

/** Exported for unit tests — see the note on {@link isCompanionApp}. */
export function runnableKindLabel(kind: string): string {
	return (
		RUNNABLE_KIND_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1)
	);
}

/** "What's included": a read-only list of the bundled runnables a full app ships
 *  (desktop-only — `detail.runnables` is absent on the web read-only host, so the
 *  section renders nothing there). Informational rows, not functional toggles. */
function AppIncludedSection({
	runnables,
}: {
	runnables?: PluginCatalogDetail["runnables"];
}) {
	if (!runnables || runnables.length === 0) {
		return null;
	}
	return (
		<section className="flex flex-col gap-2">
			<h3 className="flex items-center gap-1.5 font-medium text-sm">
				<HugeiconsIcon
					className="size-4 text-muted-foreground"
					icon={Package01Icon}
				/>
				What&apos;s included
			</h3>
			<ul className="flex flex-col gap-1.5">
				{runnables.map((runnable) => (
					<li
						className="flex items-center gap-2.5 rounded-md bg-muted px-3 py-2"
						key={runnable.id}
					>
						<HugeiconsIcon
							className="size-4 shrink-0 text-muted-foreground"
							icon={runnableKindIcon(runnable.kind)}
						/>
						<span className="min-w-0 flex-1 truncate text-sm">
							{runnable.name ?? runnable.id}
						</span>
						{/* The kind chip, EXCEPT for `companion`. In the Apps tab every
						    listing is one, so the badge repeated on every row of every
						    listing and distinguished nothing; the row's own glyph already
						    carries the kind. Deleting the map entry would not have done it
						    — `runnableKindLabel` falls back to a capitalized raw kind and
						    would still have printed "Companion". */}
						{runnable.kind === "companion" ? null : (
							<Badge className="shrink-0 text-xs" variant="secondary">
								{runnableKindLabel(runnable.kind)}
							</Badge>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}

/** Re-exported from `./plugin-id.ts` (shared with the detail tabs) because it is
 *  part of this module's tested surface — see the note on {@link isCompanionApp}. */
export { prettyPluginId } from "./plugin-id.ts";

/** The render-layer href guard now lives in `./safe-url.ts` so the detail panels
 *  share one copy. Re-exported here because it is part of this module's tested
 *  surface — see the note on {@link isCompanionApp}. */
export { safeHttpUrl } from "./safe-url.ts";

/** One value cell in the Information table. Renders as a safe external link only
 *  when `href` is a valid http(s) URL; otherwise plain text. The label half is the
 *  shell's ({@link ListingInfoGrid}) — this is only the value, so every realm's
 *  rail lays its rows out identically. */
function InfoValue({ href, value }: { href?: string | null; value: string }) {
	const safeHref = safeHttpUrl(href);
	if (!safeHref) {
		return <span className="truncate">{value}</span>;
	}
	return (
		<a
			className="truncate hover:underline"
			href={safeHref}
			rel="noopener noreferrer"
			target="_blank"
		>
			{value}
		</a>
	);
}

/** The Information rows for a listing, as data. Rows come from `detail` (desktop)
 *  falling back to `entry` (present on every surface), so on the web host — where
 *  `detail` is null — it still shows Developer/Category/Version from the entry and
 *  simply omits the detail-only rows (homepage/license/privacy/terms). */
function appInfoRows({
	detail,
	entry,
}: {
	detail: PluginCatalogDetail | null;
	entry: CatalogEntry;
}): { href?: string | null; label: string; value: string }[] {
	const version = entry.descriptor_only ? null : (entry.version ?? null);
	return [
		{
			label: "Developer",
			value:
				detail?.developer ??
				detail?.author ??
				entry.developer ??
				entry.author ??
				null,
		},
		{ label: "Category", value: detail?.category ?? entry.category ?? null },
		{ label: "Version", value: version },
		{ label: "License", value: detail?.license ?? entry.license ?? null },
		{
			href:
				detail?.repositoryUrl ?? entry.repository_url ?? entry.repo_url ?? null,
			label: "Repository",
			value:
				detail?.repositoryUrl ?? entry.repository_url ?? entry.repo_url ?? null,
		},
		{
			href: detail?.website ?? entry.website ?? entry.homepage ?? null,
			label: "Website",
			value: detail?.website ?? entry.website ?? entry.homepage ?? null,
		},
		{
			href: detail?.privacyPolicyUrl ?? entry.privacy_policy_url ?? null,
			label: "Privacy Policy",
			value: detail?.privacyPolicyUrl ?? entry.privacy_policy_url ?? null,
		},
		{
			href: detail?.termsOfServiceUrl ?? entry.terms_of_service_url ?? null,
			label: "Terms of Service",
			value: detail?.termsOfServiceUrl ?? entry.terms_of_service_url ?? null,
		},
	].filter(
		(row): row is { href?: string | null; label: string; value: string } =>
			Boolean(row.value)
	);
}

/** "Information": the key/value table. Lives in the detail shell's RIGHT RAIL
 *  now rather than at the bottom of the Overview tab — "who made this, what
 *  licence, where is the privacy policy" is what a store visitor scans for before
 *  installing, and below permissions on a tall single column it was below the fold
 *  on every listing. */
function AppInformationSection({
	detail,
	entry,
}: {
	detail: PluginCatalogDetail | null;
	entry: CatalogEntry;
}) {
	const rows = appInfoRows({ detail, entry });
	if (rows.length === 0) {
		return null;
	}
	return (
		<ListingAsideCard title="Information">
			<ListingInfoGrid
				rows={rows.map((row) => ({
					label: row.label,
					value: <InfoValue href={row.href} value={row.value} />,
				}))}
			/>
		</ListingAsideCard>
	);
}

/** The app detail hero. Thin wrapper over the shared {@link ListingHero}: this
 *  resolves the listing's ART (which is realm-specific — `icon`/`icon_url`/svgl
 *  brand marks) and the shell owns the LAYOUT (band height, scrim, icon tile,
 *  title stack, badge chips), so an app hero and an MCP hero cannot drift.
 *
 *  Always rendered, even for a listing with no presentation metadata: the band
 *  falls back to the muted surface, which is a header. It used to be omitted, and
 *  a listing without art opened with no header at all — the dialog started at a
 *  bare `<h2>` mid-air. */
function AppHero({
	actions,
	badges,
	detail,
	entry,
	showArt,
	statusIcons,
	tagline,
}: {
	/** The primary CTA cluster, right-aligned on the title row — see
	 *  {@link ListingHero.actions}. */
	actions?: ReactNode;
	badges: string[];
	/** Status glyphs for the chip row — see {@link ListingHero.statusIcons}. */
	statusIcons?: ReactNode;
	/** The loaded detail payload, when there is one. Only its verification fields
	 *  are read here: the detail is the fuller, fresher record, so it wins over the
	 *  card's copy the same way the health scorecard resolves `reviewed`. */
	detail?: PluginCatalogDetail | null;
	entry: CatalogEntry;
	/** Resolved by the caller so the detail payload's tagline can win when the
	 *  card carries none. */
	tagline?: string | null;
	/** False for descriptor-only listings, whose `icon_*` fields describe the
	 *  UPSTREAM service rather than a Ryu package — painting them as a hero would
	 *  present a third-party brand as the listing's own art. */
	showArt: boolean;
}) {
	const svglIndex = useSvglIndex();
	// Raster logo for the hero: `icon_url` (any https host), an `svgl:` brand mark,
	// or a GitHub-image URL pasted into the `icon` field (the card's
	// {@link resolveCardIcon} rule, so hero and card never disagree).
	const {
		iconId: previewIconId,
		iconUrl: previewIconUrl,
		iconUrlDark: previewIconUrlDark,
		brand: isBrandMark,
	} = resolveCardIcon({
		icon: entry.icon,
		iconUrl: entry.icon_url,
		svglIndex,
	});
	// ORG verification (who published this — NOT the manifest-signature axis the web
	// marketplace calls `verified`) is read off ONE source, never mixed. The detail
	// payload is the fresher record so it wins whole once it carries the flag —
	// including a `false`, which is how a revoked check reaches an already-rendered
	// card. Pairing the detail's flag with the card's tier would let a stale
	// qualifier survive a re-tiering the newer record already reflects. An absent
	// flag (older control plane, or an enrichment failure — see `enrichmentError`)
	// falls back to the card wholesale, the same precedence the health scorecard
	// uses for `reviewed`.
	const detailKnowsOrgVerification = detail?.orgVerified !== undefined;
	const orgVerified = detailKnowsOrgVerification
		? detail?.orgVerified
		: entry.org_verified;
	const orgVerifiedTier = detailKnowsOrgVerification
		? detail?.orgVerifiedTier
		: entry.org_verified_tier;
	const publisherTrust = detailKnowsOrgVerification
		? detail?.publisherTrust
		: entry.publisher_trust;
	const publisherVerification = detailKnowsOrgVerification
		? detail?.publisherVerification
		: entry.publisher_verification;
	return (
		<ListingHero
			actions={actions}
			badges={badges}
			banner={showArt ? (detail?.banner ?? entry.banner) : null}
			dither={showArt ? entry.icon_dither : null}
			fallback={entry.accent_color ?? null}
			icon={
				previewIconUrl ? (
					<BrandOrCoverImage
						brand={isBrandMark === true}
						dark={previewIconUrlDark ?? null}
						light={previewIconUrl}
						padding={normalizeIconPadding(entry.icon_padding)}
					/>
				) : previewIconId ? (
					<Icon icon={previewIconId} size={34} />
				) : (
					<HugeiconsIcon className="size-8" icon={GridIcon} />
				)
			}
			iconBackground={entry.icon_background ?? null}
			iconPadding={entry.icon_padding}
			name={entry.name}
			nameBadge={
				// `tone="hero"` because every foreground in this band is fixed white over
				// an author-supplied wash under a black scrim — the card's themed
				// blue-on-tint chip would be unreadable here.
				<>
					<VerifiedBadge
						orgVerified={orgVerified}
						publisherTrust={publisherTrust}
						tier={orgVerifiedTier}
						tone="hero"
						verificationDetails={publisherVerification}
					/>
					<MarketplaceAccessBadge
						className="text-white hover:text-white/75"
						membershipIncluded={Boolean(entry.membership_included)}
					/>
				</>
			}
			statusIcons={statusIcons}
			tagline={tagline}
		/>
	);
}

function DescriptorDetail({
	detail,
	detailLoading,
	detailError,
	integrationUrl,
}: {
	detail: PluginCatalogDetail | null;
	detailLoading: boolean;
	detailError: string | null;
	integrationUrl: string | null;
}) {
	return (
		<section className="flex flex-col gap-3">
			<h3 className="font-medium text-sm">Integration details</h3>
			{detailLoading ? <Spinner className="size-4" /> : null}
			{detailError ? (
				<p className="text-destructive text-sm">{detailError}</p>
			) : null}
			{integrationUrl ? (
				<p className="break-all font-mono text-muted-foreground text-xs">
					{integrationUrl}
				</p>
			) : null}
			{detail?.domain ? (
				<p className="text-muted-foreground text-sm">
					Domain: <span className="text-foreground">{detail.domain}</span>
				</p>
			) : null}
			{detail?.feeds && detail.feeds.length > 0 ? (
				<div className="flex flex-wrap gap-1">
					{detail.feeds.map((feed) => (
						<Badge className="text-xs" key={feed} variant="outline">
							{feed}
						</Badge>
					))}
				</div>
			) : null}
			<p className="text-muted-foreground text-sm">
				Descriptors are reference entries from integrations.sh — open the link
				to configure MCP, OpenAPI, or other surfaces in your agent stack.
			</p>
		</section>
	);
}

/** Status pill in the detail header: Enabled > Added > nothing. */
function AppStatusBadge({
	enabled,
	installed,
}: {
	enabled: boolean;
	installed: boolean;
}) {
	if (enabled) {
		return (
			<Badge className="shrink-0 gap-1" variant="secondary">
				<HugeiconsIcon
					className="size-3.5 text-success"
					icon={CheckmarkCircle02Icon}
				/>
				Enabled
			</Badge>
		);
	}
	if (installed) {
		return (
			<Badge className="shrink-0" variant="outline">
				Installed
			</Badge>
		);
	}
	return null;
}
