import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	CheckmarkCircle02Icon,
	Delete01Icon,
	Download01Icon,
	PencilEdit01Icon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { DitherAvatar } from "@ryu/ui/components/dither-kit/avatar.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@ryu/ui/components/resizable.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { formatCount as formatSharedCount } from "@ryu/ui/lib/number-format.ts";
import {
	type ComponentType,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type ActiveChip,
	FilterChipBar,
	ORG_ICON,
} from "./chrome/catalog-badges.tsx";
import InfiniteSentinel from "./chrome/infinite-sentinel.tsx";
import PacksShelf from "./chrome/packs-shelf.tsx";
import StoreCatalogCard from "./chrome/store-catalog-card.tsx";
import StoreCatalogLayout, {
	StoreCardGrid,
} from "./chrome/store-catalog-layout.tsx";
import StoreItemAction, {
	storeItemContextMenu,
} from "./chrome/store-item-action.tsx";
import StoreShelfHeading from "./chrome/store-shelf-heading.tsx";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingInfoGrid,
	type ListingInfoRow,
	ListingSection,
	type ListingStat,
	ListingStatStrip,
} from "./detail/listing-detail-shell.tsx";
import { ScorecardPanel } from "./detail/scorecard-panel.tsx";
import { skillOrg, titleCase } from "./friendly.ts";
import {
	type CatalogHost,
	type CatalogInstall,
	type CatalogMarkdownProps,
	type PluginSettingsOpener,
	useCatalogHost,
	useNoSettingsOpener,
} from "./host.tsx";
import { useSyncInstalledOnly } from "./installed-filter.tsx";
import { REALM_ICONS } from "./realm-icons.ts";
import { safeHttpUrl } from "./safe-url.ts";
import { runSkillScorecard } from "./scorecard.ts";
import type {
	AddMarketplaceParams,
	MarketplaceMoveDirection,
	SkillCard,
	SkillCatalogSource,
	SkillDetail,
	SkillSort,
} from "./types.ts";
import { useFriendlyMode } from "./use-friendly-mode.ts";

/**
 * Sort options for the skills list. The skills.sh directory carries no category
 * taxonomy (only install counts), so sort — not a category filter — is what's
 * applicable here.
 */
const SORT_OPTIONS: { value: SkillSort; label: string }[] = [
	{ value: "popular", label: "Most installed" },
	{ value: "name", label: "Name (A–Z)" },
];

/** Shared count policy, exported for the catalog helper tests. */
export function formatCount(n: number): string {
	return formatSharedCount(n) ?? "—";
}

function skillTrustLabel(value: string | null | undefined): string | null {
	if (value === "builtin") {
		return "Built-in source";
	}
	if (value === "trusted") {
		return "Trusted source";
	}
	if (value === "community") {
		return "Community source";
	}
	return value?.trim() || null;
}

/**
 * Resolve a catalog card to the on-disk skill id used by the enable/disable
 * toggle. The installed id (the `~/.claude/skills/<id>/` dir name) usually equals
 * the catalog slug; fall back to the card id. Returns `null` when neither is a
 * known installed key, so the caller can hide the toggle instead of targeting a
 * non-existent id.
 */
export function resolveSkillKey(
	enabledByKey: Record<string, boolean>,
	card: SkillCard
): string | null {
	if (enabledByKey[card.slug] !== undefined) {
		return card.slug;
	}
	if (enabledByKey[card.id] !== undefined) {
		return card.id;
	}
	return null;
}

export function formatDateLabel(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return value;
	}
	return parsed.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

export function isMarkdownFile(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".mdx");
}

/**
 * Whether to render the SKILL.md authoring affordances (New skill / Edit).
 *
 * Two independent conditions, and getting only the first was a live bug:
 *   1. `navigate` — the host CAN deep link. A read-only surface (web) omits it.
 *   2. `canAuthorSkills` — the deep link LANDS somewhere. The editor is a Ryu App
 *      (`@ryu/skill-editor`) that ships default-OFF, and desktop always has
 *      `navigate`, so on a fresh install every New/Edit button opened a tab reading
 *      "App not enabled". Omitted ⇒ `true`, so hosts with no notion of app
 *      enablement keep the old `navigate`-only behaviour.
 *
 * Exported (rather than inlined at the use site) because both consumers — the filter
 * panel's "New skill" button and the detail pane's Edit — mount inside the
 * Dialog-portaled preview that `renderToStaticMarkup` never emits, so this is the
 * only place the rule can actually be asserted. Deliberately NOT named
 * `canAuthorSkills`: that is the host FIELD this reads, and a function sharing its
 * name invites `host.canAuthorSkills` where the two-condition rule was meant.
 */
