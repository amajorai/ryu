import type { RenderableBackdrop } from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import type { ReactNode } from "react";
import type { AgentBannerPreferenceStore } from "./agent-banner-dialog.tsx";
import type { SlotOption } from "./agent-edit-pi-config.tsx";
import type { AgentPreviewCardProps } from "./agent-edit-preview-card.tsx";
import type { AgentSettingsTab } from "./agent-settings-search.ts";

// ── Settings form (the main editor body) ──────────────────────────────────────

export interface ToneOptionItem {
	label: string;
	value: string;
}

export interface SkillRow {
	description?: string | null;
	enabled?: boolean;
	id: string;
	name: string;
}

/** A Space the agent may be granted read access to (Memory / Spaces slot). */
export interface SpaceRow {
	id: string;
	name: string;
}

export interface ComposioActionRow {
	description?: string | null;
	displayName: string;
	name: string;
}

export interface ComposioTriggerRow {
	displayName: string;
	name: string;
}

/** One connected account an event trigger may watch (already filtered to the
 *  accounts this agent may use). */
export interface ComposioAccountOption {
	id: string;
	/** Short human label, e.g. "gmail · Active". */
	label: string;
	/** Whose account it is: one of yours (the default), or one connected to
	 *  this agent's own identity. */
	owner?: "agent" | "you";
	toolkit: string;
}

export interface TriggerSubRow {
	id: string;
	/** Whether it watches an account connected to the agent's own identity. */
	ownAccount?: boolean;
	/** Whether the identity and account access on screen stop its events
	 *  (the account it watches is no longer allowed). */
	paused?: boolean;
	toolkit: string;
	triggerSlug: string;
}

export interface AgentSettingsFormProps {
	/** Injected: which accounts this agent may use (the allowlist editor),
	 *  rendered under Connections in place of `identityPanel`. */
	accountAccessPanel?: ReactNode;
	acpCommand: string;
	/** Injected: ACP auth ("Login with X") + session list controls for external
	 *  agents. Self-hides for agents that report no auth methods or sessions. */
	acpSessionPanel?: ReactNode;

	// Advanced inference (injected — it is its own coupled component)
	advancedInference?: ReactNode;
	/** Optional icon node shown in the identity header (the agent's logo). */
	agentIcon?: ReactNode;
	/** Injected compact setup composer that combines instructions and model choice. */
	agentSetupComposer?: ReactNode;
	/** Optional role/title badge shown beside the agent name. */
	agentTitle?: string;
	/** Stable id and node preference store for the shared agent banner. */
	bannerAgentId?: string;
	bannerPreferenceStore?: AgentBannerPreferenceStore;
	/** Injected: the current agent's Gateway token budget editor. */
	budgetPanel?: ReactNode;
	/** Injected: the per-agent Calendar view, rendered as its own tab. Omit to
	 *  hide the tab. */
	calendarPanel?: ReactNode;
	/** Injected: the per-agent capability controls (tools / thinking / vision,
	 *  orchestration), rendered in the Advanced tab. */
	capabilitiesPanel?: ReactNode;
	/** Injected: the per-agent Channels panel (control-plane bot bindings). */
	channelsPanel?: ReactNode;

	// Model slots
	chatModel: string;
	/** Injected shared provider/model command picker for the live desktop app. */
	chatModelPicker?: ReactNode;
	chatSlotDisabled?: boolean;
	/** Injected: ClaudeGatewayConfig for `acp:claude`. */
	claudeConfig?: ReactNode;
	/** Injected: CodexGatewayConfig for `acp:codex`. */
	codexConfig?: ReactNode;
	/** Connected accounts the trigger picker may offer. Omit to keep the
	 *  free-text account id field (hosts without a connection list). */
	composioAccounts?: ComposioAccountOption[];
	composioActions: ComposioActionRow[];
	composioActionsLoading?: boolean;

