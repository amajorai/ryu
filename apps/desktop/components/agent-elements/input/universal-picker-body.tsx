"use client";

// The universal picker's dropdown BODY. Fed to `ComposerSettingsMenu` via its
// `renderBody` prop, so the trigger summary (`Ryu · Sonnet · Plan`) is unchanged;
// only the popover body is owned here.
//
// Compact root (no search query) — one row per TARGET, everything else nested:
//   1. Ryu          — the flagship `ryu` agent, ONE row. Its submenu holds
//                      "Use Ryu", the live model + thinking pickers when it's the
//                      active target, and the full Providers list (every Pi
//                      provider the Ryu agent can route to — they are routes OF
//                      the Ryu agent, not sibling targets). A configured provider
//                      drills into its models + thinking; an unconfigured one
//                      offers a single "Configure credentials" row.
//   2. External agents — installed ACP harnesses (Claude Code, Codex, Gemini CLI,
//                      …) drill into their advertised model / thinking / approval,
//                      probed LAZILY on submenu-open (one subprocess, not a storm).
//   3. Add more agents — ONE row out to the Customize page when the catalog has
//                      anything left to install. It is a link, not a list: this
//                      picker chooses a TARGET for the next turn, and the
//                      not-yet-installed catalog it used to nest here duplicated
//                      a browsing surface the marketplace already owns.
//
// Typing in the search box flattens everything back out (providers and
// installable agents surface as top-level matches, the latter still with their
// inline Install button) so nesting never hides a target from search — and a
// user who knows the name of an agent they have not installed yet still finds
// it here without the round trip.
//
// The lazy probe is the load-bearing detail: `DropdownMenuSubContent` (Base UI,
// `keepMounted={false}`) unmounts a closed submenu's children, so
// `ExternalAgentSettings` only calls `useComposerAcpSections` (which spawns the
// agent subprocess on first fetch) when its submenu is actually opened.

import {
	Add01Icon,
	Cancel01Icon,
	CheckmarkCircle02Icon,
	Download04Icon,
	HelpCircleIcon,
	Loading03Icon,
	PlugSocketIcon,
	SparklesIcon,
	Store01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useFullAccessSelectionGuard } from "@ryu/blocks/composer/full-access-warning";
