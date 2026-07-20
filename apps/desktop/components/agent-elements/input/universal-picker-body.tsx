"use client";

// The universal picker's dropdown BODY — the grouped
// `Ryu Portal · Providers · External Agents` layout that replaces the old
// sibling-submenu list (Agent / Model / Approval as peers). Fed to
// `ComposerSettingsMenu` via its `renderBody` prop, so the trigger summary
// (`Ryu · Sonnet · Plan`) is unchanged; only the popover body is new.
//
// Three sections, one search box on top:
//   1. Ryu Portal   — the flagship `ryu` agent (Pi + Gateway). When it's the
//                      active target its live model + thinking pickers nest under it.
//   2. Providers    — every Pi provider the Ryu agent can route to. A configured
//                      provider drills into its models + thinking; an unconfigured
//                      one offers a single "Configure credentials" row that opens
//                      the Gateway → Providers dialog.
//   3. External agents — installed ACP harnesses (Claude Code, Codex, Gemini CLI,
//                      …) drill into their advertised model / thinking / approval,
//                      probed LAZILY on submenu-open (one subprocess, not a storm).
//                      Not-installed catalog entries render greyed with an Install
//                      button on the right.
//
// The lazy probe is the load-bearing detail: `DropdownMenuSubContent` (Base UI,
// `keepMounted={false}`) unmounts a closed submenu's children, so
// `ExternalAgentSettings` only calls `useComposerAcpSections` (which spawns the
// agent subprocess on first fetch) when its submenu is actually opened.

import {
	CheckmarkCircle02Icon,
	Download04Icon,
	HelpCircleIcon,
	Loading03Icon,
	PlugSocketIcon,
	SparklesIcon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { Input } from "@ryu/ui/components/input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import type {
	ComposerSettingItem,
	ComposerSettingsSection,
} from "@/components/agent-elements/input/composer-settings-menu.tsx";
import { groupModelItems } from "@/components/agent-elements/input/model-groups.ts";
import { createModelMenuRenderer } from "@/components/agent-elements/input/model-menu-content.tsx";
import { useComposerAcpSections } from "@/components/agent-elements/input/use-composer-acp-sections.ts";
import type { ModelOption } from "@/components/agent-elements/types.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { AgentLogo } from "@/src/lib/agent-logos.tsx";
import type { AgentCatalogEntry, AgentSummary } from "@/src/lib/api/agents.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { discoverModels } from "@/src/lib/api/pi-config.ts";

/** A Pi provider row for the Providers section (built by `useUniversalPicker`). */
export interface ProviderEntry {
	/** Pi auth kind: "subscription" (OAuth login) | "api-key" | "none". */
	authKind: string;
	/** Whether a usable credential is stored (drives the models-vs-configure body). */
	configured: boolean;
	/** The provider's current model when it is the active target, else null. */
	currentModel: string | null;
	/** The provider's current thinking level when active, else null. */
	currentThinking: string | null;
	/** Engine key for the brand logo (anthropic / openai / gemini / …). */
	engineKey: string;
	id: string;
	/** True when this provider is the Ryu agent's active route. */
	isActive: boolean;
	label: string;
	/** True for the Ryu-managed provider (included with the plan, no key). Drives
	 * the upsell body when the user has no active subscription (`configured` false). */
	managed: boolean;
	/** Selectable models (from the provider's suggested set; live-discovered ids
	 * are merged in on open for discovery-capable providers like OpenRouter). */
	models: ComposerSettingItem[];
	/** Whether Core can dynamically enumerate this provider's full model list. */
	supportsDiscovery: boolean;
	/** The managed provider with no active paid plan → show the subscription upsell
	 * instead of the model list. The managed provider is always `configured` (it is
	 * wallet-gated server-side), so upsell is gated on the entitlement, not `configured`. */
	upsell: boolean;
}

/** A team row for the optional Teams section. */
export interface TeamEntry {
	engines: (string | null)[];
	id: string;
	isActive: boolean;
	name: string;
}

/**
 * Sentinel composer agent id for the "Auto" row (Plane B — Core resolves the real
 * agent per-turn). Distinct from Ryu smart-route (Plane A, a model pick) and
 * `openrouter/auto` (an upstream model id).
 */
export const AUTO_AGENT_ID = "auto";

