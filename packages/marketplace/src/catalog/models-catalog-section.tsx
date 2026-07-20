import {
	AiBrain01Icon,
	CheckmarkCircle02Icon,
	CpuIcon,
	Delete01Icon,
	DollarCircleIcon,
	Download01Icon,
	FavouriteIcon,
	FlashIcon,
	HardDriveIcon,
	Package01Icon,
	SlidersHorizontalIcon,
	SquareLock01Icon,
	TextWrapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
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
	type ReactNode,
	useCallback,
	useMemo,
	useState,
} from "react";
import {
	type ActiveChip,
	CardBadges,
	FilterChipBar,
	ModalityFlowBadges,
	ORG_ICON,
	RawTags,
	SizeBadge,
	TAG_ICON,
	TokenBadge,
	tokenIcon,
} from "./chrome/catalog-badges.tsx";
import InfiniteSentinel from "./chrome/infinite-sentinel.tsx";
import ResizableMasterDetail from "./chrome/resizable-master-detail.tsx";
import StoreListHeader from "./chrome/store-list-header.tsx";
import { useStoreToolbar } from "./chrome/store-toolbar.tsx";
import {
	CATALOG_TOKENS,
	displayTokens,
	extractTokens,
	friendlyModelName,
	friendlyQuant,
	type GgufRole,
	ggufFileRole,
	parseModelSize,
	parsePipelineModalities,
	QUANT_QUALITY_MAX,
	quantVariantRank,
} from "./friendly.ts";
import { type CatalogInstallButtonProps, useCatalogHost } from "./host.tsx";
import type {
	FitVerdict,
	LlmFitEstimate,
	ModelCard,
	ModelCatalogSource,
	ModelCategory,
	ModelDetail,
	ModelFile,
	ModelFormat,
	ModelSort,
} from "./types.ts";
import { useFriendlyMode } from "./use-friendly-mode.ts";

/** The host-provided install button, injected wherever an install action renders. */
type InstallButton = ComponentType<CatalogInstallButtonProps>;
/** The host-provided device-fit color resolver. */
type FitStyle = (fit: string) => { className: string; dot: string };

/** Token id → friendly label, for building active-filter chip text. */
const TOKEN_LABEL = new Map(CATALOG_TOKENS.map((t) => [t.id, t.label]));

/** Refine loaded models to those carrying every active token-badge filter. */
function filterModelsByTokens(
	models: ModelCard[],
	activeTokens: Set<string>,
	org: string
): ModelCard[] {
	const normalizedOrg = org.trim().toLowerCase();
	return models.filter((m) => {
		if (normalizedOrg && m.author.toLowerCase() !== normalizedOrg) {
			return false;
		}
		if (activeTokens.size === 0) {
			return true;
		}
		const ids = new Set(extractTokens(m.name, m.tags).map((t) => t.id));
		for (const id of activeTokens) {
			if (!ids.has(id)) {
				return false;
			}
		}
		return true;
	});
}

/** Build the toolbar's removable chips for the active org + token filters. */
function buildModelChips(
	org: string,
	activeTokens: Set<string>,
	setOrg: (o: string) => void,
	toggleToken: (id: string) => void
): ActiveChip[] {
	const out: ActiveChip[] = [];
	if (org) {
		out.push({
			key: `org:${org}`,
			label: `Org: ${org}`,
			icon: ORG_ICON,
			onRemove: () => setOrg(""),
		});
	}
	for (const id of activeTokens) {
		out.push({
			key: `token:${id}`,
			label: TOKEN_LABEL.get(id) ?? id,
			icon: tokenIcon(id),
			onRemove: () => toggleToken(id),
		});
	}
	return out;
}

const SORT_OPTIONS: { value: ModelSort; label: string }[] = [
	{ value: "trending", label: "Trending" },
	{ value: "downloads", label: "Popular" },
	{ value: "likes", label: "Most liked" },
	{ value: "recent", label: "Newest" },
];

/** Weight-format facet. Each maps to an engine family; the catalog lists one
 *  format at a time (one clean Hub cursor per format). */
const FORMAT_OPTIONS: { value: ModelFormat; label: string }[] = [
	{ value: "gguf", label: "Runs anywhere (GGUF)" },
	{ value: "safetensors", label: "Full quality (Safetensors)" },
	{ value: "mlx", label: "Apple Silicon (MLX)" },
];

/** Friendly category labels for the task filter (maps to a HF pipeline tag). */
const CATEGORY_OPTIONS: { value: ModelCategory; label: string }[] = [
	{ value: "all", label: "All categories" },
	{ value: "chat", label: "Chat / text" },
	{ value: "vision", label: "Vision" },
	{ value: "embedding", label: "Embedding" },
	{ value: "reranker", label: "Reranker" },
	{ value: "stt", label: "Speech-to-text" },
	{ value: "tts", label: "Text-to-speech" },
];

/** Largest-first calendar units for relative-time formatting (ms per unit). */
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["year", 365 * 24 * 60 * 60 * 1000],
	["month", 30 * 24 * 60 * 60 * 1000],
	["week", 7 * 24 * 60 * 60 * 1000],
	["day", 24 * 60 * 60 * 1000],
	["hour", 60 * 60 * 1000],
	["minute", 60 * 1000],
];

/** Shared formatter — created once, never inside the render loop. */
const RELATIVE_TIME = new Intl.RelativeTimeFormat(undefined, {
	numeric: "auto",
});

/** Relative age of an ISO-8601 timestamp, e.g. "3 months ago". `null` when the
 *  date is missing or unparseable, so callers can omit the chip entirely.
 *  Uses the native Intl formatter — no third-party date dependency. */
function formatAgo(iso: string | null): string | null {
	if (!iso) {
		return null;
	}
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	const diffMs = date.getTime() - Date.now();
	const absMs = Math.abs(diffMs);
	for (const [unit, unitMs] of RELATIVE_UNITS) {
		if (absMs >= unitMs) {
			return RELATIVE_TIME.format(Math.round(diffMs / unitMs), unit);
		}
	}
	return RELATIVE_TIME.format(Math.round(diffMs / 1000), "second");
}