	// Composio actions
	composioConfigured: boolean;
	composioToolkit: string | null;
	composioToolkitItems: SlotOption[];
	composioTriggers: ComposioTriggerRow[];
	connectedAccountId: string;
	customCron: string;
	customTone: string;
	dailyTime: string;
	/** One-line agent description (identity header). */
	description?: string;
	/** Injected: the live employee badge, shown as a pinned profile artifact. */
	employeeBadge?: ReactNode;
	engineOptions: SlotOption[];
	/** Injected: the Evals view, rendered as its own tab. Omit to hide the tab. */
	evalsPanel?: ReactNode;
	/** Injected: lifecycle (draft/trial/active) and safety profile controls,
	 *  rendered at the top of Tools & knowledge in every mode — schedules need an
	 *  Active agent, so the simple editor cannot hide it. */
	executionPolicyPanel?: ReactNode;

	// Save
	formError?: string | null;
	/** Injected: generic GatewayRoutingConfig for BYO/other ACP agents. */
	gatewayRoutingConfig?: ReactNode;

	/** Injected: the bot's optional goal and main-thread reply length, which
	 *  persist on their own (scope guidance). Rendered under the instructions. */
	goalPanel?: ReactNode;
	/** Compact health grade shown in the agent profile header. */
	healthBadge?: ReactNode;
	/** Injected deterministic configuration health scorecard. */
	healthPanel?: ReactNode;
	/** Injected: the per-agent run-history view (chats + automated runs),
	 *  rendered as its own tab. Omit to hide the tab. */
	historyPanel?: ReactNode;
	/** Injected: whether the agent acts as you, has its own identity, or both.
	 *  Rendered at the top of Tools & knowledge in every mode. */
	identityModePanel?: ReactNode;
	/** Injected: the per-agent Identity Vault profile picker (empty = none).
	 *  Superseded by `accountAccessPanel`, which carries the same picker. */
	identityPanel?: ReactNode;
	/** Open on this indexed setting (an `AGENT_SETTINGS_ENTRIES` id): switch to
	 *  the tab that holds it once that tab is shown, and flash the row once. */
	initialSettingId?: string;
	/** Optional starting tab for storyboards and other presentational hosts. */
	initialTab?: AgentSettingsTab;
	/** Injected rich editor node for Instructions; falls back to a textarea. */
	instructionsEditor?: ReactNode;

	/** Injected: code samples and external integration paths for this agent. */
	integrationsPanel?: ReactNode;
	isBuiltIn: boolean;
	isLocked: boolean;
	isNew: boolean;
	/** Injected: ModelLaunchConfigSection when a tunable local engine is picked. */
	launchConfig?: ReactNode;
	marketplaceWallpapers?: readonly RenderableBackdrop[];