export interface UniversalPickerData {
	activeAgentId: string | null;
	/** The active agent's live model section (approval/thinking live too). Only
	 * meaningful for the currently-selected target — nested under whichever row is
	 * active so its picks wire straight to the host's live handlers. */
	activeExtraSections: ComposerSettingsSection[];
	activeModelSection: ComposerSettingsSection | null;
	agents: AgentSummary[];
	/** Not-installed external agents (catalog entries with `added === false`). */
	availableExternal: AgentCatalogEntry[];
	/** Installed external ACP agents (transport `acp`, excluding the flagship). */
	installedExternal: AgentSummary[];
	/** Id of the external agent whose install is in flight, or null. */
	installPendingId: string | null;
	/** Open the agent-auto rules editor (the picker "Auto" row's Configure…). */
	onConfigureAuto: () => void;
	onConfigureCredentials: () => void;
	onCreateAgent?: () => void;
	onInstallExternal: (id: string) => void;
	onSelectAgent: (id: string) => void;
	onSelectProviderModel: (providerId: string, modelId: string) => void;
	onSelectProviderThinking: (providerId: string, level: string) => void;
	onSelectTeam?: (id: string) => void;
	/** Open the subscription upgrade / paywall (managed-provider upsell). */
	onUpgrade: () => void;
	onUseProvider: (providerId: string) => void;
	providers: ProviderEntry[];
	ryuActive: boolean;
	/** The flagship Ryu agent, or null if somehow absent from the registry. */
	ryuAgent: AgentSummary | null;
	teams: TeamEntry[];
	/** Provider thinking levels (Pi `thinkingLevels`) for the provider rows. */
	thinkingLevels: string[];
}

const SEARCH_THRESHOLD = 6;

/** Section header, with an optional hover-explained "?" tooltip. */
function SectionHeader({
	label,
	tooltip,
}: {
	label: string;
	tooltip?: string;
}) {
	return (
		<div className="flex items-center gap-1 px-3 pt-2 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
			<span>{label}</span>
			{tooltip && (
				<Tooltip>
					<TooltipTrigger
						render={
							<span
								aria-label={tooltip}
								className="flex size-4 items-center justify-center rounded-full text-muted-foreground/70 hover:text-foreground"
								role="img"
							/>
						}
					>
						<HugeiconsIcon icon={HelpCircleIcon} size={13} />
					</TooltipTrigger>
					<TooltipContent className="max-w-56 text-xs">
						{tooltip}
					</TooltipContent>
				</Tooltip>
			)}
		</div>
	);
}

function LoadingRow({ text = "Detecting…" }: { text?: string }) {
	return (
		<div className="flex items-center gap-2 px-2.5 py-2 text-[13px] text-muted-foreground">
			<HugeiconsIcon
				className="shrink-0 animate-spin"
				icon={Loading03Icon}
				size={14}
				strokeWidth={2}
			/>
			<span>{text}</span>
		</div>
	);
}

/** One picker row inside a setting submenu (model / thinking / approval value). */
function SettingItemRow({
	item,
	isActive,
	decoClassName,
	onSelect,
}: {
	decoClassName?: string;
	isActive: boolean;
	item: ComposerSettingItem;
	onSelect: (id: string) => void;
}) {
	return (
		<DropdownMenuItem
			className={cn(
				"flex-col items-start gap-0.5",
				isActive && "bg-foreground/10"
			)}
			key={item.id}
			onClick={() => onSelect(item.id)}
		>
			<span className="flex w-full items-center gap-2.5">
				<span className={cn("flex-1 truncate", decoClassName)}>
					{item.name}
				</span>
				{isActive && (
					<HugeiconsIcon
						className="shrink-0 text-muted-foreground"
						icon={Tick02Icon}
						size={16}
						strokeWidth={2}
					/>
				)}
			</span>
			{item.description && (
				<span className="w-full truncate text-left font-normal text-muted-foreground text-xs">
					{item.description}
				</span>
			)}
		</DropdownMenuItem>
	);
}

/**
 * A nested submenu for one `ComposerSettingsSection` (Model / Thinking /
 * Approval). Renders the section's custom grouped body when it has one (the
 * searchable model list), else a flat checked list with the section's optional
 * CLI-style decoration (approval tones). Hidden when it has nothing to offer.
 */
