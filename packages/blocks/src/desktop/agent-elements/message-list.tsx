import { Button } from "@ryu/ui/components/button";
import {
	Message,
	MessageAvatar,
	MessageContent,
	MessageFooter,
	MessageHeader,
} from "@ryu/ui/components/message";
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from "@ryu/ui/components/message-scroller";
import { cn } from "@ryu/ui/lib/utils";
import {
	IconCheck,
	IconChevronLeft,
	IconChevronRight,
	IconCopy,
	IconPencil,
	IconRefresh,
	IconThumbDown,
	IconThumbUp,
	IconVolume,
} from "@tabler/icons-react";
import type { ChatStatus, UIMessage } from "ai";
import type React from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatDisplayPrefs } from "./chat-display-prefs.tsx";
import { ChatToc, type ChatTocItem } from "./chat-toc.tsx";
import { CheckpointIcon } from "./checkpoint.tsx";
import { ErrorMessage } from "./error-message.tsx";
import { usePinnedUserMessage } from "./hooks/use-pinned-user-message.ts";
import { CitationSources } from "./inline-citation.tsx";
import { Markdown } from "./markdown.tsx";
import { AcpUsageStats, MessageStats } from "./message-stats.tsx";
import { PinnedUserMessageBar } from "./pinned-user-message-bar.tsx";
import { messageSelectableProps, SelectionQuoteToolbar } from "./quote.tsx";
import { SpiralLoader } from "./spiral-loader.tsx";
import { ToolRenderer as DefaultToolRenderer } from "./tools/tool-renderer.tsx";
import { ToolRowBase } from "./tools/tool-row-base.tsx";
import type { CustomToolRendererProps } from "./types.ts";
import { UserMessage } from "./user-message.tsx";
import { extractCitations } from "./utils/citations.ts";
import { normalizeAssistantToolParts } from "./utils/tool-part-normalizer.ts";

export interface MessageListProps {
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
	 * When true (default) clicking an attached image in a user message opens
	 * the fullscreen lightbox preview. Set to false to disable previews.
	 */
	enableImagePreview?: boolean;
	/**
	 * Persisted thumbs state keyed by (assistant) message id. Only ids present here
	 * render a lit thumb; absent ids are unrated.
	 */
	feedback?: Record<string, "up" | "down">;
	/**
	 * Where to position the scroll container on initial mount.
	 * - "bottom" (default): classic chat behavior, pinned to the latest message.
	 * - "top": start from the top of the conversation — useful for static demos
	 *   or read-only transcripts where the user should read top-to-bottom.
	 */
	initialScrollBehavior?: "bottom" | "top";
	messages: UIMessage[];
	/**
	 * Branch ("fork into new chat") a message. When provided, a branch button is
	 * shown in each message's hover toolbar; clicking it calls this with the id of
	 * the message to branch from (history up to and including it is copied).
	 */
	onBranch?: (messageId: string) => void;
	/**
	 * Edit a previously-sent user message into a new version (ChatGPT/Claude-style
	 * branching). When provided, a pencil button appears in each user message's
	 * hover toolbar; clicking it turns the bubble into an inline editor. Saving
	 * calls this with the message id and new text.
	 */
	onEditMessage?: (messageId: string, newText: string) => void;
	/**
	 * Thumbs 👍/👎 on an assistant turn. When provided, thumbs buttons appear in
	 * each assistant turn's hover toolbar; clicking calls this with the turn's last
	 * message id, the new rating (`null` clears a previous vote), and whether this
	 * is the latest turn. The lit state is driven by `feedback` (persisted
	 * server-side).
	 */
	onFeedback?: (
		messageId: string,
		rating: "up" | "down" | null,
		isLatest: boolean
	) => void;
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
	showCopyToolbar?: boolean;
	slots?: {
		UserMessage?: React.ComponentType<{
			message: UIMessage;
			className?: string;
			enableImagePreview?: boolean;
			editing?: boolean;
			onEditSubmit?: (text: string) => void;
			onEditCancel?: () => void;
		}>;
		ToolRenderer?: React.ComponentType<ToolRendererProps>;
	};
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

// Combined day-month + time, e.g. "23 Jun, 1:45 pm". en-GB gives the
// day-first order with lowercase am/pm the design calls for.
const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "short",
	hour: "numeric",
	minute: "2-digit",
	hour12: true,
});
interface ToolPartBase {
	input?: unknown;
	output?: unknown;
	result?: unknown;
	state?: string;
	toolCallId?: string;
	type: string;
}