import { SvglIcon } from "@ryu/blocks/web/svgl-icon.tsx";
import { AgentTitleBadge } from "@ryu/ui/components/agent-title-badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { CommandItem } from "@ryu/ui/components/command.tsx";
import {
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { IconGitBranch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useContext, useMemo, useState } from "react";
import type {
	ComposerSettingItem,
	ComposerSettingsSection,
} from "@/components/agent-elements/input/composer-settings-menu.tsx";
import { EffortSliderRow } from "@/components/agent-elements/input/effort-slider-row.tsx";
import { groupModelItems } from "@/components/agent-elements/input/model-groups.ts";
import { createModelMenuRenderer } from "@/components/agent-elements/input/model-menu-content.tsx";
import { modelMenuItem } from "@/components/agent-elements/input/model-router.ts";
import {
	type ProviderAccount,
	ProviderAccountSection,
	type ProviderAccountTarget,
} from "@/components/agent-elements/input/provider-account-section.tsx";
import { useProviderCommandNavigation } from "@/components/agent-elements/input/provider-command-dialog.tsx";
import {
	ProviderCreditsBadge,
	UsageBar,
} from "@/components/agent-elements/input/usage-bar.tsx";
import { useComposerAcpSections } from "@/components/agent-elements/input/use-composer-acp-sections.ts";
import type { ModelOption } from "@/components/agent-elements/types.ts";
import { TabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { AgentCatalogLogo } from "@/src/lib/agent-catalog-logo.tsx";
import { AgentAvatar, AgentLogo } from "@/src/lib/agent-logos.tsx";
import type { AgentCatalogEntry, AgentSummary } from "@/src/lib/api/agents.ts";
import { fetchAgentAccounts } from "@/src/lib/api/agents.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { formatMicroUsd } from "@/src/lib/api/credits.ts";
import { discoverModels, isPiModelEnabled } from "@/src/lib/api/pi-config.ts";
import { supportsSubscriptionProviderUsage } from "@/src/lib/api/usage.ts";
import {
	expiryClass,
	formatCountdown,
	formatExpiryDate,
} from "@/src/lib/expiry.ts";
import {
	showsComposerTuning,
	showsModelPicker,
} from "@/src/lib/interface-level.ts";
import type { PickerRef } from "@/src/lib/picker-favorites.ts";
import { svglForProvider } from "@/src/lib/provider-brand.tsx";

/** A Pi provider row for the Providers section (built by `useUniversalPicker`). */
export interface ProviderEntry {
	/** Every account this provider holds in the sealed vault (labels only). Lets
	 * the submenu list, switch and remove sign-ins. */
	accounts?: ProviderAccount[];
	/** Pi auth kind: "subscription" (OAuth login) | "api-key" | "none". */
	authKind: string;
	/** Browser-provider capability status, when this is the extension's synthetic row. */
	browserCapabilities?: {
		actionSupport: boolean;
		chatSupport: boolean;
		visionSupport: boolean;
	};
	/** Whether a usable credential is stored (drives the models-vs-configure body). */
	configured: boolean;
	/** The provider's current model when it is the active target, else null. */
	currentModel: string | null;
	/** The provider's current thinking level when active, else null. */
	currentThinking: string | null;
	/**
	 * Enumerate this row's full model list under a DIFFERENT registry id. Set only
	 * for the default managed Ryu row, which carries no `models_url` of its own and
	 * borrows the public OpenRouter catalog it actually routes to.
	 *
	 * Absent means "discover under `id`, and only if `supportsDiscovery`". That
	 * default is load-bearing now that several managed rows exist: a pool-backed
	 * managed row (Ryu Fast / Ryu Frontier) that inherited OpenRouter's catalog
	 * would offer models its own supply cannot serve, and every one of those picks
	 * would fail at the gateway.
	 */
	discoveryProviderId?: string;
	/** Engine key for the brand logo (anthropic / openai / gemini / …). */
	engineKey: string;
	/** Whether API-key accounts for this provider can be installed in the Gateway. */
	gatewayAccountSupported?: boolean;
	id: string;
	/** True when this provider is the Ryu agent's active route. */
	isActive: boolean;
	label: string;
	/** True for the Ryu-managed provider (included with the plan, no key). Drives
	 * the upsell body when the user has no active subscription (`configured` false). */
	managed: boolean;
	/** Explicit model visibility overrides; absent ids remain enabled. */
	modelOverrides?: Record<string, boolean>;
	/** Selectable models (from the provider's suggested set; live-discovered ids
	 * are merged in on open for discovery-capable providers like OpenRouter). */
	models: ComposerSettingItem[];
	/**
	 * This row's remaining POOL-RESTRICTED granted credit, when it is a pool-backed
	 * Ryu row and the account holds a grant in that pool. Absent otherwise.
	 *
	 * Strictly the pool's OWN money — the wallet's shared subscription/top-up
	 * buckets are deliberately NOT folded in. Those are spendable once but would
	 * appear on every pool row, so a user holding $12 shared and a $50 Frontier
	 * grant would read three rows totalling $74 for $62 of actual credit. The
	 * shared balance has its own single home (the account menu / node selector);
	 * this row answers only "how much Frontier is left", which is the question a
	 * segregated pool exists to make answerable.
	 */
	poolGrant?: {
		/** When this pool's grant money lapses, ISO, or null if it does not. */
		expiresAt: string | null;
		remainingMicroUsd: number;
	};
	/** Browser runtime status shown beside the provider's current model. */
	status?: "ready" | "not-prepared" | "preparing" | "failed" | "unsupported";
	statusMessage?: string;
	/** Whether Core can dynamically enumerate this provider's full model list. */
	supportsDiscovery: boolean;
	/** The managed provider with no active paid plan → show the subscription upsell
	 * instead of the model list. The managed provider is always `configured` (it is
	 * wallet-gated server-side), so upsell is gated on the entitlement, not `configured`. */
	upsell: boolean;
	/**
	 * Overrides the upsell body's copy. Absent = the default managed row's wording,
	 * which names OpenRouter because that row IS the managed OpenRouter route.
	 *
	 * A pool-backed managed row must override both halves: its tier is not
	 * OpenRouter, and naming the supplier behind a pool breaks the rule that a user
	 * only ever reads the pool's own tier name.
	 */
	upsellCopy?: {
		/** Sub-label under "Use your own key", or null to drop that row — a pool's
		 *  supply is not something a user can hold a key for. */
		byoKey: string | null;
		/** Sub-label under "Upgrade to Ryu". */
		upgrade: string;
	};
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
	/** Whether the caller may set a provider account for the shared Gateway. */
	canSetGatewayAccount?: boolean;
	/**
	 * Plain selectable agents that are neither the flagship nor ACP externals
	 * (custom store agents, `transport` null). Rendered as flat pick rows — they
	 * advertise no model/thinking config to drill into. Defaults to none.
	 */
	customAgents?: AgentSummary[];
	/** Keep model rows visible for setup surfaces at every interface level. */
	forceModelPicker?: boolean;
	/**
	 * Suppress the "Auto" (Plane B) row. The composer always offers Auto so a turn
	 * can be routed per-rule; a controlled settings *field* (which persists one
	 * concrete model/agent id) has nowhere to store the sentinel, so it hides it.
	 * Defaults to false — the composer is unaffected.
	 */
	hideAuto?: boolean;
	/** Installed external ACP agents (transport `acp`, excluding the flagship). */
	installedExternal: AgentSummary[];
	/** Id of the external agent whose install is in flight, or null. */
	installPendingId: string | null;
	onConfigureCredentials: () => void;
	onCreateAgent?: () => void;
	onInstallExternal: (id: string) => void;
	/** Remove an ACP agent account. */
	onRemoveAgentAccount: (agentId: string, accountId: string) => void;
	/** Remove an account from a Pi provider. */
	onRemoveProviderAccount: (providerId: string, accountId: string) => void;
	onRemoveRecent?: (ref: PickerRef) => void;
	onSelectAgent: (id: string) => void;
	onSelectProviderModel: (providerId: string, modelId: string) => void;
	onSelectProviderThinking: (providerId: string, level: string) => void;
	onSelectRecentModel?: (
		providerId: string,
		modelId: string,
		effort?: string
	) => void;
	onSelectTeam?: (id: string) => void;
	/** Switch an ACP agent's active account (`provider` required for the managed
	 *  Pi's accounts, which live in a provider scope). */
	onSwitchAgentAccount: (
		agentId: string,
		accountId: string,
		provider?: string
	) => void;
	/** Switch the active account for a Pi provider (sealed vault + materialize). */
	onSwitchProviderAccount: (
		providerId: string,
		accountId: string,
		target?: ProviderAccountTarget
	) => void;
	/** Open the subscription upgrade / paywall (managed-provider upsell). */
	onUpgrade: () => void;
	onUseProvider: (providerId: string) => void;
	providers: ProviderEntry[];
	recentRefs?: readonly PickerRef[];
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
		<div className="sticky top-0 z-10 flex items-center gap-1 border-border/40 border-b bg-popover/95 px-3 pt-2 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide backdrop-blur supports-backdrop-filter:bg-popover/80">
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
			closeOnClick={false}
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
 *
 * A `variant: "slider"` section (reasoning effort) is the exception: an ordered
 * scale reads better as one stepped track than as a submenu of rows, so it is
 * rendered inline instead of behind a sub-trigger.
 */
function SettingSub({ section }: { section: ComposerSettingsSection }) {
	const commandNavigation = useProviderCommandNavigation();
	const selectionGuard = useFullAccessSelectionGuard();
	const loadingEmpty = Boolean(section.loading) && section.items.length === 0;
	if (section.items.length === 0 && !section.renderContent && !loadingEmpty) {
		return null;
	}
	const active =
		section.items.find((it) => it.id === section.value) ?? section.items[0];
	const activeDeco = active ? section.decorate?.(active) : undefined;
	// Keep the root menu open so model → thinking → approval can be chained.
	const onSelect = (id: string) => {
		const item = section.items.find((candidate) => candidate.id === id);
		const apply = () => section.onChange(id);
		if (selectionGuard) {
			selectionGuard.request(item ?? { id, name: id }, apply, section.label);
			return;
		}
		// ProviderCommandDialog can be rendered beside ComposerSettingsMenu, so it
		// has no FullAccessSelectionProvider ancestor. A missing optional guard is
		// not a reason to drop an otherwise safe model/thinking selection.
		apply();
	};
	if (section.variant === "slider" && !loadingEmpty) {
		if (commandNavigation) {
			return (
				<CommandItem
					data-checked={section.value === section.items[0]?.id}
					onSelect={() =>
						commandNavigation.push({
							body: section.items.map((item) => (
								<CommandItem
									data-checked={item.id === section.value}
									key={item.id}
									onSelect={() => {
										onSelect(item.id);
										commandNavigation.close();
									}}
								>
									{item.name}
								</CommandItem>
							)),
							title: section.label,
						})
					}
				>
					{section.label}
				</CommandItem>
			);
		}
		return <EffortSliderRow onSelect={onSelect} section={section} />;
	}
	if (commandNavigation) {
		return (
			<CommandItem
				data-checked={active?.id === section.value}
				onSelect={() =>
					commandNavigation.push({
						body: section.items.map((item) => (
							<CommandItem
								data-checked={
									item.id === (section.value ?? section.items[0]?.id)
								}
								key={item.id}
								onSelect={() => {
									onSelect(item.id);
									commandNavigation.close();
								}}
							>
								{item.name}
							</CommandItem>
						)),
						title: section.label,
					})
				}
			>
				<span className="flex-1">{section.label}</span>
				<span className="text-muted-foreground text-xs">{active?.name}</span>
			</CommandItem>
		);
	}
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
			{/* `renderContent` bodies (the grouped model menu) own their own scroller,
			    so the popover must NOT add a second one — nested scrollers are what
			    made the model list feel stuck. A plain item list has no scroller of
			    its own, so it scrolls HERE or not at all: with `overflow-hidden` on
				    both paths, any plain section with many two-line rows was simply clipped
				    and unreachable. */}
			<DropdownMenuSubContent
				className={cn(
					"max-h-80 min-w-[220px] max-w-[300px] p-0",
					section.renderContent ? "overflow-hidden" : "overflow-y-auto"
				)}
			>
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
	const commandNavigation = useProviderCommandNavigation();
	if (commandNavigation) {
		return (
			<CommandItem
				data-checked={isActive}
				onSelect={() => {
					onSelect();
					commandNavigation.close();
				}}
			>
				<span className="flex-1 truncate">{label}</span>
			</CommandItem>
		);
	}
	return (
		<DropdownMenuItem className="gap-2" closeOnClick={false} onClick={onSelect}>
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
	forceModelPicker = false,
	isActive,
	onSelect,
	onRemoveAccount,
	onSwitchAccount,
}: {
	agent: AgentSummary;
	agents: AgentSummary[];
	forceModelPicker?: boolean;
	isActive: boolean;
	onRemoveAccount: (accountId: string) => void;
	onSelect: () => void;
	onSwitchAccount: (account: ProviderAccount) => void;
}) {
	const noModelOptions = useMemo<ModelOption[]>(() => [], []);
	// Interface level decides whether this agent's row offers anything BUT "Use
	// it" — the same gate the host applies to the active agent's sections, applied
	// again here because this body builds its own (see the hook's header). Without
	// it, Ryu Work would strip the model from the trigger summary and still list one
	// under every agent in the popover.
	//
	// It also feeds `agentId: null` when nothing would render, which skips the
	// probe entirely: `useComposerAcpSections` spawns the agent subprocess on
	// first fetch, and a level that shows none of the answers should not be asking
	// the question.
	const interfaceLevel = useInterfaceLevel();
	const showModelSection = forceModelPicker || showsModelPicker(interfaceLevel);
	const showTuningSections = showsComposerTuning(interfaceLevel);
	const { modelSection, extraSections } = useComposerAcpSections({
		agentId: showModelSection || showTuningSections ? agent.id : null,
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
	// The agent's sign-in accounts (sealed vault, labels only). Fetched lazily —
	// this component only mounts when its submenu opens. For the managed Pi agent
	// these are its provider accounts; for any other agent its opaque sign-ins.
	const node = useActiveNode();
	const accountsQuery = useQuery({
		queryKey: ["agent-accounts", node.url, agent.id],
		queryFn: () => fetchAgentAccounts(toTarget(node), agent.id),
		staleTime: 30_000,
	});
	const accounts: ProviderAccount[] = accountsQuery.data ?? [];
	return (
		<>
			<UseTargetItem
				isActive={isActive}
				label={`Use ${agent.name}`}
				onSelect={() => {
					onSelect();
				}}
			/>
			<ProviderAccountSection
				accounts={accounts}
				canSetGateway={false}
				gatewaySupported={false}
				onRemove={onRemoveAccount}
				onSwitch={(account) => onSwitchAccount(account)}
			/>
			{showModelSection && <SettingSub section={modelAsSection} />}
			{showTuningSections &&
				extraSections.map((section) => (
					<SettingSub
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
	onSwitchAccount,
	onRemoveAccount,
	canSetGateway,
	close,
	forceModelPicker = false,
}: {
	canSetGateway: boolean;
	close: () => void;
	forceModelPicker?: boolean;
	onConfigure: () => void;
	onModel: (modelId: string) => void;
	onRemoveAccount: (accountId: string) => void;
	onSwitchAccount: (
		account: ProviderAccount,
		target: ProviderAccountTarget
	) => void;
	onThinking: (level: string) => void;
	onUpgrade: () => void;
	onUse: () => void;
	provider: ProviderEntry;
	thinkingLevels: string[];
}) {
	const node = useActiveNode();
	const interfaceLevel = useInterfaceLevel();
	const showModelSection = forceModelPicker || showsModelPicker(interfaceLevel);
	const showTuningSections = showsComposerTuning(interfaceLevel);
	const [customBrowserModelId, setCustomBrowserModelId] = useState("");
	// Live-enumerate the provider's full model list once the submenu opens (this
	// component only mounts on open). OpenRouter exposes hundreds of models Core's
	// static `suggestedModels` can't carry, so a discovery-capable provider gets the
	// real list; others fall back to the suggestions. A row that borrows another
	// registry id's catalog says so explicitly via `discoveryProviderId` — see the
	// note on that field for why "managed" alone must never imply OpenRouter.
	const discoveryId = provider.discoveryProviderId ?? provider.id;
	const discoverable =
		!provider.upsell &&
		provider.configured &&
		(provider.supportsDiscovery ||
			provider.discoveryProviderId !== undefined ||
			// A login (subscription) provider — ChatGPT Plus/Pro, Claude Pro/Max,
			// GitHub Copilot — advertises no OpenAI-style `/models` endpoint, so Core
			// reports `supportsDiscovery: false` and ships an EMPTY `suggestedModels`.
			// Gating on that alone left every signed-in subscription row with a model
			// submenu containing nothing at all, even though Core's discovery falls
			// through to models.dev for exactly these ids (Settings → Providers has
			// always shown the real list because it asks unconditionally).
			provider.authKind === "subscription");
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
			if (!id || seen.has(id)) {
				return;
			}
			// A model the user turned off is hidden — EXCEPT the one this row is
			// currently set to, which stays visible so the picker never renders a
			// selection it can't show. Turning it back on is a Settings action.
			if (
				id !== provider.currentModel &&
				!isPiModelEnabled(provider.modelOverrides, id)
			) {
				return;
			}
			seen.add(id);
			out.push(modelMenuItem(id, name));
		};
		for (const m of discovery.data?.models ?? []) {
			push(m.id, m.name);
		}
		for (const it of provider.models) {
			push(it.id, it.name);
		}
		return out;
	}, [
		discovery.data,
		provider.currentModel,
		provider.modelOverrides,
		provider.models,
	]);

	if (provider.upsell) {
		const upgradeCopy =
			provider.upsellCopy?.upgrade ??
			"Every model through Ryu's managed OpenRouter — no API keys, one subscription.";
		const byoKeyCopy =
			provider.upsellCopy === undefined
				? "Already have an OpenRouter key? Add it instead."
				: provider.upsellCopy.byoKey;
		return (
			<>
				<ActionRow
					description={upgradeCopy}
					icon={SparklesIcon}
					label="Upgrade to Ryu"
					onClick={() => {
						onUpgrade();
						close();
					}}
				/>
				{byoKeyCopy === null ? null : (
					<ActionRow
						description={byoKeyCopy}
						icon={PlugSocketIcon}
						label="Use your own key"
						onClick={() => {
							onConfigure();
							close();
						}}
					/>
				)}
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
					provider.currentModel ?? undefined,
					undefined,
					discoveryId === "openrouter" ? "openrouter" : undefined
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
		// Pi's levels are an ordered effort scale, so the same stepped slider the
		// ACP reasoning option gets. The detents follow `thinkingLevels`, whatever
		// length the catalog reports.
		variant: "slider",
	};
	return (
		<>
			<UseTargetItem
				isActive={provider.isActive}
				label={`Use ${provider.label}`}
				onSelect={onUse}
			/>
			{/* Every sign-in this provider holds, switchable/removable. Multi-account
			    is the point of the sealed vault; the section renders only when there
			    are accounts to show. */}
			<ProviderAccountSection
				accounts={provider.accounts ?? []}
				canSetGateway={canSetGateway}
				gatewaySupported={provider.gatewayAccountSupported === true}
				onRemove={onRemoveAccount}
				onSwitch={onSwitchAccount}
			/>
			{/* Same interface-mode gate as the external-agent body above: Ryu Work
			    offers the provider itself and nothing to tune inside it. */}
			{showModelSection && <SettingSub section={modelSection} />}
			{provider.id === "browser" && (
				<div className="space-y-2 px-3 py-2">
					<p className="text-muted-foreground text-xs">
						Use any compatible Hugging Face model id. Unverified custom models
						are chat-only.
					</p>
					<div className="flex items-center gap-2">
						<Input
							aria-label="Custom Hugging Face model id"
							onChange={(event) => setCustomBrowserModelId(event.target.value)}
							placeholder="org/model"
							value={customBrowserModelId}
						/>
						<Button
							onClick={() => {
								const modelId = customBrowserModelId.trim();
								if (
									/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(
										modelId
									)
								) {
									onModel(modelId);
									setCustomBrowserModelId("");
								}
							}}
							size="sm"
						>
							Add
						</Button>
					</div>
				</div>
			)}
			{showTuningSections && thinkingLevels.length > 0 && (
				<SettingSub section={thinkingSection} />
			)}
		</>
	);
}

/** A top-level target row that opens a submenu (its settings body). */
function TargetSub({
	label,
	engineKey,
	providerId,
	avatarUrl,
	glyph,
	isActive,
	title,
	trailing,
	children,
}: {
	avatarUrl?: string | null;
	children: ReactNode;
	engineKey: string | null;
	glyph?: GlyphValue;
	/** Pi provider id — routes the row through the svgl brand mark when set. */
	providerId?: string;
	isActive: boolean;
	label: string;
	title?: string;
	/**
	 * A small right-aligned status for this row, before the active checkmark: an
	 * agent's subscription usage, or a Ryu pool's remaining granted credit. This is
	 * the one seam both live on, because provider rows and agent rows are the same
	 * component — anything that renders per-target belongs here rather than in two
	 * near-identical copies.
	 */
	trailing?: ReactNode;
}) {
	const commandNavigation = useProviderCommandNavigation();
	// Provider rows carry a Pi id (groq, cerebras, nvidia, …) whose bundled brand
	// mark lives in `/logos/`. Agents (no providerId) keep the engine logo.
	const providerSpec = providerId ? svglForProvider(providerId) : null;
	if (commandNavigation) {
		return (
			<CommandItem
				data-checked={isActive}
				onSelect={() =>
					commandNavigation.push({ body: children, title: label })
				}
			>
				<span className="flex min-w-0 flex-1 items-center gap-2">
					<span className="truncate">{label}</span>
					<AgentTitleBadge title={title ?? ""} />
				</span>
				{trailing}
			</CommandItem>
		);
	}

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger className={cn(isActive && "bg-foreground/10")}>
				<span className="flex min-w-0 flex-1 items-center gap-2">
					{glyph ? (
						<AgentAvatar
							className="size-4 shrink-0 rounded-full object-contain"
							engine={engineKey}
							glyph={glyph}
							size="16px"
						/>
					) : avatarUrl ? (
						// biome-ignore lint/performance/noImgElement: Tauri/Vite, data URL avatar
						// biome-ignore lint/correctness/useImageSize: sized via class
						<img
							alt=""
							className="size-4 shrink-0 rounded-full object-cover"
							src={avatarUrl}
						/>
					) : providerSpec ? (
						<SvglIcon
							className="size-4 shrink-0"
							size={16}
							spec={providerSpec}
						/>
					) : (
						<AgentLogo
							className="size-4 shrink-0"
							engine={engineKey}
							size="16px"
						/>
					)}
					<span className="truncate">{label}</span>
					<AgentTitleBadge title={title ?? ""} />
				</span>
				{trailing}
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

/**
 * A Ryu pool row's remaining granted credit, in dollars, on the picker row.
 *
 * The number is the pool's own segregated grant balance and nothing else (see
 * `ProviderEntry.poolGrant`). Campaign grants lapse, so when this money has a
 * date the badge wears the shared expiry urgency hue and the tooltip says when —
 * the same convention the composer's banked-reset timeline uses, from the same
 * helpers, so two "expires in" readings on one screen can't disagree.
 */
function PoolGrantBadge({
	grant,
	label,
}: {
	grant: NonNullable<ProviderEntry["poolGrant"]>;
	label: string;
}) {
	const amount = formatMicroUsd(grant.remainingMicroUsd);
	const expiry = grant.expiresAt;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={`${label}: ${amount} of granted credit left`}
						className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-muted-foreground/70 tabular-nums"
					/>
				}
			>
				{expiry ? (
					<span
						aria-hidden="true"
						className={cn("size-1.5 rounded-full", expiryClass(expiry))}
					/>
				) : null}
				{amount}
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					<span className="font-medium">
						{amount} of {label} credit left
					</span>
					{expiry ? (
						<span className="text-muted-foreground">
							Expires {formatExpiryDate(expiry)} · {formatCountdown(expiry)}
						</span>
					) : null}
					<span className="text-muted-foreground">
						Only spendable on {label}.
					</span>
				</div>
			</TooltipContent>
		</Tooltip>
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
			<AgentCatalogLogo
				className="size-4 shrink-0 opacity-50"
				entry={entry}
				size="16px"
			/>
			<span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
				{entry.name}
			</span>
			<Button
				className="h-6 shrink-0 gap-1 px-2 text-xs"
				disabled={!entry.available}
				loading={installing}
				onClick={(e) => {
					e.stopPropagation();
					onInstall();
				}}
				size="sm"
				type="button"
				variant="ghost"
			>
				<HugeiconsIcon icon={Download04Icon} size={12} strokeWidth={2} />
				{installing ? "Installing" : "Install"}
			</Button>
		</div>
	);
}

/**
 * The special "Auto" row (Plane B): selecting it points the composer at the
 * sentinel `auto` agent, so Core resolves the best agent per-turn by the user's
 * rules. It uses the same unadorned branch mark as the message action; the
 * configuration action lives in the picker footer beside model management.
 */
function AutoTargetRow({
	isActive,
	onSelect,
}: {
	isActive: boolean;
	onSelect: () => void;
}) {
	return (
		<DropdownMenuItem
			className={cn(
				"min-w-0 flex-col items-start gap-0.5",
				isActive && "bg-foreground/10"
			)}
			closeOnClick={false}
			onClick={onSelect}
		>
			<span className="flex w-full items-center gap-2">
				<IconGitBranch className="size-4 shrink-0 text-purple-500" />
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
			<span className="w-full truncate pl-6 text-left font-normal text-muted-foreground text-xs">
				Routes each turn to the best agent by your rules.
			</span>
		</DropdownMenuItem>
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

interface RecentPickerModel {
	effort?: string;
	model: ComposerSettingItem;
	provider: ProviderEntry;
	ref: Extract<PickerRef, { kind: "model" }>;
}

function recentModels(
	refs: readonly PickerRef[] | undefined,
	providers: ProviderEntry[]
): RecentPickerModel[] {
	const byId = new Map(providers.map((provider) => [provider.id, provider]));
	const rows: RecentPickerModel[] = [];
	for (const ref of refs ?? []) {
		if (ref.kind !== "model") {
			continue;
		}
		const provider = byId.get(ref.providerId);
		const model = provider?.models.find((item) => item.id === ref.modelId);
		if (!(provider && model)) {
			continue;
		}
		rows.push({ effort: ref.effort, model, provider, ref });
	}
	return rows;
}

function recentAgents(
	refs: readonly PickerRef[] | undefined,
	agents: AgentSummary[],
	ryuAgent: AgentSummary | null
): Array<{ agent: AgentSummary; ref: Extract<PickerRef, { kind: "agent" }> }> {
	const byId = new Map(
		[...(ryuAgent ? [ryuAgent] : []), ...agents].map((agent) => [
			agent.id,
			agent,
		])
	);
	const rows: Array<{
		agent: AgentSummary;
		ref: Extract<PickerRef, { kind: "agent" }>;
	}> = [];
	for (const ref of refs ?? []) {
		if (ref.kind !== "agent") {
			continue;
		}
		const agent = byId.get(ref.agentId);
		if (agent) {
			rows.push({ agent, ref });
		}
	}
	return rows;
}

function RecentEffortMeter({ effort }: { effort?: string }) {
	if (!effort) {
		return null;
	}
	const levels = ["off", "low", "medium", "high", "max"];
	const activeIndex = Math.max(0, levels.indexOf(effort.toLowerCase()));
	const label = effort.charAt(0).toUpperCase() + effort.slice(1);
	return (
		<span
			aria-label={`Effort: ${label}`}
			className="composer-effort-meter inline-flex h-4 shrink-0 items-end gap-px text-primary"
			data-composer-effort-meter="true"
			role="img"
			title={`Effort: ${label}`}
		>
			{levels.map((level, index) => (
				<span
					aria-hidden="true"
					className={cn(
						"w-1 rounded-[1px]",
						index <= activeIndex ? "bg-current" : "bg-muted-foreground/25"
					)}
					key={level}
					style={{ height: `${5 + index * 2}px` }}
				/>
			))}
		</span>
	);
}

function RecentModelRow({
	effort,
	model,
	modelRef,
	onRemove,
	onSelect,
	provider,
	testId,
}: Omit<RecentPickerModel, "ref"> & {
	modelRef: RecentPickerModel["ref"];
	onRemove?: (ref: PickerRef) => void;
	onSelect: (ref: PickerRef) => void;
	testId?: string;
}) {
	const commandNavigation = useProviderCommandNavigation();
	const content = (
		<>
			<AgentLogo
				className="size-4 shrink-0"
				engine={provider.engineKey}
				size="16px"
			/>
			<span className="min-w-0 flex-1">
				<span className="flex min-w-0 items-center gap-2">
					<span className="min-w-0 flex-1 truncate">{model.name}</span>
					<RecentEffortMeter effort={effort} />
				</span>
				<span className="block truncate text-muted-foreground text-xs">
					{provider.label}
				</span>
			</span>
			{onRemove ? (
				<Button
					aria-label={`Remove ${model.name} from recent`}
					className="size-6 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/recent:opacity-100"
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onRemove(modelRef);
					}}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon aria-hidden="true" icon={Cancel01Icon} />
				</Button>
			) : null}
		</>
	);
	if (commandNavigation) {
		return (
			<CommandItem
				className="group/recent min-w-0 gap-2"
				data-testid={testId ?? "recent-model-row"}
				onSelect={() => onSelect(modelRef)}
				value={`recent ${model.name} ${provider.label}`}
			>
				{content}
			</CommandItem>
		);
	}
	return (
		<DropdownMenuItem
			className="group/recent min-w-0 gap-2"
			closeOnClick={false}
			data-testid={testId ?? "recent-model-row"}
			onClick={() => onSelect(modelRef)}
		>
			{content}
		</DropdownMenuItem>
	);
}

function RecentAgentRow({
	agent,
	agentRef,
	onRemove,
	onSelect,
	testId,
}: {
	agent: AgentSummary;
	agentRef: Extract<PickerRef, { kind: "agent" }>;
	onRemove?: (ref: PickerRef) => void;
	onSelect: (ref: PickerRef) => void;
	testId?: string;
}) {
	const commandNavigation = useProviderCommandNavigation();
	const content = (
		<>
			<AgentAvatar
				className="size-4 shrink-0 rounded-full object-contain"
				engine={agent.engine ?? agent.id}
				glyph={agent.avatarGlyph}
				size="16px"
			/>
			<span className="min-w-0 flex-1 truncate">{agent.name}</span>
			{onRemove ? (
				<Button
					aria-label={`Remove ${agent.name} from recent`}
					className="size-6 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/recent:opacity-100"
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onRemove(agentRef);
					}}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon aria-hidden="true" icon={Cancel01Icon} />
				</Button>
			) : null}
		</>
	);
	if (commandNavigation) {
		return (
			<CommandItem
				className="group/recent min-w-0 gap-2"
				data-testid={testId ?? "recent-agent-row"}
				onSelect={() => onSelect(agentRef)}
				value={`recent ${agent.name}`}
			>
				{content}
			</CommandItem>
		);
	}
	return (
		<DropdownMenuItem
			className="group/recent min-w-0 gap-2"
			closeOnClick={false}
			data-testid={testId ?? "recent-agent-row"}
			onClick={() => onSelect(agentRef)}
		>
			{content}
		</DropdownMenuItem>
	);
}

export function UniversalPickerBody({
	data,
	close,
	mode = "all",
}: {
	close: () => void;
	data: UniversalPickerData;
	mode?: "agents" | "models" | "all";
}) {
	const [query, setQuery] = useState("");
	const q = query.trim().toLowerCase();
	// Read the tabs context RAW rather than through `useTabsContext`, which throws
	// outside a provider. This body is also mounted by settings-shaped fields
	// (`AgentSelectionField`, `AgentModelPickerField`) that a future surface could
	// render outside the workspace shell; a null context just hides the
	// marketplace row instead of taking the whole picker down with it.
	const tabsCtx = useContext(TabsContext);
	const openAgentsCatalog = tabsCtx
		? () => tabsCtx.openTab("/store/agents", { title: "Customize" })
		: null;
	const {
		agents,
		activeModelSection,
		activeExtraSections,
		availableExternal,
		customAgents = [],
		installedExternal,
		installPendingId,
		onConfigureCredentials,
		onCreateAgent,
		onInstallExternal,
		onRemoveRecent,
		onSelectAgent,
		onSelectProviderModel,
		onSelectProviderThinking,
		onSelectRecentModel,
		onSelectTeam,
		onSwitchProviderAccount,
		onRemoveProviderAccount,
		onSwitchAgentAccount,
		onRemoveAgentAccount,
		onUpgrade,
		onUseProvider,
		providers,
		recentRefs,
		ryuAgent,
		ryuActive,
		teams,
		thinkingLevels,
	} = data;
	const showAgents = mode !== "models";
	const showProviders = mode !== "agents";

	// Total rows across all sections — the search box only earns its space once the
	// list is long enough to need filtering. Counts the FLATTENED search space
	// (providers, installable agents), not the compact root.
	const totalRows =
		(ryuAgent ? 1 : 0) +
		providers.length +
		installedExternal.length +
		customAgents.length +
		availableExternal.length +
		teams.length;
	const showSearch = totalRows >= SEARCH_THRESHOLD;

	const filteredProviders = providers.filter((p) => matches(q, p.label, p.id));
	const filteredInstalled = installedExternal.filter((a) =>
		matches(q, a.name, a.id, a.description)
	);
	const filteredCustom = customAgents.filter((a) =>
		matches(q, a.name, a.id, a.description)
	);
	const filteredAvailable = availableExternal.filter((a) =>
		matches(q, a.name, a.id, a.description)
	);
	const filteredTeams = teams.filter((t) => matches(q, t.name, t.id));
	const recentModelRows = recentModels(recentRefs, providers);
	const recentAgentRows = recentAgents(recentRefs, agents, ryuAgent);
	const ryuVisible = ryuAgent ? matches(q, ryuAgent.name, "ryu") : false;
	// The "Auto" row is always offered (empty query) and stays findable by search —
	// unless a settings field suppresses it (`hideAuto`).
	const autoVisible =
		!data.hideAuto && matches(q, "auto routes best agent by your rules");
	const autoActive = data.activeAgentId === AUTO_AGENT_ID;

	// The Ryu agent is the active target whether it routes through the portal
	// (gateway/local) or through one of its providers — the root row reflects both.
	const ryuRowActive = ryuActive || providers.some((p) => p.isActive);

	// The active agent's LIVE model/approval/thinking sections (wired to the host's
	// live handlers). Rendered under whichever row is the active target — Ryu or
	// the active external agent — so tuning the current target updates the running
	// turn directly, instead of a second `useComposerAcpSections` instance whose picks
	// wouldn't reach the host until a remount.
	const activeSections: ComposerSettingsSection[] = [
		...(activeModelSection ? [activeModelSection] : []),
		...activeExtraSections,
	];

	const nothingMatches =
		showAgents &&
		!(autoVisible || ryuVisible) &&
		filteredInstalled.length === 0 &&
		filteredCustom.length === 0 &&
		filteredAvailable.length === 0 &&
		filteredTeams.length === 0 &&
		(!showProviders || filteredProviders.length === 0);

	const providerSub = (provider: ProviderEntry) => (
		<TargetSub
			engineKey={provider.engineKey}
			isActive={provider.isActive}
			key={provider.id}
			label={provider.label}
			providerId={provider.id}
			trailing={
				provider.id === "browser" ? (
					<span className="shrink-0 text-[11px] text-muted-foreground">
						{provider.status === "ready"
							? "Ready"
							: provider.status === "preparing"
								? "Preparing…"
								: provider.status === "failed"
									? "Retry"
									: "Browser"}
					</span>
				) : supportsSubscriptionProviderUsage(provider) ? (
					<UsageBar agentId={provider.id} className="shrink-0" />
				) : provider.poolGrant ? (
					// A pool row shows the pool's granted credit; a BYOK row shows what's
					// left on the key the user pasted. Never both — a pool has no key and
					// a BYOK provider has no pool, so this is a fork, not a stack.
					<PoolGrantBadge grant={provider.poolGrant} label={provider.label} />
				) : (
					<ProviderCreditsBadge
						label={provider.label}
						providerId={provider.id}
					/>
				)
			}
		>
			<ProviderSubBody
				canSetGateway={data.canSetGatewayAccount ?? true}
				close={close}
				forceModelPicker={data.forceModelPicker}
				onConfigure={onConfigureCredentials}
				onModel={(modelId) => onSelectProviderModel(provider.id, modelId)}
				onRemoveAccount={(accountId) =>
					onRemoveProviderAccount(provider.id, accountId)
				}
				onSwitchAccount={(account, target) =>
					onSwitchProviderAccount(provider.id, account.accountId, target)
				}
				onThinking={(level) => onSelectProviderThinking(provider.id, level)}
				onUpgrade={onUpgrade}
				onUse={() => onUseProvider(provider.id)}
				provider={provider}
				thinkingLevels={thinkingLevels}
			/>
		</TargetSub>
	);

	const externalSub = (agent: AgentSummary) => {
		const isActive = agent.id === data.activeAgentId;
		return (
			<TargetSub
				avatarUrl={agent.avatarUrl}
				engineKey={agent.engine ?? agent.id}
				glyph={agent.avatarGlyph}
				isActive={isActive}
				key={agent.id}
				label={agent.name}
				title={agent.title}
				// Installed subscription harnesses only. The not-installed catalog rows
				// (`AvailableAgentRow`) deliberately get none: their ids match the same
				// engine substrings, so a meter there would read a credential for a CLI
				// that isn't on this machine and answer "not logged in" every time.
				trailing={<UsageBar agentId={agent.id} className="shrink-0" />}
			>
				{isActive && activeSections.length > 0 ? (
					<>
						<UseTargetItem
							isActive
							label={`Use ${agent.name}`}
							onSelect={() => onSelectAgent(agent.id)}
						/>
						{activeSections.map((section) => (
							<SettingSub key={section.key} section={section} />
						))}
					</>
				) : (
					// No live sections from the host (settings-field mode, or a
					// non-active agent) — probe the agent's own advertised
					// model/thinking/approval lazily instead.
					<ExternalAgentSettings
						agent={agent}
						agents={agents}
						forceModelPicker={data.forceModelPicker}
						isActive={isActive}
						onRemoveAccount={(accountId) =>
							onRemoveAgentAccount(agent.id, accountId)
						}
						onSelect={() => onSelectAgent(agent.id)}
						onSwitchAccount={(account) =>
							onSwitchAgentAccount(
								agent.id,
								account.accountId,
								account.provider
							)
						}
					/>
				)}
			</TargetSub>
		);
	};

	const customAgentRow = (agent: AgentSummary) => {
		const isActive = agent.id === data.activeAgentId;
		return (
			<DropdownMenuItem
				className={cn("gap-2", isActive && "bg-foreground/10")}
				closeOnClick={false}
				key={agent.id}
				onClick={() => {
					onSelectAgent(agent.id);
				}}
			>
				{agent.avatarGlyph ? (
					<AgentAvatar
						className="size-4 shrink-0 rounded-full object-contain"
						engine={agent.engine ?? null}
						glyph={agent.avatarGlyph}
						size="16px"
					/>
				) : agent.avatarUrl ? (
					// biome-ignore lint/performance/noImgElement: Tauri/Vite, data URL avatar
					// biome-ignore lint/correctness/useImageSize: sized via class
					<img
						alt=""
						className="size-4 shrink-0 rounded-full object-cover"
						src={agent.avatarUrl}
					/>
				) : (
					<AgentLogo
						className="size-4 shrink-0"
						engine={agent.engine ?? null}
						size="16px"
					/>
				)}
				<span className="flex min-w-0 flex-1 items-center gap-2">
					<span className="truncate">{agent.name}</span>
					<AgentTitleBadge title={agent.title ?? ""} />
				</span>
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
	};

	const ryuSub = ryuAgent && (
		<TargetSub
			avatarUrl={ryuAgent.avatarUrl}
			engineKey="ryu"
			glyph={ryuAgent.avatarGlyph}
			isActive={ryuRowActive}
			label={ryuAgent.name}
			title={ryuAgent.title}
		>
			<UseTargetItem
				isActive={ryuActive}
				label={`Use ${ryuAgent.name}`}
				onSelect={() => {
					onSelectAgent(ryuAgent.id);
				}}
			/>
			{ryuActive &&
				activeSections.map((section) => (
					<SettingSub key={section.key} section={section} />
				))}
			{showProviders && providers.length > 0 && (
				<>
					<SectionHeader
						label="Providers"
						tooltip="Routes Ryu can send your turns through. Pick a provider to use its models with your own credentials or subscription."
					/>
					{providers.map(providerSub)}
				</>
			)}
		</TargetSub>
	);

	const selectRecent = (ref: PickerRef) => {
		if (ref.kind === "agent") {
			onSelectAgent(ref.agentId);
			return;
		}
		if (onSelectRecentModel) {
			onSelectRecentModel(ref.providerId, ref.modelId, ref.effort);
			return;
		}
		onSelectProviderModel(ref.providerId, ref.modelId);
		if (ref.effort) {
			onSelectProviderThinking(ref.providerId, ref.effort);
		}
	};

	const recentModelRowsForDisplay = recentModelRows.filter(({ model }) =>
		matches(q, model.name)
	);
	const recentAgentRowsForDisplay = recentAgentRows.filter(({ agent }) =>
		matches(q, agent.name, agent.id)
	);

	return (
		<div className="flex flex-col">
			{showSearch && (
				<div className="px-2 pb-1">
					<Input
						aria-label="Search agents, providers and models"
						className="h-8 border-0 bg-transparent px-1 text-[13px] shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
						onChange={(e) => setQuery(e.target.value)}
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => e.stopPropagation()}
						onPointerDown={(e) => e.stopPropagation()}
						placeholder="Search agents, providers…"
						spellCheck={false}
						value={query}
					/>
				</div>
			)}

			<div className="min-h-0 flex-1">
				{nothingMatches && (
					<p className="px-3 py-4 text-center text-muted-foreground text-xs">
						No matches for &ldquo;{query.trim()}&rdquo;
					</p>
				)}

				{!q &&
				(recentModelRowsForDisplay.length > 0 ||
					recentAgentRowsForDisplay.length > 0) ? (
					<>
						<SectionHeader label="Recent" />
						{showProviders &&
							recentModelRowsForDisplay.map((row, index) => (
								<RecentModelRow
									effort={row.effort}
									key={`model:${row.provider.id}:${row.model.id}`}
									model={row.model}
									modelRef={row.ref}
									onRemove={onRemoveRecent}
									onSelect={selectRecent}
									provider={row.provider}
									testId={`recent-model-row-${index}`}
								/>
							))}
						{showAgents &&
							recentAgentRowsForDisplay.map((row, index) => (
								<RecentAgentRow
									agent={row.agent}
									agentRef={row.ref}
									key={`agent:${row.agent.id}`}
									onRemove={onRemoveRecent}
									onSelect={selectRecent}
									testId={`recent-agent-row-${index}`}
								/>
							))}
					</>
				) : null}

				{/* Auto (Plane B — Core picks the agent per-turn) */}
				{showAgents && autoVisible && (
					<AutoTargetRow
						isActive={autoActive}
						onSelect={() => {
							onSelectAgent(AUTO_AGENT_ID);
						}}
					/>
				)}

				{q ? (
					// ── Search results: flattened so nesting never hides a match ──
					<>
						{showAgents && ryuVisible && ryuSub}
						{showProviders && filteredProviders.length > 0 && (
							<>
								<SectionHeader label="Providers" />
								{filteredProviders.map(providerSub)}
							</>
						)}
						{showAgents &&
							(filteredInstalled.length > 0 || filteredCustom.length > 0) && (
								<>
									<SectionHeader label="Agents" />
									{filteredInstalled.map(externalSub)}
									{filteredCustom.map(customAgentRow)}
								</>
							)}
						{showAgents && filteredAvailable.length > 0 && (
							<>
								<SectionHeader label="Not installed" />
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
					</>
				) : (
					// ── Compact root: one row per target ──
					<>
						{showAgents && ryuSub}
						{showAgents && filteredInstalled.map(externalSub)}
						{showAgents && filteredCustom.map(customAgentRow)}
						{showProviders && !q && providers.map(providerSub)}
						{/* One row out to the marketplace, not a second catalog nested
						    inside this one. The submenu that used to live here re-listed
						    every not-yet-installed agent with its own Install buttons —
						    a browsing surface the Customize page already owns, and one
						    that made a picker-for-choosing-a-target double as a store.
						    Searching still surfaces installable agents inline (the
						    "Not installed" branch above), so nothing became unreachable. */}
						{showAgents &&
							openAgentsCatalog &&
							availableExternal.length > 0 && (
								<DropdownMenuItem
									className="gap-2"
									onClick={() => {
										openAgentsCatalog();
										close();
									}}
								>
									<HugeiconsIcon
										className="shrink-0 text-muted-foreground"
										icon={Store01Icon}
										size={16}
										strokeWidth={2}
									/>
									<span className="flex-1 truncate">Add more agents</span>
								</DropdownMenuItem>
							)}
					</>
				)}

				{/* Groups (preserved from the legacy picker when present) */}
				{showAgents && filteredTeams.length > 0 && onSelectTeam && (
					<>
						<SectionHeader label="Groups" />
						{filteredTeams.map((team) => (
							<DropdownMenuItem
								className={cn("gap-2", team.isActive && "bg-foreground/10")}
								closeOnClick={false}
								key={team.id}
								onClick={() => {
									onSelectTeam(team.id);
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

				{/* Create new agent — a plus, because this row AUTHORS an agent. It
				    used to wear the download glyph, which read as "fetch one from
				    somewhere" and collided with the row above it. */}
				{showAgents && onCreateAgent && !q && (
					<DropdownMenuItem
						className="gap-2"
						onClick={() => {
							onCreateAgent();
							close();
						}}
					>
						<HugeiconsIcon
							className="shrink-0 text-muted-foreground"
							icon={Add01Icon}
							size={16}
							strokeWidth={2}
						/>
						<span className="flex-1 truncate">Create new agent</span>
					</DropdownMenuItem>
				)}
			</div>
		</div>
	);
}
