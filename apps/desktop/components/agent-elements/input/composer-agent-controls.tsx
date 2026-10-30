"use client";

import { CpuIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { acpHarnessSuffix } from "@ryu/blocks/composer/composer-trigger-summary.ts";
import { useMemo } from "react";
import { CapabilityBadges } from "@/components/agent-elements/input/capability-badges.tsx";
import {
	ComposerSettingsMenu,
	type ComposerSettingsSection,
} from "@/components/agent-elements/input/composer-settings-menu.tsx";
import { PickerSettingsMenu } from "@/components/agent-elements/input/manage-models-button.tsx";
import {
	ModeMenuContent,
	type ModeOption,
} from "@/components/agent-elements/input/mode-selector.tsx";
import { ProviderCommandDialog } from "@/components/agent-elements/input/provider-command-dialog.tsx";
import { AUTO_AGENT_ID } from "@/components/agent-elements/input/universal-picker-body.tsx";
import { UsageBar } from "@/components/agent-elements/input/usage-bar.tsx";
import { useUniversalPicker } from "@/components/agent-elements/input/use-universal-picker.ts";
import type { InputBarInfoBar } from "@/components/agent-elements/input-bar.tsx";
import { isComposerPluginSectionKey } from "@/src/components/composer/plugin-composer-controls.ts";
// The one place the chat composer's LEFT control cluster is defined.
//
// ChatPage, the launchpad (empty-tabs home), and the Ask Ryu dock all render the
// exact same bar — a single `ComposerSettingsMenu` (Agent · Model · … one trigger,
// sections inside), then read-only `CapabilityBadges`, then the subscription
// `UsageBar` — because every one of them gets it from this hook. Before this, each
// surface re-derived the mode list and re-wired the ACP hide / team-prefix / create
// sentinel by hand, and only ChatPage bolted on the badges + usage meters, so the
// launchpad and dock silently drifted into a lighter, different-looking bar. This
// module is that derivation once, so the three surfaces read identically and can
// never drift apart again.
//
// `useComposerAgentModes` builds the `ModeOption[]` from the live registry;
// `useComposerAgentControls` returns `{ leftActions, rightActions, sections }` — the
// first two a host spreads straight into `InputBar` (`rightActions` is always `null`
// — model lives in the settings menu), and `sections` the composed Agent · Model ·
// Thinking list so a surface with its own trigger (the empty-state agent logo) can
// open the IDENTICAL dropdown via `ComposerSettingsMenu`'s `trigger` prop. It is
// controlled — the caller owns the agent/team/model
// selection state (localStorage on the launchpad, a `BuilderRuntime` in the dock,
// ChatPage's own state) — and surfaces with a richer picker (ChatPage's ACP model
// chain + approval/config sections) feed those in via `modelSection`/`extraSections`.
// The capability badges + usage meters are derived from `agentId` inside the hook, so
// every surface that names an agent gets them for free.
import { useAgentCapabilities } from "@/src/hooks/useAgentCapabilities.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { usePiConfig } from "@/src/hooks/usePiConfig.ts";
import { useRoutingAdvice } from "@/src/hooks/useRoutingAdvice.ts";
import { AgentAvatar, engineForAgent } from "@/src/lib/agent-logos.tsx";
import { filterEnabledModels } from "@/src/lib/api/pi-config.ts";
import {
	showsComposerTuning,
	showsModelPicker,
} from "@/src/lib/interface-level.ts";
import type {
	ComposerAgentControls,
	ComposerAgentControlsConfig,
} from "./composer-agent-controls-types.ts";
import {
	AutoModeIcon,
	CREATE_AGENT_MODE,
	TEAM_MODE_PREFIX,
	useComposerAgentModes,
} from "./composer-agent-modes.tsx";

export type {
	ComposerAgentControls,
	ComposerAgentControlsConfig,
} from "./composer-agent-controls-types.ts";
export {
	type ComposerAgentModesOptions,
	CREATE_AGENT_MODE,
	NewAgentModeIcon,
	TEAM_MODE_PREFIX,
	useComposerAgentModes,
} from "./composer-agent-modes.tsx";

export function useComposerAgentControls(
	config: ComposerAgentControlsConfig
): ComposerAgentControls {
	const {
		agents,
		atConversationStart = false,
		teams = [],
		agentId,
		teamId = null,
		onSelectAgent,
		onSelectTeam,
		onCreateAgent,
		onUseProvider,
		onProviderModelSelection,
		onSelectProviderModel,
		onSelectProviderThinking,
		modelOptions,
		model,
		onModelChange,
		modelSection,
		forceModelPicker = false,
		managedProduct = false,
		modelLabel,
		extraSections = [],
		compact = false,
		compactTrigger = false,
		placement = "composer",
		surface = "dashboard",
	} = config;

	const modes = useComposerAgentModes(agents, teams, {
		includeTeams: Boolean(onSelectTeam),
		includeCreate: Boolean(onCreateAgent),
	});
	// Read-only capability badges + usage meters follow the active agent — the
	// same `agentId`-keyed hooks ChatPage uses, so all three surfaces match.
	// Pass the selected model so GGUF detection (vision/mmproj, template tools)
	// tracks the composer's model pick, not just the agent's bound slot.
	const { capabilities } = useAgentCapabilities(agentId, model);
	const { catalog: piCatalog } = usePiConfig();

	// Threshold fallback: what Core would actually run this turn, given how much
	// Ryu credit / provider balance / subscription window is left. Derived here
	// so every composer surface reports it identically — see the `infoBar` note on
	// this hook's return type.
	const { advice, refresh: refreshRoutingAdvice } = useRoutingAdvice(
		agentId,
		model,
		atConversationStart
	);
	const infoBar = useMemo<InputBarInfoBar | undefined>(() => {
		if (!advice?.reason) {
			return undefined;
		}
		return {
			// A swap already happened to the turn; a warning is a heads-up. Both are
			// informational — neither is an error, so neither takes the destructive
			// red wash the composer reserves for failures.
			title: advice.severity === "swap" ? "Fallback applied" : "Running low",
			description: advice.reason,
		};
	}, [advice?.reason, advice?.severity]);

	const handleModeChange = (next: string) => {
		if (next === CREATE_AGENT_MODE) {
			onCreateAgent?.();
			return;
		}
		if (next.startsWith(TEAM_MODE_PREFIX)) {
			onSelectTeam?.(next.slice(TEAM_MODE_PREFIX.length));
			return;
		}
		onSelectAgent(next);
	};

	const activeAgentValue = teamId
		? `${TEAM_MODE_PREFIX}${teamId}`
		: (agentId ?? undefined);
	// The `auto` sentinel is never in `modes` (it's Core's per-turn agent router,
	// not a concrete agent), so synthesize its active row so the trigger reads
	// "Auto" with a sparkle instead of silently falling back to the first agent.
	const autoMode: ModeOption = {
		id: AUTO_AGENT_ID,
		label: "Auto",
		icon: AutoModeIcon,
	};
	const activeMode =
		agentId === AUTO_AGENT_ID
			? autoMode
			: (modes.find((m) => m.id === activeAgentValue) ?? modes[0]);

	const activeAgent = agents.find((a) => a.id === agentId);
	// Which ACP harness is actually driving, when the agent's own name does not
	// already say so — `Ryu (pi)`, never `OpenCode (opencode)`. It rides the agent
	// name rather than taking a bullet of its own, and it is derived from the
	// agent's advertised engine, so a store-backed custom agent (whose engine
	// Core's list endpoint omits) gets no suffix rather than a guess.
	const harness =
		activeAgent?.transport === "acp"
			? acpHarnessSuffix(activeMode?.label, engineForAgent(activeAgent))
			: null;

	// Agent section — grouped, icon'd rows via ModeMenuContent (identical to
	// ChatPage). The trigger summary shows the active agent/team name.
	const agentSection: ComposerSettingsSection = {
		key: "agent",
		label: "Agent",
		ariaLabel: "Select agent",
		activeName:
			activeMode?.label && harness
				? `${activeMode.label} (${harness})`
				: activeMode?.label,
		items: modes.map((m) => ({
			id: m.id,
			name: m.label,
			description: m.description,
		})),
		value: activeAgentValue,
		onChange: handleModeChange,
		renderContent: (onSelect) => (
			<ModeMenuContent
				activeId={activeMode?.id}
				modes={modes}
				onSelect={onSelect}
			/>
		),
	};

	// Model section — caller override (ChatPage's ACP/config/engine chain) or the
	// built-in engine catalog. ACP agents advertise their own models in-chat, so
	// with no override their catalog section is empty (and thus auto-hidden).
	// Per-model visibility for THIS agent (Settings → Providers → Agents), from
	// the shared Pi catalog query.
	const agentModelOverrides = agentId
		? piCatalog?.agentModelOverrides?.[agentId]
		: undefined;
	const activeAgentIsAcp = activeAgent?.transport === "acp";
	// Capability badges (tools / thinking / vision) only carry meaning for local
	// models — where the effective capabilities are genuinely variable and detected
	// per model. For external ACP harnesses (Claude Code, Codex, Gemini CLI,
	// OpenClaw, Hermes, …) they're noise: those engines obviously do all three. So
	// show badges for openai-compat / local / custom agents and for the flagship
	// Ryu (whose transport is `acp:pi` but which runs a local model), and hide them
	// for every other ACP harness.
	const showCapabilityBadges = !activeAgentIsAcp || activeAgent?.recommended;
	const label = modelLabel ?? ((raw: string) => raw);
	const modelSectionResolved: ComposerSettingsSection = modelSection
		? {
				key: "model",
				label: "Model",
				ariaLabel: "Select model",
				items: modelSection.items,
				value: modelSection.value,
				onChange: modelSection.onChange,
				renderContent: modelSection.renderContent,
				loading: modelSection.loading,
			}
		: {
				key: "model",
				label: "Model",
				ariaLabel: "Select model",
				// Without a caller override this is the engine catalog; it obeys the
				// same per-agent visibility toggles the override path applies, so a
				// hidden model does not reappear on the surfaces that use this branch.
				items: activeAgentIsAcp
					? []
					: filterEnabledModels(
							modelOptions.map((m) => ({ id: m.id, name: label(m.name) })),
							agentModelOverrides,
							model
						),
				value: model ?? undefined,
				onChange: onModelChange,
			};

	// Interface mode decides how much of this bar exists at all (see
	// `@/src/lib/interface-level.ts`). At Ryu Work the composer is the agent picker
	// and nothing else; Code adds the model and tuning
	// sections (approval mode, thinking budget, and agent config). Gating happens HERE,
	// in the one hook all three composer surfaces
	// share, so the chat page, the launchpad and the Ask Ryu dock cannot disagree
	// about what a mode means.
	//
	// Hidden is not disabled: an agent still runs on whatever model, approval mode
	// and thinking budget it is configured with — the per-agent settings page is
	// where those live at any level. This only decides whether the CHAT BAR
	// carries them.
	const interfaceLevel = useInterfaceLevel();
	// Auto selects an agent per turn, not a model. Its placeholder model has the
	// same label, so surfacing it would make the trigger read "Auto · Auto".
	const showModelSection =
		!managedProduct &&
		(forceModelPicker || showsModelPicker(interfaceLevel)) &&
		agentId !== AUTO_AGENT_ID;
	const showTuningSections =
		!managedProduct && showsComposerTuning(interfaceLevel);
	const bodySections = useMemo(
		() => (showTuningSections ? extraSections : []),
		[extraSections, showTuningSections]
	);

	// The trigger summary reads `Ryu · Sonnet · Plan` — the agent, what it runs on,
	// and how it is allowed to act. Those are the facts that change what the NEXT
	// message does, and they are worth permanent space.
	//
	// Contributed pickers are not. An app's own mode `select` is a setting you set once
	// and leave, so spelling its current value out on the trigger buys a word of chrome
	// per installed plugin and pushes the three facts above out of a bar that is already
	// narrow at compact density.
	//
	// This narrowing is applied to `triggerSections` ONLY, never to `sections`.
	// The two are not interchangeable: `sections` is also what the composer's
	// keyboard shortcuts operate on (`firstExtraConfigSection` in
	// `composer-shortcuts.ts` cycles the first non-agent/model/approval section),
	// so dropping the contributed ones there would not hide a value — it would
	// silently repoint the shortcut at a different setting, or leave it with
	// nothing to cycle.
	const summaryExtraSections = useMemo(
		() => extraSections.filter((s) => !isComposerPluginSectionKey(s.key)),
		[extraSections]
	);
	// The summary has to describe the popover it opens, so it is filtered by the
	// same level: a trigger reading `Ryu · Sonnet` above a body with no model row
	// is worse than either half alone.
	const sectionsForLevel = (extras: ComposerSettingsSection[]) =>
		managedProduct
			? []
			: [
					agentSection,
					...(showModelSection ? [modelSectionResolved] : []),
					...(showTuningSections ? extras : []),
				];
	/** Every composed section — the shortcut targets, and the list any surface
	 *  rendering these as ROWS must use. */
	const sections = sectionsForLevel(extraSections);
	/** The same list narrowed to what a settings TRIGGER should spell out. Every
	 *  trigger built from this hook (the composer's own, and the empty-state logo's)
	 *  uses this, so the two can never summarise differently. */
	const triggerSections = sectionsForLevel(summaryExtraSections);

	// The universal picker body (Ryu (providers nested) · External Agents) that
	// replaces the sibling-submenu list. The trigger summary still derives from
	// `sections`, so `Ryu · Sonnet · Plan` is unchanged; only the popover changes.
	// The active agent's live model/approval/thinking sections are threaded in so
	// tuning the current target still wires to the host's live handlers.
	const { renderBody } = useUniversalPicker({
		agents,
		agentId,
		teamId,
		teams,
		onSelectAgent,
		onSelectTeam,
		onCreateAgent,
		onUseProvider,
		onProviderModelSelection,
		onSelectProviderModel,
		onSelectProviderThinking,
		activeModelSection: showModelSection ? modelSectionResolved : null,
		activeExtraSections: bodySections,
		forceModelPicker,
		surface,
	});
	const activeModelName =
		modelSectionResolved.items.find(
			(item) => item.id === modelSectionResolved.value
		)?.name ?? "Choose model";

	// Leading mark: a custom-agent glyph wins, else the active mode's engine
	// logo (agents) or fanned team-stack icon (teams). ActiveIcon is the same stable
	// component the picker rows use, so the trigger never drifts. Shown beside the
	// agent name on EVERY surface (compact and full), not just compact mode.
	const ActiveIcon = activeMode?.icon;
	let leading: React.ReactNode = null;
	if (activeAgent?.avatarGlyph) {
		leading = (
			<AgentAvatar
				className="size-4 shrink-0 object-contain"
				engine={engineForAgent(activeAgent)}
				glyph={activeAgent.avatarGlyph}
				size="16px"
			/>
		);
	} else if (ActiveIcon) {
		leading = <ActiveIcon className="size-4 shrink-0" />;
	}

	// Compact trigger: `[logo] agent [usage] ⌄` — model/approval stay inside the
	// dropdown. Shared by the dense chat-with-history composer and the narrow-panel
	// (Ask Ryu) one; both keep the cluster left-aligned in the stacked controls row.
	const settingsMenu = managedProduct ? null : (
		<>
			<ComposerSettingsMenu
				compact={compact || compactTrigger}
				footer={(close) => <PickerSettingsMenu close={close} />}
				leading={leading}
				renderBody={(close) => renderBody(close, "agents")}
				sections={triggerSections.filter((section) => section.key !== "model")}
				trailing={
					compact || compactTrigger ? (
						<UsageBar agentId={agentId} className="ml-0.5" compact />
					) : undefined
				}
			/>
			{showModelSection && (
				<ProviderCommandDialog
					renderBody={(close) => renderBody(close, "models")}
					trigger={
						<button
							aria-label="Choose provider and model"
							className="composer-model-trigger max-w-44 truncate rounded-md px-2 py-1 text-muted-foreground text-xs hover:bg-muted/50 hover:text-foreground"
							title={activeModelName}
							type="button"
						>
							<HugeiconsIcon
								aria-hidden="true"
								className="composer-model-icon size-3.5 shrink-0"
								icon={CpuIcon}
							/>
							<span className="composer-model-name truncate">
								{activeModelName}
							</span>
						</button>
					}
				/>
			)}
		</>
	);
	const picker = (
		<div
			className={
				placement === "tab-bar"
					? "flex min-w-0 max-w-[18rem] items-center gap-0.5"
					: undefined
			}
			data-testid="chat-model-agent-picker"
		>
			{settingsMenu}
		</div>
	);

	// ONE leading cluster: the settings menu, badges and (full trigger only) usage
	// chip. InputBar places it before a one-line compact textarea or at the left of
	// the full controls row after that textarea wraps; this hook does not fork a
	// second right-aligned arrangement.
	const leftActions = managedProduct ? null : (
		<div className="flex min-w-0 items-center gap-0.5">
			{placement === "composer" ? picker : null}
			{/* Read-only capability badges (tools / thinking / vision) — local
			    models / flagship Ryu only; hidden for external ACP harnesses. */}
			{showCapabilityBadges && (
				<CapabilityBadges
					capabilities={capabilities}
					className="composer-capability-badges"
				/>
			)}
			{/* Only the FULL trigger shows usage as a standalone chip: both compact
			    modes already fold the same meters into the trigger's `trailing`, so
			    rendering the chip too would show every meter twice. */}
			{compact || compactTrigger ? null : (
				<UsageBar adaptive agentId={agentId} />
			)}
		</div>
	);

	return {
		infoBar,
		leftActions,
		picker,
		refreshRoutingAdvice,
		rightActions: null,
		sections,
		triggerSections,
		renderBody,
	};
}
