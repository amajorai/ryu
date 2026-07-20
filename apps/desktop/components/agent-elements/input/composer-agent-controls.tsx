"use client";

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

import { Add01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useMemo } from "react";
import { CapabilityBadges } from "@/components/agent-elements/input/capability-badges.tsx";
import {
	type ComposerSettingItem,
	ComposerSettingsMenu,
	type ComposerSettingsSection,
} from "@/components/agent-elements/input/composer-settings-menu.tsx";
import {
	ModeMenuContent,
	type ModeOption,
} from "@/components/agent-elements/input/mode-selector.tsx";
import { AUTO_AGENT_ID } from "@/components/agent-elements/input/universal-picker-body.tsx";
import { UsageBar } from "@/components/agent-elements/input/usage-bar.tsx";
import { useUniversalPicker } from "@/components/agent-elements/input/use-universal-picker.ts";
import type { ModelOption } from "@/components/agent-elements/types.ts";
import { useAgentCapabilities } from "@/src/hooks/useAgentCapabilities.ts";
import {
	engineForAgent,
	getAgentIcon,
	getTeamStackIcon,
} from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { Team } from "@/src/lib/api/teams.ts";

/** Sentinel `ModeSelector` value that routes to the "create a new agent" flow. */
export const CREATE_AGENT_MODE = "__create_agent__";
/** Team ids are namespaced in the picker so they can't collide with agent ids. */
export const TEAM_MODE_PREFIX = "team:";

/** The "New agent…" leading icon for the agent picker's create sentinel. */
export function NewAgentModeIcon({ className }: { className?: string }) {
	return <HugeiconsIcon className={className} icon={Add01Icon} />;
}

/** The "Auto" leading icon for the composer trigger when the `auto` sentinel is active. */
function AutoModeIcon({ className }: { className?: string }) {
	return <HugeiconsIcon className={className} icon={SparklesIcon} />;
}

export interface ComposerAgentModesOptions {
	/** Append the "New agent…" create sentinel row. Default: true. */
	includeCreate?: boolean;
	/** Append a "Teams" section addressable as one target. Default: true. */
	includeTeams?: boolean;
}

/**
 * The composer's agent picker options, derived from the live agent/team registry
 * with each entry's engine (or team-stack) logo — never hardcoded. Agents render
 * under an "Agents" group, teams under "Teams", and an optional "New agent…"
 * sentinel closes the list.
 */
export function useComposerAgentModes(
	agents: AgentSummary[],
	teams: Team[] = [],
	{ includeTeams = true, includeCreate = true }: ComposerAgentModesOptions = {}
): ModeOption[] {
	return useMemo(() => {
		const agentOptions = agents.map<ModeOption>((a) => ({
			id: a.id,
			label: a.name,
			icon: getAgentIcon(a.avatarUrl, engineForAgent(a)),
			description: a.description ?? undefined,
			group: "Agents",
		}));
		const teamOptions =
			includeTeams && teams.length > 0
				? teams.map<ModeOption>((t) => ({
						id: `${TEAM_MODE_PREFIX}${t.id}`,
						label: t.name,
						icon: getTeamStackIcon(
							t.members.map((id) => {
								const member = agents.find((a) => a.id === id);
								return member ? engineForAgent(member) : null;
							})
						),
						description: t.description ?? undefined,
						group: "Teams",
					}))
				: [];
		return [
			...agentOptions,
			...teamOptions,
			...(includeCreate
				? [
						{
							id: CREATE_AGENT_MODE,
							label: "New agent…",
							icon: NewAgentModeIcon,
						} satisfies ModeOption,
					]
				: []),
		];
	}, [agents, teams, includeTeams, includeCreate]);
}

/**
 * A caller-supplied override for the composer's Model section — the ACP-models /
 * config-option / engine-catalog chain ChatPage computes. When omitted, the model
 * section is built from `modelOptions` (hidden for ACP agents, which advertise
 * their own models in-chat).
 */
