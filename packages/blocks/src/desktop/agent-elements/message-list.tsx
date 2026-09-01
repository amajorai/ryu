import {
	Alert02Icon,
	ArrowDataTransferHorizontalIcon,
	ArrowDown02Icon,
	BookOpen02Icon,
	InformationCircleIcon,
	MoreHorizontalIcon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AgentTitleBadge } from "@ryu/ui/components/agent-title-badge.tsx";
import {
	type CitationItem,
	CitationList,
} from "@ryu/ui/components/agents/citations";
import { MessageScroller as BeuiMessageScroller } from "@ryu/ui/components/agents/message-scroller";
import { Bubble, BubbleContent } from "@ryu/ui/components/bubble";
import { Button } from "@ryu/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { Marker, MarkerContent, MarkerIcon } from "@ryu/ui/components/marker";
import {
	Message,
	MessageAvatar,
	MessageContent,
	MessageFooter,
	MessageHeader,
} from "@ryu/ui/components/message";
import {
	ImageGeneration,
	type ImageGenerationStatus,
} from "@ryu/ui/components/motion/image-generation.tsx";
import { Loader } from "@ryu/ui/components/motion/loader";
import type { PreviewRailItem } from "@ryu/ui/components/motion/preview-rail";
import {
	VideoGeneration,
	type VideoGenerationStatus,
} from "@ryu/ui/components/motion/video-generation.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import {
	formatDateTime,
	formatTime,
	startOfTodayMs,
	useTimezoneRevision,
} from "@ryu/ui/lib/timezone.ts";
import { cn } from "@ryu/ui/lib/utils";
import {
	IconCheck,
	IconChevronLeft,
	IconChevronRight,
	IconCopy,
} from "@tabler/icons-react";
import type { ChatStatus, UIMessage } from "ai";
import { Reply as ReplyIcon } from "lucide-react";
import type React from "react";
import {
	Fragment,
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { AnswerNowControl } from "./answer-now.ts";
import { AnswerNowButton } from "./answer-now-button.tsx";
import { useChatDisplayPrefs } from "./chat-display-prefs.tsx";
import type { ChatTocFileChange, ChatTocItem } from "./chat-toc.tsx";
import {
	dayLabel,
	groupTurnsByDay,
	separatorKeyByTurnIndex,
} from "./date-groups.ts";
import { DateSeparator } from "./date-separator.tsx";
import { ErrorMessage } from "./error-message.tsx";
import { FileTypeIcon } from "./file-type-icon.tsx";
import { FloatingDateHeader } from "./floating-date-header.tsx";
import { GoalCompletionFooter } from "./goal-completion.tsx";
import {
	type GoalCompletion,
	getGoalElapsedMs,
	isGoalMessage,
} from "./goal-message.ts";
import { usePinnedUserMessage } from "./hooks/use-pinned-user-message.ts";
import { useTranscriptAnchor } from "./hooks/use-transcript-anchor.ts";
import { InlineImagePreview } from "./image-preview.tsx";
import { FileAttachment } from "./input/file-attachment.tsx";
import type { LinkPreviewResolvers } from "./link-preview.tsx";
import { Markdown } from "./markdown.tsx";
import type { MemoryCitation } from "./memory-citations.ts";
import { MessageActionSurface } from "./message-action-surface.tsx";
import {
	isMemoryCitationsAction,
	isMessageReactionAction,
} from "./message-action-types.ts";
import {
	type MessageGroupPosition,
	messageBubbleRadius,
	messageGroupPositionFor,
} from "./message-bubble.ts";
import {
	clearUnreadMessageState,
	getIncomingMessageIds,
	getUnreadMessageLabel,
	reconcileUnreadMessageState,
	type UnreadMessageState,
} from "./message-list-unread.ts";
import { AcpUsageStats, MessageStats } from "./message-stats.tsx";
import { PinnedUserMessageBar } from "./pinned-user-message-bar.tsx";
import { shouldShowPlanning } from "./planning-visibility.ts";
import { messageSelectableProps, SelectionQuoteToolbar } from "./quote.tsx";
import { StatsFooter } from "./stats-footer.tsx";
import { DEFAULT_STATS_PLUGIN_ENABLED } from "./stats-model.ts";
import {
	hasVisibleContentAtNoDetail,
	isHiddenAtNoDetail,
} from "./tool-detail-visibility.ts";
import { ToolGroup } from "./tools/tool-group.tsx";
import { isToolActivityGroupCandidate } from "./tools/tool-grouping.ts";
import { ToolRenderer as DefaultToolRenderer } from "./tools/tool-renderer.tsx";
import {
	deriveEditedFiles,
	deriveTurnEndCards,
	type FileEditUndoPlan,
	isEditedFilePart,
	isTurnEndArtifactPart,
	isTurnEndJsonRenderPart,
} from "./turn-end-cards.ts";
import { TurnEndCards } from "./turn-end-cards.tsx";
import {
	type AgentMessageContext,
	type AgentUiSubmit,
	type ContributedMessageAction,
	type ContributedSelectionAction,
	type CustomToolRendererProps,
	type MentionItem,
	type MessageActionContext,
	type MessageActionRuntimeState,
	type MessageReply,
	type SelectionActionContext,
	widgetMessageProvenanceKey,
} from "./types.ts";
import { TypingIndicator } from "./typing-indicator.tsx";
import {
	GoalMessageAnnotation,
	MESSAGE_TIME_OPTIONS,
	MESSAGE_TOOLTIP_OPTIONS,
	UserMessage,
} from "./user-message.tsx";
import { extractCitations } from "./utils/citations.ts";
import { normalizeAssistantToolParts } from "./utils/tool-part-normalizer.ts";
import { WorkflowRunProgressCard } from "./workflow-run-part.tsx";

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
	messages: UIMessage[];
	onAgentUiSubmit?: AgentUiSubmit;
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
	/**
	 * Open a project file referenced by assistant output or tool summaries.
	 */
	onOpenFile?: (path: string) => void;
	onOpenLink?: (url: string) => void;
	onOpenMention?: (item: MentionItem) => void;
	/**
	 * Quote a text selection made inside a message. When provided, selecting text
	 * in any message surfaces a floating "Quote" button; clicking it calls this
	 * with the selected plain text (the surface stashes it as a pending composer
	 * quote). When omitted, no selection toolbar is shown.
	 */
	onQuote?: (text: string) => void;
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
	onWorkflowResume?: (runId: string, payload: string) => Promise<unknown>;
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
	/** Normalized subscription usage passed by the desktop host. */
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

interface ToolPartBase {
	input?: unknown;
	output?: unknown;
	result?: unknown;
	state?: string;
	toolCallId?: string;
	type: string;
}

interface ToolRendererProps {
	agentMessageContext?: AgentMessageContext;
	chatStatus?: string;
	nestedTools?: ToolPartBase[];
	onAgentUiSubmit?: AgentUiSubmit;
	part: ToolPartBase;
	toolRenderers?: Record<string, React.ComponentType<CustomToolRendererProps>>;
}

function normalizeMessages(messages: UIMessage[]): UIMessage[] {
	let changed = false;
	const normalized = messages.map((message) => {
		if (Array.isArray(message.parts) && message.parts.length > 0) {
			return message;
		}
		const raw = message as { content?: string; text?: string };
		const content = raw.content ?? raw.text;
		if (typeof content !== "string" || !content) {
			return message;
		}
		changed = true;
		return {
			...message,
			parts: [{ type: "text", text: content }],
		} as UIMessage;
	});
	return changed ? normalized : messages;
}

// `hideToolDetail` is not a cosmetic argument here. At Detail level "None" a
// turn made only of tool calls renders NOTHING, so asking "does the last
// assistant message have content" against the raw parts would answer yes, drop
// the live "Thinking" row, and leave the transcript looking idle for the whole
// time the agent is actually working. The question has to be asked at the same
// detail level the transcript is drawing at.
function getLastAssistantHasContent(
	messages: UIMessage[],
	hideToolDetail: boolean
) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role !== "assistant") {
			continue;
		}
		const parts = msg.parts ?? [];
		if (hideToolDetail) {
			return hasVisibleContentAtNoDetail(parts);
		}
		return parts.some((part) => {
			if (isTextPart(part)) {
				return part.text.trim().length > 0;
			}
			return isV5ToolPart(part);
		});
	}
	return false;
}

/** What the live status row says the agent is doing right now. */
type PlanningActivity = "thinking" | "working" | "typing";

const PLANNING_LABELS: Record<PlanningActivity, string> = {
	thinking: "Assistant is thinking",
	working: "Assistant is working",
	typing: "Assistant is typing",
};

/**
 * Read the current activity off the last assistant message.
 *
 * The LAST part wins, because that is what the agent is doing NOW: a tool part
 * in final position means a call is the most recent thing it did ("Working"),
 * and text in final position means tokens are landing ("Typing"). An opened turn
 * with neither is still "Thinking".
 *
 * Deliberately not keyed on a tool part's `state`: a completed call followed by
 * nothing else still reads as work in progress, since the turn has not settled —
 * the row only exists while `isStreaming`.
 */
function getPlanningActivity(messages: UIMessage[]): PlanningActivity {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role !== "assistant") {
			continue;
		}
		const parts = msg.parts ?? [];
		for (let p = parts.length - 1; p >= 0; p -= 1) {
			// `unknown`, deliberately: `isV5ToolPart` narrows the union so far that
			// the following `isTextPart` sees `never` and its guard stops compiling.
			// Both predicates already validate the shape they claim.
			const part: unknown = parts[p];
			if (isV5ToolPart(part)) {
				return "working";
			}
			if (isTextPart(part) && part.text.trim().length > 0) {
				return "typing";
			}
		}
		return "thinking";
	}
	return "thinking";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** `https://www.example.com/x` → `example.com`, for a citation's domain line. */
function hostnameOfCitation(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
	return (
		isRecord(part) && part.type === "text" && typeof part.text === "string"
	);
}

function isErrorPart(
	part: unknown
): part is { type: "error"; title?: string; message: string } {
	return (
		isRecord(part) && part.type === "error" && typeof part.message === "string"
	);
}

/** An assistant image part, including the filename used by the lightbox. */
function getAssistantImageMeta(
	part: unknown
): { filename?: string; url: string } | null {
	if (!isRecord(part)) {
		return null;
	}
	const type = part.type;
	const media =
		typeof part.mediaType === "string"
			? part.mediaType
			: typeof part.mimeType === "string"
				? part.mimeType
				: undefined;
	const filename =
		typeof part.filename === "string"
			? part.filename
			: typeof part.fileName === "string"
				? part.fileName
				: typeof part.name === "string"
					? part.name
					: undefined;

	const rawUrl =
		type === "image"
			? typeof part.url === "string"
				? part.url
				: typeof part.image === "string"
					? part.image
					: undefined
			: type === "data-image" && isRecord(part.data)
				? typeof part.data.url === "string"
					? part.data.url
					: undefined
				: typeof part.url === "string"
					? part.url
					: undefined;
	const rawData =
		type === "file" && typeof part.data === "string" ? part.data : undefined;
	const url =
		rawUrl ?? (rawData && media ? `data:${media};base64,${rawData}` : null);
	if (
		!(
			url &&
			(type === "image" || type === "data-image" || media?.startsWith("image/"))
		)
	) {
		return null;
	}
	return { filename, url };
}

/** Longest edge, in px, a generated image occupies in the transcript. */
const MAX_IMAGE_EDGE = 360;

const IMAGE_GENERATION_STATUSES = new Set<ImageGenerationStatus>([
	"queued",
	"generating",
	"refining",
	"complete",
	"error",
]);

export interface ImageGenerationPartData {
	/** The prompt that produced it, shown under the frame. */
	prompt?: string;
	/** Where the generation is: `generating` while Core is working, then
	 *  `complete` (with `url`) or `error` (with `statusText` = the reason). */
	status: ImageGenerationStatus;
	/** Overrides the component's stock status line — used to surface the engine's
	 *  own error text instead of a generic "Generation failed". */
	statusText?: string;
	/** The finished image, once there is one. */
	url?: string;
}

/**
 * A client-only image-generation part — the *in-flight* half of an inline
 * `/api/images/generate` turn. The producer (ChatPage / AssistantPanel) appends
 * this the moment generation starts and rewrites the same message in place when
 * the engine answers, so the frame is reserved up front and the finished image
 * fades in with no layout shift. Producer and consumer agree on this exact
 * shape, same as the `file`-part contract above.
 */
function getImageGenerationPart(part: unknown): ImageGenerationPartData | null {
	if (!isRecord(part) || part.type !== "data-image-generation") {
		return null;
	}
	const data = isRecord(part.data) ? part.data : {};
	const status =
		typeof data.status === "string" &&
		IMAGE_GENERATION_STATUSES.has(data.status as ImageGenerationStatus)
			? (data.status as ImageGenerationStatus)
			: "generating";
	return {
		prompt: typeof data.prompt === "string" ? data.prompt : undefined,
		status,
		statusText:
			typeof data.statusText === "string" ? data.statusText : undefined,
		url: typeof data.url === "string" ? data.url : undefined,
	};
}

/**
 * The one inline surface for a generated image, in both its pending and its
 * finished state. The frame is square until the image reports its own
 * dimensions, then takes the real aspect ratio — with `object-contain` so a
 * non-square generation (`size: "512x768"`) is never cropped.
 *
 * `showStatus` is off for images that merely *arrive* as `file` parts (pasted,
 * or streamed by Core): those get the same frame, without a status line
 * describing work that never happened here.
 */
