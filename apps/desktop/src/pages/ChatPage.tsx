import { useChat } from "@ai-sdk/react";
import {
	WidgetHostContext,
	type WidgetHostServices,
	type WidgetHostValue,
} from "@ryu/blocks/desktop/agent-elements/widget-host-context";
import { Avatar } from "@ryu/ui/components/avatar";
import { toast } from "@ryu/ui/components/sileo";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import type { JoinAck } from "@ryuhq/core-client/realtime";
import { DefaultChatTransport } from "ai";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentChat } from "@/components/agent-elements/agent-chat.tsx";
import {
	EmptyStateHeader,
	type EmptyStateLogo,
} from "@/components/agent-elements/empty-state-header.tsx";
import { useComposerAgentControls } from "@/components/agent-elements/input/composer-agent-controls.tsx";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import { handleComposerSettingsShortcut } from "@/components/agent-elements/input/composer-shortcuts.ts";
import type {
	GhostControls,
	PluginComposerControlRow,
} from "@/components/agent-elements/input/goal-plus-button.tsx";
import { useComposerAcpSections } from "@/components/agent-elements/input/use-composer-acp-sections.ts";
import type {
	AttachedImage,
	InputBarProps,
} from "@/components/agent-elements/input-bar.tsx";
import { InputBar } from "@/components/agent-elements/input-bar.tsx";
import type { QueueBarProps } from "@/components/agent-elements/queue/queue-bar.tsx";
import { formatQuotePrefix } from "@/components/agent-elements/quote.tsx";
import {
	BtwOverlay,
	type BtwState,
} from "@/src/components/chat/BtwOverlay.tsx";
import { DiffReviewPane } from "@/src/components/chat/DiffReviewPane.tsx";
import { MentionMenu } from "@/src/components/chat/MentionMenu.tsx";
import {
	type ActivePermission,
	PermissionPrompt,
} from "@/src/components/chat/PermissionPrompt.tsx";
import {
	type SlashCommand,
	SlashCommandAutocomplete,
} from "@/src/components/chat/SlashCommandAutocomplete.tsx";
import { WorkspaceBar } from "@/src/components/chat/WorkspaceBar.tsx";
import type { SubagentSummary } from "@/src/components/panels/CoworkContextPanel.tsx";
import { PinnedSummaryPanel } from "@/src/components/panels/PinnedSummaryPanel.tsx";
import {
	PanelToggleButtons,
	WorkspacePanels,
} from "@/src/components/panels/WorkspacePanels.tsx";
import { VoiceModeOverlay } from "@/src/components/voice/VoiceModeOverlay.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import { useSystemStatusContext } from "@/src/contexts/SystemStatusContext.tsx";
import { useIsActiveTab, useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useTitleBar } from "@/src/contexts/TitleBarContext.tsx";
import { AppWidget } from "@/src/contributions/host/AppWidget.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useEngineModels } from "@/src/hooks/useEngineModels.ts";
import { useMcp } from "@/src/hooks/useMcp.ts";
import { useMessageQueue } from "@/src/hooks/useMessageQueue.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { useSkillsCatalog } from "@/src/hooks/useSkillsCatalog.ts";
import { useSpaces } from "@/src/hooks/useSpaces.ts";
import { useTeams } from "@/src/hooks/useTeams.ts";
import { useVoiceMode } from "@/src/hooks/useVoiceMode.ts";
import { AgentLogo, engineForAgent } from "@/src/lib/agent-logos.tsx";
import { respondPermission } from "@/src/lib/api/acp.ts";
import type {
	AgentSummary,
	ConversationParticipant,
} from "@/src/lib/api/agents.ts";
import { fetchAgent, fetchParticipants } from "@/src/lib/api/agents.ts";
import type { BtwEntry } from "@/src/lib/api/btw.ts";
import { askBtw } from "@/src/lib/api/btw.ts";
import {
	cancelChat,
	chatHeaders,
	chatStreamResumeUrl,
	chatStreamUrl,
	fetchNextPromptSuggestions,
} from "@/src/lib/api/chat.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { generateImage } from "@/src/lib/api/images.ts";
import {
	getModelContextWindow,
	getModelLaunchConfig,
} from "@/src/lib/api/inference.ts";
import {
	getConversationFeedback,
	setMessageFeedback,
} from "@/src/lib/api/message-feedback.ts";
import {
	getDesktopTtsPrefs,
	getVoiceModeReadbackPrefs,
} from "@/src/lib/api/preferences.ts";
import type { Team } from "@/src/lib/api/teams.ts";
import { generateVideo } from "@/src/lib/api/video.ts";
import { speakText, transcribeAudio } from "@/src/lib/api/voice.ts";
import {
	widgetCallTool,
	widgetFollowUp,
	widgetSetState,
} from "@/src/lib/api/widgets.ts";
import {
	PLUGIN_RUNTIME_FLAG,
	shouldRenderWidget,
	useExperimentalFlag,
} from "@/src/lib/experimental.ts";
import {
	applyMention,
	buildMentionGroups,
} from "@/src/lib/mentions/candidates.ts";
import { getComposerPlugins } from "@/src/lib/mentions/plugins.ts";
import type { MentionItem, MentionSources } from "@/src/lib/mentions/types.ts";
import {
	getAgentModel,
	modelsForAgent,
	setAgentModel,
} from "@/src/lib/models.ts";
import { getRealtimeJwt, getRealtimeUserId } from "@/src/lib/realtime/jwt.ts";
import { useRealtimeRoom } from "@/src/lib/realtime/use-realtime-room.ts";
import { useAppStore } from "@/src/store/useAppStore.ts";
import { useMeetingRecordingStore } from "@/src/store/useMeetingRecordingStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

const KICKSTART_PROMPT = "Hello! What can you help me with?";

// Stale run threshold: if a message was last updated more than 30 seconds ago
// and its conversation is still flagged "running", treat it as interrupted.
const STALE_THRESHOLD_MS = 30_000;

// Idle gap after the last keystroke before we broadcast `typing:false` to the
// conversation room (multi-user presence).
const TYPING_IDLE_MS = 2500;

/** Returns true when the selected agent uses ACP transport (never touches the gateway). */
function isAcpAgent(
	agentId: string | null,
	agents: ReturnType<typeof useAgents>["agents"]
): boolean {
	if (!agentId) {
		// No agent selected — default to ACP behaviour (no gateway needed).
		return true;
	}
	// Engine ids selected directly from the engines list (e.g. "acp:claude")
	if (agentId.startsWith("acp:")) {
		return true;
	}
	// Check against known agents in the registry
	const agent = agents.find((a) => a.id === agentId);
	if (!agent) {
		// Unknown id — default to ACP (no gateway required) to avoid false blocks.
		return true;
	}
	// Prefer the transport Core reports — the authoritative signal — over any
	// client-side re-derivation. Only "openai_compat" needs the gateway.
	if (agent.transport) {
		return agent.transport !== "openai_compat";
	}
	// Registry built-ins are always ACP
	if (agent.builtIn) {
		return true;
	}
	// Custom agents: if engine is explicitly set to an ACP variant, it's ACP
	if (agent.engine?.startsWith("acp:")) {
		return true;
	}
	// Custom agents with an explicit non-ACP engine or no engine: default to ACP
	// (openai-compat agents would have a non-null engine that does NOT start with "acp:")
	if (agent.engine && !agent.engine.startsWith("acp:")) {
		return false;
	}
	return true;
}

/**
 * Rehydrate a persisted history message into AI SDK `parts`. Core carries the
 * structured tool/text/file parts when it has them (assistant turns that ran
 * tools/media after parts capture existed), so a reloaded chat re-renders its tool
 * rows and the cowork context (Progress / Sources / Subagents) rather than
 * collapsing to flat text. When absent (user turns, or older messages) we fall
 * back to a single text part built from `content`.
 */
function hydrateMessageParts(m: {
	content: string;
	parts?: unknown[];
}): unknown[] {
	if (Array.isArray(m.parts) && m.parts.length > 0) {
		return m.parts;
	}
	return [{ type: "text", text: m.content }];
}

/**
 * Build the version-pager map (message id → { index, count, ids }) from a loaded
 * history. Only messages that actually have alternate versions (siblingCount > 1
 * with sibling ids) get an entry, so the pager renders solely at real branch
 * points.
 */
function buildVersions(
	history: Array<{
		id: string;
		siblingIndex?: number;
		siblingCount?: number;
		siblingIds?: string[];
	}>
): Record<string, { index: number; count: number; ids: string[] }> {
	const map: Record<string, { index: number; count: number; ids: string[] }> =
		{};
	for (const h of history) {
		if (h.siblingCount && h.siblingCount > 1 && h.siblingIds?.length) {
			map[h.id] = {
				index: h.siblingIndex ?? 0,
				count: h.siblingCount,
				ids: h.siblingIds,
			};
		}
	}
	return map;
}

/** Plain text from the last assistant message's parts (for auto read-back). */
function extractAssistantText(message: {
	parts?: unknown[];
	content?: string;
}): string {
	if (Array.isArray(message.parts) && message.parts.length > 0) {
		return message.parts
			.filter(
				(part): part is { type: string; text?: string } =>
					typeof part === "object" &&
					part !== null &&
					(part as { type?: string }).type === "text" &&
					typeof (part as { text?: string }).text === "string"
			)
			.map((part) => part.text ?? "")
			.join("\n\n")
			.trim();
	}
	return typeof message.content === "string" ? message.content.trim() : "";
}

/** Maps a raw error string to a user-friendly message. */
function friendlyError(raw: string): { message: string; detail: string } {
	const lower = raw.toLowerCase();
	if (
		lower.includes("executable not found") ||
		lower.includes("enoent") ||
		lower.includes("no such file")
	) {
		return {
			message: "Agent not installed - Install the agent from the Agents page.",
			detail: raw,
		};
	}
	if (
		lower.includes("connection refused") ||
		lower.includes("econnrefused") ||
		lower.includes("connect error")
	) {
		return {
			message: "Could not reach Core - Retry or start Core from Services.",
			detail: raw,
		};
	}
	return {
		message: "Something went wrong.",
		detail: raw,
	};
}

const MENTION_QUERY_RE = /(?:^|\s)@(\w*)$/;
const SLASH_QUERY_RE = /^\/(\w*)$/;
const FIRST_MENTION_RE = /@(\w+)/;
const FIRST_TEAM_MENTION_RE = /@([\w-]+)/;

/**
 * Parse the last "@word" being typed in a string.
 * Returns the partial name after "@" if the cursor is at an in-progress mention,
 * or null if the cursor is not on a mention.
 */
function parseMentionQuery(value: string): string | null {
	const match = MENTION_QUERY_RE.exec(value);
	if (!match) {
		return null;
	}
	return match[1];
}

/** Ryu's own composer commands, always offered alongside agent-advertised ones.
 *  These are intercepted client-side (`/btw`) or by a Core turn-hook plugin
 *  (`/goal`) at submit time; the popover just makes them discoverable. */
const LOCAL_SLASH_COMMANDS: SlashCommand[] = [
	{
		name: "btw",
		description: "Ask a quick side question without derailing the chat",
		hint: "your side question",
		source: "local",
	},
	{
		name: "goal",
		description: "Set a goal the agent works toward each turn",
		hint: "condition to watch for",
		source: "local",
	},
];

/**
 * Parse a leading "/word" being typed at the very start of the composer.
 * Returns the partial command name (may be empty right after "/"), or null when
 * the value isn't an in-progress slash command (e.g. once a space is typed, the
 * argument has begun and the menu should close).
 */
function parseSlashQuery(value: string): string | null {
	const match = SLASH_QUERY_RE.exec(value);
	return match ? match[1] : null;
}

/** Scan message text for the first "@Name" mention and resolve it to an agent id. */
function resolveFirstMention(
	text: string,
	agents: AgentSummary[]
): string | null {
	const match = FIRST_MENTION_RE.exec(text);
	if (!match) {
		return null;
	}
	const mentionName = match[1].toLowerCase();
	const found = agents.find((a) => a.name.toLowerCase() === mentionName);
	return found?.id ?? null;
}

/** Scan message text for the first "@Name" that matches a team, returning its id.
 *  Teams take precedence over agents when a name collides, since a team mention
 *  is the more specific "call all of them" intent. */
function resolveFirstTeamMention(text: string, teams: Team[]): string | null {
	const match = FIRST_TEAM_MENTION_RE.exec(text);
	if (!match) {
		return null;
	}
	const mentionName = match[1].toLowerCase();
	const found = teams.find((t) => t.name.toLowerCase() === mentionName);
	return found?.id ?? null;
}

// ---------------------------------------------------------------------------
/**
 * Build the per-request `plugin_flags` map from the plugin composer toggles that
 * are currently ON. Every composer control (including the built-in double-check
 * toggle, which is now a plugin contribution like any other) flows through this
 * one generic map keyed by each control's `flag`. Returns `undefined` when
 * nothing is on so Core applies its defaults.
 */