function SettingSub({
	section,
	close,
}: {
	close: () => void;
	section: ComposerSettingsSection;
}) {
	const loadingEmpty = Boolean(section.loading) && section.items.length === 0;
	if (section.items.length === 0 && !section.renderContent && !loadingEmpty) {
		return null;
	}
	const active =
		section.items.find((it) => it.id === section.value) ?? section.items[0];
	const activeDeco = active ? section.decorate?.(active) : undefined;
	const onSelect = (id: string) => {
		section.onChange(id);
		close();
	};
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<span className="flex-1 text-[13px] text-muted-foreground">
					{section.label}
				</span>
				<span
					className={cn(
						"flex max-w-[140px] items-center gap-1.5 text-[13px] text-muted-foreground",
						!loadingEmpty && activeDeco?.className
					)}
				>
					{loadingEmpty ? (
						<HugeiconsIcon
							className="shrink-0 animate-spin"
							icon={Loading03Icon}
							size={14}
							strokeWidth={2}
						/>
					) : (
						activeDeco && (
							<HugeiconsIcon
								className="shrink-0"
								icon={activeDeco.icon}
								size={14}
								strokeWidth={2}
							/>
						)
					)}
					<span className="truncate">
						{loadingEmpty ? "Detecting…" : active?.name}
					</span>
				</span>
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="max-h-80 min-w-[220px] max-w-[300px] overflow-hidden p-0">
				{loadingEmpty ? (
					<LoadingRow text="Detecting available options…" />
				) : section.renderContent ? (
					section.renderContent(onSelect)
				) : (
					section.items.map((item) => {
						const deco = section.decorate?.(item);
						return (
							<SettingItemRow
								decoClassName={deco?.className}
								isActive={item.id === (section.value ?? section.items[0]?.id)}
								item={item}
								key={item.id}
								onSelect={onSelect}
							/>
						);
					})
				)}
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}

/** A brand logo + name row header inside a target's submenu. */
function UseTargetItem({
	label,
	isActive,
	onSelect,
}: {
	isActive: boolean;
	label: string;
	onSelect: () => void;
}) {
	return (
		<DropdownMenuItem className="gap-2" onClick={onSelect}>
			<HugeiconsIcon
				className={cn(
					"shrink-0",
					isActive ? "text-foreground" : "text-muted-foreground"
				)}
				icon={CheckmarkCircle02Icon}
				size={16}
				strokeWidth={2}
			/>
			<span className="flex-1 truncate">{label}</span>
			{isActive && (
				<HugeiconsIcon
					className="shrink-0 text-muted-foreground"
					icon={Tick02Icon}
					size={16}
					strokeWidth={2}
				/>
			)}
		</DropdownMenuItem>
	);
}

/**
 * The lazily-mounted settings body for one external ACP agent — its advertised
 * model, thinking, and approval pickers. Because it only mounts when its parent
 * submenu opens (Base UI unmounts closed `SubContent`), the `useComposerAcpSections`
 * probe (which spawns the agent subprocess on first fetch) fires for exactly the
 * one agent the user drilled into. For the active agent this is a cache hit (the
 * host already probed it), so no extra subprocess is spawned.
 */
function ExternalAgentSettings({
	agent,
	agents,
	isActive,
	onSelect,
	close,
}: {
	agent: AgentSummary;
	agents: AgentSummary[];
	close: () => void;
	isActive: boolean;
	onSelect: () => void;
}) {
	const noModelOptions = useMemo<ModelOption[]>(() => [], []);
	const { modelSection, extraSections } = useComposerAcpSections({
		agentId: agent.id,
		agents,
		modelOptions: noModelOptions,
		engineModel: null,
		onEngineModelChange: NOOP,
	});
	const modelAsSection: ComposerSettingsSection = {
		key: "model",
		label: "Model",
		ariaLabel: "Model",
		items: modelSection.items,
		value: modelSection.value,
		onChange: (id) => {
			modelSection.onChange(id);
			// Picking a model on a non-active agent also switches to it.
			if (!isActive) {
				onSelect();
			}
		},
		renderContent: modelSection.renderContent,
		loading: modelSection.loading,
	};
	return (
		<>
			<UseTargetItem
				isActive={isActive}
				label={`Use ${agent.name}`}
				onSelect={() => {
					onSelect();
					close();
				}}
			/>
			<SettingSub close={close} section={modelAsSection} />
			{extraSections.map((section) => (
				<SettingSub
					close={close}
					key={section.key}
					section={{
						...section,
						onChange: (id) => {
							section.onChange(id);
							if (!isActive) {
								onSelect();
							}
						},
					}}
				/>
			))}
		</>
	);
}