export function skillAuthoringEnabled(
	host: Pick<CatalogHost, "canAuthorSkills" | "navigate">
): boolean {
	return Boolean(host.navigate) && host.canAuthorSkills !== false;
}

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

/** Filter popover: sort + source picker + friendly/installed switches + chips.
 *  The search box itself lives directly in the toolbar (see the layout's `search`
 *  prop); this is the "Filters" popover beside it. */
function SkillsFilterPanel({
	sort,
	setSort,
	sources,
	addMarketplace,
	addingMarketplace,
	removeMarketplace,
	reorderMarketplace,
	friendly,
	setFriendly,
	installedOnly,
	setInstalledOnly,
	onCreate,
	canAuthor,
	chips,
}: {
	sort: SkillSort;
	setSort: (s: SkillSort) => void;
	sources: SkillCatalogSource[];
	addMarketplace: (params: AddMarketplaceParams) => Promise<void>;
	addingMarketplace: boolean;
	removeMarketplace: (id: string) => Promise<void>;
	reorderMarketplace: (
		id: string,
		direction: MarketplaceMoveDirection
	) => Promise<void>;
	friendly: boolean;
	setFriendly: (v: boolean) => void;
	installedOnly: boolean;
	setInstalledOnly: (v: boolean) => void;
	onCreate: () => void;
	canAuthor: boolean;
	chips: ActiveChip[];
}) {
	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					{canAuthor ? (
						<Button onClick={onCreate} size="sm" variant="ghost">
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							New skill
						</Button>
					) : null}
					<Select
						items={SORT_OPTIONS}
						onValueChange={(v) => setSort(v as SkillSort)}
						value={sort}
					>
						<SelectTrigger className="h-8 w-[150px] text-sm" size="sm">
							<SelectValue placeholder="Sort" />
						</SelectTrigger>
						<SelectContent>
							{SORT_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<SkillSourcePicker
						addingMarketplace={addingMarketplace}
						addMarketplace={addMarketplace}
						removeMarketplace={removeMarketplace}
						reorderMarketplace={reorderMarketplace}
						sources={sources}
					/>
				</div>
				<div className="flex items-center gap-4 text-sm">
					<div className="flex items-center gap-2">
						<Switch
							aria-label="Friendly names"
							checked={friendly}
							id="friendly-skills"
							onCheckedChange={setFriendly}
						/>
						<label className="cursor-pointer" htmlFor="friendly-skills">
							Friendly names
						</label>
					</div>
					<div className="flex items-center gap-2">
						<Switch
							aria-label="Show only installed skills"
							checked={installedOnly}
							id="skills-installed-only"
							onCheckedChange={setInstalledOnly}
						/>
						<label className="cursor-pointer" htmlFor="skills-installed-only">
							Added only
						</label>
					</div>
				</div>
			</div>
			<FilterChipBar chips={chips} />
		</div>
	);
}

/**
 * Marketplace management popover. The catalog always shows every source; this
 * control is only for adding a custom marketplace and maintaining its order.
 */