export interface ComposerModelSection {
	items: ComposerSettingItem[];
	/** The agent's model surface is still being probed (ACP capability fetch in flight). */
	loading?: boolean;
	onChange: (id: string) => void;
	/** Grouped/searchable body; when set, overrides the flat item list. */
	renderContent?: (onSelect: (id: string) => void) => ReactNode;
	value: string | undefined;
}

export interface ComposerAgentControlsConfig {
	/** Currently selected agent id, or null when a team is the active target. */
	agentId: string | null;
	/** Live agent registry (drives both the picker options and ACP detection). */
	agents: AgentSummary[];
	/**
	 * Compact single-row composer (used once a chat has history). When true the
	 * whole cluster moves to the composer's RIGHT (`rightActions`), to the left of
	 * the mic/send, and `leftActions` is `null` so only the "+" stays on the left.
	 * The subscription usage meters — which no longer fit as standalone chips —
	 * fold into the settings-menu dropdown as a footer. Defaults to the roomy
	 * left-aligned stacked layout.
	 */
	compact?: boolean;
	/**
	 * Extra `ComposerSettingsMenu` sections appended after Agent + Model — e.g.
	 * ChatPage's Approval (permission mode) and any agent-advertised config
	 * options. Empty sections are auto-hidden by the menu.
	 */
	extraSections?: ComposerSettingsSection[];
	/** Currently selected model id (used when `modelSection` is omitted). */
	model: string | null;
	/** Map a model's display name (e.g. friendly mode). Ignored with `modelSection`. */
	modelLabel?: (raw: string) => string;
	/** Model options for the active agent (built via `modelsForAgent`). */
	modelOptions: ModelOption[];
	/** Fully override the Model section (ChatPage's ACP/config/engine chain). */
	modelSection?: ComposerModelSection;
	/** Open the create-agent flow. Omit to hide the "New agent…" sentinel. */
	onCreateAgent?: () => void;
	/** Persist a model pick for the active agent (used when `modelSection` omitted). */
	onModelChange: (modelId: string) => void;
	/** Pick an agent as the driving target (real agent id only; sentinels handled here). */
	onSelectAgent: (agentId: string) => void;
	/** Pick a team as the driving target. Omit to hide the Teams section. */
	onSelectTeam?: (teamId: string) => void;
	/** Currently selected team id, or null when an agent is the active target. */
	teamId?: string | null;
	/** Live teams; pass `[]` (or omit `onSelectTeam`) to disable the Teams section. */
	teams?: Team[];
}

/**
 * The shared composer controls: `{ leftActions, rightActions }` ready to spread
 * into `InputBar`. This is the ONE definition of the chat bar's left cluster, so
 * ChatPage, the launchpad, and the Ask Ryu dock render an identical bar:
 *
 *   [ Agent · Model · … settings ]  [ capability badges ]  [ usage meters ]
 *
 * `leftActions` merges the agent/model/approval pickers into a single
 * `ComposerSettingsMenu` (Codex-style: one trigger, sections inside), followed by
 * the read-only `CapabilityBadges` and the subscription `UsageBar` — both derived
 * from `agentId`, so every surface that names an agent gets them for free.
 * `rightActions` is `null`: model selection lives in the settings menu.
 */
