import type { ComposerModelSection } from "@ryu/blocks/composer/composer-acp-sections.ts";
import type { ReactNode } from "react";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import type { InputBarInfoBar } from "@/components/agent-elements/input-bar.tsx";
import type { ModelOption } from "@/components/agent-elements/types.ts";
import type { ChatPickerPlacement } from "@/src/hooks/useChatPickerPlacement.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { Team } from "@/src/lib/api/teams.ts";
import type { BrowserSurface } from "@/src/lib/extension-host.ts";

// `ComposerModelSection` — the caller-supplied override for the Model section
// (the ACP-models / config-option / engine-catalog chain) — is owned by
// `@ryu/blocks/composer/composer-acp-sections`, alongside the derivation that
// produces it, so desktop and the island cannot drift apart on its shape.

export interface ComposerAgentControlsConfig {
	/** Currently selected agent id, or null when a team is the active target. */
	agentId: string | null;
	/** Live agent registry (drives both the picker options and ACP detection). */
	agents: AgentSummary[];
	/**
	 * True when sending would OPEN a conversation rather than continue one (an
	 * empty thread, the launchpad). Only affects the threshold-fallback notice:
	 * a rule that swaps the whole agent applies at a conversation start only,
	 * because an ACP agent owns its own session state. Defaults to false, the
	 * conservative read — the notice then says "new conversations will start on
	 * X" instead of promising a switch to this thread.
	 */
	atConversationStart?: boolean;
	/**
	 * Responsive compact composer (used once a chat has history). The control
	 * cluster stays on the leading side of the textarea while it fits on one line,
	 * then becomes the left side of the normal controls row below when the textarea
	 * wraps. The settings-menu trigger shortens to `[logo] agent [usage] ⌄` (it
	 * implies {@link compactTrigger}) and the subscription usage meters fold INTO
	 * that trigger rather than sitting beside it as a standalone chip.
	 */
	compact?: boolean;
	/**
	 * Compact the settings-menu trigger to `[logo] agent [usage] ⌄` without
	 * moving the cluster to the right. Used by narrow surfaces (Ask Ryu floating
	 * / docked) that keep the roomy stacked textarea but still need the short
	 * trigger. Ignored when {@link compact} is true (that already includes it).
	 */
	compactTrigger?: boolean;
	/**
	 * Extra `ComposerSettingsMenu` sections appended after Agent + Model — e.g.
	 * ChatPage's Approval (permission mode) and any agent-advertised config
	 * options. Empty sections are auto-hidden by the menu.
	 */
	extraSections?: ComposerSettingsSection[];
	/** Keep the model control visible on setup surfaces at every interface level. */
	forceModelPicker?: boolean;
	/** Hide all target/model/provider controls for the managed Bot product. */
	managedProduct?: boolean;
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
	/** Observe provider/model picks without replacing the normal provider action. */
	onProviderModelSelection?: (selection: {
		modelId: string | null;
		providerId: string;
		providerLabel: string;
	}) => void;
	/** Pick an agent as the driving target (real agent id only; sentinels handled here). */
	onSelectAgent: (agentId: string) => void;
	/** Optional setup-surface override for a concrete provider/model pick. */
	onSelectProviderModel?: (providerId: string, modelId: string) => void;
	/** Optional setup-surface override for provider thinking-level picks. */
	onSelectProviderThinking?: (providerId: string, level: string) => void;
	/** Pick a group as the driving target. Omit to hide the Groups section. */
	onSelectTeam?: (teamId: string) => void;
	/** Optional setup-surface override for a provider pick. */
	onUseProvider?: (providerId: string, modelId: string | null) => void;
	/** Put the shared model/agent picker in the chat tab bar instead of the composer. */
	placement?: ChatPickerPlacement;
	/** Browser surface key; desktop defaults to the dashboard-compatible no-op host. */
	surface?: BrowserSurface;
	/** Currently selected team id, or null when an agent is the active target. */
	teamId?: string | null;
	/** Live groups; pass `[]` (or omit `onSelectTeam`) to disable the Groups section. */
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
export interface ComposerAgentControls {
	/**
	 * The threshold-fallback notice for the turn about to be sent, ready to spread
	 * into `InputBar`'s `infoBar` prop — "Ryu credit is at $3.10 (under your $5.00
	 * rule) — running this turn on gpt-5-mini."
	 *
	 * It lives HERE, next to the agent/model pickers, for the same reason the
	 * `UsageBar` does: every composer surface derives it from this one hook, so
	 * the dock and the launchpad cannot silently ship a composer that swaps a
	 * model without saying so. `undefined` when there is nothing to report, which
	 * is the case on any node with no rules configured.
	 */
	infoBar: InputBarInfoBar | undefined;
	leftActions: ReactNode;
	/** The same model/agent picker node, exposed for a host action tray. */
	picker: ReactNode;
	/**
	 * Re-ask Core for the fallback verdict. A host calls this right after sending
	 * a turn, so the bar reflects the headroom that turn just consumed.
	 */
	refreshRoutingAdvice: () => void;
	/**
	 * The universal picker body (Ryu (providers nested) · External Agents),
	 * exposed alongside `sections` so a surface with its own trigger (the
	 * empty-state agent logo) opens the IDENTICAL dropdown via
	 * `ComposerSettingsMenu`'s `trigger` + `renderBody` props.
	 */
	renderBody: (close: () => void) => ReactNode;
	rightActions: ReactNode;
	/**
	 * The composed Agent · Model · Approval/Thinking sections, exposed so the
	 * trigger summary (`Ryu · Sonnet · Plan`) stays glanceable on a surface with
	 * its own trigger. The body itself now comes from `renderBody`.
	 *
	 * Personality profiles are assigned on the agent editor, so the composer only
	 * summarizes the target and its runtime controls.
	 */
	sections: ComposerSettingsSection[];
	/** The sections shown in the trigger summary, excluding plugin-only rows. */
	triggerSections: ComposerSettingsSection[];
}