function NOOP() {
	// Non-ACP engine-model changes don't apply to external agents.
}

/** A single icon + label action row inside a provider submenu. */
function ActionRow({
	icon,
	label,
	description,
	onClick,
}: {
	description?: string;
	icon: typeof PlugSocketIcon;
	label: string;
	onClick: () => void;
}) {
	return (
		<DropdownMenuItem
			className="flex-col items-start gap-0.5"
			onClick={onClick}
		>
			<span className="flex w-full items-center gap-2">
				<HugeiconsIcon
					className="shrink-0 text-muted-foreground"
					icon={icon}
					size={16}
					strokeWidth={2}
				/>
				<span className="flex-1 truncate">{label}</span>
			</span>
			{description && (
				<span className="w-full truncate pl-6 text-left font-normal text-muted-foreground text-xs">
					{description}
				</span>
			)}
		</DropdownMenuItem>
	);
}

/**
 * Provider submenu body. Configured → its models (live-discovered for OpenRouter
 * and friends) + thinking. Unconfigured branches by auth kind: the managed Ryu
 * provider upsells the subscription (with a BYO-key escape hatch), a subscription
 * provider offers OAuth sign-in, an api-key provider links to the credential dialog.
 */
function ProviderSubBody({
	provider,
	thinkingLevels,
	onUse,
	onModel,
	onThinking,
	onConfigure,
	onUpgrade,
	close,
}: {
	close: () => void;
	onConfigure: () => void;
	onModel: (modelId: string) => void;
	onThinking: (level: string) => void;
	onUpgrade: () => void;
	onUse: () => void;
	provider: ProviderEntry;
	thinkingLevels: string[];
}) {
	const node = useActiveNode();
	// Live-enumerate the provider's full model list once the submenu opens (this
	// component only mounts on open). OpenRouter exposes hundreds of models Core's
	// static `suggestedModels` can't carry, so a discovery-capable provider gets the
	// real list; others fall back to the suggestions. The managed provider carries no
	// models_url of its own, so its full list is enumerated from the public OpenRouter
	// catalog (the same models it routes to).
	const discoveryId = provider.managed ? "openrouter" : provider.id;
	const discoverable =
		!provider.upsell &&
		provider.configured &&
		(provider.supportsDiscovery || provider.managed);
	const discovery = useQuery({
		queryKey: ["pi-discover", node.url, discoveryId],
		queryFn: () => discoverModels(toTarget(node), { provider: discoveryId }),
		enabled: discoverable,
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
	});

	const modelItems = useMemo<ComposerSettingItem[]>(() => {
		const seen = new Set<string>();
		const out: ComposerSettingItem[] = [];
		const push = (id: string, name?: string) => {
			if (id && !seen.has(id)) {
				seen.add(id);
				out.push({ id, name: name ?? id });
			}
		};
		for (const m of discovery.data?.models ?? []) {
			push(m.id, m.name);
		}
		for (const it of provider.models) {
			push(it.id, it.name);
		}
		return out;
	}, [discovery.data, provider.models]);

	if (provider.upsell) {
		return (
			<>
				<ActionRow
					description="Every model through Ryu's managed OpenRouter — no API keys, one subscription."
					icon={SparklesIcon}
					label="Upgrade to Ryu"
					onClick={() => {
						onUpgrade();
						close();
					}}
				/>
				<ActionRow
					description="Already have an OpenRouter key? Add it instead."
					icon={PlugSocketIcon}
					label="Use your own key"
					onClick={() => {
						onConfigure();
						close();
					}}
				/>
			</>
		);
	}

	if (!provider.configured) {
		const isSubscription = provider.authKind === "subscription";
		return (
			<ActionRow
				description={
					isSubscription
						? "Use your existing subscription — no API key needed."
						: undefined
				}
				icon={PlugSocketIcon}
				label={
					isSubscription
						? `Sign in with ${provider.label}`
						: "Configure credentials"
				}
				onClick={() => {
					onConfigure();
					close();
				}}
			/>
		);
	}

	// A long, discovered list (OpenRouter) gets the grouped + searchable model menu;
	// a short suggested list renders as a plain checked list.
	const useGroupedMenu = modelItems.length > 8;
	const modelSection: ComposerSettingsSection = {
		key: `provider-model-${provider.id}`,
		label: "Model",
		ariaLabel: "Model",
		items: modelItems,
		value: provider.currentModel ?? undefined,
		onChange: onModel,
		loading: discovery.isLoading,
		renderContent: useGroupedMenu
			? createModelMenuRenderer(
					groupModelItems(modelItems),
					provider.currentModel ?? undefined
				)
			: undefined,
	};
	const thinkingSection: ComposerSettingsSection = {
		key: `provider-thinking-${provider.id}`,
		label: "Thinking",
		ariaLabel: "Thinking",
		items: thinkingLevels.map((level) => ({
			id: level,
			name: level.charAt(0).toUpperCase() + level.slice(1),
		})),
		value: provider.currentThinking ?? undefined,
		onChange: onThinking,
	};
	return (
		<>
			<UseTargetItem
				isActive={provider.isActive}
				label={`Use ${provider.label}`}
				onSelect={() => {
					onUse();
					close();
				}}
			/>
			<SettingSub close={close} section={modelSection} />
			{thinkingLevels.length > 0 && (
				<SettingSub close={close} section={thinkingSection} />
			)}
		</>
	);
}

