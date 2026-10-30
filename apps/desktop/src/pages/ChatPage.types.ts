import type { AttachedImage } from "@/components/agent-elements/input-bar.tsx";
import type { useChatAcpNotices } from "./ChatPage.acp-notices.ts";
import type { useChatAcpStream } from "./ChatPage.acp-stream.ts";
import type { useChatAnswerNow } from "./ChatPage.answer-now.ts";
import type { useChatAssistantIdentity } from "./ChatPage.assistant-identity.tsx";
import type { useChatAttachments } from "./ChatPage.attachments.ts";
import type { useChatAutoActions } from "./ChatPage.auto-actions.ts";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerControls } from "./ChatPage.composer-controls.tsx";
import type { useChatComposerRefs } from "./ChatPage.composer-refs.tsx";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import type { useChatDraftsAndRewind } from "./ChatPage.drafts-rewind.ts";
import type { useChatForkAndVersions } from "./ChatPage.fork-versions.ts";
import type { useChatGoals } from "./ChatPage.goals.ts";
import type { useChatHistoryLoading } from "./ChatPage.history-loading.ts";
import type { useChatMediaAndVoice } from "./ChatPage.media-voice.ts";
import type { useChatMessagePipeline } from "./ChatPage.message-pipeline.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatPanelRequests } from "./ChatPage.panel-requests.ts";
import type { useChatPermissionsAndLinks } from "./ChatPage.permissions-links.ts";
import type { useChatPlans } from "./ChatPage.plans.tsx";
import type { useChatPluginFlags } from "./ChatPage.plugin-flags.ts";
import type { useChatPresence } from "./ChatPage.presence.ts";
import type { useChatQueueAndReplies } from "./ChatPage.queue-replies.ts";
import type { useChatRealtimeRoom } from "./ChatPage.realtime-room.ts";
import type { useChatResume } from "./ChatPage.resume.ts";
import type { useChatSend } from "./ChatPage.send.ts";
import type { useChatSideChats } from "./ChatPage.side-chats.ts";
import type { useChatTitlebar } from "./ChatPage.titlebar.tsx";
import type { useChatTransport } from "./ChatPage.transport.ts";

export interface ChatPageProps {
	initialAgent?: string;
	/** Open this thread already temporary — the launchpad's "+" offers the toggle
	 * before a conversation exists, so the pick arrives as a seed rather than as a
	 * click on this page's own row. Consumed once on mount. */
	initialGhost?: boolean;
	/** One-shot image attachments staged on the launchpad composer before a
	 * conversation existed, carried into this fresh tab. Consumed once on mount. */
	initialImages?: AttachedImage[];
	/** One-shot model restored into a newly-created focused reply thread. */
	initialModel?: string;
	/** One-shot composer flags carried from the new-chat launchpad. */
	initialPluginFlags?: Record<string, boolean>;
	/** Ask Core to create an assistant-only opening after model readiness. */
	initialProactiveOpening?: boolean;
	initialProject?: string;
	/** One-shot composer seeds from a `ryu://chat/new` deep link. The prompt
	 * pre-fills the composer (NEVER auto-sent — it is attacker-controllable);
	 * agent/project pre-select. Consumed once on mount. */
	initialPrompt?: string;
	/** One-shot quote restored into a newly-created focused reply thread. */
	initialQuote?: string;
	/** When set (launchpad composer only — a user-initiated send), the seeded
	 * `initialPrompt`/`initialImages` is SENT automatically once chat is ready,
	 * instead of just pre-filling. Never set for the deep-link/Inbox paths, whose
	 * text must stay pre-fill-only. */
	initialSubmit?: boolean;
	/** One-shot team target carried from the new-chat launchpad. */
	initialTeamId?: string;
	/** A permanent MCP App supplies the owning conversation and hosts its composer. */
	mcpAppHost?: boolean;
	/**
	 * Messaging-style "one thread per agent" view (`/chat/agent/:agentId`): every
	 * earlier thread with this agent is rendered read-only above the live one, so
	 * the page reads as a single WhatsApp-shaped scroll. Purely a view — the
	 * threads stay separate rows in Core, and the composer's thread picker chooses
	 * which one a send lands in.
	 */
	mergedAgentId?: string;
	tabConversationId?: string;
	/** Per-tab isolation requested by a fork destination or workspace handoff. */
	tabWorktreeMode?: boolean;
}

/** The props after ChatPage's parameter defaults are applied. */
export type ChatPageBaseScope = Omit<ChatPageProps, "mcpAppHost"> &
	Required<Pick<ChatPageProps, "mcpAppHost">>;

/** Every binding ChatPage computes, in render order. */
export type ChatPageScope = ChatPageBaseScope &
	ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatAssistantIdentity> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatPluginFlags> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatGoals> &
	ReturnType<typeof useChatMediaAndVoice> &
	ReturnType<typeof useChatPermissionsAndLinks> &
	ReturnType<typeof useChatAcpStream> &
	ReturnType<typeof useChatAcpNotices> &
	ReturnType<typeof useChatHistoryLoading> &
	ReturnType<typeof useChatResume> &
	ReturnType<typeof useChatAnswerNow> &
	ReturnType<typeof useChatRealtimeRoom> &
	ReturnType<typeof useChatPresence> &
	ReturnType<typeof useChatAttachments> &
	ReturnType<typeof useChatSend> &
	ReturnType<typeof useChatSideChats> &
	ReturnType<typeof useChatPanelRequests> &
	ReturnType<typeof useChatForkAndVersions> &
	ReturnType<typeof useChatQueueAndReplies> &
	ReturnType<typeof useChatDraftsAndRewind> &
	ReturnType<typeof useChatAutoActions> &
	ReturnType<typeof useChatMessagePipeline> &
	ReturnType<typeof useChatComposerControls> &
	ReturnType<typeof useChatComposerRefs> &
	ReturnType<typeof useChatPlans> &
	ReturnType<typeof useChatTitlebar>;