function SkillSourcePicker({
	sources,
	addMarketplace,
	addingMarketplace,
	removeMarketplace,
	reorderMarketplace,
}: {
	sources: SkillCatalogSource[];
	addMarketplace: (params: AddMarketplaceParams) => Promise<void>;
	addingMarketplace: boolean;
	removeMarketplace: (id: string) => Promise<void>;
	reorderMarketplace: (
		id: string,
		direction: MarketplaceMoveDirection
	) => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [repo, setRepo] = useState("");
	const [name, setName] = useState("");
	const [addError, setAddError] = useState<string | null>(null);
	const [sourceActionId, setSourceActionId] = useState<string | null>(null);
	const customSources = sources.filter((source) => !source.builtin);

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

	const runSourceAction = async (id: string, action: () => Promise<void>) => {
		setSourceActionId(id);
		setAddError(null);
		try {
			await action();
		} catch (e) {
			setAddError(
				e instanceof Error ? e.message : "Failed to update marketplace"
			);
		} finally {
			setSourceActionId(null);
		}
	};

	return (
		<div className="flex items-center gap-2">
			<Popover onOpenChange={setOpen} open={open}>
				<Tooltip>
					<TooltipTrigger
						render={
							<PopoverTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground">
								<HugeiconsIcon className="size-4" icon={Add01Icon} />
								Add marketplace
							</PopoverTrigger>
						}
					/>
					<TooltipContent>Add or manage skill marketplaces</TooltipContent>
				</Tooltip>
				<PopoverContent className="w-[24rem]">
					<div className="flex flex-col gap-4">
						<div className="flex flex-col gap-1">
							<p className="font-medium text-sm">Marketplaces</p>
							<p className="text-muted-foreground text-xs">
								All registered sources are shown in the catalog. Custom
								marketplaces can be reordered or removed here.
							</p>
						</div>
						<div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
							{sources.map((source) => {
								const customIndex = customSources.findIndex(
									(item) => item.id === source.id
								);
								const manageable = !source.builtin;
								const busy = sourceActionId === source.id;
								return (
									<div
										className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
										key={source.id}
									>
										<div className="min-w-0 flex-1">
											<p className="truncate text-sm">{source.displayName}</p>
											<p className="text-muted-foreground text-xs">
												{manageable
													? "Custom marketplace"
													: "Built-in registry"}
											</p>
										</div>
										{manageable ? (
											<div className="flex shrink-0 items-center gap-0.5">
												<Button
													aria-label={`Move ${source.displayName} up`}
													disabled={sourceActionId !== null || customIndex <= 0}
													onClick={() => {
														runSourceAction(source.id, () =>
															reorderMarketplace(source.id, "up")
														).catch(() => undefined);
													}}
													size="icon"
													variant="ghost"
												>
													<HugeiconsIcon
														className="size-4"
														icon={ArrowUp01Icon}
													/>
												</Button>
												<Button
													aria-label={`Move ${source.displayName} down`}
													disabled={
														sourceActionId !== null ||
														customIndex === customSources.length - 1
													}
													onClick={() => {
														runSourceAction(source.id, () =>
															reorderMarketplace(source.id, "down")
														).catch(() => undefined);
													}}
													size="icon"
													variant="ghost"
												>
													<HugeiconsIcon
														className="size-4"
														icon={ArrowDown01Icon}
													/>
												</Button>
												<Button
													aria-label={`Delete ${source.displayName}`}
													disabled={sourceActionId !== null}
													loading={busy}
													onClick={() => {
														runSourceAction(source.id, () =>
															removeMarketplace(source.id)
														).catch(() => undefined);
													}}
													size="icon"
													variant="ghost"
												>
													{!busy && (
														<HugeiconsIcon
															className="size-4"
															icon={Delete01Icon}
														/>
													)}
												</Button>
											</div>
										) : (
											<span className="shrink-0 text-muted-foreground text-xs">
												Built-in
											</span>
										)}
									</div>
								);
							})}
						</div>
						<div className="flex flex-col gap-3 border-t pt-3">
							<div className="flex flex-col gap-1">
								<p className="font-medium text-sm">Add marketplace</p>
								<p className="text-muted-foreground text-xs">
									Connect a repo, git URL, or local marketplace path.
								</p>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="mp-repo">Repo, git URL, or local path</Label>
								<Input
									id="mp-repo"
									onChange={(e) => setRepo(e.target.value)}
									placeholder="owner/repo or /path/to/marketplace"
									value={repo}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="mp-name">Display name (optional)</Label>
								<Input
									id="mp-name"
									onChange={(e) => setName(e.target.value)}
									placeholder="My Marketplace"
									value={name}
								/>
							</div>
							{addError && (
								<p className="text-destructive text-xs">{addError}</p>
							)}
							<Button
								disabled={sourceActionId !== null}
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
					</div>
				</PopoverContent>
			</Popover>
		</div>
	);
}

export interface SkillSourceSection {
	id: string;
	label: string;
	skills: SkillCard[];
}

/** Group the federated result by the registry that produced each card. */
export function groupSkillsBySource(
	skills: readonly SkillCard[]
): SkillSourceSection[] {
	const sections = new Map<string, SkillSourceSection>();
	for (const skill of skills) {
		const id = skill.catalogSourceId ?? skill.source ?? "other";
		const existing = sections.get(id);
		if (existing) {
			existing.skills.push(skill);
			continue;
		}
		sections.set(id, {
			id,
			label: skill.catalogSourceName ?? skill.source ?? "Other marketplaces",
			skills: [skill],
		});
	}
	return [...sections.values()];
}

function SkillList({
	skills,
	loading,
	error,
	selectedId,
	onSelect,
	groupBySource,
	cardInstall,
	setSkillEnabled,
	enabledByKey,
	installing,
	togglingSkill,
	fetchNextPage,
	hasNextPage,
	onClearFilters,
	onRetry,
	settingsOpener,
}: {
	skills: SkillCard[];
	loading: boolean;
	error: string | null;
	selectedId: string | null;
	onSelect: (id: string) => void;
	groupBySource: boolean;
	cardInstall: (id: string) => void;
	setSkillEnabled: (id: string, active: boolean) => Promise<void>;
	enabledByKey: Record<string, boolean>;
	installing: string | null;
	togglingSkill: string | null;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	onClearFilters: () => void;
	onRetry: () => void;
	/** Resolves a card to the settings of the plugin that ships it, when one does. */
	settingsOpener: PluginSettingsOpener;
}) {
	// The IntersectionObserver root is the layout's scroll column, not the viewport.
	const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
	const sections = groupBySource
		? groupSkillsBySource(skills)
		: [{ id: "all", label: "", skills }];
	const sourceShelved = groupBySource && sections.length > 1;
	const renderCard = (s: SkillCard) => (
		<StoreCatalogCard
			action={
				<SkillCardAction
					card={s}
					downloadCount={s.downloads}
					enabled={enabledByKey[s.id]}
					installBusy={installing === s.id}
					onDisable={() => {
						setSkillEnabled(s.id, false).catch(() => undefined);
					}}
					onEnable={() => {
						setSkillEnabled(s.id, true).catch(() => undefined);
					}}
					onInstall={() => cardInstall(s.id)}
					onOpenSettings={settingsOpener(s.id)}
					toggleBusy={togglingSkill === s.id}
				/>
			}
			// The same verbs the card's own control offers, installed states
			// included — the gesture used to work only on skills you had not
			// added yet, which is the half with the least to do to it.
			contextMenu={storeItemContextMenu({
				enabled: s.installed ? enabledByKey[s.id] : undefined,
				installed: s.installed,
				onDisable: () => {
					setSkillEnabled(s.id, false).catch(() => undefined);
				},
				onEnable: () => {
					setSkillEnabled(s.id, true).catch(() => undefined);
				},
				onInstall: () => cardInstall(s.id),
				onOpenSettings: settingsOpener(s.id) ?? undefined,
			})}
			// The SKILL.md one-liner when the source could give us one
			// without a per-card round trip (installed skills always can),
			// else the provenance line every card showed before.
			description={
				s.description?.trim() ||
				(s.installs > 0
					? `${s.source} · ${formatCount(s.installs)} installs`
					: s.source)
			}
			icon={<HugeiconsIcon className="size-5" icon={REALM_ICONS.skills} />}
			key={s.id}
			// A skill's `owner/repo[/subdir]` id IS its namespace — the same
			// string the fetcher installs from — so it keys likes exactly as
			// an app's `@scope/name` does.
			likeNamespace={s.id}
			name={s.name}
			onClick={() => onSelect(s.id)}
			seedId={s.id}
			selected={s.id === selectedId}
		/>
	);

	if (loading && skills.length === 0) {
		return (
			<div className="flex items-center justify-center p-8 text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (error) {
		return (
			<Empty className="h-full p-6">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={SparklesIcon} />
					</EmptyMedia>
					<EmptyTitle>Couldn&apos;t load skills</EmptyTitle>
					<EmptyDescription>{error}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onRetry} size="sm" variant="ghost">
						Try again
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
	if (skills.length === 0) {
		return (
			<Empty className="h-full p-6">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={SparklesIcon} />
					</EmptyMedia>
					<EmptyTitle>No skills found</EmptyTitle>
					<EmptyDescription>Try a different search.</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onClearFilters} size="sm" variant="ghost">
						Clear filters
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	return (
		<div ref={setScrollEl}>
			{sourceShelved ? (
				<div className="flex flex-col gap-6">
					{sections.map((section) => (
						<section key={section.id}>
							<StoreShelfHeading>{section.label}</StoreShelfHeading>
							<StoreCardGrid>{section.skills.map(renderCard)}</StoreCardGrid>
						</section>
					))}
				</div>
			) : (
				<StoreCardGrid>{skills.map(renderCard)}</StoreCardGrid>
			)}
			<InfiniteSentinel
				hasMore={hasNextPage}
				loading={false}
				onLoadMore={fetchNextPage}
				root={scrollEl}
			/>
		</div>
	);
}

/** Card action for a skill: Add (not installed) or an Enabled↔Disabled morph
 *  once installed. `enabled` is `enabledByKey[id]` (undefined when the on-disk key
 *  isn't the card id, which collapses to the plain "Installed" affordance). */
function SkillCardAction({
	card,
	enabled,
	installBusy,
	downloadCount,
	toggleBusy,
	onInstall,
	onEnable,
	onDisable,
	onOpenSettings,
}: {
	card: SkillCard;
	enabled: boolean | undefined;
	installBusy: boolean;
	downloadCount?: number | null;
	toggleBusy: boolean;
	onInstall: () => void;
	onEnable: () => void;
	onDisable: () => void;
	/** Set for a skill shipped by an installed plugin that declares settings; a
	 *  plain SKILL.md has none and gets no Settings row. */
	onOpenSettings?: (() => void) | null;
}) {
	return (
		<StoreItemAction
			busy={installBusy || toggleBusy}
			downloadCount={downloadCount}
			enabled={card.installed ? enabled : undefined}
			installed={card.installed}
			onDisable={onDisable}
			onEnable={onEnable}
			onInstall={onInstall}
			onOpenSettings={onOpenSettings ?? undefined}
		/>
	);
}

function SkillDetailPanel({
	selectedId,
	detail,
	distributeSkill,
	loading,
	error,
	install,
	installing,
	friendly,
	onSelectOrg,
	enabledByKey,
	onToggleEnabled,
	togglingSkill,
	onCreate,
	onEdit,
	canAuthor,
	installLayer,
	renderAffordance,
	runCatalogScan,
	Markdown,
}: {
	selectedId: string | null;
	detail: SkillDetail | null;
	distributeSkill: CatalogHost["distributeSkill"];
	loading: boolean;
	error: string | null;
	install: () => Promise<void>;
	installing: string | null;
	friendly: boolean;
	onSelectOrg: (org: string) => void;
	enabledByKey: Record<string, boolean>;
	onToggleEnabled: (id: string, active: boolean) => Promise<void>;
	togglingSkill: string | null;
	onCreate: () => void;
	onEdit: (skillId: string) => void;
	canAuthor: boolean;
	installLayer: CatalogInstall | null;
	renderAffordance: CatalogHost["renderAffordance"];
	runCatalogScan: CatalogHost["runCatalogScan"];
	Markdown: ComponentType<CatalogMarkdownProps>;
}) {
	if (!selectedId) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={SparklesIcon} />
					</EmptyMedia>
					<EmptyTitle>No skill selected</EmptyTitle>
					<EmptyDescription>
						Pick a skill on the left to read what it does and add it to your
						agents{canAuthor ? " — or author your own." : "."}
					</EmptyDescription>
				</EmptyHeader>
				{canAuthor ? (
					<EmptyContent>
						<Button onClick={onCreate}>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							New skill
						</Button>
					</EmptyContent>
				) : null}
			</Empty>
		);
	}
	if (loading && !detail) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (error) {
		return (
			<div className="p-4 text-destructive text-sm">
				Couldn't load this skill: {error}
			</div>
		);
	}
	if (!detail) {
		return null;
	}

	const { card, description, metadata, readme, url } = detail;
	// On-disk skill id for the enable/disable toggle (null when unresolvable, so
	// the toggle degrades to the plain "Installed" badge instead of silently
	// targeting a non-existent id).
	const skillKey = resolveSkillKey(enabledByKey, card);
	const skillEnabled = skillKey ? (enabledByKey[skillKey] ?? false) : false;
	const isToggling = skillKey !== null && togglingSkill === skillKey;
	const owner = skillOrg(card);
	const installs =
		metadata.installs ??
		(card.installs > 0 ? formatCount(card.installs) : null);
	// Only show a Downloads figure when the skill actually reports one; falling
	// back to the Installs value would render two rows with an identical number,
	// which reads as a data error.
	const downloads =
		(card.downloads ?? 0) > 0 ? formatCount(card.downloads ?? 0) : null;

	const title = friendly ? titleCase(card.name) : card.name;
	const sourceLabel = card.source || "skills.sh";
	const trustLabel = skillTrustLabel(card.trustLevel);
	const scorecard = runSkillScorecard(card, detail);
	const agentScan = runCatalogScan
		? () =>
				runCatalogScan({
					description,
					files: detail.files,
					id: card.id,
					kind: "skill",
					metadata: {
						githubStars: metadata.githubStars,
						repositoryUrl: metadata.repositoryUrl,
						securityAudits: metadata.securityAudits,
						source: card.source,
						trustLevel: card.trustLevel,
					},
					name: card.name,
					readme,
					scorecard,
				})
		: undefined;

	return (
		<ListingDetailShell
			actions={
				<>
					<SkillDetailAction
						canAuthor={canAuthor}
						card={card}
						distributeSkill={distributeSkill}
						install={install}
						installing={installing}
						installLayer={installLayer}
						isToggling={isToggling}
						onEdit={onEdit}
						onToggleEnabled={onToggleEnabled}
						renderAffordance={renderAffordance}
						skillEnabled={skillEnabled}
						skillKey={skillKey}
					/>
					<span className="ml-auto flex shrink-0 items-center gap-2">
						{owner ? (
							<Tooltip>
								<TooltipTrigger
									render={
										<button
											className="text-muted-foreground text-xs underline decoration-dotted underline-offset-2 hover:text-foreground"
											onClick={() => onSelectOrg(owner)}
											type="button"
										>
											More by {owner}
										</button>
									}
								/>
								<TooltipContent>Browse all skills by {owner}</TooltipContent>
							</Tooltip>
						) : null}
					</span>
				</>
			}
			aside={
				<SkillDetailAside
					metadata={metadata}
					sourceLabel={sourceLabel}
					url={url}
				/>
			}
			hero={
				<ListingHero
					badges={[
						card.installed ? (skillEnabled ? "Enabled" : "Added") : null,
						sourceLabel,
						trustLabel,
					].filter((b): b is string => Boolean(b))}
					icon={
						// Skills carry no art of their own — no manifest, no icon field. The
						// generative tile keyed on the skill id is the same rule
						// `AppIcon` uses for an artless app, so a skill still reads as
						// *that* skill rather than as one repeated grey glyph.
						<DitherAvatar
							animate={false}
							className="size-full"
							name={card.id}
						/>
					}
					name={title}
					tagline={description}
				/>
			}
			stats={
				<ListingStatStrip
					items={skillStatItems({ downloads, installs, metadata })}
				/>
			}
		>
			<ListingSection title="Health">
				<ScorecardPanel
					agentScan={agentScan}
					key={card.id}
					scorecard={scorecard}
				/>
			</ListingSection>
			{readme ? (
				<ListingSection title="README">
					<div className="prose prose-sm dark:prose-invert max-w-none text-sm">
						<Markdown className="[&_ol]:pl-10 [&_ul]:pl-9" content={readme} />
					</div>
				</ListingSection>
			) : (
				<p className="text-muted-foreground text-sm">
					This skill ships no README.
				</p>
			)}
		</ListingDetailShell>
	);
}

/** The skill stat strip. Only facts the source ACTUALLY reported get a cell —
 *  the old metadata grid rendered "Not reported" in seven boxes for a skill with
 *  no GitHub link, which is a wall of nothing where the headline numbers go. The
 *  unreported ones still appear, as rows, in the rail. */
function skillStatItems({
	downloads,
	installs,
	metadata,
}: {
	downloads: string | null;
	installs: string | null;
	metadata: SkillDetail["metadata"];
}): ListingStat[] {
	const audits = metadata.securityAudits;
	const passed = audits.filter((a) => a.status.toLowerCase() === "pass").length;
	const cells: (ListingStat | null)[] = [
		installs ? { label: "Installs", value: installs } : null,
		downloads ? { label: "Downloads", value: downloads } : null,
		metadata.githubStars
			? { label: "Stars", value: metadata.githubStars }
			: null,
		formatDateLabel(metadata.githubPushedAt)
			? {
					label: "Last push",
					value: formatDateLabel(metadata.githubPushedAt) as string,
				}
			: null,
		metadata.firstSeen
			? { label: "First seen", value: metadata.firstSeen }
			: null,
		audits.length > 0
			? {
					label: "Audits",
					sub: `${passed}/${audits.length} pass`,
					value: formatCount(audits.length) ?? "—",
				}
			: null,
	];
	return cells.filter((cell): cell is ListingStat => cell !== null);
}

/** The skill detail rail: provenance rows, then the security-audit list. The
 *  audits were previously buried under a seven-box grid at the bottom of the
 *  header — for a listing whose whole trust story IS the audit, that is the one
 *  thing that should not need scrolling to. */
function SkillDetailAside({
	metadata,
	sourceLabel,
	url,
}: {
	metadata: SkillDetail["metadata"];
	sourceLabel: string;
	url: string;
}) {
	const rows: (ListingInfoRow | null)[] = [
		{ label: "Source", value: sourceLabel },
		metadata.repositoryUrl
			? {
					label: "Repository",
					value: <SkillLink href={metadata.repositoryUrl} label="GitHub" />,
				}
			: null,
		{ label: "Listing", value: <SkillLink href={url} label="Open" /> },
		formatDateLabel(metadata.githubCreatedAt)
			? {
					label: "Created",
					value: formatDateLabel(metadata.githubCreatedAt) as string,
				}
			: null,
		formatDateLabel(metadata.githubUpdatedAt)
			? {
					label: "Updated",
					value: formatDateLabel(metadata.githubUpdatedAt) as string,
				}
			: null,
	];

	return (
		<>
			<ListingAsideCard title="Information">
				<ListingInfoGrid
					rows={rows.filter((row): row is ListingInfoRow => row !== null)}
				/>
			</ListingAsideCard>
			<ListingAsideCard title="Security audits">
				<SkillAuditList audits={metadata.securityAudits} />
			</ListingAsideCard>
		</>
	);
}

/** External link in the skill rail, scheme-guarded like every other catalog href. */
function SkillLink({ href, label }: { href: string; label: string }) {
	const safe = safeHttpUrl(href);
	if (!safe) {
		return <span className="text-muted-foreground">Unavailable</span>;
	}
	return (
		<a
			className="hover:underline"
			href={safe}
			rel="noopener noreferrer"
			target="_blank"
		>
			{label}
		</a>
	);
}

/** The primary action cluster in the skill detail header: install / enable-toggle
 *  on an install-capable surface (desktop), or the read-only "Open in Ryu"
 *  affordance where `installLayer` is null (web). */
function SkillDetailAction({
	card,
	distributeSkill,
	install,
	installing,
	installLayer,
	renderAffordance,
	skillKey,
	skillEnabled,
	isToggling,
	onToggleEnabled,
	onEdit,
	canAuthor,
}: {
	card: SkillCard;
	distributeSkill: CatalogHost["distributeSkill"];
	install: () => Promise<void>;
	installing: string | null;
	installLayer: CatalogInstall | null;
	renderAffordance: CatalogHost["renderAffordance"];
	skillKey: string | null;
	skillEnabled: boolean;
	isToggling: boolean;
	onToggleEnabled: (id: string, active: boolean) => Promise<void>;
	onEdit: (skillId: string) => void;
	canAuthor: boolean;
}) {
	if (!installLayer) {
		// Read-only surface: no local install; deep-link into the Ryu app instead.
		return (
			renderAffordance?.({
				id: card.id,
				name: card.name,
				realm: "skill",
			}) ?? null
		);
	}

	if (!card.installed) {
		const InstallButton = installLayer.InstallButton;
		return (
			<InstallButton
				idleVariant="ghost"
				installing={installing === card.id}
				onClick={() => {
					install().catch(() => undefined);
				}}
				progress={{ kinds: ["skill"], name: card.name }}
			>
				<HugeiconsIcon className="size-4" icon={Download01Icon} />
				Add skill
			</InstallButton>
		);
	}

	return (
		<div className="flex shrink-0 items-center gap-3">
			{distributeSkill ? (
				<Button
					onClick={() => {
						distributeSkill(card.id).catch(() => undefined);
					}}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={Download01Icon} />
					Use with agents
				</Button>
			) : null}
			{canAuthor && skillKey !== null ? (
				<Button onClick={() => onEdit(skillKey)} size="sm" variant="ghost">
					<HugeiconsIcon className="size-4" icon={PencilEdit01Icon} />
					Edit
				</Button>
			) : null}
			<Badge className="gap-1" variant="secondary">
				<HugeiconsIcon
					className="size-3.5 text-success"
					icon={CheckmarkCircle02Icon}
				/>
				Added
			</Badge>
			{skillKey === null ? null : (
				<div className="flex items-center gap-1.5">
					{isToggling ? <Spinner className="size-3.5" /> : null}
					<Switch
						aria-label={skillEnabled ? "Disable skill" : "Enable skill"}
						checked={skillEnabled}
						disabled={isToggling}
						id={`skill-enabled-${card.id}`}
						onCheckedChange={(v) => {
							onToggleEnabled(skillKey, v).catch(() => undefined);
						}}
					/>
					<Label
						className="cursor-pointer text-muted-foreground text-xs"
						htmlFor={`skill-enabled-${card.id}`}
					>
						{skillEnabled ? "Enabled" : "Disabled"}
					</Label>
				</div>
			)}
		</div>
	);
}

/** The security-audit list, as a rail card. Extracted from the old
 *  `SkillMetadataGrid`, whose other half (a 2-column "Not reported" x7 box grid)
 *  is now the stat strip + the Information rows: a fact the source did report is
 *  a headline cell, a fact it did not is a rail row, and neither is a box of the
 *  word "Not reported". */
function SkillAuditList({
	audits,
}: {
	audits: SkillDetail["metadata"]["securityAudits"];
}) {
	if (audits.length === 0) {
		return (
			<p className="text-muted-foreground text-xs">
				Nobody has published an audit of this skill.
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-1.5">
			{audits.map((audit) => {
				const href = safeHttpUrl(audit.url);
				const body = (
					<>
						<div className="flex items-center justify-between gap-2">
							<span className="font-medium">{audit.name}</span>
							<span
								className={
									audit.status.toLowerCase() === "pass"
										? "font-mono text-success uppercase"
										: "font-mono text-warning uppercase"
								}
							>
								{audit.status}
							</span>
						</div>
						{audit.risk_level ? (
							<div className="mt-1 text-muted-foreground">
								Risk: {audit.risk_level}
							</div>
						) : null}
						{audit.summary ? (
							<div className="mt-1 line-clamp-2 text-muted-foreground">
								{audit.summary}
							</div>
						) : null}
					</>
				);
				const className =
					"block w-full rounded-md border border-border/60 px-3 py-2 text-xs";
				return href ? (
					<a
						className={`${className} transition-colors hover:bg-accent/50`}
						href={href}
						key={audit.name}
						rel="noopener noreferrer"
						target="_blank"
					>
						{body}
					</a>
				) : (
					<div className={className} key={audit.name}>
						{body}
					</div>
				);
			})}
		</div>
	);
}

function SkillFilesPanel({
	selectedId,
	detail,
	loading,
	Markdown,
}: {
	selectedId: string | null;
	detail: SkillDetail | null;
	loading: boolean;
	Markdown: ComponentType<CatalogMarkdownProps>;
}) {
	const files = detail?.files ?? [];
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const paths = useMemo(() => files.map((file) => file.path), [files]);
	const selectedFile =
		files.find((file) => file.path === selectedPath) ?? files[0] ?? null;

	useEffect(() => {
		setSelectedPath(files[0]?.path ?? null);
	}, [files]);

	if (!selectedId) {
		return <div className="border-l" />;
	}
	if (loading && !detail) {
		return (
			<div className="flex h-full items-center justify-center border-l text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (files.length === 0) {
		return (
			<div className="flex h-full items-center justify-center border-l text-muted-foreground text-sm">
				No bundled files.
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-col border-l">
			<div className="border-b px-3 py-2">
				<h3 className="font-medium text-sm">
					Files ({formatCount(files.length) ?? "—"})
				</h3>
			</div>
			{/* File navigator (tree + flat list) vs. content are a resizable vertical
			    split — drag the handle to give either side more room. */}
			<ResizablePanelGroup className="min-h-0 flex-1" orientation="vertical">
				<ResizablePanel defaultSize={45} id="nav" minSize={20}>
					<div className="flex h-full min-h-0 flex-col">
						<div className="min-h-0 flex-1 overflow-auto">
							<SkillFileTree
								onSelect={setSelectedPath}
								paths={paths}
								selectedPath={selectedFile?.path ?? null}
							/>
						</div>
						<div className="max-h-40 shrink-0 overflow-auto border-t p-2">
							<div className="flex flex-col gap-1">
								{files.map((file) => {
									const active = file.path === selectedFile?.path;
									return (
										<button
											className={`truncate rounded-md px-2 py-1.5 text-left font-mono text-xs transition-colors ${
												active
													? "bg-accent text-foreground"
													: "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
											}`}
											key={file.path}
											onClick={() => setSelectedPath(file.path)}
											type="button"
										>
											{file.path}
										</button>
									);
								})}
							</div>
						</div>
					</div>
				</ResizablePanel>
				<ResizableHandle withHandle />
				<ResizablePanel defaultSize={55} id="content" minSize={25}>
					<SkillFileContent
						file={selectedFile}
						Markdown={Markdown}
						readme={detail?.readme ?? null}
					/>
				</ResizablePanel>
			</ResizablePanelGroup>
		</div>
	);
}

function SkillFileTree({
	paths,
	selectedPath,
	onSelect,
}: {
	paths: string[];
	selectedPath: string | null;
	onSelect: (path: string) => void;
}) {
	const { model } = useFileTree({
		flattenEmptyDirectories: true,
		initialExpansion: "open",
		initialSelectedPaths: selectedPath ? [selectedPath] : [],
		onSelectionChange: (selectedPaths) => {
			const [path] = selectedPaths;
			if (path && paths.includes(path)) {
				onSelect(path);
			}
		},
		paths,
		search: true,
	});

	return (
		<FileTree
			className="h-full w-full"
			model={model}
			style={{ height: "100%" }}
		/>
	);
}

function SkillFileContent({
	file,
	readme,
	Markdown,
}: {
	file: SkillDetail["files"][number] | null;
	readme: string | null;
	Markdown: ComponentType<CatalogMarkdownProps>;
}) {
	if (!file) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
				Select a file.
			</div>
		);
	}

	const content =
		file.contents ||
		(file.path.toLowerCase().endsWith("skill.md") ? readme : null) ||
		"";
	const hasContent = content.trim().length > 0;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="truncate border-b px-3 py-2 font-mono text-muted-foreground text-xs">
				{file.path}
			</div>
			{hasContent && isMarkdownFile(file.path) ? (
				<div className="scroll-fade prose prose-sm dark:prose-invert min-h-0 max-w-none flex-1 overflow-auto p-3 text-sm">
					<Markdown className="[&_ol]:pl-10 [&_ul]:pl-9" content={content} />
				</div>
			) : (
				<pre className="scroll-fade min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed">
					{content || "This file is empty."}
				</pre>
			)}
		</div>
	);
}