export function buildPluginFlags(
	pluginFlags: Record<string, boolean>
): Record<string, boolean> | undefined {
	const merged: Record<string, boolean> = {};
	for (const [flag, on] of Object.entries(pluginFlags)) {
		if (on) {
			merged[flag] = true;
		}
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

// #415: Council-aware InputBar — adds @mention autocomplete above the textarea
// ---------------------------------------------------------------------------
interface CouncilInputBarProps extends InputBarProps {
	allAgents: AgentSummary[];
	allTeams: Team[];
	/** Slash commands offered in the "/" popover (agent-advertised + local). */
	availableCommands: SlashCommand[];
	composerSections: ComposerSettingsSection[];
	/** Sources for the grouped "@" mention menu (agents/teams/spaces/skills/mcp/
	 *  folders/plugins). Agents/teams here also drive the council target. */
	mentionSources: MentionSources;
	onRespondPermission?: (optionId: string | null) => void;
	onTargetAgentChange: (agentId: string | null) => void;
	onTeamChange: (teamId: string | null) => void;
	/** Fired on each composer keystroke so the surface can broadcast a debounced
	 * "typing" presence delta to the conversation room (multi-user collaboration). */
	onTyping?: () => void;
	/** Active interactive ACP tool-permission prompt, rendered above the composer. */
	permission?: ActivePermission | null;
}

function CouncilInputBar({
	allAgents,
	allTeams,
	availableCommands,
	composerSections,
	mentionSources,
	onTargetAgentChange,
	onTeamChange,
	onTyping,
	permission,
	onRespondPermission,
	value,
	onChange,
	onSend,
	onTextareaKeyDown,
	...rest
}: CouncilInputBarProps) {
	// Band-2 gate (free-tier plan): council (multi-agent) chat is a Pro feature.
	// A team @mention is the entry into council, so gate the two paths that set a
	// team target — the mention-menu pick and the send-time team resolution — and
	// open the upgrade paywall on a blocked attempt (a Pro badge does not fit in a
	// mention dropdown). Never silently downgrade a team send to single-agent.
	const { canUse, requestUpgrade } = useEntitlementContext();
	const [mentionQuery, setMentionQuery] = useState<string | null>(null);
	const [slashQuery, setSlashQuery] = useState<string | null>(null);
	const textareaWrapRef = useRef<HTMLTextAreaElement | null>(null);

	// Grouped "@" candidates for the current fragment (empty when the menu is
	// closed). Recomputed per keystroke; buildMentionGroups is pure + capped.
	const mentionGroups = useMemo(
		() =>
			mentionQuery === null
				? []
				: buildMentionGroups(mentionSources, mentionQuery),
		[mentionQuery, mentionSources]
	);

	const handleChange = useCallback(
		(next: string) => {
			onChange?.(next);
			onTyping?.();
			const query = parseMentionQuery(next);
			setMentionQuery(query);
			if (query === null) {
				onTargetAgentChange(null);
				onTeamChange(null);
			}
			setSlashQuery(parseSlashQuery(next));
		},
		[onChange, onTyping, onTargetAgentChange, onTeamChange]
	);

	const handleSelectSlash = useCallback(
		(command: SlashCommand) => {
			// Insert "/name " and leave the cursor for the argument; the hint is
			// shown as guidance in the popover. Commands with no argument can just
			// be sent as-is. Matches Zed / the @-mention insert convention.
			onChange?.(`/${command.name} `);
			setSlashQuery(null);
		},
		[onChange]
	);

	const handleSelect = useCallback(
		(item: MentionItem) => {
			// Picking a team enters council (multi-agent). Block it behind the Pro
			// gate before inserting the mention or setting the target.
			if (item.kind === "team" && !canUse("council")) {
				setMentionQuery(null);
				requestUpgrade();
				return;
			}
			onChange?.(applyMention(value ?? "", item));
			setMentionQuery(null);
			// Agents/teams set the council target directly from the picked id;
			// spaces/skills/mcp/folders are plain reference tokens and plugins
			// rewrite the composer — none of those set a target.
			if (item.kind === "team") {
				onTeamChange(item.id);
				onTargetAgentChange(null);
			} else if (item.kind === "agent") {
				onTargetAgentChange(item.id);
				onTeamChange(null);
			}
		},
		[value, onChange, onTargetAgentChange, onTeamChange, canUse, requestUpgrade]
	);

	const handleSend = useCallback(
		(msg: { role: "user"; content: string }) => {
			const teamId = resolveFirstTeamMention(msg.content, allTeams);
			// A team mention dispatches a council turn. Gate it behind Pro; block the
			// whole send (rather than silently sending single-agent) so the user
			// understands why nothing happened, then upsell.
			if (teamId && !canUse("council")) {
				setMentionQuery(null);
				setSlashQuery(null);
				requestUpgrade();
				return;
			}
			if (teamId) {
				onTeamChange(teamId);
				onTargetAgentChange(null);
			} else {
				onTeamChange(null);
				onTargetAgentChange(resolveFirstMention(msg.content, allAgents));
			}
			setMentionQuery(null);
			setSlashQuery(null);
			onSend(msg);
		},
		[
			onSend,
			allAgents,
			allTeams,
			onTargetAgentChange,
			onTeamChange,
			canUse,
			requestUpgrade,
		]
	);

	return (
		<div className="relative">
			{mentionQuery !== null && mentionGroups.length > 0 && (
				<MentionMenu
					anchorRef={textareaWrapRef}
					groups={mentionGroups}
					onDismiss={() => setMentionQuery(null)}
					onSelect={handleSelect}
				/>
			)}
			{slashQuery !== null && (
				<SlashCommandAutocomplete
					anchorRef={textareaWrapRef}
					commands={availableCommands}
					onDismiss={() => setSlashQuery(null)}
					onSelect={handleSelectSlash}
					query={slashQuery}
				/>
			)}
			{permission && onRespondPermission && (
				<PermissionPrompt
					onRespond={onRespondPermission}
					permission={permission}
				/>
			)}
			<InputBar
				{...rest}
				onChange={handleChange}
				onSend={handleSend}
				onTextareaKeyDown={(event) => {
					if (handleComposerSettingsShortcut(event, composerSections)) {
						event.preventDefault();
					}
					onTextareaKeyDown?.(event);
				}}
				value={value}
			/>
		</div>
	);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
export default function ChatPage({
	tabConversationId,
	initialPrompt,
	initialSubmit,
	initialImages,
	initialAgent,
	initialProject,
}: {
	tabConversationId?: string;
	/** One-shot composer seeds from a `ryu://chat/new` deep link. The prompt
	 * pre-fills the composer (NEVER auto-sent — it is attacker-controllable);
	 * agent/project pre-select. Consumed once on mount. */
	initialPrompt?: string;
	/** When set (launchpad composer only — a user-initiated send), the seeded
	 * `initialPrompt`/`initialImages` is SENT automatically once chat is ready,
	 * instead of just pre-filling. Never set for the deep-link/Inbox paths, whose
	 * text must stay pre-fill-only. */
	initialSubmit?: boolean;
	/** One-shot image attachments staged on the launchpad composer before a
	 * conversation existed, carried into this fresh tab. Consumed once on mount. */
	initialImages?: AttachedImage[];
	initialAgent?: string;
	initialProject?: string;
} = {}) {
	// Read gateway/core reachability from the shared provider so this page and
	// the shell banner always agree on the same poll tick.
	const {
		coreReachable,
		gatewayReachable,
		loading: statusLoading,
	} = useSystemStatusContext();

	const { folder, setFolder } = useWorkspaceStore();
	const [agentId, setAgentId] = useState<string | null>(
		() => initialAgent ?? localStorage.getItem("ryu_default_agent")
	);
	// Persistent team selection from the composer target picker. When set, every
	// turn fans out to the team's members (Core's `team_id` takes precedence over
	// `agent_id`). Session-only — distinct from the transient `@team` mention ref.
	const [teamId, setTeamId] = useState<string | null>(null);
	const [agentTools, setAgentTools] = useState<string[]>([]);

	// One-shot seed from a `ryu://chat/new` deep link: pre-fill the composer and
	// pre-select the project folder. The agent is seeded above via initial state.
	// The prompt is NEVER auto-sent — only placed in the composer for review.
	const deepLinkSeeded = useRef(false);
	useEffect(() => {
		if (deepLinkSeeded.current) {
			return;
		}
		deepLinkSeeded.current = true;
		if (initialProject) {
			setFolder(initialProject).catch(() => {
				/* invalid path — leave the project unset */
			});
		}
	}, [initialProject, setFolder]);

	// Workspace panel open/close state (bottom + right panels)
	const [bottomPanelOpen, setBottomPanelOpen] = useState(false);
	const [rightPanelOpen, setRightPanelOpen] = useState(false);
	// User's intent for the floating "Pinned summary" card (project ▸ branch ▸
	// worktree + git changes + commit&push). This is only the preference; the
	// card also auto-hides while the right panel is open (see pinnedSummaryVisible
	// below) and auto-reopens when it closes — unless the user hid it here.
	const [pinnedSummaryOpen, setPinnedSummaryOpen] = useState(true);
	// The floating pinned-summary card overlaps the message column, so it
	// dismisses on a press-away (the titlebar toggle brings it back). Stable so
	// the panel's outside-press listener isn't re-bound each render.
	const dismissPinnedSummary = useCallback(
		() => setPinnedSummaryOpen(false),
		[]
	);

	// Per-agent model selection for the composer model picker. Recomputed when
	// the active agent changes; the chosen id is persisted per agent and sent in
	// the chat body. The ref keeps the transport closure reading the live value.
	const [selectedModel, setSelectedModel] = useState<string | null>(() =>
		getAgentModel(localStorage.getItem("ryu_default_agent"))
	);
	const selectedModelRef = useRef(selectedModel);

	// Image attachments — managed here so handleSend can include them in the
	// AI SDK message and clear them after send. Seeded once from `initialImages`
	// when this tab was opened from the launchpad composer (files staged before a
	// conversation existed), so they aren't lost across the launcher → chat handoff.
	const [attachedImages, setAttachedImages] = useState<
		{
			id: string;
			filename: string;
			url: string;
			mimeType: string;
			size?: number;
		}[]
	>(
		() =>
			initialImages?.map((img) => ({
				id: img.id,
				filename: img.filename,
				url: img.url,
				mimeType: img.mimeType ?? "image/png",
				size: img.size,
			})) ?? []
	);
	const [isDragOver, setIsDragOver] = useState(false);
	const attachmentRef = useRef({ attachedImages, isDragOver });
	attachmentRef.current = { attachedImages, isDragOver };

	// #415: target_agent_id for council @mentions — written by CouncilInputBar on
	// each send and consumed by the transport body closure below.
	const targetAgentIdRef = useRef<string | null>(null);

	// team_id for @team mentions — when set, Core fans the message out to the
	// team's members per its coordination strategy (takes precedence over
	// agent_id/target_agent_id). Reset after each send.
	const teamIdRef = useRef<string | null>(null);

	// Mirror of the persistent team selection for the send-time body closure
	// (assigned every render, like selectedModelRef). The transient `@team`
	// mention in teamIdRef wins for one send, then falls back to this.
	const composerTeamIdRef = useRef<string | null>(null);
	composerTeamIdRef.current = teamId;

	// #415: Current participants list for labelling assistant messages per-agent.
	const [participants, setParticipants] = useState<ConversationParticipant[]>(
		[]
	);

	// #415: Maps assistant-message index (string) to an agent display name for labels.
	const agentLabelMapRef = useRef<Record<string, string>>({});

	// Load agents to inspect the selected agent's transport type.
	const { agents } = useAgents();
	// Load teams so @team mentions resolve in the composer autocomplete.
	const { teams } = useTeams();
	// Extra "@" mention sources: spaces, installed skills, MCP servers, and
	// recent project folders. Composer plugins (goal/proof/double-check) come
	// from the client-side registry. See docs/rfc-mention-composer.md.
	const { spaces } = useSpaces();
	const { installedSkills } = useSkillsCatalog();
	const { servers: mcpServers } = useMcp();
	const recentFolders = useWorkspaceStore((s) => s.recentFolders);
	// Core-owned per-engine model catalog (offline fallback lives in models.ts).
	const engineModels = useEngineModels();

	// #402: Derive transport-aware gating flags.
	// Core down = all chat off regardless of agent.
	// Gateway required only when the selected agent uses openai-compat transport.
	const acpAgent = isAcpAgent(agentId, agents);
	const chatDisabled = statusLoading ? false : !coreReachable;
	const gatewayRequiredForAgent = !(acpAgent || gatewayReachable);

	// The reason a blocked composer is disabled is surfaced in the sidebar
	// Announcements section (see useSystemAnnouncements) rather than as an
	// inline overlay banner, so the composer just quietly disables here.

	const composerBlocked = chatDisabled || gatewayRequiredForAgent;

	// Long-term (cross-session) memory is opt-in per the privacy-by-default
	// principle. Persisted locally so the choice survives restarts.
	const [longTermMemory] = useState<boolean>(
		() => localStorage.getItem("ryu_long_term_memory") === "true"
	);

	// Remember the last picked agent so a new chat opens with it preselected. The
	// agent itself is owned by Core (CRUD via U6); this is only the local "last
	// used" hint, not agent storage.
	const { openTab } = useTabsContext();

	// Model options follow the active agent's engine binding. The effective
	// value prefers the explicit in-session pick, then the persisted per-agent
	// choice, then the engine's first option — so the picker always shows what
	// will actually be sent.
	const modelOptions = useMemo(
		() => modelsForAgent(agentId, agents, engineModels),
		[agentId, agents, engineModels]
	);
	const effectiveModel =
		[selectedModel, getAgentModel(agentId)].find(
			(id) => id && modelOptions.some((m) => m.id === id)
		) ??
		modelOptions[0]?.id ??
		null;
	selectedModelRef.current = effectiveModel;

	// The empty-state logo reflects the active target: a team fans out its
	// members' engine logos; any single agent (Ryu included) shows its own mark.
	const emptyStateLogo = useMemo<EmptyStateLogo>(() => {
		if (teamId) {
			const team = teams.find((t) => t.id === teamId);
			const engines = (team?.members ?? []).map((id) => {
				const member = agents.find((a) => a.id === id);
				return member ? engineForAgent(member) : null;
			});
			if (engines.length > 0) {
				return { kind: "stack", engines };
			}
		}
		const agent = agents.find((a) => a.id === agentId);
		if (agent?.avatarUrl) {
			return { kind: "image", url: agent.avatarUrl };
		}
		return { kind: "single", engine: agent ? engineForAgent(agent) : null };
	}, [agentId, teamId, agents, teams]);

	// Avatar + name shown beside each assistant turn in the transcript. A single
	// agent shows its engine logo in a circular avatar; a team shows its name
	// (the fanned member avatars are wired separately). Mirrors emptyStateLogo.
	const assistantIdentity = useMemo<{
		avatar?: React.ReactNode;
		name?: string;
	}>(() => {
		if (teamId) {
			const team = teams.find((t) => t.id === teamId);
			return { name: team?.name };
		}
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) {
			return {};
		}
		return {
			name: agent.name,
			avatar: (
				<Avatar
					className="flex items-center justify-center after:hidden"
					size="sm"
				>
					{agent.avatarUrl ? (
						// biome-ignore lint/performance/noImgElement: Tauri/Vite app, no next/image; avatar is an inline data URL
						// biome-ignore lint/correctness/useImageSize: sized via the `size-full` class
						<img
							alt={agent.name}
							className="size-full rounded-full object-cover"
							src={agent.avatarUrl}
						/>
					) : (
						<AgentLogo engine={engineForAgent(agent)} size="16px" />
					)}
				</Avatar>
			),
		};
	}, [agentId, teamId, agents, teams]);

	const handleModelChange = useCallback(
		(modelId: string) => {
			setSelectedModel(modelId);
			if (agentId) {
				setAgentModel(agentId, modelId);
			}
		},
		[agentId]
	);

	// ── ACP session controls (Zed-style, data-driven per active agent) ──
	// The agent's advertised Model + Thinking/approval + config selectors, plus the
	// effective per-turn selections, come from the ONE shared hook the launchpad and
	// Ask Ryu dock also use — so every composer's dropdown is identical (and shows
	// them even before a chat exists). Selections persist per agent and ride each
	// turn's request body; Core re-applies them via set_mode / set_config_option /
	// set_model. `modelSection`/`extraSections` feed the composer's settings menu.
	// An agent-INITIATED permission-mode switch seen on the live stream (Core's
	// `data-ryu-acp-mode` part). Derived from `messages` further below and fed
	// back into the composer hook so the Approval picker reflects a mode the
	// agent changed on its own — not only the user's clicks.
	const [streamedAcpMode, setStreamedAcpMode] = useState<string | null>(null);

	const acp = useComposerAcpSections({
		agentId,
		agents,
		modelOptions,
		engineModel: effectiveModel,
		onEngineModelChange: handleModelChange,
		streamedMode: streamedAcpMode,
	});

	// Effective ACP selections for the request body, held in refs so the send path
	// reads current values without re-identifying the memoized composer slot. The
	// hook already nulls acp_mode when a category:"mode" config option owns it.
	const acpModeRef = useRef(acp.acpMode);
	acpModeRef.current = acp.acpMode;
	const acpModelRef = useRef(acp.acpModel);
	acpModelRef.current = acp.acpModel;
	const acpOptionValuesRef = useRef(acp.acpOptionValues);
	acpOptionValuesRef.current = acp.acpOptionValues;

	// Fetch tool names for the selected agent so we can render tool chips below
	// the composer. Uses the lightweight full-record fetch (tools[] is not on the
	// summary). Clears on deselect and re-fetches when the agent changes.
	const activeNodeForTools = useActiveNode();
	useEffect(() => {
		if (!agentId) {
			setAgentTools([]);
			return;
		}
		let cancelled = false;
		const toolTarget: ApiTarget = {
			url: activeNodeForTools.url,
			token: activeNodeForTools.token ?? null,
		};
		fetchAgent(toolTarget, agentId)
			.then((agent) => {
				if (!cancelled) {
					setAgentTools(agent.tools ?? []);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setAgentTools([]);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [agentId, activeNodeForTools.url, activeNodeForTools.token]);

	const {
		activeConversationId,
		setActiveConversationId,
		createConversation,
		getConversation,
		loadMessages,
		forkConversation,
		editMessage,
		regenerateMessage,
		selectVersion,
		refresh,
	} = useChatHistoryContext();

	// Version-tree state (ChatGPT/Claude edit + regenerate branching), keyed by
	// message id: how many versions exist at this branch point, which is active,
	// and the ordered sibling ids the pager steps through. Populated from Core's
	// active-path read on every (re)hydration; empty for never-branched threads.
	const [versions, setVersions] = useState<
		Record<string, { index: number; count: number; ids: string[] }>
	>({});
	// Persisted thumbs 👍/👎 for the active conversation, keyed by assistant
	// message id. Loaded when the conversation switches; updated optimistically on
	// a vote (reverted if the server rejects it).
	const [feedback, setFeedback] = useState<Record<string, "up" | "down">>({});
	// One-shot flag consumed by the chat-stream body: when a regenerate()/edit
	// re-run streams, Core must NOT re-append the trailing user turn (it is
	// already persisted). Set immediately before regenerate(), reset on read.
	const skipNextUserAppendRef = useRef(false);

	// This tab's OWN conversation id, independent of the shared focused-tab
	// `activeConversationId`. Every chat tab stays mounted at once (Layout), and
	// AI SDK's `useChat({ id })` shares ONE Chat instance across all hooks that
	// pass the same id — so keying every mounted tab off the single global id
	// made a newly-opened conversation collide with an already-mounted tab and
	// render empty (the new mount's blank initial state clobbered the loaded
	// history). Keying each tab off its own id keeps the threads independent.
	const [convId, setConvId] = useState<string | null>(
		tabConversationId ?? null
	);

	// Mirror THIS tab's conversation into the shared context whenever it is the
	// focused tab, so the sidebar highlight + goal/fork/double-check target the
	// conversation the user is actually looking at. Tab *content* is driven by
	// the local `convId`, not this shared mirror, so background tabs never fight
	// over it (e.g. tab-strip switching shows each tab's own thread).
	const isActiveTab = useIsActiveTab();
	const isActiveTabRef = useRef(isActiveTab);
	isActiveTabRef.current = isActiveTab;
	useEffect(() => {
		if (isActiveTab) {
			setActiveConversationId(convId);
		}
	}, [isActiveTab, convId, setActiveConversationId]);

	const activeNode = useActiveNode();
	const chatTarget: ApiTarget = useMemo(
		() => ({ url: activeNode.url, token: activeNode.token ?? null }),
		[activeNode.url, activeNode.token]
	);

	// Ryu Apps widget host (U7). The desktop is the TRUSTED side: it holds the Core
	// token and performs the Gateway-governed round-trips on a widget's behalf. The
	// context value carries the WidgetRenderer slot (AppWidget) + node-scoped
	// services; `@ryu/blocks`'s tool-renderer reads it to mount a widget for a
	// `data-tool-widget-available` part. Gated behind PLUGIN_RUNTIME_FLAG: when OFF
	// the value is null, so the tool row degrades to a plain tool output.
	const { enabled: widgetRuntimeEnabled } =
		useExperimentalFlag(PLUGIN_RUNTIME_FLAG);
	const widgetHostValue = useMemo<WidgetHostValue | null>(() => {
		if (!shouldRenderWidget(widgetRuntimeEnabled)) {
			return null;
		}
		const services: WidgetHostServices = {
			callTool: (input) => widgetCallTool(chatTarget, input),
			sendFollowUpMessage: (input) => widgetFollowUp(chatTarget, input),
			setWidgetState: (input) => widgetSetState(chatTarget, input),
		};
		return { Renderer: AppWidget, services };
	}, [widgetRuntimeEnabled, chatTarget]);

	// Voice input: a stable transcribe fn (reads the live node target via a ref)
	// passed into the composer's mic button. Stable identity keeps the memoized
	// InputBar slot from remounting and dropping textarea focus.
	const chatTargetRef = useRef(chatTarget);
	chatTargetRef.current = chatTarget;
	const composerBlockedRef = useRef(false);
	composerBlockedRef.current = composerBlocked;

	// Active model's context window (tokens), used as the denominator for the
	// per-message context-usage ring in each assistant turn's stats footer.
	// Resolved from the model's launch config; `undefined` (auto / unknown) ⇒
	// no ring, mirroring Jan's "hide when n_ctx unknown". Keyed on the primitive
	// model id (not the `chatTarget` object) to avoid a deps-driven render loop.
	const [contextSize, setContextSize] = useState<number | undefined>(undefined);
	useEffect(() => {
		if (!effectiveModel) {
			setContextSize(undefined);
			return;
		}
		let cancelled = false;
		(async () => {
			const target = chatTargetRef.current;
			const cfg = await getModelLaunchConfig(target, effectiveModel);
			if (cancelled) {
				return;
			}
			if (cfg.ctx_size && cfg.ctx_size > 0) {
				setContextSize(cfg.ctx_size);
				return;
			}
			// ACP / cloud models: local launch config has no ctx_size — resolve
			// from models.dev so the composer's context ring has a denominator.
			const fromCatalog = await getModelContextWindow(target, effectiveModel);
			if (!cancelled) {
				setContextSize(
					fromCatalog && fromCatalog > 0 ? fromCatalog : undefined
				);
			}
		})().catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [effectiveModel]);
	const voiceTranscribe = useCallback(
		(audio: Blob) => transcribeAudio(chatTargetRef.current, audio),
		[]
	);

	// #415: Load the conversation's participants so assistant messages can still be
	// labelled per-agent. (The in-composer "add agent" control was removed in favour
	// of agent teams, but legacy multi-agent conversations keep their attribution.)
	useEffect(() => {
		if (!convId) {
			setParticipants([]);
			return;
		}
		let cancelled = false;
		fetchParticipants(chatTarget, convId).then((list) => {
			if (!cancelled) {
				setParticipants(list);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [convId, chatTarget]);

	// Keep the latest opt-in value reachable from the transport body closure,
	// which is created once and would otherwise capture a stale value.
	const longTermMemoryRef = useRef(longTermMemory);
	useEffect(() => {
		longTermMemoryRef.current = longTermMemory;
		localStorage.setItem("ryu_long_term_memory", String(longTermMemory));
	}, [longTermMemory]);

	// Stable draft ID so useChat keeps the same id on first send (state update is async)
	const draftConvId = useRef(`conv-${Date.now()}`);
	const chatId = convId ?? draftConvId.current;
	// Latest convId reachable from the once-created transport body closure below.
	const convIdRef = useRef<string | null>(convId);
	convIdRef.current = convId;

	// Tracks which requested tool calls the user has acted on, so the approval
	// footer in chat is shown once per pending tool and dismissed after a
	// decision. Core auto-runs the call, so approving just dismisses the prompt;
	// rejecting stops the in-flight stream.
	const [toolDecisions, setToolDecisions] = useState<
		Record<string, "approved" | "rejected">
	>({});

	// #403: Tracks user messages that were blocked so they still appear in the
	// thread even when the send is prevented.
	const [blockedMessages, setBlockedMessages] = useState<
		Array<{ id: string; content: string; timestamp: number }>
	>([]);

	// ── Goal + Double-check are now plugins (io.ryu.goal / io.ryu.double-check) ──
	// driven by the Core plugin turn-hook runtime. The goal loop runs server-side
	// (type `/goal <condition>` in chat; the plugin parses + pursues it), and the
	// double-check review streams back as a `data-plugin_note` part. The desktop
	// carries no plugin-specific composer state: double-check is a plain composer
	// control contributed by its plugin manifest, so it flows through the generic
	// `pluginFlags` map below like every other composer toggle.

	// Generic plugin composer toggles (`composer_controls`): a flag→on map keyed by
	// each control's `flag`. Held in state (drives the toggle's rendered `enabled`)
	// plus a ref the once-created transport body closure reads when merging the
	// per-request `plugin_flags` — same pattern as the double-check flag above.
	const [pluginFlags, setPluginFlags] = useState<Record<string, boolean>>({});
	const pluginFlagsRef = useRef<Record<string, boolean>>({});
	pluginFlagsRef.current = pluginFlags;

	// Ghost (temporary) chat: when on, every turn is sent with `persist: false` so
	// Core writes nothing to the conversation store, and a new ghost chat is never
	// registered in the sidebar history — it lives only in this tab's memory and is
	// gone on close or when a fresh chat starts. Ryu's incognito thread. A ref
	// mirrors the toggle so the once-created transport body closure reads the live
	// value (same pattern as the double-check flag above).
	const [ghostMode, setGhostMode] = useState(false);
	const ghostModeRef = useRef(false);
	ghostModeRef.current = ghostMode;

	// Plugin notes (e.g. the double-check review) arrive as `data-plugin_note`
	// stream parts; dismissed ids are tracked so a note clears once acknowledged.
	const [dismissedPluginNotes, setDismissedPluginNotes] = useState<Set<string>>(
		() => new Set()
	);

	const {
		messages,
		sendMessage,
		setMessages,
		regenerate,
		stop,
		status,
		error,
	} = useChat({
		id: chatId,
		transport: new DefaultChatTransport({
			api: chatStreamUrl(chatTarget),
			// Forward the user-identity JWT alongside the node token so Core can
			// verify WHO sent this turn and stamp `author_user_id` on the persisted
			// message — the value the realtime fan-out uses to attribute it to a
			// human for other viewers. `null` when signed out: no header, anonymous
			// turn (author stays NULL), single-user flow unchanged.
			headers: async (): Promise<Record<string, string>> => {
				const base = chatHeaders(chatTarget);
				const jwt = await getRealtimeJwt();
				return jwt ? { ...base, "X-Ryu-User-Jwt": jwt } : base;
			},
			body: () => {
				const ws = useWorkspaceStore.getState();
				const cwd = ws.folder ?? undefined;
				// Consume the one-shot skip flag: read then immediately reset so it
				// applies to exactly this request (the edit/regenerate re-run) and no
				// subsequent normal send.
				const skipUserAppend = skipNextUserAppendRef.current;
				skipNextUserAppendRef.current = false;
				// Persistent-session worktree: opt-in via the workspace bar's run
				// mode (not auto-on per folder). When enabled, Core creates an
				// isolated worktree on the first message and reuses it across turns,
				// capturing the aggregate diff (fetched by DiffReviewPane).
				const useWorktree = Boolean(cwd) && ws.worktreeMode;
				return {
					agent_id: agentId,
					conversation_id: convIdRef.current ?? draftConvId.current,
					// A ghost (temporary) chat must leave no durable trace, so it never
					// records the turn into long-term cross-session memory — regardless of
					// the user's standing long-term-memory preference.
					enable_long_term: ghostModeRef.current
						? false
						: longTermMemoryRef.current,
					cwd,
					worktree_isolation: useWorktree,
					// Desired branch for the worktree Core creates on the first turn
					// (sanitized server-side; ignored when reusing an existing one).
					worktree_branch: useWorktree ? ws.worktreeBranch : undefined,
					// #415: Pass the @mention target agent id when the user directed the
					// message at a specific conversation participant.
					target_agent_id: targetAgentIdRef.current ?? undefined,
					// When the user @-mentioned a team, Core fans out to its members.
					// The transient mention wins for one send; otherwise the persistent
					// composer team pick applies.
					team_id: teamIdRef.current ?? composerTeamIdRef.current ?? undefined,
					// Composer model picker selection (per-agent). Core routes honour it
					// where the transport supports a model override; otherwise ignored.
					model: selectedModelRef.current ?? undefined,
					// ACP session controls (agent-reported). Re-applied to this turn's
					// ACP session by Core; ignored by non-ACP routes.
					acp_mode: acpModeRef.current ?? undefined,
					acp_config:
						acpOptionValuesRef.current &&
						Object.keys(acpOptionValuesRef.current).length > 0
							? acpOptionValuesRef.current
							: undefined,
					acp_model: acpModelRef.current ?? undefined,
					// Per-request plugin flags (every plugin-contributed composer toggle,
					// double-check included). The plugin turn-hook runtime passes these to
					// each hook; a plugin acts only when its flag is set.
					plugin_flags: buildPluginFlags(pluginFlagsRef.current),
					// Ghost (temporary) chat: never write this turn to the conversation
					// store. Omitted otherwise so Core applies its default (persist=true).
					persist: ghostModeRef.current ? false : undefined,
					// Version-tree edit/regenerate re-run: the edited user sibling is
					// already persisted (edit route) or a regenerate carries no new user
					// turn, so Core must not re-append the trailing user message. The ref
					// is set true just before the regenerate() trigger and consumed here.
					skip_user_append: skipUserAppend || undefined,
				};
			},
		}),
	});

	// Per-message send time (ms), keyed by message id. Persisted history seeds this
	// with Core's server-stamped `created_at`; live turns (which arrive over the SSE
	// stream without a timestamp) get a client stamp the first time they're seen.
	// Kept out of useChat's own message state so nothing extra is POSTed back to Core
	// on the next turn — `processedMessages` reads from here to render the toolbar.
	const messageSentAtRef = useRef<Map<string, number>>(new Map());

	// Multimodal: generate an image from the composer text and surface it inline as
	// an assistant message. The result is client-only — Core's /api/images/generate
	// is one-shot and isn't written to the conversation store, so the image is not
	// re-hydrated on reload (loadMessages rebuilds history as text-only parts).
	const handleGenerateImage = useCallback(
		async (prompt: string) => {
			const userId = `img-user-${Date.now()}`;
			const assistantId = `img-${Date.now()}`;
			// Echo the prompt as a user bubble so the turn reads naturally.
			setMessages((prev) => [
				...prev,
				{
					id: userId,
					role: "user",
					parts: [{ type: "text", text: prompt }],
				} as (typeof prev)[number],
			]);
			try {
				const urls = await generateImage(chatTargetRef.current, prompt);
				const parts =
					urls.length > 0
						? urls.map((url) => ({
								type: "file" as const,
								mediaType: "image/png",
								url,
							}))
						: [
								{
									type: "error" as const,
									title: "Image generation failed",
									message: "The image engine returned no image.",
								},
							];
				setMessages((prev) => [
					...prev,
					{
						id: assistantId,
						role: "assistant",
						parts,
					} as unknown as (typeof prev)[number],
				]);
			} catch (e) {
				setMessages((prev) => [
					...prev,
					{
						id: assistantId,
						role: "assistant",
						parts: [
							{
								type: "error" as const,
								title: "Image generation failed",
								message:
									e instanceof Error ? e.message : "Could not generate image.",
							},
						],
					} as unknown as (typeof prev)[number],
				]);
			}
		},
		[setMessages]
	);

	// Multimodal: generate a video from the composer text, surfaced inline like the
	// image path. Client-only (not persisted). The sdcpp vid_gen response shape is
	// best-effort (see lib/api/video.ts) — an empty result renders a clear notice.
	const handleGenerateVideo = useCallback(
		async (prompt: string) => {
			const userId = `vid-user-${Date.now()}`;
			const assistantId = `vid-${Date.now()}`;
			setMessages((prev) => [
				...prev,
				{
					id: userId,
					role: "user",
					parts: [{ type: "text", text: prompt }],
				} as (typeof prev)[number],
			]);
			try {
				const clips = await generateVideo(chatTargetRef.current, prompt);
				const parts =
					clips.length > 0
						? clips.map((clip) => ({
								type: "file" as const,
								mediaType: clip.mediaType,
								url: clip.url,
							}))
						: [
								{
									type: "error" as const,
									title: "Video generation",
									message:
										"The engine returned no video. Load a video model (Wan/LTX) in the sdcpp engine and try again.",
								},
							];
				setMessages((prev) => [
					...prev,
					{
						id: assistantId,
						role: "assistant",
						parts,
					} as unknown as (typeof prev)[number],
				]);
			} catch (e) {
				setMessages((prev) => [
					...prev,
					{
						id: assistantId,
						role: "assistant",
						parts: [
							{
								type: "error" as const,
								title: "Video generation failed",
								message:
									e instanceof Error ? e.message : "Could not generate video.",
							},
						],
					} as unknown as (typeof prev)[number],
				]);
			}
		},
		[setMessages]
	);

	// Speak an assistant reply aloud via Core's /api/voice/speak, honouring the
	// Voice-tab TTS engine/voice (localStorage). Playback uses a plain
	// HTMLAudioElement; the URL is revoked on end to free the blob.
	const speakingAudioRef = useRef<HTMLAudioElement | null>(null);
	// The text of the turn currently playing, so a second click on the SAME turn
	// stops it (toggle) rather than restarting — `audio.play()` resolves at playback
	// start, so SpeakButton re-enables mid-playback and the second click lands here.
	const speakingTextRef = useRef<string | null>(null);
	const handleSpeak = useCallback(async (text: string) => {
		const trimmed = text.trim();
		if (!trimmed) {
			return;
		}
		// Stop any in-flight playback so a second click doesn't overlap; if it was the
		// same turn, this is a toggle-off — return without starting a new synthesis.
		if (speakingAudioRef.current) {
			const wasSameTurn = speakingTextRef.current === trimmed;
			speakingAudioRef.current.pause();
			speakingAudioRef.current = null;
			speakingTextRef.current = null;
			if (wasSameTurn) {
				return;
			}
		}
		const prefs = getDesktopTtsPrefs();
		const blob = await speakText(chatTargetRef.current, trimmed, {
			engine: prefs.engine,
			voice: prefs.voice || undefined,
		});
		const url = URL.createObjectURL(blob);
		const audio = new Audio(url);
		speakingAudioRef.current = audio;
		speakingTextRef.current = trimmed;
		audio.addEventListener("ended", () => {
			URL.revokeObjectURL(url);
			if (speakingAudioRef.current === audio) {
				speakingAudioRef.current = null;
				speakingTextRef.current = null;
			}
		});
		await audio.play();
	}, []);
	const handleSpeakRef = useRef(handleSpeak);
	handleSpeakRef.current = handleSpeak;
	const desktopTts = getDesktopTtsPrefs();
	// ChatGPT-style continuous voice mode (its own separate entry point — the
	// composer mic above stays as push-to-talk voice INPUT). All realtime logic
	// (VAD, endpointing, barge-in) lives in Core; this reflects it into the overlay.
	const voiceMode = useVoiceMode(chatTarget, {
		conversationId: activeConversationId ?? undefined,
		ttsEngine: desktopTts.engine,
		ttsVoice: desktopTts.voice || undefined,
	});

	// Interactive ACP tool-permission prompts. When an agent in a gating mode
	// asks to run a tool, Core streams a `data-ryu-permission` part; we surface
	// the latest unresolved one above the composer and POST the user's choice
	// back (`/api/chat/permission`) to unblock the awaiting turn. Resolved request
	// ids are tracked so the prompt clears once answered.
	const [resolvedPermissions, setResolvedPermissions] = useState<Set<string>>(
		() => new Set()
	);
	const activePermission = useMemo<ActivePermission | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "assistant" || !m.parts) {
				continue;
			}
			for (let j = m.parts.length - 1; j >= 0; j--) {
				const part = m.parts[j] as { type?: string; data?: unknown };
				if (part?.type !== "data-ryu-permission") {
					continue;
				}
				const data = part.data as ActivePermission | undefined;
				if (data?.requestId && !resolvedPermissions.has(data.requestId)) {
					return data;
				}
			}
		}
		return null;
	}, [messages, resolvedPermissions]);

	// Slash commands contributed by enabled Core plugins (e.g. `/proof` from the
	// proof-of-work turn-hook plugin). Core tags each with its owning `plugin` id
	// and returns the full `command` text (leading "/"); the popover works off the
	// bare name, so strip it. These are plain messages at submit time — Core's
	// turn-hook interprets them — so nothing client-side handles them here.
	const pluginContributions = usePluginContributions();
	const pluginSlashCommands = useMemo<SlashCommand[]>(() => {
		const out: SlashCommand[] = [];
		for (const entry of pluginContributions.slash_commands) {
			const rec = entry as {
				command?: unknown;
				description?: unknown;
			};
			if (typeof rec.command !== "string") {
				continue;
			}
			const name = rec.command.replace(/^\//, "").trim();
			if (!name) {
				continue;
			}
			out.push({
				name,
				description: typeof rec.description === "string" ? rec.description : "",
				hint: null,
				source: "plugin",
			});
		}
		return out;
	}, [pluginContributions.slash_commands]);

	// Slash commands the active agent advertised over ACP. Core streams the full
	// list (each update replaces the last) as a `data-ryu-acp-commands` part; we
	// take the most recent one across the thread. Combined with Ryu's own local
	// commands and enabled plugins' contributed commands to drive the composer's
	// "/" popover. Plugin commands are deduped by name against ACP + local ones,
	// which win.
	const composerCommands = useMemo<SlashCommand[]>(() => {
		const withPlugins = (base: SlashCommand[]): SlashCommand[] => {
			const seen = new Set(base.map((c) => c.name));
			const extra = pluginSlashCommands.filter((c) => !seen.has(c.name));
			return [...base, ...extra];
		};
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "assistant" || !m.parts) {
				continue;
			}
			for (let j = m.parts.length - 1; j >= 0; j--) {
				const part = m.parts[j] as { type?: string; data?: unknown };
				if (part?.type !== "data-ryu-acp-commands") {
					continue;
				}
				const data = part.data as
					| {
							commands?: {
								name: string;
								description?: string;
								hint?: string;
							}[];
					  }
					| undefined;
				if (!data?.commands) {
					continue;
				}
				const agentCommands: SlashCommand[] = data.commands.map((c) => ({
					name: c.name,
					description: c.description ?? "",
					hint: c.hint ?? null,
					source: "agent",
				}));
				return withPlugins([...agentCommands, ...LOCAL_SLASH_COMMANDS]);
			}
		}
		return withPlugins(LOCAL_SLASH_COMMANDS);
	}, [messages, pluginSlashCommands]);

	// Agent-initiated Session Mode changes. Core streams the new active mode as a
	// `data-ryu-acp-mode` part (`{ currentModeId }`); we take the most recent one
	// and push it into ChatPage's `streamedAcpMode` state, which the composer hook
	// adopts as the Approval picker's selection (and persists for the agent).
	const latestStreamedAcpMode = useMemo<string | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "assistant" || !m.parts) {
				continue;
			}
			for (let j = m.parts.length - 1; j >= 0; j--) {
				const part = m.parts[j] as { type?: string; data?: unknown };
				if (part?.type !== "data-ryu-acp-mode") {
					continue;
				}
				const data = part.data as { currentModeId?: string } | undefined;
				const modeId = data?.currentModeId?.trim();
				if (modeId) {
					return modeId;
				}
			}
		}
		return null;
	}, [messages]);
	useEffect(() => {
		if (latestStreamedAcpMode) {
			setStreamedAcpMode(latestStreamedAcpMode);
		}
	}, [latestStreamedAcpMode]);

	// Non-fatal config warnings. Core streams `data-ryu-acp-config-warning` when a
	// session control the user chose (e.g. a model pick) was not accepted by the
	// agent. Surface the newest unseen one as a transient toast so the user isn't
	// silently misled. A ref tracks the last shown warning so re-renders don't
	// re-toast the same one.
	const lastConfigWarningRef = useRef<string | null>(null);
	const latestConfigWarning = useMemo<{
		key: string;
		message: string;
	} | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "assistant" || !m.parts) {
				continue;
			}
			for (let j = m.parts.length - 1; j >= 0; j--) {
				const part = m.parts[j] as { type?: string; data?: unknown };
				if (part?.type !== "data-ryu-acp-config-warning") {
					continue;
				}
				const data = part.data as
					| { field?: string; message?: string; requested?: string }
					| undefined;
				const message = data?.message?.trim();
				if (message) {
					return { key: `${m.id}:${j}`, message };
				}
			}
		}
		return null;
	}, [messages]);
	useEffect(() => {
		if (
			latestConfigWarning &&
			latestConfigWarning.key !== lastConfigWarningRef.current
		) {
			lastConfigWarningRef.current = latestConfigWarning.key;
			toast.warning({
				title: "Agent didn't apply a setting",
				description: latestConfigWarning.message,
			});
		}
	}, [latestConfigWarning]);

	// The latest plugin note (e.g. the double-check review) streamed as a
	// `data-plugin_note` part and not yet dismissed. Surfaced in a dismissible
	// banner above the composer; it never enters chat history.
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
	const activePluginNote = useMemo<{ id: string; text: string } | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "assistant" || !m.parts) {
				continue;
			}
			for (let j = m.parts.length - 1; j >= 0; j--) {
				const part = m.parts[j] as { type?: string; data?: unknown };
				if (part?.type !== "data-plugin_note") {
					continue;
				}
				const data = part.data as { text?: string } | undefined;
				const text = data?.text?.trim();
				if (!text) {
					continue;
				}
				const id = `${m.id}:${j}`;
				if (dismissedPluginNotes.has(id)) {
					return null;
				}
				return { id, text };
			}
		}
		return null;
	}, [messages, dismissedPluginNotes]);

	const handleRespondPermission = useCallback(
		(optionId: string | null) => {
			const requestId = activePermission?.requestId;
			if (!requestId) {
				return;
			}
			setResolvedPermissions((prev) => {
				const next = new Set(prev);
				next.add(requestId);
				return next;
			});
			respondPermission(chatTargetRef.current, requestId, optionId).catch(
				() => {
					// Optimistically cleared already; a failed POST just means the
					// request had already timed out/resolved server-side.
				}
			);
		},
		[activePermission]
	);

	const permissionRef = useRef<{
		permission: ActivePermission | null;
		onRespond: (optionId: string | null) => void;
	}>({ permission: null, onRespond: handleRespondPermission });
	permissionRef.current = {
		permission: activePermission,
		onRespond: handleRespondPermission,
	};

	// Slash-command list held in a ref so the memoized InputBar slot stays stable
	// (same pattern as permission/agents above — avoids textarea focus loss).
	const commandsRef = useRef<SlashCommand[]>(composerCommands);
	commandsRef.current = composerCommands;

	// Hydrate the visible thread from Core's server-side store when switching
	// conversations, so history survives restarts and is shared across clients.
	// Switching `activeConversationId` changes `chatId`, which makes useChat
	// recreate its Chat with an empty message list (a fresh new/deleted/selected
	// thread starts blank). We then overlay any persisted history on top.
	//
	// The `history.length === 0` early-return is load-bearing: this effect also
	// fires during the first send (handleSend sets activeConversationId *before*
	// the message is persisted), when Core has nothing yet. Calling setMessages([])
	// on that empty result would wipe the just-sent user message and the streaming
	// reply, so we must leave useChat's own state untouched when there is no
	// server-side history.
	useEffect(() => {
		if (!convId) {
			return;
		}
		let cancelled = false;
		loadMessages(convId).then((history) => {
			if (cancelled || history.length === 0) {
				return;
			}
			const now = Date.now();
			// Seed the send-time map with each persisted message's server timestamp so
			// the toolbar can render "when it was sent" on reload. Live turns fall back
			// to a client stamp in `processedMessages`.
			for (const h of history) {
				if (typeof h.timestamp === "number") {
					messageSentAtRef.current.set(h.id, h.timestamp);
				}
			}
			setVersions(buildVersions(history));
			setMessages(
				history.map((m) => {
					// #404: Mark stale assistant messages that were left in a "running"
					// state from a previous session as interrupted. We detect this by
					// checking whether the message has no content (or only whitespace)
					// and was last stamped more than STALE_THRESHOLD_MS ago. The history
					// item's `timestamp` carries the server-stamped send time (ms).
					const stampedAt = m.timestamp;
					const msSinceUpdate =
						typeof stampedAt === "number"
							? now - stampedAt
							: Number.POSITIVE_INFINITY;
					// A message that carries structured parts is a real completed turn,
					// so it is never "stale running" — prefer its parts verbatim.
					const hasParts = Array.isArray(m.parts) && m.parts.length > 0;
					const isStaleRunning =
						m.role === "assistant" &&
						!hasParts &&
						(!m.content || m.content.trim() === "") &&
						msSinceUpdate > STALE_THRESHOLD_MS;

					if (hasParts) {
						return { id: m.id, role: m.role, parts: m.parts };
					}

					return {
						id: m.id,
						role: m.role,
						parts: [
							{
								type: "text" as const,
								text: isStaleRunning ? "⚠️ Interrupted" : m.content,
							},
						],
						// Attach a metadata flag so the render pass can style interrupted
						// messages differently (currently handled via the text above).
						...(isStaleRunning ? { _interrupted: true } : {}),
					};
				})
			);
		});
		return () => {
			cancelled = true;
		};
	}, [convId, loadMessages, setMessages]);

	// Re-hydrate messages when the user switches back to this tab. If the ACP
	// agent is still running, reconnect to Core's live stream resume endpoint so
	// text deltas appear in real time. Otherwise just load persisted history.
	const prevIsActiveTab = useRef(isActiveTab);
	const resumeAbort = useRef<AbortController | null>(null);
	useEffect(() => {
		const wasActive = prevIsActiveTab.current;
		prevIsActiveTab.current = isActiveTab;
		if (!wasActive && isActiveTab && status === "ready" && convId) {
			// First, load persisted messages to restore history up to the
			// incremental-flush point. Then attempt a live resume.
			const controller = new AbortController();
			resumeAbort.current?.abort();
			resumeAbort.current = controller;

			loadMessages(convId).then((history) => {
				if (controller.signal.aborted) {
					return;
				}
				if (history.length > 0) {
					setVersions(buildVersions(history));
					setMessages(
						history.map((m) => ({
							id: m.id,
							role: m.role,
							parts: hydrateMessageParts(m),
						}))
					);
				}
				// Try to reconnect to the running turn's live stream.
				const resumeUrl = chatStreamResumeUrl(chatTargetRef.current, convId);
				const headers = chatHeaders(chatTargetRef.current);
				fetch(resumeUrl, { headers, signal: controller.signal })
					// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
					.then(async (resp) => {
						if (!(resp.ok && resp.body)) {
							return; // 404 = no running turn
						}
						const reader = resp.body.getReader();
						const decoder = new TextDecoder();
						let buffer = "";
						// Find the last assistant message id to append deltas to it,
						// or create a new one if none exists yet.
						const lastAssistant = history
							.slice()
							.reverse()
							.find((m) => m.role === "assistant");
						const targetMsgId = lastAssistant?.id ?? `resume-${Date.now()}`;
						// Start with the persisted text and append new deltas.
						let replyText = lastAssistant?.content ?? "";
						for (;;) {
							const { done, value } = await reader.read();
							if (done) {
								break;
							}
							buffer += decoder.decode(value, { stream: true });
							// Parse SSE frames (double-newline separated).
							let sep = buffer.indexOf("\n\n");
							while (sep !== -1) {
								const frame = buffer.slice(0, sep);
								buffer = buffer.slice(sep + 2);
								for (const line of frame.split("\n")) {
									if (!line.startsWith("data: ")) {
										continue;
									}
									const raw = line.slice(6).trim();
									if (raw === "[DONE]") {
										continue;
									}
									try {
										const parsed = JSON.parse(raw);
										if (parsed.type === "text-delta" && parsed.delta) {
											replyText += parsed.delta;
											setMessages((prev) => {
												const idx = prev.findIndex((m) => m.id === targetMsgId);
												if (idx !== -1) {
													const next = prev.slice();
													next[idx] = {
														...next[idx],
														parts: [
															{
																type: "text" as const,
																text: replyText,
															},
														],
													};
													return next;
												}
												return [
													...prev,
													{
														id: targetMsgId,
														role: "assistant" as const,
														parts: [
															{
																type: "text" as const,
																text: replyText,
															},
														],
													},
												];
											});
										}
									} catch {
										// Ignore malformed frames.
									}
								}
								sep = buffer.indexOf("\n\n");
							}
						}
						// Stream ended — re-fetch the final persisted state.
						if (!controller.signal.aborted) {
							const final_ = await loadMessages(convId);
							if (final_.length > 0) {
								setMessages(
									final_.map((m) => ({
										id: m.id,
										role: m.role,
										parts: hydrateMessageParts(m),
									}))
								);
							}
							refresh();
						}
					})
					.catch(() => {
						// Resume failed (no live turn / network error) — persisted
						// history is already loaded above, nothing more to do.
					});
			});
		}
		return () => {
			resumeAbort.current?.abort();
		};
	}, [isActiveTab, status, convId, loadMessages, setMessages, refresh]);

	// ── Multi-user collaboration (Phase 2): live chat fan-out + presence ────────
	// Join this conversation's realtime room (only once a real `convId` exists —
	// never the draft id) so another human's messages appear live and we can show
	// who is present/typing. Anonymous (no node JWT) still works: with no verified
	// author, nothing is attributed or live-inserted, leaving the single-user flow
	// untouched.
	//
	// The signed-in human (control-plane profile) — name/email for presence and a
	// secondary self-match key. Read into a ref so the realtime callbacks (created
	// once) always see the current value without re-subscribing.
	const oidcUser = useAppStore((s) => s.oidcUser);
	const myEmailRef = useRef<string | null>(null);
	myEmailRef.current = oidcUser?.email ?? null;

	// This client's stable Core user id (the JWT subject Core stamps as a message's
	// `author_user_id`). Resolved once; lets us tell our own echoed message from
	// someone else's. Null when signed out (anonymous) — then own/other is
	// indistinguishable, but an anonymous author is null too, so nothing inserts.
	const myUserIdRef = useRef<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		// `getRealtimeUserId` resolves to null on any failure (never rejects).
		getRealtimeUserId().then((id) => {
			if (!cancelled) {
				myUserIdRef.current = id;
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);

	// This connection's room member id (from the join ack), used to drop our own
	// presence echo so we never show ourselves as "typing".
	const myMemberIdRef = useRef<string | null>(null);

	// Remote members' latest presence (name + typing), keyed by member id. Our own
	// member is excluded. Reset when the conversation changes.
	const [remotePresence, setRemotePresence] = useState<
		Record<string, { name?: string; typing?: boolean }>
	>({});
	// Presence belongs to the room we are leaving, so wipe it when convId changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: convId is the reset trigger, not read in the body.
	useEffect(() => {
		setRemotePresence({});
		myMemberIdRef.current = null;
	}, [convId]);

	// Live-insert a message authored by ANOTHER human. Assistant turns (null
	// author) arrive through the local SSE stream, and our own message echoes back
	// under our user id (its optimistic copy is already shown under a different,
	// client-generated id) — both are skipped here. Dedupe by id guards against a
	// frame being delivered twice. Appended last = created_at order for live
	// arrival; the server timestamp is kept in metadata for later reconstruction.
	const handleRealtimeEvent = useCallback(
		(data: unknown) => {
			if (typeof data !== "object" || data === null) {
				return;
			}
			const frame = data as { type?: string; message?: unknown };
			if (frame.type !== "message" || typeof frame.message !== "object") {
				return;
			}
			const msg = frame.message as {
				id?: string;
				content?: string;
				author_user_id?: string | null;
				author_name?: string | null;
				created_at?: number;
			};
			const authorId = msg.author_user_id ?? null;
			// "Mine" matches the JWT subject Core stamps (`author_user_id`), with the
			// email as a defensive secondary key. Either match means it's our own echo
			// (its optimistic copy is already shown), so skip it.
			const isOwnMessage =
				authorId === myUserIdRef.current ||
				(myEmailRef.current !== null && authorId === myEmailRef.current);
			if (
				!msg.id ||
				typeof msg.content !== "string" ||
				!authorId ||
				isOwnMessage
			) {
				return;
			}
			const inserted = {
				id: msg.id,
				role: "user",
				parts: [{ type: "text", text: msg.content }],
				metadata: {
					author: { name: msg.author_name ?? undefined, id: authorId },
					createdAt: msg.created_at,
				},
			};
			setMessages((prev) => {
				if (prev.some((m) => m.id === msg.id)) {
					return prev;
				}
				return [...prev, inserted as unknown as (typeof prev)[number]];
			});
		},
		[setMessages]
	);

	// Apply a presence delta from another member: upsert their name/typing, or
	// drop them on a `presence_leave`. Our own echo (same member id) is ignored.
	const handleRealtimePresence = useCallback((data: unknown) => {
		if (typeof data !== "object" || data === null) {
			return;
		}
		const frame = data as {
			type?: string;
			member_id?: string;
			name?: string;
			typing?: boolean;
		};
		const memberId = frame.member_id;
		if (!memberId || memberId === myMemberIdRef.current) {
			return;
		}
		if (frame.type === "presence_leave") {
			setRemotePresence((prev) => {
				if (!(memberId in prev)) {
					return prev;
				}
				const next = { ...prev };
				delete next[memberId];
				return next;
			});
			return;
		}
		setRemotePresence((prev) => ({
			...prev,
			[memberId]: { name: frame.name, typing: Boolean(frame.typing) },
		}));
	}, []);

	const handleRealtimeJoinAck = useCallback((ack: JoinAck) => {
		myMemberIdRef.current = ack.memberId;
	}, []);

	// A ghost (temporary) chat never opens a realtime room: its turns are never
	// persisted (so Core fans out nothing), and we also skip presence so a
	// temporary thread stays fully private. `null` room id = no join.
	const { publishPresence: publishRoomPresence } = useRealtimeRoom(
		ghostMode ? null : convId,
		"conversation",
		{
			onEvent: handleRealtimeEvent,
			onJoinAck: handleRealtimeJoinAck,
			onPresence: handleRealtimePresence,
		}
	);

	// Our presence display name (control-plane profile), read into a ref so the
	// stable typing publisher always sends the current value.
	const myPresenceNameRef = useRef("Someone");
	myPresenceNameRef.current = oidcUser?.name ?? oidcUser?.email ?? "Someone";
	const publishRoomPresenceRef = useRef(publishRoomPresence);
	publishRoomPresenceRef.current = publishRoomPresence;

	// Debounced typing presence: publish `typing:true` on activity, then
	// `typing:false` once the user pauses (or on send). No-op until the room is
	// open (publishPresence swallows pre-open calls).
	const typingTimerRef = useRef<number | null>(null);
	const stopTyping = useCallback(() => {
		if (typingTimerRef.current !== null) {
			window.clearTimeout(typingTimerRef.current);
			typingTimerRef.current = null;
		}
		publishRoomPresenceRef.current({
			typing: false,
			name: myPresenceNameRef.current,
		});
	}, []);
	const handleTypingActivity = useCallback(() => {
		publishRoomPresenceRef.current({
			typing: true,
			name: myPresenceNameRef.current,
		});
		if (typingTimerRef.current !== null) {
			window.clearTimeout(typingTimerRef.current);
		}
		typingTimerRef.current = window.setTimeout(() => {
			typingTimerRef.current = null;
			publishRoomPresenceRef.current({
				typing: false,
				name: myPresenceNameRef.current,
			});
		}, TYPING_IDLE_MS);
	}, []);

	// A short human-readable presence line: who is typing wins; otherwise who is
	// here. Empty when alone, so nothing renders in the common single-user case.
	const presenceLabel = useMemo(() => {
		const members = Object.values(remotePresence);
		const typingNames = members
			.filter((m) => m.typing)
			.map((m) => m.name?.trim() || "Someone");
		if (typingNames.length > 0) {
			const verb = typingNames.length === 1 ? "is" : "are";
			return `${typingNames.join(", ")} ${verb} typing…`;
		}
		const presentNames = members.map((m) => m.name?.trim() || "Someone");
		if (presentNames.length > 0) {
			return presentNames.length === 1
				? `${presentNames[0]} is here`
				: `${presentNames.length} others here`;
		}
		return null;
	}, [remotePresence]);

	// The conversation id of the most recently completed run. Used to query the
	// worktree diff after stream completion. Reset when a new conversation starts.
	const [diffConvId, setDiffConvId] = useState<string | null>(null);

	// ChatGPT-style next-prompt suggestions: fetched from Core once a turn
	// settles, cleared the moment the next turn starts (or the thread switches).
	const [followUps, setFollowUps] = useState<string[]>([]);
	const followUpAbort = useRef<AbortController | null>(null);

	// After a streamed reply completes, re-sync the sidebar list from Core and
	// record the conversation id so DiffReviewPane can fetch the run's diff.
	const prevStatus = useRef(status);
	useEffect(() => {
		// A new turn is in flight — drop stale chips and cancel any pending fetch.
		if (status === "streaming" || status === "submitted") {
			setFollowUps([]);
			followUpAbort.current?.abort();
			followUpAbort.current = null;
		}
		if (prevStatus.current === "streaming" && status === "ready") {
			refresh();
			if (activeConversationId) {
				setDiffConvId(activeConversationId);
			}
			// Auto read-back when enabled (Voice settings), unless a meeting is recording.
			getVoiceModeReadbackPrefs(chatTargetRef.current).then((prefs) => {
				if (!prefs.enabled) {
					return;
				}
				if (useMeetingRecordingStore.getState().active) {
					return;
				}
				const lastAssistant = messages
					.filter((m) => m.role === "assistant")
					.at(-1);
				if (!lastAssistant) {
					return;
				}
				const text = extractAssistantText(lastAssistant);
				if (text) {
					handleSpeakRef.current(text)?.catch(() => undefined);
				}
			});
			// Core auto-renames a new chat with the local model shortly after the
			// first turn (ChatGPT-style). That title lands a moment after the
			// stream ends, so re-sync once more to pick it up without a reload.
			const t = setTimeout(refresh, 2500);
			prevStatus.current = status;
			// Ask Core for follow-up prompts for the turn that just finished.
			// Best-effort: an empty list simply shows no chips.
			const convId = activeConversationId ?? draftConvId.current;
			if (convId) {
				const controller = new AbortController();
				followUpAbort.current = controller;
				fetchNextPromptSuggestions(
					chatTargetRef.current,
					convId,
					controller.signal
				).then((items) => {
					if (!controller.signal.aborted) {
						setFollowUps(items);
					}
				});
			}
			return () => clearTimeout(t);
		}
		prevStatus.current = status;
	}, [status, refresh, activeConversationId, messages]);

	// Switching threads must not carry chips across conversations.
	useEffect(() => {
		setFollowUps([]);
		followUpAbort.current?.abort();
		followUpAbort.current = null;
	}, []);

	const addImages = useCallback((files: File[]) => {
		const imageFiles = files.filter((f) => f.type.startsWith("image/"));
		if (imageFiles.length === 0) {
			return;
		}
		for (const file of imageFiles) {
			const reader = new FileReader();
			reader.onload = () => {
				const url = reader.result as string;
				setAttachedImages((prev) => [
					...prev,
					{
						id: `img-${Date.now()}-${Math.random()}`,
						filename: file.name,
						url,
						mimeType: file.type,
						size: file.size,
					},
				]);
			};
			reader.readAsDataURL(file);
		}
	}, []);

	const handleAttach = useCallback(() => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.multiple = true;
		input.onchange = () => {
			if (input.files) {
				addImages(Array.from(input.files));
			}
		};
		input.click();
	}, [addImages]);

	const handleRemoveImage = useCallback((id: string) => {
		setAttachedImages((prev) => prev.filter((img) => img.id !== id));
	}, []);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent) => {
			const files = Array.from(e.clipboardData.files);
			addImages(files);
		},
		[addImages]
	);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		setIsDragOver(true);
	}, []);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		if (!e.currentTarget.contains(e.relatedTarget as Node)) {
			setIsDragOver(false);
		}
	}, []);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			setIsDragOver(false);
			const files = Array.from(e.dataTransfer.files);
			addImages(files);
		},
		[addImages]
	);

	// When the user clicks a run-completion OS notification, navigate to that
	// run's review pane. The event is dispatched by useRuns in the hook after
	// the Notification's onclick fires (see useRuns.ts).
	useEffect(() => {
		const handler = (e: Event) => {
			// Only the focused tab navigates, so one notification click doesn't
			// hijack every mounted chat tab.
			if (!isActiveTabRef.current) {
				return;
			}
			const { runId } = (e as CustomEvent<{ runId: string }>).detail;
			if (runId) {
				setConvId(runId);
				setActiveConversationId(runId);
				setDiffConvId(runId);
			}
		};
		window.addEventListener("ryu:run-notification-click", handler);
		return () =>
			window.removeEventListener("ryu:run-notification-click", handler);
	}, [setActiveConversationId]);

	const handleSend = useCallback(
		(message: { role: "user"; content: string }) => {
			// #403: Always surface the user's message even when blocked, so it's never
			// silently dropped. If chat is blocked, record it in blockedMessages so the
			// UI can render it with an error state.
			if (composerBlocked) {
				setBlockedMessages((prev) => [
					...prev,
					{
						id: `blocked-${Date.now()}`,
						content: message.content,
						timestamp: Date.now(),
					},
				]);
				return;
			}
			if (!convId) {
				const newId = draftConvId.current;
				// A ghost (temporary) chat is never registered in the sidebar history:
				// skip `createConversation` so it leaves no trace in the thread list.
				// The turn still streams (useChat keys off the local id) and Core
				// persists nothing because the transport sends `persist: false`.
				if (!ghostMode) {
					createConversation(newId, agentId ?? undefined);
				}
				setConvId(newId);
				setActiveConversationId(newId);
			}

			// #415: Record the targeted agent for this upcoming assistant turn so we
			// can label the response bubble with the right agent name.
			const assistantIdx = messages.filter(
				(m) => m.role === "assistant"
			).length;
			const targetId = targetAgentIdRef.current;
			if (targetId) {
				const targetAgent = agents.find((a) => a.id === targetId);
				if (targetAgent) {
					agentLabelMapRef.current[String(assistantIdx)] = targetAgent.name;
				}
			} else if (participants.length === 1) {
				agentLabelMapRef.current[String(assistantIdx)] = participants[0].name;
			}

			const currentImages = attachmentRef.current.attachedImages;
			if (currentImages.length > 0) {
				sendMessage({
					text: message.content,
					files: currentImages.map((img) => ({
						type: "file" as const,
						mediaType: img.mimeType,
						filename: img.filename,
						url: img.url,
					})),
				});
				setAttachedImages([]);
			} else {
				sendMessage({ text: message.content });
			}
			// Reset after send so the next message starts fresh.
			targetAgentIdRef.current = null;
			teamIdRef.current = null;
			// Our turn is sent — clear any lingering "typing" presence immediately.
			stopTyping();
		},
		[
			composerBlocked,
			convId,
			agentId,
			agents,
			participants,
			messages,
			ghostMode,
			createConversation,
			setActiveConversationId,
			sendMessage,
			stopTyping,
		]
	);

	// Start a brand-new empty thread in THIS tab: rotate the draft id, clear the
	// active conversation and the on-screen messages. Used when the ghost toggle
	// flips so a temporary chat and a persisted chat never share a thread — a
	// persisted conversation must never receive a non-persisted turn, and a ghost
	// thread must not inherit a persisted one.
	const startFreshThread = useCallback(() => {
		draftConvId.current = `conv-${Date.now()}`;
		setConvId(null);
		setActiveConversationId(null);
		setMessages([]);
	}, [setActiveConversationId, setMessages]);

	const toggleGhostMode = useCallback(() => {
		startFreshThread();
		setGhostMode((on) => !on);
	}, [startFreshThread]);

	// `/btw` side question: an ephemeral question about the current conversation
	// shown in a dismissible overlay and never added to the chat history (modeled
	// on Claude Code's interactive `/btw`). The side model sees the conversation
	// context but has no tools. `null` = overlay closed.
	const [btwState, setBtwState] = useState<BtwState | null>(null);
	const btwRequestRef = useRef(0);
	// Bumped after each `/btw` resolves so the Context rail's Side-chats list
	// refetches the now-persisted aside without a full reload.
	const [sideChatsRefreshKey, setSideChatsRefreshKey] = useState(0);

	// Reopen a persisted side chat (from the Context rail or the sidebar) in the
	// btw overlay.
	const handleOpenSideChat = useCallback((entry: BtwEntry) => {
		setBtwState({
			question: entry.question,
			loading: false,
			answer: entry.answer,
			model: entry.model ?? null,
			error: null,
		});
	}, []);

	// Open a spawned subagent's transcript in the right panel. The nonce makes each
	// click a distinct request so re-selecting the same subagent re-focuses the tab;
	// opening the right panel auto-hides the (overlapping) pinned summary card.
	const [subagentReq, setSubagentReq] = useState<{
		id: string;
		label: string;
		nonce: number;
	} | null>(null);
	const subagentNonce = useRef(0);
	const handleOpenSubagent = useCallback((subagent: SubagentSummary) => {
		subagentNonce.current += 1;
		setSubagentReq({
			id: subagent.id,
			label: subagent.label,
			nonce: subagentNonce.current,
		});
		setRightPanelOpen(true);
	}, []);

	// Sidebar → side chat: the sidebar selects the thread then dispatches this
	// event. Only the tab whose conversation matches opens the overlay; if the
	// tab is still mounting (convId not yet set), stash it and flush once convId
	// catches up. Mirrors the run-notification-click decoupling below.
	const pendingSideChatRef = useRef<{
		conversationId: string;
		entry: BtwEntry;
	} | null>(null);
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (
				e as CustomEvent<{ conversationId: string; entry: BtwEntry }>
			).detail;
			if (!detail?.entry) {
				return;
			}
			if (detail.conversationId === convIdRef.current) {
				handleOpenSideChat(detail.entry);
			} else {
				// Another tab (or one still mounting) — stash it, keyed by the target
				// conversation so only the matching tab flushes it.
				pendingSideChatRef.current = detail;
			}
		};
		window.addEventListener("ryu:open-side-chat", handler);
		return () => window.removeEventListener("ryu:open-side-chat", handler);
	}, [handleOpenSideChat]);

	// Flush a pending side chat once this tab's conversation matches the one the
	// sidebar asked to open (exact id match, so other tabs never steal it).
	useEffect(() => {
		const pending = pendingSideChatRef.current;
		if (pending && pending.conversationId === convId) {
			pendingSideChatRef.current = null;
			handleOpenSideChat(pending.entry);
		}
	}, [convId, handleOpenSideChat]);

	// Stop the current stream. Aborting the SSE (`stop()`) only halts the client's
	// read — an ACP agent keeps running to completion server-side — so we ALSO ask
	// Core to cancel the live turn for this conversation. Best-effort: the endpoint
	// returns `{ cancelled: false }` when there is no live turn, and any error is
	// ignored so Stop always feels instant. The id is the same session key sent as
	// `conversation_id` on each turn.
	const handleStop = useCallback(() => {
		stop();
		const conversationId = convIdRef.current ?? draftConvId.current;
		cancelChat(chatTargetRef.current, conversationId).catch(() => {
			// No live turn (or Core unreachable) — the SSE abort above still stands.
		});
	}, [stop]);

	// Branch ("fork into new chat", ChatGPT-style): copy this conversation's
	// history up to the chosen message into a fresh conversation and open it in a
	// new tab. Core persists the copy, so the new tab hydrates from the server.
	const handleBranch = useCallback(
		(messageId: string) => {
			if (!activeConversationId) {
				return;
			}
			forkConversation(activeConversationId, messageId).then((newId) => {
				if (newId) {
					openTab("/chat", { conversationId: newId, forceNew: true });
				}
			});
		},
		[activeConversationId, forkConversation, openTab]
	);

	// Load the persisted thumbs state when the active conversation changes, so a
	// reloaded transcript restores its lit thumbs. Best-effort (empty on failure).
	useEffect(() => {
		if (!activeConversationId) {
			setFeedback({});
			return;
		}
		let cancelled = false;
		getConversationFeedback(chatTargetRef.current, activeConversationId).then(
			(map) => {
				if (!cancelled) {
					setFeedback(map);
				}
			}
		);
		return () => {
			cancelled = true;
		};
	}, [activeConversationId]);

	// Thumbs 👍/👎 an assistant turn: update the lit state optimistically, then
	// persist. Core fans the vote out to the learning reward + RAG-memory sinks.
	// On a server rejection, revert to the prior state so the UI never lies.
	const handleFeedback = useCallback(
		(messageId: string, rating: "up" | "down" | null, isLatest: boolean) => {
			const conv = convIdRef.current ?? activeConversationId;
			if (!conv) {
				return;
			}
			let prev: "up" | "down" | undefined;
			setFeedback((current) => {
				prev = current[messageId];
				const next = { ...current };
				if (rating) {
					next[messageId] = rating;
				} else {
					delete next[messageId];
				}
				return next;
			});
			// A live reply is still under a client id; let the server retarget the
			// newest assistant message when this is the latest turn.
			setMessageFeedback(
				chatTargetRef.current,
				conv,
				messageId,
				rating,
				isLatest
			).then((res) => {
				if (res) {
					return;
				}
				// Transport failure: roll back to the pre-click state — but only if
				// the user is still viewing the conversation that was voted on, so a
				// late rejection can't contaminate another conversation's map.
				if ((convIdRef.current ?? activeConversationId) !== conv) {
					return;
				}
				setFeedback((current) => {
					const reverted = { ...current };
					if (prev) {
						reverted[messageId] = prev;
					} else {
						delete reverted[messageId];
					}
					return reverted;
				});
			});
		},
		[activeConversationId]
	);

	// After an edit/regenerate stream settles, re-read the active path so the
	// version pager counts (and any server-side title/ordering) reflect the new
	// branch. Cheap: one GET, keyed to the conversation being edited.
	const refreshVersions = useCallback(
		async (conv: string) => {
			const history = await loadMessages(conv);
			setVersions(buildVersions(history));
		},
		[loadMessages]
	);

	// Edit a previously-sent user message (ChatGPT/Claude-style). Core creates a
	// new sibling version carrying the new text and switches the active branch to
	// it; the client truncates the thread to the edit point, then streams a fresh
	// reply (skip_user_append: the sibling is already persisted).
	const handleEditMessage = useCallback(
		async (messageId: string, newText: string) => {
			const conv = convIdRef.current ?? activeConversationId;
			if (!(conv && newText.trim())) {
				return;
			}
			const newId = await editMessage(conv, messageId, newText.trim());
			if (!newId) {
				return;
			}
			// Rebuild the local thread: keep everything before the edited message,
			// then the edited user turn (under its new id). Drop the rest — the new
			// reply will stream in beneath it.
			setMessages((prev) => {
				const idx = prev.findIndex((m) => m.id === messageId);
				const head = idx >= 0 ? prev.slice(0, idx) : prev;
				return [
					...head,
					{
						id: newId,
						role: "user" as const,
						parts: [{ type: "text" as const, text: newText.trim() }],
					},
				];
			});
			skipNextUserAppendRef.current = true;
			try {
				await regenerate();
			} finally {
				await refreshVersions(conv);
			}
		},
		[
			activeConversationId,
			editMessage,
			setMessages,
			regenerate,
			refreshVersions,
		]
	);

	// Regenerate an assistant reply: Core points the active branch at the user
	// turn above it; the client drops that assistant message (and anything after)
	// and streams a fresh sibling reply.
	const handleRegenerateMessage = useCallback(
		async (messageId: string) => {
			const conv = convIdRef.current ?? activeConversationId;
			if (!conv) {
				return;
			}
			const ok = await regenerateMessage(conv, messageId);
			if (!ok) {
				return;
			}
			setMessages((prev) => {
				const idx = prev.findIndex((m) => m.id === messageId);
				return idx >= 0 ? prev.slice(0, idx) : prev;
			});
			skipNextUserAppendRef.current = true;
			try {
				await regenerate();
			} finally {
				await refreshVersions(conv);
			}
		},
		[
			activeConversationId,
			regenerateMessage,
			setMessages,
			regenerate,
			refreshVersions,
		]
	);

	// Page between versions at a branch point: Core switches the active leaf to
	// the chosen sibling and descends to its leaf; the client reloads the active
	// path to re-render the selected branch (no generation).
	const handleSelectVersion = useCallback(
		async (versionId: string) => {
			const conv = convIdRef.current ?? activeConversationId;
			if (!conv) {
				return;
			}
			const ok = await selectVersion(conv, versionId);
			if (!ok) {
				return;
			}
			const history = await loadMessages(conv);
			setVersions(buildVersions(history));
			setMessages(
				history.map((m) => ({
					id: m.id,
					role: m.role,
					parts: hydrateMessageParts(m),
				}))
			);
		},
		[activeConversationId, selectVersion, loadMessages, setMessages]
	);

	// Reset per-thread ephemeral overlay state when switching conversations: a
	// `/btw` side question belongs to the thread it was asked in, and dismissed
	// plugin notes (e.g. double-check reviews) are per-thread too. Keyed on
	// `convId` so switching threads within the same tab clears a leftover answer
	// or dismissed note instead of carrying it across conversations.
	// biome-ignore lint/correctness/useExhaustiveDependencies: convId is the reset trigger, not read in the body.
	useEffect(() => {
		btwRequestRef.current += 1;
		setBtwState(null);
		setDismissedPluginNotes(new Set());
	}, [convId]);

	// Client-side message queue (Codex/Claude-app style). While a run streams,
	// submitted messages are stashed and auto-drained one per turn; the queue bar
	// exposes per-message "send now" and a "send all" combine. `handleSend` is the
	// real dispatch path so queued turns get the same conversation/mention/memory
	// handling as a normal send.
	const {
		queue: queuedMessages,
		enqueue: enqueueMessage,
		edit: editQueued,
		remove: removeQueued,
		clear: clearQueue,
		sendNow: sendQueuedNow,
		sendAll: sendQueuedAll,
	} = useMessageQueue({
		status,
		send: handleSend,
		stop,
		blocked: composerBlocked,
	});

	// Intercept the `/btw` slash command: ask an ephemeral side question about the
	// current conversation. Returns true when the input was a `/btw` command (and
	// should not be sent as a normal message). The question/answer never enter the
	// chat history — they live only in the overlay. Available even while a turn is
	// streaming (the side question is independent of the main run).
	const maybeHandleBtwCommand = useCallback(
		(raw: string) => {
			const text = raw.trim();
			if (!(text === "/btw" || text.startsWith("/btw "))) {
				return false;
			}
			const question = text.slice("/btw".length).trim();
			if (!question) {
				// `/btw` alone is a no-op (nothing to ask) — but still swallow it so it
				// isn't sent to the agent as a literal message.
				return true;
			}
			const convId = activeConversationId;
			if (!convId) {
				setBtwState({
					question,
					loading: false,
					answer: null,
					model: null,
					error: "Ask something in this chat first, then try /btw.",
				});
				return true;
			}
			const requestId = btwRequestRef.current + 1;
			btwRequestRef.current = requestId;
			setBtwState({
				question,
				loading: true,
				answer: null,
				model: null,
				error: null,
			});
			askBtw(chatTargetRef.current, convId, question)
				.then((result) => {
					// Ignore a stale answer if the user asked another side question.
					if (btwRequestRef.current !== requestId) {
						return;
					}
					setBtwState({
						question,
						loading: false,
						answer: result.answer,
						model: result.model,
						error: null,
					});
					// The aside is now persisted server-side; refresh the rail's list.
					setSideChatsRefreshKey((k) => k + 1);
				})
				.catch((e: unknown) => {
					if (btwRequestRef.current !== requestId) {
						return;
					}
					setBtwState({
						question,
						loading: false,
						answer: null,
						model: null,
						error: e instanceof Error ? e.message : "Side question failed",
					});
				});
			return true;
		},
		[activeConversationId]
	);

	// Route composer submits: when busy, enqueue; when idle, send straight
	// through. The blocked path keeps the existing behaviour (records the message
	// in blockedMessages so it is never silently dropped).
	// Pending quote (ChatGPT-style): text the user selected in a message and chose
	// to quote. Shown above the composer and prepended to the next message as a
	// markdown blockquote on send. Cleared on send, dismiss, or thread switch.
	const [quote, setQuote] = useState<string | null>(null);
	useEffect(() => {
		setQuote(null);
	}, [activeConversationId]);

	const handleComposerSubmit = useCallback(
		(message: { role: "user"; content: string }) => {
			// `/btw …` is a client-side command. `/goal …` is now handled
			// server-side by the io.ryu.goal plugin, so it is sent as a normal
			// message (the plugin parses it from the turn).
			if (maybeHandleBtwCommand(message.content)) {
				return;
			}
			// Bake any pending quote into the outgoing text as a leading markdown
			// blockquote, then clear it — the model sees the quoted context and the
			// sent user bubble re-renders it as a styled quote block.
			const outgoing = quote
				? {
						...message,
						content: `${formatQuotePrefix(quote)}${message.content}`,
					}
				: message;
			if (quote) {
				setQuote(null);
			}
			if (composerBlocked) {
				handleSend(outgoing);
				return;
			}
			if (status === "ready") {
				handleSend(outgoing);
			} else {
				enqueueMessage(outgoing.content);
			}
		},
		[
			composerBlocked,
			status,
			handleSend,
			enqueueMessage,
			maybeHandleBtwCommand,
			quote,
		]
	);

	// Queued messages belong to the conversation they were typed in. Switching
	// conversations resets useChat (status → "ready"), which would otherwise drain
	// stale items into the new thread — clear on every switch (mirrors the
	// blockedMessages reset below).
	useEffect(() => {
		clearQueue();
	}, [clearQueue]);

	// Clear blocked messages when a new conversation starts or services recover.
	useEffect(() => {
		if (!composerBlocked) {
			setBlockedMessages([]);
		}
	}, [composerBlocked]);

	useEffect(() => {
		if (!activeConversationId) {
			draftConvId.current = `conv-${Date.now()}`;
			setBlockedMessages([]);
		}
	}, [activeConversationId]);

	// First-run auto-kickstart: send a seed message the first time chat is ready
	// after onboarding so the user sees a streaming AI response with zero typing.
	const kickstartFired = useRef(false);
	const servicesReady = !statusLoading && coreReachable && gatewayReachable;
	useEffect(() => {
		if (
			!servicesReady ||
			kickstartFired.current ||
			localStorage.getItem("ryu_first_run_kickstart") !== "true"
		) {
			return;
		}
		kickstartFired.current = true;
		localStorage.removeItem("ryu_first_run_kickstart");

		const convId = draftConvId.current;
		createConversation(convId, agentId ?? undefined);
		setActiveConversationId(convId);

		const timer = setTimeout(() => {
			sendMessage({ text: KICKSTART_PROMPT });
		}, 800);
		return () => clearTimeout(timer);
	}, [
		servicesReady,
		agentId,
		createConversation,
		setActiveConversationId,
		sendMessage,
	]);

	// Launchpad auto-send: when this tab was opened from the home composer with a
	// user-typed prompt (`initialSubmit`), send it as soon as the composer would
	// accept it — rather than only pre-filling the draft. The prompt + any staged
	// images (already seeded into `attachedImages`) go through the normal submit
	// path, so they stream just as if typed here. Fires once; gated on the same
	// `!composerBlocked && status === "ready"` a manual send needs, so a message
	// is never dropped into a down gateway/Core. Deep-link/Inbox seeds leave
	// `initialSubmit` unset and stay pre-fill-only (attacker-/system-controllable).
	const autoSubmitFired = useRef(false);
	useEffect(() => {
		if (autoSubmitFired.current || !initialSubmit) {
			return;
		}
		const content = initialPrompt?.trim() ?? "";
		const hasImages = (initialImages?.length ?? 0) > 0;
		if (!(content || hasImages)) {
			autoSubmitFired.current = true;
			return;
		}
		if (composerBlocked || status !== "ready") {
			return;
		}
		autoSubmitFired.current = true;
		handleComposerSubmit({ role: "user", content });
	}, [
		initialSubmit,
		initialPrompt,
		initialImages,
		composerBlocked,
		status,
		handleComposerSubmit,
	]);

	useEffect(() => {
		const conv = activeConversationId
			? getConversation(activeConversationId)
			: undefined;
		if (conv?.agentId) {
			// An existing thread is agent-pinned (conversations carry an agentId,
			// never a team) — drop any persistent team pick so the composer target
			// matches the thread instead of silently fanning out to a team.
			setTeamId(null);
			if (conv.agentId !== agentId) {
				setAgentId(conv.agentId);
				// Keep the model picker in sync when the conversation pins its agent
				// back (each thread owns its agent; the model follows the agent).
				setSelectedModel(getAgentModel(conv.agentId));
			}
		}
	}, [activeConversationId, getConversation, agentId]);

	const decideTool = useCallback(
		(toolCallId: string, decision: "approved" | "rejected") => {
			setToolDecisions((prev) => ({ ...prev, [toolCallId]: decision }));
			if (decision === "rejected") {
				stop();
			}
		},
		[stop]
	);

	// Attach an approval footer to any requested-but-unresolved tool call the user
	// has not yet acted on. This wires the shared ToolApprovalFooter into the chat
	// tool loop: a tool part in `input-available` state (the agent asked to run it)
	// gets an `approval` object the MCP tool renderer surfaces as the footer.
	//
	// #403: Also patch in friendly error cards for failed assistant turns.
	const errorString =
		error instanceof Error ? error.message : error ? String(error) : null;

	const messagesWithApproval = useMemo(() => {
		// When the active ACP mode is a bypass/full-access variant, tools run
		// without user approval — skip injecting the approval footer entirely.
		const mode = (acpModeRef.current ?? "").toLowerCase();
		const isBypassMode =
			mode.includes("bypass") ||
			mode.includes("full access") ||
			mode.includes("full-access") ||
			mode.includes("fullaccess") ||
			mode.includes("yolo");

		return messages.map((m) => {
			if (m.role !== "assistant" || !m.parts) {
				return m;
			}

			// #403: If this assistant message has empty content and there's an active
			// error, inject an error card part instead of leaving it blank.
			const hasContent = m.parts.some(
				(p) => p.type === "text" && (p as { text?: string }).text?.trim()
			);
			if (!hasContent && errorString) {
				return {
					...m,
					parts: [
						{
							type: "text" as const,
							text: `__error__:${errorString}`,
						},
					],
				};
			}

			let changed = false;
			const parts = m.parts.map((part) => {
				const p = part as {
					type?: string;
					state?: string;
					toolCallId?: string;
					input?: Record<string, unknown>;
				};
				const isTool =
					p.type === "dynamic-tool" ||
					(typeof p.type === "string" && p.type.startsWith("tool-"));
				if (
					isBypassMode ||
					!isTool ||
					p.state !== "input-available" ||
					!p.toolCallId ||
					toolDecisions[p.toolCallId]
				) {
					return part;
				}
				const toolCallId = p.toolCallId;
				changed = true;
				// The approval object is consumed by the MCP tool renderer; it isn't
				// part of the AI SDK part schema, so reattach the original part type.
				return {
					...p,
					input: {
						...(p.input ?? {}),
						approval: {
							approveLabel: "Approve",
							rejectLabel: "Skip",
							onApprove: () => decideTool(toolCallId, "approved"),
							onReject: () => decideTool(toolCallId, "rejected"),
						},
					},
				} as typeof part;
			});
			return changed ? { ...m, parts } : m;
		});
	}, [messages, toolDecisions, decideTool, errorString]);

	// #403: Synthesise blocked-message entries as visible user messages so they
	// appear in the thread even when not sent. Append them after the real messages.
	const visibleMessages = useMemo(() => {
		if (blockedMessages.length === 0) {
			return messagesWithApproval;
		}
		const blocked = blockedMessages.map((bm) => ({
			id: bm.id,
			role: "user" as const,
			parts: [{ type: "text" as const, text: bm.content }],
			_blocked: true,
		}));
		return [...messagesWithApproval, ...blocked];
	}, [messagesWithApproval, blockedMessages]);

	// #403: Custom text renderer that intercepts the __error__ sentinel and renders
	// an ErrorCard instead of raw JSON. The AgentChat component passes text parts
	// through its render pipeline — we hook in via the messages array above.
	// For the blocked-message case, we rely on AgentChat's default user bubble
	// (the message appears as normal user text, which is fine).
	//
	// #415: Also inject a per-agent label prefix into the first text part of each
	// assistant message when we have a participant label for that turn.
	const processedMessages = useMemo(() => {
		let assistantIdx = 0;
		// Resolve a message's send time: the persisted server stamp (seeded on
		// history load) if known, otherwise a client stamp captured the first time
		// this id is seen. Attached as `createdAt` so the message toolbar can render
		// it beside the action buttons for both user and assistant turns.
		const resolveCreatedAt = (id: string): Date => {
			const seen = messageSentAtRef.current;
			let stamp = seen.get(id);
			if (stamp === undefined) {
				stamp = Date.now();
				seen.set(id, stamp);
			}
			return new Date(stamp);
		};
		return visibleMessages.map((m) => {
			const createdAt = resolveCreatedAt(m.id);
			if (m.role !== "assistant" || !m.parts) {
				return { ...m, createdAt };
			}

			const myIdx = assistantIdx;
			assistantIdx += 1;

			// Codex-style: plain replies in a normal chat. Labels only appear in
			// council (multi-agent) conversations, resolved from the label map or
			// the participant list.
			const agentLabel = (() => {
				if (participants.length <= 1) {
					return null;
				}
				const mapped = agentLabelMapRef.current[String(myIdx)];
				if (mapped) {
					return mapped;
				}
				if (agentId) {
					const a = agents.find((ag) => ag.id === agentId);
					if (a) {
						return a.name;
					}
				}
				return null;
			})();

			const parts = m.parts.map((part) => {
				const p = part as { type?: string; text?: string };
				if (p.type === "text" && p.text?.startsWith("__error__:")) {
					const rawError = p.text.slice("__error__:".length);
					const { message: friendlyMsg } = friendlyError(rawError);
					return {
						...part,
						text: friendlyMsg,
					};
				}
				// Prepend the agent label line for council conversations.
				if (
					p.type === "text" &&
					agentLabel &&
					p.text !== undefined &&
					!p.text.startsWith(`**${agentLabel}**`)
				) {
					return {
						...part,
						text: `**${agentLabel}**\n\n${p.text}`,
					};
				}
				return part;
			});
			return { ...m, parts, createdAt };
		});
	}, [visibleMessages, participants, agentId, agents]);

	// #415: Stable slot reference for the custom InputBar. Using useMemo with an
	// empty dep array so the component identity is stable across renders, avoiding
	// textarea focus loss on every keystroke. Agents are accessed from state
	// through a stable ref pattern inside CouncilInputBar itself.
	const agentsStableRef = useRef(agents);
	agentsStableRef.current = agents;
	const teamsStableRef = useRef(teams);
	teamsStableRef.current = teams;
	// Aggregate the seven "@" mention sources into one object, held in a ref so
	// the memoized composer slot stays stable (same pattern as the agent/team
	// refs above). buildMentionGroups filters this per keystroke.
	const mentionSources = useMemo<MentionSources>(
		() => ({
			agents: agents.map((a) => ({ id: a.id, name: a.name })),
			teams: teams.map((t) => ({ id: t.id, name: t.name })),
			spaces: spaces.map((s) => ({ id: s.id, name: s.name })),
			skills: installedSkills.map((s) => ({ id: s.id, name: s.name })),
			mcp: mcpServers.map((m) => ({ id: m.id, name: m.name })),
			folders: recentFolders,
			plugins: getComposerPlugins(),
		}),
		[agents, teams, spaces, installedSkills, mcpServers, recentFolders]
	);
	const mentionSourcesRef = useRef(mentionSources);
	mentionSourcesRef.current = mentionSources;

	// Codex-style composer controls: the project (folder) picker on the left,
	// agent + model pickers on the right, all inside the input card. Held in a
	// ref (assigned every render) so the slot component identity stays stable —
	// remounting it on each change would drop textarea focus.
	// Agent · Model · Approval (+ any agent config) are merged into ONE composer
	// dropdown (ComposerSettingsMenu) whose trigger shows every active value. Each
	// control becomes a labelled section; sections with no options are dropped, so
	// the exact same data-driven visibility as the old separate pickers holds —
	// nothing is hardcoded, an agent that advertises no model/modes just shows
	// fewer rows.

	// The Model + Approval/Thinking + config sections come from the shared
	// `useComposerAcpSections` hook (see `acp` above), so ChatPage, the launchpad,
	// and the dock build them from one place and can't diverge.

	// The composer's left cluster (Agent · Model · Approval · … + capability
	// badges + usage meters) is built by the ONE shared factory, so ChatPage, the
	// launchpad, and the Ask Ryu dock render an identical bar and can never drift.
	// ChatPage feeds its richer Model chain (ACP models / config option / engine
	// catalog) via `modelSection` and its Approval + config picks via
	// `extraSections`; the factory owns the agent picker, badges, and usage meters.
	// The create/team/agent sentinel routing lives in the factory's callbacks, and
	// its composed `sections` are reused by the empty-state header so the logo
	// opens the identical Agent · Model · Thinking dropdown.
	// Once a conversation has history the composer collapses to a single row
	// ("+" · input · model · mic · send): the agent/model cluster moves to the
	// right of the input and the usage meters fold into its dropdown. The fresh
	// launchpad surface (no history) keeps the roomy left-aligned stacked layout.
	const composerCompact = processedMessages.length > 0;
	const composerCompactRef = useRef(composerCompact);
	composerCompactRef.current = composerCompact;

	const {
		leftActions: composerLeft,
		rightActions: composerRight,
		sections: composerSections,
		renderBody: composerRenderBody,
	} = useComposerAgentControls({
		compact: composerCompact,
		agents,
		teams,
		agentId,
		teamId,
		onCreateAgent: () => openTab("/agents/new/edit", { title: "New agent" }),
		onSelectTeam: (id) => setTeamId(id),
		onSelectAgent: (id) => {
			setTeamId(null);
			setAgentId(id);
			localStorage.setItem("ryu_default_agent", id);
			setSelectedModel(getAgentModel(id));
		},
		modelOptions,
		model: effectiveModel,
		onModelChange: handleModelChange,
		modelSection: acp.modelSection,
		extraSections: acp.extraSections,
	});

	const composerControlsRef = useRef<{
		left: ReactNode;
		right: ReactNode;
	}>({ left: null, right: null });
	composerControlsRef.current = { left: composerLeft, right: composerRight };
	const composerSectionsRef =
		useRef<ComposerSettingsSection[]>(composerSections);
	composerSectionsRef.current = composerSections;

	// Workspace strip (project ▸ branch ▸ worktree) rendered above the textarea.
	// Held in a ref like composerControlsRef so the memoized InputBar slot stays
	// stable; WorkspaceBar itself reads the workspace store reactively. The
	// conversation id is the worktree store key, so the draft id is used until a
	// conversation is created.
	// Once a conversation has a thread the project ▸ branch ▸ worktree strip moves
	// out of the composer and into the floating Pinned summary card (top-right), so
	// the composer footer stays clean during a chat. On a fresh draft (no thread)
	// the strip stays in the composer — the natural place to pick a project first.
	const workspaceBarRef = useRef<ReactNode>(null);
	workspaceBarRef.current =
		processedMessages.length > 0 ? null : (
			<WorkspaceBar
				conversationId={activeConversationId ?? draftConvId.current}
				target={chatTarget}
			/>
		);

	// Live queue state for the InputBar's queue bar. Held in a ref (assigned every
	// render) so the slot component identity stays stable — see the note on
	// composerControlsRef above.
	const queueBarRef = useRef<QueueBarProps>({
		items: [],
		onEdit: editQueued,
		onSendNow: sendQueuedNow,
		onRemove: removeQueued,
		onSendAll: sendQueuedAll,
		onClear: clearQueue,
	});
	queueBarRef.current = {
		items: queuedMessages,
		onEdit: editQueued,
		onSendNow: sendQueuedNow,
		onRemove: removeQueued,
		onSendAll: sendQueuedAll,
		onClear: clearQueue,
	};

	// Goal affordances for the composer, held in refs so the memoized InputBar slot
	// stays stable (see composerControlsRef/queueBarRef above). The "+" dropdown
	// chip uses `active` (goal set and not yet achieved); the bar shows whenever a
	// goal exists (including the achieved state) or a draft is open.
	// Generic plugin-contributed composer toggles, mapped to the "+" dropdown rows.
	// Every `toggle` composer control (double-check included — it is now a plain
	// plugin contribution, no special-case) renders through this one generic loop
	// and merges into `plugin_flags` uniformly. Held in a ref (read by the memoized
	// InputBar slot) so a toggle re-renders the composer without rebuilding the slot.
	const pluginComposerControls = useMemo<PluginComposerControlRow[]>(
		() =>
			pluginContributions.composer_controls
				.filter((c) => c.type === "toggle")
				.map((c) => ({
					id: c.id,
					flag: c.flag,
					label: c.label,
					description: c.description,
					enabled: Boolean(pluginFlags[c.flag]),
					onToggle: (flag: string, next: boolean) =>
						setPluginFlags((m) => ({ ...m, [flag]: next })),
				})),
		[pluginContributions.composer_controls, pluginFlags]
	);
	const pluginComposerControlsRef = useRef<PluginComposerControlRow[]>([]);
	pluginComposerControlsRef.current = pluginComposerControls;

	// Ghost (temporary) chat toggle, now a row in the composer "+" dropdown rather
	// than a standalone toolbar button. Held in a ref (assigned every render) so
	// the memoized InputBar slot stays stable. Only offered on the new-chat surface
	// (no rendered messages) — an existing conversation can't retroactively become
	// temporary — but it stays available during an active ghost chat so the user
	// can see and exit the temporary state. `undefined` hides the row entirely.
	const ghostControlsRef = useRef<GhostControls | undefined>(undefined);
	ghostControlsRef.current =
		processedMessages.length === 0 || ghostMode
			? { active: ghostMode, onToggle: toggleGhostMode }
			: undefined;

	const councilInputBar = useMemo(() => {
		return function BoundCouncilInputBar(props: InputBarProps) {
			return (
				<CouncilInputBar
					{...props}
					allAgents={agentsStableRef.current}
					allTeams={teamsStableRef.current}
					availableCommands={commandsRef.current}
					// Single-row compact composer once the chat has history (read from a
					// ref so the memoized slot flips without rebuilding — same pattern as
					// workspaceBar). Pairs with the right-aligned controls above.
					compact={composerCompactRef.current}
					composerSections={composerSectionsRef.current}
					enableQueue
					// Dashed violet composer treatment while a ghost (temporary) chat is
					// active. `ghostMode` is a dep of this memo, so the closure value is
					// always current (no ref needed).
					ghost={ghostMode}
					// The "+" dropdown's Temporary-chat toggle row (read fresh from the
					// ref so gating on rendered messages stays current).
					ghostControls={ghostControlsRef.current}
					leftActions={composerControlsRef.current.left}
					mentionSources={mentionSourcesRef.current}
					onGenerateImage={handleGenerateImage}
					onGenerateVideo={handleGenerateVideo}
					onRespondPermission={permissionRef.current.onRespond}
					onTargetAgentChange={(id) => {
						targetAgentIdRef.current = id;
					}}
					onTeamChange={(id) => {
						teamIdRef.current = id;
					}}
					onTyping={handleTypingActivity}
					permission={permissionRef.current.permission}
					pluginControls={pluginComposerControlsRef.current}
					queueBar={queueBarRef.current}
					rightActions={composerControlsRef.current.right}
					voice={{
						transcribe: voiceTranscribe,
						disabled: composerBlockedRef.current,
					}}
					voiceMode={{ onStart: voiceMode.start }}
					workspaceBar={workspaceBarRef.current}
				/>
			);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		voiceTranscribe,
		handleGenerateVideo,
		handleGenerateImage,
		voiceMode.start,
		// Rebuild the composer slot when ghost mode flips so the violet ring
		// reflects it immediately (a toggle already starts a fresh thread, so the
		// brief remount costs nothing — the textarea is cleared and unfocused).
		ghostMode,
		handleTypingActivity,
	]);

	const hasThread =
		activeConversationId !== null || processedMessages.length > 0;

	// "History page" = the conversation has actual messages on screen. The
	// new-chat surface (centered empty state) can still carry a focused-tab
	// `activeConversationId`, so gate the workspace-bar relocation and the pinned
	// summary strictly on rendered messages — never on the new-chat page.
	const hasMessages = processedMessages.length > 0;

	// The floating Pinned summary card shows only on a history page, and auto-hides
	// while the full-height right panel is open (they'd overlap and duplicate the
	// project/branch info) and auto-reopens when it closes — unless the user has
	// explicitly hidden it via the titlebar toggle (`pinnedSummaryOpen`).
	const pinnedSummaryVisible =
		hasMessages && pinnedSummaryOpen && !rightPanelOpen;

	// The Cowork context (Progress / Artifacts / Changes / Sources / Side chats),
	// shared by the right panel's Context tab and the floating Pinned summary card.
	const coworkData = {
		messages,
		runId: convId,
		target: chatTarget,
		chatStatus: status,
		onOpenSideChat: handleOpenSideChat,
		onOpenSubagent: handleOpenSubagent,
		sideChatsRefreshKey,
	};

	// A ghost thread has no store-backed title (it's never persisted), so label it
	// "Temporary chat" to reinforce that this conversation won't be saved.
	const persistedTitle = activeConversationId
		? getConversation(activeConversationId)?.title
		: undefined;
	const conversationTitle = ghostMode
		? "Temporary chat"
		: (persistedTitle ?? "New chat");

	// Push the conversation title and contextual actions into the shared titlebar.
	// Actions are memoized so the effect only re-fires when the relevant state changes.
	const titlebarActions = useMemo(() => {
		// The agent info icon, branch, council participants, and sessions moved
		// into the composer toolbar (see composerControlsRef.left). Only the tool
		// count and the panel toggles remain in the titlebar.
		const threadActions =
			hasThread && agentTools.length > 0 ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<span className="hidden truncate px-2 text-muted-foreground text-xs lg:inline">
								{agentTools.length} tool{agentTools.length === 1 ? "" : "s"}
							</span>
						}
					/>
					<TooltipContent>{agentTools.join(", ")}</TooltipContent>
				</Tooltip>
			) : null;

		return (
			<>
				{threadActions}
				<PanelToggleButtons
					bottomOpen={bottomPanelOpen}
					folder={folder}
					onBottomToggle={() => setBottomPanelOpen((v) => !v)}
					onPinnedSummaryToggle={
						hasMessages ? () => setPinnedSummaryOpen((v) => !v) : undefined
					}
					onRightToggle={() => setRightPanelOpen((v) => !v)}
					pinnedSummaryOpen={pinnedSummaryOpen}
					rightOpen={rightPanelOpen}
				/>
			</>
		);
	}, [
		hasThread,
		hasMessages,
		agentTools,
		bottomPanelOpen,
		rightPanelOpen,
		folder,
		pinnedSummaryOpen,
	]);

	useTitleBar(hasThread ? conversationTitle : null, titlebarActions);

	return (
		<WorkspacePanels
			bottomOpen={bottomPanelOpen}
			cowork={coworkData}
			folder={folder}
			onBottomOpenChange={setBottomPanelOpen}
			onRightOpenChange={setRightPanelOpen}
			rightOpen={rightPanelOpen}
			subagentRequest={subagentReq}
		>
			<div className="flex h-full flex-col overflow-hidden">
				{voiceMode.active && <VoiceModeOverlay voice={voiceMode} />}
				{/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: custom drag/resize interaction */}
				<div
					className="relative flex-1 overflow-hidden"
					onDragLeave={handleDragLeave}
					onDragOver={handleDragOver}
					onDrop={handleDrop}
				>
					<WidgetHostContext.Provider value={widgetHostValue}>
						<AgentChat
							assistantAvatar={assistantIdentity.avatar}
							assistantName={assistantIdentity.name}
							attachments={{
								images: attachedImages,
								onAttach: handleAttach,
								onRemoveImage: handleRemoveImage,
								onPaste: handlePaste,
								isDragOver,
							}}
							// Pad the message list down by the titlebar height so the
							// conversation rests below the frosted bar yet scrolls under it.
							classNames={{ messageList: "pt-12" }}
							contextSize={contextSize}
							emptyStateHeader={
								<EmptyStateHeader
									logo={emptyStateLogo}
									// The full Agent · Model · Thinking dropdown from the shared
									// composer factory — the logo opens the identical menu the
									// composer's settings trigger does, not just an agent list.
									renderBody={composerRenderBody}
									sections={composerSections}
									// Ghost (temporary) chat: the empty-state greeting whispers
									// "secretly" so it's obvious this thread won't be saved.
									title={ghostMode ? "What are we secretly doing?" : undefined}
								/>
							}
							emptyStatePosition="center"
							error={error ?? undefined}
							feedback={feedback}
							followUps={{
								items: followUps.map((text, i) => ({
									id: `followup-${i}`,
									label: text,
									value: text,
								})),
								// One click runs the suggested next prompt straight away.
								onSelect: (item) => {
									setFollowUps([]);
									handleComposerSubmit({
										role: "user",
										content: item.value ?? item.label,
									});
								},
							}}
							key={`${activeNode.url}-${chatId}`}
							messages={processedMessages}
							onBranch={activeConversationId ? handleBranch : undefined}
							onClearQuote={() => setQuote(null)}
							onEditMessage={
								activeConversationId ? handleEditMessage : undefined
							}
							onFeedback={activeConversationId ? handleFeedback : undefined}
							onQuote={setQuote}
							onRegenerateMessage={
								activeConversationId ? handleRegenerateMessage : undefined
							}
							onSelectVersion={
								activeConversationId ? handleSelectVersion : undefined
							}
							onSend={handleComposerSubmit}
							onSpeak={handleSpeak}
							onStop={handleStop}
							quote={quote}
							seedDraft={initialSubmit ? undefined : initialPrompt}
							showCopyToolbar
							slots={{ InputBar: councilInputBar }}
							status={status}
							toolRenderers={{}}
							versions={versions}
						/>
					</WidgetHostContext.Provider>
					{/* Floating Pinned summary card (project ▸ branch ▸ worktree + git
					    changes + commit & push), pinned top-right below the titlebar.
					    Auto-hidden while the right panel is open — see pinnedSummaryVisible. */}
					{pinnedSummaryVisible && (
						<div className="pointer-events-none absolute top-14 right-3 z-20">
							<PinnedSummaryPanel
								conversationId={activeConversationId ?? draftConvId.current}
								cowork={coworkData}
								folder={folder}
								onDismiss={dismissPinnedSummary}
								target={chatTarget}
							/>
						</div>
					)}
					{/* Multi-user presence: who else is in this conversation, and whether
					    they are typing. Hidden when alone (single-user flow unchanged). */}
					{presenceLabel && (
						<div
							aria-live="polite"
							className="absolute top-14 left-1/2 z-10 -translate-x-1/2 rounded-full bg-popover/90 px-3 py-1 text-muted-foreground text-xs shadow-sm backdrop-blur"
						>
							{presenceLabel}
						</div>
					)}
				</div>
				{diffConvId && (
					<div className="shrink-0 px-4 pb-3">
						<DiffReviewPane runId={diffConvId} target={chatTarget} />
					</div>
				)}
			</div>
			<BtwOverlay onClose={() => setBtwState(null)} state={btwState} />
			{activePluginNote && (
				<div className="fixed bottom-28 left-1/2 z-50 w-[min(40rem,90vw)] -translate-x-1/2 rounded-lg bg-popover p-3 text-popover-foreground text-sm shadow-lg">
					<div className="mb-1 flex items-center justify-between">
						<span className="font-medium text-muted-foreground text-xs">
							Double-check
						</span>
						<button
							className="text-muted-foreground text-xs hover:text-foreground"
							onClick={() =>
								setDismissedPluginNotes((prev) => {
									const next = new Set(prev);
									next.add(activePluginNote.id);
									return next;
								})
							}
							type="button"
						>
							Dismiss
						</button>
					</div>
					<p className="whitespace-pre-wrap">{activePluginNote.text}</p>
				</div>
			)}
		</WorkspacePanels>
	);
}