/** A top-level target row that opens a submenu (its settings body). */
function TargetSub({
	label,
	engineKey,
	avatarUrl,
	isActive,
	children,
}: {
	avatarUrl?: string | null;
	children: ReactNode;
	engineKey: string | null;
	isActive: boolean;
	label: string;
}) {
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger className={cn(isActive && "bg-foreground/10")}>
				<span className="flex min-w-0 flex-1 items-center gap-2">
					{avatarUrl ? (
						// biome-ignore lint/performance/noImgElement: Tauri/Vite, data URL avatar
						// biome-ignore lint/correctness/useImageSize: sized via class
						<img
							alt=""
							className="size-4 shrink-0 rounded-full object-cover"
							src={avatarUrl}
						/>
					) : (
						<AgentLogo
							className="size-4 shrink-0"
							engine={engineKey}
							size="16px"
						/>
					)}
					<span className="truncate">{label}</span>
				</span>
				{isActive && (
					<HugeiconsIcon
						className="mr-1 shrink-0 text-muted-foreground"
						icon={Tick02Icon}
						size={15}
						strokeWidth={2}
					/>
				)}
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="max-h-96 min-w-[220px] max-w-[320px] overflow-y-auto p-1">
				{children}
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}

/** A greyed, not-installed external agent row with a right-aligned Install button. */
function AvailableAgentRow({
	entry,
	installing,
	onInstall,
}: {
	entry: AgentCatalogEntry;
	installing: boolean;
	onInstall: () => void;
}) {
	return (
		<div className="flex items-center gap-2 rounded-md px-2 py-1.5">
			<AgentLogo
				className="size-4 shrink-0 opacity-50"
				engine={entry.engine ?? entry.id}
				size="16px"
			/>
			<span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
				{entry.name}
			</span>
			<Button
				className="h-6 shrink-0 gap-1 px-2 text-xs"
				disabled={installing || !entry.available}
				onClick={(e) => {
					e.stopPropagation();
					onInstall();
				}}
				size="sm"
				type="button"
				variant="outline"
			>
				{installing ? (
					<HugeiconsIcon
						className="animate-spin"
						icon={Loading03Icon}
						size={12}
						strokeWidth={2}
					/>
				) : (
					<HugeiconsIcon icon={Download04Icon} size={12} strokeWidth={2} />
				)}
				{installing ? "Installing" : "Install"}
			</Button>
		</div>
	);
}

/**
 * The special "Auto" row (Plane B): selecting it points the composer at the
 * sentinel `auto` agent, so Core resolves the best agent per-turn by the user's
 * rules. Visually distinct (a sparkle mark) and carries a small "Configure…"
 * affordance that opens the agent-auto rules editor.
 */
