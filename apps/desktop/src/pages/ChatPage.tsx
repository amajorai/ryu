import { useChat } from "@ai-sdk/react";
import { ClipboardIcon, Share08Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
	AcpConfigOption,
	StreamedAcpConfig,
	StreamedAcpControl,
} from "@ryu/blocks/composer/composer-acp-sections.ts";
import { createComposerDirectory } from "@ryu/blocks/composer/composer-directory.ts";
import { handleComposerSettingsShortcut } from "@ryu/blocks/composer/composer-shortcuts.ts";
import { answerNowDelayMs } from "@ryu/blocks/desktop/agent-elements/answer-now.ts";
import {
	ArtifactHostContext,
	type ArtifactHostValue,
	type HostArtifact,
} from "@ryu/blocks/desktop/agent-elements/artifact-host-context.tsx";
import { deriveContextUsage } from "@ryu/blocks/desktop/agent-elements/context-usage.tsx";
import type { GoalCompletion } from "@ryu/blocks/desktop/agent-elements/goal-message.ts";
import type {
	ComposerMenuGroup,
	ComposerMenuItem,
} from "@ryu/blocks/desktop/agent-elements/input/composer-menu.tsx";
import { extractMemoryCitations } from "@ryu/blocks/desktop/agent-elements/memory-citations.ts";
import { isMessageReactionAction } from "@ryu/blocks/desktop/agent-elements/message-action-types.ts";
import {
	replyThreadDescription,
	shouldSuggestReplyThread,
} from "@ryu/blocks/desktop/agent-elements/reply-thread.ts";
import { mergeResumedReplyMessage } from "@ryu/blocks/desktop/agent-elements/resume-merge.ts";
import type { FileEditUndoPlan } from "@ryu/blocks/desktop/agent-elements/turn-end-cards";
import type {
	MentionItem as AgentElementMentionItem,
	AgentMessageContext,
	AgentMessageIdentity,
	ChatVoiceMode,
	ContributedMessageAction,
	ContributedSelectionAction,
	MessageActionContext,
	MessageActionRuntimeState,
	MessageReply,
	SelectionActionContext,
} from "@ryu/blocks/desktop/agent-elements/types.ts";
import { useDeferredComposerPrompt } from "@ryu/blocks/desktop/agent-elements/use-deferred-question.ts";
import {
	WidgetHostContext,
	type WidgetHostServices,
	type WidgetHostValue,
} from "@ryu/blocks/desktop/agent-elements/widget-host-context.tsx";
import { Avatar } from "@ryu/ui/components/avatar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import {
	clearGoal,
	type GoalState,
	getGoal,
	pauseGoal,
	resumeGoal,
	setGoal,
} from "@ryuhq/core-client/goals";
import {
	createRealtimeClientId,
	type JoinAck,
} from "@ryuhq/core-client/realtime";
import type { UIMessage } from "ai";
import { DefaultChatTransport } from "ai";
import {
	createElement,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { AgentChat } from "@/components/agent-elements/agent-chat.tsx";
import {
	EmptyStateHeader,
	type EmptyStateLogo,
} from "@/components/agent-elements/empty-state-header.tsx";
import { useComposerAgentControls } from "@/components/agent-elements/input/composer-agent-controls.tsx";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import type {
	GhostControls,
	PluginComposerControlRow,
} from "@/components/agent-elements/input/goal-plus-button.tsx";
import { useComposerAcpSections } from "@/components/agent-elements/input/use-composer-acp-sections.ts";
import type {
	AttachedImage,
	InputBarInfoBar,
	InputBarProps,
	TemporaryChatSaveControls,
} from "@/components/agent-elements/input-bar.tsx";
import { InputBar } from "@/components/agent-elements/input-bar.tsx";
import type { QueueBarProps } from "@/components/agent-elements/queue/queue-bar.tsx";
import { formatQuotePrefix } from "@/components/agent-elements/quote.tsx";
import { openExternal, previewLinkMetadata } from "@/lib/tauri-bridge.ts";
import { AppLaunchpad } from "@/src/components/chat/AppLaunchpad.tsx";
import {
	BtwOverlay,
	type BtwState,
} from "@/src/components/chat/BtwOverlay.tsx";
import {
	ChatSearchBar,
	type ChatSearchMode,
} from "@/src/components/chat/ChatSearchBar.tsx";
import { DiffReviewPane } from "@/src/components/chat/DiffReviewPane.tsx";
import {
	type ForkDestination,
	ForkDialog,
} from "@/src/components/chat/ForkDialog.tsx";
import { InlineArtifact } from "@/src/components/chat/InlineArtifact.tsx";
import { MentionMenu } from "@/src/components/chat/MentionMenu.tsx";
import { MergedThreadPicker } from "@/src/components/chat/MergedThreadPicker.tsx";
import {
	type ActivePermission,
	PermissionPrompt,
} from "@/src/components/chat/PermissionPrompt.tsx";
import { ShareConversationDialog } from "@/src/components/chat/ShareConversationDialog.tsx";
import { SlashCommandAutocomplete } from "@/src/components/chat/SlashCommandAutocomplete.tsx";
import { WorkspaceBar } from "@/src/components/chat/WorkspaceBar.tsx";
import { WorkspaceRequiredDialog } from "@/src/components/chat/WorkspaceRequiredDialog.tsx";
import { PluginComposerBarControls } from "@/src/components/composer/PluginComposerBarControls.tsx";
import {
	composerPluginSectionKey,
	composerSelectOptions,
	composerSelectValue,
	partitionComposerControls,
} from "@/src/components/composer/plugin-composer-controls.ts";
import { patchForFile } from "@/src/components/diffs/RichPatchDiff.tsx";
import { CHAT_REFERENCE_DRAG_MIME } from "@/src/components/layout/tabDnd.tsx";
import {
	extractSubagents,
	SubagentActivityChips,
	type SubagentSummary,
} from "@/src/components/panels/CoworkContextPanel.tsx";
import { PinnedSummaryPanel } from "@/src/components/panels/PinnedSummaryPanel.tsx";
import {
	type FileReviewRequest,
	PanelToggleButtons,
	WorkspacePanels,
} from "@/src/components/panels/WorkspacePanels.tsx";
import { VoiceModeSurface } from "@/src/components/voice/VoiceModeSurface.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import { useSystemStatusContext } from "@/src/contexts/SystemStatusContext.tsx";
import {
	useCurrentTabId,
	useIsActiveTab,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { useTitleBar } from "@/src/contexts/TitleBarContext.tsx";
import { AppWidget } from "@/src/contributions/host/AppWidget.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useAgentUsage } from "@/src/hooks/useAgentUsage.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { useChatPickerPlacement } from "@/src/hooks/useChatPickerPlacement.ts";
import { useComposerAutoQueue } from "@/src/hooks/useComposerAutoQueue.ts";
import {
	useComposerDraftAutosave,
	useComposerDraftRestore,
} from "@/src/hooks/useComposerDraftAutosave.ts";
import {
	composerSelectionToastDescription,
	shouldShowComposerSelectionToast,
	useComposerSelectionApplyMode,
} from "@/src/hooks/useComposerSelectionApplyMode.ts";
import { useComposerShortcutBindings } from "@/src/hooks/useComposerShortcutBindings.ts";
import {
	useComposioConnections,
	useComposioStatus,
	useComposioToolkits,
} from "@/src/hooks/useComposioCatalog.ts";
import { useEngineModels } from "@/src/hooks/useEngineModels.ts";
import {
	invalidateGitStatus,
	invalidateWorktreeDiff,
	invalidateWorktreeStatus,
	useWorktreeDiff,
} from "@/src/hooks/useGitStatus.ts";
import { useHumanMentionDirectory } from "@/src/hooks/useHumanMentionDirectory.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { useMcp } from "@/src/hooks/useMcp.ts";
import { useMentionableResources } from "@/src/hooks/useMentionableResources.ts";
import {
	isMergedHistoryId,
	useMergedAgentThreads,
} from "@/src/hooks/useMergedAgentThreads.ts";
import { useMessageQueue } from "@/src/hooks/useMessageQueue.ts";
import { useMessageReactions } from "@/src/hooks/useMessageReactions.ts";
import { useNodeDefaultAgentId } from "@/src/hooks/useNodeDefaultAgent.ts";
import {
	pluginCompanionPath,
	usePluginContributions,
	usePluginContributionsQuery,
} from "@/src/hooks/usePluginContributions.ts";
import { useProjectlessTaskFolder } from "@/src/hooks/useProjectlessTaskFolder.ts";
import {
	setQueueDrainMode,
	useQueueDrainMode,
} from "@/src/hooks/useQueueDrainMode.ts";
import { useShowBottomPanelToggle } from "@/src/hooks/useShowBottomPanelToggle.ts";
import { useSkillsCatalog } from "@/src/hooks/useSkillsCatalog.ts";
import { useSpeechPlayback } from "@/src/hooks/useSpeechPlayback.ts";
import { useTeams } from "@/src/hooks/useTeams.ts";
import { useVoiceMode } from "@/src/hooks/useVoiceMode.ts";
import { useWorkflows } from "@/src/hooks/useWorkflows.ts";
import { AgentAvatar, engineForAgent } from "@/src/lib/agent-logos.tsx";
import {
	authenticateAgent,
	fetchAcpConfig,
	respondPermission,
} from "@/src/lib/api/acp.ts";
import type {
	AgentSummary,
	ConversationParticipant,
} from "@/src/lib/api/agents.ts";
import { fetchAgent, fetchParticipants } from "@/src/lib/api/agents.ts";
import type { BtwEntry, BtwMessage } from "@/src/lib/api/btw.ts";
import { askBtw } from "@/src/lib/api/btw.ts";
import {
	answerNowChat,
	cancelChat,
	chatHeaders,
	chatStreamResumeUrl,
	chatStreamUrl,
	fetchNextPromptSuggestions,
	startProactiveOpening,
} from "@/src/lib/api/chat.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { apiUrl, makeHeaders } from "@/src/lib/api/client.ts";
import { deleteDraft, listDrafts, saveDraft } from "@/src/lib/api/drafts.ts";
import { reverseGitEdits } from "@/src/lib/api/git.ts";
import { generateImage } from "@/src/lib/api/images.ts";
import {
	getModelContextWindow,
	getModelLaunchConfig,
} from "@/src/lib/api/inference.ts";
import { getConversationFeedback } from "@/src/lib/api/message-feedback.ts";
import {
	type PluginChatWidgetTemplate,
	type PluginSelectionAction,
	pluginHostInvoke,
} from "@/src/lib/api/plugins.ts";
import {
	getDesktopTtsPrefs,
	getVoiceInputPrefs,
	getVoiceModeReadbackPrefs,
	subscribePreferenceChanges,
	VOICE_PREF_KEY,
} from "@/src/lib/api/preferences.ts";
import {
	fetchDocument,
	fetchDocuments,
	ingestDocument,
	updateDocument,
} from "@/src/lib/api/spaces.ts";
import type { Team } from "@/src/lib/api/teams.ts";
import {
	saveTemporaryChat,
	TEMPORARY_CONTEXT_FLAG,
} from "@/src/lib/api/temporary-chat.ts";
import { stageImageUpload } from "@/src/lib/api/uploads.ts";
import { generateVideo } from "@/src/lib/api/video.ts";
import { speakText, transcribeAudio } from "@/src/lib/api/voice.ts";
import {
	submitWidgetFollowUp,
	widgetCallTool,
	widgetSetState,
} from "@/src/lib/api/widgets.ts";
import type { Workflow } from "@/src/lib/api/workflows.ts";
import type { Artifact } from "@/src/lib/artifacts.ts";
import { artifactFromPayload } from "@/src/lib/artifacts.ts";
import { hydrateHistoryMessage } from "@/src/lib/chat-history-hydrate.ts";
import {
	modelRoutingFieldsForInterface,
	responseModeForInterface,
} from "@/src/lib/chat-routing.ts";
import { searchChatMessages } from "@/src/lib/chat-search.ts";
import { getChatTabBusySpeed } from "@/src/lib/chat-tab-busy-speed.ts";
import { textToDataUrl } from "@/src/lib/composer/attachments.ts";
import {
	conversationTargetDecision,
	readLastUsedAgentId,
	rememberLastUsedAgent,
	seedComposerAgentId,
	shouldAdoptNodeDefault,
} from "@/src/lib/composer-target.ts";
import { openContributedLink } from "@/src/lib/contributed-link-handler.ts";
import {
	copyChatTranscript,
	type TranscriptMessage,
} from "@/src/lib/copy-chat-transcript.ts";
import { instrumentedFetch } from "@/src/lib/dev-metrics.ts";
import {
	browserProviderHost,
	useBrowserProviderSnapshot,
} from "@/src/lib/extension-host.ts";
import { basename, readProjectFile } from "@/src/lib/files.ts";
import { appMentionVisual } from "@/src/lib/mentions/app-visuals.tsx";
import {
	applyMention,
	buildComposioMentionSources,
	buildMentionGroups,
	CHAT_MENTION_KINDS,
	resolveFirstNamedMentionId,
	resolveReferencedChatIds,
} from "@/src/lib/mentions/candidates.ts";
import {
	type SelectedHumanMention,
	selectHumanNotificationTargets,
} from "@/src/lib/mentions/human-notification.ts";
import type { MentionItem, MentionSources } from "@/src/lib/mentions/types.ts";
import {
	getAgentModel,
	modelsForAgent,
	setAgentModel,
} from "@/src/lib/models.ts";
import {
	extractPlans,
	type PlanSnapshot,
	planArtifact,
	planDocumentTitle,
} from "@/src/lib/plan-artifacts.ts";
import {
	buildSideChatContext,
	buildSideChatSelectionQuestion,
	EXPANDED_COMPOSER_FEATURE_KIND,
	EXPANDED_COMPOSER_PLUGIN_ID,
	GHOST_CHAT_FEATURE_KIND,
	GHOST_CHATS_PLUGIN_ID,
	hasPluginChatFeature,
	SIDE_CHAT_FEATURE_KIND,
	SIDE_CHAT_SELECTION_DISPATCH,
	SIDE_CHATS_PLUGIN_ID,
	type SideChatSelectionIntent,
	STATS_FEATURE_KIND,
	STATS_PLUGIN_ID,
} from "@/src/lib/plugin-chat-features.ts";
import { useProductMode } from "@/src/lib/product-mode.ts";
import { getRealtimeJwt, getRealtimeUserId } from "@/src/lib/realtime/jwt.ts";
import { isRealtimeMessageEcho } from "@/src/lib/realtime/message-origin.ts";
import { useRealtimeRoom } from "@/src/lib/realtime/use-realtime-room.ts";
import { CHAT_RETRY_STARTED_EVENT } from "@/src/lib/reconnect-retry.ts";
import {
	applySlashCommandOption,
	mergeComposerCommands,
	parseSlashCommandContribution,
	parseSlashMenuState,
	type SlashCommand,
	type SlashCommandOptionSelection,
} from "@/src/lib/slash-commands.ts";
import { deriveTurnComposerProgress } from "@/src/lib/turn-composer-progress.ts";
import { messageNeedsWorkspace } from "@/src/lib/workspace-intent.ts";
import { resolveWorkspaceFilePath } from "@/src/lib/workspace-links.ts";
import { findWorkspaceProject } from "@/src/lib/workspace-projects.ts";
import { useAppStore } from "@/src/store/useAppStore.ts";
import { useArtifactStore } from "@/src/store/useArtifactStore.ts";
import { useChatHotkeyTargets } from "@/src/store/useChatHotkeyTargets.ts";
import { useCreateAgentDialog } from "@/src/store/useCreateAgentDialog.ts";
import { useDockPanelRequestStore } from "@/src/store/useDockPanelRequestStore.ts";
import { useFileTreeSearchStore } from "@/src/store/useFileTreeSearchStore.ts";
import { useMeetingRecordingStore } from "@/src/store/useMeetingRecordingStore.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";
import {
	publishSidebarTodoProgress,
	sidebarTodoProgressKey,
} from "@/src/store/useSidebarTodoProgressStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

interface ChatSearchState {
	mode: ChatSearchMode;
	nonce: number;
	open: boolean;
	query: string;
}

// How often the focused chat tab re-probes `/api/chat/stream/resume/:id` while it
// believes it is idle. The endpoint 404s in-memory when nothing is running, so
// this is deliberately cheap; the interval only has to be short enough that Stop
// appears promptly for a turn this tab did not start.
const RESUME_POLL_MS = 15_000;

// How long after an explicit Stop the resume probe stays quiet, so a turn Core
// is still tearing down cannot re-arm the composer's Stop button.
const RESUME_STOP_GRACE_MS = 5000;

// Cool-down after a resumed reader detaches, so the "stream ended" → "ready"
// transition cannot re-probe in a tight loop.
const RESUME_REATTACH_GRACE_MS = 1500;

// Idle gap after the last keystroke before we broadcast `typing:false` to the
// conversation room (multi-user presence).
const TYPING_IDLE_MS = 2500;

// Hoisted so the identity is stable. Passed inline as `{}` this is a dependency
// of the memo that builds every assistant message's element tree, so a fresh
// object rebuilds the ENTIRE transcript (markdown, tool rows, citations) on
// every render of this page.
const EMPTY_TOOL_RENDERERS: Record<string, never> = {};

interface StreamedTurnControl {
	effort?: string;
	phase: "answering" | "reasoning";
	startedAtMs: number;
	strategy: "native";
	turnId: string;
}

const ARTIFACTS_SPACE_NAME = "Artifacts";

interface SavedPlanDocument {
	documentId: string;
	spaceId: string;
}

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

const MENTION_QUERY_RE = /(?:^|\s)@(\w*)$/;

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
 *  Plugin-owned commands are supplied by `pluginContributions.slash_commands` so
 *  disabling a plugin removes both its discoverability and its handler. */
const LOCAL_SLASH_COMMANDS: SlashCommand[] = [
	{
		args: [],
		name: "goal",
		description: "Set a goal the agent works toward each turn",
		hint: "condition to watch for",
		source: "local",
	},
];

/** Scan message text for the first "@Name" mention and resolve it to an agent id. */
function resolveFirstMention(
	text: string,
	agents: AgentSummary[]
): string | null {
	return resolveFirstNamedMentionId(text, agents);
}

/** Scan message text for the first "@Name" that matches a team, returning its id.
 *  Teams take precedence over agents when a name collides, since a team mention
 *  is the more specific "call all of them" intent. */
function resolveFirstTeamMention(text: string, teams: Team[]): string | null {
	return resolveFirstNamedMentionId(text, teams);
}

/** Scan message text for the first "@Name" that matches a chat-triggerable
 *  workflow, returning its id. A workflow mention is the most specific target
 *  of all — the message becomes the run's input, so it wins over agent/team.
 *
 *  Unlike agents/teams (matched on a `@word` token), workflow names are
 *  arbitrary ("Plan → Implement → Verify"), so the check is an exact
 *  `@Name` substring match — the same form the composer inserts when you pick a
 *  workflow from the mention menu. */
function resolveFirstWorkflowMention(
	text: string,
	workflows: Workflow[]
): string | null {
	const lower = text.toLowerCase();
	const found = workflows.find((w) =>
		lower.includes(`@${w.name.toLowerCase()}`)
	);
	return found?.id ?? null;
}

// ---------------------------------------------------------------------------
/**
 * Build the per-request `plugin_flags` map from the plugin composer toggles that
 * are currently ON (plus any one-shot `action` flag fired for this turn). Every
 * composer control (including the built-in double-check toggle, which is now a
 * plugin contribution like any other) flows through this one generic map keyed by
 * each control's `flag`. Returns `undefined` when nothing is on so Core applies
 * its defaults.
 *
 * The map is BOOL-ONLY on purpose: Core's `ChatRequest::plugin_flags` is a
 * `HashMap<String, bool>`, so a string value would fail to deserialize and take
 * the whole turn down with it. A `select`/`chip` value therefore lives in the
 * composer's own `pluginControlValues` state and does NOT reach the turn until
 * Core widens that field to a JSON value.
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
	/** Chat-triggerable workflows (a root Input node), for @workflow mentions. */
	allWorkflows: Workflow[];
	/** Slash commands offered in the "/" popover (agent-advertised + local). */
	availableCommands: SlashCommand[];
	/** Host-owned metadata affordances for available app widgets. */
	chatWidgetTemplates: PluginChatWidgetTemplate[];
	composerSections: ComposerSettingsSection[];
	/** Current signed-in Core user, excluded from Inbox mention fan-out. */
	currentUserId: string | null;
	/** Sources for the grouped "@" mention menu (apps/plugins/agents/workflows/users
	 *  plus the existing reference sources). Agents/teams/workflows also drive the target. */
	mentionSources: MentionSources;
	/** Sends selected human mentions to the optional Inbox bridge after chat send. */
	onHumanMentions: (mentions: SelectedHumanMention[], content: string) => void;
	/** Supplies the resolved chat mentions to the request body for this turn. */
	onReferencedChats: (conversationIds: string[]) => void;
	onRespondPermission?: (
		permission: ActivePermission,
		optionId: string | null
	) => void;
	onTargetAgentChange: (agentId: string | null) => void;
	onTeamChange: (teamId: string | null) => void;
	/** Fired on each composer keystroke so the surface can broadcast a debounced
	 * "typing" presence delta to the conversation room (multi-user collaboration). */
	onTyping?: () => void;
	onWorkflowChange: (workflowId: string | null) => void;
	/** Active interactive ACP tool-permission prompt, rendered above the composer. */
	permission?: ActivePermission | null;
}

interface DraggedChatReference {
	id: string;
	label: string;
}

function readDraggedChatReference(
	dataTransfer: DataTransfer
): DraggedChatReference | null {
	try {
		const value = JSON.parse(
			dataTransfer.getData(CHAT_REFERENCE_DRAG_MIME)
		) as Partial<DraggedChatReference>;
		return typeof value.id === "string" && typeof value.label === "string"
			? { id: value.id, label: value.label }
			: null;
	} catch {
		return null;
	}
}

function CouncilInputBar({
	allAgents,
	allTeams,
	allWorkflows,
	availableCommands,
	chatWidgetTemplates,
	composerSections,
	currentUserId,
	mentionSources,
	onHumanMentions,
	onReferencedChats,
	onTargetAgentChange,
	onTeamChange,
	onWorkflowChange,
	onTyping,
	permission,
	onRespondPermission,
	value,
	onChange,
	onSend,
	onTextareaKeyDown,
	...rest
}: CouncilInputBarProps) {
	const botProduct = useProductMode() === "bot";
	const isActiveTab = useIsActiveTab();
	const composerShortcuts = useComposerShortcutBindings();
	const showTechnicalPermissionDetails = useInterfaceLevel() !== "simple";
	const [mentionQuery, setMentionQuery] = useState<string | null>(null);
	const [dismissedSlashValue, setDismissedSlashValue] = useState<string | null>(
		null
	);
	const textareaWrapRef = useRef<HTMLDivElement | null>(null);
	const referencedChatIdsRef = useRef<Set<string>>(new Set());
	const selectedHumanMentionsRef = useRef<SelectedHumanMention[]>([]);
	const slashMenuCandidate = useMemo(
		() => parseSlashMenuState(value ?? "", availableCommands),
		[value, availableCommands]
	);
	const slashMenu =
		botProduct || dismissedSlashValue === (value ?? "")
			? null
			: slashMenuCandidate;
	const {
		markComposerActivity: markPermissionActivity,
		markComposerIdle: markPermissionIdle,
		visiblePrompt: visiblePermission,
	} = useDeferredComposerPrompt(permission);
	const insertChatReference = useCallback(
		(chat: DraggedChatReference) => {
			referencedChatIdsRef.current.add(chat.id);
			onChange?.(
				`${value?.trimEnd() ?? ""}${value?.trim() ? " " : ""}@${chat.label} `
			);
			setMentionQuery(null);
		},
		[onChange, value]
	);
	useEffect(() => {
		if (!isActiveTab) {
			return;
		}
		const handleChatReferenceDrop = (event: Event) => {
			insertChatReference((event as CustomEvent<DraggedChatReference>).detail);
		};
		window.addEventListener("ryu:chat-reference-drop", handleChatReferenceDrop);
		return () =>
			window.removeEventListener(
				"ryu:chat-reference-drop",
				handleChatReferenceDrop
			);
	}, [insertChatReference, isActiveTab]);

	// Grouped "@" candidates for the current fragment (empty when the menu is
	// closed). Recomputed per keystroke; buildMentionGroups is pure.
	const mentionGroups = useMemo(
		() =>
			botProduct || mentionQuery === null
				? []
				: buildMentionGroups(mentionSources, mentionQuery, CHAT_MENTION_KINDS),
		[botProduct, mentionQuery, mentionSources]
	);
	const directoryMentionGroups = useMemo(
		() => (botProduct ? [] : buildMentionGroups(mentionSources, "")),
		[botProduct, mentionSources]
	);
	const composerMenuGroups = useMemo<ComposerMenuGroup[]>(
		() =>
			botProduct
				? []
				: directoryMentionGroups
						.filter((group) => group.kind !== "user")
						.map((group) => ({
							id: `directory:${group.kind}`,
							label: group.label,
							items: group.items.map((item) => ({
								id: `${item.kind}:${item.id}`,
								label: item.label,
								description: item.description,
								badge:
									item.kind === "app"
										? "App"
										: item.kind === "app-item"
											? "App item"
											: item.kind === "plugin"
												? "Plugin"
												: item.kind === "integration"
													? "Integration"
													: item.kind === "page"
														? "Page"
														: item.kind === "output-style"
															? "Profile"
															: undefined,
								icon:
									item.visualIcon ??
									(item.icon
										? createElement(item.icon, { className: "size-4" })
										: undefined),
							})),
						})),
		[botProduct, directoryMentionGroups]
	);
	const composerMentionItems = useMemo(
		() =>
			botProduct
				? []
				: directoryMentionGroups
						.flatMap((group) => group.items)
						.map((item) => ({
							accentColor: item.accentColor,
							icon: item.icon
								? createElement(item.icon, { className: "size-3.5" })
								: undefined,
							kind: item.kind,
							label: item.label,
							visualIcon: item.visualIcon,
						})),
		[botProduct, directoryMentionGroups]
	);

	const handleChange = useCallback(
		(next: string) => {
			onChange?.(next);
			setDismissedSlashValue(null);
			onTyping?.();
			if (next.length > 0) {
				markPermissionActivity();
			} else {
				markPermissionIdle();
			}
			const query = parseMentionQuery(next);
			setMentionQuery(query);
			if (query === null) {
				onTargetAgentChange(null);
				onTeamChange(null);
				onWorkflowChange(null);
			}
		},
		[
			markPermissionActivity,
			markPermissionIdle,
			onChange,
			onTyping,
			onTargetAgentChange,
			onTeamChange,
			onWorkflowChange,
		]
	);

	const handleSelectSlash = useCallback(
		(command: SlashCommand) => {
			// An imported user command (Codex prompt) expands straight into its
			// template body — the "prompt fills the box, then send" convention
			// Cursor/Codex use. Everything else inserts "/name " and leaves the
			// cursor for the argument.
			if (command.body) {
				onChange?.(command.body);
			} else {
				onChange?.(`/${command.name} `);
			}
		},
		[onChange]
	);
	const handleSelectSlashArgument = useCallback(
		(selection: SlashCommandOptionSelection) => {
			if (slashMenu?.kind !== "arguments") {
				return;
			}
			const hasNextArgument =
				slashMenu.argumentIndex < slashMenu.command.args.length - 1;
			const nextValue = applySlashCommandOption(
				value ?? "",
				selection.option.value,
				hasNextArgument
			);
			onChange?.(nextValue);
			if (!hasNextArgument) {
				setDismissedSlashValue(nextValue);
			}
		},
		[onChange, slashMenu, value]
	);

	const handleSelect = useCallback(
		(item: MentionItem) => {
			if (botProduct) {
				return;
			}
			onChange?.(applyMention(value ?? "", item));
			if (item.kind === "chat") {
				referencedChatIdsRef.current.add(item.id);
			}
			if (item.kind === "user") {
				selectedHumanMentionsRef.current.push({
					id: item.id,
					label: item.label,
				});
			}
			setMentionQuery(null);
			// Agents/teams/workflows set the target directly from the picked id;
			// spaces/skills/mcp/folders are plain reference tokens and plugins
			// rewrite the composer — none of those set a target.
			if (item.kind === "workflow") {
				onWorkflowChange(item.id);
				onTeamChange(null);
				onTargetAgentChange(null);
			} else if (item.kind === "team") {
				onTeamChange(item.id);
				onTargetAgentChange(null);
				onWorkflowChange(null);
			} else if (item.kind === "agent") {
				onTargetAgentChange(item.id);
				onTeamChange(null);
				onWorkflowChange(null);
			}
		},
		[
			value,
			onChange,
			onTargetAgentChange,
			onTeamChange,
			onWorkflowChange,
			botProduct,
		]
	);
	const handleDirectorySelect = useCallback(
		(item: ComposerMenuItem) => {
			if (botProduct) {
				return;
			}
			const mention = directoryMentionGroups
				.flatMap((group) => group.items)
				.find((candidate) => `${candidate.kind}:${candidate.id}` === item.id);
			if (!mention) {
				return;
			}
			if (mention.kind === "workflow") {
				onWorkflowChange(mention.id);
				onTeamChange(null);
				onTargetAgentChange(null);
			} else if (mention.kind === "team") {
				onTeamChange(mention.id);
				onTargetAgentChange(null);
				onWorkflowChange(null);
			} else if (mention.kind === "agent") {
				onTargetAgentChange(mention.id);
				onTeamChange(null);
				onWorkflowChange(null);
			}
		},
		[
			directoryMentionGroups,
			botProduct,
			onWorkflowChange,
			onTeamChange,
			onTargetAgentChange,
		]
	);

	const handleSend = useCallback(
		(msg: { role: "user"; content: string }) => {
			if (botProduct) {
				setMentionQuery(null);
				setDismissedSlashValue(value ?? "");
				onTargetAgentChange(null);
				onTeamChange(null);
				onWorkflowChange(null);
				onSend(msg);
				return;
			}
			// A workflow mention is the most specific target — the message becomes
			// the run's input — so it wins over a team mention, which wins over an
			// agent mention.
			const workflowId = resolveFirstWorkflowMention(msg.content, allWorkflows);
			const teamId = resolveFirstTeamMention(msg.content, allTeams);
			if (workflowId) {
				onWorkflowChange(workflowId);
				onTeamChange(null);
				onTargetAgentChange(null);
			} else if (teamId) {
				onTeamChange(teamId);
				onTargetAgentChange(null);
				onWorkflowChange(null);
			} else {
				onTeamChange(null);
				onWorkflowChange(null);
				onTargetAgentChange(resolveFirstMention(msg.content, allAgents));
			}
			setMentionQuery(null);
			setDismissedSlashValue(value ?? "");
			const referencedConversationIds = resolveReferencedChatIds(
				msg.content,
				mentionSources.chats,
				referencedChatIdsRef.current
			);
			const humanMentions = selectHumanNotificationTargets({
				content: msg.content,
				currentUserId,
				selected: selectedHumanMentionsRef.current,
			});
			referencedChatIdsRef.current.clear();
			selectedHumanMentionsRef.current = [];
			onReferencedChats(referencedConversationIds);
			onSend(msg);
			onHumanMentions(humanMentions, msg.content);
		},
		[
			onSend,
			allAgents,
			allTeams,
			allWorkflows,
			mentionSources.chats,
			currentUserId,
			onHumanMentions,
			onTargetAgentChange,
			onTeamChange,
			onWorkflowChange,
			onReferencedChats,
			botProduct,
		]
	);

	return (
		<div
			className="relative"
			onDragOver={(event) => {
				if (event.dataTransfer.types.includes(CHAT_REFERENCE_DRAG_MIME)) {
					event.preventDefault();
					event.stopPropagation();
					event.dataTransfer.dropEffect = "copy";
				}
			}}
			onDrop={(event) => {
				const chat = readDraggedChatReference(event.dataTransfer);
				if (!chat) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				insertChatReference(chat);
			}}
			ref={textareaWrapRef}
		>
			{chatWidgetTemplates.length > 0 && (
				<div className="mx-auto mb-2 flex w-full max-w-[880px] flex-wrap items-center gap-1.5 px-3">
					<span className="text-[11px] text-muted-foreground">
						Available widgets
					</span>
					{chatWidgetTemplates.map((template) => {
						const prompt = template.examples[0] ?? template.triggers[0];
						if (!prompt) {
							return null;
						}
						return (
							<button
								className="rounded-full border border-border/70 bg-background px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
								key={`${template.plugin ?? "widget"}:${template.id}`}
								onClick={() => onChange?.(prompt)}
								type="button"
							>
								{template.title}
							</button>
						);
					})}
				</div>
			)}
			{!botProduct && mentionQuery !== null && (
				<MentionMenu
					anchorRef={textareaWrapRef}
					groups={mentionGroups}
					onDismiss={() => setMentionQuery(null)}
					onSelect={handleSelect}
				/>
			)}
			{slashMenu?.kind === "commands" && (
				<SlashCommandAutocomplete
					anchorRef={textareaWrapRef}
					commands={availableCommands}
					menu={slashMenu}
					mode="commands"
					onDismiss={() => setDismissedSlashValue(value ?? "")}
					onSelect={handleSelectSlash}
				/>
			)}
			{slashMenu?.kind === "arguments" && (
				<SlashCommandAutocomplete
					anchorRef={textareaWrapRef}
					menu={slashMenu}
					mode="arguments"
					onDismiss={() => setDismissedSlashValue(value ?? "")}
					onSelectArgument={handleSelectSlashArgument}
				/>
			)}
			<InputBar
				{...rest}
				composerMenuGroups={composerMenuGroups}
				composerPrompt={
					visiblePermission && onRespondPermission
						? {
								content: (
									<PermissionPrompt
										embedded
										onRespond={(optionId) =>
											onRespondPermission(visiblePermission, optionId)
										}
										permission={visiblePermission}
										showTechnicalDetails={showTechnicalPermissionDetails}
									/>
								),
								id: `permission:${visiblePermission.requestId}`,
							}
						: undefined
				}
				mentionItems={composerMentionItems}
				onChange={handleChange}
				onComposerMenuSelect={handleDirectorySelect}
				onSend={handleSend}
				onTextareaKeyDown={(event) => {
					if (
						handleComposerSettingsShortcut(
							event,
							composerSections,
							composerShortcuts
						)
					) {
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
/** Fetch a created artifact's blob as text through the node API (best-effort:
 *  a failed fetch yields null, and the surface falls back to the download/open
 *  affordance rather than an error state). */
async function fetchArtifactContent(
	target: ApiTarget,
	url: string
): Promise<string | null> {
	try {
		const res = await fetch(apiUrl(target, url), {
			headers: makeHeaders(target.token, target.userJwt),
		});
		if (!res.ok) {
			return null;
		}
		return await res.text();
	} catch {
		return null;
	}
}

export default function ChatPage({
	tabConversationId,
	initialPrompt,
	initialQuote,
	initialModel,
	initialProactiveOpening,
	initialSubmit,
	initialImages,
	initialAgent,
	initialTeamId,
	initialGhost,
	initialPluginFlags,
	initialProject,
	mergedAgentId,
	tabWorktreeMode,
}: {
	tabConversationId?: string;
	/**
	 * Messaging-style "one thread per agent" view (`/chat/agent/:agentId`): every
	 * earlier thread with this agent is rendered read-only above the live one, so
	 * the page reads as a single WhatsApp-shaped scroll. Purely a view — the
	 * threads stay separate rows in Core, and the composer's thread picker chooses
	 * which one a send lands in.
	 */
	mergedAgentId?: string;
	/** One-shot composer seeds from a `ryu://chat/new` deep link. The prompt
	 * pre-fills the composer (NEVER auto-sent — it is attacker-controllable);
	 * agent/project pre-select. Consumed once on mount. */
	initialPrompt?: string;
	/** One-shot quote restored into a newly-created focused reply thread. */
	initialQuote?: string;
	/** One-shot model restored into a newly-created focused reply thread. */
	initialModel?: string;
	/** Ask Core to create an assistant-only opening after model readiness. */
	initialProactiveOpening?: boolean;
	/** When set (launchpad composer only — a user-initiated send), the seeded
	 * `initialPrompt`/`initialImages` is SENT automatically once chat is ready,
	 * instead of just pre-filling. Never set for the deep-link/Inbox paths, whose
	 * text must stay pre-fill-only. */
	initialSubmit?: boolean;
	/** One-shot image attachments staged on the launchpad composer before a
	 * conversation existed, carried into this fresh tab. Consumed once on mount. */
	initialImages?: AttachedImage[];
	initialAgent?: string;
	/** One-shot team target carried from the new-chat launchpad. */
	initialTeamId?: string;
	/** Open this thread already temporary — the launchpad's "+" offers the toggle
	 * before a conversation exists, so the pick arrives as a seed rather than as a
	 * click on this page's own row. Consumed once on mount. */
	initialGhost?: boolean;
	/** One-shot composer flags carried from the new-chat launchpad. */
	initialPluginFlags?: Record<string, boolean>;
	initialProject?: string;
	/** Per-tab isolation requested by a fork destination or workspace handoff. */
	tabWorktreeMode?: boolean;
}) {
	const botProduct = useProductMode() === "bot";
	// Read gateway/core reachability from the shared provider so this page and
	// the shell banner always agree on the same poll tick.
	const {
		coreReachable,
		connectionPhase,
		gatewayReachable,
		loading: statusLoading,
	} = useSystemStatusContext();
	const browserSnapshot = useBrowserProviderSnapshot();
	const browserLocalAbortRef = useRef<AbortController | null>(null);
	const forceCoreNextRef = useRef(false);
	const handleSendRef = useRef<
		(message: {
			attachments?: AttachedImage[];
			content: string;
			role: "user";
		}) => void
	>(() => undefined);
	const interfaceLevel = useInterfaceLevel();
	const [chatPickerPlacement] = useChatPickerPlacement();
	const pluginContributions = usePluginContributions();
	const {
		isError: pluginContributionsFailed,
		isSuccess: pluginContributionsLoaded,
	} = usePluginContributionsQuery();
	const pluginContributionsSettled =
		pluginContributionsLoaded || pluginContributionsFailed;
	const sideChatsPluginEnabled = hasPluginChatFeature(
		pluginContributions.chat_features,
		SIDE_CHATS_PLUGIN_ID,
		SIDE_CHAT_FEATURE_KIND
	);
	const ghostChatsPluginEnabled = hasPluginChatFeature(
		pluginContributions.chat_features,
		GHOST_CHATS_PLUGIN_ID,
		GHOST_CHAT_FEATURE_KIND
	);
	const expandedComposerPluginEnabled = hasPluginChatFeature(
		pluginContributions.chat_features,
		EXPANDED_COMPOSER_PLUGIN_ID,
		EXPANDED_COMPOSER_FEATURE_KIND
	);
	const statsPluginEnabled = hasPluginChatFeature(
		pluginContributions.chat_features,
		STATS_PLUGIN_ID,
		STATS_FEATURE_KIND
	);

	const { folder, setFolder } = useWorkspaceStore();
	const activeNode = useActiveNode();
	const [projectlessTaskFolder] = useProjectlessTaskFolder();
	const [showBottomPanelToggle] = useShowBottomPanelToggle();
	const localProjectlessTaskFolder = isLocalNode(activeNode)
		? projectlessTaskFolder
		: null;
	// THIS TAB's composer target. Every chat tab stays mounted at once (Layout),
	// so this is deliberately per-instance state: nothing outside this ChatPage
	// may write it. The seed chain (merged-view pin → tab seed → last-used hint →
	// node default → the conversation's own pinned agent) lives in
	// `lib/composer-target.ts`; this initializer covers only its synchronous
	// links, and the two effects below cover the async ones.
	const [agentId, setAgentId] = useState<string | null>(() =>
		botProduct
			? "ryu"
			: seedComposerAgentId({
					// The merged view is *about* one agent, so it pins the target: opening it
					// must never inherit whichever agent happened to be picked last.
					pinnedAgentId: mergedAgentId,
					seededAgentId: initialAgent,
					lastUsedAgentId: readLastUsedAgentId(),
				})
	);
	const statsUsage = useAgentUsage(agentId);
	// Read-only mirror for effects that must compare against the live target
	// WITHOUT re-running when it changes — see the conversation-hydration effect,
	// where depending on `agentId` is what reverted the user's own pick.
	const agentIdRef = useRef(agentId);
	agentIdRef.current = agentId;
	// Persistent group selection from the composer target picker. When set, every
	// turn fans out to the group's members (Core's `team_id` takes precedence over
	// `agent_id`). Session-only — distinct from the transient `@group` mention ref.
	const [teamId, setTeamId] = useState<string | null>(initialTeamId ?? null);
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
	useEffect(() => {
		if (!showBottomPanelToggle) {
			setBottomPanelOpen(false);
		}
	}, [showBottomPanelToggle]);
	const [shareDialogOpen, setShareDialogOpen] = useState(false);
	// User's intent for the "Pinned summary" sidebar (project ▸ branch ▸
	// worktree + git changes + commit&push). It docks as its own column stacked
	// with the right panel (both can be open at once); WorkspacePanels
	// auto-demotes it to a floating overlay when the chat gets too narrow.
	const [pinnedSummaryOpen, setPinnedSummaryOpen] = useState(true);
	const [pendingWorkspaceMessage, setPendingWorkspaceMessage] = useState<{
		attachments?: AttachedImage[];
		content: string;
		role: "user";
	} | null>(null);
	// Only the floating (auto-demoted) overlay overlaps the message column, so
	// only it dismisses on a press-away (the titlebar toggle brings it back).
	// Stable so the panel's outside-press listener isn't re-bound each render.
	const dismissPinnedSummary = useCallback(
		() => setPinnedSummaryOpen(false),
		[]
	);

	// "Create new agent" in the composer's agent picker opens the create dialog
	// rather than a whole editor tab.
	const { openCreateAgent } = useCreateAgentDialog();

	// Per-agent model selection for the composer model picker. Recomputed when
	// the active agent changes; the chosen id is persisted per agent and sent in
	// the chat body. The ref keeps the transport closure reading the live value.
	//
	// Seeded from THIS tab's own agent, not from the last-used one: a tab opened
	// on a specific agent (merged view, launchpad seed) otherwise started on some
	// other agent's model until the first pick.
	const [selectedModel, setSelectedModel] = useState<string | null>(
		() => initialModel ?? getAgentModel(agentId)
	);
	// A streamed control can explicitly clear the model. Keep that distinction
	// from an unset picker value so the fallback model is not reintroduced.
	const [modelSelectionCleared, setModelSelectionCleared] = useState(false);
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
	const handleAttachTextFile = useCallback((attachment: AttachedImage) => {
		setAttachedImages((previous) => [
			...previous,
			{ ...attachment, mimeType: attachment.mimeType ?? "text/plain" },
		]);
		toast.success("CI failure report attached", {
			description: "It will be included with your next message in this chat.",
		});
	}, []);

	// #415: target_agent_id for council @mentions — written by CouncilInputBar on
	// each send and consumed by the transport body closure below.
	const targetAgentIdRef = useRef<string | null>(null);

	// team_id for @group mentions — when set, Core fans the message out to the
	// group's members per its coordination strategy (takes precedence over
	// agent_id/target_agent_id). Reset after each send.
	const teamIdRef = useRef<string | null>(null);

	// Mirror of the persistent group selection for the send-time body closure
	// (assigned every render, like selectedModelRef). The transient `@group`
	// mention in teamIdRef wins for one send, then falls back to this.
	const composerTeamIdRef = useRef<string | null>(null);
	composerTeamIdRef.current = teamId;

	// workflow_id for @workflow mentions — when set, Core runs the workflow with
	// the message as its chat input (takes precedence over agent/team targets).
	// Reset after each send, mirroring teamIdRef.
	const workflowIdRef = useRef<string | null>(null);
	// Chat @mentions are context references, not routing targets. The composer
	// resolves labels to durable ids and hands them to the next request once.
	const referencedConversationIdsRef = useRef<string[]>([]);

	// #415: Current participants list for labelling assistant messages per-agent.
	const [participants, setParticipants] = useState<ConversationParticipant[]>(
		[]
	);

	// #415: Maps assistant-message index (string) to an agent display name for labels.
	const agentLabelMapRef = useRef<Record<string, string>>({});

	// Load agents to inspect the selected agent's transport type.
	const { agents } = useAgents();
	const { apps: registeredApps } = useApps();
	const inboxEnabled = registeredApps.some(
		(app) => app.id === "@ryu/approvals" && app.enabled
	);
	const humanMentionDirectory = useHumanMentionDirectory({
		enabled: inboxEnabled,
	});
	const pullRequestsEnabled = registeredApps.some(
		(app) => app.id === "@ryu/pull-requests" && app.enabled
	);
	// Composio connections are mentionable only when Core reports a configured
	// credential. That same redacted status covers a local BYOK key and a
	// provisioned managed/proxy credential; never infer access from the catalog.
	const composioStatus = useComposioStatus();
	const composioConfigured = composioStatus.data?.configured ?? false;
	const { data: composioConnections = [] } = useComposioConnections(
		"",
		composioConfigured
	);
	const { data: composioToolkits = [] } = useComposioToolkits(
		composioConfigured && composioConnections.length > 0
	);
	// Load groups so @group mentions resolve in the composer autocomplete.
	const { teams } = useTeams();
	// Load workflows so @workflow mentions resolve in the composer autocomplete.
	// Only chat-triggerable ones (a root Input node, per Core) surface in the
	// mention menu; the rest can still be run from the Workflows app.
	const { resume: resumeWorkflow, workflows } = useWorkflows();
	const handleWorkflowResume = useCallback(
		(runId: string, payload: string) => resumeWorkflow(runId, payload),
		[resumeWorkflow]
	);
	// Extra "@" mention sources: spaces, installed skills, MCP servers, connected
	// integrations, and recent project folders. Composer plugins (goal/proof/double-check) come
	// from the client-side registry. See docs/rfc-mention-composer.md.
	const {
		error: spacesError,
		loading: spacesLoading,
		spaces,
	} = useSpacesContext();
	const contributedSections = useMemo(
		() =>
			[...pluginContributions.sidebar_sections].sort(
				(a, b) =>
					(a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title)
			),
		[pluginContributions.sidebar_sections]
	);
	const mentionableResources = useMentionableResources(contributedSections);
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
	const {
		openTab,
		updateTabBusy,
		updateTabWorktreeMode,
		bindTabConversation,
		tabs,
		clearScrollToMessage,
	} = useTabsContext();
	const currentTabId = useCurrentTabId();
	const scrollToMessageId = currentTabId
		? tabs.find((t) => t.id === currentTabId)?.scrollToMessageId
		: undefined;

	// Model options follow the active agent's engine binding. The effective
	// value prefers the explicit in-session pick, then the persisted per-agent
	// choice, then the engine's first option — so the picker always shows what
	// will actually be sent.
	const modelOptions = useMemo(
		() => modelsForAgent(agentId, agents, engineModels),
		[agentId, agents, engineModels]
	);
	const effectiveModel = modelSelectionCleared
		? null
		: ([selectedModel, getAgentModel(agentId)].find(
				(id) => id && modelOptions.some((m) => m.id === id)
			) ??
			modelOptions[0]?.id ??
			null);
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
		if (agent?.avatarGlyph) {
			return { kind: "glyph", glyph: agent.avatarGlyph };
		}
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
		title?: string;
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
			title: agent.title,
			avatar: (
				<Avatar
					className="flex items-center justify-center after:hidden"
					size="sm"
				>
					<AgentAvatar
						className="size-full rounded-full object-contain"
						engine={engineForAgent(agent)}
						glyph={agent.avatarGlyph}
						size="16px"
					/>
				</Avatar>
			),
		};
	}, [agentId, teamId, agents, teams]);

	// The agent-comms transcript renderer uses the same roster and avatar primitive
	// as the main assistant header, so a sender stays recognizable in both places.
	const agentMessageContext = useMemo<AgentMessageContext>(() => {
		const identityForAgent = (
			agent: AgentSummary,
			id = agent.id
		): AgentMessageIdentity => ({
			avatar: (
				<AgentAvatar
					className="size-full rounded-full object-contain"
					engine={engineForAgent(agent)}
					glyph={agent.avatarGlyph}
					size="16px"
				/>
			),
			id,
			name: agent.name,
		});
		const activeAgent = agents.find((agent) => agent.id === agentId);
		const current = activeAgent
			? identityForAgent(activeAgent)
			: {
					avatar: assistantIdentity.avatar,
					id: agentId ?? "agent",
					name: assistantIdentity.name ?? "Agent",
				};

		return {
			current,
			resolve: (id) => {
				const normalizedId = id.startsWith("acp:") ? id.slice(4) : id;
				const agent = agents.find(
					(candidate) => candidate.id === id || candidate.id === normalizedId
				);
				return agent ? identityForAgent(agent, id) : undefined;
			},
		};
	}, [agentId, agents, assistantIdentity]);

	// Marks for the live status row. A team is the case where more than one agent
	// is genuinely on the same turn, so it contributes one mark per member; a
	// single agent contributes its own. Built from the same `agents`/`teams`
	// lookups as the identity above rather than from the transcript, because a
	// turn that has produced nothing yet carries no agent attribution at all —
	// and that is exactly when this row is on screen.
	const assistantPlanningAvatars = useMemo<React.ReactNode[]>(() => {
		// `AgentAvatar` with an explicit 16px class, NOT the `<Avatar size="sm">`
		// wrapper the transcript's per-turn identity uses: that component carries its
		// own size class, which wins over whatever slot it is dropped into, so a row
		// of them would not line up with the 16px status line they sit on. This is
		// the same shape the sidebar's ChatRow draws its agent mark with.
		const mark = (agent: (typeof agents)[number]) => (
			<AgentAvatar
				className="size-4 shrink-0 rounded-[3px] object-contain"
				engine={engineForAgent(agent)}
				glyph={agent.avatarGlyph}
				key={agent.id}
				size="16px"
				thinking
			/>
		);
		if (teamId) {
			const team = teams.find((t) => t.id === teamId);
			const members = (team?.members ?? [])
				.map((id) => agents.find((a) => a.id === id))
				.filter((a): a is (typeof agents)[number] => Boolean(a));
			if (members.length > 0) {
				return members.map(mark);
			}
		}
		const agent = agents.find((a) => a.id === agentId);
		return agent ? [mark(agent)] : [];
	}, [agentId, teamId, agents, teams]);

	// Whether a turn is in flight, for the pick notice below. A ref because the
	// notice callback is created here, above `useChat`'s `status` (assigned into
	// this ref right after that hook), and reading it live would be a TDZ error.
	const turnInFlightRef = useRef(false);
	const [composerSelectionApplyMode] = useComposerSelectionApplyMode();
	const announceComposerSelection = useCallback(
		(setting: string, value: string) => {
			// An idle picker already makes the next message's target obvious. The
			// toast is only useful when a response is in flight and the pick cannot
			// change that response.
			if (!shouldShowComposerSelectionToast(turnInFlightRef.current)) {
				return;
			}
			toast.info({
				id: "ryu-composer-selection-applied",
				title: `${setting}: ${value}`,
				description: composerSelectionToastDescription(
					composerSelectionApplyMode
				),
			});
		},
		[composerSelectionApplyMode]
	);

	const handleModelChange = useCallback(
		(modelId: string) => {
			setModelSelectionCleared(false);
			setSelectedModel(modelId);
			if (agentId) {
				setAgentModel(agentId, modelId);
			}
			announceComposerSelection("Model", modelId);
		},
		[agentId, announceComposerSelection]
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
	// The same shape one level up: session CONFIG values the agent asked the client
	// to update (Core's `data-ryu-acp-config` part). Derived from `messages` below
	// and fed back into the composer hook, which adopts and persists them — so a
	// pick the agent's own action invalidated stops being re-sent next turn. The
	// emission `key` rides along so both sides dedupe on the PART, not the value.
	const [streamedAcpConfig, setStreamedAcpConfig] =
		useState<StreamedAcpConfig | null>(null);
	// Accepted agent-level model/effort controls are conversation-scoped. They
	// feed the shared ACP picker state without mutating the agent's saved defaults.
	const [streamedAcpControl, setStreamedAcpControl] =
		useState<StreamedAcpControl | null>(null);
	// The agent's config option DEFINITIONS as re-published against the LIVE
	// session (Core's `data-ryu-acp-config-options` part) — the answer to
	// `session/set_config_option`, which by protocol returns the whole refreshed
	// set. Distinct from `streamedAcpConfig`, which carries option VALUES.
	//
	// This is the only way an option that exists solely for another option's value
	// (codex reveals its reasoning `effort` list once a model that has one is
	// picked) can reach the pickers against the real session: the probe that
	// otherwise supplies them runs in a throwaway session of its own.
	const [streamedAcpConfigOptions, setStreamedAcpConfigOptions] = useState<
		AcpConfigOption[] | null
	>(null);

	// Changing Approval / Model / Thinking mid-chat is sticky: the pick rides the
	// next request body and Core re-applies it to the live ACP session before that
	// turn's prompt (`apply_turn_config`). The busy-only toast closes the gap where
	// nothing on screen moves, while keeping idle picker changes quiet. One fixed
	// toast slot means dragging the thinking slider replaces in place instead of
	// stacking a toast per detent.
	const handleAcpSelectionApplied = useCallback(
		(setting: string, value: string) => {
			announceComposerSelection(setting, value);
		},
		[announceComposerSelection]
	);

	const acp = useComposerAcpSections({
		agentId,
		agents,
		modelOptions,
		engineModel: effectiveModel,
		onEngineModelChange: handleModelChange,
		onSelectionApplied: handleAcpSelectionApplied,
		preferSimpleApprovalDefaults: interfaceLevel === "simple",
		streamedMode: streamedAcpMode,
		streamedConfig: streamedAcpConfig,
		streamedConfigOptions: streamedAcpConfigOptions,
		streamedControl: streamedAcpControl,
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
	const simpleApprovalDefaultsRef = useRef(acp.simpleApprovalDefaults);
	simpleApprovalDefaultsRef.current = acp.simpleApprovalDefaults;

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
			userJwt: activeNodeForTools.userJwt ?? null,
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
		conversations,
		setActiveConversationId,
		createConversation,
		getConversation,
		loadMessages,
		loadMessagesResult,
		loadMessagesPageResult,
		forkConversation,
		editMessage,
		regenerateMessage,
		selectVersion,
		seedTitleFromFirstMessage,
		setConversationFolder,
		refresh,
	} = useChatHistoryContext();

	// Version-tree state (ChatGPT/Claude edit + regenerate branching), keyed by
	// message id: how many versions exist at this branch point, which is active,
	// and the ordered sibling ids the pager steps through. Populated from Core's
	// active-path read on every (re)hydration; empty for never-branched threads.
	const [versions, setVersions] = useState<
		Record<string, { index: number; count: number; ids: string[] }>
	>({});
	// Persisted Learning action state for the active conversation, keyed by
	// assistant message id. The Learning plugin contributes the toolbar control;
	// the shell only hydrates and optimistically mirrors its durable state.
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
	const [chatSearch, setChatSearch] = useState<ChatSearchState>({
		mode: "chat",
		nonce: 0,
		open: false,
		query: "",
	});
	const [activeChatSearchMatchIndex, setActiveChatSearchMatchIndex] =
		useState(0);
	const fileSearchRequest = useMemo(
		() =>
			chatSearch.open && chatSearch.mode === "files"
				? { nonce: chatSearch.nonce, query: chatSearch.query }
				: null,
		[chatSearch]
	);
	useEffect(() => {
		setChatSearch((current) =>
			current.open
				? {
						...current,
						mode: "chat",
						nonce: current.nonce + 1,
						open: false,
						query: "",
					}
				: current
		);
		setActiveChatSearchMatchIndex(0);
	}, [convId]);
	// Agent-level controls are scoped to the conversation that emitted them. Do
	// not carry a model/effort override into a different thread that happens to
	// use the same agent.
	useEffect(() => {
		setModelSelectionCleared(false);
		setStreamedAcpControl(null);
	}, [convId]);
	// Existing conversations own their folder. New chats may still use the
	// optional global selection, but a loaded chat must never be retargeted when
	// another tab changes that selection.
	const chatFolder = convId
		? (getConversation(convId)?.folderPath ?? null)
		: (folder ?? localProjectlessTaskFolder);
	const chatFolderRef = useRef<string | null>(chatFolder);
	chatFolderRef.current = chatFolder;

	// Restore state for THIS tab's thread. Seeded `true` whenever the tab is
	// restored onto an existing conversation: the first paint happens before the
	// hydration effect below has even fired, and a tab that reports "not loading,
	// no messages" in that window renders the new-chat greeting — the "all my
	// chats are gone" screen the boot bug is actually about. A fresh chat has no
	// conversation id and therefore never enters this state.
	const [historyLoading, setHistoryLoading] = useState(
		Boolean(tabConversationId)
	);
	// The fetch came back as a transport/HTTP failure. Distinct from "loaded and
	// empty" — the thread exists, this node just could not be reached.
	const [historyFailed, setHistoryFailed] = useState(false);
	// Reload nonce: bumping it re-runs the hydration effect for the Try-again
	// button without touching the auto-refresh paths.
	const [historyReloadKey, setHistoryReloadKey] = useState(0);
	// History opens on the newest page. The cursor is kept in a ref so scrolling
	// can request another page without making the transcript callback churn.
	const [hasOlderMessages, setHasOlderMessages] = useState(false);
	const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
	const olderMessagesCursorRef = useRef<string | null>(null);
	const hasOlderMessagesRef = useRef(false);
	const olderMessagesRequestRef = useRef(false);
	hasOlderMessagesRef.current = hasOlderMessages;

	// ── Merged agent view ────────────────────────────────────────────────────
	// Older threads with this agent, rendered read-only above the live one. The
	// live thread is still a single conversation driven by `useChat`; only the
	// transcript above it is stitched, so streaming, editing and branching keep
	// working unchanged on the thread the composer is pointed at.
	const merged = useMergedAgentThreads({
		agentId: mergedAgentId ?? null,
		enabled: Boolean(mergedAgentId),
		liveConversationId: convId,
	});
	// Opening the view lands on the newest thread — the messaging-app default of
	// "continue where we left off".
	//
	// The latch trips the first time a thread list EXISTS, not the first time a
	// thread is selected. The conversation list is empty until Core's first fetch
	// resolves, so a latch that only trips on success would still be armed if the
	// user hit "New thread" in that window (or on a later reconnect refresh) — and
	// would then yank them out of their empty thread into the newest one.
	const mergedSeeded = useRef(false);
	useEffect(() => {
		if (!mergedAgentId || mergedSeeded.current || merged.threads.length === 0) {
			return;
		}
		mergedSeeded.current = true;
		if (convId) {
			return;
		}
		setConvId(merged.threads[0].id);
	}, [mergedAgentId, convId, merged.threads]);

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

	const chatTarget: ApiTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token]
	);
	const [projectDrafts, setProjectDrafts] = useState<
		import("@ryu/blocks/desktop/agent-elements/input-bar").ComposerDraftItem[]
	>([]);
	const refreshProjectDrafts = useCallback(async () => {
		try {
			const rows = await listDrafts(chatTarget);
			setProjectDrafts(
				rows
					.filter(
						(draft) =>
							(draft.folder_path ?? undefined) === (chatFolder ?? undefined)
					)
					.map((draft) => ({
						id: draft.id,
						preview: draft.preview,
						text: draft.text,
					}))
			);
		} catch {
			setProjectDrafts([]);
		}
	}, [chatFolder, chatTarget]);
	useEffect(() => {
		void refreshProjectDrafts();
	}, [refreshProjectDrafts]);
	const draftControls = useMemo(
		() => ({
			items: projectDrafts,
			onDelete: (id: string) => {
				void deleteDraft(chatTarget, id).then(refreshProjectDrafts);
			},
			onInsert: () => {},
			onSave: (text: string) => {
				void saveDraft(chatTarget, {
					text,
					folder_path: chatFolder ?? undefined,
					source: "manual",
				}).then(refreshProjectDrafts);
			},
		}),
		[chatFolder, chatTarget, projectDrafts, refreshProjectDrafts]
	);

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
	const [voiceInputEngine, setVoiceInputEngine] = useState<
		string | undefined
	>();
	useEffect(() => {
		let cancelled = false;
		const load = () => {
			getVoiceInputPrefs(chatTarget)
				.then((prefs) => {
					if (!cancelled) {
						setVoiceInputEngine(prefs.engine);
					}
				})
				.catch(() => undefined);
		};
		load();
		const unsubscribe = subscribePreferenceChanges((key) => {
			if (key === VOICE_PREF_KEY) {
				load();
			}
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [chatTarget]);
	const voiceTranscribe = useCallback(
		(audio: Blob) =>
			transcribeAudio(
				chatTargetRef.current,
				audio,
				"recording.wav",
				voiceInputEngine
			),
		[voiceInputEngine]
	);

	// #415: Load the conversation's participants so assistant messages can still be
	// labelled per-agent. (The in-composer "add agent" control was removed in favour
	// of agent groups, but legacy multi-agent conversations keep their attribution.)
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
	const realtimeClientIdRef = useRef(createRealtimeClientId());
	// Latest convId reachable from the once-created transport body closure below.
	const convIdRef = useRef<string | null>(convId);
	convIdRef.current = convId;

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
	const [goalState, setGoalState] = useState<GoalState | null>(null);
	const [goalDraftOpen, setGoalDraftOpen] = useState(false);
	const [goalCompletionMessageId, setGoalCompletionMessageId] = useState<
		string | null
	>(null);

	useEffect(() => {
		if (!convId) {
			setGoalState(null);
			setGoalCompletionMessageId(null);
			return;
		}
		let cancelled = false;
		getGoal(chatTarget, convId)
			.then((next) => {
				if (!cancelled) {
					setGoalState(next.goal ? next : null);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setGoalState(null);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [chatTarget, convId]);

	// Generic plugin composer toggles (`composer_controls`): a flag→on map keyed by
	// each control's `flag`. Held in state (drives the toggle's rendered `enabled`)
	// plus a ref the once-created transport body closure reads when merging the
	// per-request `plugin_flags` — same pattern as the double-check flag above.
	const [pluginFlags, setPluginFlags] = useState<Record<string, boolean>>(
		() => ({ ...initialPluginFlags })
	);
	const pluginFlagsRef = useRef<Record<string, boolean>>({});
	pluginFlagsRef.current = pluginFlags;

	// One-shot flags marked by an `action` composer control when it fires. Kept in
	// a ref rather than state (the button holds no visual state) and CONSUMED by
	// the next request's body, exactly like `skipNextUserAppendRef`: a button press
	// belongs to the turn it precedes, not to every turn after it.
	const pendingActionFlagsRef = useRef<Record<string, boolean>>({});
	const firePluginActionFlag = useCallback((flag: string) => {
		pendingActionFlagsRef.current = {
			...pendingActionFlagsRef.current,
			[flag]: true,
		};
	}, []);

	// Temporary chat: when on, every turn is sent with `persist: false` so Core
	// writes nothing to the conversation store, and a temporary chat is never
	// registered in the sidebar history — it lives only in this tab's memory and is
	// gone on close or when a fresh chat starts. Ryu's incognito thread. A ref
	// mirrors the toggle so the once-created transport body closure reads the live
	// value (same pattern as the double-check flag above).
	// Seeded from the tab when the launchpad's "+" turned it on before this thread
	// existed, so the very first turn is already unsaved (flipping it after mount
	// would be too late — the turn would have persisted).
	const [ghostMode, setGhostMode] = useState(Boolean(initialGhost));
	// A launchpad-seeded temporary chat may render before the contribution fetch lands.
	// Keep that initial privacy behavior until the feed settles, then require the
	// plugin declaration for every subsequent temporary-chat turn.
	const ghostChatActive =
		ghostMode &&
		(ghostChatsPluginEnabled ||
			(Boolean(initialGhost) && !pluginContributionsSettled));
	const ghostModeRef = useRef(false);
	ghostModeRef.current = ghostChatActive;
	useEffect(() => {
		if (pluginContributionsSettled && !ghostChatsPluginEnabled && ghostMode) {
			setGhostMode(false);
		}
	}, [ghostChatsPluginEnabled, ghostMode, pluginContributionsSettled]);

	// Write this tab's thread back onto its Tab record. A tab opened blank ("New
	// chat") only learns its conversation id on the first send, and nothing used
	// to tell TabsContext — so the tab stayed unbound for its whole life:
	// session restore reopened it EMPTY (the thread was only reachable from the
	// sidebar), and a sidebar click on that same thread missed `openTab`'s
	// conversation dedup and stacked a SECOND tab on it. Two chat tabs on one
	// conversation share a single `useChat({ id })` instance, so the late mount's
	// blank state clobbers the live one and both stop updating — the "opened it
	// again and the new tab is broken" report.
	//
	// A temporary thread never binds: it must leave no durable trace, and
	// a persisted binding would restore a tab pointing at a conversation Core
	// never wrote. Unbinding is equally load-bearing — a tab that starts a fresh
	// thread must drop its old id, or a click on the OLD conversation would dedup
	// onto a tab that is showing something else.
	//
	// The binding carries the id only, never a title: the tab label already has a
	// single writer (`useTitleBar` → `updateTabTitle`, below), and a second one
	// here would race it for ghost threads ("Temporary chat" vs the default).
	const boundConversationId = ghostChatActive
		? undefined
		: (convId ?? undefined);
	useEffect(() => {
		if (!currentTabId) {
			return;
		}
		bindTabConversation(currentTabId, boundConversationId);
	}, [currentTabId, boundConversationId, bindTabConversation]);

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
		clearError,
	} = useChat({
		id: chatId,
		transport: new DefaultChatTransport({
			api: chatStreamUrl(chatTarget),
			// Developer-mode turn timing (time-to-first-token, stream duration,
			// bytes). A plain `fetch` when metrics are off — see lib/dev-metrics.ts.
			fetch: instrumentedFetch,
			// Forward the user-identity JWT alongside the node token so Core can
			// verify WHO sent this turn and stamp `author_user_id` on the persisted
			// message — the value the realtime fan-out uses to attribute it to a
			// human for other viewers. `null` when signed out: no header, anonymous
			// turn (author stays NULL), single-user flow unchanged.
			headers: async (): Promise<Record<string, string>> => {
				const base = chatHeaders(chatTarget);
				const jwt = await getRealtimeJwt();
				const identityHeaders = realtimeClientIdRef.current
					? { ...base, "X-Ryu-Client-Id": realtimeClientIdRef.current }
					: base;
				return jwt
					? { ...identityHeaders, "X-Ryu-User-Jwt": jwt }
					: identityHeaders;
			},
			body: () => {
				const ws = useWorkspaceStore.getState();
				const selectedFolder = chatFolderRef.current;
				const project = selectedFolder
					? findWorkspaceProject(ws.projects, selectedFolder)
					: undefined;
				const cwd = project?.folders[0] ?? selectedFolder ?? undefined;
				const sourceFolders = project?.folders ?? (cwd ? [cwd] : []);
				const environmentId = cwd
					? ws.activeProjectEnvironments[cwd]
					: undefined;
				const projectEnvironment = cwd
					? ws.projectEnvironments[cwd]?.find(
							(environment) => environment.id === environmentId
						)
					: undefined;
				// Consume the one-shot skip flag: read then immediately reset so it
				// applies to exactly this request (the edit/regenerate re-run) and no
				// subsequent normal send.
				const skipUserAppend = skipNextUserAppendRef.current;
				skipNextUserAppendRef.current = false;
				// Same consume-once treatment for the flags an `action` composer
				// control marked when it fired: they belong to this turn, and leaving
				// them set would make the owning plugin's hook act on every later one.
				const firedActionFlags = pendingActionFlagsRef.current;
				pendingActionFlagsRef.current = {};
				const referencedConversationIds = referencedConversationIdsRef.current;
				referencedConversationIdsRef.current = [];
				// Persistent-session worktree: opt-in via the workspace bar's run
				// mode (not auto-on per folder). When enabled, Core creates an
				// isolated worktree on the first message and reuses it across turns,
				// capturing the aggregate diff (fetched by DiffReviewPane).
				const useWorktree =
					tabWorktreeMode ?? (Boolean(cwd) && ws.worktreeMode);
				const routingFields = modelRoutingFieldsForInterface(interfaceLevel, {
					model: selectedModelRef.current,
					acpMode: acpModeRef.current,
					acpConfig: acpOptionValuesRef.current,
					acpModel: acpModelRef.current,
					simpleApprovalDefaults: simpleApprovalDefaultsRef.current,
				});
				return {
					agent_id: agentId,
					response_mode: responseModeForInterface(interfaceLevel),
					conversation_id: convIdRef.current ?? draftConvId.current,
					referenced_conversation_ids:
						referencedConversationIds.length > 0
							? referencedConversationIds
							: undefined,
					// A temporary chat must leave no durable trace, so it never
					// records the turn into long-term cross-session memory — regardless of
					// the user's standing long-term-memory preference.
					enable_long_term: ghostModeRef.current
						? false
						: longTermMemoryRef.current,
					cwd,
					workspace_folders:
						sourceFolders.length > 1 ? sourceFolders : undefined,
					worktree_isolation: useWorktree,
					// Desired branch for the worktree Core creates on the first turn
					// (sanitized server-side; ignored when reusing an existing one).
					worktree_branch: useWorktree ? ws.worktreeBranch : undefined,
					project_environment: projectEnvironment
						? {
								name: projectEnvironment.name,
								setup: projectEnvironment.setup,
								cleanup: projectEnvironment.cleanup,
								variables: projectEnvironment.variables.map(
									({ key, value }) => ({
										key,
										value,
									})
								),
							}
						: undefined,
					// #415: Pass the @mention target agent id when the user directed the
					// message at a specific conversation participant.
					target_agent_id: targetAgentIdRef.current ?? undefined,
					// When the user @-mentioned a team, Core fans out to its members.
					// The transient mention wins for one send; otherwise the persistent
					// composer team pick applies.
					team_id: teamIdRef.current ?? composerTeamIdRef.current ?? undefined,
					// When the user @-mentioned a workflow, Core runs it with this
					// message as its chat input. Resets after each send. A workflow
					// target is the most specific intent, so it is sent alongside
					// (Core's `workflow_id` branch ignores agent/team).
					workflow_id: workflowIdRef.current ?? undefined,
					// Ryu Work keeps the chosen agent visible but lets Core own model
					// routing. Code sends the user's explicit model/ACP controls.
					...routingFields,
					// Per-request plugin flags (every plugin-contributed composer toggle,
					// double-check included). The plugin turn-hook runtime passes these to
					// each hook; a plugin acts only when its flag is set.
					plugin_flags: buildPluginFlags({
						...pluginFlagsRef.current,
						...firedActionFlags,
					}),
					// Temporary chat: never write this turn to the conversation
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

	// A failed model call already persisted the user turn. Clear the AI SDK's
	// terminal error, mark this as a re-run (so Core does not append that user row
	// twice), and let the transport resend the same turn.
	const handleRetryError = useCallback(async () => {
		clearError();
		skipNextUserAppendRef.current = true;
		await regenerate();
	}, [clearError, regenerate]);

	// The goal hook evaluates after the assistant turn finishes. Refresh the
	// durable state at that boundary so the completion status lands on the turn
	// that actually achieved it rather than waiting for a tab reload.
	const goalWasStreamingRef = useRef(false);
	useEffect(() => {
		const streaming = status !== "ready";
		if (goalWasStreamingRef.current && !streaming && convIdRef.current) {
			const targetConversationId = convIdRef.current;
			void getGoal(chatTarget, targetConversationId)
				.then((next) => {
					if (convIdRef.current !== targetConversationId) {
						return;
					}
					setGoalState(next.goal ? next : null);
					if (next.status === "achieved") {
						const lastAssistantMessage = [...messages]
							.reverse()
							.find((message) => message.role === "assistant");
						setGoalCompletionMessageId(lastAssistantMessage?.id ?? null);
					} else {
						setGoalCompletionMessageId(null);
					}
				})
				.catch(() => undefined);
		}
		goalWasStreamingRef.current = streaming;
	}, [chatTarget, messages, status]);

	// Side chats receive the transcript currently visible in this tab, rather than
	// relying only on Core's persisted copy. That keeps a `/btw` asked during an
	// in-flight reply aware of the latest assistant text as well as older turns.
	const sideChatMessages = useMemo<BtwMessage[]>(
		() => buildSideChatContext(messages),
		[messages]
	);

	// Goal-setting is a UI action rather than a model turn, but it still belongs in
	// the transcript as a user-authored message. Metadata keeps the annotation out
	// of the text sent to the agent while the shared UserMessage renders it beside
	// the normal copy toolbar.
	const goalMessageSequenceRef = useRef(0);
	const appendGoalMessage = useCallback(
		(text: string) => {
			const id = `goal-${Date.now()}-${goalMessageSequenceRef.current}`;
			goalMessageSequenceRef.current += 1;
			setMessages((prev) => [
				...prev,
				{
					id,
					metadata: { goal: true },
					parts: [{ text, type: "text" as const }],
					role: "user" as const,
				} as (typeof prev)[number],
			]);
		},
		[setMessages]
	);
	const handleGoalSubmit = useCallback(
		(text: string) => {
			const targetConversationId = convId;
			if (!targetConversationId) {
				setGoalDraftOpen(false);
				return;
			}
			void setGoal(chatTarget, targetConversationId, text)
				.then((next) => {
					if (convIdRef.current !== targetConversationId) {
						return;
					}
					setGoalState(next);
					setGoalCompletionMessageId(null);
					setGoalDraftOpen(false);
					appendGoalMessage(text);
				})
				.catch(() => undefined);
		},
		[appendGoalMessage, chatTarget, convId]
	);
	const handleGoalClear = useCallback(() => {
		if (!convId) {
			setGoalState(null);
			setGoalCompletionMessageId(null);
			setGoalDraftOpen(false);
			return;
		}
		void clearGoal(chatTarget, convId).then(() => {
			setGoalState(null);
			setGoalCompletionMessageId(null);
			setGoalDraftOpen(false);
		});
	}, [chatTarget, convId]);
	const handleGoalPause = useCallback(() => {
		if (!convId) {
			return;
		}
		void pauseGoal(chatTarget, convId)
			.then((next) => {
				setGoalState(next);
				setGoalCompletionMessageId(null);
			})
			.catch(() => undefined);
	}, [chatTarget, convId]);
	const handleGoalResume = useCallback(() => {
		if (!convId) {
			return;
		}
		void resumeGoal(chatTarget, convId)
			.then((next) => {
				setGoalState(next);
				setGoalCompletionMessageId(null);
			})
			.catch(() => undefined);
	}, [chatTarget, convId]);

	// Ryu Apps widget host (U7). The desktop is the TRUSTED side: it holds the Core
	// token and performs the Gateway-governed round-trips on a widget's behalf. The
	// follow-up is first gated by Core, then its returned prompt is submitted via
	// this same useChat handle so the normal transport supplies the live
	// conversation and agent context.
	const widgetHostValue = useMemo<WidgetHostValue>(() => {
		const services: WidgetHostServices = {
			callTool: (input) => widgetCallTool(chatTarget, input),
			sendFollowUpMessage: (input) =>
				submitWidgetFollowUp(chatTarget, input, (message, options) =>
					sendMessage(message, options)
				),
			setWidgetState: (input) => widgetSetState(chatTarget, input),
		};
		return {
			// The two shell facts the shared renderer can't derive: how this app
			// opens a real browser, and which node origin proxies widget assets.
			env: {
				openExternal: (href: string) => openExternal(href),
				proxyOrigin: chatTarget.url,
			},
			Renderer: AppWidget,
			services,
		};
	}, [chatTarget, sendMessage]);

	// Feeds the session-control pick notice above, which is defined before this
	// hook (it is passed into the composer's ACP sections) and so cannot read
	// `status` directly.
	turnInFlightRef.current = status === "streaming" || status === "submitted";

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
	// The generation itself, against an assistant message that ALREADY exists.
	// Split out from the handler below so a failed generation can be re-run in
	// place (see `handleRetryGeneration`) instead of echoing the prompt a second
	// time. Core has no progress events for this path, so the status goes straight
	// from `generating` to `complete`/`error` — no fabricated intermediate steps.
	const runImageGeneration = useCallback(
		async (assistantId: string, prompt: string) => {
			const settle = (parts: unknown[]) => {
				setMessages((prev) =>
					prev.map((m) =>
						m.id === assistantId ? ({ ...m, parts } as typeof m) : m
					)
				);
			};
			// Back to the in-flight frame first: on a retry the message still holds
			// the failed part, and the frame must reserve its box again.
			settle([
				{
					type: "data-image-generation",
					data: { status: "generating", prompt },
				},
			]);
			try {
				const urls = await generateImage(chatTargetRef.current, prompt);
				const [first, ...rest] = urls;
				if (!first) {
					settle([
						{
							type: "data-image-generation",
							data: {
								status: "error",
								prompt,
								statusText: "The image engine returned no image.",
							},
						},
					]);
					return;
				}
				// The first image drives the generation surface; any extras (n > 1)
				// ride along as plain file parts, which render in the same frame.
				settle([
					{
						type: "data-image-generation",
						data: { status: "complete", prompt, url: first },
					},
					...rest.map((url) => ({
						type: "file",
						mediaType: "image/png",
						url,
					})),
				]);
			} catch (e) {
				settle([
					{
						type: "data-image-generation",
						data: {
							status: "error",
							prompt,
							statusText:
								e instanceof Error ? e.message : "Could not generate image.",
						},
					},
				]);
			}
		},
		[setMessages]
	);

	const handleGenerateImage = useCallback(
		async (prompt: string) => {
			const userId = `img-user-${Date.now()}`;
			const assistantId = `img-${Date.now()}`;
			// Echo the prompt as a user bubble, and reserve the image frame in the
			// same tick: MessageList renders a `data-image-generation` part through
			// the ImageGeneration surface, so the turn shows the generation running
			// and the finished image fades into an already-sized frame.
			setMessages((prev) => [
				...prev,
				{
					id: userId,
					role: "user",
					parts: [{ type: "text", text: prompt }],
				} as (typeof prev)[number],
				{
					id: assistantId,
					role: "assistant",
					parts: [
						{
							type: "data-image-generation",
							data: { status: "generating", prompt },
						},
					],
				} as unknown as (typeof prev)[number],
			]);
			await runImageGeneration(assistantId, prompt);
		},
		[runImageGeneration, setMessages]
	);

	// The video twin of `runImageGeneration`, on the matching
	// `data-video-generation` part. The sdcpp vid_gen response shape is
	// best-effort (see lib/api/video.ts) — an empty result keeps the frame and
	// says which model to load, rather than dropping a bare error card.
	const runVideoGeneration = useCallback(
		async (assistantId: string, prompt: string) => {
			const settle = (parts: unknown[]) => {
				setMessages((prev) =>
					prev.map((m) =>
						m.id === assistantId ? ({ ...m, parts } as typeof m) : m
					)
				);
			};
			settle([
				{
					type: "data-video-generation",
					data: { status: "generating", prompt },
				},
			]);
			try {
				const clips = await generateVideo(chatTargetRef.current, prompt);
				const [first, ...rest] = clips;
				if (!first) {
					settle([
						{
							type: "data-video-generation",
							data: {
								status: "error",
								prompt,
								statusText:
									"The engine returned no video. Load a video model (Wan/LTX) in the sdcpp engine and try again.",
							},
						},
					]);
					return;
				}
				// Same split as images: the first clip drives the generation surface,
				// extras ride along as file parts (which render in the same frame).
				settle([
					{
						type: "data-video-generation",
						data: { status: "complete", prompt, url: first.url },
					},
					...rest.map((clip) => ({
						type: "file",
						mediaType: clip.mediaType,
						url: clip.url,
					})),
				]);
			} catch (e) {
				settle([
					{
						type: "data-video-generation",
						data: {
							status: "error",
							prompt,
							statusText:
								e instanceof Error ? e.message : "Could not generate video.",
						},
					},
				]);
			}
		},
		[setMessages]
	);

	// Multimodal: generate a video from the composer text, surfaced inline exactly
	// like the image path. Client-only (not persisted).
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
				{
					id: assistantId,
					role: "assistant",
					parts: [
						{
							type: "data-video-generation",
							data: { status: "generating", prompt },
						},
					],
				} as unknown as (typeof prev)[number],
			]);
			await runVideoGeneration(assistantId, prompt);
		},
		[runVideoGeneration, setMessages]
	);

	// Retry a FAILED inline generation. Not `handleRegenerateMessage`: that one
	// branches a persisted turn server-side, and these parts are client-only (Core
	// never wrote them to the conversation store), so there is nothing to branch.
	// The narrowest correct call is re-running the same generator against the same
	// assistant message — no second user echo, no new bubble.
	const handleRetryGeneration = useCallback(
		(messageId: string, kind: "image" | "video", prompt: string) => {
			const run = kind === "video" ? runVideoGeneration : runImageGeneration;
			void run(messageId, prompt);
		},
		[runImageGeneration, runVideoGeneration]
	);

	// Speak an assistant reply via Core, honouring the Voice-tab Audio preference.
	// The shared owner keeps replacement/toggle/unmount cleanup identity-safe.
	const { play: playSpeech } = useSpeechPlayback();
	const handleSpeak = useCallback(
		async (text: string) => {
			const trimmed = text.trim();
			if (!trimmed) {
				return;
			}
			await playSpeech(trimmed, () => {
				const prefs = getDesktopTtsPrefs();
				return speakText(chatTargetRef.current, trimmed, {
					engine: prefs.engine,
					voice: prefs.voice || undefined,
				});
			});
		},
		[playSpeech]
	);
	const handleSpeakRef = useRef(handleSpeak);
	handleSpeakRef.current = handleSpeak;
	const desktopTts = getDesktopTtsPrefs();
	// ChatGPT-style continuous voice mode (its own separate entry point — the
	// composer mic above stays as push-to-talk voice INPUT). All realtime logic
	// (VAD, endpointing, barge-in) lives in Core; this reflects it into the overlay.
	const voiceMode = useVoiceMode(chatTarget, {
		conversationId: activeConversationId ?? undefined,
		sttEngine: voiceInputEngine,
		ttsEngine: desktopTts.engine,
		ttsVoice: desktopTts.voice || undefined,
	});
	const voiceModeSlot: ChatVoiceMode = voiceMode.active
		? {
				active: true,
				render: (composer: ReactNode) => (
					<VoiceModeSurface composer={composer} voice={voiceMode} />
				),
			}
		: { active: false };

	// Interactive ACP tool-permission prompts. When an agent in a gating mode
	// asks to run a tool, Core streams a `data-ryu-permission` part; we surface
	// the latest unresolved one in the shared composer surface and POST the user's choice
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

	// Deliver a decision for one permission request. Keeping the request id in
	// this callback makes the composer card answer the exact gate that is on
	// screen, even if another stream update arrives while it is open.
	const respondToPermission = useCallback(
		(requestId: string, optionId: string | null) => {
			setResolvedPermissions((prev) => {
				if (prev.has(requestId)) {
					return prev;
				}
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
		[]
	);

	// Every unresolved permission is presented in the same composer surface as
	// structured questions. The transcript keeps the tool row as history, while
	// this active card owns the one decision that can unblock the turn.
	const composerPermission = activePermission;

	// Slash commands contributed by enabled Core plugins (e.g. `/proof` from the
	// proof-of-work turn-hook plugin). Core tags each with its owning `plugin` id
	// and returns the full `command` text (leading "/"); the popover works off the
	// bare name, so strip it. These are plain messages at submit time — Core's
	// turn-hook interprets them — so nothing client-side handles them here.
	const handleOpenFileLink = useCallback(
		(mentionedPath: string) => {
			const path = resolveWorkspaceFilePath(chatFolder, mentionedPath);
			if (!path) {
				toast.error("That file is outside the current workspace.");
				return;
			}
			openTab(`/file/${encodeURIComponent(path)}`, { title: basename(path) });
		},
		[chatFolder, openTab]
	);
	const handleOpenWebsiteLink = useCallback(
		async (href: string) => {
			const opened = await openContributedLink(
				chatTarget,
				pluginContributions.dock_panels,
				href
			).catch(() => null);
			if (opened) {
				useDockPanelRequestStore.getState().open(opened.kind, opened.label);
				return;
			}
			await openExternal(href).catch(() => undefined);
		},
		[chatTarget, pluginContributions.dock_panels]
	);
	const handleOpenMention = useCallback(
		(item: AgentElementMentionItem) => {
			if (item.target) {
				openTab(item.target.path, {
					...item.target.options,
					title: item.label,
				});
				return;
			}
			if (!item.id) {
				openTab("/store", { title: item.label });
				return;
			}
			switch (item.kind) {
				case "agent":
					openTab(`/agents/${encodeURIComponent(item.id)}/edit`, {
						title: item.label,
					});
					break;
				case "app": {
					const companion = pluginContributions.companions.find(
						(entry) => entry.pluginId === item.id
					);
					openTab(companion ? pluginCompanionPath(companion.id) : "/apps", {
						title: item.label,
					});
					break;
				}
				case "chat":
					openTab("/chat", {
						conversationId: item.id,
						title: item.label,
					});
					break;
				case "folder":
					openTab(`/project/files/${encodeURIComponent(item.id)}`, {
						title: basename(item.id),
					});
					break;
				case "integration":
					openTab("/store/integrations", { title: item.label });
					break;
				case "mcp":
					openTab(`/store/mcp/q/${encodeURIComponent(item.id)}`, {
						title: item.label,
					});
					break;
				case "plugin":
					openTab("/extensions", { title: item.label });
					break;
				case "skill":
					openTab("/skills", { title: item.label });
					break;
				case "space":
					openTab(`/spaces/${encodeURIComponent(item.id)}`, {
						title: item.label,
					});
					break;
				case "page":
					openTab("/spaces", { title: item.label });
					break;
				case "app-item":
					openTab("/apps", { title: item.label });
					break;
				case "output-style":
					openTab("/library/agent", { title: item.label });
					break;
				case "team":
					openTab("/library/team", { title: item.label });
					break;
				case "workflow":
					openTab(`/workflows/${encodeURIComponent(item.id)}`, {
						title: item.label,
					});
					break;
				default:
					openTab("/store", { title: item.label });
			}
		},
		[openTab, pluginContributions.companions]
	);
	const linkPreviewResolvers = useMemo(
		() => ({
			previewWebsite: previewLinkMetadata,
			previewFile: async (mentionedPath: string) => {
				const path = resolveWorkspaceFilePath(folder, mentionedPath);
				if (!path) {
					return null;
				}
				const content = await readProjectFile(path);
				const snippet = content
					.split("\n")
					.slice(0, 24)
					.join("\n")
					.slice(0, 6000);
				return { name: basename(path), path, snippet };
			},
		}),
		[folder]
	);
	const pluginSlashCommands = useMemo<SlashCommand[]>(() => {
		const out: SlashCommand[] = [];
		for (const entry of pluginContributions.slash_commands) {
			const command = parseSlashCommandContribution(entry);
			if (command) {
				out.push(command);
			}
		}
		return out;
	}, [pluginContributions.slash_commands]);

	// Contributed per-message toolbar actions (`contributes.message_actions`),
	// passed into blocks presentationally. The shell dispatches each through its
	// renderer or the owning plugin's granted host seam when fired.
	const contributedMessageActions = useMemo(() => {
		return pluginContributions.message_actions.map((a) => ({
			args: a.args,
			id: a.id,
			label: a.label,
			icon: a.icon,
			kind: a.kind,
			target: a.target,
			states: a.states,
			capability: a.capability,
			order: a.order,
			plugin: a.plugin,
		}));
	}, [pluginContributions.message_actions]);

	// Contributed actions for the floating text-selection toolbar. Blocks renders
	// these presentationally; the shell keeps the selected text and dispatch rules
	// on this side of the plugin boundary.
	const contributedSelectionActions = useMemo<ContributedSelectionAction[]>(
		() =>
			pluginContributions.selection_actions.map((a: PluginSelectionAction) => ({
				args: a.args,
				capability: a.capability,
				icon: a.icon,
				id: a.id,
				kind: a.kind,
				label: a.label,
				order: a.order,
				plugin: a.plugin,
			})),
		[pluginContributions.selection_actions]
	);

	// Slash commands the active agent advertised over ACP. Core streams the full
	// list (each update replaces the last) as a `data-ryu-acp-commands` part; we
	// take the most recent one across the thread. Combined with Ryu's own local
	// commands and enabled plugins' contributed commands to drive the composer's
	// "/" popover. Plugin commands are deduped by name against ACP + local ones,
	// which win; enabled installed Skills are appended after those commands and
	// lose any id collision so a real command always keeps its handler.
	const composerCommands = useMemo<SlashCommand[]>(() => {
		const withPlugins = (base: SlashCommand[]): SlashCommand[] => {
			const seen = new Set(base.map((c) => c.name));
			const extra = pluginSlashCommands.filter((c) => !seen.has(c.name));
			return [...base, ...extra];
		};
		const withSkills = (base: SlashCommand[]): SlashCommand[] =>
			mergeComposerCommands(withPlugins(base), installedSkills);
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
					args: [],
					name: c.name,
					description: c.description ?? "",
					hint: c.hint ?? null,
					source: "agent",
				}));
				return withSkills([...agentCommands, ...LOCAL_SLASH_COMMANDS]);
			}
		}
		return withSkills(LOCAL_SLASH_COMMANDS);
	}, [installedSkills, messages, pluginSlashCommands]);

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

	// The agent refused a turn because its login lapsed (Core's
	// `data-ryu-acp-auth-required`, raised from JSON-RPC -32000). Core deliberately
	// does NOT send this down the error path: that one tears the turn down with
	// advice about configuring a model, which cannot fix an expired OAuth token
	// and hides the real cause.
	//
	// Surfaced as an actionable toast rather than an inline block: the recovery is
	// a single login the desktop already owns, and the turn can simply be re-run
	// afterwards. Keyed on the emitting part so one lapse prompts once, not on
	// every re-render of the transcript.
	const authPromptedRef = useRef<string | null>(null);
	const latestAuthRequired = useMemo<{
		agentId: string;
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
				if (part?.type !== "data-ryu-acp-auth-required") {
					continue;
				}
				const data = part.data as
					| { agentId?: string; message?: string }
					| undefined;
				if (data?.agentId) {
					return {
						agentId: data.agentId,
						message: data.message ?? "",
						key: `${m.id}:${j}`,
					};
				}
			}
		}
		return null;
	}, [messages]);
	useEffect(() => {
		if (
			!latestAuthRequired ||
			authPromptedRef.current === latestAuthRequired.key
		) {
			return;
		}
		authPromptedRef.current = latestAuthRequired.key;
		const { agentId: staleAgent } = latestAuthRequired;
		let cancelled = false;
		// Ask the agent which login methods it advertises before offering one —
		// the method id is agent-specific and there is no useful default.
		fetchAcpConfig(chatTarget, staleAgent)
			.then((cfg) => {
				if (cancelled) {
					return;
				}
				const method = cfg?.authMethods?.[0];
				if (!method) {
					toast.error({
						title: "The agent needs you to log in again",
						description:
							latestAuthRequired.message ||
							"Its session expired, and it advertises no login method.",
					});
					return;
				}
				toast.warning({
					title: "Your agent login expired",
					description: "Log in again, then re-send your message.",
					// Held open: a login prompt that auto-dismisses while the user is
					// reading it leaves them with a dead turn and no explanation.
					duration: null,
					button: {
						title: method.name ?? "Log in",
						onClick: () => {
							authenticateAgent(chatTarget, staleAgent, method.id)
								.then((res) => {
									if (res.authenticated) {
										toast.success({ title: "Logged back in" });
									} else {
										toast.error({ title: "Login did not complete" });
									}
								})
								.catch(() => {
									toast.error({ title: "Login failed" });
								});
						},
					},
				});
			})
			.catch(() => {
				if (!cancelled) {
					toast.error({
						title: "The agent needs you to log in again",
						description: latestAuthRequired.message || undefined,
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, [latestAuthRequired, chatTarget]);

	// The agent's config option DEFINITIONS, re-published on the live stream as
	// `data-ryu-acp-config-options` (`{ configOptions }`). Most recent part wins
	// and REPLACES the set wholesale, the same contract as the slash-command list
	// above — an option missing from a refreshed list is one the agent has
	// withdrawn, so merging would keep a stale picker alive forever.
	const latestStreamedAcpConfigOptions = useMemo<
		AcpConfigOption[] | null
	>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "assistant" || !m.parts) {
				continue;
			}
			for (let j = m.parts.length - 1; j >= 0; j--) {
				const part = m.parts[j] as { type?: string; data?: unknown };
				if (part?.type !== "data-ryu-acp-config-options") {
					continue;
				}
				const data = part.data as
					| { configOptions?: AcpConfigOption[] }
					| undefined;
				if (Array.isArray(data?.configOptions)) {
					return data.configOptions;
				}
			}
		}
		return null;
	}, [messages]);

	// Agent-level target changes are Core-owned, one-turn decisions. The event is
	// deliberately separate from ACP config write-backs: it can move the active
	// conversation agent, but it must not mutate an agent card or a global model
	// preference. The effective target is adopted by this tab so the next user
	// message follows the handoff instead of sending the old agent id again.
	const latestAgentControl = useMemo<{
		data: {
			effective_agent_id?: unknown;
			effective_effort?: unknown;
			effective_model?: unknown;
			effort_cleared?: unknown;
			model_cleared?: unknown;
			requested_effort?: unknown;
			requested_model?: unknown;
		};
		key: string;
	} | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant" || !message.parts) {
				continue;
			}
			for (let j = message.parts.length - 1; j >= 0; j--) {
				const part = message.parts[j] as { data?: unknown; type?: string };
				if (part.type !== "data-ryu-agent-control") {
					continue;
				}
				const data = part.data as
					| {
							effective_agent_id?: unknown;
							effective_effort?: unknown;
							effective_model?: unknown;
							effort_cleared?: unknown;
							model_cleared?: unknown;
							requested_effort?: unknown;
							requested_model?: unknown;
					  }
					| undefined;
				return { data: data ?? {}, key: `${message.id}:${j}` };
			}
		}
		return null;
	}, [messages]);
	const lastAgentControlRef = useRef<string | null>(null);
	useEffect(() => {
		if (botProduct) {
			return;
		}
		if (
			!latestAgentControl ||
			latestAgentControl.key === lastAgentControlRef.current
		) {
			return;
		}
		lastAgentControlRef.current = latestAgentControl.key;
		const targetAgentId =
			typeof latestAgentControl.data.effective_agent_id === "string"
				? latestAgentControl.data.effective_agent_id.trim()
				: "";
		const modelWasControlled =
			latestAgentControl.data.model_cleared === true ||
			typeof latestAgentControl.data.requested_model === "string";
		const effortWasControlled =
			latestAgentControl.data.effort_cleared === true ||
			typeof latestAgentControl.data.requested_effort === "string";
		const streamedControl: StreamedAcpControl = {
			agentId: targetAgentId || null,
			key: latestAgentControl.key,
		};
		if (modelWasControlled) {
			streamedControl.model =
				latestAgentControl.data.model_cleared === true
					? null
					: typeof latestAgentControl.data.effective_model === "string"
						? latestAgentControl.data.effective_model.trim() || null
						: null;
		}
		if (effortWasControlled) {
			streamedControl.effort =
				latestAgentControl.data.effort_cleared === true
					? null
					: typeof latestAgentControl.data.effective_effort === "string"
						? latestAgentControl.data.effective_effort.trim() || null
						: null;
		}
		if (!targetAgentId) {
			// A null effective target means Core resumed automatic routing. Clear
			// this tab's stale manual target so the next request cannot re-pin the
			// agent that just asked to be cleared.
			setTeamId(null);
			setAgentId(null);
			setSelectedModel(null);
			setModelSelectionCleared(true);
			setStreamedAcpControl(
				modelWasControlled || effortWasControlled ? streamedControl : null
			);
			return;
		}
		if (targetAgentId !== agentIdRef.current) {
			setTeamId(null);
			setAgentId(targetAgentId);
			setSelectedModel(getAgentModel(targetAgentId));
			setModelSelectionCleared(false);
		}
		if (modelWasControlled && !isAcpAgent(targetAgentId, agents)) {
			setSelectedModel(streamedControl.model ?? null);
			setModelSelectionCleared(streamedControl.model === null);
		}
		setStreamedAcpControl(
			modelWasControlled || effortWasControlled ? streamedControl : null
		);
	}, [agents, botProduct, latestAgentControl]);

	// A native provider publishes this part only for the active user turn. Stop
	// at the newest user message so a completed prior turn can never re-arm the
	// affordance when the next request starts before its first data part arrives.
	const latestTurnControl = useMemo<StreamedTurnControl | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === "user") {
				return null;
			}
			if (message.role !== "assistant" || !message.parts) {
				continue;
			}
			for (let j = message.parts.length - 1; j >= 0; j--) {
				const part = message.parts[j] as { data?: unknown; type?: string };
				if (part.type !== "data-ryu-turn-control") {
					continue;
				}
				const data = part.data as
					| {
							effort?: unknown;
							phase?: unknown;
							startedAtMs?: unknown;
							strategy?: unknown;
							turnId?: unknown;
					  }
					| undefined;
				if (
					typeof data?.turnId !== "string" ||
					typeof data.startedAtMs !== "number" ||
					(data.phase !== "reasoning" && data.phase !== "answering") ||
					data.strategy !== "native"
				) {
					continue;
				}
				return {
					effort: typeof data.effort === "string" ? data.effort : undefined,
					phase: data.phase,
					startedAtMs: data.startedAtMs,
					strategy: "native",
					turnId: data.turnId,
				};
			}
		}
		return null;
	}, [messages]);

	// ACP session metadata and Core context compaction are transcript-level
	// events. Show the newest one as a compact marker after the conversation;
	// neither is assistant prose and neither should be copied into the reply.
	const latestAcpTranscriptNotice = useMemo<{
		description?: string;
		id: string;
		title: string;
	} | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant" || !message.parts) {
				continue;
			}
			for (let j = message.parts.length - 1; j >= 0; j--) {
				const part = message.parts[j] as { data?: unknown; type?: string };
				if (part.type === "data-ryu-agent-control") {
					const data = part.data as
						| {
								effective_agent_id?: unknown;
								effective_effort?: unknown;
								effective_model?: unknown;
						  }
						| undefined;
					const effectiveAgent =
						typeof data?.effective_agent_id === "string"
							? data.effective_agent_id.trim()
							: "";
					const effectiveModel =
						typeof data?.effective_model === "string"
							? data.effective_model.trim()
							: "";
					const effectiveEffort =
						typeof data?.effective_effort === "string"
							? data.effective_effort.trim()
							: "";
					const details = [
						effectiveAgent ? `agent: ${effectiveAgent}` : null,
						effectiveModel ? `model: ${effectiveModel}` : null,
						effectiveEffort ? `effort: ${effectiveEffort}` : null,
					].filter((detail): detail is string => detail !== null);
					return {
						description: details.length > 0 ? details.join(" · ") : undefined,
						id: `${message.id}:${j}`,
						title: "Agent control applied",
					};
				}
				if (part.type === "data-ryu-acp-compaction") {
					const data = part.data as { summary?: unknown } | undefined;
					return {
						description:
							typeof data?.summary === "string" ? data.summary : undefined,
						id: `${message.id}:${j}`,
						title: "Earlier context was compacted",
					};
				}
				if (part.type === "data-ryu-acp-session-info") {
					const data = part.data as
						| { title?: unknown; updatedAt?: unknown }
						| undefined;
					const title =
						typeof data?.title === "string" && data.title.trim()
							? `Agent session: ${data.title.trim()}`
							: "Agent session updated";
					const updatedAt =
						typeof data?.updatedAt === "string" ? data.updatedAt : undefined;
					if (title || updatedAt) {
						return {
							description: updatedAt,
							id: `${message.id}:${j}`,
							title,
						};
					}
				}
			}
		}
		return null;
	}, [messages]);
	useEffect(() => {
		if (latestStreamedAcpConfigOptions) {
			setStreamedAcpConfigOptions(latestStreamedAcpConfigOptions);
		}
	}, [latestStreamedAcpConfigOptions]);
	// An option list belongs to the agent that published it. Switching agent (or
	// thread) must drop it, or the new agent's pickers would keep rendering the
	// previous agent's options — the memo above only ever SETS, so a stale value
	// would otherwise survive until something else published.
	// biome-ignore lint/correctness/useExhaustiveDependencies: agentId/convId are the reset triggers, not read in the body.
	useEffect(() => {
		setStreamedAcpConfigOptions(null);
	}, [agentId, convId]);

	// Agent-requested session-config write-backs, the exact same shape one level up
	// from the mode sync. Core streams `data-ryu-acp-config` (`{ config }`) when a
	// tool result asked the client to change values it holds and re-sends every
	// turn — an approved `ExitPlanMode` clearing the Plan mode pill is the shipped
	// case. Most recent part wins; the composer hook adopts and persists it.
	//
	// Carries the EMISSION key (`messageId:partIndex`), exactly like the config
	// warning below, because the identity that must be deduped is "this part", not
	// "this value": a second plan cycle in one conversation re-emits the byte-identical
	// `{"ryu.plan":"off"}`, and a value-keyed guard would swallow it and leave the
	// pill armed — the very bug this channel exists to fix. The key also preserves
	// what a value-keyed guard gave us: this memo re-runs on every stream chunk and
	// hands back a fresh object, but a later chunk re-derives the SAME key, so the
	// effect no-ops and a manual pick made mid-stream is never stomped.
	const latestStreamedAcpConfig = useMemo<StreamedAcpConfig | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "assistant" || !m.parts) {
				continue;
			}
			for (let j = m.parts.length - 1; j >= 0; j--) {
				const part = m.parts[j] as { type?: string; data?: unknown };
				if (part?.type !== "data-ryu-acp-config") {
					continue;
				}
				const data = part.data as
					| { config?: Record<string, string> }
					| undefined;
				const config = data?.config;
				if (config && Object.keys(config).length > 0) {
					return { key: `${m.id}:${j}`, config };
				}
			}
		}
		return null;
	}, [messages]);
	const lastStreamedAcpConfigRef = useRef<string | null>(null);
	useEffect(() => {
		if (
			!latestStreamedAcpConfig ||
			latestStreamedAcpConfig.key === lastStreamedAcpConfigRef.current
		) {
			return;
		}
		lastStreamedAcpConfigRef.current = latestStreamedAcpConfig.key;
		setStreamedAcpConfig(latestStreamedAcpConfig);
	}, [latestStreamedAcpConfig]);

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
	const activePluginNote = useMemo<{
		id: string;
		question: string | null;
		text: string;
	} | null>(() => {
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
				const data = part.data as
					| { question?: string; text?: string }
					| undefined;
				const text = data?.text?.trim();
				if (!text) {
					continue;
				}
				const id = `${m.id}:${j}`;
				if (dismissedPluginNotes.has(id)) {
					return null;
				}
				return {
					id,
					question: data?.question?.trim() || null,
					text,
				};
			}
		}
		return null;
	}, [messages, dismissedPluginNotes]);

	const handleRespondPermission = useCallback(
		(permission: ActivePermission, optionId: string | null) => {
			respondToPermission(permission.requestId, optionId);
		},
		[respondToPermission]
	);

	const permissionRef = useRef<{
		permission: ActivePermission | null;
		onRespond: (permission: ActivePermission, optionId: string | null) => void;
	}>({ permission: null, onRespond: handleRespondPermission });
	permissionRef.current = {
		permission: composerPermission,
		onRespond: handleRespondPermission,
	};

	// Slash-command list held in a ref so the memoized InputBar slot stays stable
	// (same pattern as permission/agents above — avoids textarea focus loss).
	const commandsRef = useRef<SlashCommand[]>(composerCommands);
	commandsRef.current = composerCommands;
	const chatWidgetTemplatesRef = useRef<PluginChatWidgetTemplate[]>([]);
	chatWidgetTemplatesRef.current = (
		pluginContributions.chat_widget_templates ?? []
	).filter(
		(template) =>
			template.availability === "available" &&
			Boolean(template.backing.tool_id ?? template.backing.view_id) &&
			(template.examples.length > 0 || template.triggers.length > 0)
	);

	// Whether anything is on screen right now, read inside the async hydration
	// without making it a dependency: the point is what is true when the fetch
	// RESOLVES, and depending on `messages` would re-run the fetch on every token.
	const hasMessagesRef = useRef(false);
	hasMessagesRef.current = messages.length > 0;

	const loadOlderMessages = useCallback(async () => {
		const conversationId = convIdRef.current;
		const before = olderMessagesCursorRef.current;
		if (
			!(conversationId && before && hasOlderMessagesRef.current) ||
			olderMessagesRequestRef.current
		) {
			return;
		}
		olderMessagesRequestRef.current = true;
		setLoadingOlderMessages(true);
		try {
			const result = await loadMessagesPageResult(conversationId, before);
			if (convIdRef.current !== conversationId || result.status === "error") {
				return;
			}
			const now = Date.now();
			for (const message of result.messages) {
				if (typeof message.timestamp === "number") {
					messageSentAtRef.current.set(message.id, message.timestamp);
				}
			}
			setVersions((current) => ({
				...current,
				...buildVersions(result.messages),
			}));
			setMessages((current) => {
				const existingIds = new Set(current.map((message) => message.id));
				const older = result.messages.filter(
					(message) => !existingIds.has(message.id)
				);
				if (older.length === 0) {
					return current;
				}
				return [
					...older.map((message) => hydrateHistoryMessage(message, now)),
					...current,
				];
			});
			const nextCursor = result.olderMessagesCursor ?? null;
			olderMessagesCursorRef.current = nextCursor;
			setHasOlderMessages(
				result.hasOlderMessages === true && nextCursor !== null
			);
		} finally {
			olderMessagesRequestRef.current = false;
			setLoadingOlderMessages(false);
		}
	}, [loadMessagesPageResult, setMessages]);

	const retryHistoryLoad = useCallback(() => {
		setHistoryFailed(false);
		olderMessagesCursorRef.current = null;
		setHasOlderMessages(false);
		setHistoryReloadKey((n) => n + 1);
	}, []);

	// A history request can lose the race with the shared status probe: the chat
	// marks itself unavailable first, then the node comes back. Retry that one
	// restored conversation automatically so the tab does not leave a manual
	// error card behind after the shell has already reconnected.
	const previousConnectionPhaseRef = useRef(connectionPhase);
	useEffect(() => {
		const previousPhase = previousConnectionPhaseRef.current;
		previousConnectionPhaseRef.current = connectionPhase;
		if (
			connectionPhase === "online" &&
			previousPhase !== "online" &&
			historyFailed &&
			convId
		) {
			retryHistoryLoad();
		}
	}, [connectionPhase, convId, historyFailed, retryHistoryLoad]);

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
		olderMessagesCursorRef.current = null;
		setHasOlderMessages(false);
		setLoadingOlderMessages(false);
		if (!convId) {
			// A brand-new chat has nothing to wait for — the greeting is correct here.
			setHistoryLoading(false);
			setHistoryFailed(false);
			return;
		}
		let cancelled = false;
		// Only claim "loading" when there is nothing on screen. This effect also
		// fires the moment the FIRST send adopts a conversation id, and blanking
		// the just-sent message behind a skeleton would be worse than the bug.
		if (!hasMessagesRef.current) {
			setHistoryLoading(true);
		}
		loadMessagesPageResult(convId).then(
			({
				status,
				messages: history,
				hasOlderMessages: pageHasOlderMessages,
				olderMessagesCursor,
			}) => {
				if (cancelled) {
					return;
				}
				setHistoryLoading(false);
				// A transport/HTTP failure is NOT an empty conversation. Leaving
				// useChat's state alone and flagging the failure is what keeps a chat
				// opened while Core is still booting from rendering as a new chat.
				if (status === "error") {
					setHistoryFailed(true);
					return;
				}
				setHistoryFailed(false);
				const nextCursor = olderMessagesCursor ?? null;
				olderMessagesCursorRef.current = nextCursor;
				setHasOlderMessages(
					pageHasOlderMessages === true && nextCursor !== null
				);
				if (history.length === 0) {
					return;
				}
				// The user typed while the fetch was in flight (first send adopting this
				// id). Their message and its live reply outrank stale server history.
				if (hasMessagesRef.current) {
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
				setMessages(history.map((m) => hydrateHistoryMessage(m, now)));
			}
		);
		return () => {
			cancelled = true;
		};
	}, [convId, loadMessagesPageResult, setMessages, historyReloadKey]);

	// Re-hydrate messages when the user switches back to this tab. If the ACP
	// agent is still running, reconnect to Core's live stream resume endpoint so
	// text deltas appear in real time. Otherwise just load persisted history.
	//
	// "error" re-hydrates alongside "ready": a turn whose stream died (Core
	// restarted, network dropped) leaves useChat parked in `error` forever, and
	// gating re-hydration on "ready" alone meant that tab NEVER refreshed again —
	// it showed the truncated thread for the rest of the session even though Core
	// had the finished turn persisted. There is no live stream to clobber in the
	// error state, so reloading is safe. (A turn stuck in "streaming" without a
	// terminal frame is still not re-hydrated — clobbering a genuinely live turn
	// would be worse.)
	//
	// Reloading history alone would leave the tab READ-ONLY: `handleComposerSubmit`
	// only sends on `status === "ready"` and otherwise parks the message in the
	// send queue, which drains on "ready" — so a chat stuck in `error` swallowed
	// every subsequent message. `clearError()` returns the Chat to "ready" once the
	// persisted thread is back on screen, which is also what drains that queue.
	//
	// Seeded `false`, not `isActiveTab`: seeding it from the live value meant the
	// mount pass counted as "was already active", so a tab that mounts on an
	// existing conversation NEVER attempted a resume. Reopening the app (or a
	// thread) while Core was mid-turn therefore showed a frozen partial reply and
	// an idle composer — no live text, no Stop — until the tab was toggled away
	// and back. A fresh chat has no `convId`, so this stays a no-op there.
	const prevIsActiveTab = useRef(false);
	const resumeAbort = useRef<AbortController | null>(null);
	// A resumed turn streams through `setMessages` below, NOT through `useChat`,
	// so its `status` stays "ready" for the whole reply — which left the composer
	// showing the idle trailing button (voice mode) with no Stop while text was
	// visibly arriving. Track the resumed stream explicitly and fold it into the
	// status handed to the chat surface so Stop appears for it too.
	const [resumeStreaming, setResumeStreaming] = useState(false);
	// True until this effect has taken its branch once. The mount pass must NOT
	// re-hydrate: the effect above already owns mount hydration, and its mapping
	// is the richer one (prefers structured `parts`, marks #404 stale-running
	// turns "⚠️ Interrupted", seeds `messageSentAtRef` with the server stamps).
	// Two hydrations racing on the same tab would let the lossy one win at random,
	// so on mount we read history only to seed the resume reader.
	// Keyed off the first effect INVOCATION, not the first time the branch is
	// taken: a tab that mounts on a fresh chat (no `convId`) skips the branch, so
	// a "first branch entry" flag would still read as the mount pass on a later
	// re-activation and skip the `clearError()` that un-sticks an error-parked
	// thread. Mount is the only pass that races the hydrator.
	const didMountPass = useRef(false);
	// True while a resume attempt (probe or attached reader) is outstanding. The
	// probe is now armed from three places instead of one, and without this guard
	// two of them can attach two readers to the same turn — which duplicates every
	// delta and leaves an orphaned reader running.
	const resumeInFlight = useRef(false);
	// Epoch ms until which resume probing is suppressed (set by an explicit Stop).
	const resumeSuppressedUntil = useRef(0);

	/**
	 * Probe `/api/chat/stream/resume/:id` and, if Core says a turn IS running,
	 * attach to it — which is what makes `effectiveStatus` (and therefore the
	 * composer's Stop button) report the truth.
	 *
	 * The 404-when-idle contract is what makes this safe to arm repeatedly: the
	 * server side is one in-memory registry lookup, so a probe against an idle
	 * conversation costs nothing. It is deliberately NOT derived from the
	 * conversation's persisted `run_status` — Core never reconciles that field at
	 * boot, so a crashed turn would leave the composer permanently showing Stop.
	 *
	 * `restore` also re-loads persisted history first (the tab-activation path,
	 * which must repaint the thread and `clearError()` whether or not a turn is
	 * live). `probe` touches nothing unless the probe actually attaches.
	 */
	const tryResume = useCallback(
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one SSE reader, kept whole
		async (mode: "restore" | "probe", options?: { hydrate?: boolean }) => {
			const conv = convIdRef.current;
			if (!conv || resumeInFlight.current) {
				return;
			}
			// An explicit Stop cancels the turn server-side, but Core takes a moment
			// to tear the live stream down. Without this window the poll below would
			// re-attach to the dying turn and flash Stop back on immediately after
			// the user pressed it.
			if (Date.now() < resumeSuppressedUntil.current) {
				return;
			}
			resumeInFlight.current = true;
			const controller = new AbortController();
			resumeAbort.current = controller;
			const hydrate = options?.hydrate ?? false;
			let attached = false;
			try {
				let history: Awaited<
					ReturnType<typeof loadMessagesPageResult>
				>["messages"] = [];
				if (mode === "restore") {
					const page = await loadMessagesPageResult(conv);
					history = page.messages;
					if (controller.signal.aborted) {
						return;
					}
					if (page.status === "ok" && hydrate) {
						const nextCursor = page.olderMessagesCursor ?? null;
						olderMessagesCursorRef.current = nextCursor;
						setHasOlderMessages(
							page.hasOlderMessages === true && nextCursor !== null
						);
					}
					if (history.length > 0 && hydrate) {
						setVersions(buildVersions(history));
						// The SAME mapper the mount pass uses. These two used to
						// disagree: this one mapped bare parts and dropped the
						// interruption marker, so a turn that was cut off came back
						// looking finished every time the tab was reopened.
						const now = Date.now();
						setMessages(history.map((m) => hydrateHistoryMessage(m, now)));
					}
					// Persisted state is on screen — take the chat out of `error` so the
					// composer (and any queued messages) work again. No-op when ready.
					if (hydrate) {
						clearError();
					}
				}

				// Try to reconnect to the running turn's live stream.
				const resumeUrl = chatStreamResumeUrl(chatTargetRef.current, conv);
				const headers = chatHeaders(chatTargetRef.current);
				const resp = await fetch(resumeUrl, {
					headers,
					signal: controller.signal,
				});
				if (!(resp.ok && resp.body)) {
					return; // 404 = no running turn
				}
				// A live turn IS attached — the composer must show Stop.
				attached = true;
				setResumeStreaming(true);
				if (mode === "probe") {
					// Only now is the history worth fetching: a bare probe must not cost
					// a conversation read on every tick.
					const page = await loadMessagesPageResult(conv);
					history = page.messages;
					if (controller.signal.aborted) {
						return;
					}
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
											// Merge, never replace: the reader understands only
											// text-delta, so overwriting `parts` deleted the tool
											// rows, Thinking traces and stats part of a turn it
											// had merely reconnected to. The whole-message form
											// also clears `_interrupted`, which a delta disproves
											// — see mergeResumedReplyMessage.
											next[idx] = mergeResumedReplyMessage(
												next[idx],
												replyText
											);
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
					const finalPage = await loadMessagesPageResult(conv);
					if (finalPage.status === "ok" && finalPage.messages.length > 0) {
						const nextCursor = finalPage.olderMessagesCursor ?? null;
						olderMessagesCursorRef.current = nextCursor;
						setHasOlderMessages(
							finalPage.hasOlderMessages === true && nextCursor !== null
						);
						const now = Date.now();
						setMessages(
							finalPage.messages.map((m) => hydrateHistoryMessage(m, now))
						);
					}
					refresh();
				}
			} catch {
				// Resume failed (no live turn / network error) — persisted history is
				// already loaded above, nothing more to do.
			} finally {
				resumeInFlight.current = false;
				setResumeStreaming(false);
				if (attached) {
					// Detaching flips `effectiveStatus` back to "ready", which re-arms
					// arm 2. Bound that cycle: if Core ever hands back a stream that
					// closes immediately, this makes it a slow retry rather than a
					// request storm.
					resumeSuppressedUntil.current = Date.now() + RESUME_REATTACH_GRACE_MS;
				}
			}
		},
		[loadMessagesPageResult, setMessages, refresh, clearError]
	);

	// Reconnect Retry starts hidden/background turns through Core. If this tab owns
	// the same conversation, attach its UI reader after the background route has had
	// a moment to publish the live stream; the normal idle probe remains the final
	// fallback if the first attempt races the stream setup.
	useEffect(() => {
		const timers = new Set<number>();
		const onRetryStarted = (event: Event) => {
			const detail = (event as CustomEvent<{ conversationId?: unknown }>)
				.detail;
			if (detail?.conversationId !== convId) {
				return;
			}
			clearError();
			const first = window.setTimeout(() => {
				void tryResume("probe");
			}, 250);
			const second = window.setTimeout(() => {
				void tryResume("probe");
			}, 1000);
			timers.add(first);
			timers.add(second);
		};
		window.addEventListener(CHAT_RETRY_STARTED_EVENT, onRetryStarted);
		return () => {
			window.removeEventListener(CHAT_RETRY_STARTED_EVENT, onRetryStarted);
			for (const timer of timers) {
				window.clearTimeout(timer);
			}
		};
	}, [clearError, convId, tryResume]);

	// Arm 1 — tab activation (and mount). The original, and the only one that
	// re-hydrates history.
	useEffect(() => {
		const isMountPass = !didMountPass.current;
		didMountPass.current = true;
		const wasActive = prevIsActiveTab.current;
		prevIsActiveTab.current = isActiveTab;
		const settled = status === "ready" || status === "error";
		if (!wasActive && isActiveTab && settled && convId) {
			void tryResume("restore", { hydrate: !isMountPass });
		}
	}, [isActiveTab, status, convId, tryResume]);

	// Tear the reader down when the CONVERSATION changes (or the tab unmounts) —
	// not on every re-run of the effects above. The old cleanup lived on the
	// activation effect and fired on any dependency-identity churn, which aborted
	// a genuinely live resumed reader mid-reply.
	useEffect(
		() => () => {
			resumeAbort.current?.abort();
			resumeInFlight.current = false;
			setResumeStreaming(false);
		},
		[convId]
	);

	// The turn state everything user-facing keys off. `status` alone reports
	// "ready" through a whole resumed reply (that stream is ours, not useChat's),
	// which showed the composer as idle — no Stop, voice mode in the trailing
	// slot — and let a fresh send interleave with the running turn instead of
	// queueing behind it. Every consumer of "is a turn in flight" uses this;
	// `status` stays the raw useChat value for the stream plumbing itself.
	const effectiveStatus: typeof status =
		resumeStreaming && status === "ready" ? "streaming" : status;
	const [answerNowClock, setAnswerNowClock] = useState(() => Date.now());
	const [answerNowPendingTurnId, setAnswerNowPendingTurnId] = useState<
		string | null
	>(null);
	const turnIsBusy =
		effectiveStatus === "streaming" || effectiveStatus === "submitted";

	// Keep the effort-aware grace period ticking only while the native provider is
	// still in its reasoning phase. Unsupported routes never publish this part,
	// so they pay no timer or render cost.
	useEffect(() => {
		if (!(turnIsBusy && latestTurnControl?.phase === "reasoning")) {
			return;
		}
		setAnswerNowClock(Date.now());
		const timer = window.setInterval(() => setAnswerNowClock(Date.now()), 250);
		return () => window.clearInterval(timer);
	}, [latestTurnControl?.phase, latestTurnControl?.turnId, turnIsBusy]);

	useEffect(() => {
		if (
			answerNowPendingTurnId &&
			(answerNowPendingTurnId !== latestTurnControl?.turnId || !turnIsBusy)
		) {
			setAnswerNowPendingTurnId(null);
		}
	}, [answerNowPendingTurnId, latestTurnControl?.turnId, turnIsBusy]);

	const handleAnswerNow = useCallback(async () => {
		const control = latestTurnControl;
		const conversationId = convIdRef.current ?? draftConvId.current;
		if (!(control && conversationId && turnIsBusy)) {
			return;
		}
		setAnswerNowPendingTurnId(control.turnId);
		try {
			const accepted = await answerNowChat(
				chatTargetRef.current,
				conversationId,
				control.turnId
			);
			if (!accepted) {
				throw new Error("Core did not accept the request");
			}
		} catch {
			setAnswerNowPendingTurnId(null);
			toast.error("Could not ask this turn to answer now.");
		}
	}, [latestTurnControl, turnIsBusy]);

	const answerNowControl = useMemo(() => {
		if (
			!(
				turnIsBusy &&
				latestTurnControl?.phase === "reasoning" &&
				answerNowClock - latestTurnControl.startedAtMs >=
					answerNowDelayMs(latestTurnControl.effort)
			)
		) {
			return undefined;
		}
		return {
			onClick: handleAnswerNow,
			pending: answerNowPendingTurnId === latestTurnControl.turnId,
		};
	}, [
		answerNowClock,
		answerNowPendingTurnId,
		handleAnswerNow,
		latestTurnControl,
		turnIsBusy,
	]);
	// Arm 2 — a stream of OURS just ended or errored. This is the case that made
	// a runaway turn unstoppable: a local SSE that drops mid-turn puts useChat
	// back at "ready"/"error" while Core keeps the turn running, and the one-shot
	// activation probe never fires again because the tab never lost focus. Edge-
	// triggered on the busy → settled transition, so dependency churn cannot turn
	// it into a loop.
	const prevSettledStatus = useRef<string>("ready");
	useEffect(() => {
		const previous = prevSettledStatus.current;
		prevSettledStatus.current = effectiveStatus;
		const wasBusy = previous === "streaming" || previous === "submitted";
		const settledNow =
			effectiveStatus === "ready" || effectiveStatus === "error";
		if (wasBusy && settledNow && convId && isActiveTab) {
			void tryResume("probe");
		}
	}, [effectiveStatus, convId, isActiveTab, tryResume]);

	// Arm 3 — a slow poll for turns this tab never started: a queued/scheduled
	// run, or the same conversation driven from another client. Only the focused
	// workspace tab of a focused WINDOW polls, and only while it believes it is
	// idle, so this is one cheap 404 every 15s for the chat the user is actually
	// looking at — not one per open tab.
	//
	// `document.hasFocus()`, not `visibilityState`: in the Tauri shell the page
	// stays "visible" while the window sits behind another app, so a visibility
	// check would poll forever for a window nobody is looking at.
	useEffect(() => {
		if (!(convId && isActiveTab) || effectiveStatus !== "ready") {
			return;
		}
		const id = window.setInterval(() => {
			if (document.hasFocus()) {
				void tryResume("probe");
			}
		}, RESUME_POLL_MS);
		return () => window.clearInterval(id);
	}, [convId, isActiveTab, effectiveStatus, tryResume]);

	// ── Multi-user collaboration (Phase 2): live chat fan-out + presence ────────
	// Join this conversation's realtime room (only once a real `convId` exists —
	// never the draft id) so another human's messages appear live and we can show
	// who is present/typing. Anonymous (no node JWT) still works: with no verified
	// author, nothing is attributed or live-inserted, leaving the single-user flow
	// untouched.
	//
	// The signed-in human supplies the display name used for presence.
	const oidcUser = useAppStore((s) => s.oidcUser);

	// This client's stable Core user id (the JWT subject Core stamps as a message's
	// `author_user_id`). Resolved once; lets us tell our own echoed message from
	// someone else's. Null when signed out (anonymous) — then own/other is
	// indistinguishable, but an anonymous author is null too, so nothing inserts.
	const myUserIdRef = useRef<string | null>(null);
	const [myUserId, setMyUserId] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		// `getRealtimeUserId` resolves to null on any failure (never rejects).
		getRealtimeUserId().then((id) => {
			if (!cancelled) {
				myUserIdRef.current = id;
				setMyUserId(id);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);

	// This connection's room member id (from the join ack), used to drop our own
	// presence echo so we never show ourselves as "typing".
	const myMemberIdRef = useRef<string | null>(null);

	const reactionsPluginEnabled = useMemo(
		() => contributedMessageActions.some(isMessageReactionAction),
		[contributedMessageActions]
	);

	// Emoji reactions for this conversation. A temporary chat is never persisted, so
	// there is nothing to react TO and no room to fan reactions out over — the
	// null conversation id disables the query the same way it skips presence.
	const {
		byMessage: reactionsByMessage,
		applyRealtimeFrame: applyReactionFrame,
		toggle: toggleReaction,
	} = useMessageReactions(
		ghostChatActive || !reactionsPluginEnabled ? null : convId
	);

	const memoryCitationsByMessage = useMemo(() => {
		const citationsByMessage = new Map<
			string,
			ReturnType<typeof extractMemoryCitations>
		>();
		const transcriptMessages = [
			...(merged.messages as unknown as UIMessage[]),
			...messages,
		];
		for (const message of transcriptMessages) {
			const citations = extractMemoryCitations(message.parts);
			if (citations.length > 0) {
				citationsByMessage.set(message.id, citations);
			}
		}
		return citationsByMessage;
	}, [merged.messages, messages]);

	const messageActionStates = useMemo(() => {
		const states = new Map<string, MessageActionRuntimeState>();
		const messageIds = new Set([
			...reactionsByMessage.keys(),
			...Object.keys(feedback),
			...memoryCitationsByMessage.keys(),
		]);
		for (const messageId of messageIds) {
			const buckets = reactionsByMessage.get(messageId);
			const rating = feedback[messageId];
			const memoryCitations = memoryCitationsByMessage.get(messageId);
			states.set(messageId, {
				...(buckets ? { reactionBuckets: buckets } : {}),
				...(memoryCitations ? { memoryCitations } : {}),
				...(rating ? { toggleValues: { "learning.feedback": rating } } : {}),
			});
		}
		return states;
	}, [feedback, memoryCitationsByMessage, reactionsByMessage]);

	const handleContributedMessageAction = useCallback(
		(action: ContributedMessageAction, context: MessageActionContext) => {
			if (isMessageReactionAction(action)) {
				if (context.value) {
					toggleReaction(context.messageId, context.value);
				}
				return;
			}
			if (
				action.id === "learning.feedback" &&
				action.plugin === "@ryu/learning"
			) {
				if (isMergedHistoryId(context.messageId)) {
					return;
				}
				const conversationId = convIdRef.current ?? activeConversationId;
				if (!conversationId) {
					return;
				}
				if (!action.capability) {
					return;
				}
				const rating =
					context.value === "up"
						? "up"
						: context.value === "down"
							? "down"
							: null;
				let previous: "up" | "down" | undefined;
				setFeedback((current) => {
					previous = current[context.messageId];
					const next = { ...current };
					if (rating) {
						next[context.messageId] = rating;
					} else {
						delete next[context.messageId];
					}
					return next;
				});
				void pluginHostInvoke(chatTarget, action.plugin, action.capability, {
					...(action.args ?? {}),
					conversation_id: conversationId,
					message_id: context.messageId,
					rating,
				}).catch(() => {
					if ((convIdRef.current ?? activeConversationId) !== conversationId) {
						return;
					}
					setFeedback((current) => {
						const reverted = { ...current };
						if (previous) {
							reverted[context.messageId] = previous;
						} else {
							delete reverted[context.messageId];
						}
						return reverted;
					});
				});
				return;
			}
			if (!(action.plugin && action.capability)) {
				return;
			}
			const args = {
				...(action.args ?? {}),
				message_id: context.messageId,
				...(context.value === undefined ? {} : { value: context.value }),
			};
			void pluginHostInvoke(chatTarget, action.plugin, action.capability, args);
		},
		[activeConversationId, chatTarget, toggleReaction]
	);

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
			// Reactions ride the same named-event channel as messages. Routed before
			// the message guard below, which would otherwise drop them on the floor.
			if (frame.type === "reaction") {
				applyReactionFrame(data, myUserIdRef.current);
				return;
			}
			if (frame.type !== "message" || typeof frame.message !== "object") {
				return;
			}
			const msg = frame.message as {
				id?: string;
				content?: string;
				author_user_id?: string | null;
				author_name?: string | null;
				created_at?: number;
				source?: string | null;
				widget_instance_id?: string | null;
				origin_server?: string | null;
				client_id?: string | null;
			};
			const authorId = msg.author_user_id ?? null;
			// Suppress only the exact client that submitted the optimistic message.
			// Another tab or device owned by the same user must still receive it.
			const isOwnMessage = isRealtimeMessageEcho(
				msg.client_id,
				realtimeClientIdRef.current
			);
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
					origin_server: msg.origin_server ?? undefined,
					source: msg.source ?? undefined,
					widget_instance_id: msg.widget_instance_id ?? undefined,
				},
			};
			setMessages((prev) => {
				if (prev.some((m) => m.id === msg.id)) {
					return prev;
				}
				return [...prev, inserted as unknown as (typeof prev)[number]];
			});
		},
		[setMessages, applyReactionFrame]
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
		setRemotePresence((prev) => {
			const next = { ...prev };
			for (const entry of ack.presence) {
				if (typeof entry !== "object" || entry === null) {
					continue;
				}
				const frame = entry as {
					member_id?: string;
					name?: string;
					typing?: boolean;
				};
				if (frame.member_id && frame.member_id !== ack.memberId) {
					next[frame.member_id] = {
						name: frame.name,
						typing: Boolean(frame.typing),
					};
				}
			}
			return next;
		});
		// Publish an initial payload so both the roster snapshot and future
		// presence deltas carry a human-readable identity before typing starts.
		publishRoomPresenceRef.current({
			name: myPresenceNameRef.current,
			typing: false,
		});
	}, []);

	// A temporary chat never opens a realtime room: its turns are never
	// persisted (so Core fans out nothing), and we also skip presence so a
	// temporary thread stays fully private. `null` room id = no join.
	const { publishPresence: publishRoomPresence } = useRealtimeRoom(
		ghostChatActive ? null : convId,
		"conversation",
		{
			onEvent: handleRealtimeEvent,
			onJoinAck: handleRealtimeJoinAck,
			onPresence: handleRealtimePresence,
			onResyncRequired: () => setHistoryReloadKey((value) => value + 1),
		},
		realtimeClientIdRef.current
	);

	// Our presence display name (control-plane profile), read into a ref so the
	// stable typing publisher always sends the current value.
	const myPresenceNameRef = useRef("Someone");
	myPresenceNameRef.current = oidcUser?.name ?? oidcUser?.email ?? "Someone";
	const publishRoomPresenceRef = useRef<(data: unknown) => void>(() => {});
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
		// Keep the tab chip in sync with the live stream so the spinner/shimmer
		// appear as soon as the user sends — before Core's run_status catches up.
		if (currentTabId) {
			const busy = status === "streaming" || status === "submitted";
			updateTabBusy(
				currentTabId,
				busy,
				getChatTabBusySpeed(status, acp.acpMode, acp.acpOptionValues)
			);
		}
		// A new turn is in flight — drop stale chips and cancel any pending fetch.
		if (status === "streaming" || status === "submitted") {
			setFollowUps([]);
			followUpAbort.current?.abort();
			followUpAbort.current = null;
		}
		// Any transition INTO "ready", not only from "streaming": a turn that is
		// answered without ever emitting a stream chunk goes submitted → ready, and
		// gating on "streaming" meant such a turn never re-synced the sidebar — its
		// row kept the draft's title and stayed in the loose Chats bucket for the
		// rest of the session, even though Core had already stamped the folder.
		if (prevStatus.current !== "ready" && status === "ready") {
			refresh();
			// The run has finished writing files, so this is the moment the working
			// tree changed — re-read git now rather than waiting for the safety-net
			// poll. Cheap: once per turn, not once per chunk.
			invalidateGitStatus();
			if (activeConversationId) {
				invalidateWorktreeStatus(activeConversationId);
				invalidateWorktreeDiff(activeConversationId);
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
			// The chat-title plugin may re-title after a completed turn. Refresh
			// once more so the sidebar picks up the new title without a reload.
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
	}, [
		status,
		refresh,
		activeConversationId,
		messages,
		currentTabId,
		acp.acpMode,
		acp.acpOptionValues,
		updateTabBusy,
	]);

	// Clear busy on unmount so a closed streaming tab doesn't leave a stale spinner.
	useEffect(() => {
		return () => {
			if (currentTabId) {
				updateTabBusy(currentTabId, false);
			}
		};
	}, [currentTabId, updateTabBusy]);

	// Sidebar / TOC jump: once messages are hydrated, ask the message list to
	// scroll to the pending anchor and clear the one-shot tab flag.
	useEffect(() => {
		if (!(scrollToMessageId && currentTabId && messages.length > 0)) {
			return;
		}
		const timer = window.setTimeout(() => {
			window.dispatchEvent(
				new CustomEvent("ryu:scroll-to-message", {
					detail: { messageId: scrollToMessageId },
				})
			);
			clearScrollToMessage(currentTabId);
		}, 80);
		return () => window.clearTimeout(timer);
	}, [scrollToMessageId, currentTabId, messages.length, clearScrollToMessage]);

	// Switching threads must not carry chips across conversations.
	// `activeConversationId` is load-bearing: it is the only thing that changes on
	// a thread switch, so without it this never runs again after mount and the
	// chips leak into the next conversation.
	useEffect(() => {
		setFollowUps([]);
		followUpAbort.current?.abort();
		followUpAbort.current = null;
	}, [activeConversationId]);

	/** Keep very large pastes out of the prompt body and make them inspectable files. */
	const LONG_PASTE_THRESHOLD = 10_000;

	const addImages = useCallback(
		(files: File[]) => {
			const imageFiles = files.filter((f) => f.type.startsWith("image/"));
			if (imageFiles.length === 0) {
				return;
			}
			for (const file of imageFiles) {
				void stageImageUpload(chatTarget, file).then(({ dataUrl, upload }) => {
					setAttachedImages((prev) => [
						...prev,
						{
							id: upload?.id ?? `img-${Date.now()}-${Math.random()}`,
							filename: file.name,
							url: dataUrl,
							mimeType: file.type,
							size: file.size,
						},
					]);
				});
			}
		},
		[chatTarget]
	);

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
			const pastedText = e.clipboardData.getData("text/plain");
			if (pastedText.length >= LONG_PASTE_THRESHOLD) {
				e.preventDefault();
				setAttachedImages((prev) => [
					...prev,
					{
						id: `paste-${Date.now()}-${prev.length}`,
						filename: "pasted-text.txt",
						url: textToDataUrl(pastedText),
						mimeType: "text/plain",
						size: new TextEncoder().encode(pastedText).byteLength,
					},
				]);
				return;
			}
			const files = Array.from(e.clipboardData.files);
			addImages(files);
		},
		[addImages]
	);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		if (e.dataTransfer.types.includes(CHAT_REFERENCE_DRAG_MIME)) {
			e.dataTransfer.dropEffect = "copy";
			return;
		}
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
			const chat = readDraggedChatReference(e.dataTransfer);
			if (chat) {
				window.dispatchEvent(
					new CustomEvent("ryu:chat-reference-drop", { detail: chat })
				);
				return;
			}
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
		(message: {
			attachments?: AttachedImage[];
			content: string;
			role: "user";
		}) => {
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
			if (!chatFolderRef.current && messageNeedsWorkspace(message.content)) {
				// Keep the submitted message intact while a non-technical user chooses a
				// project. This avoids the old upfront folder gate without allowing a local
				// edit request to run in Core's arbitrary process directory.
				setPendingWorkspaceMessage((current) => current ?? message);
				return;
			}
			const browserModelId =
				browserSnapshot?.currentModelBySurface.dashboard ??
				browserProviderHost.getModelSelection(agentId, "dashboard");
			const browserModel = browserSnapshot?.models.find(
				(model) => model.id === browserModelId
			);
			const browserLocalActive =
				!forceCoreNextRef.current &&
				browserSnapshot?.activeSurface === "dashboard" &&
				browserSnapshot.activeAgentId === agentId &&
				browserModel?.capabilities.chatSupport === true &&
				!(
					ghostChatActive &&
					pluginFlagsRef.current[TEMPORARY_CONTEXT_FLAG] === true
				) &&
				(message.attachments?.length ?? 0) === 0;
			if (browserLocalActive) {
				forceCoreNextRef.current = false;
				const localConversationId = convIdRef.current ?? draftConvId.current;
				if (!ghostChatActive) {
					setConvId(localConversationId);
					setActiveConversationId(localConversationId);
				}
				const localUserId = `browser-user-${Date.now()}`;
				const localMessages = [
					...messages.map((item) => ({
						content: item.parts
							.filter(
								(part): part is { text: string; type: "text" } =>
									part.type === "text"
							)
							.map((part) => part.text)
							.join("\n"),
						role: item.role,
					})),
					{ content: message.content, role: "user" as const },
				];
				setMessages((previous) => [
					...previous,
					{
						id: localUserId,
						parts: [{ text: message.content, type: "text" }],
						role: "user",
					},
				]);
				const controller = new AbortController();
				browserLocalAbortRef.current = controller;
				void browserProviderHost
					.runLocalTurn({
						conversationId: localConversationId,
						ghostMode: ghostChatActive,
						messages: localMessages,
						modelId: browserModelId,
						requestId: localUserId,
						signal: controller.signal,
						surface: "dashboard",
					})
					.then((result) => {
						browserLocalAbortRef.current = null;
						if (!result) {
							setMessages((previous) =>
								previous.filter((item) => item.id !== localUserId)
							);
							forceCoreNextRef.current = true;
							handleSendRef.current(message);
							return;
						}
						if (result.text) {
							setMessages((previous) => [
								...previous,
								{
									id: `browser-assistant-${Date.now()}`,
									parts: [{ text: result.text, type: "text" }],
									role: "assistant",
								},
							]);
						}
						if (result.pendingApprovals.length > 0) {
							setMessages((previous) => [
								...previous,
								{
									id: `browser-approval-${Date.now()}`,
									parts: [
										{
											text: result.pendingApprovals
												.map(
													(approval) =>
														`Safe approval needed: ${approval.reason}`
												)
												.join("\n"),
											type: "text",
										},
									],
									role: "assistant",
								},
							]);
						}
					})
					.catch((error: unknown) => {
						if (controller.signal.aborted) {
							return;
						}
						browserLocalAbortRef.current = null;
						setMessages((previous) => [
							...previous.filter((item) => item.id !== localUserId),
							{
								id: `browser-fallback-${Date.now()}`,
								parts: [
									{
										text: `Browser engine failed — switching to Core. Retry or choose Browser in Settings. ${error instanceof Error ? error.message : String(error)}`,
										type: "text",
									},
								],
								role: "assistant",
							},
						]);
						forceCoreNextRef.current = true;
						handleSendRef.current(message);
					});
				return;
			}
			forceCoreNextRef.current = false;
			// The folder this turn is about to run in — read from the store, exactly
			// as the transport body does a moment later, so the row the sidebar shows
			// and the `cwd` Core stamps onto the conversation are the same value.
			const sendFolder = chatFolderRef.current ?? undefined;
			if (!convId) {
				const newId = draftConvId.current;
				// A temporary chat is never registered in the sidebar history:
				// skip `createConversation` so it leaves no trace in the thread list.
				// The turn still streams (useChat keys off the local id) and Core
				// persists nothing because the transport sends `persist: false`.
				if (!ghostChatActive) {
					createConversation(newId, {
						agentId: agentId ?? undefined,
						folderPath: sendFolder,
					});
				}
				setConvId(newId);
				setActiveConversationId(newId);
			}

			// Chats started in a project belong to that project from their first
			// message, not from whenever the list next refreshes. Core stamps the
			// same folder from this turn's `cwd`; recording it locally is what keeps
			// the row from sitting in the loose "Chats" bucket in the meantime — and
			// it also catches a draft opened before the user switched folders.
			if (!ghostChatActive) {
				const folderTargetId = convIdRef.current ?? draftConvId.current;
				if (folderTargetId) {
					setConversationFolder(folderTargetId, sendFolder);
				}
			}

			// Name the thread after what the user just asked, right now. Core derives
			// the identical title when it persists this turn, so this only removes the
			// wait — without it the row reads "New Chat" for the whole first reply
			// (the list is only re-fetched once the turn completes). The chat-title
			// plugin replaces it with a model-written name after that reply lands.
			// Temporary chats are absent from the list, so the seed is a no-op for them.
			if (!ghostChatActive) {
				const titleTargetId = convIdRef.current ?? draftConvId.current;
				if (titleTargetId) {
					seedTitleFromFirstMessage(titleTargetId, message.content);
				}
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

			const currentImages =
				message.attachments ?? attachmentRef.current.attachedImages;
			if (currentImages.length > 0) {
				sendMessage({
					text: message.content,
					files: currentImages.map((img) => ({
						type: "file" as const,
						mediaType: img.mimeType ?? "application/octet-stream",
						filename: img.filename,
						url: img.url,
					})),
				});
			} else {
				sendMessage({ text: message.content });
			}
			if (!message.attachments) {
				setAttachedImages([]);
			}
			// Reset after send so the next message starts fresh.
			targetAgentIdRef.current = null;
			teamIdRef.current = null;
			workflowIdRef.current = null;
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
			ghostChatActive,
			createConversation,
			setConversationFolder,
			seedTitleFromFirstMessage,
			setActiveConversationId,
			sendMessage,
			stopTyping,
			browserSnapshot,
			setMessages,
		]
	);
	handleSendRef.current = handleSend;

	const handleWorkspaceFolderSelected = useCallback(
		(selectedFolder: string) => {
			if (ghostChatActive) {
				return;
			}
			const conversationId = convIdRef.current;
			if (conversationId) {
				setConversationFolder(conversationId, selectedFolder);
			}
		},
		[ghostChatActive, setConversationFolder]
	);

	// A folder selection made from the lightweight prompt resumes the exact turn
	// that was waiting. The ref avoids replaying a stale callback after the store
	// updates, and clearing the pending value first makes the hand-off idempotent.
	useEffect(() => {
		if (!(pendingWorkspaceMessage && chatFolder)) {
			return;
		}
		const pending = pendingWorkspaceMessage;
		setPendingWorkspaceMessage(null);
		handleSendRef.current(pending);
	}, [chatFolder, pendingWorkspaceMessage]);

	// Start a brand-new empty thread in THIS tab: rotate the draft id, clear the
	// active conversation and the on-screen messages. Used when the ghost toggle
	// flips so a temporary chat and a persisted chat never share a thread — a
	// persisted conversation must never receive a non-persisted turn, and a ghost
	// thread must not inherit a persisted one.
	const startFreshThread = useCallback(() => {
		draftConvId.current = `conv-${Date.now()}`;
		// An explicit "new thread" outranks the merged view's open-on-newest seed
		// for the rest of this tab's life — see the latch above.
		mergedSeeded.current = true;
		setConvId(null);
		setActiveConversationId(null);
		setMessages([]);
	}, [setActiveConversationId, setMessages]);

	const toggleGhostMode = useCallback(() => {
		if (!ghostChatsPluginEnabled) {
			return;
		}
		startFreshThread();
		setGhostMode((on) => !on);
	}, [ghostChatsPluginEnabled, startFreshThread]);

	const [savingTemporaryChat, setSavingTemporaryChat] = useState(false);
	const handleSaveTemporaryChat = useCallback(async () => {
		if (
			!ghostChatActive ||
			savingTemporaryChat ||
			status === "submitted" ||
			status === "streaming"
		) {
			return;
		}
		const conversationId = convIdRef.current ?? draftConvId.current;
		const snapshot = messages.flatMap((message) => {
			if (message.role !== "user" && message.role !== "assistant") {
				return [];
			}
			return [
				{
					content: extractAssistantText(message),
					parts: Array.isArray(message.parts) ? [...message.parts] : undefined,
					role: message.role,
				},
			];
		});
		if (snapshot.length === 0) {
			return;
		}

		setSavingTemporaryChat(true);
		try {
			const folderPath = chatFolderRef.current ?? folder ?? undefined;
			await saveTemporaryChat(chatTarget, conversationId, {
				agentId: agentId ?? undefined,
				folderPath,
				messages: snapshot,
			});
			createConversation(conversationId, {
				agentId: agentId ?? undefined,
				folderPath,
			});
			if (folderPath) {
				setConversationFolder(conversationId, folderPath);
			}
			const firstUserMessage = snapshot.find(
				(message) => message.role === "user"
			);
			if (firstUserMessage) {
				seedTitleFromFirstMessage(conversationId, firstUserMessage.content);
			}
			setConvId(conversationId);
			setGhostMode(false);
			setActiveConversationId(conversationId);

			const saved = await loadMessagesResult(conversationId);
			if (saved.status === "ok" && saved.messages.length > 0) {
				const now = Date.now();
				for (const message of saved.messages) {
					if (typeof message.timestamp === "number") {
						messageSentAtRef.current.set(message.id, message.timestamp);
					}
				}
				setVersions(buildVersions(saved.messages));
				setMessages(
					saved.messages.map((message) => hydrateHistoryMessage(message, now))
				);
			}
			clearError();
			refresh();
			toast.success("Chat saved", {
				description: "This temporary chat is now in your history.",
			});
		} catch {
			toast.error("Couldn’t save temporary chat", {
				description: "The chat is still temporary. Try saving again.",
			});
		} finally {
			setSavingTemporaryChat(false);
		}
	}, [
		agentId,
		chatFolderRef,
		chatTarget,
		clearError,
		createConversation,
		folder,
		ghostChatActive,
		loadMessagesResult,
		messages,
		refresh,
		savingTemporaryChat,
		seedTitleFromFirstMessage,
		setConvId,
		setActiveConversationId,
		setConversationFolder,
		setMessages,
		status,
	]);

	// `/btw` side question: an ephemeral question about the current conversation
	// shown in a dismissible overlay and never added to the chat history (modeled
	// on Claude Code's interactive `/btw`). The side model sees the conversation
	// context but has no tools. `null` = overlay closed.
	const [btwState, setBtwState] = useState<BtwState | null>(null);
	const btwRequestRef = useRef(0);
	// Bumped after each `/btw` resolves so the Context rail's Side-chats list
	// refetches the now-persisted aside without a full reload.
	const [sideChatsRefreshKey, setSideChatsRefreshKey] = useState(0);

	/** Run one side question from either `/btw` or a selection-toolbar action. */
	const askSideChatQuestion = useCallback(
		(question: string) => {
			const convId = activeConversationId;
			if (!convId) {
				setBtwState({
					question,
					loading: false,
					answer: null,
					model: null,
					error: "Ask something in this chat first, then try again.",
				});
				return;
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
			askBtw(
				chatTargetRef.current,
				convId,
				question,
				sideChatMessages,
				undefined,
				effectiveModel ?? undefined
			)
				.then((result) => {
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
					setSideChatsRefreshKey((key) => key + 1);
				})
				.catch((error: unknown) => {
					if (btwRequestRef.current !== requestId) {
						return;
					}
					setBtwState({
						question,
						loading: false,
						answer: null,
						model: null,
						error:
							error instanceof Error ? error.message : "Side question failed",
					});
				});
		},
		[activeConversationId, effectiveModel, sideChatMessages]
	);

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
	const handleOpenSideChatRequest = useCallback(
		(entry?: BtwEntry) => {
			if (entry) {
				handleOpenSideChat(entry);
				return;
			}
			setBtwState({
				question: "",
				loading: false,
				answer: null,
				model: null,
				error: null,
			});
		},
		[handleOpenSideChat]
	);

	// Open a spawned subagent's transcript in the right panel. The nonce makes each
	// click a distinct request so re-selecting the same subagent re-focuses the tab;
	// opening the right panel auto-hides the (overlapping) pinned summary card.
	const [subagentReq, setSubagentReq] = useState<{
		id: string;
		nonce: number;
	} | null>(null);
	const subagentNonce = useRef(0);
	const handleOpenSubagent = useCallback((subagent: SubagentSummary) => {
		subagentNonce.current += 1;
		setSubagentReq({
			id: subagent.id,
			nonce: subagentNonce.current,
		});
		setRightPanelOpen(true);
	}, []);

	// Capped pinned-summary sections open their complete live collections in
	// reusable workspace tabs. One nonce stream is enough because the request also
	// carries the collection kind.
	const [collectionReq, setCollectionReq] = useState<{
		kind: "sources" | "subagents";
		nonce: number;
	} | null>(null);
	const collectionNonce = useRef(0);
	const openCollection = useCallback((kind: "sources" | "subagents") => {
		collectionNonce.current += 1;
		setCollectionReq({ kind, nonce: collectionNonce.current });
		setRightPanelOpen(true);
	}, []);
	const handleOpenSources = useCallback(
		() => openCollection("sources"),
		[openCollection]
	);
	const handleOpenSubagents = useCallback(
		() => openCollection("subagents"),
		[openCollection]
	);

	// Open a rendered/canvas artifact in the right panel — the same nonce flow as
	// the subagent, but WorkspacePanels opens ONE DEDICATED TAB per artifact (no
	// one-at-a-time limit), so clicking a second artifact stacks it alongside the
	// first rather than replacing it.
	const [artifactReq, setArtifactReq] = useState<{
		artifact: Artifact;
		nonce: number;
	} | null>(null);
	const artifactNonce = useRef(0);
	const handleOpenArtifact = useCallback((artifact: Artifact) => {
		artifactNonce.current += 1;
		setArtifactReq({ artifact, nonce: artifactNonce.current });
		setRightPanelOpen(true);
	}, []);

	// Open the context-window breakdown in the right panel (composer ring click).
	// Same nonce-per-click flow as the subagent tab, but the request carries no
	// payload: the panel reads `contextView` live so it keeps tracking the
	// conversation instead of freezing at the moment it was opened.
	const [contextReq, setContextReq] = useState<{ nonce: number } | null>(null);
	const contextNonce = useRef(0);
	const handleOpenContext = useCallback(() => {
		contextNonce.current += 1;
		setContextReq({ nonce: contextNonce.current });
		setRightPanelOpen(true);
	}, []);

	const [fileReviewRequest, setFileReviewRequest] =
		useState<FileReviewRequest | null>(null);
	const fileReviewNonce = useRef(0);
	const handleReviewFileEdits = useCallback((paths: string[]) => {
		fileReviewNonce.current += 1;
		setFileReviewRequest({ nonce: fileReviewNonce.current, paths });
		setRightPanelOpen(true);
	}, []);
	const handleUndoFileEdits = useCallback(
		async (plan: FileEditUndoPlan) => {
			if (!folder) {
				throw new Error("Open the project folder before undoing this turn.");
			}
			const result = await reverseGitEdits(chatTarget, folder, plan);
			if (result.kind === "conflict") {
				const reason =
					result.reason === "staged_changes"
						? "One of these files has staged changes. Unstage it before retrying."
						: result.reason === "unsupported_file"
							? "One of these files is not reversible text."
							: "The edited text changed after this turn. No files were changed.";
				throw new Error(reason);
			}
			invalidateGitStatus();
			if (activeConversationId) {
				invalidateWorktreeStatus(activeConversationId);
				invalidateWorktreeDiff(activeConversationId);
			}
			toast.success(
				result.paths.length === 1
					? "Turn edit undone"
					: `${result.paths.length} turn edits undone`
			);
		},
		[activeConversationId, chatTarget, folder]
	);
	useEffect(() => {
		setFileReviewRequest(null);
	}, [activeConversationId, folder]);

	// Sidebar → side chat: the sidebar selects the thread then dispatches this
	// event. Only the tab whose conversation matches opens the overlay; if the
	// tab is still mounting (convId not yet set), stash it and flush once convId
	// catches up. Mirrors the run-notification-click decoupling below.
	const pendingSideChatRef = useRef<{
		conversationId: string;
		entry?: BtwEntry;
	} | null>(null);
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (
				e as CustomEvent<{ conversationId: string; entry?: BtwEntry }>
			).detail;
			if (!detail?.conversationId) {
				return;
			}
			if (detail.conversationId === convIdRef.current) {
				handleOpenSideChatRequest(detail.entry);
			} else {
				// Another tab (or one still mounting) — stash it, keyed by the target
				// conversation so only the matching tab flushes it.
				pendingSideChatRef.current = detail;
			}
		};
		window.addEventListener("ryu:open-side-chat", handler);
		return () => window.removeEventListener("ryu:open-side-chat", handler);
	}, [handleOpenSideChatRequest]);

	// Flush a pending side chat once this tab's conversation matches the one the
	// sidebar asked to open (exact id match, so other tabs never steal it).
	useEffect(() => {
		const pending = pendingSideChatRef.current;
		if (pending && pending.conversationId === convId) {
			pendingSideChatRef.current = null;
			handleOpenSideChatRequest(pending.entry);
		}
	}, [convId, handleOpenSideChatRequest]);

	// Stop the current stream. Aborting the SSE (`stop()`) only halts the client's
	// read — an ACP agent keeps running to completion server-side — so we ALSO ask
	// Core to cancel the live turn for this conversation. Best-effort: the endpoint
	// returns `{ cancelled: false }` when there is no live turn, and any error is
	// ignored so Stop always feels instant. The id is the same session key sent as
	// `conversation_id` on each turn.
	const handleStop = useCallback(() => {
		stop();
		// A resumed turn is read by our own fetch, not by useChat — `stop()` does
		// not touch it, so abort that reader explicitly or Stop would look dead.
		resumeAbort.current?.abort();
		setResumeStreaming(false);
		resumeSuppressedUntil.current = Date.now() + RESUME_STOP_GRACE_MS;
		const conversationId = convIdRef.current ?? draftConvId.current;
		cancelChat(chatTargetRef.current, conversationId).catch(() => {
			// No live turn (or Core unreachable) — the SSE abort above still stands.
		});
	}, [stop]);

	const toggleChatSearch = useCallback(() => {
		setActiveChatSearchMatchIndex(0);
		setChatSearch((current) =>
			current.open
				? {
						...current,
						mode: current.mode === "chat" ? "files" : "chat",
						nonce: current.nonce + 1,
					}
				: {
						...current,
						mode: "chat",
						nonce: current.nonce + 1,
						open: true,
						query: "",
					}
		);
	}, []);

	// Publish this tab's chat-owned shortcut handlers while it is the FOCUSED tab.
	// Every chat tab stays mounted, and the hotkey provider keeps one handler per
	// action id (last-writer-wins), so binding `chat.stop` inside ChatPage would
	// let a hidden tab own it and abort the wrong stream. Layout binds the ids
	// once and reads this slot; the owner token means a deactivating tab only
	// clears the slot when a newer tab has not already claimed it.
	const hotkeyOwner = useId();
	const publishHotkeyTargets = useChatHotkeyTargets((s) => s.publish);
	const clearHotkeyTargets = useChatHotkeyTargets((s) => s.clearIfOwner);
	const publishFileTreeSearch = useFileTreeSearchStore((s) => s.publish);
	const clearFileTreeSearch = useFileTreeSearchStore((s) => s.clearIfOwner);
	useEffect(() => {
		if (!isActiveTab) {
			clearHotkeyTargets(hotkeyOwner);
			clearFileTreeSearch(hotkeyOwner);
			return;
		}
		publishHotkeyTargets(hotkeyOwner, {
			// `effectiveStatus`, not `status`: a resumed turn streams outside
			// useChat, and Stop must stay live for it.
			isStreaming:
				effectiveStatus === "streaming" || effectiveStatus === "submitted",
			stop: handleStop,
			startVoiceMode: voiceMode.start,
			toggleBottomPanel: showBottomPanelToggle
				? () => setBottomPanelOpen((v) => !v)
				: null,
			toggleRightPanel: () => setRightPanelOpen((v) => !v),
			toggleSearch: toggleChatSearch,
		});
		publishFileTreeSearch(hotkeyOwner, fileSearchRequest);
		return () => {
			clearHotkeyTargets(hotkeyOwner);
			clearFileTreeSearch(hotkeyOwner);
		};
	}, [
		chatSearch,
		clearFileTreeSearch,
		fileSearchRequest,
		isActiveTab,
		hotkeyOwner,
		effectiveStatus,
		handleStop,
		voiceMode.start,
		toggleChatSearch,
		showBottomPanelToggle,
		publishHotkeyTargets,
		publishFileTreeSearch,
		clearHotkeyTargets,
	]);

	// Branch ("fork into new chat"): ask where the copy should run before calling
	// Core. The request keeps the source conversation id with the message so a tab
	// switch while the dialog is open cannot fork the wrong thread.
	const [forkRequest, setForkRequest] = useState<{
		conversationId: string;
		messageId: string;
	} | null>(null);

	const handleBranch = useCallback(
		(messageId: string) => {
			// Prepended history from another thread in the merged agent view: every
			// action below writes into the LIVE conversation, so a foreign id must
			// bounce rather than branch the wrong thread.
			if (isMergedHistoryId(messageId)) {
				return;
			}
			if (!activeConversationId) {
				return;
			}
			setForkRequest({
				conversationId: activeConversationId,
				messageId,
			});
		},
		[activeConversationId]
	);

	const handleForkDestination = useCallback(
		(destination: ForkDestination) => {
			if (!forkRequest) {
				return;
			}
			const request = forkRequest;
			setForkRequest(null);
			void forkConversation(request.conversationId, request.messageId)
				.then((newId) => {
					if (!newId) {
						toast.error("Could not fork this chat.");
						return;
					}
					openTab("/chat", {
						conversationId: newId,
						forceNew: true,
						worktreeMode: destination === "worktree",
					});
				})
				.catch(() => {
					toast.error("Could not fork this chat.");
				});
		},
		[forkConversation, forkRequest, openTab]
	);

	const handleHandOffToWorktree = useCallback(
		(branchName: string) => {
			if (currentTabId) {
				updateTabWorktreeMode(currentTabId, true);
			}
			toast.success("Chat handed off to worktree", {
				description: `The next response will continue on ${branchName}.`,
			});
		},
		[currentTabId, updateTabWorktreeMode]
	);
	const handleWorktreeModeChange = useCallback(
		(enabled: boolean) => {
			if (currentTabId) {
				updateTabWorktreeMode(currentTabId, enabled);
			}
		},
		[currentTabId, updateTabWorktreeMode]
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
			if (isMergedHistoryId(messageId)) {
				return;
			}
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
			if (isMergedHistoryId(messageId)) {
				return;
			}
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
			if (isMergedHistoryId(versionId)) {
				return;
			}
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
			const now = Date.now();
			setMessages(history.map((m) => hydrateHistoryMessage(m, now)));
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
		reorder: reorderQueued,
	} = useMessageQueue({
		status: effectiveStatus,
		send: handleSend,
		// `handleStop`, not useChat's bare `stop`: the queue's force-send path
		// interrupts the run and waits for the status to return to "ready". Raw
		// `stop()` leaves a resumed reader attached, so `effectiveStatus` would
		// stay "streaming" and the forced item would never drain.
		stop: handleStop,
		blocked: composerBlocked,
	});
	const queueDrainMode = useQueueDrainMode();

	// Intercept the `/btw` slash command: ask an ephemeral side question about the
	// current conversation. Returns true when the input was a `/btw` command (and
	// should not be sent as a normal message). The question/answer never enter the
	// chat history — they live only in the overlay. Available even while a turn is
	// streaming (the side question is independent of the main run).
	const maybeHandleBtwCommand = useCallback(
		(raw: string) => {
			const text = raw.trim();
			if (
				!(
					sideChatsPluginEnabled &&
					(text === "/btw" || text.startsWith("/btw "))
				)
			) {
				return false;
			}
			const question = text.slice("/btw".length).trim();
			if (!question) {
				// `/btw` alone is a no-op (nothing to ask) — but still swallow it so it
				// isn't sent to the agent as a literal message.
				return true;
			}
			askSideChatQuestion(question);
			return true;
		},
		[askSideChatQuestion, sideChatsPluginEnabled]
	);

	const handleContributedSelectionAction = useCallback(
		(action: ContributedSelectionAction, context: SelectionActionContext) => {
			const dispatch = action.args?.dispatch;
			if (
				action.plugin === SIDE_CHATS_PLUGIN_ID &&
				dispatch === SIDE_CHAT_SELECTION_DISPATCH
			) {
				const intent: SideChatSelectionIntent =
					action.args?.intent === "explain" ? "explain" : "ask";
				askSideChatQuestion(
					buildSideChatSelectionQuestion(intent, context.text)
				);
				return;
			}

			const capability = action.capability?.trim();
			if (!(action.plugin && capability)) {
				return;
			}
			const conversationId = convIdRef.current ?? activeConversationId;
			void pluginHostInvoke(chatTarget, action.plugin, capability, {
				...(action.args ?? {}),
				selection_text: context.text,
				...(conversationId ? { conversation_id: conversationId } : {}),
				...(effectiveModel ? { model: effectiveModel } : {}),
			});
		},
		[activeConversationId, askSideChatQuestion, chatTarget, effectiveModel]
	);

	// Route composer submits: when busy, enqueue; when idle, send straight
	// through. The blocked path keeps the existing behaviour (records the message
	// in blockedMessages so it is never silently dropped).
	// Pending quote (ChatGPT-style): text the user selected in a message and chose
	// to quote. Shown above the composer and prepended to the next message as a
	// markdown blockquote on send. A reply action also keeps the source identity
	// long enough to offer a focused fork for older, longer chains.
	const [quote, setQuote] = useState<string | null>(initialQuote ?? null);
	const [replyContext, setReplyContext] = useState<MessageReply | null>(null);
	const [creatingReplyThread, setCreatingReplyThread] = useState(false);
	const quoteConversationRef = useRef(convId);
	useEffect(() => {
		if (quoteConversationRef.current === convId) {
			return;
		}
		quoteConversationRef.current = convId;
		setQuote(null);
		setReplyContext(null);
	}, [convId]);

	const handleQuote = useCallback((text: string) => {
		setQuote(text);
		setReplyContext(null);
	}, []);
	const handleReply = useCallback(
		(reply: MessageReply) => {
			setQuote(reply.text);
			setReplyContext(
				convId &&
					!isMergedHistoryId(reply.messageId) &&
					shouldSuggestReplyThread(reply.chainLength)
					? reply
					: null
			);
		},
		[convId]
	);
	const clearReply = useCallback(() => {
		setQuote(null);
		setReplyContext(null);
	}, []);

	// Mirror unsent composer text into the `@ryu/drafts` outbox so closing the tab
	// does not destroy it. A no-op unless that app is enabled, and a blank composer
	// deletes the draft — which is also how a SEND clears it, since submitting
	// empties the text.
	// Keyed on THIS tab's conversation: the draft and the auto-queue belong to the
	// thread whose composer holds the text, not to whichever tab has focus.
	const draftContext = useMemo(
		() => ({
			conversationId: convId ?? undefined,
			agentId: agentId ?? undefined,
			model: effectiveModel ?? undefined,
			folderPath: chatFolder ?? undefined,
			persist: !ghostChatActive,
		}),
		[convId, agentId, effectiveModel, chatFolder, ghostChatActive]
	);
	const autosaveDraft = useComposerDraftAutosave(draftContext);
	const restoredDraft = useComposerDraftRestore(draftContext);
	const maybeAutoQueue = useComposerAutoQueue(draftContext);
	const composerDraftRef = useRef("");
	const handleDraftChange = useCallback(
		(draft: string) => {
			composerDraftRef.current = draft;
			autosaveDraft(draft);
		},
		[autosaveDraft]
	);
	const composerSeed = initialSubmit
		? undefined
		: (initialPrompt ?? restoredDraft);
	const handleCreateFocusedThread = useCallback(async () => {
		const pending = replyContext;
		if (!(pending && convId) || creatingReplyThread) {
			return;
		}
		setCreatingReplyThread(true);
		try {
			const newConversationId = await forkConversation(
				convId,
				pending.messageId
			);
			if (!newConversationId) {
				toast.error("Could not create a focused thread.");
				return;
			}
			const draft = composerDraftRef.current.trim();
			openTab("/chat", {
				conversationId: newConversationId,
				forceNew: true,
				initialModel: effectiveModel ?? undefined,
				initialPrompt: draft || undefined,
				initialQuote: pending.text,
				title: "Focused thread",
			});
			clearReply();
		} catch {
			toast.error("Could not create a focused thread.");
		} finally {
			setCreatingReplyThread(false);
		}
	}, [
		clearReply,
		convId,
		creatingReplyThread,
		forkConversation,
		effectiveModel,
		openTab,
		replyContext,
	]);

	const submitNow = useCallback(
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
				setReplyContext(null);
			}
			if (composerBlocked) {
				handleSend(outgoing);
				return;
			}
			if (
				effectiveStatus === "ready" ||
				effectiveStatus === "error" ||
				queueDrainMode === "off"
			) {
				if (effectiveStatus === "error") {
					clearError();
				}
				handleSend(outgoing);
			} else {
				const attachments = attachmentRef.current.attachedImages;
				enqueueMessage(outgoing.content, attachments);
				setAttachedImages([]);
			}
		},
		[
			composerBlocked,
			effectiveStatus,
			queueDrainMode,
			clearError,
			handleSend,
			enqueueMessage,
			maybeHandleBtwCommand,
			quote,
		]
	);

	// The auto-queue gate sits IN FRONT of the send, not inside it: when the node is
	// already at its concurrency ceiling and the user has asked for queueing, the
	// message becomes an armed draft and no turn starts. Only MANUAL sends pass
	// through here — the launchpad/dispatcher auto-submit path below calls
	// `submitNow` directly, because a draft the dispatcher just released for having
	// a free slot must not be re-queued by a reading taken a moment later.
	const handleComposerSubmit = useCallback(
		async (message: { role: "user"; content: string }) => {
			if (await maybeAutoQueue(message.content)) {
				return;
			}
			submitNow(message);
		},
		[maybeAutoQueue, submitNow]
	);

	const handleAgentUiSubmit = useCallback(
		(value: unknown) => {
			const content =
				typeof value === "string"
					? value
					: (JSON.stringify(value) ?? String(value));
			return handleComposerSubmit({ role: "user", content });
		},
		[handleComposerSubmit]
	);

	// Queued messages belong to the conversation they were typed in. Switching
	// conversations resets useChat (status → "ready"), which would otherwise drain
	// stale items into the new thread — clear on every switch (mirrors the
	// blockedMessages reset below).
	// `activeConversationId` is load-bearing. `clearQueue` is
	// `useCallback(() => setQueue([]), [])` — a permanently stable identity — so
	// on its own this effect runs once at mount and NEVER on a thread switch,
	// which is exactly the stale-drain the comment above says it prevents.
	useEffect(() => {
		clearQueue();
	}, [clearQueue, activeConversationId]);

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
		autoSubmitFired.current = true;
		// Hand the seeded message to the SAME entry point a manual send uses.
		// `submitNow` already routes every state safely — it sends when
		// ready, ENQUEUES when the turn isn't ready yet (the queue drains on ready),
		// and records into `blockedMessages` (visible error state) when the
		// gateway/Core is down. The previous `if (composerBlocked || status !==
		// "ready") return` guard dropped the message in exactly those two cases:
		// the launchpad text is never placed in the composer (`seedDraft` is
		// suppressed for `initialSubmit`), so a bailed effect made the message
		// silently vanish after the redirect from the empty-tabs shell — the user
		// landed on an empty new chat with nothing sent.
		submitNow({ role: "user", content });
	}, [initialSubmit, initialPrompt, initialImages, submitNow]);

	// The first Ryu conversation is opened by Core as an assistant-only turn. No
	// synthetic user message is handed to useChat, and a not-ready local model is
	// retried until the same durable idempotency key completes.
	const proactiveOpeningStartedRef = useRef(false);
	const proactiveOpeningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null
	);
	useEffect(() => {
		return () => {
			if (proactiveOpeningTimerRef.current) {
				clearTimeout(proactiveOpeningTimerRef.current);
			}
		};
	}, []);
	useEffect(() => {
		if (
			!initialProactiveOpening ||
			proactiveOpeningStartedRef.current ||
			agentId !== "ryu"
		) {
			return;
		}
		proactiveOpeningStartedRef.current = true;
		const conversationId = convIdRef.current ?? draftConvId.current;
		if (!convIdRef.current) {
			createConversation(conversationId, { agentId: "ryu" });
			setConvId(conversationId);
			setActiveConversationId(conversationId);
		}
		const idempotencyKey = `desktop:ryu-opening:v1:${conversationId}`;
		let cancelled = false;
		let attempt: () => Promise<void>;
		const scheduleRetry = () => {
			if (!cancelled) {
				proactiveOpeningTimerRef.current = setTimeout(attempt, 5000);
			}
		};
		attempt = async () => {
			if (cancelled) {
				return;
			}
			try {
				const result = await startProactiveOpening(
					chatTarget,
					conversationId,
					"ryu",
					idempotencyKey
				);
				if (cancelled) {
					return;
				}
				if (
					result.status !== "completed" &&
					result.status !== "already_completed"
				) {
					scheduleRetry();
					return;
				}
				const page = await loadMessagesPageResult(conversationId);
				if (cancelled) {
					return;
				}
				const now = Date.now();
				if (page.status === "ok" && page.messages.length > 0) {
					setMessages(
						page.messages.map((message) => hydrateHistoryMessage(message, now))
					);
				} else if (result.reply) {
					setMessages([
						{
							id: `proactive-opening-${conversationId}`,
							role: "assistant",
							parts: [{ type: "text", text: result.reply }],
						} as unknown as UIMessage,
					]);
				}
				seedTitleFromFirstMessage(conversationId, "Getting started with Ryu");
			} catch (error) {
				if (cancelled) {
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				if (!/failed: (400|401|403|404)$/.test(message)) {
					scheduleRetry();
				}
			}
		};
		void attempt();
		return () => {
			cancelled = true;
			if (proactiveOpeningTimerRef.current) {
				clearTimeout(proactiveOpeningTimerRef.current);
			}
		};
	}, [
		agentId,
		chatTarget,
		createConversation,
		initialProactiveOpening,
		loadMessagesPageResult,
		seedTitleFromFirstMessage,
		setActiveConversationId,
		setMessages,
	]);

	// Adopt the composer target from the conversation THIS TAB is on — once per
	// conversation. Keyed on the tab-local `convId`, never on the shared
	// focused-tab `activeConversationId`: every chat tab stays mounted, so the
	// shared id made every background tab re-target itself onto the focused tab's
	// agent. That is the "set opencode in one pane and Claude in another and both
	// collapse onto whichever tab is active" bug, and — because the effect also
	// listed `agentId` as a dependency — the reason picking a different agent
	// inside an existing thread snapped straight back to the thread's stored one.
	// The pick is the user's; the conversation only seeds it.
	const hydratedTargetConvRef = useRef<string | null>(null);
	useEffect(() => {
		if (botProduct) {
			return;
		}
		const { hydrate, agentId: pinnedAgentId } = conversationTargetDecision({
			conversationId: convId,
			hydratedConversationId: hydratedTargetConvRef.current,
			conversationAgentId: convId ? getConversation(convId)?.agentId : null,
		});
		if (!(hydrate && pinnedAgentId)) {
			return;
		}
		hydratedTargetConvRef.current = convId;
		// An existing thread is agent-pinned (conversations carry an agentId, never
		// a team) — drop any persistent team pick so the composer target matches
		// the thread instead of silently fanning out to a group.
		setTeamId(null);
		if (pinnedAgentId !== agentIdRef.current) {
			setAgentId(pinnedAgentId);
			setModelSelectionCleared(false);
			// Keep the model picker in sync when the conversation pins its agent
			// back (each thread owns its agent; the model follows the agent).
			setSelectedModel(getAgentModel(pinnedAgentId));
		}
	}, [botProduct, convId, getConversation]);

	// Last link in the seed chain: the node-wide default agent
	// (`default-agent-selection`), which arrives asynchronously and so cannot sit
	// in the `agentId` initializer. It only ever FILLS A HOLE — a composer that
	// still has no agent at all — so a merged-view pin, a tab seed, the last-used
	// hint, a conversation's pinned agent, or the user picking one while the
	// preference was in flight all win over it.
	const nodeDefaultAgentId = useNodeDefaultAgentId();
	useEffect(() => {
		if (botProduct) {
			return;
		}
		if (shouldAdoptNodeDefault(agentIdRef.current, nodeDefaultAgentId)) {
			setAgentId(nodeDefaultAgentId);
			setModelSelectionCleared(false);
			setSelectedModel(getAgentModel(nodeDefaultAgentId));
		}
	}, [botProduct, nodeDefaultAgentId]);

	// Active permission requests are rendered by the shared composer surface. The
	// gate is a real `data-ryu-permission` request from Core (the ACP
	// `session/request_permission` seam), never the part's own stream state.
	//
	// The tool row remains transcript history; only the active decision card is
	// allowed to replace the composer, so an approval cannot appear twice.
	// The request that blocks the turn is resolved over `/api/chat/permission`.
	//
	// #403: Synthesise blocked-message entries as visible user messages so they
	// appear in the thread even when not sent. Append them after the real messages.
	const visibleMessages = useMemo(() => {
		if (blockedMessages.length === 0) {
			return messages;
		}
		const blocked = blockedMessages.map((bm) => ({
			id: bm.id,
			role: "user" as const,
			parts: [{ type: "text" as const, text: bm.content }],
			_blocked: true,
		}));
		return [...messages, ...blocked];
	}, [messages, blockedMessages]);

	// Inject a per-agent label prefix into the first text part of each
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

	// What the transcript actually renders. In the merged agent view the older
	// threads sit above the live one; everything else in this page — the context
	// meter, "does this thread have messages", the transcript copy — deliberately
	// keeps reading `processedMessages`, because those messages are NOT in the
	// model's context and do not belong to the live conversation.
	const renderedMessages = useMemo(
		() =>
			merged.messages.length > 0
				? [
						...(merged.messages as unknown as typeof processedMessages),
						...processedMessages,
					]
				: processedMessages,
		[merged.messages, processedMessages]
	);
	const chatSearchMatches = useMemo(
		() =>
			chatSearch.mode === "chat"
				? searchChatMessages(renderedMessages, chatSearch.query)
				: [],
		[chatSearch.mode, chatSearch.query, renderedMessages]
	);
	const activeChatSearchMatch =
		chatSearchMatches[activeChatSearchMatchIndex] ?? null;
	useEffect(() => {
		setActiveChatSearchMatchIndex((current) =>
			chatSearchMatches.length === 0
				? 0
				: Math.min(current, chatSearchMatches.length - 1)
		);
	}, [chatSearchMatches.length]);
	useEffect(() => {
		if (
			!(chatSearch.open && chatSearch.mode === "chat" && activeChatSearchMatch)
		) {
			return;
		}
		const frame = window.requestAnimationFrame(() => {
			window.dispatchEvent(
				new CustomEvent("ryu:scroll-to-message", {
					detail: { messageId: activeChatSearchMatch.anchorMessageId },
				})
			);
		});
		return () => window.cancelAnimationFrame(frame);
	}, [
		activeChatSearchMatch?.anchorMessageId,
		activeChatSearchMatch?.messageId,
		chatSearch.mode,
		chatSearch.open,
	]);

	const closeChatSearch = useCallback(() => {
		setActiveChatSearchMatchIndex(0);
		setChatSearch((current) => ({
			...current,
			mode: "chat",
			nonce: current.nonce + 1,
			open: false,
			query: "",
		}));
	}, []);
	const changeChatSearchMode = useCallback((mode: ChatSearchMode) => {
		setActiveChatSearchMatchIndex(0);
		setChatSearch((current) =>
			current.mode === mode
				? current
				: { ...current, mode, nonce: current.nonce + 1, open: true }
		);
	}, []);
	const changeChatSearchQuery = useCallback((query: string) => {
		setActiveChatSearchMatchIndex(0);
		setChatSearch((current) => ({ ...current, query, open: true }));
	}, []);
	const nextChatSearchMatch = useCallback(() => {
		setActiveChatSearchMatchIndex((current) =>
			chatSearchMatches.length === 0
				? 0
				: (current + 1) % chatSearchMatches.length
		);
	}, [chatSearchMatches.length]);
	const previousChatSearchMatch = useCallback(() => {
		setActiveChatSearchMatchIndex((current) =>
			chatSearchMatches.length === 0
				? 0
				: (current - 1 + chatSearchMatches.length) % chatSearchMatches.length
		);
	}, [chatSearchMatches.length]);

	// #415: Stable slot reference for the custom InputBar. Using useMemo with an
	// empty dep array so the component identity is stable across renders, avoiding
	// textarea focus loss on every keystroke. Agents are accessed from state
	// through a stable ref pattern inside CouncilInputBar itself.
	const agentsStableRef = useRef(agents);
	agentsStableRef.current = agents;
	const teamsStableRef = useRef(teams);
	teamsStableRef.current = teams;
	const workflowsStableRef = useRef(workflows);
	workflowsStableRef.current = workflows;
	// Aggregate the "@" mention sources into one object, held in a ref so
	// the memoized composer slot stays stable (same pattern as the agent/team
	// refs above). buildMentionGroups filters this per keystroke.
	const mentionSources = useMemo<MentionSources>(() => {
		const enabled = registeredApps.filter((app) => app.enabled);
		const enabledById = new Map(enabled.map((app) => [app.id, app]));
		const toAppMentionSource = (app: (typeof enabled)[number]) => ({
			...appMentionVisual(app),
			description: app.tagline ?? app.description ?? undefined,
			id: app.id,
			name: app.name,
		});
		return {
			agents: agents.map((a) => ({ id: a.id, name: a.name })),
			chats: conversations
				.filter((conversation) => conversation.id !== convId)
				.map((conversation) => ({
					id: conversation.id,
					name: conversation.title,
					description: conversation.lastMessage,
				})),
			apps: enabled
				.filter((app) => app.companion !== null)
				.map(toAppMentionSource),
			appItems: mentionableResources.appItems.map((item) => ({
				...item,
				...appMentionVisual(enabledById.get(item.ownerId ?? "")),
			})),
			integrations: buildComposioMentionSources(
				composioConfigured,
				composioConnections,
				composioToolkits
			),
			teams: teams.map((t) => ({ id: t.id, name: t.name })),
			// Only chat-triggerable workflows (a root Input node, per Core) are
			// offered — a workflow that never reads the typed message would
			// silently ignore it.
			workflows: workflows
				.filter((w) => w.chatInput)
				.map((w) => ({ id: w.id, name: w.name, description: w.description })),
			spaces: spaces.map((s) => ({ id: s.id, name: s.name })),
			pages: mentionableResources.pages,
			outputStyles: mentionableResources.outputStyles,
			skills: installedSkills.map((s) => ({ id: s.id, name: s.name })),
			mcp: mcpServers.map((m) => ({ id: m.name, name: m.name })),
			folders: recentFolders,
			plugins: enabled
				.filter((app) => app.companion === null)
				.map(toAppMentionSource),
			users: humanMentionDirectory.users,
		};
	}, [
		agents,
		conversations,
		convId,
		teams,
		workflows,
		spaces,
		installedSkills,
		mcpServers,
		composioConfigured,
		composioConnections,
		composioToolkits,
		recentFolders,
		registeredApps,
		mentionableResources,
		humanMentionDirectory.users,
	]);
	const humanMentionNotifyRef = useRef<
		(mentions: SelectedHumanMention[], content: string) => void
	>(() => undefined);
	const notifyHumanMentions = useCallback(
		(mentions: SelectedHumanMention[], content: string) => {
			if (!inboxEnabled || mentions.length === 0) {
				return;
			}
			const senderName =
				oidcUser?.name?.trim() || oidcUser?.email?.trim() || "Someone";
			const title = `${senderName} mentioned you`.slice(0, 120);
			const body =
				`${senderName} mentioned you in chat:\n${content.trim()}`.slice(
					0,
					1800
				);
			void Promise.allSettled(
				mentions.map((mention) =>
					pluginHostInvoke(chatTarget, "@ryu/approvals", "notifications.send", {
						body,
						target_user_id: mention.id,
						title,
					})
				)
			).then((results) => {
				const failedNames = results.flatMap((result, index) =>
					result.status === "rejected" && mentions[index]
						? [mentions[index].label]
						: []
				);
				if (failedNames.length > 0) {
					toast.error({
						title: `Couldn't notify ${failedNames.join(", ")}`.slice(0, 180),
					});
				}
			});
		},
		[inboxEnabled, chatTarget, oidcUser?.email, oidcUser?.name]
	);
	humanMentionNotifyRef.current = notifyHumanMentions;
	const mentionSourcesRef = useRef(mentionSources);
	mentionSourcesRef.current = mentionSources;
	const resolvedMentionItems = useMemo(
		() =>
			buildMentionGroups(mentionSources, "")
				.flatMap((group) => group.items)
				.map((item) => ({
					accentColor: item.accentColor,
					icon: item.icon
						? createElement(item.icon, { className: "size-3.5" })
						: undefined,
					id: item.id,
					kind: item.kind,
					label: item.label,
					target: item.target,
					visualIcon: item.visualIcon,
				})),
		[mentionSources]
	);
	const turnProgress = useMemo(
		() => deriveTurnComposerProgress(messages),
		[messages]
	);
	useEffect(() => {
		if (!convId || messages.length === 0) {
			return;
		}
		publishSidebarTodoProgress({
			key: sidebarTodoProgressKey({
				conversationId: convId,
				nodeUrl: chatTarget.url,
			}),
			messages,
			revision: getConversation(convId)?.updatedAt ?? 0,
		});
	}, [chatTarget.url, convId, getConversation, messages]);
	const composerWorktreeDiff = useWorktreeDiff(chatTarget, diffConvId);
	const turnProgressWithPreviews = useMemo(() => {
		if (!turnProgress) {
			return undefined;
		}
		return {
			...turnProgress,
			files: turnProgress.files.map((file) => {
				const worktreeFile = composerWorktreeDiff.files.find(
					(candidate) =>
						candidate.path === file.path ||
						file.path.endsWith(`/${candidate.path}`) ||
						candidate.path.endsWith(`/${file.path}`)
				);
				return worktreeFile
					? {
							...file,
							preview: patchForFile(
								composerWorktreeDiff.unified_diff,
								worktreeFile.path
							),
						}
					: file;
			}),
		};
	}, [
		composerWorktreeDiff.files,
		composerWorktreeDiff.unified_diff,
		turnProgress,
	]);
	const turnProgressRef = useRef(turnProgressWithPreviews);
	turnProgressRef.current = turnProgressWithPreviews;

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
	// The SAME usage the composer ring shows, derived here too so the Context
	// panel and the ring can never report different numbers (the ring derives it
	// internally from the identical inputs — see `deriveContextUsage`).
	const contextUsage = useMemo(
		() => deriveContextUsage(processedMessages, contextSize),
		[processedMessages, contextSize]
	);

	const composerCompact = processedMessages.length > 0;
	const composerCompactRef = useRef(composerCompact);
	composerCompactRef.current = composerCompact;

	// ── App-contributed composer controls (`contributes.composer_controls`) ─────
	//
	// The manifest vocabulary is `toggle` | `select` | `chip` | `action`, and each
	// reaches the composer through one of its EXISTING seams (see
	// `plugin-composer-controls.ts`): toggles are "+" menu rows, menu-placed
	// selects are settings-menu sections (fed to the shared factory as
	// `extraSections`, the same seam the ACP approval/config pickers use), and
	// chips/actions/bar-placed selects render in the composer toolbar. Nothing here
	// is per-app: an entry whose `type` this build doesn't know is dropped by the
	// partition, so a newer control degrades to "not shown" instead of breaking the
	// composer.
	const partitionedComposerControls = useMemo(
		() => partitionComposerControls(pluginContributions.composer_controls),
		[pluginContributions.composer_controls]
	);

	// The string-valued controls (a `select`'s chosen option, a `chip`'s live id),
	// keyed by each control's `flag`. Separate from `pluginFlags` because the wire
	// `plugin_flags` map is bool-only (Core's `ChatRequest`), so these values stay
	// desktop-side for now — see the note on `buildPluginFlags`.
	const [pluginControlValues, setPluginControlValues] = useState<
		Record<string, string>
	>({});
	// Stable + idempotent: re-setting the same value returns the SAME object, so a
	// chip mirroring its polled value into state can't drive a render loop.
	const setPluginControlValue = useCallback(
		(flag: string, value: string | null) => {
			setPluginControlValues((prev) => {
				if (value === null) {
					if (!(flag in prev)) {
						return prev;
					}
					const next = { ...prev };
					delete next[flag];
					return next;
				}
				return prev[flag] === value ? prev : { ...prev, [flag]: value };
			});
		},
		[]
	);

	// Menu-placed `select` controls, as settings-menu sections. The section's items
	// ARE the control's options, so the shell renders a mode picker it knows
	// nothing about. An options-less one is auto-hidden by the menu.
	const pluginComposerSelectSections = useMemo<ComposerSettingsSection[]>(
		() =>
			partitionedComposerControls.selects.map((control) => ({
				key: composerPluginSectionKey(control),
				ariaLabel: control.label,
				label: control.label,
				items: composerSelectOptions(control).map((option) => ({
					id: option.value,
					name: option.label,
					description: option.description ?? null,
				})),
				value: composerSelectValue(control, pluginControlValues),
				onChange: (id: string) => setPluginControlValue(control.flag, id),
			})),
		[
			partitionedComposerControls.selects,
			pluginControlValues,
			setPluginControlValue,
		]
	);

	// The factory's extra sections: ChatPage's own ACP approval/config pickers plus
	// whatever the enabled apps contributed.
	const composerExtraSections = useMemo(
		() => [...acp.extraSections, ...pluginComposerSelectSections],
		[acp.extraSections, pluginComposerSelectSections]
	);

	const {
		infoBar: composerInfoBar,
		leftActions: composerLeft,
		picker: composerPicker,
		refreshRoutingAdvice,
		rightActions: composerRight,
		sections: composerSections,
		triggerSections: composerTriggerSections,
		renderBody: composerRenderBody,
	} = useComposerAgentControls({
		compact: composerCompact,
		placement: chatPickerPlacement,
		agents,
		// An empty thread is a conversation start, which is the only point an
		// agent-swapping fallback rule may move the whole agent. Mirrors the turn
		// path's own test (`conversation_id.is_none() || messages.len() <= 1`):
		// zero RENDERED messages here is the same moment the server sees a single
		// message — the turn it is about to run. Read from THIS tab's `convId`, not
		// the shared focused-tab id, or a background tab reports the focused tab's
		// thread state and its fallback notice describes the wrong turn.
		atConversationStart: convId === null || processedMessages.length === 0,
		teams,
		agentId,
		teamId,
		onCreateAgent: () => openCreateAgent(),
		onSelectTeam: (id) => {
			setTeamId(id);
			const team = teams.find((candidate) => candidate.id === id);
			announceComposerSelection("Agent", team?.name ?? "Team");
		},
		onSelectAgent: (id) => {
			setTeamId(null);
			setAgentId(id);
			// The pick is authoritative for THIS tab only. Remembering it seeds the
			// next brand-new chat; it must never reach back into another tab, which
			// is why nothing reads this key except a fresh composer's initializer.
			rememberLastUsedAgent(id);
			setModelSelectionCleared(false);
			setSelectedModel(getAgentModel(id));
			const selectedAgent = agents.find((candidate) => candidate.id === id);
			announceComposerSelection("Agent", selectedAgent?.name ?? id);
		},
		modelOptions,
		model: effectiveModel,
		onModelChange: handleModelChange,
		modelSection: acp.modelSection,
		extraSections: composerExtraSections,
		managedProduct: botProduct,
	});
	const sideChatComposerDirectory = useMemo(
		() => createComposerDirectory(composerSections),
		[composerSections]
	);

	// Bar-placed controls (chips, actions, inline selects), rendered into the
	// composer toolbar's right slot below.
	const pluginComposerBar =
		!botProduct && partitionedComposerControls.bar.length > 0 ? (
			<PluginComposerBarControls
				controls={partitionedComposerControls.bar}
				onActionFired={firePluginActionFlag}
				onValueChange={setPluginControlValue}
				values={pluginControlValues}
			/>
		) : null;

	// The "check my balance every time I send" half of the threshold fallback.
	// Bound to the turn LIFECYCLE rather than the submit handler: a send can land
	// through three paths here (direct, queued, blocked-retry), and the spend a
	// rule tests only exists once the turn has actually run — so re-asking as the
	// stream settles back to `ready` is both simpler and more accurate than
	// firing at keystroke time. Cache-backed in Core, so this is not a vendor
	// round-trip per message.
	const wasStreamingRef = useRef(false);
	useEffect(() => {
		const streaming = status !== "ready";
		if (wasStreamingRef.current && !streaming) {
			refreshRoutingAdvice();
		}
		wasStreamingRef.current = streaming;
	}, [status, refreshRoutingAdvice]);

	const composerControlsRef = useRef<{
		infoBar: InputBarInfoBar | undefined;
		left: ReactNode;
		right: ReactNode;
		goalBar: InputBarProps["goalBar"];
		goalControls: InputBarProps["goalControls"];
	}>({
		infoBar: undefined,
		left: null,
		right: null,
		goalBar: undefined,
		goalControls: undefined,
	});
	const replyThreadInfoBar: InputBarInfoBar | undefined =
		replyContext && convId
			? {
					action: {
						label: creatingReplyThread ? "Creating…" : "Create thread",
						onClick: handleCreateFocusedThread,
					},
					description: replyThreadDescription(replyContext.chainLength),
					onClose: clearReply,
					title: "Long reply chain",
				}
			: undefined;
	composerControlsRef.current = {
		// The threshold-fallback notice ("running this turn on X because Y is
		// low"). Rides the same ref as the other composer controls so the memoized
		// InputBar picks it up without re-rendering on every advice refetch.
		infoBar: replyThreadInfoBar ?? composerInfoBar,
		// In the merged agent view the composer must say which thread a send joins
		// — the transcript above it spans several. Sits ahead of the shared
		// agent/model controls so it reads as the destination, not a setting.
		left: mergedAgentId ? (
			<>
				<MergedThreadPicker
					activeConversationId={convId}
					onNewThread={startFreshThread}
					onSelectThread={setConvId}
					threads={merged.threads}
				/>
				{composerLeft}
			</>
		) : (
			composerLeft
		),
		// Contributed bar controls sit after the shell's own right-hand controls,
		// in the one slot the memoized InputBar reads from this ref.
		right: pluginComposerBar ? (
			<>
				{composerRight}
				{pluginComposerBar}
			</>
		) : (
			composerRight
		),
		goalBar:
			goalState?.goal || goalDraftOpen
				? {
						achieved: goalState?.status === "achieved",
						achievedAt: goalState?.achieved_at,
						paused: goalState?.status === "paused",
						onCancelDraft: () => setGoalDraftOpen(false),
						onClear: handleGoalClear,
						onPause: handleGoalPause,
						onResume: handleGoalResume,
						onSubmit: handleGoalSubmit,
						reason: goalState?.last_reason,
						startedAt: goalState?.started_at,
						startInEdit: goalDraftOpen,
						text: goalState?.goal ?? "",
						turns: goalState?.turns,
					}
				: undefined,
		goalControls: {
			active: Boolean(goalState?.goal),
			onPursueToggle: () => {
				if (goalState?.goal) {
					void handleGoalClear();
				} else {
					setGoalDraftOpen(true);
				}
			},
			onRemove: handleGoalClear,
		},
	};
	// `composerSections` already carries the plugin-contributed select sections:
	// they are fed to the factory as `extraSections` above, so they render inside
	// the composer's own settings dropdown (and its universal-picker body) exactly
	// like the ACP approval/config sections do.
	//
	// This ref feeds the composer's KEYBOARD SHORTCUTS, so it must stay the full
	// list — `firstExtraConfigSection` cycles the first non-agent/model/approval
	// section, and handing it the trigger-narrowed list would repoint that shortcut
	// at a different setting than the one the popover shows.
	const composerSectionsRef =
		useRef<ComposerSettingsSection[]>(composerSections);
	composerSectionsRef.current = composerSections;

	// Workspace strip (project ▸ branch ▸ worktree) rendered above the textarea.
	// Held in a ref like composerControlsRef so the memoized InputBar slot stays
	// stable; WorkspaceBar itself reads the workspace store reactively. The
	// conversation id is the worktree store key, so the draft id is used until a
	// conversation is created.
	// Ryu Work mode starts with no project picker; an explicit local-project request
	// opens the contextual chooser instead. Once a conversation has a thread, the
	// project ▸ branch ▸ worktree strip moves
	// out of the composer and into the floating Pinned summary card (top-right), so
	// the composer footer stays clean during a chat. In Code, a
	// fresh draft keeps the strip in the composer — the natural place to pick a
	// project first.
	const workspaceBarRef = useRef<ReactNode>(null);
	workspaceBarRef.current =
		interfaceLevel === "simple" || processedMessages.length > 0 ? null : (
			<WorkspaceBar
				conversationId={activeConversationId ?? draftConvId.current}
				folderOverride={chatFolder}
				onWorktreeModeChange={handleWorktreeModeChange}
				target={chatTarget}
				worktreeModeOverride={tabWorktreeMode}
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
		onReorder: reorderQueued,
		onClear: clearQueue,
		onQueueModeChange: (mode) => setQueueDrainMode(mode),
		queueMode: queueDrainMode === "off" ? "off" : "auto",
	});
	queueBarRef.current = {
		items: queuedMessages,
		onEdit: editQueued,
		onSendNow: sendQueuedNow,
		onRemove: removeQueued,
		onSendAll: sendQueuedAll,
		onReorder: reorderQueued,
		onClear: clearQueue,
		onQueueModeChange: (mode) => setQueueDrainMode(mode),
		queueMode: queueDrainMode === "off" ? "off" : "auto",
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
			partitionedComposerControls.toggles
				.filter((c) => c.flag !== TEMPORARY_CONTEXT_FLAG || ghostChatActive)
				.map((c) => ({
					id: c.id,
					flag: c.flag,
					label: c.label,
					description: c.description,
					enabled: Boolean(pluginFlags[c.flag]),
					onToggle: (flag: string, next: boolean) =>
						setPluginFlags((m) => ({ ...m, [flag]: next })),
				})),
		[ghostChatActive, partitionedComposerControls.toggles, pluginFlags]
	);
	const pluginComposerControlsRef = useRef<PluginComposerControlRow[]>([]);
	pluginComposerControlsRef.current = pluginComposerControls;
	const expandedComposerPluginEnabledRef = useRef(false);
	expandedComposerPluginEnabledRef.current = expandedComposerPluginEnabled;

	// Temporary chat toggle, now a row in the composer "+" dropdown rather
	// than a standalone toolbar button. Held in a ref (assigned every render) so
	// the memoized InputBar slot stays stable. Only offered on the new-chat surface
	// (no rendered messages) — an existing conversation can't retroactively become
	// temporary — but it stays available during an active temporary chat so the user
	// can see and exit the temporary state. `undefined` hides the row entirely.
	const ghostControlsRef = useRef<GhostControls | undefined>(undefined);
	ghostControlsRef.current =
		ghostChatsPluginEnabled &&
		(processedMessages.length === 0 || ghostChatActive)
			? { active: ghostChatActive, onToggle: toggleGhostMode }
			: undefined;
	const temporaryChatSaveControlsRef = useRef<
		TemporaryChatSaveControls | undefined
	>(undefined);
	temporaryChatSaveControlsRef.current =
		ghostChatActive && messages.length > 0
			? {
					disabled: status === "submitted" || status === "streaming",
					onSave: () => {
						void handleSaveTemporaryChat();
					},
					saving: savingTemporaryChat,
				}
			: undefined;

	const councilInputBar = useMemo(() => {
		return function BoundCouncilInputBar(props: InputBarProps) {
			return (
				<CouncilInputBar
					{...props}
					allAgents={agentsStableRef.current}
					allTeams={teamsStableRef.current}
					allWorkflows={workflowsStableRef.current}
					availableCommands={botProduct ? [] : commandsRef.current}
					chatWidgetTemplates={botProduct ? [] : chatWidgetTemplatesRef.current}
					// Single-row compact composer once the chat has history (read from a
					// ref so the memoized slot flips without rebuilding — same pattern as
					// workspaceBar). Pairs with the right-aligned controls above.
					compact={composerCompactRef.current}
					composerSections={composerSectionsRef.current}
					currentUserId={myUserIdRef.current}
					enableQueue
					expandComposer={
						botProduct ? false : expandedComposerPluginEnabledRef.current
					}
					// Dashed violet composer treatment while a temporary chat is
					// active. `ghostMode` is a dep of this memo, so the closure value is
					// always current (no ref needed).
					ghost={botProduct ? false : ghostChatActive}
					// The "+" dropdown's Temporary-chat toggle row (read fresh from the
					// ref so gating on rendered messages stays current).
					ghostControls={botProduct ? undefined : ghostControlsRef.current}
					goalBar={botProduct ? undefined : composerControlsRef.current.goalBar}
					goalControls={
						botProduct ? undefined : composerControlsRef.current.goalControls
					}
					infoBar={botProduct ? undefined : composerControlsRef.current.infoBar}
					leftActions={composerControlsRef.current.left}
					mentionSources={mentionSourcesRef.current}
					onGenerateImage={botProduct ? undefined : handleGenerateImage}
					onGenerateVideo={botProduct ? undefined : handleGenerateVideo}
					onHumanMentions={(mentions, content) =>
						humanMentionNotifyRef.current(mentions, content)
					}
					onReferencedChats={(ids) => {
						referencedConversationIdsRef.current = ids;
					}}
					onRespondPermission={permissionRef.current.onRespond}
					onTargetAgentChange={(id) => {
						targetAgentIdRef.current = id;
					}}
					onTeamChange={(id) => {
						teamIdRef.current = id;
					}}
					onTyping={handleTypingActivity}
					onWorkflowChange={(id) => {
						workflowIdRef.current = id;
					}}
					permission={permissionRef.current.permission}
					pluginControls={
						botProduct ? undefined : pluginComposerControlsRef.current
					}
					queueBar={queueBarRef.current}
					rightActions={composerControlsRef.current.right}
					temporaryChatSaveControls={
						botProduct ? undefined : temporaryChatSaveControlsRef.current
					}
					turnProgress={turnProgressRef.current}
					voice={{
						transcribe: voiceTranscribe,
						disabled: composerBlockedRef.current,
					}}
					voiceMode={botProduct ? undefined : { onStart: voiceMode.start }}
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
		ghostChatActive,
		handleTypingActivity,
	]);

	const hasThread =
		activeConversationId !== null || processedMessages.length > 0;

	// "History page" = the conversation has actual messages on screen. The
	// new-chat surface (centered empty state) can still carry a focused-tab
	// `activeConversationId`, so gate the workspace-bar relocation and the pinned
	// summary strictly on rendered messages — never on the new-chat page.
	const hasMessages = processedMessages.length > 0;
	const subagentSummaries = useMemo(
		() => extractSubagents(messages),
		[messages]
	);
	const planSnapshots = useMemo(() => extractPlans(messages), [messages]);
	const artifactsSpace = useMemo(
		() =>
			spaces.find(
				(space) =>
					space.name.toLowerCase() === ARTIFACTS_SPACE_NAME.toLowerCase()
			) ?? null,
		[spaces]
	);
	const [savedPlanDocuments, setSavedPlanDocuments] = useState<
		Record<string, SavedPlanDocument>
	>({});
	const [planSaveErrors, setPlanSaveErrors] = useState<Record<string, string>>(
		{}
	);
	const planPersistenceRef = useRef<{
		contents: Map<string, string>;
		documents: Map<string, SavedPlanDocument>;
		targetKey: string;
	}>({
		contents: new Map(),
		documents: new Map(),
		targetKey: "",
	});
	const planSyncQueueRef = useRef<Promise<void>>(Promise.resolve());
	const planTargetKey = `${chatTarget.url}|${chatTarget.token ?? ""}`;

	useEffect(() => {
		const cache = planPersistenceRef.current;
		if (cache.targetKey === planTargetKey) {
			return;
		}
		cache.contents.clear();
		cache.documents.clear();
		cache.targetKey = planTargetKey;
		setSavedPlanDocuments({});
		setPlanSaveErrors({});
	}, [planTargetKey]);

	// Persist every completed ACP/Pi plan snapshot as a markdown page in the
	// node's seeded Artifacts Space. Stable document titles make this idempotent
	// across reloads and let another tab reuse a page that already exists.
	useEffect(() => {
		if (planSnapshots.length === 0) {
			return;
		}
		if (!(spacesLoading || artifactsSpace)) {
			const message =
				spacesError ?? "The Artifacts Space is unavailable on this node.";
			setPlanSaveErrors((previous) => {
				const next = { ...previous };
				for (const plan of planSnapshots) {
					next[plan.key] = message;
				}
				return next;
			});
			return;
		}
		if (!artifactsSpace) {
			return;
		}
		const cache = planPersistenceRef.current;
		if (cache.targetKey !== planTargetKey) {
			return;
		}
		const pendingPlans: PlanSnapshot[] = planSnapshots.filter((plan) => {
			const cacheKey = `${artifactsSpace.id}:${plan.key}`;
			return cache.contents.get(cacheKey) !== plan.markdown;
		});
		if (pendingPlans.length === 0) {
			return;
		}

		let cancelled = false;
		const persist = async () => {
			let existingByTitle = new Map<string, { id: string }>();
			try {
				const documents = await fetchDocuments(chatTarget, artifactsSpace.id);
				existingByTitle = new Map(
					documents.map((document) => [document.title, { id: document.id }])
				);
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Could not read the Artifacts Space.";
				if (cancelled) {
					return;
				}
				setPlanSaveErrors((previous) => {
					const next = { ...previous };
					for (const plan of pendingPlans) {
						next[plan.key] = message;
					}
					return next;
				});
				return;
			}

			for (const plan of pendingPlans) {
				if (cancelled) {
					return;
				}
				const cacheKey = `${artifactsSpace.id}:${plan.key}`;
				if (cache.contents.get(cacheKey) === plan.markdown) {
					continue;
				}
				try {
					let documentId = cache.documents.get(cacheKey)?.documentId;
					if (!documentId) {
						documentId = existingByTitle.get(planDocumentTitle(plan))?.id;
					}
					if (documentId) {
						const current = await fetchDocument(
							chatTarget,
							artifactsSpace.id,
							documentId
						);
						if (current.source !== plan.markdown) {
							await updateDocument(
								chatTarget,
								artifactsSpace.id,
								documentId,
								planDocumentTitle(plan),
								plan.markdown
							);
						}
					} else {
						documentId = await ingestDocument(
							chatTarget,
							artifactsSpace.id,
							planDocumentTitle(plan),
							plan.markdown
						);
					}
					if (cancelled) {
						return;
					}
					const saved = {
						documentId,
						spaceId: artifactsSpace.id,
					};
					cache.documents.set(cacheKey, saved);
					cache.contents.set(cacheKey, plan.markdown);
					setSavedPlanDocuments((previous) => ({
						...previous,
						[plan.key]: saved,
					}));
					setPlanSaveErrors((previous) => {
						if (!(plan.key in previous)) {
							return previous;
						}
						const next = { ...previous };
						delete next[plan.key];
						return next;
					});
				} catch (error) {
					if (cancelled) {
						return;
					}
					const message =
						error instanceof Error
							? error.message
							: "Could not save this plan.";
					setPlanSaveErrors((previous) => ({
						...previous,
						[plan.key]: message,
					}));
				}
			}
		};

		planSyncQueueRef.current = planSyncQueueRef.current
			.catch(() => undefined)
			.then(persist);
		return () => {
			cancelled = true;
		};
	}, [
		artifactsSpace,
		chatTarget,
		planSnapshots,
		planTargetKey,
		spacesError,
		spacesLoading,
	]);

	const planArtifacts = useMemo(
		() =>
			planSnapshots.map((plan) =>
				planArtifact(
					plan,
					savedPlanDocuments[plan.key],
					planSaveErrors[plan.key]
				)
			),
		[planSaveErrors, planSnapshots, savedPlanDocuments]
	);

	// The Pinned summary sidebar shows only on a history page. It stacks with
	// the right panel (both docked columns can be open at once) — visibility is
	// just the user's titlebar toggle (`pinnedSummaryOpen`).
	const pinnedSummaryVisible = hasMessages && pinnedSummaryOpen;
	const pinnedSummaryFolder = convId
		? (getConversation(convId)?.folderPath ?? null)
		: null;

	// The Cowork context (Progress / Artifacts / Changes / Sources / Side chats),
	// shared by the right panel's Context tab and the floating Pinned summary card.
	const coworkData = {
		messages,
		runId: convId,
		target: chatTarget,
		chatStatus: effectiveStatus,
		planArtifacts,
		onOpenArtifact: handleOpenArtifact,
		onOpenSideChat: handleOpenSideChat,
		onOpenSubagent: handleOpenSubagent,
		onOpenSources: handleOpenSources,
		onOpenSubagents: handleOpenSubagents,
		sideChatsRefreshKey,
		sideChatsEnabled: sideChatsPluginEnabled,
	};

	// The desktop half of the artifact host: `@ryu/blocks` renders an inline
	// artifact card through this context (openInPanel / openInTab / fetchContent /
	// submitFollowUp), and the Renderer is our InlineArtifact card. `openInTab`
	// resolves a created artifact's blob BEFORE the tab opens so the window-tab
	// page (which has no host) renders content rather than an empty view.
	const artifactHostValue = useMemo<ArtifactHostValue>(() => {
		const openArtifactTab = (payload: HostArtifact, id: string) => {
			const artifact = artifactFromPayload(payload, id, "tool");
			const openTabNow = (resolved: Artifact) => {
				useArtifactStore.getState().put(resolved);
				openTab(`/artifact/${id}`, {
					title: resolved.title,
					icon: { kind: "icon", id: "hugeicons:browser" },
				});
			};
			if (!artifact.content && artifact.url) {
				Promise.resolve(fetchArtifactContent(chatTarget, artifact.url))
					.then((content) =>
						openTabNow(content ? { ...artifact, content } : artifact)
					)
					.catch(() => openTabNow(artifact));
				return;
			}
			openTabNow(artifact);
		};
		return {
			openInPanel: (payload, id) =>
				handleOpenArtifact(artifactFromPayload(payload, id, "tool")),
			openInTab: openArtifactTab,
			fetchContent: (payload) =>
				payload.url
					? fetchArtifactContent(chatTarget, payload.url)
					: Promise.resolve(null),
			submitFollowUp: (text) => {
				Promise.resolve(
					handleComposerSubmit({ role: "user", content: text })
				).catch(() => undefined);
			},
			Renderer: InlineArtifact,
		};
	}, [chatTarget, handleOpenArtifact, openTab, handleComposerSubmit]);

	// A ghost thread has no store-backed title (it's never persisted), so label it
	// "Temporary chat" to reinforce that this conversation won't be saved.
	const persistedTitle = activeConversationId
		? getConversation(activeConversationId)?.title
		: undefined;
	const conversationTitle = ghostChatActive
		? "Temporary chat"
		: (persistedTitle ?? "New chat");

	// Push the conversation title and contextual actions into the shared titlebar.
	// Actions are memoized so the effect only re-fires when the relevant state changes.
	const titlebarActions = useMemo(() => {
		// The agent info icon, branch, council participants, and sessions moved
		// into the composer toolbar (see composerControlsRef.left). Only the tool
		// count, copy transcript, and the panel toggles remain in the titlebar.
		const threadActions =
			hasThread && agentTools.length > 0 ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<span className="hidden truncate px-2 text-muted-foreground text-xs lg:inline">
								{formatCount(agentTools.length) ?? "—"} tool
								{agentTools.length === 1 ? "" : "s"}
							</span>
						}
					/>
					<TooltipContent>{agentTools.join(", ")}</TooltipContent>
				</Tooltip>
			) : null;

		const copyTranscriptAction = hasMessages ? (
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							aria-label="Copy transcript"
							className="flex size-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							onClick={() => {
								void copyChatTranscript(
									processedMessages as unknown as TranscriptMessage[],
									{
										defaultUserName: oidcUser?.name || oidcUser?.email,
									}
								);
							}}
							type="button"
						>
							<HugeiconsIcon
								className="size-4"
								icon={ClipboardIcon}
								stroke="currentColor"
							/>
						</button>
					}
				/>
				<TooltipContent>Copy transcript</TooltipContent>
			</Tooltip>
		) : null;

		const shareAction =
			hasMessages && activeConversationId && !ghostChatActive ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								aria-label="Share conversation"
								className="flex size-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
								onClick={() => setShareDialogOpen(true)}
								type="button"
							>
								<HugeiconsIcon
									className="size-4"
									icon={Share08Icon}
									stroke="currentColor"
								/>
							</button>
						}
					/>
					<TooltipContent>Share conversation</TooltipContent>
				</Tooltip>
			) : null;

		const pickerAction =
			chatPickerPlacement === "tab-bar" ? (
				<span
					className="flex min-w-0 items-center"
					data-testid="chat-model-agent-picker-tab-bar"
				>
					{composerPicker}
				</span>
			) : null;

		return (
			<>
				{pickerAction}
				{threadActions}
				{copyTranscriptAction}
				{shareAction}
				<PanelToggleButtons
					bottomOpen={bottomPanelOpen}
					folder={chatFolder}
					onBottomToggle={() => setBottomPanelOpen((v) => !v)}
					onPinnedSummaryToggle={
						hasMessages ? () => setPinnedSummaryOpen((v) => !v) : undefined
					}
					onRightToggle={() => setRightPanelOpen((v) => !v)}
					pinnedSummaryOpen={pinnedSummaryOpen}
					rightOpen={rightPanelOpen}
					showBottomPanelToggle={showBottomPanelToggle}
				/>
			</>
		);
	}, [
		hasThread,
		hasMessages,
		activeConversationId,
		ghostChatActive,
		agentTools,
		processedMessages,
		composerPicker,
		chatPickerPlacement,
		bottomPanelOpen,
		showBottomPanelToggle,
		rightPanelOpen,
		chatFolder,
		pinnedSummaryOpen,
	]);

	const historyErrorCopy =
		connectionPhase === "online"
			? {
					description:
						"This node didn't answer. Your messages are still on it — nothing has been lost.",
					title: "Couldn't load this conversation",
				}
			: connectionPhase === "offline"
				? {
						description:
							"Ryu will retry automatically when your connection returns.",
						title: "Waiting for connectivity",
					}
				: {
						description:
							"Ryu will retry automatically when this node reconnects.",
						title: "Waiting for node",
					};

	useTitleBar(hasThread ? conversationTitle : null, titlebarActions);

	return (
		<ArtifactHostContext.Provider value={artifactHostValue}>
			<ForkDialog
				onOpenChange={(open) => {
					if (!open) {
						setForkRequest(null);
					}
				}}
				onSelect={handleForkDestination}
				open={forkRequest !== null}
			/>
			{activeConversationId && !ghostChatActive ? (
				<ShareConversationDialog
					conversationId={activeConversationId}
					onOpenChange={setShareDialogOpen}
					open={shareDialogOpen}
					target={chatTarget}
					title={conversationTitle}
				/>
			) : null}
			<WorkspaceRequiredDialog
				onFolderSelected={handleWorkspaceFolderSelected}
				onOpenChange={(open) => {
					if (!open) {
						setPendingWorkspaceMessage(null);
					}
				}}
				open={pendingWorkspaceMessage !== null}
			/>
			<WorkspacePanels
				artifactRequest={artifactReq}
				bottomOpen={bottomPanelOpen}
				collectionRequest={collectionReq}
				contextRequest={contextReq}
				contextView={{
					conversationId: activeConversationId ?? draftConvId.current,
					target: chatTarget,
					usage: contextUsage,
				}}
				cowork={coworkData}
				fileReviewRequest={fileReviewRequest}
				fileSearchRequest={fileSearchRequest}
				folder={chatFolder}
				onBottomOpenChange={setBottomPanelOpen}
				onRightOpenChange={setRightPanelOpen}
				renderPinnedSummary={
					pinnedSummaryVisible
						? ({ floating }) => (
								<PinnedSummaryPanel
									conversationId={convId ?? draftConvId.current}
									cowork={coworkData}
									folder={pinnedSummaryFolder}
									onAttachTextFile={handleAttachTextFile}
									onDismiss={floating ? dismissPinnedSummary : undefined}
									onHandOffToWorktree={handleHandOffToWorktree}
									onInterruptChat={handleStop}
									onWorktreeModeChange={handleWorktreeModeChange}
									pullRequestsEnabled={pullRequestsEnabled}
									showLineStats={interfaceLevel !== "simple"}
									target={chatTarget}
									worktreeModeOverride={tabWorktreeMode}
								/>
							)
						: null
				}
				rightOpen={rightPanelOpen}
				subagentRequest={subagentReq}
			>
				<div className="flex h-full flex-col overflow-hidden">
					<SubagentActivityChips
						onOpen={handleOpenSubagent}
						subagents={subagentSummaries}
					/>
					{/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: custom drag/resize interaction */}
					<div
						className="relative flex-1 overflow-hidden"
						onDragLeave={handleDragLeave}
						onDragOver={handleDragOver}
						onDrop={handleDrop}
					>
						{chatSearch.open && (
							<ChatSearchBar
								activeMatchIndex={activeChatSearchMatchIndex}
								folderAvailable={Boolean(chatFolder)}
								matches={chatSearchMatches}
								mode={chatSearch.mode}
								onClose={closeChatSearch}
								onModeChange={changeChatSearchMode}
								onNextMatch={nextChatSearchMatch}
								onPreviousMatch={previousChatSearchMatch}
								onQueryChange={changeChatSearchQuery}
								query={chatSearch.query}
							/>
						)}
						<WidgetHostContext.Provider value={widgetHostValue}>
							<AgentChat
								agentMessageContext={agentMessageContext}
								answerNow={answerNowControl}
								assistantAvatar={assistantIdentity.avatar}
								assistantName={assistantIdentity.name}
								assistantPlanningAvatars={assistantPlanningAvatars}
								assistantTitle={assistantIdentity.title}
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
								// Opening this thread jumps the transcript to the newest
								// message; the id is what makes that fire once per
								// conversation rather than on every history rewrite.
								conversationKey={convId ?? undefined}
								currentUser={{
									avatar: oidcUser?.picture,
									id: myUserId ?? undefined,
									name: oidcUser?.name || oidcUser?.email,
								}}
								draftControls={draftControls}
								// Launchpad: every openable app as a grid of icon tiles under
								// the composer, on the start page only. Renders nothing when no
								// enabled app contributes a UI surface.
								emptyStateFooter={botProduct ? null : <AppLaunchpad />}
								emptyStateHeader={
									<EmptyStateHeader
										interactiveLogo={!botProduct}
										logo={emptyStateLogo}
										// The full Agent · Model · Thinking dropdown from the shared
										// composer factory — the logo opens the identical menu the
										// composer's settings trigger does, not just an agent list.
										renderBody={composerRenderBody}
										// The narrowed list: this logo IS a settings trigger, so it
										// summarises exactly what the composer's own trigger does.
										sections={composerTriggerSections}
										showProjectPicker={!botProduct}
										// Temporary chat: the empty-state greeting whispers
										// "secretly" so it's obvious this thread won't be saved.
										title={
											ghostChatActive
												? "What are we secretly doing?"
												: undefined
										}
									/>
								}
								emptyStatePosition="center"
								error={error ?? undefined}
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
								goalCompletion={
									!botProduct && goalState?.status === "achieved"
										? ({
												achievedAt: goalState.achieved_at,
												messageId: goalCompletionMessageId ?? undefined,
												startedAt: goalState.started_at,
											} satisfies GoalCompletion)
										: undefined
								}
								hasOlderMessages={hasOlderMessages}
								// A restored tab must say "loading this conversation", never
								// paint the new-chat greeting — that is what reads as "all my
								// chats are gone" at boot. Both flags are false for a genuinely
								// new chat (no conversation id), so the greeting is untouched
								// there.
								historyError={
									historyFailed
										? {
												...historyErrorCopy,
												onRetry: retryHistoryLoad,
											}
										: undefined
								}
								historyLoading={historyLoading}
								historyNotice={latestAcpTranscriptNotice ?? undefined}
								key={`${activeNode.url}-${chatId}`}
								loadingOlderMessages={loadingOlderMessages}
								mentionItems={resolvedMentionItems}
								messageActionStates={messageActionStates}
								messageActions={contributedMessageActions}
								messages={renderedMessages}
								onAgentUiSubmit={handleAgentUiSubmit}
								onBranch={activeConversationId ? handleBranch : undefined}
								onClearQuote={clearReply}
								onContributedMessageAction={
									activeConversationId
										? handleContributedMessageAction
										: undefined
								}
								onContributedSelectionAction={handleContributedSelectionAction}
								onDraftChange={handleDraftChange}
								onEditMessage={
									activeConversationId ? handleEditMessage : undefined
								}
								onLoadOlderMessages={loadOlderMessages}
								onOpenContext={handleOpenContext}
								onOpenFile={handleOpenFileLink}
								onOpenLink={handleOpenWebsiteLink}
								onOpenMention={handleOpenMention}
								onQuote={handleQuote}
								onRegenerateMessage={
									activeConversationId ? handleRegenerateMessage : undefined
								}
								onReply={handleReply}
								onRetryError={handleRetryError}
								// Unconditional: a generation part is client-only, so retrying
								// one needs no persisted conversation (unlike regenerate above).
								onRetryGeneration={handleRetryGeneration}
								onReviewFileEdits={handleReviewFileEdits}
								onSelectVersion={
									activeConversationId ? handleSelectVersion : undefined
								}
								onSend={handleComposerSubmit}
								onSpeak={handleSpeak}
								onStop={handleStop}
								onUndoFileEdits={handleUndoFileEdits}
								onWorkflowResume={handleWorkflowResume}
								previewResolvers={linkPreviewResolvers}
								quote={quote}
								searchActiveMessageId={
									chatSearch.open && chatSearch.mode === "chat"
										? activeChatSearchMatch?.messageId
										: undefined
								}
								seedDraft={composerSeed}
								selectionActions={contributedSelectionActions}
								showCopyToolbar
								slots={{ InputBar: councilInputBar }}
								statsModelName={effectiveModel ?? undefined}
								statsPluginEnabled={statsPluginEnabled}
								statsUsage={statsUsage}
								status={effectiveStatus}
								toolRenderers={EMPTY_TOOL_RENDERERS}
								versions={versions}
								voiceMode={voiceModeSlot}
							/>
						</WidgetHostContext.Provider>
						{/* The Pinned summary sidebar (project ▸ branch ▸ worktree + git
					    changes + commit & push) is rendered by WorkspacePanels via
					    renderPinnedSummary — docked column stacked with the right panel,
					    auto-demoted to a floating overlay when the chat gets narrow. */}
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
				{sideChatsPluginEnabled && (
					<BtwOverlay
						composerMenuGroups={sideChatComposerDirectory.groups}
						mentionItems={resolvedMentionItems}
						onAsk={(question) => {
							maybeHandleBtwCommand(`/btw ${question}`);
						}}
						onClose={() => setBtwState(null)}
						state={btwState}
					/>
				)}
				{activePluginNote && (
					<div className="fixed bottom-28 left-1/2 z-50 w-[min(40rem,90vw)] -translate-x-1/2 rounded-lg bg-popover p-3 text-popover-foreground text-sm shadow-lg">
						<div className="mb-1 flex items-center justify-between">
							<span className="font-medium text-muted-foreground text-xs">
								{activePluginNote.question ? "Action summary" : "Double-check"}
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
						{activePluginNote.question && (
							<p className="mb-1 font-medium">{activePluginNote.question}</p>
						)}
						<p className="whitespace-pre-wrap">{activePluginNote.text}</p>
					</div>
				)}
			</WorkspacePanels>
		</ArtifactHostContext.Provider>
	);
}
