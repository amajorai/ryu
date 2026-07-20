import {
	Add01Icon,
	CheckmarkCircle02Icon,
	Download01Icon,
	PencilEdit01Icon,
	PuzzleIcon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
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
import {
	type ComponentType,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	type ActiveChip,
	FilterChipBar,
	ORG_ICON,
} from "./chrome/catalog-badges.tsx";
import InfiniteSentinel from "./chrome/infinite-sentinel.tsx";
import StoreCatalogCard from "./chrome/store-catalog-card.tsx";
import StoreCatalogLayout, {
	StoreCardGrid,
} from "./chrome/store-catalog-layout.tsx";
import StoreItemAction from "./chrome/store-item-action.tsx";
import { skillOrg, titleCase } from "./friendly.ts";
import {
	type CatalogHost,
	type CatalogInstall,
	type CatalogMarkdownProps,
	useCatalogHost,
} from "./host.tsx";
import type {
	AddMarketplaceParams,
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

/** Format a large count as a friendly short string (1234567 → "1.2M"). */
function formatCount(n: number): string {
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(1)}M`;
	}
	if (n >= 1000) {
		return `${(n / 1000).toFixed(1)}k`;
	}
	return String(n);
}

/**
 * Resolve a catalog card to the on-disk skill id used by the enable/disable
 * toggle. The installed id (the `~/.claude/skills/<id>/` dir name) usually equals
 * the catalog slug; fall back to the card id. Returns `null` when neither is a
 * known installed key, so the caller can hide the toggle instead of targeting a
 * non-existent id.
 */
function resolveSkillKey(
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

function formatDateLabel(value: string | null): string | null {
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

function isMarkdownFile(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".mdx");
}

/**
 * Skills catalog Store section, shared by desktop and web. Browses the active
 * catalog source (skills.sh by default, or a custom Claude plugin marketplace)
 * joined with live installed/enabled state, and drives install → enable → disable
 * on desktop.
 *
 * Desktop injects its real Core-node catalog hook + install layer + `navigate`
 * (which unlocks the SKILL.md authoring UI) through the {@link CatalogHost}; web
 * injects a federated adapter with `install: null` and no `navigate`, so the
 * install/enable/source/authoring touchpoints collapse to an "Open in Ryu"
 * affordance.
 */
export default function SkillsCatalogSection({
	initialQuery = "",
}: {
	/** Seed the search box (e.g. carried over from the store-wide search). */
	initialQuery?: string;
} = {}) {
	const host = useCatalogHost();
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
		activeSource,
		selectSource,
		selectingSource,
		addMarketplace,
		addingMarketplace,
		enabledByKey,
		setSkillEnabled,
		togglingSkill,
	} = host.useSkillsCatalog(initialQuery);

	const [friendly, setFriendly] = useFriendlyMode();

	// Authoring (create/edit a SKILL.md) is only reachable where the host can deep
	// link into the app. A read-only surface (web) omits `navigate`, which hides
	// every New/Edit affordance.
	const canAuthor = Boolean(host.navigate);
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
							activeSource={activeSource}
							addingMarketplace={addingMarketplace}
							addMarketplace={addMarketplace}
							canAuthor={canAuthor}
							chips={chips}
							friendly={friendly}
							installedOnly={installedOnly}
							onCreate={openNewSkill}
							selectingSource={selectingSource}
							selectSource={selectSource}
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
				hasSelection={selectedId != null}
				list={
					<SkillList
						cardInstall={cardInstall}
						enabledByKey={enabledByKey}
						error={error}
						fetchNextPage={fetchNextPage}
						hasNextPage={hasNextPage}
						installing={installing}
						loading={loading}
						onSelect={select}
						selectedId={selectedId}
						setSkillEnabled={setSkillEnabled}
						skills={skills}
						togglingSkill={togglingSkill}
					/>
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
	activeSource,
	selectSource,
	selectingSource,
	addMarketplace,
	addingMarketplace,
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
	activeSource: string;
	selectSource: (id: string) => void;
	selectingSource: boolean;
	addMarketplace: (params: AddMarketplaceParams) => Promise<void>;
	addingMarketplace: boolean;
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
						<Button onClick={onCreate} size="sm" variant="outline">
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
						activeSource={activeSource}
						addingMarketplace={addingMarketplace}
						addMarketplace={addMarketplace}
						selectingSource={selectingSource}
						selectSource={selectSource}
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
							Installed only
						</label>
					</div>
				</div>
			</div>
			<FilterChipBar chips={chips} />
		</div>
	);
}

/**
 * Source dropdown (skills.sh + any custom Claude plugin marketplaces) plus an
 * "Add marketplace" popover. A marketplace is just a repo/URL pointing at a
 * `.claude-plugin/marketplace.json`. The dropdown only shows when there is a real
 * choice; the add control is always available.
 */
function SkillSourcePicker({
	sources,
	activeSource,
	selectSource,
	selectingSource,
	addMarketplace,
	addingMarketplace,
}: {
	sources: SkillCatalogSource[];
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

	const sourceItems = sources.map((s) => ({
		value: s.id,
		label: s.displayName,
	}));

	const submit = async () => {
		const trimmedRepo = repo.trim();
		if (!trimmedRepo) {
			setAddError("Enter a repo or marketplace.json URL");
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
		<div className="flex items-center gap-2">
			{sources.length > 1 && (
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
					<SelectTrigger className="h-8 w-[150px] text-sm" size="sm">
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
				<Tooltip>
					<TooltipTrigger
						render={
							<PopoverTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground">
								<HugeiconsIcon className="size-4" icon={Add01Icon} />
								Add marketplace
							</PopoverTrigger>
						}
					/>
					<TooltipContent>
						Add a Claude plugin marketplace as a skill source
					</TooltipContent>
				</Tooltip>
				<PopoverContent className="w-80">
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1">
							<Label htmlFor="mp-repo">Repo or marketplace.json URL</Label>
							<Input
								id="mp-repo"
								onChange={(e) => setRepo(e.target.value)}
								placeholder="owner/repo or https://…/marketplace.json"
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
						{addError && <p className="text-destructive text-xs">{addError}</p>}
						<Button
							disabled={addingMarketplace}
							onClick={() => {
								submit().catch(() => undefined);
							}}
							size="sm"
						>
							{addingMarketplace ? (
								<Spinner className="size-4" />
							) : (
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

function SkillList({
	skills,
	loading,
	error,
	selectedId,
	onSelect,
	cardInstall,
	setSkillEnabled,
	enabledByKey,
	installing,
	togglingSkill,
	fetchNextPage,
	hasNextPage,
}: {
	skills: SkillCard[];
	loading: boolean;
	error: string | null;
	selectedId: string | null;
	onSelect: (id: string) => void;
	cardInstall: (id: string) => void;
	setSkillEnabled: (id: string, active: boolean) => Promise<void>;
	enabledByKey: Record<string, boolean>;
	installing: string | null;
	togglingSkill: string | null;
	fetchNextPage: () => void;
	hasNextPage: boolean;
}) {
	// The IntersectionObserver root is the layout's scroll column, not the viewport.
	const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

	if (loading && skills.length === 0) {
		return (
			<div className="flex items-center justify-center p-8 text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (error) {
		return (
			<div className="p-4 text-destructive text-sm">
				Couldn't load skills: {error}
			</div>
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
			</Empty>
		);
	}

	return (
		<div ref={setScrollEl}>
			<StoreCardGrid>
				{skills.map((s) => (
					<StoreCatalogCard
						action={
							<SkillCardAction
								card={s}
								enabled={enabledByKey[s.id]}
								installBusy={installing === s.id}
								onDisable={() => {
									setSkillEnabled(s.id, false).catch(() => undefined);
								}}
								onEnable={() => {
									setSkillEnabled(s.id, true).catch(() => undefined);
								}}
								onInstall={() => cardInstall(s.id)}
								toggleBusy={togglingSkill === s.id}
							/>
						}
						description={
							s.installs > 0
								? `${s.source} · ${formatCount(s.installs)} installs`
								: s.source
						}
						icon={<HugeiconsIcon className="size-5" icon={PuzzleIcon} />}
						key={s.id}
						name={s.name}
						onClick={() => onSelect(s.id)}
						selected={s.id === selectedId}
					/>
				))}
			</StoreCardGrid>
			<InfiniteSentinel
				hasMore={hasNextPage}
				loading={false}
				onLoadMore={fetchNextPage}
				root={scrollEl}
			/>
		</div>
	);
}

/** Card action for a skill: Install (not installed) or an Enabled↔Disabled morph
 *  once installed. `enabled` is `enabledByKey[id]` (undefined when the on-disk key
 *  isn't the card id, which collapses to the plain "Installed" affordance). */
function SkillCardAction({
	card,
	enabled,
	installBusy,
	toggleBusy,
	onInstall,
	onEnable,
	onDisable,
}: {
	card: SkillCard;
	enabled: boolean | undefined;
	installBusy: boolean;
	toggleBusy: boolean;
	onInstall: () => void;
	onEnable: () => void;
	onDisable: () => void;
}) {
	return (
		<StoreItemAction
			busy={installBusy || toggleBusy}
			enabled={card.installed ? enabled : undefined}
			installed={card.installed}
			onDisable={onDisable}
			onEnable={onEnable}
			onInstall={onInstall}
		/>
	);
}

function SkillDetailPanel({
	selectedId,
	detail,
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
	Markdown,
}: {
	selectedId: string | null;
	detail: SkillDetail | null;
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

	return (
		<div className="flex flex-col gap-6 p-4">
			<header className="flex flex-col gap-3">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<h2 className="truncate font-semibold text-xl">
							{friendly ? titleCase(card.name) : card.name}
						</h2>
						<p className="text-muted-foreground text-sm">
							{owner ? (
								<Tooltip>
									<TooltipTrigger
										render={
											<button
												className="underline decoration-dotted underline-offset-2 hover:text-foreground"
												onClick={() => onSelectOrg(owner)}
												type="button"
											>
												{card.source || "skills.sh"}
											</button>
										}
									/>
									<TooltipContent>Browse all skills by {owner}</TooltipContent>
								</Tooltip>
							) : (
								card.source || "skills.sh"
							)}
						</p>
					</div>
					<SkillDetailAction
						canAuthor={canAuthor}
						card={card}
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
				</div>
				{description && (
					<p className="text-muted-foreground text-sm">{description}</p>
				)}
				<SkillMetadataGrid
					downloads={downloads}
					firstSeen={metadata.firstSeen}
					githubCreatedAt={metadata.githubCreatedAt}
					githubPushedAt={metadata.githubPushedAt}
					githubStars={metadata.githubStars}
					githubUpdatedAt={metadata.githubUpdatedAt}
					installs={installs}
					repositoryUrl={metadata.repositoryUrl}
					securityAudits={metadata.securityAudits}
					url={url}
				/>
			</header>

			{readme && (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">README</h3>
					<div className="prose prose-sm dark:prose-invert max-w-none text-sm">
						<Markdown className="[&_ol]:pl-10 [&_ul]:pl-9" content={readme} />
					</div>
				</section>
			)}
		</div>
	);
}

/** The primary action cluster in the skill detail header: install / enable-toggle
 *  on an install-capable surface (desktop), or the read-only "Open in Ryu"
 *  affordance where `installLayer` is null (web). */
function SkillDetailAction({
	card,
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
				installing={installing === card.id}
				onClick={() => {
					install().catch(() => undefined);
				}}
				progress={{ kinds: ["skill"], name: card.name }}
			>
				<HugeiconsIcon className="size-4" icon={Download01Icon} />
				Install skill
			</InstallButton>
		);
	}

	return (
		<div className="flex shrink-0 items-center gap-3">
			{canAuthor && skillKey !== null ? (
				<Button onClick={() => onEdit(skillKey)} size="sm" variant="outline">
					<HugeiconsIcon className="size-4" icon={PencilEdit01Icon} />
					Edit
				</Button>
			) : null}
			<Badge className="gap-1" variant="secondary">
				<HugeiconsIcon
					className="size-3.5 text-success"
					icon={CheckmarkCircle02Icon}
				/>
				Installed
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

function SkillMetadataGrid({
	installs,
	downloads,
	githubStars,
	firstSeen,
	githubCreatedAt,
	githubUpdatedAt,
	githubPushedAt,
	repositoryUrl,
	securityAudits,
	url,
}: {
	installs: string | null;
	downloads: string | null;
	githubStars: string | null;
	firstSeen: string | null;
	githubCreatedAt: string | null;
	githubUpdatedAt: string | null;
	githubPushedAt: string | null;
	repositoryUrl: string | null;
	securityAudits: SkillDetail["metadata"]["securityAudits"];
	url: string;
}) {
	const rows = [
		{ label: "Installs", value: installs ?? "Not reported" },
		{ label: "Downloads", value: downloads ?? "Not reported" },
		{ label: "GitHub Stars", value: githubStars ?? "Not reported" },
		{ label: "Skills First Seen", value: firstSeen ?? "Not reported" },
		{
			label: "GitHub Created",
			value: formatDateLabel(githubCreatedAt) ?? "Not reported",
		},
		{
			label: "GitHub Updated",
			value: formatDateLabel(githubUpdatedAt) ?? "Not reported",
		},
		{
			label: "Last Push",
			value: formatDateLabel(githubPushedAt) ?? "Not reported",
		},
	];

	return (
		<div className="flex flex-col gap-3">
			{rows.length > 0 && (
				<div className="grid grid-cols-2 gap-2">
					{rows.map((row) => (
						<div className="rounded-md border px-3 py-2" key={row.label}>
							<div className="text-muted-foreground text-xs">{row.label}</div>
							<div className="font-medium text-sm">{row.value}</div>
						</div>
					))}
				</div>
			)}
			<div className="flex flex-col gap-1">
				<div className="text-muted-foreground text-xs">Security Audits</div>
				<div className="flex flex-wrap gap-1.5">
					{securityAudits.length > 0 ? (
						securityAudits.map((audit) => (
							<a
								className="block w-full rounded-md px-3 py-2 text-xs transition-colors hover:bg-accent/50"
								href={audit.url ?? undefined}
								key={audit.name}
								rel="noopener noreferrer"
								target={audit.url ? "_blank" : undefined}
							>
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
								{audit.risk_level && (
									<div className="mt-1 text-muted-foreground">
										Risk: {audit.risk_level}
									</div>
								)}
								{audit.summary && (
									<div className="mt-1 line-clamp-2 text-muted-foreground">
										{audit.summary}
									</div>
								)}
							</a>
						))
					) : (
						<Badge variant="secondary">Not reported</Badge>
					)}
				</div>
			</div>
			<div className="flex flex-wrap gap-3 text-muted-foreground text-xs">
				{repositoryUrl && (
					<a
						className="underline hover:text-foreground"
						href={repositoryUrl}
						rel="noopener noreferrer"
						target="_blank"
					>
						Repository
					</a>
				)}
				{url && (
					<a
						className="underline hover:text-foreground"
						href={url}
						rel="noopener noreferrer"
						target="_blank"
					>
						skills.sh
					</a>
				)}
			</div>
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
				<h3 className="font-medium text-sm">Files ({files.length})</h3>
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
				<div className="scroll-fade-effect-y prose prose-sm dark:prose-invert min-h-0 max-w-none flex-1 overflow-auto p-3 text-sm">
					<Markdown className="[&_ol]:pl-10 [&_ul]:pl-9" content={content} />
				</div>
			) : (
				<pre className="scroll-fade-effect-y min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed">
					{content || "This file is empty."}
				</pre>
			)}
		</div>
	);
}
