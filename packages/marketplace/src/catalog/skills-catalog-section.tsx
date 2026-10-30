import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ActiveChip, ORG_ICON } from "./chrome/catalog-badges.tsx";
import PacksShelf from "./chrome/packs-shelf.tsx";
import StoreCatalogLayout from "./chrome/store-catalog-layout.tsx";
import { useCatalogHost, useNoSettingsOpener } from "./host.tsx";
import { useSyncInstalledOnly } from "./installed-filter.tsx";
import { SkillDetailPanel } from "./skills-catalog-section-detail.tsx";
import { SkillFilesPanel } from "./skills-catalog-section-files.tsx";
import { SkillsFilterPanel } from "./skills-catalog-section-filter-panel.tsx";
import { SkillList } from "./skills-catalog-section-list.tsx";
import { skillAuthoringEnabled } from "./skills-catalog-section-model.ts";
import { useFriendlyMode } from "./use-friendly-mode.ts";

export {
	formatCount,
	formatDateLabel,
	groupSkillsBySource,
	isMarkdownFile,
	resolveSkillKey,
	type SkillSourceSection,
	skillAuthoringEnabled,
} from "./skills-catalog-section-model.ts";

/**
 * Skills catalog Store section, shared by desktop and web. Browses the live
 * federated catalog by default (skills.sh, GitHub taps, browse.sh, ClawHub,
 * LobeHub, Ryu/custom marketplaces) joined with live installed/enabled state,
 * and drives install → enable → disable on desktop.
 *
 * Desktop injects its real Core-node catalog hook + install layer + `navigate`
 * (which unlocks the SKILL.md authoring UI) through the {@link CatalogHost}; web
 * injects a federated adapter with `install: null` and no `navigate`, so the
 * install/enable/source/authoring touchpoints collapse to an "Open in Ryu"
 * affordance.
 */