function AssistantGeneratedImage({
	filename,
	onRetry,
	prompt,
	showStatus,
	status,
	statusText,
	url,
}: ImageGenerationPartData & {
	filename?: string;
	onRetry?: () => void;
	showStatus: boolean;
}) {
	const [size, setSize] = useState<{ height: number; width: number } | null>(
		null
	);

	const handleLoad = useCallback(
		(event: React.SyntheticEvent<HTMLImageElement>) => {
			const { naturalHeight, naturalWidth } = event.currentTarget;
			if (naturalWidth > 0 && naturalHeight > 0) {
				setSize({ height: naturalHeight, width: naturalWidth });
			}
		},
		[]
	);

	// The frame is square until the image reports its own dimensions. A portrait
	// generation then narrows rather than growing tall, so BOTH edges stay within
	// the transcript's 360px budget (the old render capped height the same way).
	const maxWidth =
		size && size.height > size.width
			? Math.round(MAX_IMAGE_EDGE * (size.width / size.height))
			: MAX_IMAGE_EDGE;

	return (
		<div className="w-full" style={{ maxWidth }}>
			<ImageGeneration
				aspectRatio={size ? `${size.width} / ${size.height}` : "1 / 1"}
				mediaClassName="[&>*]:object-contain [&_img]:object-contain"
				onRetry={onRetry}
				prompt={prompt}
				// Only ever the image's real dimensions — nothing is claimed before
				// the engine has actually produced something.
				resolution={size ? `${size.width} × ${size.height}` : undefined}
				showStatus={showStatus}
				size="fluid"
				status={status}
				statusText={statusText}
			>
				{url ? (
					<InlineImagePreview
						alt={prompt ?? "Generated image"}
						filename={filename ?? prompt ?? "Generated image"}
						imageClassName="size-full object-contain"
						onLoad={handleLoad}
						src={url}
					/>
				) : null}
			</ImageGeneration>
		</div>
	);
}

const VIDEO_GENERATION_STATUSES = new Set<VideoGenerationStatus>([
	"queued",
	"generating",
	"rendering",
	"complete",
	"error",
]);

export interface VideoGenerationPartData {
	/** A still to hold the frame while the clip buffers, when the engine gave one. */
	poster?: string;
	/** The prompt that produced it, shown under the frame. */
	prompt?: string;
	/** Where the generation is: `generating` while Core is working, then
	 *  `complete` (with `url`) or `error` (with `statusText` = the reason). */
	status: VideoGenerationStatus;
	/** Overrides the component's stock status line — used to surface the engine's
	 *  own error text instead of a generic "Generation failed". */
	statusText?: string;
	/** The finished clip, once there is one. */
	url?: string;
}

/**
 * A client-only video-generation part — the video twin of
 * {@link getImageGenerationPart}, produced by ChatPage's handleGenerateVideo in
 * this exact shape. Same contract, same in-place rewrite when the engine
 * answers.
 */
function getVideoGenerationPart(part: unknown): VideoGenerationPartData | null {
	if (!isRecord(part) || part.type !== "data-video-generation") {
		return null;
	}
	const data = isRecord(part.data) ? part.data : {};
	const status =
		typeof data.status === "string" &&
		VIDEO_GENERATION_STATUSES.has(data.status as VideoGenerationStatus)
			? (data.status as VideoGenerationStatus)
			: "generating";
	return {
		poster: typeof data.poster === "string" ? data.poster : undefined,
		prompt: typeof data.prompt === "string" ? data.prompt : undefined,
		status,
		statusText:
			typeof data.statusText === "string" ? data.statusText : undefined,
		url: typeof data.url === "string" ? data.url : undefined,
	};
}

const SECONDS_PER_MINUTE = 60;