function AutoTargetRow({
	isActive,
	onSelect,
	onConfigure,
}: {
	isActive: boolean;
	onConfigure: () => void;
	onSelect: () => void;
}) {
	return (
		<div className="flex items-center gap-1">
			<DropdownMenuItem
				className={cn(
					"min-w-0 flex-1 flex-col items-start gap-0.5",
					isActive && "bg-foreground/10"
				)}
				onClick={onSelect}
			>
				<span className="flex w-full items-center gap-2">
					<span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
						<HugeiconsIcon icon={SparklesIcon} size={13} strokeWidth={2} />
					</span>
					<span className="flex-1 truncate font-medium">Auto</span>
					{isActive && (
						<HugeiconsIcon
							className="shrink-0 text-muted-foreground"
							icon={Tick02Icon}
							size={16}
							strokeWidth={2}
						/>
					)}
				</span>
				<span className="w-full truncate pl-7 text-left font-normal text-muted-foreground text-xs">
					Routes each turn to the best agent by your rules.
				</span>
			</DropdownMenuItem>
			<Button
				className="h-6 shrink-0 px-2 text-xs"
				onClick={(e) => {
					e.stopPropagation();
					onConfigure();
				}}
				size="sm"
				type="button"
				variant="ghost"
			>
				Configure
			</Button>
		</div>
	);
}

/** Case-insensitive substring match over a target's searchable text. */
function matches(
	query: string,
	...fields: (string | null | undefined)[]
): boolean {
	if (!query) {
		return true;
	}
	return fields.some((f) => (f ?? "").toLowerCase().includes(query));
}

