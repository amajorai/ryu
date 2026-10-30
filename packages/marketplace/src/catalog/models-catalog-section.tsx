import { SlidersHorizontalIcon } from "@hugeicons/core-free-icons";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ResizableMasterDetail from "./chrome/resizable-master-detail.tsx";
import StoreListHeader from "./chrome/store-list-header.tsx";
import { useStoreToolbar } from "./chrome/store-toolbar.tsx";
import { useCatalogHost } from "./host.tsx";
import { useSyncInstalledOnly } from "./installed-filter.tsx";
import { ModelDetailPanel } from "./models-catalog-section-detail-panel.tsx";
import { ModelsFilterPanel } from "./models-catalog-section-filter-panel.tsx";
import {
	buildModelChips,
	filterModelsByTokens,
} from "./models-catalog-section-format.ts";
import { ModelList } from "./models-catalog-section-list.tsx";
import { useFriendlyMode } from "./use-friendly-mode.ts";

export {
	ModelsFilterPanel,
	type ModelsFilterPanelProps,
} from "./models-catalog-section-filter-panel.tsx";
export {
	buildModelChips,
	deviceSummaryLines,
	filterModelsByTokens,
	fineTuneHrefForModel,
	formatAgo,
	formatContext,
	formatCount,
	formatDate,
	formatParams,
} from "./models-catalog-section-format.ts";

/**
 * Models catalog as an embeddable Store section, shared by desktop and web.
 * Desktop injects its real Core-node model-catalog hook + install layer through
 * the {@link useCatalogHost} seam; web injects a federated adapter with
 * `install: null`, so the install/enable/source/active/fine-tune touchpoints
 * collapse to an "Open in Ryu" affordance.
 */
export default function ModelsCatalogSection({
	initialQuery = "",
	initialSelectedId,
}: {
	/** Seed the search box (e.g. carried over from the store-wide search). */
	initialQuery?: string;
	/** Open this item's preview on arrival — the id of a card clicked on the
	 *  Store's Home shelves. */
	initialSelectedId?: string;
} = {}) {
	const host = useCatalogHost();
	const {
		models,
		loading,
		error,
		fetchNextPage,
		hasNextPage,
		loadingMore,
		query,
		setQuery,
		sort,
		setSort,
		category,
		setCategory,
		installedOnly,
		setInstalledOnly,
		format,
		setFormat,
		org,
		setOrg,
		browseOrg,
		selectedId,
		select,
		detail,
		detailLoading,
		detailError,
		installing,
		install,
		installSnapshot,
		installingSnapshot,
		uninstall,
		uninstalling,
		sources,
		activeSource,
		selectSource,
		selectingSource,
	} = host.useModelCatalog(initialQuery);

	// The shell's "installed only" switch (the retired "Added" tab, inverted).
	// Pushed into this section's OWN filter rather than applied over `models`:
	// here the flag narrows the request, so filtering the returned array would
	// only hide rows from a page the server already scoped.
	useSyncInstalledOnly(setInstalledOnly);

	// A Home shelf card opens this section with its item already selected. One
	// shot, latched: the prop is a arrival instruction, not a controlled value, so
	// re-running it would fight the user's own next click (and `select` changes
	// identity on every refetch, which would make a plain dep array do exactly
	// that).
	const preselected = useRef(false);
	useEffect(() => {
		if (!initialSelectedId || preselected.current) {
			return;
		}
		preselected.current = true;
		select(initialSelectedId);
	}, [initialSelectedId, select]);

	const [friendly, setFriendly] = useFriendlyMode();
	// Raw Hugging Face tags in the list are off by default — there are a lot of
	// them, so they're opt-in.
	const [showTags, setShowTags] = host.usePersistedToggle(
		"ryu.catalog.showTags",
		false
	);
	// Active token-badge filters, refined client-side over the loaded pages.
	const [activeTokens, setActiveTokens] = useState<Set<string>>(new Set());

	const toggleToken = useCallback((id: string) => {
		setActiveTokens((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	// Apply active token filters to whatever pages are loaded. The org is also
	// enforced here as a defensive guard: Core sends `author=`, but mirrors or
	// cached pages should never leak out-of-org cards into an active org view.
	const filteredModels = useMemo(
		() => filterModelsByTokens(models, activeTokens, org),
		[models, activeTokens, org]
	);

	const chips = useMemo(
		() => buildModelChips(org, activeTokens, setOrg, toggleToken),
		[org, activeTokens, setOrg, toggleToken]
	);

	// Publish search + filters into the floating bottom nav. The signature lists
	// every primitive that changes the rendered controls; callbacks are captured
	// live by the panel node, so they stay out of the deps signal.
	const toolbarSig = [
		query,
		category,
		sort,
		format,
		friendly,
		installedOnly,
		showTags,
		activeSource,
		selectingSource,
		sources.length,
		org,
		[...activeTokens].sort().join(","),
	].join("|");
	useStoreToolbar(
		{
			panel: (
				<ModelsFilterPanel
					activeSource={activeSource}
					activeTokens={activeTokens}
					category={category}
					chips={chips}
					format={format}
					friendly={friendly}
					installedOnly={installedOnly}
					selectingSource={selectingSource}
					selectSource={selectSource}
					setCategory={setCategory}
					setFormat={setFormat}
					setFriendly={setFriendly}
					setInstalledOnly={setInstalledOnly}
					setShowTags={setShowTags}
					setSort={setSort}
					showInstalledOnly={host.install !== null}
					showTags={showTags}
					sort={sort}
					sources={sources}
					toggleToken={toggleToken}
				/>
			),
			panelLabel: "Filters",
			panelIcon: SlidersHorizontalIcon,
		},
		[toolbarSig]
	);

	return (
		<TooltipProvider delay={0}>
			<div className="flex h-full flex-col overflow-hidden">
				{/* Body: master-detail, resizable divider */}
				<div className="min-h-0 flex-1 overflow-hidden">
					<ResizableMasterDetail
						detail={
							<ModelDetailPanel
								activeTokens={activeTokens}
								detail={detail}
								error={detailError}
								friendly={friendly}
								install={install}
								installing={installing}
								installingSnapshot={installingSnapshot}
								installSnapshot={installSnapshot}
								loading={detailLoading}
								onSelectOrg={browseOrg}
								onToggleToken={toggleToken}
								selectedId={selectedId}
								uninstall={uninstall}
								uninstalling={uninstalling}
							/>
						}
						list={
							<ModelList
								error={error}
								fetchNextPage={fetchNextPage}
								friendly={friendly}
								hasNextPage={hasNextPage}
								installedOnly={installedOnly}
								loading={loading}
								loadingMore={loadingMore}
								models={filteredModels}
								onClearFilters={() => {
									setQuery("");
									setCategory("all");
									setFormat("gguf");
									setInstalledOnly(false);
									setOrg("");
									setSort("trending");
									setActiveTokens(new Set());
								}}
								onRetry={fetchNextPage}
								onSelect={select}
								selectedId={selectedId}
								showTags={showTags}
							/>
						}
						listHeader={
							<StoreListHeader
								search={{
									value: query,
									onChange: setQuery,
									placeholder:
										"Search by name, org, tag, or type (e.g. llama, google, coder, uncensored)…",
								}}
							/>
						}
						storageKey="ryu.store.models.split"
					/>
				</div>
			</div>
		</TooltipProvider>
	);
}