export function useComposerAgentControls(config: ComposerAgentControlsConfig): {
	leftActions: ReactNode;
	rightActions: ReactNode;
	/**
	 * The universal picker body (Ryu Portal · Providers · External Agents),
	 * exposed alongside `sections` so a surface with its own trigger (the
	 * empty-state agent logo) opens the IDENTICAL dropdown via
	 * `ComposerSettingsMenu`'s `trigger` + `renderBody` props.
	 */
	renderBody: (close: () => void) => ReactNode;
	/**
	 * The composed Agent · Model · Approval/Thinking sections, exposed so the
	 * trigger summary (`Ryu · Sonnet · Plan`) stays glanceable on a surface with
	 * its own trigger. The body itself now comes from `renderBody`.
	 */
	sections: ComposerSettingsSection[];
} {
	const {
		agents,
		teams = [],
		agentId,
		teamId = null,
		onSelectAgent,
		onSelectTeam,
		onCreateAgent,
		modelOptions,
		model,
		onModelChange,
		modelSection,
		modelLabel,
		extraSections = [],
		compact = false,
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

	// Agent section — grouped, icon'd rows via ModeMenuContent (identical to
	// ChatPage). The trigger summary shows the active agent/team name.
	const agentSection: ComposerSettingsSection = {
		key: "agent",
		label: "Agent",
		ariaLabel: "Select agent",
		activeName: activeMode?.label,
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
	const activeAgent = agents.find((a) => a.id === agentId);
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
				items: activeAgentIsAcp
					? []
					: modelOptions.map((m) => ({ id: m.id, name: label(m.name) })),
				value: model ?? undefined,
				onChange: onModelChange,
			};

	const sections = [agentSection, modelSectionResolved, ...extraSections];

	// The universal picker body (Ryu Portal · Providers · External Agents) that
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
		activeModelSection: modelSectionResolved,
		activeExtraSections: extraSections,
	});

	// Leading mark: a custom-agent avatar image wins, else the active mode's engine
	// logo (agents) or fanned team-stack icon (teams). ActiveIcon is the same stable
	// component the picker rows use, so the trigger never drifts. Shown beside the
	// agent name on EVERY surface (compact and full), not just compact mode.
	const ActiveIcon = activeMode?.icon;
	let leading: React.ReactNode = null;
	if (activeAgent?.avatarUrl) {
		leading = (
			// biome-ignore lint/performance/noImgElement: Tauri/Vite app, no next/image; avatar is an inline data URL
			// biome-ignore lint/correctness/useImageSize: sized via the `size-4` class
			<img
				alt=""
				className="size-4 shrink-0 rounded-full object-cover"
				src={activeAgent.avatarUrl}
			/>
		);
	} else if (ActiveIcon) {
		leading = <ActiveIcon className="size-4 shrink-0" />;
	}

	// Compact single-row composer: the cluster moves to the RIGHT of the input
	// (left of the mic/send). The trigger names only the active agent — with its
	// engine logo (or custom avatar) leading and the usage meters trailing, right
	// beside the name — so the whole composer fits on one line while model/approval
	// stay reachable inside the dropdown.
	if (compact) {
		const rightActions = (
			<div className="flex items-center gap-0.5">
				{/* Read-only capability badges (tools / thinking / vision) — local
				    models / flagship Ryu only; hidden for external ACP harnesses. */}
				{showCapabilityBadges && (
					<CapabilityBadges capabilities={capabilities} />
				)}
				{/* Agent picker: [logo] agent name [usage] ⌄ — model/approval inside. */}
				<ComposerSettingsMenu
					compact
					leading={leading}
					renderBody={renderBody}
					sections={sections}
					trailing={<UsageBar agentId={agentId} className="ml-0.5" compact />}
				/>
			</div>
		);
		return { leftActions: null, rightActions, sections, renderBody };
	}

	const leftActions = (
		<div className="flex min-w-0 items-center gap-0.5">
			<ComposerSettingsMenu
				leading={leading}
				renderBody={renderBody}
				sections={sections}
			/>
			{/* Read-only capability badges (tools / thinking / vision) — local
			    models / flagship Ryu only; hidden for external ACP harnesses. */}
			{showCapabilityBadges && <CapabilityBadges capabilities={capabilities} />}
			{/* Subscription usage meters (5h + weekly) for the active agent. */}
			<UsageBar agentId={agentId} />
		</div>
	);

	return { leftActions, rightActions: null, sections, renderBody };
}