/** `4.2` → `"0:04"`. Only ever called with a duration the element reported. */
function formatClipDuration(seconds: number): string {
	const whole = Math.round(seconds);
	const minutes = Math.floor(whole / SECONDS_PER_MINUTE);
	const rest = whole % SECONDS_PER_MINUTE;
	return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

/**
 * The one inline surface for a generated video, in both its pending and its
 * finished state — the twin of {@link AssistantGeneratedImage}. The frame is
 * 16/9 until the clip reports its own dimensions on `loadedmetadata`, which is
 * also where the duration badge comes from; nothing is claimed before the
 * element has actually measured the media.
 *
 * `showStatus` is off for clips that merely *arrive* as `file` parts, exactly as
 * for images: same frame, no status line describing work that never happened.
 */
function AssistantGeneratedVideo({
	onRetry,
	poster,
	prompt,
	showStatus,
	status,
	statusText,
	url,
}: VideoGenerationPartData & {
	onRetry?: () => void;
	showStatus: boolean;
}) {
	const [meta, setMeta] = useState<{
		duration: number;
		height: number;
		width: number;
	} | null>(null);

	const handleLoadedMetadata = useCallback(
		(event: React.SyntheticEvent<HTMLVideoElement>) => {
			const { duration, videoHeight, videoWidth } = event.currentTarget;
			if (videoWidth > 0 && videoHeight > 0) {
				setMeta({
					duration: Number.isFinite(duration) ? duration : 0,
					height: videoHeight,
					width: videoWidth,
				});
			}
		},
		[]
	);

	// Same budget as the image frame: a portrait clip narrows rather than growing
	// tall, so BOTH edges stay within the transcript's 360px allowance.
	const maxWidth =
		meta && meta.height > meta.width
			? Math.round(MAX_IMAGE_EDGE * (meta.width / meta.height))
			: MAX_IMAGE_EDGE;

	return (
		<div className="w-full" style={{ maxWidth }}>
			<VideoGeneration
				aspectRatio={meta ? `${meta.width} / ${meta.height}` : "16 / 9"}
				duration={
					meta && meta.duration > 0
						? formatClipDuration(meta.duration)
						: undefined
				}
				mediaClassName="[&>*]:object-contain [&_video]:object-contain"
				onRetry={onRetry}
				poster={poster}
				prompt={prompt}
				showStatus={showStatus}
				size="fluid"
				status={status}
				statusText={statusText}
			>
				{url ? (
					// biome-ignore lint/a11y/useMediaCaption: a generated clip has no caption track
					<video
						aria-label={prompt ?? "Generated video"}
						controls
						onLoadedMetadata={handleLoadedMetadata}
						playsInline
						poster={poster}
						preload="metadata"
						src={url}
					>
						<a href={url}>Download video</a>
					</video>
				) : null}
			</VideoGeneration>
		</div>
	);
}

/**
 * An assistant video part — the `file`-part twin of {@link getAssistantImageUrl},
 * so a clip that merely arrives (streamed by Core, or the extra clips of a
 * multi-clip generation) gets the same reserved frame and a real player instead
 * of a download link.
 */
function getAssistantVideoUrl(part: unknown): string | null {
	if (!isRecord(part) || part.type !== "file") {
		return null;
	}
	const filePart = part as {
		mediaType?: string;
		mimeType?: string;
		url?: string;
		data?: string;
	};
	const media = filePart.mediaType ?? filePart.mimeType;
	if (!media?.startsWith("video/")) {
		return null;
	}
	if (filePart.url) {
		return filePart.url;
	}
	if (filePart.data) {
		return `data:${media};base64,${filePart.data}`;
	}
	return null;
}

/**
 * A NON-image, NON-video assistant `file` part (audio, or any other mime),
 * resolved to a playable/downloadable url + its media type. Images and videos
 * are handled separately by {@link getAssistantImageMeta} and
 * {@link getAssistantVideoUrl}; this covers the rest so inline audio (and other
 * attachments Core streams) isn't silently dropped.
 */
function getAssistantFileMeta(
	part: unknown
): { filename: string; media: string; size?: number; url: string } | null {
	if (!isRecord(part) || part.type !== "file") {
		return null;
	}
	const filePart = part as {
		data?: string;
		fileName?: string;
		filename?: string;
		mediaType?: string;
		mimeType?: string;
		name?: string;
		size?: number;
		url?: string;
	};
	const media = filePart.mediaType ?? filePart.mimeType;
	if (!media || media.startsWith("image/") || media.startsWith("video/")) {
		return null;
	}
	const url =
		filePart.url ??
		(filePart.data ? `data:${media};base64,${filePart.data}` : undefined);
	if (url) {
		return {
			filename:
				filePart.filename ?? filePart.fileName ?? filePart.name ?? "Attachment",
			media,
			size: typeof filePart.size === "number" ? filePart.size : undefined,
			url,
		};
	}
	return null;
}

function isV5ToolPart(part: unknown): part is ToolPartBase {
	if (!isRecord(part)) {
		return false;
	}
	const partType = part.type;
	return (
		partType === "dynamic-tool" ||
		(typeof partType === "string" && partType.startsWith("tool-"))
	);
}

/**
 * A `data-tool-widget-available` stream part — the live app widget Core mints for
 * a completed tool call. Not a v5 tool part; its payload is nested under `.data`
 * (D6) and carries the shared `toolCallId` that ties it to its tool row.
 */
function isWidgetAvailablePart(part: unknown): part is {
	type: "data-tool-widget-available";
	data: { toolCallId?: string };
} {
	return isRecord(part) && part.type === "data-tool-widget-available";
}

function getTextFromParts(parts: unknown[], joiner: string): string {
	return parts
		.filter(isTextPart)
		.map((part) => part.text)
		.join(joiner);
}

/** Collect the edit summary used by the message-navigation preview rail. */
function getChangedFilesFromParts(parts: unknown[]): ChatTocFileChange[] {
	return deriveEditedFiles(parts).map((file) => {
		const stats = [
			file.insertions > 0 ? `+${formatCount(file.insertions) ?? "0"}` : "",
			file.deletions > 0 ? `-${formatCount(file.deletions) ?? "0"}` : "",
		]
			.filter(Boolean)
			.join(" ");
		return { name: file.path, stats: stats || undefined };
	});
}

const MAX_PREVIEW_FILES = 4;

/**
 * The rich card the beUI rail shows while hovering a tick. Reuses the exact
 * content of the old left-gutter ChatToc popover — user prompt, agent mark +
 * reply excerpt, files changed — so switching navigation from the bespoke TOC
 * to the beUI PreviewRail keeps every fact, just in a beUI surface.
 */
function ChatRailPreview({ item }: { item: PreviewRailItem }) {
	const toc = item.data as ChatTocItem | undefined;
	if (!toc) {
		return (
			<div
				className="w-full rounded-2xl border border-border bg-card p-3 shadow-sm"
				data-slot="preview-rail-card"
			>
				<p
					className="font-medium text-card-foreground text-xs"
					data-slot="preview-rail-title"
				>
					{item.label}
				</p>
			</div>
		);
	}
	const extraFiles = (toc.files?.length ?? 0) - MAX_PREVIEW_FILES;
	return (
		<div
			className="w-full rounded-2xl border border-border bg-card p-3 shadow-sm"
			data-slot="preview-rail-card"
		>
			<p
				className="line-clamp-2 font-medium text-card-foreground text-xs leading-4"
				data-slot="preview-rail-title"
			>
				{toc.title}
			</p>
			{(toc.description || toc.agentAvatar) && (
				<div className="mt-1.5 flex items-start gap-1.5">
					{toc.agentAvatar ? (
						<span className="mt-0.5 flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
							{toc.agentAvatar}
						</span>
					) : null}
					{toc.agentName ? (
						<p className="mb-0.5 text-[10px] text-muted-foreground leading-3">
							{toc.agentName}
						</p>
					) : null}
					{toc.description ? (
						<p
							className="line-clamp-2 text-[11px] text-muted-foreground leading-4"
							data-slot="preview-rail-description"
						>
							{toc.description}
						</p>
					) : null}
				</div>
			)}
			{toc.files && toc.files.length > 0 ? (
				<div className="mt-1.5 border-border/60 border-t pt-1.5">
					<ul className="flex flex-col gap-0.5">
						{toc.files.slice(0, MAX_PREVIEW_FILES).map((file) => (
							<li
								className="flex min-w-0 items-baseline justify-between gap-2"
								key={file.name}
							>
								<span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[10px] leading-3">
									<FileTypeIcon className="size-3.5" path={file.name} />
									{file.name}
								</span>
								{file.stats ? (
									<span className="shrink-0 text-[9px] text-muted-foreground tabular-nums">
										{file.stats}
									</span>
								) : null}
							</li>
						))}
					</ul>
					{extraFiles > 0 ? (
						<p className="mt-0.5 text-[9px] text-muted-foreground">
							+{extraFiles} more
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function CopyButton({
	text,
	onCopied,
}: {
	text: string;
	onCopied?: () => void;
}) {
	const [copied, setCopied] = useState(false);
	const copiedTimerRef = useRef<number | null>(null);

	const handleCopy = () => {
		navigator.clipboard.writeText(text);
		setCopied(true);
		if (copiedTimerRef.current) {
			window.clearTimeout(copiedTimerRef.current);
		}
		copiedTimerRef.current = window.setTimeout(() => {
			setCopied(false);
			copiedTimerRef.current = null;
		}, 2000);
		onCopied?.();
	};
	return (
		<Button
			aria-label={copied ? "Message copied" : "Copy message"}
			className={cn("size-6 rounded-md opacity-50 hover:opacity-100")}
			onClick={handleCopy}
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => {
				event.stopPropagation();
			}}
			size="icon"
			title={copied ? "Message copied" : "Copy message"}
			type="button"
			variant="ghost"
		>
			<div className="relative h-3.5 w-3.5">
				<IconCopy
					className={cn(
						"absolute inset-0 h-3.5 w-3.5 text-muted-foreground transition-[opacity,transform] duration-150 ease-out",
						copied ? "scale-50 opacity-0" : "scale-100 opacity-100"
					)}
				/>
				<IconCheck
					className={cn(
						"absolute inset-0 h-3.5 w-3.5 text-muted-foreground transition-[opacity,transform] duration-150 ease-out",
						copied ? "scale-100 opacity-100" : "scale-50 opacity-0"
					)}
				/>
			</div>
		</Button>
	);
}

function ReplyButton({ onReply }: { onReply: () => void }) {
	return (
		<Button
			aria-label="Reply to message"
			className={cn("size-6 rounded-md opacity-50 hover:opacity-100")}
			onClick={onReply}
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => {
				event.stopPropagation();
			}}
			size="icon"
			title="Reply to message"
			type="button"
			variant="ghost"
		>
			<ReplyIcon className="h-3.5 w-3.5 text-muted-foreground" />
		</Button>
	);
}

// `< n / m >` version pager shown when a turn has alternate versions. Stepping
// left/right calls `onSelect` with the target version's id.
function VersionPager({
	index,
	count,
	ids,
	alignClass,
	onSelect,
}: {
	index: number;
	count: number;
	ids: string[];
	alignClass: string;
	onSelect: (versionId: string) => void;
}) {
	const go = (delta: number) => {
		const next = index + delta;
		const target = ids[next];
		if (target) {
			onSelect(target);
		}
	};
	return (
		<div
			className={cn(
				"flex items-center gap-0.5 text-muted-foreground/70 text-xs",
				alignClass
			)}
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => event.stopPropagation()}
		>
			<Button
				aria-label="Previous version"
				className="size-5 rounded-md opacity-60 hover:opacity-100 disabled:opacity-25"
				disabled={index <= 0}
				onClick={() => go(-1)}
				size="icon"
				tabIndex={-1}
				type="button"
				variant="ghost"
			>
				<IconChevronLeft className="h-3.5 w-3.5" />
			</Button>
			<span className="tabular-nums">
				{index + 1}/{count}
			</span>
			<Button
				aria-label="Next version"
				className="size-5 rounded-md opacity-60 hover:opacity-100 disabled:opacity-25"
				disabled={index >= count - 1}
				onClick={() => go(1)}
				size="icon"
				tabIndex={-1}
				type="button"
				variant="ghost"
			>
				<IconChevronRight className="h-3.5 w-3.5" />
			</Button>
		</div>
	);
}

function MemoryCitationsMenuItem({
	action,
	citations,
}: {
	action: ContributedMessageAction;
	citations?: readonly MemoryCitation[];
}) {
	const [open, setOpen] = useState(false);
	if (!citations || citations.length === 0) {
		return null;
	}

	return (
		<Popover modal={false} onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				render={
					<DropdownMenuItem closeOnClick={false} onClick={() => setOpen(true)}>
						<HugeiconsIcon
							aria-hidden="true"
							className="size-3.5"
							icon={BookOpen02Icon}
						/>
						{action.label}
					</DropdownMenuItem>
				}
			/>
			<PopoverContent
				align="start"
				className="w-80 max-w-[min(20rem,calc(100vw-2rem))] items-start p-3"
			>
				<div className="min-w-0">
					<p className="font-medium text-foreground">Memories cited</p>
					<ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
						{citations.map((citation) => (
							<li key={citation.id}>{citation.content}</li>
						))}
					</ul>
				</div>
			</PopoverContent>
		</Popover>
	);
}

function MessageOverflowMenu({
	actionState,
	align,
	contributedActions,
	onBranch,
	onContributedAction,
	onEdit,
	onRegenerate,
	onSpeak,
}: {
	actionState?: MessageActionRuntimeState;
	align: "start" | "end";
	contributedActions?: ContributedMessageAction[];
	onBranch?: () => void;
	onContributedAction?: (
		action: ContributedMessageAction,
		value?: string
	) => void;
	onEdit?: () => void;
	onRegenerate?: () => void;
	onSpeak?: () => void;
}) {
	const [speaking, setSpeaking] = useState(false);
	const hasOverflow = Boolean(
		onBranch || onEdit || onRegenerate || onSpeak || contributedActions?.length
	);
	if (!hasOverflow) {
		return null;
	}

	const speak = async () => {
		if (speaking || !onSpeak) {
			return;
		}
		setSpeaking(true);
		try {
			onSpeak();
		} finally {
			setSpeaking(false);
		}
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label="More message actions"
						className="size-6 rounded-md opacity-60 hover:opacity-100"
						onMouseDown={(event) => event.stopPropagation()}
						onPointerDown={(event) => event.stopPropagation()}
						size="icon"
						title="More message actions"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon
							aria-hidden="true"
							className="size-3.5"
							icon={MoreHorizontalIcon}
						/>
					</Button>
				}
			/>
			<DropdownMenuContent
				align={align}
				className="w-auto min-w-48"
				withBackdrop={false}
			>
				{onEdit ? (
					<DropdownMenuItem onClick={onEdit}>
						<Icon
							aria-hidden="true"
							className="size-3.5"
							icon="lucide:pencil"
						/>
						Edit message
					</DropdownMenuItem>
				) : null}
				{onRegenerate ? (
					<DropdownMenuItem onClick={onRegenerate}>
						<Icon
							aria-hidden="true"
							className="size-3.5"
							icon="lucide:refresh-cw"
						/>
						Regenerate reply
					</DropdownMenuItem>
				) : null}
				{onBranch ? (
					<DropdownMenuItem onClick={onBranch}>
						<Icon
							aria-hidden="true"
							className="size-3.5"
							icon="lucide:git-branch"
						/>
						Fork chat from here
					</DropdownMenuItem>
				) : null}
				{onSpeak ? (
					<DropdownMenuItem disabled={speaking} onClick={() => void speak()}>
						<Icon
							aria-hidden="true"
							className="size-3.5"
							icon="lucide:volume-2"
						/>
						{speaking ? "Speaking…" : "Speak reply"}
					</DropdownMenuItem>
				) : null}
				{contributedActions?.map((action) => {
					if (isMemoryCitationsAction(action)) {
						return (
							<MemoryCitationsMenuItem
								action={action}
								citations={actionState?.memoryCitations}
								key={action.id}
							/>
						);
					}
					if (action.kind === "toggle-group" && action.states?.length) {
						return (
							<Fragment key={action.id}>
								{action.states.map((state) => {
									const active =
										actionState?.toggleValues?.[action.id] === state.value;
									return (
										<DropdownMenuItem
											key={`${action.id}:${state.value}`}
											onClick={() =>
												onContributedAction?.(
													action,
													active ? undefined : state.value
												)
											}
										>
											{state.icon || state.active_icon ? (
												<Icon
													aria-hidden="true"
													className="size-3.5"
													icon={
														active
															? (state.active_icon ?? state.icon ?? "")
															: (state.icon ?? "")
													}
												/>
											) : null}
											{state.label}
											{active ? (
												<HugeiconsIcon
													aria-hidden="true"
													className="ml-auto size-3.5"
													icon={Tick02Icon}
												/>
											) : null}
										</DropdownMenuItem>
									);
								})}
							</Fragment>
						);
					}
					return (
						<DropdownMenuItem
							key={action.id}
							onClick={() => onContributedAction?.(action)}
						>
							{action.icon ? (
								<Icon
									aria-hidden="true"
									className="size-3.5"
									icon={action.icon}
								/>
							) : null}
							{action.label}
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function MessageToolbar({
	actionState,
	alignClass,
	contributedActions,
	text,
	heightClass,
	hoverClass,
	isVisible,
	menuAlign,
	onCopied,
	onBranch,
	onEdit,
	onRegenerate,
	onReply,
	onSpeak,
	onContributedAction,
	reactionAction,
	reactionMessageId,
	goalCompletion,
}: {
	actionState?: MessageActionRuntimeState;
	alignClass: string;
	contributedActions?: ContributedMessageAction[];
	text?: string;
	heightClass: string;
	hoverClass: string;
	isVisible: boolean;
	menuAlign: "start" | "end";
	onCopied?: () => void;
	onBranch?: () => void;
	onEdit?: () => void;
	onRegenerate?: () => void;
	onReply?: () => void;
	onSpeak?: () => void;
	onContributedAction?: (
		action: ContributedMessageAction,
		value?: string
	) => void;
	reactionAction?: ContributedMessageAction;
	reactionMessageId?: string;
	/** Compact completion status appended to the ending-turn toolbar. */
	goalCompletion?: React.ReactNode;
}) {
	return (
		<div
			className={cn(
				"pointer-events-none flex items-center gap-1 text-muted-foreground/70 text-xs opacity-0 transition-opacity duration-100",
				heightClass,
				alignClass,
				hoverClass,
				isVisible && "pointer-events-auto opacity-100",
				"focus-within:pointer-events-auto focus-within:opacity-100"
			)}
			data-slot="message-toolbar"
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => event.stopPropagation()}
		>
			{reactionAction && reactionMessageId && onContributedAction ? (
				<MessageActionSurface
					actions={[reactionAction]}
					messageId={reactionMessageId}
					onAction={(action, context) =>
						onContributedAction(action, context.value)
					}
					state={actionState}
				/>
			) : null}
			{onReply && <ReplyButton onReply={onReply} />}
			{text && <CopyButton onCopied={onCopied} text={text} />}
			<MessageOverflowMenu
				actionState={actionState}
				align={menuAlign}
				contributedActions={contributedActions}
				onBranch={onBranch}
				onContributedAction={onContributedAction}
				onEdit={onEdit}
				onRegenerate={onRegenerate}
				onSpeak={onSpeak}
			/>
			{goalCompletion ? goalCompletion : null}
		</div>
	);
}

/** One user message plus every assistant message that answered it. */
interface AssistantTurn {
	assistantMsgs: UIMessage[];
	userMsg?: UIMessage;
}

/**
 * Module-level so the "nothing is hidden" branch hands back a stable identity —
 * a fresh empty Set would change the memo's result on every render and defeat
 * it.
 */
const EMPTY_TURN_SET: ReadonlySet<AssistantTurn> = new Set<AssistantTurn>();

/**
 * The human sentence off a `data-ryu-failover` part, or `null` for anything
 * else.
 *
 * Emitted by Core's reactive-failover wrapper
 * (`apps/core/src/sidecar/adapters/mod.rs`) when a turn fails because a
 * subscription window is spent: which plan had room, what was done about it, and
 * when the window reopens. The `kind: "stand"` verdict — "the failure was not a
 * cap" — is never sent, so a part that arrives always carries a note.
 */
function getFailoverNote(part: unknown): string | null {
	if (!isRecord(part) || part.type !== "data-ryu-failover") {
		return null;
	}
	const data = part.data;
	if (!isRecord(data)) {
		return null;
	}
	const note = data.note;
	return typeof note === "string" && note.trim().length > 0
		? note.trim()
		: null;
}

/** True for a `data-ryu-workflow` part — the live checklist Core streams while
 *  a `workflow_id` chat turn runs. */
function isWorkflowRunPart(part: unknown): boolean {
	return isRecord(part) && part.type === "data-ryu-workflow";
}

/**
 * Was this turn cut off before it finished?
 *
 * `_interrupted` is stamped by the history mapper
 * (`apps/desktop/src/lib/chat-history-hydrate.ts`) off Core's server-side
 * `messages.interrupted` column, which is reconciled at boot. It rides on the
 * message object rather than in `parts`, which is the whole point: the marker is
 * metadata about the run, so it can never be copied out with the reply, replayed
 * to the model, or mistaken for something the agent said.
 */
function isInterruptedMessage(msg: UIMessage): boolean {
	return (msg as { _interrupted?: boolean })._interrupted === true;
}

/** Group flat messages into turns (user message + following assistant messages) */
function groupMessagesIntoTurns(messages: UIMessage[]): AssistantTurn[] {
	const turns: AssistantTurn[] = [];
	let current: AssistantTurn | null = null;

	for (const msg of messages) {
		if (msg.role === "user") {
			if (current) {
				turns.push(current);
			}
			current = { userMsg: msg, assistantMsgs: [] };
		} else if (msg.role === "assistant") {
			if (!current) {
				current = { assistantMsgs: [] };
			}
			current.assistantMsgs.push(msg);
		}
	}
	if (current) {
		turns.push(current);
	}
	return turns;
}

/**
 * Jumps the transcript to the newest message once per conversation.
 *
 * The scroller positions itself at the end when content first arrives, which
 * covers a chat hydrating in front of you (ChatPage loads history *after* mount).
 * What it does not cover is a transcript whose history lands while the surface
 * has NO layout — a tab restored behind `display:none`, or a background pane —
 * because there is nothing to scroll at that moment and the placement is never
 * revisited when the tab is shown. Measured in the chat-scroll story: that case
 * opens ~7200px up, at the very start of the conversation. A wheel/touch/key
 * event during the load has the same effect, dropping the scroller out of its
 * follow-the-bottom mode for good.
 *
 * So the jump is made explicit: try on mount, on hydration, and again whenever
 * the surface gains layout, then stop until the conversation changes so a
 * scrolled-up read is never yanked back down.
 *
 * Rendered above the scroller; scrolls the beUI MessageScroller's viewport,
 * located the same way `usePinnedUserMessage` finds it (by data-slot). Renders
 * nothing.
 */
function OpenAtBottom({
	containerRef,
	enabled,
	hasMessages,
	conversationKey,
}: {
	containerRef: React.RefObject<HTMLDivElement | null>;
	enabled: boolean;
	hasMessages: boolean;
	conversationKey: string | null;
}) {
	const settledKeyRef = useRef<string | null>(null);

	useEffect(() => {
		if (
			!(enabled && hasMessages && conversationKey) ||
			settledKeyRef.current === conversationKey
		) {
			return;
		}
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const viewport = container.querySelector<HTMLElement>(
			'[data-slot="message-scroller-viewport"]'
		);
		if (!viewport) {
			return;
		}
		let observer: ResizeObserver | null = null;
		const jump = () => {
			// Consult the latch on EVERY pass, not just before installing the
			// observer. Without this the observer — installed only when the first
			// attempt found a zero-height container — keeps firing for the life of
			// the effect and yanks a scrolled-up reader back to the bottom on any
			// resize of the chat container.
			if (settledKeyRef.current === conversationKey) {
				observer?.disconnect();
				return;
			}
			// A surface with no layout yet (a tab still hidden behind `display:none`)
			// would scroll a zero-height viewport and settle on nothing, so wait for
			// the ResizeObserver below to report real height.
			if (container.clientHeight === 0) {
				return;
			}
			if (typeof viewport.scrollTo === "function") {
				viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" });
			} else {
				viewport.scrollTop = viewport.scrollHeight;
			}
			settledKeyRef.current = conversationKey;
			observer?.disconnect();
		};
		jump();
		if (
			settledKeyRef.current === conversationKey ||
			typeof ResizeObserver === "undefined"
		) {
			return;
		}
		observer = new ResizeObserver(jump);
		observer.observe(container);
		return () => observer?.disconnect();
	}, [containerRef, conversationKey, enabled, hasMessages]);

	return null;
}

export const MessageList = memo(function MessageList({
	messages,
	status,
	answerNow,
	className,
	showCopyToolbar = true,
	searchActiveMessageId,
	onBranch,
	onAgentUiSubmit,
	onEditMessage,
	onRegenerateMessage,
	onRetryError,
	onRetryGeneration,
	historyNotice,
	historyNotices,
	hasOlderMessages,
	loadingOlderMessages,
	messageActions,
	messageActionStates,
	onContributedMessageAction,
	selectionActions,
	onContributedSelectionAction,
	onSelectVersion,
	versions,
	onSpeak,
	onQuote,
	onReply,
	onOpenFile,
	onReviewFileEdits,
	onUndoFileEdits,
	onOpenLink,
	onOpenMention,
	onWorkflowResume,
	previewResolvers,
	mentionItems,
	suppressQuestionTool = false,
	initialScrollBehavior = "bottom",
	enableImagePreview = true,
	assistantAvatar,
	assistantName,
	assistantTitle,
	assistantPlanningAvatars,
	agentMessageContext,
	currentUser,
	goalCompletion,
	slots,
	classNames,
	toolRenderers,
	contextSize,
	conversationKey,
	statsPluginEnabled = DEFAULT_STATS_PLUGIN_ENABLED,
	statsUsage,
	statsModelName,
	onLoadOlderMessages,
}: MessageListProps) {
	const [activeCopyId, setActiveCopyId] = useState<string | null>(null);
	// Which user message is currently in inline-edit mode (null = none).
	const [editingId, setEditingId] = useState<string | null>(null);
	const [isMounted, setIsMounted] = useState(false);
	// Whether the reader is at the live edge of the transcript — driven by the
	// beUI scroller's `onFollowChange`. `false` is when the scroll-to-end button
	// appears.
	const [following, setFollowing] = useState(true);
	const scrollerRef = useRef<HTMLDivElement>(null);
	// The beUI MessageScroller's scrollable viewport. Forwarded via
	// `viewportRef` so the pinned bar, the floating date header and the TOC can
	// read scroll position without owning the scroller.
	const viewportRef = useRef<HTMLElement | null>(null);
	const {
		density,
		hideToolDetail,
		inferenceStats,
		openAtBottom,
		pinUserMessage,
	} = useChatDisplayPrefs();
	const statsEnabled = statsPluginEnabled && inferenceStats;
	const followOutput = openAtBottom && initialScrollBehavior !== "top";
	const followingRef = useRef(true);
	const unreadStateRef = useRef<UnreadMessageState | null>(null);
	const unreadMarkerRef = useRef<HTMLDivElement | null>(null);
	const preserveUnreadBoundaryRef = useRef(false);
	const [unreadMessageIds, setUnreadMessageIds] = useState<string[]>([]);
	const clearUnreadBoundaryPreservation = useCallback(() => {
		preserveUnreadBoundaryRef.current = false;
	}, []);
	// A narrow surface (island mini-chat, companion popover) renders the same
	// parts with tighter padding. The shared preview rail remains available; its
	// own overflow behavior collapses it to a popover when the surface is narrow.
	const isCompact = density === "compact";

	const clearUnreadMessages = useCallback(() => {
		const state = unreadStateRef.current;
		if (!state || state.unreadIds.length === 0) {
			return;
		}
		unreadStateRef.current = clearUnreadMessageState(state);
		setUnreadMessageIds([]);
	}, []);

	const handleFollowChange = useCallback(
		(next: boolean) => {
			if (next && preserveUnreadBoundaryRef.current) {
				return;
			}
			followingRef.current = next;
			setFollowing(next);
			if (next) {
				clearUnreadMessages();
			}
		},
		[clearUnreadMessages]
	);
	const olderLoadInFlightRef = useRef(false);
	const handleViewportScroll = useCallback(
		(event: React.UIEvent<HTMLElement>) => {
			const viewport = event.currentTarget;
			if (
				!(onLoadOlderMessages && hasOlderMessages) ||
				loadingOlderMessages ||
				viewport.scrollTop > 96 ||
				olderLoadInFlightRef.current
			) {
				return;
			}
			olderLoadInFlightRef.current = true;
			const previousHeight = viewport.scrollHeight;
			const previousTop = viewport.scrollTop;
			void onLoadOlderMessages()
				.then(() => {
					const restoreScrollAnchor = (framesRemaining: number) => {
						if (!viewport.isConnected || framesRemaining <= 0) {
							return;
						}
						viewport.scrollTop =
							previousTop + viewport.scrollHeight - previousHeight;
						window.requestAnimationFrame(() =>
							restoreScrollAnchor(framesRemaining - 1)
						);
					};
					window.requestAnimationFrame(() => restoreScrollAnchor(8));
				})
				.finally(() => {
					olderLoadInFlightRef.current = false;
				});
		},
		[hasOlderMessages, loadingOlderMessages, onLoadOlderMessages]
	);

	useEffect(() => {
		followingRef.current = followOutput;
		setFollowing(followOutput);
		if (followOutput) {
			clearUnreadMessages();
		}
	}, [clearUnreadMessages, followOutput]);

	const {
		isScrollingUp,
		pinnedMessage,
		registerAnchor,
		scrollToPinned,
		setScrollDirection,
	} = usePinnedUserMessage({
		enabled: pinUserMessage && !isCompact,
		messages,
		scrollerRef,
	});

	const CustomUserMessage = slots?.UserMessage || UserMessage;
	const CustomToolRenderer = slots?.ToolRenderer || DefaultToolRenderer;

	const markCopied = useCallback((id: string) => {
		setActiveCopyId(id);
	}, []);

	useEffect(() => {
		setIsMounted(true);
	}, []);

	useEffect(() => {
		const handlePointerDown = () => {
			setActiveCopyId(null);
		};
		window.addEventListener("pointerdown", handlePointerDown);
		return () => window.removeEventListener("pointerdown", handlePointerDown);
	}, []);

	const isStreaming = status === "streaming" || status === "submitted";

	const normalizedMessages = useMemo(
		() => normalizeMessages(messages),
		[messages]
	);
	const conversationStateKey =
		conversationKey ?? normalizedMessages[0]?.id ?? null;
	useEffect(() => {
		const nextState = reconcileUnreadMessageState(
			unreadStateRef.current,
			conversationStateKey,
			getIncomingMessageIds(normalizedMessages),
			followingRef.current && !preserveUnreadBoundaryRef.current
		);
		unreadStateRef.current = nextState;
		setUnreadMessageIds((current) => {
			if (
				current.length === nextState.unreadIds.length &&
				current.every((id, index) => id === nextState.unreadIds[index])
			) {
				return current;
			}
			return [...nextState.unreadIds];
		});
	}, [conversationStateKey, normalizedMessages]);

	const unreadMessageIdSet = useMemo(
		() => new Set(unreadMessageIds),
		[unreadMessageIds]
	);
	const firstUnreadMessageId = useMemo(
		() =>
			normalizedMessages.find(
				(message) =>
					message.role === "assistant" && unreadMessageIdSet.has(message.id)
			)?.id ?? null,
		[normalizedMessages, unreadMessageIdSet]
	);
	const unreadMessageCount = unreadMessageIds.length;
	const unreadMessageLabel = getUnreadMessageLabel(unreadMessageCount);

	useEffect(() => {
		if (!(unreadMessageCount > 0 && firstUnreadMessageId)) {
			return;
		}
		const marker = unreadMarkerRef.current;
		const viewport = viewportRef.current;
		if (!(marker && viewport)) {
			return;
		}
		const clearAtUnreadBoundary = () => {
			if (preserveUnreadBoundaryRef.current) {
				return;
			}
			clearUnreadMessages();
			// Reaching the marker is not the same as choosing the live edge. The
			// browser may place a marker near the end of a short transcript at the
			// bottom when it is revealed; keep the latest-message affordance visible
			// until the reader explicitly follows the newest reply.
			if (followingRef.current) {
				followingRef.current = false;
				setFollowing(false);
			}
			preserveUnreadBoundaryRef.current = true;
		};

		const clearWhenVisible = () => {
			const markerRect = marker.getBoundingClientRect();
			const viewportRect = viewport.getBoundingClientRect();
			if (
				markerRect.top < viewportRect.bottom &&
				markerRect.bottom > viewportRect.top
			) {
				clearAtUnreadBoundary();
			}
		};

		const observer =
			typeof IntersectionObserver === "undefined"
				? null
				: new IntersectionObserver(
						(entries) => {
							if (entries.some((entry) => entry.isIntersecting)) {
								clearAtUnreadBoundary();
							}
						},
						{ root: viewport, threshold: 0.1 }
					);
		observer?.observe(marker);
		viewport.addEventListener("scroll", clearWhenVisible, { passive: true });
		clearWhenVisible();

		return () => {
			observer?.disconnect();
			viewport.removeEventListener("scroll", clearWhenVisible);
		};
	}, [clearUnreadMessages, firstUnreadMessageId, unreadMessageCount]);
	const planningLabel =
		PLANNING_LABELS[getPlanningActivity(normalizedMessages)];
	// Who is on the turn, drawn in the row's leading slot. Several agents overlap
	// slightly (`-space-x-1`) so three marks still read as one group rather than a
	// row of loose icons; a single agent is unaffected by the negative margin.
	// `undefined` (not an empty node) when there is nothing to draw, so the
	// planning row leads with the typing indicator alone.
	const planningMarks = (
		assistantPlanningAvatars?.length
			? assistantPlanningAvatars
			: [assistantAvatar]
	).filter(Boolean);
	const planningLeading =
		planningMarks.length > 0 ? (
			<span className="flex shrink-0 items-center -space-x-1">
				{planningMarks.map((mark, index) => (
					<span
						className="flex size-4 items-center justify-center"
						// biome-ignore lint/suspicious/noArrayIndexKey: avatars are opaque nodes with no id of their own; the list is a fixed-order snapshot of the active agents
						key={index}
					>
						{mark}
					</span>
				))}
			</span>
		) : undefined;
	const rawTurns = useMemo(
		() => groupMessagesIntoTurns(normalizedMessages),
		[normalizedMessages]
	);
	// Computed BEFORE the detail filter below, and off `rawTurns`, because
	// whether an assistant message exists at all is a fact about the stream, not
	// about how much of it we draw.
	const showPlanning = useMemo(() => {
		const lastMessage = normalizedMessages.at(-1);
		const lastTurn = rawTurns.at(-1);
		return shouldShowPlanning({
			hasMessages: Boolean(lastMessage),
			lastMessageIsUser: lastMessage?.role === "user",
			lastTurnHasAssistant: Boolean(
				lastTurn && lastTurn.assistantMsgs.length > 0
			),
			isStreaming,
			lastAssistantHasContent: getLastAssistantHasContent(
				normalizedMessages,
				hideToolDetail
			),
		});
	}, [hideToolDetail, isStreaming, normalizedMessages, rawTurns]);

	// --- Detail level "None" -----------------------------------------------
	// A turn whose whole content is tool detail renders nothing at None. Left in
	// the list it would still emit a `MessageScrollerItem`: an empty row that
	// occupies a scroll slot and carries a content-visibility placeholder, i.e.
	// a blank gap in the transcript. So the turn is dropped OUTRIGHT rather than
	// replaced with a minimal "n steps hidden" row — such a row is a tool row
	// under another name and would defeat the point of the level. What keeps
	// that safe: failed tool rows are never hidden, `type: "error"` parts are
	// never hidden, and an interrupted turn counts as visible below — the
	// interruption marker is metadata now (`_interrupted`), not a text part, so
	// a turn that died with nothing but hidden tool work would otherwise vanish
	// entirely at None and take its crash notice with it.
	//
	// Filtering HERE (not at render time) is deliberate: `separatorKeyByTurnIndex`
	// keys day separators by turn index, so dropping a turn later would leave a
	// separator pointing at a turn that no longer exists.
	//
	// Two turns are always kept:
	//  • one with a user message — the prompt is the user's own text, and an
	//    assistant reply that was pure tool work simply shows no reply bubble;
	//  • the last one while `showPlanning` is on — it is the row's only home,
	//    and dropping it would strand a running agent with no liveness cue.
	const { turns, assistantHiddenTurns } = useMemo(() => {
		if (!hideToolDetail) {
			return { turns: rawTurns, assistantHiddenTurns: EMPTY_TURN_SET };
		}
		const hidden = new Set<AssistantTurn>();
		for (const turn of rawTurns) {
			const visible = turn.assistantMsgs.some(
				(msg) =>
					hasVisibleContentAtNoDetail(msg.parts ?? []) ||
					isInterruptedMessage(msg)
			);
			if (!visible) {
				hidden.add(turn);
			}
		}
		const kept = rawTurns.filter(
			(turn, index) =>
				Boolean(turn.userMsg) ||
				!hidden.has(turn) ||
				(index === rawTurns.length - 1 && showPlanning)
		);
		return { turns: kept, assistantHiddenTurns: hidden };
	}, [hideToolDetail, rawTurns, showPlanning]);

	// --- day grouping ------------------------------------------------------
	// The display time zone is a GROUPING input here, not just a label input:
	// it decides where midnight falls, so changing Appearance → "Date & time"
	// MOVES a separator rather than just retitling one. Subscribing (rather than
	// letting the formatters read the zone at call time, as most surfaces do) is
	// what makes these memos recompute instead of leaving a stale boundary on
	// screen. `useExhaustiveDependencies` is off repo-wide, so the revision sits
	// in the dep arrays below without a suppression; it is intentional, not a
	// leftover.
	const tzRevision = useTimezoneRevision();
	const dayGroups = useMemo(() => groupTurnsByDay(turns), [turns, tzRevision]);
	const separatorKeys = useMemo(
		() => separatorKeyByTurnIndex(dayGroups),
		[dayGroups]
	);
	const startOfToday = useMemo(() => startOfTodayMs(), [tzRevision]);
	// Anchor id → flat turn index, so the floating header can map the scroller's
	// `currentAnchorId` back onto a group. Only turns with a user message are
	// anchors (`scrollAnchor={Boolean(turn.userMsg)}` below), and their anchor id
	// is that message's id.
	const turnIndexByAnchorId = useMemo(() => {
		const byId = new Map<string, number>();
		for (const [index, turn] of turns.entries()) {
			if (turn.userMsg) {
				byId.set(turn.userMsg.id, index);
			}
		}
		return byId;
	}, [turns]);

	// Anchor ids in DOM order: every turn that opens with a user message. The
	// beUI MessageScroller owns scroll-follow but exposes no anchor API, so the
	// transcript tracks "which turn is at the top" itself — the fact the floating
	// date header and the chat TOC both render from.
	const transcriptAnchorIds = useMemo(
		() =>
			turns
				.map((turn) => turn.userMsg?.id)
				.filter((id): id is string => Boolean(id)),
		[turns]
	);
	const {
		currentAnchorId,
		registerAnchor: registerTranscriptAnchor,
		scrollToMessage,
	} = useTranscriptAnchor({
		anchorIds: transcriptAnchorIds,
		enabled: !isCompact,
		viewportRef,
	});

	// --- messaging-style user runs -----------------------------------------
	// A "run" is consecutive messages from the same speaker: one avatar for the
	// whole run, tight spacing inside it. Only the USER side needs computing.
	// `groupMessagesIntoTurns` opens a new turn on every user message and joins
	// every assistant message to the current one, so `turn.assistantMsgs` IS the
	// assistant run and already draws as ONE `Message` with one avatar and one
	// header. A user run, by the same rule, spans consecutive TURNS — i.e.
	// sibling `MessageScrollerItem`s — which is exactly why it cannot be a
	// wrapper element: `MessageScrollerContent`'s MutationObserver watches
	// `childList` with no `subtree`, so a new turn appended inside a per-run
	// wrapper would fire no mutation and scroll-new-turn-to-top would die
	// silently. The run is therefore carried as `data-group-position` on each
	// item plus a computed avatar flag, never as a container.
	//
	// A run continues past turn i when all of these hold:
	//  • turn i draws no assistant reply — the other party breaks a run;
	//  • a next turn exists AND opens with a user message;
	//  • no day separator falls between them — a new day starts a fresh run,
	//    which is what Telegram/WhatsApp do and what keeps the avatar attached
	//    to the block the separator introduces.
	// `assistantHiddenTurns` is consulted rather than `assistantMsgs.length`
	// because at Detail level "None" a turn of pure tool work draws NOTHING, and
	// an invisible reply must not break a run the reader sees as continuous.
	const userRunPositions = useMemo(() => {
		const continues = turns.map((turn, index) => {
			const nextUserMsg = turns[index + 1]?.userMsg;
			const drawsAssistant =
				turn.assistantMsgs.length > 0 && !assistantHiddenTurns.has(turn);
			return Boolean(
				turn.userMsg &&
					!drawsAssistant &&
					nextUserMsg &&
					widgetMessageProvenanceKey(turn.userMsg) ===
						widgetMessageProvenanceKey(nextUserMsg) &&
					!separatorKeys.has(index + 1)
			);
		});
		return turns.map((_turn, index) => {
			const isLast = !continues[index];
			const isFirst = index === 0 || !continues[index - 1];
			if (isFirst && isLast) {
				return "single" as const;
			}
			if (isFirst) {
				return "first" as const;
			}
			return isLast ? ("last" as const) : ("middle" as const);
		});
	}, [turns, assistantHiddenTurns, separatorKeys]);

	// Built from the FILTERED turns, so a turn None dropped gets no entry. The
	// per-entry `files` list survives None on purpose: the TOC is navigation
	// ("jump to where that file changed"), not a tool row, and stripping it
	// would leave the aid weaker without making the transcript any quieter.
	const tocItems = useMemo<ChatTocItem[]>(() => {
		const items: ChatTocItem[] = [];
		for (const turn of turns) {
			if (!turn.userMsg) {
				continue;
			}
			const text = getTextFromParts(turn.userMsg.parts ?? [], " ").trim();
			if (!text) {
				continue;
			}
			const title = text.length > 80 ? `${text.slice(0, 80)}…` : text;
			const assistantParts = turn.assistantMsgs.flatMap((m) => m.parts ?? []);
			const reply = getTextFromParts(assistantParts, " ").trim();
			const description =
				reply.length > 160 ? `${reply.slice(0, 160)}…` : reply || undefined;
			items.push({
				id: turn.userMsg.id,
				title,
				description,
				agentAvatar: assistantAvatar,
				agentName: assistantName,
				files: getChangedFilesFromParts(assistantParts),
			});
		}
		return items;
	}, [turns, assistantAvatar, assistantName]);

	// The beUI rail's items: one tick per user turn, keyed by that message's id
	// (matched to the row's `data-message-id` for scroll targeting). Each item
	// carries the full TOC entry so the rail's preview card can render our info.
	const railItems = useMemo<PreviewRailItem[]>(
		() =>
			tocItems.map((item) => ({
				id: item.id,
				label: item.title,
				description: item.description,
				ariaLabel: `Go to message: ${item.title}`,
				data: item,
			})),
		[tocItems]
	);

	// Sidebar / deep-link jump: ChatPage and AppSidebar dispatch this once
	// messages hydrate. The beUI rail has no event surface of its own, so the
	// listener lives here next to the scroll target it drives.
	useEffect(() => {
		const onJump = (event: Event) => {
			const messageId = (event as CustomEvent<{ messageId?: string }>).detail
				?.messageId;
			if (messageId) {
				scrollToMessage(messageId);
			}
		};
		window.addEventListener("ryu:scroll-to-message", onJump);
		return () => window.removeEventListener("ryu:scroll-to-message", onJump);
	}, [scrollToMessage]);

	return (
		<div className="relative flex min-h-0 flex-1 flex-col" ref={scrollerRef}>
			{/* A surface that deliberately reads top-down (a static transcript)
			    opts out via `initialScrollBehavior="top"`; the user opts out via
			    Appearance → "Open chats at the latest message". */}
			<OpenAtBottom
				containerRef={scrollerRef}
				conversationKey={conversationKey ?? normalizedMessages[0]?.id ?? null}
				enabled={openAtBottom && initialScrollBehavior !== "top"}
				hasMessages={normalizedMessages.length > 0}
			/>
			{/* beUI MessageScroller: self-contained follow-at-the-live-edge viewport.
			    `data-slot` props below preserve the transcript DOM contract the
			    pinned-message bar and the e2e scroll/grouping/date specs read. The
			    turn rows render as plain `message-scroller-item` children (beUI
			    has no item primitive), with the same `data-group-position` the
			    sender-run styling keys off.
			    `followOutput` is gated by the SAME pref `OpenAtBottom` reads: with
			    "Open chats at the latest message" off, a transcript that hydrated
			    hidden must stay where it loaded once revealed — the beUI scroller's
			    ResizeObserver would otherwise re-follow the reveal resize and yank
			    it to the bottom (chat-scroll-story.spec.ts asserts this). */}
			<BeuiMessageScroller
				busy={isStreaming}
				className={cn("an-message-list flex-1", className)}
				contentClassName={cn(
					"w-full gap-0",
					isCompact ? "px-0.5 py-1" : "mx-auto max-w-[744px] px-3 py-6"
				)}
				contentProps={{ "data-slot": "message-scroller-content" }}
				followOutput={followOutput}
				label="Conversation"
				navigation="rail"
				onFollowChange={handleFollowChange}
				railItems={railItems}
				renderPreview={(item) => <ChatRailPreview item={item} />}
				showScrollToLatest={false}
				showUnreadMessages={false}
				smooth
				viewportProps={{
					"data-slot": "message-scroller-viewport",
					onKeyDown: (event) => {
						if (["ArrowDown", "End", "PageDown"].includes(event.key)) {
							clearUnreadBoundaryPreservation();
						}
					},
					onScroll: handleViewportScroll,
					onTouchStart: clearUnreadBoundaryPreservation,
					onWheel: clearUnreadBoundaryPreservation,
				}}
				viewportRef={viewportRef}
			>
				{hasOlderMessages ? (
					<div
						aria-busy={loadingOlderMessages}
						aria-live="polite"
						className="mx-auto w-full max-w-[744px] px-3 py-2 text-center text-muted-foreground text-xs"
						data-older-messages-loader
					>
						{loadingOlderMessages
							? "Loading older messages…"
							: "Scroll up for older messages"}
					</div>
				) : null}
				{pinUserMessage && !isCompact && isScrollingUp && pinnedMessage ? (
					// `data-slot` is load-bearing: the pin bar sits IN FLOW, so
					// mounting it pushes every anchor below it down by its own
					// height. usePinnedUserMessage measures this element to size the
					// release hysteresis that stops the bar un-electing its own
					// anchor (see PIN_RELEASE_SLACK).
					//
					// `top-9` reserves the fixed date-chip lane above the bar. The
					// bar remains in flow so its measured height continues to drive
					// pin-election hysteresis without moving the floating chip.
					//
					// It MUST be a sticky top offset and NOT padding — an offset
					// only moves where the bar paints, whereas padding would change
					// its offsetHeight, which is the very number PINNED_BAR_SLOT /
					// PIN_RELEASE_SLACK measure.
					<div
						className="sticky top-9 z-20 -mb-1"
						data-slot="pinned-user-message-bar"
					>
						<div className="mx-auto w-full max-w-[744px] px-3 pt-2 pb-1">
							<PinnedUserMessageBar
								message={pinnedMessage}
								onScrollTo={scrollToPinned}
							/>
						</div>
					</div>
				) : null}
				{/* 744 = the composer's own 720px column PLUS its `px-3` gutter
				    (input-bar.tsx wraps `mx-auto max-w-[720px]` in `px-3`).
				    Matching both numbers — not just the 720 — is what puts a
				    message's content edges on the composer's card edges at every
				    width. With `max-w-[720px] px-4` the transcript sat 16px inside
				    the composer on each side, which reads as a gap to the right of
				    the user avatar. */}
				{/* `gap-0`, NOT the `gap-2` this used to carry. A uniform gap can
				    only express one vertical rhythm, and messaging grouping needs
				    two: ~2px between consecutive messages from the same speaker
				    and 8px everywhere else. A run spans SIBLING children here (see
				    `userRunPositions`), so the tightening cannot live on a wrapper
				    — every direct child brings its own explicit top margin
				    instead, keyed off `data-group-position`. Negative margins are
				    deliberately not used: they would fight the scroller's
				    intrinsic-size estimates. */}
				{turns.map((turn, turnIndex) => {
					const isLastTurn = turnIndex === turns.length - 1;
					const turnKey = turn.userMsg?.id ?? `turn-${turnIndex}`;
					// Present only on the turn that OPENS a day run, and never
					// for the undated head run (subagent transcripts, the
					// storyboard and the e2e fixtures carry no `createdAt`, so
					// they get no separators at all).
					const separatorKey = separatorKeys.get(turnIndex);
					// Where this turn's USER row sits in its sender run. Also the
					// spacing key: a row that continues a run sits 2px under its
					// predecessor, everything else keeps the 8px the old `gap-2`
					// on Content used to give every child.
					const groupPosition = userRunPositions[turnIndex] ?? "single";
					const continuesRun =
						groupPosition === "middle" || groupPosition === "last";
					const hasUnreadMessage = turn.assistantMsgs.some(
						(msg) => msg.id === firstUnreadMessageId
					);
					const isSearchActive =
						searchActiveMessageId === turn.userMsg?.id ||
						turn.assistantMsgs.some((msg) => msg.id === searchActiveMessageId);

					return (
						// A Fragment, NOT a wrapper element: the separator and the
						// turn must both be DIRECT children of Content, so the
						// separator can never be picked as a scroll target. beUI
						// has no item primitive, so the turn is a plain div that
						// carries the item data-slot the grouping specs read.
						<Fragment key={turnKey}>
							{separatorKey === undefined ? null : (
								<DateSeparator label={dayLabel(separatorKey, startOfToday)} />
							)}
							<div
								className={cn(
									"relative space-y-2",
									continuesRun ? "mt-0.5" : "mt-2",
									isSearchActive &&
										"rounded-xl bg-primary/5 ring-2 ring-primary/35 ring-offset-2 ring-offset-background"
								)}
								data-chat-search-active={isSearchActive ? "true" : undefined}
								data-group-position={groupPosition}
								data-message-id={turn.userMsg ? turnKey : undefined}
								data-slot="message-scroller-item"
							>
								{turn.userMsg &&
									(() => {
										const text = getTextFromParts(
											turn.userMsg?.parts ?? [],
											""
										);
										const hasParts = (turn.userMsg?.parts ?? []).length > 0;
										if (!(text || hasParts)) {
											return null;
										}
										const userCopyKey = `user-${turn.userMsg.id}`;
										const userCopyVisible = activeCopyId === userCopyKey;
										const userMsgId = turn.userMsg.id;
										const onReplyUser =
											text && (onReply || onQuote)
												? () => {
														if (onReply) {
															onReply({
																chainLength: turns.length - turnIndex,
																messageId: userMsgId,
																text,
															});
															return;
														}
														onQuote?.(text);
													}
												: undefined;
										const goalAnnotation = isGoalMessage(turn.userMsg) ? (
											<GoalMessageAnnotation />
										) : null;
										const userActionState = messageActionStates?.get(userMsgId);
										const userActions = messageActions?.filter(
											(a) => a.target === "user" || a.target === "any"
										);
										const reactionAction = userActions?.find(
											isMessageReactionAction
										);
										const userToolbarActions = userActions?.filter(
											(a) =>
												!isMessageReactionAction(a) &&
												(!isMemoryCitationsAction(a) ||
													Boolean(userActionState?.memoryCitations?.length))
										);
										// Only render the toolbar when it has content — copy,
										// reply, or a contributed action (all built-ins
										// require message text).
										// Otherwise a 28px-tall empty row inflates the gap to the
										// assistant reply.
										const showUserToolbar =
											Boolean(text) &&
											(showCopyToolbar ||
												Boolean(onReplyUser) ||
												Boolean(reactionAction) ||
												Boolean(userToolbarActions?.length));
										const onContributedActionUser = onContributedMessageAction
											? (action: ContributedMessageAction, value?: string) =>
													onContributedMessageAction(action, {
														messageId: userMsgId,
														value,
													})
											: undefined;
										const userVersion = versions?.[userMsgId];
										const isEditingThis = editingId === userMsgId;
										return (
											<div
												className="group/user-message"
												ref={(el) => {
													// `userMsgId` above is the same id, already narrowed
													// to a definite string; `turn.userMsg?.id` was
													// `string | undefined` and registerAnchor needs one.
													registerAnchor(userMsgId, el);
													registerTranscriptAnchor(userMsgId, el);
												}}
											>
												<CustomUserMessage
													// Handed to UserMessage so it can sit on the outside
													// edge of the shrink-to-fit bubble row. A local user's
													// actions land left of the bubble; a remote sender's
													// actions land right.
													actions={
														!isEditingThis &&
														(showUserToolbar || goalAnnotation) ? (
															<div className="flex items-center gap-2">
																{showUserToolbar && (
																	<MessageToolbar
																		actionState={userActionState}
																		alignClass="justify-start"
																		contributedActions={userToolbarActions}
																		heightClass="h-[28px]"
																		hoverClass="group-hover/user-message:opacity-100 group-hover/user-message:pointer-events-auto"
																		isVisible={userCopyVisible}
																		menuAlign="start"
																		onBranch={
																			onBranch
																				? () => onBranch(userMsgId)
																				: undefined
																		}
																		onContributedAction={
																			onContributedActionUser
																		}
																		onCopied={() => markCopied(userCopyKey)}
																		onEdit={
																			onEditMessage && text
																				? () => setEditingId(userMsgId)
																				: undefined
																		}
																		onReply={onReplyUser}
																		reactionAction={reactionAction}
																		reactionMessageId={userMsgId}
																		text={showCopyToolbar ? text : ""}
																	/>
																)}
																{goalAnnotation}
															</div>
														) : null
													}
													className={classNames?.userMessage}
													currentUser={currentUser}
													editing={isEditingThis}
													enableImagePreview={enableImagePreview}
													groupPosition={groupPosition}
													mentionItems={mentionItems}
													message={turn.userMsg}
													messageActionState={messageActionStates?.get(
														userMsgId
													)}
													messageActions={userActions}
													onContributedMessageAction={
														onContributedMessageAction
													}
													onEditCancel={() => setEditingId(null)}
													onEditSubmit={(next: string) => {
														setEditingId(null);
														onEditMessage?.(userMsgId, next);
													}}
													onOpenFile={onOpenFile}
													onOpenLink={onOpenLink}
													onOpenMention={onOpenMention}
													previewResolvers={previewResolvers}
												/>
												{!isEditingThis &&
													userVersion &&
													userVersion.count > 1 &&
													onSelectVersion && (
														<VersionPager
															alignClass="justify-end"
															count={userVersion.count}
															ids={userVersion.ids}
															index={userVersion.index}
															onSelect={onSelectVersion}
														/>
													)}
											</div>
										);
									})()}

								{turn.assistantMsgs.length > 0 &&
									// Detail level "None" and this turn was pure tool
									// work: no reply bubble at all. The turn itself
									// survives here only because it carries the user's
									// own message (or the planning row) — see the
									// filter above.
									!assistantHiddenTurns.has(turn) &&
									!(isLastTurn && showPlanning && !hasUnreadMessage) &&
									(() => {
										const assistantParts = turn.assistantMsgs.flatMap(
											(msg) => msg.parts ?? []
										);
										const isTurnStreaming = isStreaming && isLastTurn;
										const turnEndCards = deriveTurnEndCards(
											assistantParts,
											turnKey
										);
										// Only reserve toolbar height when there's actually
										// something to show in it. With showCopyToolbar=false the
										// toolbar would otherwise render as a 48px-tall empty box,
										// creating large gaps between assistant turns.
										// The reply's send time comes from the last
										// assistant message (the turn's final part);
										// mirrors the user row.
										const assistantCreatedAt = (
											turn.assistantMsgs.at(-1) as {
												createdAt?: Date | string;
											}
										)?.createdAt;
										const assistantTimestamp =
											isMounted && assistantCreatedAt
												? new Date(assistantCreatedAt)
												: null;
										const branchMsgId = turn.assistantMsgs.at(-1)?.id;
										const isGoalCompletionTurn =
											Boolean(goalCompletion) &&
											!isTurnStreaming &&
											(goalCompletion?.messageId
												? goalCompletion.messageId === branchMsgId
												: isLastTurn);
										const completionEndMs =
											typeof goalCompletion?.achievedAt === "number" &&
											Number.isFinite(goalCompletion.achievedAt)
												? goalCompletion.achievedAt
												: assistantTimestamp?.getTime();
										const goalCompletionElapsedMs =
											isGoalCompletionTurn && goalCompletion
												? getGoalElapsedMs(
														goalCompletion,
														completionEndMs ?? Date.now()
													)
												: null;
										const goalCompletionNode =
											goalCompletionElapsedMs === null ? null : (
												<GoalCompletionFooter
													completedAt={
														isMounted && completionEndMs
															? new Date(completionEndMs)
															: null
													}
													elapsedMs={goalCompletionElapsedMs}
												/>
											);
										const reactionAction = messageActions?.find(
											(a) =>
												(a.target === "assistant" || a.target === "any") &&
												isMessageReactionAction(a)
										);
										const assistantVersion = branchMsgId
											? versions?.[branchMsgId]
											: undefined;
										const turnInterrupted =
											turn.assistantMsgs.some(isInterruptedMessage);
										return (
											<Message align="start" className="group/assistant-turn">
												{assistantAvatar ? (
													<MessageAvatar className="self-start bg-transparent group-has-data-[slot=message-footer]/message:translate-y-0">
														{assistantAvatar}
													</MessageAvatar>
												) : null}
												<MessageContent className="gap-1.5">
													{assistantName || assistantTimestamp ? (
														<MessageHeader className="gap-2 px-0">
															{assistantName ? (
																<span>{assistantName}</span>
															) : null}
															{assistantName && assistantTitle ? (
																<AgentTitleBadge title={assistantTitle} />
															) : null}
															{assistantTimestamp && (
																<TooltipProvider delay={0}>
																	<Tooltip>
																		{/* Base UI composes through `render`, not `asChild`. */}
																		<TooltipTrigger
																			render={
																				<span className="inline-flex items-center text-muted-foreground/70 text-xs">
																					{formatTime(
																						assistantTimestamp,
																						MESSAGE_TIME_OPTIONS
																					)}
																				</span>
																			}
																		/>
																		<TooltipContent>
																			<p>
																				{formatDateTime(
																					assistantTimestamp,
																					MESSAGE_TOOLTIP_OPTIONS
																				)}
																			</p>
																		</TooltipContent>
																	</Tooltip>
																</TooltipProvider>
															)}
														</MessageHeader>
													) : null}
													<div
														className={cn(
															"flex min-w-0 flex-col",
															turn.assistantMsgs.length > 1
																? "gap-0.5"
																: "gap-3"
														)}
													>
														{turn.assistantMsgs.map((msg, i) => {
															const isLastMsg =
																isLastTurn &&
																i === turn.assistantMsgs.length - 1;
															const assistantGroupPosition =
																messageGroupPositionFor(
																	i,
																	turn.assistantMsgs.length
																);
															const messageText = getTextFromParts(
																msg.parts ?? [],
																"\n\n"
															);
															const hasMessageText = Boolean(
																messageText.trim()
															);
															const messageCopyKey = `assistant-${msg.id}`;
															const messageActionState =
																messageActionStates?.get(msg.id);
															const assistantActions = messageActions?.filter(
																(a) =>
																	(a.target === "assistant" ||
																		a.target === "any") &&
																	!isMessageReactionAction(a) &&
																	(!isMemoryCitationsAction(a) ||
																		Boolean(
																			messageActionState?.memoryCitations
																				?.length
																		))
															);
															const onBranchMessage = onBranch
																? () => onBranch(msg.id)
																: undefined;
															const onSpeakMessage =
																onSpeak && hasMessageText
																	? () => onSpeak(messageText)
																	: undefined;
															const onReplyMessage =
																hasMessageText && (onReply || onQuote)
																	? () => {
																			if (onReply) {
																				onReply({
																					chainLength: turns.length - turnIndex,
																					messageId: msg.id,
																					text: messageText,
																				});
																				return;
																			}
																			onQuote?.(messageText);
																		}
																	: undefined;
															const onRegenerateMessageForMessage =
																onRegenerateMessage
																	? () => onRegenerateMessage(msg.id)
																	: undefined;
															const onContributedActionMessage =
																onContributedMessageAction
																	? (
																			action: ContributedMessageAction,
																			value?: string
																		) =>
																			onContributedMessageAction(action, {
																				messageId: msg.id,
																				value,
																			})
																	: undefined;
															const messageGoalCompletion = isLastMsg
																? goalCompletionNode
																: null;
															const showMessageToolbar =
																!isTurnStreaming &&
																(Boolean(messageGoalCompletion) ||
																	((showCopyToolbar ||
																		Boolean(onSpeakMessage) ||
																		Boolean(onReplyMessage) ||
																		Boolean(reactionAction) ||
																		Boolean(onBranchMessage) ||
																		Boolean(onRegenerateMessageForMessage) ||
																		Boolean(assistantActions?.length)) &&
																		hasMessageText));
															const shouldRenderToolbar =
																showMessageToolbar ||
																activeCopyId === messageCopyKey;
															return (
																<Fragment key={msg.id}>
																	{msg.id === firstUnreadMessageId ? (
																		<div
																			data-slot="unread-message-marker"
																			ref={unreadMarkerRef}
																		>
																			<Marker
																				aria-label={unreadMessageLabel}
																				className="my-1 text-primary before:bg-primary/30 after:bg-primary/30"
																				role="status"
																				variant="separator"
																			>
																				<MarkerIcon>
																					<span className="size-2 rounded-full bg-primary" />
																				</MarkerIcon>
																				<MarkerContent>
																					{unreadMessageLabel}
																				</MarkerContent>
																			</Marker>
																		</div>
																	) : null}
																	<div className="group/assistant-message flex w-fit max-w-full items-center gap-2">
																		<AssistantParts
																			agentMessageContext={agentMessageContext}
																			deferTurnEndCards={!isTurnStreaming}
																			groupPosition={assistantGroupPosition}
																			isLast={isLastMsg}
																			isStreaming={isStreaming}
																			mentionItems={mentionItems}
																			msg={msg}
																			onAgentUiSubmit={onAgentUiSubmit}
																			onOpenFile={onOpenFile}
																			onOpenLink={onOpenLink}
																			onOpenMention={onOpenMention}
																			onRetryError={
																				msg.id === "agent-chat-error"
																					? onRetryError
																					: onRegenerateMessageForMessage
																			}
																			onRetryGeneration={onRetryGeneration}
																			onWorkflowResume={onWorkflowResume}
																			previewResolvers={previewResolvers}
																			suppressQuestionTool={
																				suppressQuestionTool
																			}
																			ToolRendererComponent={CustomToolRenderer}
																			toolRenderers={toolRenderers}
																		/>
																		{shouldRenderToolbar ? (
																			<MessageToolbar
																				actionState={messageActionState}
																				alignClass=""
																				contributedActions={assistantActions}
																				goalCompletion={messageGoalCompletion}
																				heightClass="h-6"
																				hoverClass="group-hover/assistant-message:opacity-100 group-hover/assistant-message:pointer-events-auto"
																				isVisible={
																					isLastMsg ||
																					activeCopyId === messageCopyKey
																				}
																				menuAlign="end"
																				onBranch={onBranchMessage}
																				onContributedAction={
																					onContributedActionMessage
																				}
																				onCopied={() =>
																					markCopied(messageCopyKey)
																				}
																				onRegenerate={
																					onRegenerateMessageForMessage
																				}
																				onReply={onReplyMessage}
																				onSpeak={onSpeakMessage}
																				reactionAction={reactionAction}
																				reactionMessageId={msg.id}
																				text={
																					showCopyToolbar ? messageText : ""
																				}
																			/>
																		) : null}
																	</div>
																</Fragment>
															);
														})}
													</div>
													{!isTurnStreaming && turnEndCards.length > 0 ? (
														<TurnEndCards
															cards={turnEndCards}
															onAgentUiSubmit={onAgentUiSubmit}
															onOpenFile={onOpenFile}
															onReviewFileEdits={onReviewFileEdits}
															onUndoFileEdits={onUndoFileEdits}
														/>
													) : null}
													{turnInterrupted ? (
														// The turn the node died in the middle of. Driven by
														// `_interrupted` — server-stamped and reconciled at Core boot —
														// and NOT by sniffing the text, which is how this used to work:
														// the history mapper appended an "⚠️ Interrupted…" sentence as a
														// trailing text part, so a crash notice was indistinguishable
														// from something the agent wrote, came along when you copied the
														// reply, and had to be pattern-matched back out on resume.
														<Marker
															className="pt-0.5 text-destructive"
															variant="separator"
														>
															<MarkerIcon>
																<HugeiconsIcon
																	icon={Alert02Icon}
																	strokeWidth={2}
																/>
															</MarkerIcon>
															<MarkerContent>
																Interrupted — this reply was cut off before it
																finished. Send a follow-up to continue; it will
																not auto-resume after a restart.
															</MarkerContent>
														</Marker>
													) : null}
													{(() => {
														// Gate the whole footer, not each component: an
														// empty `MessageFooter` still renders a gapped
														// row under every turn.
														if (!statsEnabled) {
															return null;
														}
														const lastAssistantMsg = turn.assistantMsgs.at(-1);
														return lastAssistantMsg ? (
															<MessageFooter className="gap-3">
																{statsPluginEnabled && isLastTurn ? (
																	<StatsFooter
																		contextSize={contextSize}
																		conversationMessages={messages}
																		isMainChainActive={isTurnStreaming}
																		modelName={statsModelName}
																		usage={statsUsage}
																	/>
																) : (
																	<>
																		{/* Local-engine (llama.cpp) finalized stats. */}
																		<MessageStats
																			contextSize={contextSize}
																			msg={lastAssistantMsg}
																		/>
																		{/* ACP agents: live-ticking token count while
											    streaming, then frozen count + tok/s +
											    duration once the frame sets done:true.
											    `isLive` is the second brake — a turn that
											    never got its done:true frame (crash, Stop,
											    Core restart) would otherwise tick forever,
											    including days later when the thread is
											    reopened. */}
																		<AcpUsageStats
																			isLive={isTurnStreaming}
																			msg={lastAssistantMsg}
																		/>
																	</>
																)}
															</MessageFooter>
														) : null;
													})()}
													{assistantVersion &&
														assistantVersion.count > 1 &&
														onSelectVersion && (
															<VersionPager
																alignClass="justify-start"
																count={assistantVersion.count}
																ids={assistantVersion.ids}
																index={assistantVersion.index}
																onSelect={onSelectVersion}
															/>
														)}
												</MessageContent>
											</Message>
										);
									})()}

								{isLastTurn && showPlanning && (
									<div className="flex items-center gap-2 py-0.5">
										{planningLeading}
										<TypingIndicator label={planningLabel} />
									</div>
								)}
								{isLastTurn && answerNow ? (
									<div
										className={cn("flex", planningLeading ? "pl-6" : undefined)}
									>
										<AnswerNowButton control={answerNow} />
									</div>
								) : null}
							</div>
						</Fragment>
					);
				})}
				{[
					...(historyNotices ?? []),
					...(historyNotice ? [historyNotice] : []),
				].map((notice) => (
					// A thread-level notice, not a turn-level one, so it is the LAST
					// direct child of Content rather than part of any message. No
					// `messageId` and no scroll anchor, so it can never become the
					// scroll target and steal the jump from the user's next question —
					// the same rule the date separators follow.
					<Marker
						className="mt-2 shrink-0 py-1"
						key={notice.id}
						variant="separator"
					>
						<MarkerIcon>
							<HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} />
						</MarkerIcon>
						<MarkerContent>
							<span className="font-medium">{notice.title}</span>
							{notice.description ? <span> {notice.description}</span> : null}
						</MarkerContent>
						{notice.actions?.map((action) => (
							<button
								className="shrink-0 underline underline-offset-3 hover:text-foreground"
								key={action.label}
								onClick={action.onClick}
								type="button"
							>
								{action.label}
							</button>
						))}
					</Marker>
				))}
			</BeuiMessageScroller>
			{/* The scrolled-up escape hatch: beUI keeps following output only while
			    the reader stays at the live edge, so once they scroll up there is no
			    built-in way back down. A compact end button appears in that state
			    and returns to the newest message. `onFollowChange` drives it. */}
			{isCompact || following ? null : (
				<Button
					aria-label={`Scroll to latest${unreadMessageCount > 0 ? `, ${unreadMessageLabel}` : ""}`}
					className={cn(
						"absolute bottom-3 left-1/2 z-30 flex h-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background/85 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:text-foreground",
						unreadMessageCount > 0
							? "max-w-[calc(100%-1.5rem)] gap-1.5 px-3"
							: "w-8"
					)}
					onClick={() => {
						preserveUnreadBoundaryRef.current = false;
						setScrollDirection("down");
						const viewport = viewportRef.current;
						if (!viewport) {
							return;
						}
						if (typeof viewport.scrollTo === "function") {
							viewport.scrollTo({
								top: viewport.scrollHeight,
								behavior: "smooth",
							});
						} else {
							viewport.scrollTop = viewport.scrollHeight;
						}
					}}
					size={unreadMessageCount > 0 ? "sm" : "icon"}
					type="button"
					variant="ghost"
				>
					{isStreaming ? (
						<Loader
							label="Agent is active"
							size={16}
							speed={0.8}
							variant="dots"
						/>
					) : (
						<HugeiconsIcon icon={ArrowDown02Icon} strokeWidth={2} />
					)}
					{unreadMessageCount > 0 ? (
						<span className="truncate text-xs tabular-nums">
							{unreadMessageLabel}
						</span>
					) : (
						<span className="sr-only">Scroll to latest</span>
					)}
				</Button>
			)}
			{/* FloatingDateHeader is OUT OF FLOW BY CONSTRUCTION — it absolutely
			    positions against this relative root, exactly where it used to sit
			    inside the shadcn scroller's own root. Keeping it out of flow means
			    mounting it can never move a scroll anchor, which is the same
			    guarantee the pinned-user-message bar's design depends on. (The old
			    left-gutter ChatToc is gone — the beUI rail navigation replaced it,
			    with the same info rendered in its preview cards.) */}
			{isCompact ? null : (
				<FloatingDateHeader
					currentAnchorId={currentAnchorId}
					groups={dayGroups}
					startOfToday={startOfToday}
					turnIndexByAnchorId={turnIndexByAnchorId}
				/>
			)}
			{(onQuote || selectionActions?.length) && (
				<SelectionQuoteToolbar
					containerRef={scrollerRef}
					onContributedAction={onContributedSelectionAction}
					onQuote={onQuote}
					selectionActions={selectionActions}
				/>
			)}
		</div>
	);
});

/**
 * Stable stand-in for "no custom renderers". `toolRenderers` is a dependency of
 * the memo that builds a message's whole element tree, so a caller passing a
 * fresh `{}` (or leaving it undefined and letting a literal default be created
 * per render) rebuilds that tree every render.
 */
const NO_TOOL_RENDERERS: Record<
	string,
	React.ComponentType<CustomToolRendererProps>
> = Object.freeze({});

function AssistantParts({
	msg,
	groupPosition,
	isLast,
	isStreaming,
	suppressQuestionTool,
	ToolRendererComponent,
	toolRenderers = NO_TOOL_RENDERERS,
	onOpenFile,
	onOpenLink,
	onOpenMention,
	mentionItems,
	previewResolvers,
	onRetryGeneration,
	onRetryError,
	onWorkflowResume,
	onAgentUiSubmit,
	agentMessageContext,
	deferTurnEndCards,
}: {
	agentMessageContext?: AgentMessageContext;
	groupPosition: MessageGroupPosition;
	msg: UIMessage;
	isLast: boolean;
	isStreaming: boolean;
	suppressQuestionTool: boolean;
	ToolRendererComponent: React.ComponentType<ToolRendererProps>;
	toolRenderers?: Record<string, React.ComponentType<CustomToolRendererProps>>;
	onOpenFile?: (path: string) => void;
	onOpenLink?: (url: string) => void;
	onOpenMention?: (item: MentionItem) => void;
	mentionItems?: MentionItem[];
	previewResolvers?: LinkPreviewResolvers;
	onRetryGeneration?: MessageListProps["onRetryGeneration"];
	onRetryError?: () => void;
	onWorkflowResume?: MessageListProps["onWorkflowResume"];
	onAgentUiSubmit?: MessageListProps["onAgentUiSubmit"];
	deferTurnEndCards: boolean;
}) {
	const { expandCommands, expandFileEdits, groupToolUses, hideToolDetail } =
		useChatDisplayPrefs();
	const parts = useMemo(
		() => normalizeAssistantToolParts(msg.parts ?? []) as unknown[],
		[msg.parts]
	);
	const editedFiles = useMemo(() => deriveEditedFiles(parts), [parts]);

	const { elements } = useMemo(() => {
		// Each part is tagged as prose or not, because only the PROSE runs get a
		// bubble (see the fold at the end of this memo). Tool rows, generated
		// media, error cards and widgets already draw their own `bg-card`
		// surfaces; boxing them a second time double-frames every one of them.
		const elems: { isText: boolean; node: React.ReactNode }[] = [];
		const pushPart = (node: React.ReactNode, isText = false) => {
			elems.push({ isText, node });
		};
		// Extract once so text parts can render inline `[n]` chips against the
		// same numbered list shown in the sources footer. Read from the FULL part
		// list, before any detail filtering: the chips are numbered against this
		// list, so extracting from a filtered one would point `[2]` at a source
		// that is no longer there. Citations survive Detail level "None" — they
		// are part of the reply, not a tool row.
		const citations = extractCitations(parts);
		const taskPartIds = new Set(
			parts
				.filter(
					(p): p is ToolPartBase =>
						isV5ToolPart(p) &&
						(p.type === "tool-Task" || p.type === "tool-Agent") &&
						typeof p.toolCallId === "string"
				)
				.map((p) => p.toolCallId!)
		);
		const nestedToolsMap = new Map<string, ToolPartBase[]>();
		const nestedToolIds = new Set<string>();
		// Reactive-failover verdicts, collected up front so the PLAIN-TEXT TWIN
		// of each one can be dropped below. Core deliberately emits both: the
		// structured `data-ryu-failover` part for anything that can read data
		// frames, and the same `note` as an ordinary text block because
		// `/api/chat/stream` is not desktop-only — the TUI, the native app and the
		// island all POST to it and none of them renders `data-*`. So the twin
		// stays on the wire (removing it would silently strip the explanation from
		// those surfaces); it is suppressed HERE, where the structured part is
		// about to be drawn as a Marker instead.
		const failoverNotes = new Set<string>();
		for (const part of parts) {
			const note = getFailoverNote(part);
			if (note) {
				failoverNotes.add(note);
			}
		}

		// Only collect nested tools into the parent group when grouping is on.
		// When off, every tool renders individually (nestedToolIds stays empty so
		// the skip-check at render time doesn't hide them).
		//
		// Detail level "None" also switches grouping off, and not as a shortcut:
		// the only tool rows that survive None are the FAILED ones, and rolling a
		// failed child into a hidden parent would swallow the failure entirely.
		// With grouping off, every failed call is judged on its own.
		if (groupToolUses && !hideToolDetail) {
			for (const part of parts) {
				if (!isV5ToolPart(part)) {
					continue;
				}
				if (part.type === "tool-TaskOutput") {
					continue;
				}
				if (!part.toolCallId?.includes(":")) {
					continue;
				}
				const parentId = part.toolCallId.split(":")[0];
				if (!taskPartIds.has(parentId)) {
					continue;
				}
				if (!nestedToolsMap.has(parentId)) {
					nestedToolsMap.set(parentId, []);
				}
				nestedToolsMap.get(parentId)?.push(part);
				nestedToolIds.add(part.toolCallId);
			}
		}

		let i = 0;
		while (i < parts.length) {
			const part = parts[i]!;

			if (
				deferTurnEndCards &&
				((editedFiles.length > 0 && isEditedFilePart(part)) ||
					isTurnEndArtifactPart(part) ||
					isTurnEndJsonRenderPart(part))
			) {
				i++;
				continue;
			}

			if (isV5ToolPart(part) && part.type === "tool-TaskOutput") {
				i++;
				continue;
			}

			// The structured failover verdict, drawn as a Marker between the
			// reply's prose. `stand` never reaches a client, so any verdict that
			// arrives has something to say.
			const failoverNote = getFailoverNote(part);
			if (failoverNote) {
				pushPart(
					<Marker className="py-1" key={`${msg.id}-failover-${i}`}>
						<MarkerIcon>
							<HugeiconsIcon
								icon={ArrowDataTransferHorizontalIcon}
								strokeWidth={2}
							/>
						</MarkerIcon>
						<MarkerContent>{failoverNote}</MarkerContent>
					</Marker>
				);
				i++;
				continue;
			}

			// A workflow run part — the live per-node checklist Core streams while
			// a `workflow_id` chat turn executes. Repeated frames reconcile into
			// one part, so this renders once per turn, updating in place.
			if (isWorkflowRunPart(part)) {
				pushPart(
					<WorkflowRunProgressCard
						key={`${msg.id}-workflow-${i}`}
						msg={msg}
						onResume={onWorkflowResume}
					/>
				);
				i++;
				continue;
			}

			if (isTextPart(part)) {
				const text = part.text;
				// The plain-text twin of a verdict we just drew as a Marker. Dropped
				// here rather than server-side; see `failoverNotes` above.
				if (failoverNotes.has(text.trim())) {
					i++;
					continue;
				}
				if (text) {
					pushPart(
						// A `BubbleContent`, folded into a `Bubble` with its neighbouring
						// prose parts below. `w-fit` on the primitive is what makes a
						// one-line reply a small pill and a long one fill the column.
						<BubbleContent
							className={cn(
								"group/assistant-text overflow-visible text-[14px]",
								messageBubbleRadius("start", groupPosition)
							)}
							key={`${msg.id}-text-${i}`}
							{...messageSelectableProps}
						>
							<Markdown
								citations={citations.length > 0 ? citations : undefined}
								className="leading-relaxed [&_p]:leading-relaxed"
								content={text}
								mentionItems={mentionItems}
								onOpenFile={onOpenFile}
								onOpenLink={onOpenLink}
								onOpenMention={onOpenMention}
								previewResolvers={previewResolvers}
								wideBlocks
							/>
						</BubbleContent>,
						true
					);
				}
				i++;
				continue;
			}

			const generation = getImageGenerationPart(part);
			if (generation) {
				// Retry re-runs the SAME prompt against the same message, so it needs
				// one: a generation part that never carried a prompt (older shape, or
				// a producer that failed before it had one) gets no dead button.
				const retryPrompt = generation.prompt;
				pushPart(
					<AssistantGeneratedImage
						key={`${msg.id}-image-generation-${i}`}
						onRetry={
							onRetryGeneration && retryPrompt
								? () => onRetryGeneration(msg.id, "image", retryPrompt)
								: undefined
						}
						prompt={generation.prompt}
						showStatus
						status={generation.status}
						statusText={generation.statusText}
						url={generation.url}
					/>
				);
				i++;
				continue;
			}

			const videoGeneration = getVideoGenerationPart(part);
			if (videoGeneration) {
				const retryPrompt = videoGeneration.prompt;
				pushPart(
					<AssistantGeneratedVideo
						key={`${msg.id}-video-generation-${i}`}
						onRetry={
							onRetryGeneration && retryPrompt
								? () => onRetryGeneration(msg.id, "video", retryPrompt)
								: undefined
						}
						poster={videoGeneration.poster}
						prompt={videoGeneration.prompt}
						showStatus
						status={videoGeneration.status}
						statusText={videoGeneration.statusText}
						url={videoGeneration.url}
					/>
				);
				i++;
				continue;
			}

			const image = getAssistantImageMeta(part);
			if (image) {
				pushPart(
					<AssistantGeneratedImage
						filename={image.filename}
						key={`${msg.id}-image-${i}`}
						showStatus={false}
						status="complete"
						url={image.url}
					/>
				);
				i++;
				continue;
			}

			const videoUrl = getAssistantVideoUrl(part);
			if (videoUrl) {
				pushPart(
					<AssistantGeneratedVideo
						key={`${msg.id}-video-${i}`}
						showStatus={false}
						status="complete"
						url={videoUrl}
					/>
				);
				i++;
				continue;
			}

			const fileMeta = getAssistantFileMeta(part);
			if (fileMeta) {
				pushPart(
					fileMeta.media.startsWith("audio/") ? (
						// biome-ignore lint/a11y/useMediaCaption: generated audio has no caption track
						<audio
							className="max-w-[360px]"
							controls
							key={`${msg.id}-audio-${i}`}
							src={fileMeta.url}
						>
							<a href={fileMeta.url}>Download audio</a>
						</audio>
					) : (
						<FileAttachment
							filename={fileMeta.filename}
							id={`${msg.id}-file-${i}`}
							key={`${msg.id}-file-${i}`}
							size={fileMeta.size}
							url={fileMeta.url}
						/>
					)
				);
				i++;
				continue;
			}

			if (isErrorPart(part)) {
				pushPart(
					<ErrorMessage
						key={`${msg.id}-error-${i}`}
						message={part.message}
						onRetry={onRetryError}
						title={part.title}
					/>
				);
				i++;
				continue;
			}

			if (isV5ToolPart(part)) {
				if (suppressQuestionTool && part.type === "tool-Question") {
					i++;
					continue;
				}
				if (part.toolCallId && nestedToolIds.has(part.toolCallId)) {
					i++;
					continue;
				}
				// Detail level "None": no tool rows, no file edits, no thinking
				// traces — only the calls that FAILED, because a turn that died
				// silently is worse than a turn that shows one row.
				if (hideToolDetail && isHiddenAtNoDetail(part)) {
					i++;
					continue;
				}

				const chatStreamingStatus =
					isLast && isStreaming ? "streaming" : undefined;
				const groupOptions = { expandCommands, expandFileEdits };
				if (
					groupToolUses &&
					ToolRendererComponent === DefaultToolRenderer &&
					isToolActivityGroupCandidate(part, groupOptions)
				) {
					const groupedParts: ToolPartBase[] = [part];
					let nextIndex = i + 1;
					while (nextIndex < parts.length) {
						const nextPart = parts[nextIndex];
						if (
							!isV5ToolPart(nextPart) ||
							(nextPart.toolCallId !== undefined &&
								nestedToolIds.has(nextPart.toolCallId)) ||
							!isToolActivityGroupCandidate(nextPart, groupOptions)
						) {
							break;
						}
						groupedParts.push(nextPart);
						nextIndex += 1;
					}

					if (groupedParts.length > 1) {
						pushPart(
							<ToolGroup
								chatStatus={chatStreamingStatus}
								key={`${msg.id}-tool-group-${i}`}
								parts={groupedParts}
							/>
						);
						i = nextIndex;
						continue;
					}
				}
				const toolCallId = part.toolCallId;
				const nestedTools =
					(part.type === "tool-Task" || part.type === "tool-Agent") &&
					toolCallId
						? nestedToolsMap.get(toolCallId) || []
						: undefined;
				pushPart(
					<ToolRendererComponent
						agentMessageContext={agentMessageContext}
						chatStatus={chatStreamingStatus}
						key={part.toolCallId ?? `${msg.id}-tool-${i}`}
						nestedTools={nestedTools}
						onAgentUiSubmit={onAgentUiSubmit}
						part={part}
						toolRenderers={toolRenderers}
					/>
				);
				i++;
				continue;
			}

			// Route an app-widget data part (D6) through the tool renderer, keyed by
			// its shared `toolCallId` so it attaches after the matching tool row. The
			// default renderer dispatches it to the injected WidgetHostContext.
			if (isWidgetAvailablePart(part)) {
				// A widget exists only because a tool ran, so it is tool detail too.
				if (hideToolDetail) {
					i++;
					continue;
				}
				const widgetToolCallId = part.data?.toolCallId;
				const chatStreamingStatus =
					isLast && isStreaming ? "streaming" : undefined;
				pushPart(
					<ToolRendererComponent
						agentMessageContext={agentMessageContext}
						chatStatus={chatStreamingStatus}
						key={
							widgetToolCallId
								? `${widgetToolCallId}-widget`
								: `${msg.id}-widget-${i}`
						}
						onAgentUiSubmit={onAgentUiSubmit}
						part={part as ToolPartBase}
						toolRenderers={toolRenderers}
					/>
				);
				i++;
				continue;
			}

			i++;
		}

		// Cited sources from this turn's web tools (WebFetch/WebSearch) render as
		// a beUI citation list footer under the reply. Empty when no web tools ran.
		if (citations.length > 0) {
			const citationItems: CitationItem[] = citations.map((citation) => ({
				id: citation.url,
				title: citation.title,
				domain: hostnameOfCitation(citation.url),
				url: citation.url,
			}));
			pushPart(
				<CitationList
					citations={citationItems}
					className="mt-2 rounded-xl bg-muted/60 p-2"
					key={`${msg.id}-citations`}
				/>
			);
		}

		// Fold contiguous prose into ONE `Bubble` per run. A reply that reads
		// "sentence · tool call · sentence" therefore gets two bubbles with the
		// tool row between them, which is what actually happened, rather than one
		// bubble swallowing the tool row or three unrelated boxes.
		//
		// `muted` — a FILL, not a hairline. The two sides now read as one system:
		// the agent takes the neutral filled surface the user side used to own, and
		// the user side moves up to the theme's primary (see `user-message.tsx`). An
		// outline around the agent's prose was the odd one out — the only bubble in
		// the transcript drawn as a border rather than a surface.
		// `max-w-full` overrides the primitive's `max-w-[80%]`, which would squeeze
		// code, tables and diffs.
		const folded: React.ReactNode[] = [];
		let run: React.ReactNode[] = [];
		const flushRun = () => {
			if (run.length === 0) {
				return;
			}
			folded.push(
				<Bubble
					align="start"
					className="max-w-full"
					key={`${msg.id}-bubble-${folded.length}`}
					variant="muted"
				>
					{run}
				</Bubble>
			);
			run = [];
		};
		for (const entry of elems) {
			if (entry.isText) {
				run.push(entry.node);
				continue;
			}
			flushRun();
			folded.push(entry.node);
		}
		flushRun();

		return { elements: folded };
	}, [
		parts,
		msg.id,
		isLast,
		isStreaming,
		suppressQuestionTool,
		groupToolUses,
		hideToolDetail,
		expandCommands,
		expandFileEdits,
		ToolRendererComponent,
		agentMessageContext,
		toolRenderers,
		onRetryGeneration,
		onRetryError,
		onOpenFile,
		onOpenLink,
		onOpenMention,
		onWorkflowResume,
		previewResolvers,
		mentionItems,
		deferTurnEndCards,
		editedFiles,
	]);

	// Nothing to draw for this message — return null, not an empty div. Inside
	// the turn's `flex flex-col gap-3` an empty element is not invisible: it
	// still takes a 12px gap from each neighbour. That shows up at Detail level
	// "None" (a turn of prose followed by a message of pure tool calls) and,
	// before it, for a message that held only `tool-TaskOutput` parts.
	if (elements.length === 0) {
		return null;
	}

	if (elements.length > 1) {
		return (
			<div
				className="group/assistant-turn flex flex-col gap-3"
				data-assistant-group-position={groupPosition}
			>
				{elements}
			</div>
		);
	}

	return (
		<div
			className="group/assistant-turn"
			data-assistant-group-position={groupPosition}
		>
			{elements}
		</div>
	);
}