export function UniversalPickerBody({
	data,
	close,
}: {
	close: () => void;
	data: UniversalPickerData;
}) {
	const [query, setQuery] = useState("");
	const q = query.trim().toLowerCase();
	const {
		agents,
		activeModelSection,
		activeExtraSections,
		availableExternal,
		installedExternal,
		installPendingId,
		onConfigureAuto,
		onConfigureCredentials,
		onCreateAgent,
		onInstallExternal,
		onSelectAgent,
		onSelectProviderModel,
		onSelectProviderThinking,
		onSelectTeam,
		onUpgrade,
		onUseProvider,
		providers,
		ryuAgent,
		ryuActive,
		teams,
		thinkingLevels,
	} = data;

	// Total rows across all sections — the search box only earns its space once the
	// list is long enough to need filtering.
	const totalRows =
		(ryuAgent ? 1 : 0) +
		providers.length +
		installedExternal.length +
		availableExternal.length +
		teams.length;
	const showSearch = totalRows >= SEARCH_THRESHOLD;

	const filteredProviders = providers.filter((p) => matches(q, p.label, p.id));
	const filteredInstalled = installedExternal.filter((a) =>
		matches(q, a.name, a.id, a.description)
	);
	const filteredAvailable = availableExternal.filter((a) =>
		matches(q, a.name, a.id, a.description)
	);
	const filteredTeams = teams.filter((t) => matches(q, t.name, t.id));
	const ryuVisible = ryuAgent
		? matches(q, ryuAgent.name, "ryu portal ryu")
		: false;
	// The "Auto" row is always offered (empty query) and stays findable by search.
	const autoVisible = matches(q, "auto routes best agent by your rules");
	const autoActive = data.activeAgentId === AUTO_AGENT_ID;

	// The active agent's LIVE model/approval/thinking sections (wired to the host's
	// live handlers). Rendered under whichever row is the active target — Ryu Portal
	// or the active external agent — so tuning the current target updates the running
	// turn directly, instead of a second `useComposerAcpSections` instance whose picks
	// wouldn't reach the host until a remount.
	const activeSections: ComposerSettingsSection[] = [
		...(activeModelSection ? [activeModelSection] : []),
		...activeExtraSections,
	];

	const nothingMatches =
		!(autoVisible || ryuVisible) &&
		filteredProviders.length === 0 &&
		filteredInstalled.length === 0 &&
		filteredAvailable.length === 0 &&
		filteredTeams.length === 0;

	return (
		<div className="flex flex-col">
			{showSearch && (
				<div className="bg-popover px-2 pt-2 pb-1">
					<Input
						aria-label="Search agents, providers and models"
						className="h-8 border-0 bg-transparent px-1 text-[13px] shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => e.stopPropagation()}
						placeholder="Search agents, providers…"
						spellCheck={false}
						value={query}
					/>
				</div>
			)}

			<div className="min-h-0 flex-1 p-1">
				{nothingMatches && (
					<p className="px-3 py-4 text-center text-muted-foreground text-xs">
						No matches for &ldquo;{query.trim()}&rdquo;
					</p>
				)}

				{/* 0. Auto (Plane B — Core picks the agent per-turn) */}
				{autoVisible && (
					<AutoTargetRow
						isActive={autoActive}
						onConfigure={() => {
							onConfigureAuto();
							close();
						}}
						onSelect={() => {
							onSelectAgent(AUTO_AGENT_ID);
							close();
						}}
					/>
				)}

				{/* 1. Ryu Portal */}
				{ryuAgent && ryuVisible && (
					<>
						<SectionHeader label="Ryu Portal" />
						<TargetSub
							avatarUrl={ryuAgent.avatarUrl}
							engineKey="ryu"
							isActive={ryuActive}
							label={ryuAgent.name}
						>
							<UseTargetItem
								isActive={ryuActive}
								label={`Use ${ryuAgent.name}`}
								onSelect={() => {
									onSelectAgent(ryuAgent.id);
									close();
								}}
							/>
							{ryuActive &&
								activeSections.map((section) => (
									<SettingSub
										close={close}
										key={section.key}
										section={section}
									/>
								))}
						</TargetSub>
					</>
				)}

				{/* 2. Providers */}
				{filteredProviders.length > 0 && (
					<>
						<SectionHeader label="Providers" />
						{filteredProviders.map((provider) => (
							<TargetSub
								engineKey={provider.engineKey}
								isActive={provider.isActive}
								key={provider.id}
								label={provider.label}
							>
								<ProviderSubBody
									close={close}
									onConfigure={onConfigureCredentials}
									onModel={(modelId) =>
										onSelectProviderModel(provider.id, modelId)
									}
									onThinking={(level) =>
										onSelectProviderThinking(provider.id, level)
									}
									onUpgrade={onUpgrade}
									onUse={() => onUseProvider(provider.id)}
									provider={provider}
									thinkingLevels={thinkingLevels}
								/>
							</TargetSub>
						))}
					</>
				)}

				{/* 3. External agents */}
				{(filteredInstalled.length > 0 || filteredAvailable.length > 0) && (
					<>
						<SectionHeader
							label="External Agents"
							tooltip="Third-party coding agents (Claude Code, Codex, Gemini CLI, …) that run as their own process. Ryu governs their tool calls; pick one to use its own models and approval modes."
						/>
						{filteredInstalled.map((agent) => {
							const isActive = agent.id === data.activeAgentId;
							return (
								<TargetSub
									avatarUrl={agent.avatarUrl}
									engineKey={agent.engine ?? agent.id}
									isActive={isActive}
									key={agent.id}
									label={agent.name}
								>
									{isActive ? (
										<>
											<UseTargetItem
												isActive
												label={`Use ${agent.name}`}
												onSelect={close}
											/>
											{activeSections.map((section) => (
												<SettingSub
													close={close}
													key={section.key}
													section={section}
												/>
											))}
										</>
									) : (
										<ExternalAgentSettings
											agent={agent}
											agents={agents}
											close={close}
											isActive={false}
											onSelect={() => onSelectAgent(agent.id)}
										/>
									)}
								</TargetSub>
							);
						})}
						{filteredAvailable.map((entry) => (
							<AvailableAgentRow
								entry={entry}
								installing={installPendingId === entry.id}
								key={entry.id}
								onInstall={() => onInstallExternal(entry.id)}
							/>
						))}
					</>
				)}

				{/* Teams (preserved from the legacy picker when present) */}
				{filteredTeams.length > 0 && onSelectTeam && (
					<>
						<SectionHeader label="Teams" />
						{filteredTeams.map((team) => (
							<DropdownMenuItem
								className={cn("gap-2", team.isActive && "bg-foreground/10")}
								key={team.id}
								onClick={() => {
									onSelectTeam(team.id);
									close();
								}}
							>
								<AgentLogo
									className="size-4 shrink-0"
									engine={team.engines[0] ?? null}
									size="16px"
								/>
								<span className="flex-1 truncate">{team.name}</span>
								{team.isActive && (
									<HugeiconsIcon
										className="shrink-0 text-muted-foreground"
										icon={Tick02Icon}
										size={16}
										strokeWidth={2}
									/>
								)}
							</DropdownMenuItem>
						))}
					</>
				)}

				{/* New agent… */}
				{onCreateAgent && !q && (
					<>
						<div className="my-1 border-border/60 border-t" />
						<DropdownMenuItem
							className="gap-2"
							onClick={() => {
								onCreateAgent();
								close();
							}}
						>
							<HugeiconsIcon
								className="shrink-0 text-muted-foreground"
								icon={Download04Icon}
								size={16}
								strokeWidth={2}
							/>
							<span className="flex-1 truncate">New agent…</span>
						</DropdownMenuItem>
					</>
				)}
			</div>
		</div>
	);
}