interface ToolRendererProps {
	chatStatus?: string;
	nestedTools?: ToolPartBase[];
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

function getLastAssistantHasContent(messages: UIMessage[]) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role !== "assistant") {
			continue;
		}
		return (msg.parts ?? []).some((part) => {
			if (isTextPart(part)) {
				return part.text.trim().length > 0;
			}
			return isV5ToolPart(part);
		});
	}
	return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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

/**
 * An assistant image part — a standard AI SDK `file` part whose media type is an
 * image, carrying a `url` (a data: URL for generated images, or a remote URL).
 * Generated images are appended in this exact shape (see ChatPage's
 * handleGenerateImage), so the producer and this consumer agree.
 */
function getAssistantImageUrl(part: unknown): string | null {
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
	if (!media?.startsWith("image/")) {
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
 * A NON-image assistant `file` part (audio, or any other mime), resolved to a
 * playable/downloadable url + its media type. Images are handled separately by
 * {@link getAssistantImageUrl}; this covers the rest so inline audio (and other
 * attachments Core streams) isn't silently dropped.
 */
function getAssistantFileMeta(
	part: unknown
): { media: string; url: string } | null {
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
	if (!media || media.startsWith("image/")) {
		return null;
	}
	if (filePart.url) {
		return { url: filePart.url, media };
	}
	if (filePart.data) {
		return { url: `data:${media};base64,${filePart.data}`, media };
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

function formatTimestamp(date: Date): string {
	return dateTimeFormatter.format(date);
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
			className={cn("size-6 rounded-md opacity-50 hover:opacity-100")}
			onClick={handleCopy}
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => {
				event.stopPropagation();
			}}
			size="icon"
			tabIndex={-1}
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

// Restore a checkpoint: forks a new chat from this point (history up to and
// including this message is copied), leaving the original thread intact. The
// bookmark affordance mirrors the AI SDK "Checkpoint" element over Ryu's
// existing non-destructive fork.
function BranchButton({ onBranch }: { onBranch: () => void }) {
	return (
		<Button
			aria-label="Restore checkpoint"
			className={cn("size-6 rounded-md opacity-50 hover:opacity-100")}
			onClick={onBranch}
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => {
				event.stopPropagation();
			}}
			size="icon"
			tabIndex={-1}
			title="Restore checkpoint (branch a new chat from here)"
			type="button"
			variant="ghost"
		>
			<CheckpointIcon className="text-muted-foreground" />
		</Button>
	);
}

function SpeakButton({ onSpeak }: { onSpeak: () => void }) {
	const [speaking, setSpeaking] = useState(false);
	const handleSpeak = async () => {
		if (speaking) {
			return;
		}
		setSpeaking(true);
		try {
			await onSpeak();
		} finally {
			setSpeaking(false);
		}
	};
	return (
		<Button
			aria-label="Speak reply"
			className={cn("size-6 rounded-md opacity-50 hover:opacity-100")}
			disabled={speaking}
			onClick={() => {
				handleSpeak().catch(() => undefined);
			}}
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => {
				event.stopPropagation();
			}}
			size="icon"
			tabIndex={-1}
			title="Speak reply"
			type="button"
			variant="ghost"
		>
			<IconVolume
				className={cn(
					"h-3.5 w-3.5 text-muted-foreground",
					speaking && "text-primary"
				)}
			/>
		</Button>
	);
}

// Edit a previously-sent user message (ChatGPT/Claude-style): turns the bubble
// into an inline editor. The actual editing UI lives in UserMessage; this just
// requests entry into edit mode.
function EditButton({ onEdit }: { onEdit: () => void }) {
	return (
		<Button
			aria-label="Edit message"
			className={cn("size-6 rounded-md opacity-50 hover:opacity-100")}
			onClick={onEdit}
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => {
				event.stopPropagation();
			}}
			size="icon"
			tabIndex={-1}
			title="Edit message"
			type="button"
			variant="ghost"
		>
			<IconPencil className="h-3.5 w-3.5 text-muted-foreground" />
		</Button>
	);
}

// Regenerate an assistant reply as a new version.
function RegenerateButton({ onRegenerate }: { onRegenerate: () => void }) {
	return (
		<Button
			aria-label="Regenerate reply"
			className={cn("size-6 rounded-md opacity-50 hover:opacity-100")}
			onClick={onRegenerate}
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => {
				event.stopPropagation();
			}}
			size="icon"
			tabIndex={-1}
			title="Regenerate reply"
			type="button"
			variant="ghost"
		>
			<IconRefresh className="h-3.5 w-3.5 text-muted-foreground" />
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

// Thumbs 👍/👎 on an assistant reply. Clicking the active rating again clears it
// (toggle); the lit state is driven by `rating` (persisted server-side), so it
// survives reloads. The vote seeds the learning + memory sinks in Core.
type FeedbackRating = "up" | "down";

function FeedbackButtons({
	rating,
	onFeedback,
}: {
	rating?: FeedbackRating;
	onFeedback: (next: FeedbackRating | null) => void;
}) {
	const vote = (value: FeedbackRating) => {
		onFeedback(rating === value ? null : value);
	};
	return (
		<>
			<Button
				aria-label="Good response"
				aria-pressed={rating === "up"}
				className={cn(
					"size-6 rounded-md opacity-50 hover:opacity-100",
					rating === "up" && "opacity-100"
				)}
				onClick={() => vote("up")}
				onMouseDown={(event) => event.stopPropagation()}
				onPointerDown={(event) => {
					event.stopPropagation();
				}}
				size="icon"
				tabIndex={-1}
				title="Good response"
				type="button"
				variant="ghost"
			>
				<IconThumbUp
					className={cn(
						"h-3.5 w-3.5 text-muted-foreground",
						rating === "up" && "fill-current text-primary"
					)}
				/>
			</Button>
			<Button
				aria-label="Bad response"
				aria-pressed={rating === "down"}
				className={cn(
					"size-6 rounded-md opacity-50 hover:opacity-100",
					rating === "down" && "opacity-100"
				)}
				onClick={() => vote("down")}
				onMouseDown={(event) => event.stopPropagation()}
				onPointerDown={(event) => {
					event.stopPropagation();
				}}
				size="icon"
				tabIndex={-1}
				title="Bad response"
				type="button"
				variant="ghost"
			>
				<IconThumbDown
					className={cn(
						"h-3.5 w-3.5 text-muted-foreground",
						rating === "down" && "fill-current text-destructive"
					)}
				/>
			</Button>
		</>
	);
}

function MessageToolbar({
	text,
	timestamp,
	heightClass,
	hoverClass,
	isVisible,
	alignClass,
	onCopied,
	onBranch,
	onEdit,
	onRegenerate,
	onSpeak,
	feedbackRating,
	onFeedback,
}: {
	text?: string;
	timestamp?: string;
	heightClass: string;
	hoverClass: string;
	isVisible: boolean;
	alignClass: string;
	onCopied?: () => void;
	onBranch?: () => void;
	onEdit?: () => void;
	onRegenerate?: () => void;
	onSpeak?: () => void;
	feedbackRating?: FeedbackRating;
	onFeedback?: (next: FeedbackRating | null) => void;
}) {
	return (
		<div
			className={cn(
				"pointer-events-none flex items-center gap-1 pt-1 text-muted-foreground/70 text-xs opacity-0 transition-opacity duration-100",
				heightClass,
				alignClass,
				hoverClass,
				isVisible && "pointer-events-auto opacity-100"
			)}
			onMouseDown={(event) => event.stopPropagation()}
			onPointerDown={(event) => event.stopPropagation()}
		>
			{timestamp && <span>{timestamp}</span>}
			{text && <CopyButton onCopied={onCopied} text={text} />}
			{onEdit && <EditButton onEdit={onEdit} />}
			{onRegenerate && <RegenerateButton onRegenerate={onRegenerate} />}
			{onBranch && <BranchButton onBranch={onBranch} />}
			{onSpeak && <SpeakButton onSpeak={onSpeak} />}
			{onFeedback && (
				<FeedbackButtons onFeedback={onFeedback} rating={feedbackRating} />
			)}
		</div>
	);
}

/** Group flat messages into turns (user message + following assistant messages) */
function groupMessagesIntoTurns(messages: UIMessage[]) {
	const turns: { userMsg?: UIMessage; assistantMsgs: UIMessage[] }[] = [];
	let current: { userMsg?: UIMessage; assistantMsgs: UIMessage[] } | null =
		null;

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

export const MessageList = memo(function MessageList({
	messages,
	status,
	className,
	showCopyToolbar = true,
	onBranch,
	onEditMessage,
	onRegenerateMessage,
	onFeedback,
	feedback,
	onSelectVersion,
	versions,
	onSpeak,
	onQuote,
	suppressQuestionTool = false,
	initialScrollBehavior = "bottom",
	enableImagePreview = true,
	assistantAvatar,
	assistantName,
	slots,
	classNames,
	toolRenderers,
	contextSize,
}: MessageListProps) {
	const [activeCopyId, setActiveCopyId] = useState<string | null>(null);
	// Which user message is currently in inline-edit mode (null = none).
	const [editingId, setEditingId] = useState<string | null>(null);
	const [isMounted, setIsMounted] = useState(false);
	const scrollerRef = useRef<HTMLDivElement>(null);
	const { pinUserMessage } = useChatDisplayPrefs();

	const { pinnedMessage, registerAnchor, scrollToPinned } =
		usePinnedUserMessage({
			enabled: pinUserMessage,
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
	const planningLabel = "Thinking";
	const turns = useMemo(
		() => groupMessagesIntoTurns(normalizedMessages),
		[normalizedMessages]
	);
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
			items.push({ id: turn.userMsg.id, title });
		}
		return items;
	}, [turns]);
	const showPlanning = useMemo(() => {
		const lastMessage = normalizedMessages.at(-1);
		if (!lastMessage) {
			return false;
		}
		const lastTurn = turns.at(-1);
		const hasAssistant = Boolean(lastTurn && lastTurn.assistantMsgs.length > 0);
		if (lastMessage.role === "user" && !hasAssistant) {
			return true;
		}
		return isStreaming && !getLastAssistantHasContent(normalizedMessages);
	}, [isStreaming, normalizedMessages, turns]);

	return (
		<MessageScrollerProvider
			autoScroll
			defaultScrollPosition={initialScrollBehavior === "top" ? "start" : "end"}
		>
			<div className="flex min-h-0 flex-1 flex-col" ref={scrollerRef}>
				<MessageScroller className={cn("an-message-list flex-1", className)}>
					<ChatToc items={tocItems} />
					<MessageScrollerViewport>
						{pinUserMessage && pinnedMessage ? (
							<div className="sticky top-0 z-20 -mb-1">
								<div className="mx-auto w-full max-w-[720px] px-4 pt-2 pb-1">
									<PinnedUserMessageBar
										message={pinnedMessage}
										onScrollTo={scrollToPinned}
									/>
								</div>
							</div>
						) : null}
						<MessageScrollerContent className="mx-auto w-full max-w-[720px] gap-2 px-4 py-6">
							{turns.map((turn, turnIndex) => {
								const isLastTurn = turnIndex === turns.length - 1;
								const turnKey = turn.userMsg?.id ?? `turn-${turnIndex}`;

								return (
									<MessageScrollerItem
										className="relative space-y-2"
										key={turnKey}
										messageId={turnKey}
										scrollAnchor={Boolean(turn.userMsg)}
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
												const userCreatedAt = (
													turn.userMsg as { createdAt?: Date | string }
												)?.createdAt;
												const userCopyKey = `user-${turn.userMsg.id}`;
												const userCopyVisible = activeCopyId === userCopyKey;
												const userTimestamp =
													isMounted && userCreatedAt
														? formatTimestamp(new Date(userCreatedAt))
														: undefined;
												// Only render the toolbar when it has content — copy
												// button (gated by showCopyToolbar) or a timestamp.
												// Otherwise a 28px-tall empty row inflates the gap to the
												// assistant reply.
												const showUserToolbar =
													(showCopyToolbar && Boolean(text)) ||
													Boolean(userTimestamp);
												const userMsgId = turn.userMsg.id;
												const userVersion = versions?.[userMsgId];
												const isEditingThis = editingId === userMsgId;
												return (
													<div
														className="group/user-message"
														ref={(el) => {
															registerAnchor(turn.userMsg?.id, el);
														}}
													>
														<CustomUserMessage
															className={classNames?.userMessage}
															editing={isEditingThis}
															enableImagePreview={enableImagePreview}
															message={turn.userMsg}
															onEditCancel={() => setEditingId(null)}
															onEditSubmit={(next: string) => {
																setEditingId(null);
																onEditMessage?.(userMsgId, next);
															}}
														/>
														{!isEditingThis && showUserToolbar && (
															<MessageToolbar
																alignClass="justify-end"
																heightClass="h-[28px]"
																hoverClass="group-hover/user-message:opacity-100 group-hover/user-message:pointer-events-auto"
																isVisible={userCopyVisible}
																onBranch={
																	onBranch
																		? () => onBranch(turn.userMsg?.id)
																		: undefined
																}
																onCopied={() => markCopied(userCopyKey)}
																onEdit={
																	onEditMessage && text
																		? () => setEditingId(userMsgId)
																		: undefined
																}
																text={showCopyToolbar ? text : ""}
																timestamp={userTimestamp}
															/>
														)}
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
											!(isLastTurn && showPlanning) &&
											(() => {
												const assistantText = getTextFromParts(
													turn.assistantMsgs.flatMap((msg) => msg.parts ?? []),
													"\n\n"
												);
												const isTurnStreaming = isStreaming && isLastTurn;
												// Only reserve toolbar height when there's actually
												// something to show in it. With showCopyToolbar=false the
												// toolbar would otherwise render as a 48px-tall empty box,
												// creating large gaps between assistant turns.
												const hasAssistantText = Boolean(assistantText.trim());
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
														? formatTimestamp(new Date(assistantCreatedAt))
														: undefined;
												const showToolbar =
													(showCopyToolbar ||
														Boolean(onSpeak) ||
														Boolean(assistantTimestamp)) &&
													hasAssistantText &&
													!isTurnStreaming;
												const copyKey = `assistant-${turnKey}-all`;
												const toolbarText = showCopyToolbar
													? assistantText
													: "";
												const branchMsgId = turn.assistantMsgs.at(-1)?.id;
												const onBranchTurn =
													onBranch && branchMsgId
														? () => onBranch(branchMsgId)
														: undefined;
												const onSpeakTurn =
													onSpeak && hasAssistantText
														? () => onSpeak(assistantText)
														: undefined;
												const onRegenerateTurn =
													onRegenerateMessage && branchMsgId
														? () => onRegenerateMessage(branchMsgId)
														: undefined;
												const onFeedbackTurn =
													onFeedback && branchMsgId
														? (next: FeedbackRating | null) =>
																onFeedback(branchMsgId, next, isLastTurn)
														: undefined;
												const feedbackRating = branchMsgId
													? feedback?.[branchMsgId]
													: undefined;
												const assistantVersion = branchMsgId
													? versions?.[branchMsgId]
													: undefined;

												return (
													<Message
														align="start"
														className="group/assistant-turn"
													>
														{assistantAvatar ? (
															<MessageAvatar className="self-start bg-transparent group-has-data-[slot=message-footer]/message:translate-y-0">
																{assistantAvatar}
															</MessageAvatar>
														) : null}
														<MessageContent>
															{assistantName ? (
																<MessageHeader className="px-0">
																	{assistantName}
																</MessageHeader>
															) : null}
															<div className="flex flex-col gap-3">
																{turn.assistantMsgs.map((msg, i) => {
																	const isLastMsg =
																		isLastTurn &&
																		i === turn.assistantMsgs.length - 1;
																	return (
																		<AssistantParts
																			isLast={isLastMsg}
																			isStreaming={isStreaming}
																			key={msg.id}
																			msg={msg}
																			suppressQuestionTool={
																				suppressQuestionTool
																			}
																			ToolRendererComponent={CustomToolRenderer}
																			toolRenderers={toolRenderers}
																		/>
																	);
																})}
															</div>
															{(() => {
																const lastAssistantMsg =
																	turn.assistantMsgs.at(-1);
																return lastAssistantMsg ? (
																	<MessageFooter className="gap-3">
																		{/* Local-engine (llama.cpp) finalized stats. */}
																		<MessageStats
																			contextSize={contextSize}
																			msg={lastAssistantMsg}
																		/>
																		{/* ACP agents: live-ticking token count while
															    streaming, then frozen count + tok/s +
															    duration once the frame sets done:true. */}
																		<AcpUsageStats msg={lastAssistantMsg} />
																	</MessageFooter>
																) : null;
															})()}
															{showToolbar ? (
																<MessageToolbar
																	alignClass="justify-start"
																	feedbackRating={feedbackRating}
																	heightClass="h-[48px] flex items-start w-full"
																	hoverClass="group-hover/assistant-turn:opacity-100 group-hover/assistant-turn:pointer-events-auto"
																	// Latest turn: pin the action buttons open so they
																	// don't require a hover; older turns stay hover-only
																	// via hoverClass.
																	isVisible={
																		isLastTurn || activeCopyId === copyKey
																	}
																	onBranch={onBranchTurn}
																	onCopied={() => markCopied(copyKey)}
																	onFeedback={onFeedbackTurn}
																	onRegenerate={onRegenerateTurn}
																	onSpeak={onSpeakTurn}
																	text={toolbarText}
																	timestamp={assistantTimestamp}
																/>
															) : activeCopyId === copyKey ? (
																<MessageToolbar
																	alignClass="justify-start"
																	feedbackRating={feedbackRating}
																	heightClass="h-[48px] flex items-start w-full"
																	hoverClass="group-hover/assistant-turn:opacity-100 group-hover/assistant-turn:pointer-events-auto"
																	isVisible={true}
																	onBranch={onBranchTurn}
																	onCopied={() => markCopied(copyKey)}
																	onFeedback={onFeedbackTurn}
																	onRegenerate={onRegenerateTurn}
																	onSpeak={onSpeakTurn}
																	text={toolbarText}
																	timestamp={assistantTimestamp}
																/>
															) : null}
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
											<ToolRowBase
												completeLabel="Done"
												icon={<SpiralLoader size={12} />}
												isAnimating={true}
												shimmerLabel={planningLabel}
											/>
										)}
									</MessageScrollerItem>
								);
							})}
						</MessageScrollerContent>
					</MessageScrollerViewport>
					<MessageScrollerButton direction="end" />
				</MessageScroller>
				{onQuote && (
					<SelectionQuoteToolbar containerRef={scrollerRef} onQuote={onQuote} />
				)}
			</div>
		</MessageScrollerProvider>
	);
});

function AssistantParts({
	msg,
	isLast,
	isStreaming,
	suppressQuestionTool,
	ToolRendererComponent,
	toolRenderers,
}: {
	msg: UIMessage;
	isLast: boolean;
	isStreaming: boolean;
	suppressQuestionTool: boolean;
	ToolRendererComponent: React.ComponentType<ToolRendererProps>;
	toolRenderers?: Record<string, React.ComponentType<CustomToolRendererProps>>;
}) {
	const { groupToolUses } = useChatDisplayPrefs();
	const parts = useMemo(
		() => normalizeAssistantToolParts(msg.parts ?? []) as unknown[],
		[msg.parts]
	);

	const { elements } = useMemo(() => {
		const elems: React.ReactNode[] = [];
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

		// Only collect nested tools into the parent group when grouping is on.
		// When off, every tool renders individually (nestedToolIds stays empty so
		// the skip-check at render time doesn't hide them).
		if (groupToolUses) {
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

			if (isV5ToolPart(part) && part.type === "tool-TaskOutput") {
				i++;
				continue;
			}

			if (isTextPart(part)) {
				const text = part.text;
				if (text) {
					elems.push(
						<div
							className="group/assistant-text text-[14px]"
							key={`${msg.id}-text-${i}`}
							{...messageSelectableProps}
						>
							<Markdown
								className="leading-relaxed [&_p]:leading-relaxed"
								content={text}
							/>
						</div>
					);
				}
				i++;
				continue;
			}

			const imageUrl = getAssistantImageUrl(part);
			if (imageUrl) {
				elems.push(
					<div
						className="max-w-[360px] rounded-2xl bg-foreground/4 p-1.5"
						key={`${msg.id}-image-${i}`}
					>
						<img
							alt="Generated image"
							className="block max-h-[360px] max-w-full rounded-xl object-contain"
							src={imageUrl}
						/>
					</div>
				);
				i++;
				continue;
			}

			const fileMeta = getAssistantFileMeta(part);
			if (fileMeta) {
				elems.push(
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
						<a
							className="inline-flex max-w-[360px] items-center gap-2 rounded-xl bg-foreground/4 px-3 py-2 text-sm hover:bg-foreground/8"
							download
							href={fileMeta.url}
							key={`${msg.id}-file-${i}`}
							rel="noopener"
						>
							Download attachment ({fileMeta.media})
						</a>
					)
				);
				i++;
				continue;
			}

			if (isErrorPart(part)) {
				elems.push(
					<ErrorMessage
						key={`${msg.id}-error-${i}`}
						message={part.message}
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

				const chatStreamingStatus =
					isLast && isStreaming ? "streaming" : undefined;
				const toolCallId = part.toolCallId;
				const nestedTools =
					(part.type === "tool-Task" || part.type === "tool-Agent") &&
					toolCallId
						? nestedToolsMap.get(toolCallId) || []
						: undefined;
				elems.push(
					<ToolRendererComponent
						chatStatus={chatStreamingStatus}
						key={part.toolCallId ?? `${msg.id}-tool-${i}`}
						nestedTools={nestedTools}
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
				const widgetToolCallId = part.data?.toolCallId;
				const chatStreamingStatus =
					isLast && isStreaming ? "streaming" : undefined;
				elems.push(
					<ToolRendererComponent
						chatStatus={chatStreamingStatus}
						key={
							widgetToolCallId
								? `${widgetToolCallId}-widget`
								: `${msg.id}-widget-${i}`
						}
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
		// a hover-pill "Sources" strip below the reply. Empty when no web tools
		// ran, so ordinary turns are unaffected.
		const citations = extractCitations(parts);
		if (citations.length > 0) {
			elems.push(
				<CitationSources citations={citations} key={`${msg.id}-citations`} />
			);
		}

		return { elements: elems };
	}, [
		parts,
		msg.id,
		isLast,
		isStreaming,
		suppressQuestionTool,
		groupToolUses,
		ToolRendererComponent,
		toolRenderers,
	]);

	if (elements.length > 1) {
		return (
			<div className="group/assistant-turn flex flex-col gap-3">{elements}</div>
		);
	}

	return <div className="group/assistant-turn">{elements}</div>;
}
