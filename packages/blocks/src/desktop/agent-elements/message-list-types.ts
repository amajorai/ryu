import type { ChatStatus, UIMessage } from "ai";
import type React from "react";
import type { AnswerNowControl } from "./answer-now.ts";
import type { GoalCompletion } from "./goal-message.ts";
import type { LinkPreviewResolvers } from "./link-preview.tsx";
import type { MessageReadReceiptState } from "./message-read-receipt.tsx";
import type { FileEditUndoPlan } from "./turn-end-cards.ts";
import type {
	AgentMessageContext,
	AgentUiSubmit,
	ContributedMessageAction,
	ContributedSelectionAction,
	CustomToolRendererProps,
	MentionItem,
	MessageActionContext,
	MessageActionRuntimeState,
	MessageReply,
	SelectionActionContext,
} from "./types.ts";
import type {
	NativeSdkValue,
	RenderedMessage,
} from "./utils/native-sdk-observation.ts";
import type { WorkflowResumeHandler } from "./workflow-run-part.tsx";

export interface MessageListProps {
	/** Agent identities used when an agent-comms tool becomes a transcript activity. */
	agentMessageContext?: AgentMessageContext;
	/** Native-provider action shown directly below the active thinking row. */
	answerNow?: AnswerNowControl;
	/**
	 * Avatar node shown beside each assistant turn (e.g. the active agent's
	 * logo, or a fanned stack of member logos for a team). When omitted, no
	 * avatar is rendered. Goes inside `MessageAvatar`.
	 */
	assistantAvatar?: React.ReactNode;
	/**
	 * Display name shown above each assistant turn (agent or team name). When
	 * omitted, no header is rendered.
	 */
	assistantName?: string;
	/**
	 * Marks for the agents currently working on the turn, drawn side by side in
	 * the live status row so a running turn says WHO is on it, not just that
	 * something is happening. Falls back to `assistantAvatar` when omitted, and
	 * to the spiral loader when there is no avatar at all.
	 */
	assistantPlanningAvatars?: React.ReactNode[];
	/** Optional role/title badge shown beside each assistant name. */
	assistantTitle?: string;
	className?: string;
	classNames?: {
		messageList?: string;
		userMessage?: string;
	};
	/**
	 * The active model's context window in tokens. When provided, a completed
	 * assistant turn shows a Twitter-style context-usage ring (tokens used vs
	 * this size) in its stats footer. Omitted ⇒ speed only, no ring.
	 */
	contextSize?: number;
	/**
	 * Identity of the thread being shown, used to fire the open-at-bottom jump
	 * once per conversation (see {@link ChatDisplayPrefs.openAtBottom}). Pass the
	 * conversation id when the surface has one — the fallback (the first
	 * message's id) also changes when history is rewritten, e.g. editing the
	 * opening user message mints a new id and would re-jump.
	 */
	conversationKey?: string;
	/**
	 * Current signed-in user info for displaying avatar/name on own messages.
	 */
	currentUser?: {
		avatar?: string;
		name?: string;
		id?: string;
	};
	/**
	 * When true (default) clicking an attached image in a user message opens
	 * the fullscreen lightbox preview. Set to false to disable previews.
	 */
	enableImagePreview?: boolean;
	/** Completion data shown beside the assistant turn that finished the goal. */
	goalCompletion?: GoalCompletion;
	/** True when a page older than the visible transcript is available. */
	hasOlderMessages?: boolean;
	/**
	 * A non-model notice about the THREAD rather than about a turn — "this
	 * conversation was imported", "history before this point was trimmed" — drawn
	 * as a `Marker` after the last message, with its optional actions as inline
	 * links.
	 *
	 * It lands as the final direct child of the scroller's Content, which is
	 * deliberate: it carries no `data-scroll-anchor`, so `firstAnchorAtOrAfter`
	 * skips it and appending it can never steal the scroll target from the user's
	 * next question.
	 */
	historyNotice?: {
		actions?: { label: string; onClick: () => void }[];
		description?: string;
		id: string;
		title: string;
	};
	/** Thread-level notices rendered as separator markers in arrival order. */
	historyNotices?: {
		actions?: { label: string; onClick: () => void }[];
		description?: string;
		id: string;
		title: string;
	}[];
	/**
	 * Where to position the scroll container on initial mount.
	 * - "bottom" (default): classic chat behavior, pinned to the latest message.
	 * - "top": start from the top of the conversation — useful for static demos
	 *   or read-only transcripts where the user should read top-to-bottom.
	 */
	initialScrollBehavior?: "bottom" | "top";
	/** True while the transcript is fetching the page above the current one. */
	loadingOlderMessages?: boolean;
	/** Resolved @ mentions used by user and assistant Markdown. */
	mentionItems?: MentionItem[];
	/** Runtime state keyed by message id for contributed action renderers. */
	messageActionStates?: ReadonlyMap<string, MessageActionRuntimeState>;
	/** Contributed per-message toolbar actions (see {@link ContributedMessageAction}),
	 *  rendered after the built-ins. Filtered to the message's `target` by the shell. */
	messageActions?: ContributedMessageAction[];
	/** Durable read markers grouped by message id for the transcript footer. */
	messageReadReceipts?: ReadonlyMap<string, MessageReadReceiptState>;
	messages: RenderedMessage[];
	onAgentUiSubmit?: AgentUiSubmit;
	onAnnotateImage?: (image: {
		filename?: string;
		id: string;
		url: string;
	}) => void;
	/**
	 * Branch ("fork into new chat") a message. When provided, a branch button is
	 * shown in each message's hover toolbar; clicking it calls this with the id of
	 * the message to branch from (history up to and including it is copied).
	 */
	onBranch?: (messageId: string) => void;
	/** Fire a contributed message action (see {@link ContributedMessageAction}). */
	onContributedMessageAction?: (
		action: ContributedMessageAction,
		context: MessageActionContext
	) => void;
	/** Fire a contributed text-selection action with the selected plain text. */
	onContributedSelectionAction?: (
		action: ContributedSelectionAction,
		context: SelectionActionContext
	) => void;
	/**
	 * Edit a previously-sent user message into a new version (ChatGPT/Claude-style
	 * branching). When provided, a pencil button appears in each user message's
	 * hover toolbar; clicking it turns the bubble into an inline editor. Saving
	 * calls this with the message id and new text.
	 */
	onEditMessage?: (messageId: string, newText: string) => void;
	/** Request the next older message page when the viewport reaches the top. */
	onLoadOlderMessages?: () => Promise<void>;
	/** Called when a persisted user message enters the viewport. */
	onMessageVisible?: (messageId: string) => void;
	/**
	 * Open a project file referenced by assistant output or tool summaries.
	 */
	onOpenFile?: (path: string) => void;
	onOpenLink?: (url: string) => void;
	onOpenMention?: (item: MentionItem) => void;
	/**
	 * Quote a text selection made inside a message. When provided, selecting text
	 * in any message surfaces a floating annotate box; its "Quote" action calls
	 * this with the selected plain text and the typed note, if any (the surface
	 * stashes the text as a pending composer quote). When omitted, the box only
	 * offers contributed selection actions, and nothing when there are none.
	 */
	onQuote?: (text: string, note?: string) => void;
	/**
	 * Regenerate an assistant reply as a new version. When provided, a refresh
	 * button appears in each assistant turn's hover toolbar; clicking it calls this
	 * with the last assistant message's id.
	 */
	onRegenerateMessage?: (messageId: string) => void;
	/** Reply to a complete message, including the source id and turn distance. */
	onReply?: (reply: MessageReply) => void;
	/** Retry the current client-side failed request. Persisted error rows use
	 * `onRegenerateMessage` instead because they have a Core message id. */
	onRetryError?: () => void;
	/**
	 * Re-run a failed inline media generation. Called with the assistant message
	 * holding the failed part, which of the two media surfaces it is, and the
	 * prompt that produced it — everything the producer needs to rewrite that same
	 * message in place. Distinct from `onRegenerateMessage`, which branches a
	 * PERSISTED turn server-side: these generation parts are client-only, so there
	 * is no server message to branch from. Without it, a failed generation shows
	 * no Retry.
	 */
	onRetryGeneration?: (
		messageId: string,
		kind: "image" | "video",
		prompt: string
	) => void;
	onReviewFileEdits?: (paths: string[]) => void;
	/**
	 * Rewind code and/or conversation to just before a user message. When
	 * provided, the user message's overflow menu offers "Rewind to here".
	 */
	onRewindMessage?: (messageId: string, text: string) => void;
	/**
	 * Switch the active version at a branch point. When a message has more than one
	 * version (see `versions`), a `< n / m >` pager renders; stepping it calls this
	 * with the target version's message id.
	 */
	onSelectVersion?: (versionId: string) => void;
	/**
	 * Speak an assistant turn aloud (text-to-speech). When provided, a speaker
	 * button is shown in each assistant turn's hover toolbar; clicking it calls
	 * this with the turn's combined text. When omitted, no speak button is shown.
	 */
	onSpeak?: (text: string) => void;
	onUndoFileEdits?: (plan: FileEditUndoPlan) => Promise<void>;
	onWorkflowResume?: WorkflowResumeHandler;
	previewResolvers?: LinkPreviewResolvers;
	/** Message id currently selected by the host's chat-local search. */
	searchActiveMessageId?: string;
	/** Contributed text-selection toolbar actions (see
	 * {@link ContributedSelectionAction}), resolved and ordered by the shell. */
	selectionActions?: ContributedSelectionAction[];
	showCopyToolbar?: boolean;
	slots?: {
		UserMessage?: React.ComponentType<{
			/** Hover actions for the turn. A custom UserMessage MUST render this
			 *  somewhere inside the bubble's column or the toolbar disappears. */
			actions?: React.ReactNode;
			message: UIMessage;
			className?: string;
			readReceipt?: MessageReadReceiptState;
			currentUser?: {
				avatar?: string;
				name?: string;
				id?: string;
			};
			enableImagePreview?: boolean;
			editing?: boolean;
			mentionItems?: MentionItem[];
			onOpenMention?: (item: MentionItem) => void;
			onEditSubmit?: (text: string) => void;
			onEditCancel?: () => void;
		}>;
		ToolRenderer?: React.ComponentType<ToolRendererProps>;
	};
	/** Active model id used for context-window hint parsing. */
	statsModelName?: string;
	/** Enabled-plugin gate for the session stats footer. */
	statsPluginEnabled?: boolean;
	/**
	 * Normalized subscription usage passed by the desktop host. `accountLabel`
	 * names the saved subscription account the usage belongs to, when known.
	 */
	statsUsage?: import("./stats-model.ts").StatsUsageSnapshot | null;
	status: ChatStatus;
	suppressQuestionTool?: boolean;
	toolRenderers?: Record<string, React.ComponentType<CustomToolRendererProps>>;
	/**
	 * Version-pager data keyed by message id: the number of versions at this branch
	 * point, the active index, and the ordered sibling ids to step through. Only
	 * ids with `count > 1` render a pager.
	 */
	versions?: Record<string, { index: number; count: number; ids: string[] }>;
}

export interface ToolPartBase {
	input?: NativeSdkValue;
	output?: NativeSdkValue;
	result?: NativeSdkValue;
	state?: string;
	toolCallId?: string;
	type: string;
}

export interface ToolRendererProps {
	agentMessageContext?: AgentMessageContext;
	chatStatus?: string;
	nestedTools?: ToolPartBase[];
	onAgentUiSubmit?: AgentUiSubmit;
	part: ToolPartBase;
	toolRenderers?: Record<string, React.ComponentType<CustomToolRendererProps>>;
}