/** Absolute calendar date for a detail line, e.g. "10 Jun 2026". */
function formatDate(iso: string | null): string | null {
	if (!iso) {
		return null;
	}
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return date.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

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

/** Friendly context-window string (32768 → "32K", 1048576 → "1M"). `null` when
 *  the Hub didn't report a context length, so callers can omit the chip. */
function formatContext(tokens: number | null): string | null {
	if (!tokens || tokens <= 0) {
		return null;
	}
	if (tokens >= 1_000_000) {
		const m = tokens / 1_048_576;
		return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
	}
	if (tokens >= 1024) {
		return `${Math.round(tokens / 1024)}K`;
	}
	return String(tokens);
}

/** Friendly parameter-count string (999885952 → "1.0B", 8e9 → "8.0B"). `null`
 *  when unknown. Uses 1B = 1e9 (HF reports decimal parameter counts). */
function formatParams(n: number | null): string | null {
	if (!n || n <= 0) {
		return null;
	}
	if (n >= 500_000_000) {
		const b = n / 1_000_000_000;
		return `${b >= 10 ? Math.round(b) : b.toFixed(1)}B`;
	}
	if (n >= 1_000_000) {
		return `${Math.round(n / 1_000_000)}M`;
	}
	return String(n);
}

/** Multi-line hardware summary for the detail overview. */
function deviceSummaryLines(device: ModelDetail["device"]): string[] {
	if (device.unifiedMemory && device.ramHuman) {
		return [`${device.ramHuman} unified memory`];
	}
	const lines: string[] = [];
	if (device.gpuName) {
		lines.push(device.gpuName);
	}
	if (device.vramHuman) {
		lines.push(`${device.vramHuman} GPU RAM`);
	}
	if (device.ramHuman) {
		lines.push(`${device.ramHuman} system RAM`);
	}
	if (lines.length === 0) {
		return [device.os || "unknown hardware"];
	}
	return lines;
}

/**
 * Models catalog as an embeddable Store section, shared by desktop and web.
 * Desktop injects its real Core-node model-catalog hook + install layer through
 * the {@link useCatalogHost} seam; web injects a federated adapter with
 * `install: null`, so the install/enable/source/active/fine-tune touchpoints
 * collapse to an "Open in Ryu" affordance.
 */
export default function ModelsCatalogSection({
	initialQuery = "",
}: {
	/** Seed the search box (e.g. carried over from the store-wide search). */
	initialQuery?: string;
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

/**
 * Multi-select "Filter by tag" dropdown. Each checked token narrows the list
 * with AND logic (a model must carry every selected tag). Mirrors the clickable
 * token badges — both drive the same `activeTokens` set.
 */
function TagFilterDropdown({
	activeTokens,
	toggleToken,
}: {
	activeTokens: Set<string>;
	toggleToken: (id: string) => void;
}) {
	const count = activeTokens.size;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button size="sm" variant={count > 0 ? "secondary" : "ghost"}>
						<HugeiconsIcon className="size-4" icon={TAG_ICON} />
						Tags
						{count > 0 && (
							<Badge
								className="ml-1 h-4 px-1.5 text-[10px]"
								variant="secondary"
							>
								{count}
							</Badge>
						)}
					</Button>
				}
			/>
			<DropdownMenuContent
				align="start"
				className="max-h-80 w-60 overflow-auto"
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>Filter by tag (matches all)</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				{CATALOG_TOKENS.map((t) => (
					<DropdownMenuCheckboxItem
						checked={activeTokens.has(t.id)}
						closeOnClick={false}
						key={t.id}
						onCheckedChange={() => toggleToken(t.id)}
					>
						<HugeiconsIcon className="size-4" icon={tokenIcon(t.id)} />
						{t.label}
					</DropdownMenuCheckboxItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Bottom-nav filter panel: category + sort + friendly/installed switches + chips.
 *  The search box itself lives directly in the bar (see the section's
 *  useStoreToolbar call); this is the "Filters" region that morphs above it. */
function ModelsFilterPanel({
	category,
	setCategory,
	sort,
	setSort,
	format,
	setFormat,
	friendly,
	setFriendly,
	installedOnly,
	setInstalledOnly,
	chips,
	sources,
	activeSource,
	selectSource,
	selectingSource,
	activeTokens,
	toggleToken,
	showTags,
	setShowTags,
}: {
	category: ModelCategory;
	setCategory: (c: ModelCategory) => void;
	sort: ModelSort;
	setSort: (s: ModelSort) => void;
	format: ModelFormat;
	setFormat: (f: ModelFormat) => void;
	friendly: boolean;
	setFriendly: (v: boolean) => void;
	installedOnly: boolean;
	setInstalledOnly: (v: boolean) => void;
	chips: ActiveChip[];
	sources: ModelCatalogSource[];
	activeSource: string;
	selectSource: (id: string) => void;
	selectingSource: boolean;
	activeTokens: Set<string>;
	toggleToken: (id: string) => void;
	showTags: boolean;
	setShowTags: (v: boolean) => void;
}) {
	// Only worth a picker when there's a real choice. The {value,label} items
	// prop is required so Base UI's SelectValue renders the friendly name.
	const sourceItems = sources.map((s) => ({
		value: s.id,
		label: s.displayName,
	}));
	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					{/* Catalog source (Hugging Face by default). Only shown when there's
					    more than one source to pick from. */}
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
					{/* Category narrows by Hugging Face task. Local models carry no
					    task metadata, so it's disabled in the installed-only view. */}
					<Select
						disabled={installedOnly}
						items={CATEGORY_OPTIONS}
						onValueChange={(v) => setCategory(v as ModelCategory)}
						value={category}
					>
						<SelectTrigger className="h-8 w-[160px] text-sm" size="sm">
							<SelectValue placeholder="All categories" />
						</SelectTrigger>
						<SelectContent>
							{CATEGORY_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{/* Weight-format facet — picks which engine family's models the
					    catalog lists. Incompatible models still appear, annotated. */}
					<Select
						items={FORMAT_OPTIONS}
						onValueChange={(v) => v && setFormat(v as ModelFormat)}
						value={format}
					>
						<SelectTrigger className="h-8 w-[170px] text-sm" size="sm">
							<SelectValue placeholder="Format" />
						</SelectTrigger>
						<SelectContent>
							{FORMAT_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select
						items={SORT_OPTIONS}
						onValueChange={(v) => v && setSort(v as ModelSort)}
						value={sort}
					>
						<SelectTrigger className="h-8 w-[140px] text-sm" size="sm">
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
					<TagFilterDropdown
						activeTokens={activeTokens}
						toggleToken={toggleToken}
					/>
				</div>
				<div className="flex items-center gap-4 text-sm">
					<div className="flex items-center gap-2">
						<Switch
							aria-label="Friendly names and badges"
							checked={friendly}
							id="friendly-models"
							onCheckedChange={setFriendly}
						/>
						<label className="cursor-pointer" htmlFor="friendly-models">
							Friendly names
						</label>
					</div>
					<div className="flex items-center gap-2">
						<Switch
							aria-label="Show Hugging Face tags in the list"
							checked={showTags}
							id="show-tags"
							onCheckedChange={setShowTags}
						/>
						<label className="cursor-pointer" htmlFor="show-tags">
							Show tags
						</label>
					</div>
					<div className="flex items-center gap-2">
						<Switch
							aria-label="Show only installed models"
							checked={installedOnly}
							id="installed-only"
							onCheckedChange={setInstalledOnly}
						/>
						<label className="cursor-pointer" htmlFor="installed-only">
							Installed only
						</label>
					</div>
				</div>
			</div>
			<FilterChipBar chips={chips} />
		</div>
	);
}

// ── Left: model selector list ───────────────────────────────────────────────

function ModelList({
	models,
	loading,
	error,
	selectedId,
	onSelect,
	fetchNextPage,
	hasNextPage,
	loadingMore,
	friendly,
	showTags,
	installedOnly,
}: {
	models: ModelCard[];
	loading: boolean;
	error: string | null;
	selectedId: string | null;
	onSelect: (id: string) => void;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	loadingMore: boolean;
	friendly: boolean;
	showTags: boolean;
	installedOnly: boolean;
}) {
	// The IntersectionObserver root is this scrollable nav, not the viewport.
	const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

	if (loading && models.length === 0) {
		return (
			<div className="flex items-center justify-center p-8 text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (error) {
		return (
			<div className="p-4 text-destructive text-sm">
				Couldn't load models: {error}
			</div>
		);
	}
	if (models.length === 0) {
		return (
			<Empty className="h-full p-6">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Package01Icon} />
					</EmptyMedia>
					<EmptyTitle>
						{installedOnly ? "No installed models yet" : "No models found"}
					</EmptyTitle>
					<EmptyDescription>
						{installedOnly
							? "Turn off “Installed only” to browse and install models."
							: "Try a different search."}
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<nav
			className="scroll-fade-effect-y h-full overflow-auto p-2"
			ref={setScrollEl}
		>
			<ul className="flex flex-col gap-1">
				{models.map((m) => {
					const isSelected = m.id === selectedId;
					const modality = parsePipelineModalities(m.pipelineTag);
					const updatedAgo = formatAgo(m.lastModified);
					const publishedAgo = formatAgo(m.createdAt);
					return (
						<li key={m.id}>
							<button
								className={`w-full rounded-md px-3 py-2 text-left transition-colors ${
									isSelected ? "bg-accent" : "hover:bg-accent/50"
								}`}
								onClick={() => onSelect(m.id)}
								type="button"
							>
								<div className="flex items-center gap-2">
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-1.5">
											<span className="min-w-0 truncate font-medium text-sm">
												{friendly ? friendlyModelName(m.name, m.tags) : m.name}
											</span>
											{m.installed && (
												<HugeiconsIcon
													aria-label="Installed"
													className="size-3.5 shrink-0 text-success"
													icon={CheckmarkCircle02Icon}
												/>
											)}
											{m.gated && (
												<HugeiconsIcon
													className="size-3.5 shrink-0 text-warning"
													icon={SquareLock01Icon}
												/>
											)}
										</div>
										<div className="truncate text-muted-foreground text-xs">
											{m.author || "unknown"}
										</div>
									</div>
									{(updatedAgo || publishedAgo) && (
										<div className="flex shrink-0 flex-col items-end justify-center gap-0.5 text-right text-[11px] text-muted-foreground leading-4">
											{publishedAgo && (
												<ModelDateLine
													date={formatDate(m.createdAt)}
													tooltipLabel="Published"
													value={publishedAgo}
												/>
											)}
											{updatedAgo && (
												<ModelDateLine
													date={formatDate(m.lastModified)}
													tooltipLabel="Updated"
													value={`(updated ${updatedAgo})`}
												/>
											)}
										</div>
									)}
								</div>
								<CardBadges
									friendly={friendly}
									name={m.name}
									showTags={showTags}
									tags={m.tags}
								/>
								{!m.compatible && (
									<Badge
										className="border-warning/30 bg-warning/5 text-warning dark:text-warning"
										variant="outline"
									>
										{m.format === "mlx"
											? "macOS only"
											: `Needs ${m.needsEngine ?? "another engine"}`}
									</Badge>
								)}
								<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
									<span className="flex items-center gap-1">
										<HugeiconsIcon className="size-3" icon={Download01Icon} />
										{formatCount(m.downloads)}
									</span>
									<span className="flex items-center gap-1">
										<HugeiconsIcon className="size-3" icon={FavouriteIcon} />
										{formatCount(m.likes)}
									</span>
									{formatContext(m.contextLength) && (
										<Tooltip>
											<TooltipTrigger
												render={
													<span className="flex items-center gap-1 whitespace-nowrap">
														<HugeiconsIcon
															className="size-3"
															icon={TextWrapIcon}
														/>
														{formatContext(m.contextLength)} context
													</span>
												}
											/>
											<TooltipContent>
												Context window (tokens the model can read + write at
												once)
											</TooltipContent>
										</Tooltip>
									)}
									{modality && (
										<span className="min-w-0 shrink basis-full sm:basis-auto">
											<ModalityFlowBadges compact flow={modality} />
										</span>
									)}
								</div>
							</button>
						</li>
					);
				})}
			</ul>
			<InfiniteSentinel
				hasMore={hasNextPage}
				loading={loadingMore}
				onLoadMore={fetchNextPage}
				root={scrollEl}
			/>
		</nav>
	);
}

function ModelDateLine({
	date,
	tooltipLabel,
	value,
}: {
	date: string | null;
	tooltipLabel: string;
	value: string;
}) {
	if (!date) {
		return <span>{value}</span>;
	}
	return (
		<Tooltip>
			<TooltipTrigger render={<span>{value}</span>} />
			<TooltipContent>
				{tooltipLabel} {date}
			</TooltipContent>
		</Tooltip>
	);
}

// ── Right: detail panel ───────────────────────────────────────────────────

/** The detail panel's title block: name, org link, badges, size/token row, tags. */
function ModelDetailHeader({
	card,
	friendly,
	activeTokens,
	onToggleToken,
	onSelectOrg,
}: {
	card: ModelCard;
	friendly: boolean;
	activeTokens: Set<string>;
	onToggleToken: (id: string) => void;
	onSelectOrg: (org: string) => void;
}) {
	const size = parseModelSize(card.name);
	const tokens = displayTokens(extractTokens(card.name, card.tags), friendly);
	return (
		<header className="flex flex-col gap-2">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<h2 className="truncate font-semibold text-xl">
						{friendly ? friendlyModelName(card.name, card.tags) : card.name}
					</h2>
					<p className="text-muted-foreground text-sm">
						by{" "}
						{card.author ? (
							<Tooltip>
								<TooltipTrigger
									render={
										<button
											className="underline decoration-dotted underline-offset-2 hover:text-foreground"
											onClick={() => onSelectOrg(card.author)}
											type="button"
										>
											{card.author}
										</button>
									}
								/>
								<TooltipContent>
									Browse all models by {card.author}
								</TooltipContent>
							</Tooltip>
						) : (
							"unknown"
						)}
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{card.gated && (
						<Badge className="gap-1" variant="secondary">
							<HugeiconsIcon
								className="size-3.5 text-warning"
								icon={SquareLock01Icon}
							/>
							Gated
						</Badge>
					)}
					{card.installed && (
						<Badge className="gap-1" variant="secondary">
							<HugeiconsIcon
								className="size-3.5 text-success"
								icon={CheckmarkCircle02Icon}
							/>
							Installed
						</Badge>
					)}
				</div>
			</div>
			<div className="flex items-center gap-3 text-muted-foreground text-xs">
				<span className="flex items-center gap-1">
					<HugeiconsIcon className="size-3.5" icon={Download01Icon} />
					{formatCount(card.downloads)} downloads
				</span>
				<span className="flex items-center gap-1">
					<HugeiconsIcon className="size-3.5" icon={FavouriteIcon} />
					{formatCount(card.likes)} likes
				</span>
				<a
					className="underline hover:text-foreground"
					href={`https://huggingface.co/${card.id}`}
					rel="noopener noreferrer"
					target="_blank"
				>
					View on Hugging Face
				</a>
			</div>
			{(card.createdAt || card.lastModified) && (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
					{formatAgo(card.createdAt) && (
						<span>
							Published {formatDate(card.createdAt)} (
							{formatAgo(card.createdAt)})
						</span>
					)}
					{formatAgo(card.lastModified) && (
						<span>
							Updated {formatDate(card.lastModified)} (
							{formatAgo(card.lastModified)})
						</span>
					)}
				</div>
			)}
			{(size || tokens.length > 0) && (
				<div className="flex flex-wrap items-center gap-1.5">
					{size && <SizeBadge friendly={friendly} size={size} />}
					{tokens.map((t) => (
						<TokenBadge
							active={activeTokens.has(t.id)}
							key={t.id}
							onToggle={onToggleToken}
							token={t}
						/>
					))}
				</div>
			)}
		</header>
	);
}

/**
 * Compact spec strip shown at the top of the detail panel: the model's context
 * window, parameter count, and architecture, read from the Hub's parsed GGUF
 * metadata. Renders nothing when the Hub reported none of these.
 */
function ModelSpecsRow({ card }: { card: ModelCard }) {
	const ctx = formatContext(card.contextLength);
	const params = formatParams(card.params);
	const arch = card.architecture;
	const specs: { label: string; title?: string; value: string }[] = [];
	if (ctx) {
		specs.push({
			label: "Context window",
			value: `${ctx} tokens`,
			title:
				"The total tokens the model can read and write at once, shared by your prompt and its reply. GGUF models have one window, not separate input/output limits.",
		});
	}
	if (params) {
		specs.push({ label: "Parameters", value: params });
	}
	if (arch) {
		specs.push({ label: "Architecture", value: arch });
	}
	if (specs.length === 0) {
		return null;
	}
	return (
		<section className="flex flex-wrap gap-x-8 gap-y-2 rounded-lg bg-muted/50 px-4 py-3">
			{specs.map((s) => (
				<div className="flex flex-col gap-0.5" key={s.label}>
					{s.title ? (
						<Tooltip>
							<TooltipTrigger
								render={
									<span className="text-muted-foreground text-xs">
										{s.label}
									</span>
								}
							/>
							<TooltipContent>{s.title}</TooltipContent>
						</Tooltip>
					) : (
						<span className="text-muted-foreground text-xs">{s.label}</span>
					)}
					<span className="font-semibold text-sm">{s.value}</span>
				</div>
			))}
		</section>
	);
}

function ModelOverviewGrid({
	card,
	device,
}: {
	card: ModelCard;
	device: ModelDetail["device"];
}) {
	const modalities = parsePipelineModalities(card.pipelineTag);
	const deviceLines = deviceSummaryLines(device);
	let deviceHint =
		"No GPU detected, so downloads are checked against CPU + RAM.";
	if (device.vramBytes) {
		deviceHint = "GPU memory is used first; larger files can share system RAM.";
	} else if (device.unifiedMemory) {
		deviceHint = "CPU and GPU share unified memory on this device.";
	}
	return (
		<section className="grid gap-3 md:grid-cols-3">
			<div className="flex min-w-0 flex-col gap-1.5">
				<div className="font-medium text-muted-foreground text-xs">
					Modalities
				</div>
				<div className="rounded-md bg-muted/50 p-3">
					{modalities ? (
						<ModalityFlowBadges flow={modalities} />
					) : (
						<div className="text-muted-foreground text-sm">
							No task metadata
						</div>
					)}
				</div>
			</div>
			<div className="flex min-w-0 flex-col gap-1.5">
				<div className="font-medium text-muted-foreground text-xs">
					Your device
				</div>
				<div className="rounded-md bg-muted/50 p-3">
					<div className="flex items-start gap-2 text-sm">
						<HugeiconsIcon
							className="mt-0.5 size-4 shrink-0 text-muted-foreground"
							icon={CpuIcon}
						/>
						<div className="min-w-0 text-muted-foreground">
							{deviceLines.map((line) => (
								<div className="truncate" key={line}>
									{line}
								</div>
							))}
						</div>
					</div>
					<p className="mt-2 text-muted-foreground text-xs">{deviceHint}</p>
				</div>
			</div>
			<div className="flex min-w-0 flex-col gap-1.5">
				<div className="font-medium text-muted-foreground text-xs">Tags</div>
				<div className="rounded-md bg-muted/50 p-3">
					{card.tags.length > 0 ? (
						<RawTags limit={18} tags={card.tags} />
					) : (
						<div className="text-muted-foreground text-sm">No tags</div>
					)}
				</div>
			</div>
		</section>
	);
}

/**
 * On-demand hardware speed/fit estimate via the optional `llmfit` tool. Renders
 * only on an install-capable surface (it needs a Core node); its node identity,
 * estimate call, and sidecar install all cross the host seam.
 */
function LlmfitEstimateBlock({ repo }: { repo: string }) {
	const host = useCatalogHost();
	const node = host.useActiveNode();
	const [busy, setBusy] = useState<"idle" | "loading" | "installing">("idle");
	const [result, setResult] = useState<LlmFitEstimate | null>(null);
	const [error, setError] = useState<string | null>(null);
	const target = { url: node.url, token: node.token };

	const run = async () => {
		setBusy("loading");
		setError(null);
		try {
			setResult(await host.estimateLlmfit(target, repo));
		} catch (e) {
			setError(e instanceof Error ? e.message : "Estimate failed");
		} finally {
			setBusy("idle");
		}
	};

	const install = async () => {
		setBusy("installing");
		setError(null);
		try {
			await host.installSidecar(node.url, node.token, "llmfit");
			setResult(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Install failed");
		} finally {
			setBusy("idle");
		}
	};

	// run()/install() capture their own errors into state and never reject, so the
	// button handlers just fire-and-forget (the project forbids the `void` op).
	const onRun = () => {
		run().catch(() => {
			// handled inside run()
		});
	};
	const onInstall = () => {
		install().catch(() => {
			// handled inside install()
		});
	};

	let body: ReactNode;
	if (result === null) {
		body = (
			<div className="flex flex-wrap items-center gap-3">
				<Button
					disabled={busy !== "idle"}
					onClick={onRun}
					size="sm"
					variant="outline"
				>
					{busy === "loading" ? <Spinner className="size-4" /> : null}
					{busy === "loading"
						? "Estimating… (~15s)"
						: "Estimate speed on your device"}
				</Button>
				<span className="text-muted-foreground text-xs">
					See how fast this model would run on your device.
				</span>
			</div>
		);
	} else if (!result.installed) {
		body = (
			<div className="flex flex-wrap items-center gap-3">
				<Button disabled={busy !== "idle"} onClick={onInstall} size="sm">
					{busy === "installing" ? <Spinner className="size-4" /> : null}
					Enable speed estimates
				</Button>
				<span className="text-muted-foreground text-xs">
					Speed estimates aren’t set up on this computer yet — enable them to
					see how fast this model would run.
				</span>
			</div>
		);
	} else if (result.matched) {
		body = (
			<div className="flex flex-wrap items-center gap-2">
				{result.tps != null && (
					<Badge variant="secondary">≈{Math.round(result.tps)} words/sec</Badge>
				)}
				{result.fit_level && (
					<Badge variant="outline">{result.fit_level}</Badge>
				)}
				{result.min_vram_gb != null && (
					<span className="text-muted-foreground text-xs">
						needs {result.min_vram_gb.toFixed(1)} GB graphics memory
						{result.path ? ` · ${result.path.replace("_", " ")}` : ""}
					</span>
				)}
				<Button onClick={onRun} size="sm" variant="ghost">
					Re-estimate
				</Button>
			</div>
		);
	} else {
		body = (
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-muted-foreground text-sm">
					No speed estimate available for this model — use the device fit above.
				</span>
				<Button onClick={onRun} size="sm" variant="ghost">
					Retry
				</Button>
			</div>
		);
	}

	return (
		<section className="flex flex-col gap-2">
			<h3 className="font-medium text-sm">Speed estimate</h3>
			{body}
			{error && <p className="text-destructive text-xs">{error}</p>}
		</section>
	);
}

/**
 * Fine-tuned variants of the selected model: merged GGUFs recorded against it as
 * their base. They are installed (servable by stem), so each can be set as the
 * active model. Reads installed models across the host seam; renders nothing when
 * there are none. Install-capable surfaces only.
 */
function FinetunedVariants({ baseId }: { baseId: string }) {
	const host = useCatalogHost();
	const installed = host.useInstalledModels();
	const ActiveModelControl = host.ActiveModelControl;
	const variants = installed.filter(
		(m) => m.finetuneBase && m.finetuneBase === baseId
	);
	if (variants.length === 0) {
		return null;
	}
	return (
		<section className="flex flex-col gap-2">
			<h3 className="font-medium text-sm">Your fine-tuned versions</h3>
			<ul className="flex flex-col gap-2">
				{variants.map((m) => (
					<li
						className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 px-4 py-3"
						key={m.stem}
					>
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<p className="truncate font-medium text-sm">{m.stem}</p>
								<Badge variant="secondary">Fine-tuned</Badge>
							</div>
							<p className="truncate text-muted-foreground text-xs">
								Fine-tuned from {m.finetuneBase}
							</p>
						</div>
						<ActiveModelControl repoId={m.stem} />
					</li>
				))}
			</ul>
		</section>
	);
}

function ModelDetailPanel({
	selectedId,
	detail,
	loading,
	error,
	install,
	installing,
	installSnapshot,
	installingSnapshot,
	uninstall,
	uninstalling,
	friendly,
	activeTokens,
	onToggleToken,
	onSelectOrg,
}: {
	selectedId: string | null;
	detail: ModelDetail | null;
	loading: boolean;
	error: string | null;
	install: (file: string) => Promise<void>;
	installing: string | null;
	installSnapshot: () => Promise<void>;
	installingSnapshot: boolean;
	uninstall: (file: string) => Promise<void>;
	uninstalling: string | null;
	friendly: boolean;
	activeTokens: Set<string>;
	onToggleToken: (id: string) => void;
	onSelectOrg: (org: string) => void;
}) {
	const host = useCatalogHost();
	const installLayer = host.install;
	const Markdown = host.Markdown;
	const ActiveModelControl = host.ActiveModelControl;

	if (!selectedId) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Package01Icon} />
					</EmptyMedia>
					<EmptyTitle>No model selected</EmptyTitle>
					<EmptyDescription>
						Pick a model on the left to read what it does and see whether it
						runs on your device.
					</EmptyDescription>
				</EmptyHeader>
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
				Couldn't load this model: {error}
			</div>
		);
	}
	if (!detail) {
		return null;
	}

	const {
		card,
		files,
		vision,
		stats,
		statsApiKeyPresent,
		device,
		readme,
		format,
		repoSizeBytes,
		repoFitLabel,
	} = detail;

	return (
		<div className="flex flex-col gap-6 p-4">
			<ModelDetailHeader
				activeTokens={activeTokens}
				card={card}
				friendly={friendly}
				onSelectOrg={onSelectOrg}
				onToggleToken={onToggleToken}
			/>

			{/* Read-only surface (web): the primary action is deep-linking into Ryu,
			    which owns the actual download/install flow. */}
			{!installLayer && host.renderAffordance && (
				<div className="flex">
					{host.renderAffordance({
						id: card.id,
						name: card.name,
						realm: "model",
					})}
				</div>
			)}

			<ModelSpecsRow card={card} />
			<ModelOverviewGrid card={card} device={device} />

			{installLayer && <LlmfitEstimateBlock repo={card.id} />}

			{/* Stats from Artificial Analysis */}
			<StatsBlock present={statsApiKeyPresent} stats={stats} />

			{/* Gated-model notice */}
			{card.gated && (
				<section className="flex gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-muted-foreground text-xs">
					<HugeiconsIcon
						className="mt-0.5 size-4 shrink-0 text-warning"
						icon={SquareLock01Icon}
					/>
					<p>
						This is a gated model. Add a Hugging Face access token in{" "}
						<span className="font-medium text-foreground">
							Settings → Integrations
						</span>{" "}
						and accept this model's terms on its{" "}
						<a
							className="underline hover:text-foreground"
							href={`https://huggingface.co/${card.id}`}
							rel="noopener noreferrer"
							target="_blank"
						>
							Hugging Face page
						</a>{" "}
						before downloading.
					</p>
				</section>
			)}

			{/* Switch the local engine to serve this model (when installed). */}
			{installLayer && card.installed && (
				<section className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 px-4 py-3">
					<div className="min-w-0">
						<p className="font-medium text-sm">Active model</p>
						<p className="text-muted-foreground text-xs">
							Serve this model from the local engine.
						</p>
					</div>
					<ActiveModelControl repoId={card.id} />
				</section>
			)}

			{/* Adapt this model to your own data with a LoRA fine-tune (Unsloth).
			    Opens the Fine-tune page. Install-capable surfaces with a shell only. */}
			{installLayer && host.navigate && (
				<section className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 px-4 py-3">
					<div className="min-w-0">
						<p className="font-medium text-sm">Fine-tune this model</p>
						<p className="text-muted-foreground text-xs">
							Train a LoRA on your data, then merge to a servable GGUF.
						</p>
					</div>
					<Button
						onClick={() => host.navigate?.("/plugin/com.ryu.finetune")}
						size="sm"
						variant="outline"
					>
						Fine-tune
					</Button>
				</section>
			)}

			{/* Fine-tuned variants of this model: merged GGUFs trained from it. */}
			{installLayer && <FinetunedVariants baseId={card.id} />}

			{/* Vision model: the matching projector installs automatically. */}
			{vision && (
				<section className="flex gap-2 rounded-lg border border-violet-500/30 bg-violet-500/5 px-4 py-3 text-muted-foreground text-xs">
					<HugeiconsIcon
						className="mt-0.5 size-4 shrink-0 text-violet-500"
						icon={AiBrain01Icon}
					/>
					<p>
						This is a{" "}
						<span className="font-medium text-foreground">vision model</span>.
						Its image adapter is downloaded automatically alongside the quant
						you choose, and loaded for you when the model runs.
					</p>
				</section>
			)}

			{/* GGUF: per-quant file picker. Snapshot formats (safetensors/MLX):
			    a single repo install. Install-capable surfaces only. */}
			{installLayer &&
				(format === "gguf" ? (
					<FileSections
						files={files}
						fitStyle={host.fitStyle}
						friendly={friendly}
						InstallButton={installLayer.InstallButton}
						install={install}
						installing={installing}
						uninstall={uninstall}
						uninstalling={uninstalling}
					/>
				) : (
					<SnapshotInstall
						card={card}
						InstallButton={installLayer.InstallButton}
						installed={card.installed}
						installing={installingSnapshot}
						onInstall={installSnapshot}
						repoFitLabel={repoFitLabel}
						repoSizeBytes={repoSizeBytes}
					/>
				))}

			{/* README */}
			{readme && (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">About this model</h3>
					<div className="prose prose-sm dark:prose-invert max-w-none text-sm">
						<Markdown className="[&_ol]:pl-10 [&_ul]:pl-9" content={readme} />
					</div>
				</section>
			)}
		</div>
	);
}

function StatsBlock({
	stats,
	present,
}: {
	stats: ModelDetail["stats"];
	present: boolean;
}) {
	if (!stats) {
		if (!present) {
			return (
				<section className="rounded-lg border border-dashed px-4 py-3 text-muted-foreground text-xs">
					Add an Artificial Analysis API key (
					<code>ARTIFICIAL_ANALYSIS_API_KEY</code>) to see independent speed,
					quality, and price benchmarks here.
				</section>
			);
		}
		return null;
	}

	const items: {
		icon: typeof AiBrain01Icon;
		label: string;
		value: string | null;
	}[] = [
		{
			icon: AiBrain01Icon,
			label: "Intelligence",
			value:
				stats.intelligenceIndex === null
					? null
					: stats.intelligenceIndex.toFixed(0),
		},
		{
			icon: FlashIcon,
			label: "Speed (tok/s)",
			value:
				stats.outputTokensPerSecond === null
					? null
					: stats.outputTokensPerSecond.toFixed(0),
		},
		{
			icon: HardDriveIcon,
			label: "First token",
			value:
				stats.timeToFirstTokenS === null
					? null
					: `${stats.timeToFirstTokenS.toFixed(2)}s`,
		},
		{
			icon: DollarCircleIcon,
			label: "Price /1M",
			value:
				stats.priceUsdPer1m === null
					? null
					: `$${stats.priceUsdPer1m.toFixed(2)}`,
		},
	];

	return (
		<section className="flex flex-col gap-2 rounded-lg border px-4 py-3">
			<div className="flex items-center gap-2 text-sm">
				<span className="font-medium">Benchmarks</span>
				<span className="text-muted-foreground text-xs">
					via Artificial Analysis ({stats.matchedName})
				</span>
			</div>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{items.map((it) => (
					<div className="flex flex-col gap-0.5" key={it.label}>
						<span className="flex items-center gap-1 text-muted-foreground text-xs">
							<HugeiconsIcon className="size-3.5" icon={it.icon} />
							{it.label}
						</span>
						<span className="font-semibold text-sm">{it.value ?? "—"}</span>
					</div>
				))}
			</div>
		</section>
	);
}

/**
 * The "Installed" affordance for a downloaded quant: a button that reads
 * "Installed" at rest and morphs into a destructive "Uninstall" on hover/focus,
 * so the same control that installed a file also removes it (no separate icon).
 */
function InstalledButton({
	busy,
	onUninstall,
}: {
	busy: boolean;
	onUninstall: () => void;
}) {
	const [armed, setArmed] = useState(false);
	// Resolve the three visual states (busy / armed-to-remove / at-rest) without
	// nested ternaries.
	let label = "Installed";
	if (busy) {
		label = "Removing…";
	} else if (armed) {
		label = "Uninstall";
	}
	return (
		<Button
			className="shrink-0 gap-1"
			disabled={busy}
			onBlur={() => setArmed(false)}
			onClick={onUninstall}
			onFocus={() => setArmed(true)}
			onMouseEnter={() => setArmed(true)}
			onMouseLeave={() => setArmed(false)}
			size="sm"
			variant={armed ? "destructive" : "secondary"}
		>
			{busy && <Spinner className="size-4" />}
			{!busy && (
				<HugeiconsIcon
					className={armed ? "size-3.5" : "size-3.5 text-success"}
					icon={armed ? Delete01Icon : CheckmarkCircle02Icon}
				/>
			)}
			{label}
		</Button>
	);
}

/** GB string for a snapshot repo's total size. */
function formatRepoSize(bytes: number | null): string {
	if (!bytes || bytes <= 0) {
		return "Size unknown";
	}
	const gb = bytes / 1_000_000_000;
	if (gb >= 1) {
		return `${gb.toFixed(1)} GB`;
	}
	return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * Snapshot install block for safetensors / MLX models — a single "install the
 * whole repo" action (no per-quant picker). Shows the repo size + a conservative
 * fit label, and gates the button when no engine for this format is runnable on
 * the node.
 */
function SnapshotInstall({
	card,
	installed,
	installing,
	onInstall,
	repoSizeBytes,
	repoFitLabel,
	InstallButton,
}: {
	card: ModelCard;
	installed: boolean;
	installing: boolean;
	onInstall: () => Promise<void>;
	repoSizeBytes: number | null;
	repoFitLabel: string;
	InstallButton: InstallButton;
}) {
	const blocked = !card.compatible;
	return (
		<section className="flex flex-col gap-3">
			<h3 className="font-medium text-sm">
				{card.format === "mlx" ? "MLX model" : "Safetensors model"}
			</h3>
			<div className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 px-4 py-3">
				<div className="min-w-0">
					<p className="font-medium text-sm">{formatRepoSize(repoSizeBytes)}</p>
					<p className="text-muted-foreground text-xs">
						{blocked
							? card.format === "mlx"
								? "Requires MLX (Apple Silicon) — not available on this computer."
								: `Requires ${card.needsEngine ?? "another engine"} — not available on this computer.`
							: repoFitLabel || "Installs the full model repository."}
					</p>
				</div>
				{installed ? (
					<Badge variant="secondary">
						<HugeiconsIcon className="size-3.5" icon={CheckmarkCircle02Icon} />
						Installed
					</Badge>
				) : (
					<InstallButton
						busyLabel="Installing…"
						disabled={blocked || installing}
						installing={installing}
						onClick={() => {
							onInstall().catch(() => undefined);
						}}
						// Snapshot downloads label as "<repo_id> (<file>)" — match on the id.
						progress={{ kinds: ["model"], name: card.id }}
					>
						<HugeiconsIcon className="size-4" icon={Download01Icon} />
						Install repository
					</InstallButton>
				)}
			</div>
		</section>
	);
}

interface FileSectionsProps {
	files: ModelFile[];
	fitStyle: FitStyle;
	friendly: boolean;
	InstallButton: InstallButton;
	install: (file: string) => Promise<void>;
	installing: string | null;
	uninstall: (file: string) => Promise<void>;
	uninstalling: string | null;
}

/** Device-fit rank for the canonical-variant tie-break — lower is a better fit. */
const FIT_RANK: Record<FitVerdict, number> = {
	great: 0,
	ok: 1,
	partial: 2,
	cpu: 3,
	too_big: 4,
	unknown: 5,
};

/** One friendly compression tier with the single variant shown by default and
 *  the others stashed behind a "show more" disclosure. */
interface QuantTierGroup {
	/** The representative variant surfaced for this tier. */
	canonical: ModelFile;
	/** Friendly tier label, also the grouping + React key. */
	key: string;
	quality: number | null;
	/** The remaining variants in the same tier, hidden until expanded. */
	rest: ModelFile[];
}

/** Order two variants of the same tier; the first is the canonical pick. Prefers
 *  the standard quant variant (Q*_K_M …), then the better device fit, then the
 *  smaller file. */
function compareVariants(a: ModelFile, b: ModelFile): number {
	const rankDelta = quantVariantRank(a.quant) - quantVariantRank(b.quant);
	if (rankDelta !== 0) {
		return rankDelta;
	}
	const fitDelta = (FIT_RANK[a.fit] ?? 9) - (FIT_RANK[b.fit] ?? 9);
	if (fitDelta !== 0) {
		return fitDelta;
	}
	return (
		(a.sizeBytes ?? Number.POSITIVE_INFINITY) -
		(b.sizeBytes ?? Number.POSITIVE_INFINITY)
	);
}

/**
 * Group GGUF download files by their friendly compression tier, choosing one
 * canonical variant per tier and stashing the rest. Used only in friendly mode.
 */
function groupFilesByTier(files: ModelFile[]): QuantTierGroup[] {
	const order: string[] = [];
	const byKey = new Map<string, ModelFile[]>();
	for (const f of files) {
		const key = friendlyQuant(f.quant).label;
		const bucket = byKey.get(key);
		if (bucket) {
			bucket.push(f);
		} else {
			byKey.set(key, [f]);
			order.push(key);
		}
	}
	const groups: QuantTierGroup[] = [];
	for (const key of order) {
		const [canonical, ...rest] = [...(byKey.get(key) ?? [])].sort(
			compareVariants
		);
		// Every key in `order` was seeded with at least one file, so `canonical` is
		// always present; the guard only satisfies noUncheckedIndexedAccess.
		if (!canonical) {
			continue;
		}
		groups.push({
			key,
			quality: friendlyQuant(canonical.quant).quality,
			canonical,
			rest,
		});
	}
	// Stable sort climbs by quality; equal/unknown qualities keep insertion order.
	return groups.sort(
		(a, b) =>
			(a.quality ?? Number.POSITIVE_INFINITY) -
			(b.quality ?? Number.POSITIVE_INFINITY)
	);
}

/**
 * One friendly quant tier: the canonical variant, plus a "show N more variants"
 * disclosure that reveals the rest. Only rendered in friendly mode.
 */
function QuantTierGroupRows({
	group,
	install,
	installing,
	uninstall,
	uninstalling,
	InstallButton,
	fitStyle,
}: {
	group: QuantTierGroup;
	install: (file: string) => Promise<void>;
	installing: string | null;
	uninstall: (file: string) => Promise<void>;
	uninstalling: string | null;
	InstallButton: InstallButton;
	fitStyle: FitStyle;
}) {
	const [expanded, setExpanded] = useState(false);
	const moreCount = group.rest.length;
	return (
		<>
			<FileRow
				file={group.canonical}
				fitStyle={fitStyle}
				friendly
				InstallButton={InstallButton}
				install={install}
				installing={installing}
				uninstall={uninstall}
				uninstalling={uninstalling}
			/>
			{moreCount > 0 && !expanded && (
				<li>
					<Button
						className="h-auto px-1 py-0.5 text-muted-foreground text-xs"
						onClick={() => setExpanded(true)}
						size="sm"
						variant="ghost"
					>
						Show {moreCount} more {moreCount === 1 ? "variant" : "variants"}
					</Button>
				</li>
			)}
			{expanded &&
				group.rest.map((f) => (
					<FileRow
						disambiguate
						file={f}
						fitStyle={fitStyle}
						friendly
						InstallButton={InstallButton}
						install={install}
						installing={installing}
						key={f.filename}
						uninstall={uninstall}
						uninstalling={uninstalling}
					/>
				))}
		</>
	);
}

/**
 * The detail panel's file list, split into three reads: an "Installed" section,
 * "Download options" (the model's own quantizations), and "Add-ons" — auxiliary
 * files like vision adapters and draft/MTP heads that pair with a base model.
 *
 * In friendly mode the download options are further grouped by compression tier
 * (one canonical row each, the rest behind "show more"). Technical mode keeps the
 * full flat list.
 */
function FileSections({
	files,
	friendly,
	install,
	installing,
	uninstall,
	uninstalling,
	InstallButton,
	fitStyle,
}: FileSectionsProps) {
	if (files.length === 0) {
		return (
			<section className="flex flex-col gap-2">
				<h3 className="font-medium text-sm">Download options</h3>
				<p className="text-muted-foreground text-sm">
					No GGUF files found in this repo. It may not be runnable with the
					local engine.
				</p>
			</section>
		);
	}

	const renderRow = (f: ModelFile) => {
		const role = ggufFileRole(f.filename);
		return (
			<FileRow
				file={f}
				fitStyle={fitStyle}
				friendly={friendly}
				InstallButton={InstallButton}
				install={install}
				installing={installing}
				key={f.filename}
				role={role}
				uninstall={uninstall}
				uninstalling={uninstalling}
			/>
		);
	};

	const installed = files.filter((f) => f.installed);
	const notInstalled = files.filter((f) => !f.installed);
	const downloads = notInstalled.filter(
		(f) => ggufFileRole(f.filename) === null
	);
	const addons = notInstalled.filter((f) => ggufFileRole(f.filename) !== null);

	return (
		<div className="flex flex-col gap-5">
			{installed.length > 0 && (
				<section className="flex flex-col gap-2">
					<h3 className="flex items-center gap-1.5 font-medium text-sm">
						<HugeiconsIcon
							className="size-4 text-success"
							icon={CheckmarkCircle02Icon}
						/>
						Installed
					</h3>
					<ul className="flex flex-col gap-2">{installed.map(renderRow)}</ul>
				</section>
			)}
			{downloads.length > 0 && (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">Download options</h3>
					<ul className="flex flex-col gap-2">
						{friendly
							? groupFilesByTier(downloads).map((g) => (
									<QuantTierGroupRows
										fitStyle={fitStyle}
										group={g}
										InstallButton={InstallButton}
										install={install}
										installing={installing}
										key={g.key}
										uninstall={uninstall}
										uninstalling={uninstalling}
									/>
								))
							: downloads.map(renderRow)}
					</ul>
				</section>
			)}
			{addons.length > 0 && (
				<section className="flex flex-col gap-2">
					<h3 className="font-medium text-sm">Add-ons</h3>
					<p className="text-muted-foreground text-xs">
						Optional companion files (vision adapters, draft heads) that pair
						with a model quant above — not standalone models.
					</p>
					<ul className="flex flex-col gap-2">{addons.map(renderRow)}</ul>
				</section>
			)}
		</div>
	);
}

/**
 * A segmented "more bars = better" quality meter for a friendly-mode quant.
 * Rendered only when the quality is known.
 */
// Stable pip levels (1..max) so each meter segment has a fixed key identity.
const QUALITY_PIPS = Array.from({ length: QUANT_QUALITY_MAX }, (_, i) => i + 1);

function QualityMeter({ quality, label }: { quality: number; label: string }) {
	return (
		<span
			aria-label={`Quality: ${quality} of ${QUANT_QUALITY_MAX} (${label})`}
			className="flex items-center gap-0.5"
			role="img"
		>
			{QUALITY_PIPS.map((level) => (
				<span
					className={`h-2.5 w-1 rounded-full ${level <= quality ? "bg-success" : "bg-muted-foreground/25"}`}
					key={level}
				/>
			))}
		</span>
	);
}

function FileRow({
	file,
	install,
	installing,
	uninstall,
	uninstalling,
	friendly,
	role,
	disambiguate = false,
	InstallButton,
	fitStyle,
}: {
	file: ModelFile;
	install: (file: string) => Promise<void>;
	installing: string | null;
	uninstall: (file: string) => Promise<void>;
	uninstalling: string | null;
	friendly: boolean;
	role?: GgufRole | null;
	// In friendly mode, several variants share one tier label; when this row is
	// one of the "show more" variants, append the raw quant so the otherwise
	// identical rows are still distinguishable.
	disambiguate?: boolean;
	InstallButton: InstallButton;
	fitStyle: FitStyle;
}) {
	const fit = fitStyle(file.fit);
	const isInstalling = installing === file.filename;
	const isUninstalling = uninstalling === file.filename;
	const tooBig = file.fit === "too_big";
	const compression = friendlyQuant(file.quant);
	const handleInstall = () => {
		install(file.filename).catch(() => undefined);
	};
	const handleUninstall = () => {
		uninstall(file.filename).catch(() => undefined);
	};

	// Auxiliary files (vision adapter / draft head) aren't model quants, so they
	// get their role label and an explanatory tooltip — never a quality meter.
	const renderLabel = () => {
		if (role) {
			return (
				<Tooltip>
					<TooltipTrigger
						render={<span className="font-medium text-sm">{role.label}</span>}
					/>
					<TooltipContent>{role.tooltip}</TooltipContent>
				</Tooltip>
			);
		}
		if (friendly) {
			return (
				<Tooltip>
					<TooltipTrigger
						render={
							<span className="flex items-center gap-2">
								{compression.quality !== null && (
									<QualityMeter
										label={compression.label}
										quality={compression.quality}
									/>
								)}
								<span className="font-medium text-sm">{compression.label}</span>
								{disambiguate && file.quant && (
									<span className="text-muted-foreground text-xs">
										{file.quant}
									</span>
								)}
							</span>
						}
					/>
					<TooltipContent>{compression.tooltip}</TooltipContent>
				</Tooltip>
			);
		}
		return <span className="font-medium text-sm">{file.quant ?? "GGUF"}</span>;
	};

	const installButton = (
		<InstallButton
			idleVariant={tooBig ? "outline" : "default"}
			installing={isInstalling}
			onClick={handleInstall}
			progress={{ kinds: ["model"], name: file.filename }}
		>
			<HugeiconsIcon className="size-4" icon={Download01Icon} />
			Install
		</InstallButton>
	);

	return (
		<li className="flex items-center gap-3 rounded-md border px-3 py-2">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					{renderLabel()}
					{file.sizeHuman && (
						<span className="text-muted-foreground text-xs">
							{file.sizeHuman}
						</span>
					)}
				</div>
				<div
					className={`mt-0.5 flex items-center gap-1.5 text-xs ${fit.className}`}
				>
					<span className={`size-1.5 rounded-full ${fit.dot}`} />
					{file.fitLabel}
				</div>
			</div>
			{file.installed ? (
				<InstalledButton busy={isUninstalling} onUninstall={handleUninstall} />
			) : tooBig ? (
				<Tooltip>
					<TooltipTrigger render={installButton} />
					<TooltipContent>
						This may not fit in your device's memory
					</TooltipContent>
				</Tooltip>
			) : (
				installButton
			)}
		</li>
	);
}