export default function SkillsCatalogSection({
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
	const auditNode = host.useActiveNode();
	// One resolver for the section (a host implementation reads live node state to
	// answer it), threaded to the cards. Null for a plain SKILL.md, which is most.
	const usePluginSettingsOpener =
		host.usePluginSettingsOpener ?? useNoSettingsOpener;
	const settingsOpener = usePluginSettingsOpener();
	const {
		skills,
		loading,
		error,
		fetchNextPage,
		hasNextPage,
		query,
		setQuery,
		sort,
		setSort,
		installedOnly,
		setInstalledOnly,
		org,
		setOrg,
		selectedId,
		select,
		detail,
		detailLoading,
		detailError,
		installing,
		install,
		sources,
		addMarketplace,
		addingMarketplace,
		removeMarketplace,
		reorderMarketplace,
		enabledByKey,
		setSkillEnabled,
		togglingSkill,
	} = host.useSkillsCatalog(initialQuery);

	// The shell's "installed only" switch (the retired "Added" tab, inverted),
	// pushed into this section's own filter — the one the data layer understands.
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

	const canAuthor = skillAuthoringEnabled(host);
	const openNewSkill = useCallback(() => {
		host.navigate?.("/skills/new");
	}, [host]);
	const openEditSkill = useCallback(
		(skillId: string) => {
			host.navigate?.(`/skills/${skillId}/edit`);
		},
		[host]
	);

	const chips: ActiveChip[] = useMemo(() => {
		if (!org) {
			return [];
		}
		return [
			{
				key: `org:${org}`,
				label: `Org: ${org}`,
				icon: ORG_ICON,
				onRemove: () => setOrg(""),
			},
		];
	}, [org, setOrg]);

	// Per-card lifecycle without a per-id hook: the hook's install() acts on the
	// SELECTED skill, so a card's Install selects its skill and defers the call
	// until the selection lands (non-racy — the effect fires only once selectedId
	// matches). Enable/disable are ID-based (setSkillEnabled), so they run inline.
	const [pending, setPending] = useState<{ id: string } | null>(null);

	useEffect(() => {
		if (!pending || selectedId !== pending.id) {
			return;
		}
		install().catch(() => {
			// Errors surface through the hook's error state in the detail panel.
		});
		setPending(null);
	}, [pending, selectedId, install]);

	const cardInstall = (id: string) => {
		setPending({ id });
		select(id);
	};

	return (
		<TooltipProvider delay={0}>
			<StoreCatalogLayout
				detail={
					<div className="grid h-full min-w-0 grid-cols-[minmax(0,1fr)_minmax(280px,36%)] overflow-hidden">
						<div className="min-h-0 overflow-auto border-r">
							<SkillDetailPanel
								auditScope={auditNode.url}
								canAuthor={canAuthor}
								detail={detail}
								distributeSkill={host.distributeSkill}
								enabledByKey={enabledByKey}
								error={detailError}
								friendly={friendly}
								install={install}
								installing={installing}
								installLayer={host.install}
								loading={detailLoading}
								Markdown={host.Markdown}
								onCreate={openNewSkill}
								onEdit={openEditSkill}
								onOpenAuditConversation={host.openAuditConversation}
								onSelectOrg={setOrg}
								onToggleEnabled={setSkillEnabled}
								renderAffordance={host.renderAffordance}
								runCatalogScan={host.runCatalogScan}
								selectedId={selectedId}
								togglingSkill={togglingSkill}
							/>
						</div>
						<SkillFilesPanel
							detail={detail}
							loading={detailLoading}
							Markdown={host.Markdown}
							selectedId={selectedId}
						/>
					</div>
				}
				detailTitle={detail?.card.name ?? "Skill"}
				filter={{
					panel: (
						<SkillsFilterPanel
							addingMarketplace={addingMarketplace}
							addMarketplace={addMarketplace}
							canAuthor={canAuthor}
							chips={chips}
							friendly={friendly}
							installedOnly={installedOnly}
							onCreate={openNewSkill}
							removeMarketplace={removeMarketplace}
							reorderMarketplace={reorderMarketplace}
							setFriendly={setFriendly}
							setInstalledOnly={setInstalledOnly}
							setSort={setSort}
							showInstalledOnly={host.install !== null}
							sort={sort}
							sources={sources}
						/>
					),
					label: "Filters",
					activeCount: (org ? 1 : 0) + (installedOnly ? 1 : 0),
				}}
				// `Boolean`, NOT `!= null`. Closing the preview calls `select("")`, and
				// every host's `select` stores what it is given — so `!= null` stayed
				// true on an EMPTY id: the dialog re-opened itself on close, with no
				// selection to render ("No skill selected"), and no further click could
				// dismiss it. Every other section already tests truthiness; this was the
				// one that did not.
				hasSelection={Boolean(selectedId)}
				list={
					<>
						{/* The Packs shelf rides above the searchable grid — packs are the
						    curated "get a whole collection at once" surface, skills the
						    individual rows. It renders nothing when the host has no pack
						    seam (a read-only web host before packs federate). */}
						<PacksShelf />
						<SkillList
							cardInstall={cardInstall}
							enabledByKey={enabledByKey}
							error={error}
							fetchNextPage={fetchNextPage}
							groupBySource
							hasNextPage={hasNextPage}
							installing={installing}
							loading={loading}
							onClearFilters={() => {
								setQuery("");
								setInstalledOnly(false);
								setOrg("");
							}}
							onRetry={fetchNextPage}
							onSelect={select}
							selectedId={selectedId}
							setSkillEnabled={setSkillEnabled}
							settingsOpener={settingsOpener}
							skills={skills}
							togglingSkill={togglingSkill}
						/>
					</>
				}
				onCloseDetail={() => select("")}
				search={{
					value: query,
					onChange: setQuery,
					placeholder: "Search skills…",
				}}
			/>
		</TooltipProvider>
	);
}