	// Memory / Spaces slot
	/** Memory scope levels the agent may recall from (subset of
	 * agent/user/node/project/org). Empty = all personal levels (the back-compat
	 * default); organization memory must be explicit. */
	memoryReadLevels: Set<string>;
	/** Space IDs the agent may read for retrieval. Empty = no Spaces injected. */
	memorySpaceIds: Set<string>;
	/** Whether the agent may record new memories during a session. */
	memoryWriteEnabled: boolean;
	// Identity
	name: string;
	/** Injected: the traceable identity + activity ledger for this agent,
	 *  rendered as its own tab beside run history. */
	observabilityPanel?: ReactNode;
	onAcpCommandChange?: (v: string) => void;
	/** Open the Customize store on the Agents tab to install more engines. */
	onAddMoreAgentProviders?: () => void;
	onAddRule?: () => void;
	onAgentTitleChange?: (v: string) => void;
	onCancel?: () => void;
	onChatModelChange?: (v: string) => void;
	/** Clear the currently-shown toolkit's actions from the selection. */
	onClearComposio?: () => void;
	onComposioToolkitChange?: (v: string | null) => void;
	onConnectedAccountIdChange?: (v: string) => void;
	onCreateAndChat?: () => void;
	onCustomCronChange?: (v: string) => void;
	onCustomToneChange?: (v: string) => void;
	onDailyTimeChange?: (v: string) => void;
	onDeleteTrigger?: (id: string) => void;
	onDescriptionChange?: (v: string) => void;
	onInstallWallpaper?: (
		wallpaper: RenderableBackdrop
	) => boolean | Promise<boolean>;
	onMemoryWriteEnabledChange?: (v: boolean) => void;
	onNameChange?: (v: string) => void;
	/** Simple mode only: open the advanced editor (the Agent workspace). Omit when the
	 *  viewer has no Console access; the link is then not offered. */
	onOpenAdvanced?: () => void;
	onOpenPromptStudio?: () => void;
	onPersonaDisplayNameChange?: (v: string) => void;
	/** Select the reusable personality profile assigned to this agent. */
	onPersonalityProfileChange?: (v: string) => void;
	onRemoveRule?: (index: number) => void;
	onRuleChange?: (index: number, value: string) => void;
	onSave?: () => void;
	onScheduleEnabledChange?: (v: boolean) => void;
	onSchedulePhraseChange?: (v: string) => void;
	/** Select every action of the currently-shown toolkit ("all tools"). */
	onSelectAllComposio?: () => void;
	onSubscribeTrigger?: () => void;
	onToggleComposio?: (name: string) => void;
	onToggleMemoryReadLevel?: (level: string) => void;
	onToggleMemorySpace?: (id: string) => void;
	onToggleSkill?: (id: string) => void;
	onToggleTool?: (name: string) => void;
	onToneChange?: (v: string) => void;
	onTriggerSlugChange?: (v: string) => void;
	onWeeklyDayChange?: (v: string) => void;
	onWeeklyTimeChange?: (v: string) => void;
	/** Injected: history-backed cost optimizations (cheaper model, unused
	 *  tools), rendered beside Quality tests. Omit to hide the view. */
	optimizationsPanel?: ReactNode;
	/** Whether the identity on screen gives the agent accounts of its own, so
	 *  the trigger picker can point to them when it has none to offer. */
	ownAccountsAllowed?: boolean;
	passportPanel?: ReactNode;

	// Persona
	personaDisplayName: string;
	/** Current personality profile id, or the caller's sentinel for the agent's own voice. */
	personalityProfile?: string;
	/** Available plugin/user personality profiles, including the agent's own voice option. */
	personalityProfiles?: SlotOption[];
	/** Injected: RyuPiConfig for the `ryu` agent. */
	piConfig?: ReactNode;

	// Preview — retained for back-compat (storyboard). The two-pane editor no
	// longer renders a preview aside; the live builder chat is the left pane.
	preview?: AgentPreviewCardProps;
	/** Injected: the Prompt Studio editor, rendered as its own tab. Omit to hide
	 *  the tab (e.g. for brand-new agents that have no record yet). */
	promptStudioPanel?: ReactNode;

	/** Injected: persistent agent routines with run destinations and controls. */
	routinesPanel?: ReactNode;

	// Rules
	rules: string[];
	/** Injected Agent Edit panel supplied by a plugin (for example Rules). */
	rulesPanel?: ReactNode;
	saveDisabled?: boolean;
	saving?: boolean;
	scheduleEnabled?: boolean;
	schedulePhrase: string;
	selectedComposio: Set<string>;
	selectedSkills: Set<string>;
	selectedTools: Set<string>;
	/** True when the "Run a custom agent command…" engine option is selected. */
	showAcpCommand?: boolean;

	// Composio event triggers
	showComposioTriggers?: boolean;
	/** Hide the model tab/step for the simplified interface preset. */
	showModelPanel?: boolean;
	/** Essentials only (Bot): Behavior, Tools & knowledge, and Triggers.
	 *  Every other tab stays in the advanced editor (the Agent workspace). */
	simple?: boolean;
	skills: SkillRow[];

	// Skills
	skillsLoading?: boolean;
	/** Spaces available to grant this agent read access to (Memory / Spaces slot). */
	spaces: SpaceRow[];
	subscribing?: boolean;
	systemPrompt: string;
	tone: string;
	toneOptions: ToneOptionItem[];
	tools: string[];

	// Tools
	toolsLoading?: boolean;
	triggerError?: string | null;
	triggerSlug: string;
	triggerSubs: TriggerSubRow[];
	/** Injected: complete agent-definition history with diff and restore. */
	versionHistoryPanel?: ReactNode;
	weeklyDay: string;
	weeklyTime: string;
}
