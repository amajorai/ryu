import { Target01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Avatar, AvatarFallback, AvatarImage } from "@ryu/ui/components/avatar";
import { Bubble, BubbleContent } from "@ryu/ui/components/bubble";
import { Button } from "@ryu/ui/components/button";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar";
import {
	Message,
	MessageAvatar,
	MessageContent,
	MessageFooter,
	MessageHeader,
} from "@ryu/ui/components/message";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { formatDateTime, formatTime } from "@ryu/ui/lib/timezone.ts";
import { cn } from "@ryu/ui/lib/utils";
import type { UIMessage } from "ai";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { CollapsibleText } from "./collapsible-text.tsx";
import { ImageLightbox } from "./image-lightbox.tsx";
import { FileAttachment } from "./input/file-attachment.tsx";
import type { LinkPreviewResolvers } from "./link-preview.tsx";
import { Markdown } from "./markdown.tsx";
import { getMessageAttachments } from "./message-attachments.ts";
import {
	type MessageGroupPosition,
	messageBubbleRadius,
} from "./message-bubble.ts";
import {
	messageSelectableProps,
	QuoteBlock,
	splitLeadingQuote,
} from "./quote.tsx";
import type {
	ContributedMessageAction,
	MentionItem,
	MessageActionContext,
	MessageActionRuntimeState,
} from "./types.ts";
import { getWidgetMessageAttribution } from "./types.ts";

export interface UserMessageProps {
	/**
	 * Hover actions (copy / edit / branch) for this turn. The message row places
	 * them beside the bubble: on the outside edge for the local user and the
	 * opposite edge for a remote sender.
	 */
	actions?: ReactNode;
	className?: string;
	/** Current signed-in user info for displaying avatar/name on own messages. */
	currentUser?: {
		avatar?: string;
		name?: string;
		id?: string;
	};
	/** When true, the bubble is replaced by an inline editor (ChatGPT/Claude-style
	 * message editing). Saving calls `onEditSubmit`; Escape/Cancel calls
	 * `onEditCancel`. */
	editing?: boolean;
	/**
	 * When true (default) clicking an attached image opens a fullscreen
	 * lightbox preview. Set to false to render images as plain thumbnails.
	 */
	enableImagePreview?: boolean;
	/**
	 * Where this row sits in its sender RUN — consecutive messages from the same
	 * speaker with no reply and no day boundary between them. Computed by the
	 * transcript across sibling scroll items (`userRunPositions` in
	 * message-list.tsx), because a run spans turns and therefore cannot be a
	 * wrapper element.
	 *
	 * It drives the whole messaging convention: the avatar and the timestamp are
	 * drawn once, on the row that CLOSES the run, and a remote sender is named
	 * once, on the row that OPENS it. Everything else about the row is unchanged,
	 * including its hover toolbar and its edit affordance.
	 *
	 * Defaults to `"single"`, which is the ungrouped behaviour every other
	 * surface (island, storyboard, subagent panel) gets for free.
	 */
	groupPosition?: MessageGroupPosition;
	mentionItems?: MentionItem[];
	message: UIMessage;
	/** Runtime state keyed for the message-action renderers. */
	messageActionState?: MessageActionRuntimeState;
	/** Message actions contributed by enabled plugins. */
	messageActions?: readonly ContributedMessageAction[];
	/** Dispatch a contributed action back to the shell. */
	onContributedMessageAction?: (
		action: ContributedMessageAction,
		context: MessageActionContext
	) => void;
	onEditCancel?: () => void;
	onEditSubmit?: (text: string) => void;
	onOpenFile?: (path: string) => void;
	onOpenLink?: (url: string) => void;
	onOpenMention?: (item: MentionItem) => void;
	previewResolvers?: LinkPreviewResolvers;
}

/** Compact transcript annotation shown beneath a goal-setting user message. */
export function GoalMessageAnnotation() {
	return (
		<span
			className="inline-flex items-center gap-1 text-muted-foreground/70 text-xs"
			data-testid="goal-message-annotation"
			title="This message was sent as a goal"
		>
			<HugeiconsIcon
				aria-hidden="true"
				className="size-3.5"
				icon={Target01Icon}
			/>
			<span>Sent as goal</span>
		</span>
	);
}

type MessagePart = UIMessage["parts"][number];

function isTextPart(part: MessagePart): part is { type: "text"; text: string } {
	return (
		part.type === "text" &&
		typeof (part as { text?: unknown }).text === "string"
	);
}

/**
 * Sender attribution for a user bubble, carried on the AI SDK message's
 * `metadata`. Set by the chat surface when it live-inserts a message authored by
 * another human (multi-user collaboration). Absent on the local user's own
 * optimistic messages, so only OTHER people get a name label.
 */
interface MessageAuthor {
	/** Avatar URL for the user. */
	avatar?: string;
	/** Stable Core user id (`author_user_id`). */
	id?: string;
	/** Display name (Core's `author_name`), falling back to the user id/email. */
	name?: string;
}

/**
 * A per-message stamp is CLOCK TIME, with the full date in its tooltip — the
 * messaging shape, now that the DATE is carried by the day separators above
 * each run (date-separator.tsx) instead of being repeated on every row.
 *
 * Both go through `@ryu/ui/lib/timezone.ts`, so they follow Appearance →
 * "Date & time" like every other timestamp in the product. They replaced the
 * last two zone-naive formatters in the transcript: a hand-rolled "5m ago"
 * relative age and a hardcoded `en-GB` full stamp, neither of which could
 * follow the setting.
 *
 * Exported so the assistant header in message-list.tsx renders the identical
 * pair; two rows of the same turn showing different clock formats is exactly
 * the drift a shared constant prevents. (The import goes this way — message-list
 * already imports `UserMessage` from here, so the reverse would be a cycle.)
 */
export const MESSAGE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
	hour: "numeric",
	minute: "2-digit",
};

export const MESSAGE_TOOLTIP_OPTIONS: Intl.DateTimeFormatOptions = {
	dateStyle: "medium",
	timeStyle: "short",
};

function getAuthor(message: UIMessage): MessageAuthor | null {
	const metadata = (message as { metadata?: { author?: MessageAuthor } })
		.metadata;
	const author = metadata?.author;
	if (!author) {
		return null;
	}
	const label = author.name || author.id;
	if (!label) {
		return null;
	}
	return author;
}

/**
 * Inline editor shown in place of a user bubble while editing. Enter saves
 * (Shift+Enter inserts a newline), Escape cancels. Mirrors the composer's
 * right-aligned bubble styling so the edit feels in-place.
 */
function UserMessageEditor({
	initialText,
	onSubmit,
	onCancel,
}: {
	initialText: string;
	onSubmit?: (text: string) => void;
	onCancel?: () => void;
}) {
	const [value, setValue] = useState(initialText);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		const el = textareaRef.current;
		if (el) {
			el.focus();
			// Place the caret at the end and grow to fit the content.
			el.setSelectionRange(el.value.length, el.value.length);
			el.style.height = "auto";
			el.style.height = `${el.scrollHeight}px`;
		}
	}, []);

	const submit = () => {
		const trimmed = value.trim();
		if (trimmed) {
			onSubmit?.(trimmed);
		}
	};

	// No width cap of its own: the field fills the bubble column, which already
	// carries the message's max width. The old `max-w-[calc(95%-40px)]` was a
	// second, different basis, so the editor was visibly wider than the bubble it
	// replaced.
	return (
		<div className="flex w-full flex-col items-end gap-2">
			<div
				className="w-full rounded-2xl bg-muted px-3.5 py-2"
				data-slot="user-message-editor"
			>
				<textarea
					className="w-full resize-none bg-transparent text-foreground text-sm leading-5 outline-none"
					onChange={(event) => {
						setValue(event.target.value);
						event.target.style.height = "auto";
						event.target.style.height = `${event.target.scrollHeight}px`;
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							submit();
						} else if (event.key === "Escape") {
							event.preventDefault();
							onCancel?.();
						}
					}}
					ref={textareaRef}
					rows={1}
					value={value}
				/>
			</div>
			<div className="flex items-center gap-2">
				<Button
					className="h-7 rounded-full px-3 text-xs"
					onClick={onCancel}
					size="sm"
					type="button"
					variant="ghost"
				>
					Cancel
				</Button>
				<Button
					className="h-7 rounded-full px-3 text-xs"
					disabled={!value.trim()}
					onClick={submit}
					size="sm"
					type="button"
				>
					Send
				</Button>
			</div>
		</div>
	);
}

export const UserMessage = memo(function UserMessage({
	actions,
	message,
	className,
	currentUser,
	enableImagePreview = true,
	editing = false,
	groupPosition = "single",
	onEditSubmit,
	onEditCancel,
	onOpenFile,
	onOpenLink,
	onOpenMention,
	mentionItems,
	previewResolvers,
}: UserMessageProps) {
	const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
	const lightboxOriginRef = useRef<HTMLElement | null>(null);
	const textParts = message.parts?.filter(isTextPart) ?? [];
	const text = textParts.map((p) => p.text).join("");

	// A message sent with a quote carries it as a leading markdown blockquote;
	// peel it back off so it renders as a styled QuoteBlock, not raw `> …` text.
	const { quote, body } = splitLeadingQuote(text);
	const attachments = getMessageAttachments(message);
	const imageAttachments = attachments.filter(
		(attachment) => attachment.isImage && attachment.url
	);
	const lightboxImages = imageAttachments.map((attachment) => ({
		filename: attachment.filename,
		id: attachment.id,
		url: attachment.url ?? "",
	}));

	// `editing` keeps an otherwise-empty message mounted: a turn that is only
	// attachments still has an editor to show, and returning null here would
	// unmount it mid-edit.
	if (!(text || attachments.length > 0 || editing)) {
		return null;
	}

	const remoteAuthor = getAuthor(message);
	const widgetAttribution = getWidgetMessageAttribution(message);
	const isOwnMessage = !remoteAuthor;
	const author = isOwnMessage ? (currentUser ?? null) : remoteAuthor;
	const createdAt = (message as { createdAt?: Date | string }).createdAt;
	const timestamp = createdAt ? new Date(createdAt) : null;

	const TimestampNode = timestamp ? (
		<TooltipProvider delay={0}>
			<Tooltip>
				<TooltipTrigger
					className="text-muted-foreground/70 text-xs"
					data-slot="message-timestamp"
				>
					{formatTime(timestamp, MESSAGE_TIME_OPTIONS)}
				</TooltipTrigger>
				<TooltipContent>
					<p>{formatDateTime(timestamp, MESSAGE_TOOLTIP_OPTIONS)}</p>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	) : null;

	const MessageBubble = (
		<>
			{attachments.length > 0 && (
				<div
					className={cn(
						"flex max-w-full flex-wrap items-end gap-2",
						isOwnMessage ? "justify-end" : "justify-start"
					)}
					data-slot="message-attachments"
				>
					{attachments.map((attachment) => {
						if (attachment.isImage && attachment.url) {
							const imageIndex = imageAttachments.findIndex(
								(image) => image.id === attachment.id
							);
							return (
								<button
									aria-label={`Open ${attachment.filename}`}
									className={cn(
										"group/message-image relative size-[104px] shrink-0 overflow-hidden rounded-xl bg-muted/50 p-1 outline-none transition-[filter,transform] hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring",
										enableImagePreview && "cursor-zoom-in"
									)}
									data-testid="message-image-attachment"
									key={attachment.id}
									onClick={
										enableImagePreview
											? (event) => {
													lightboxOriginRef.current = event.currentTarget;
													setLightboxIndex(imageIndex);
												}
											: undefined
									}
									type="button"
								>
									<img
										alt={attachment.filename}
										className="block size-full rounded-[10px] object-cover"
										src={attachment.url}
									/>
								</button>
							);
						}

						return (
							<FileAttachment
								filename={attachment.filename}
								id={attachment.id}
								key={attachment.id}
								size={attachment.size}
								url={attachment.url}
							/>
						);
					})}
				</div>
			)}
			{enableImagePreview && lightboxImages.length > 0 && (
				<ImageLightbox
					images={lightboxImages}
					initialIndex={lightboxIndex ?? 0}
					onClose={() => setLightboxIndex(null)}
					open={lightboxIndex !== null}
					originRef={lightboxOriginRef}
				/>
			)}
			{text && (
				// `Bubble` + `BubbleContent` (@ryu/ui/components/bubble), overridden
				// back to the shipped geometry: the primitive defaults to
				// `max-w-[80%] rounded-3xl py-2.5`, and all three of those are wrong
				// here. The width cap belongs to the COLUMN below (`max-w-[90%]`), not
				// to the bubble — that is what makes the bubble, its attachments and
				// its hover toolbar agree on one left edge — so the bubble itself is
				// uncapped.
				//
				// The fill is not set here: it comes from the variant's
				// `*:data-[slot=bubble-content]:bg-*` selector, which is why
				// `data-slot` must stay the primitive's own and the e2e hook is a
				// `data-testid` instead.
				//
				// `default` = the theme's primary. The agent side took over the neutral
				// `muted` fill this bubble used to carry, so the user's own turn is the
				// one thing in the transcript painted in the brand colour — which is
				// what makes it findable when scrolling back through a long thread.
				// `text-foreground` is dropped for the same reason: the variant pairs
				// `bg-primary` with `text-primary-foreground`, and forcing the plain
				// foreground on top of it would leave dark text on a saturated fill.
				<Bubble
					align={isOwnMessage ? "end" : "start"}
					className="max-w-full"
					variant="default"
				>
					<BubbleContent
						className={cn(
							messageBubbleRadius(
								isOwnMessage ? "end" : "start",
								groupPosition
							),
							"px-3.5 py-1.5 text-sm leading-5 transition-colors"
						)}
						data-testid="user-message-bubble"
					>
						{quote && <QuoteBlock text={quote} />}
						{body && (
							<CollapsibleText
								collapsedMaxHeightClass="max-h-[120px]"
								contentClassName="wrap-break-word whitespace-pre-wrap leading-5"
								contentKey={body}
								fadeToClass="to-primary"
							>
								<div {...messageSelectableProps}>
									<Markdown
										className="[&_a]:text-primary-foreground [&_button]:text-primary-foreground [&_p]:text-primary-foreground"
										content={body}
										mentionItems={mentionItems}
										onOpenFile={onOpenFile}
										onOpenLink={onOpenLink}
										onOpenMention={onOpenMention}
										previewResolvers={previewResolvers}
										tone="primary"
										wideBlocks
									/>
								</div>
							</CollapsibleText>
						)}
					</BubbleContent>
				</Bubble>
			)}
		</>
	);

	// Editing swaps the BODY only. Everything around it — avatar, timestamp, the
	// column's width — is shared with the read-only bubble, so entering edit mode
	// no longer makes the message jump or lose its chrome.
	const BodyNode = editing ? (
		<UserMessageEditor
			initialText={text}
			onCancel={onEditCancel}
			onSubmit={onEditSubmit}
		/>
	) : (
		MessageBubble
	);

	const AvatarNode = author ? (
		<Avatar className="size-8 shrink-0 rounded-full">
			<AvatarImage src={author.avatar} />
			<AvatarFallback className="overflow-hidden rounded-full bg-transparent p-0">
				<DitherAvatar
					className="size-full"
					name={ditherAvatarSeed({ id: author.id, name: author.name })}
				/>
			</AvatarFallback>
		</Avatar>
	) : null;

	// Messaging grouping: one avatar per RUN, on the row that closes it. The
	// gutter on every OTHER row stays occupied — `Message` is `flex gap-2` and
	// `MessageAvatar` is the only thing holding the 32px column open, so REMOVING
	// it collapses the gutter and slides the bubble sideways. `chat-message-align`
	// asserts the row's left edge against the composer to 1px, which is exactly
	// the regression that would catch. `invisible` keeps the box, drops the paint.
	const showAvatar = groupPosition === "single" || groupPosition === "last";
	const AvatarSlot = AvatarNode ? (
		<MessageAvatar
			aria-hidden={showAvatar ? undefined : "true"}
			// `self-start`, not the primitive's `self-end`: a turn can be metres
			// tall (code blocks, tool cards), and a bottom-anchored avatar ends up
			// far below the message it belongs to. Matches the assistant side.
			className={cn(
				"size-8 self-start bg-transparent",
				showAvatar ? null : "invisible"
			)}
		>
			{AvatarNode}
		</MessageAvatar>
	) : null;

	// A remote sender is named once per run, on the row that OPENS it.
	const showName =
		!isOwnMessage &&
		Boolean(author?.name) &&
		(groupPosition === "single" || groupPosition === "first");
	const showWidgetAttribution =
		Boolean(widgetAttribution) &&
		(groupPosition === "single" || groupPosition === "first");
	// The name is on the OPENING row and the time is on the CLOSING row. The time
	// sits below the message body, which keeps the attachment strip and the text
	// easy to scan while matching the usual messaging-app reading order.
	const showTimestamp =
		Boolean(TimestampNode) &&
		(groupPosition === "single" || groupPosition === "last");
	// Gated as a whole — an empty `MessageHeader` still renders a 16px gapped row.
	const HeaderNode =
		showName || showWidgetAttribution ? (
			<MessageHeader className="h-4 gap-2 px-0">
				{showName && <span>{author?.name}</span>}
				{showWidgetAttribution && widgetAttribution ? (
					<span
						className="text-muted-foreground"
						data-testid="widget-message-attribution"
						title={`Widget instance ${widgetAttribution.widget_instance_id}`}
					>
						Widget · {widgetAttribution.origin_server}
					</span>
				) : null}
			</MessageHeader>
		) : null;

	// One shrink-to-fit column holding the body. The width cap stays here rather
	// than on the bubble so the action row can sit beside a short bubble without
	// changing the bubble's own edge.
	const BubbleColumn = (
		<div
			className={cn(
				"flex w-fit min-w-0 max-w-[90%] flex-col gap-1",
				isOwnMessage ? "items-end" : "items-start",
				// A textarea has no content width to shrink to, so while editing the
				// column takes the whole row and the 90% cap does the framing — which
				// is the width the bubble had.
				editing && "w-full"
			)}
		>
			{BodyNode}
		</div>
	);
	const MessageRow = (
		<div
			className={cn(
				"flex w-fit max-w-full items-center gap-2",
				isOwnMessage ? "flex-row-reverse" : "flex-row"
			)}
		>
			{BubbleColumn}
			{actions ? <div className="shrink-0">{actions}</div> : null}
		</div>
	);

	// `Message` (@ryu/ui/components/message) is a `flex w-full gap-2` row that
	// flips to `flex-row-reverse` at `align="end"` — so the avatar is written
	// FIRST in the DOM either way and lands on the right for one's own messages.
	// `items-start` overrides the primitive's default stretch, which is what the
	// hand-rolled row carried before this port.
	//
	// The header (name) and footer (clock) sit inside `MessageContent`, not above
	// the whole row, so they align to the bubble column rather than to the
	// transcript's edge. `items-end`/`items-start` on Content is what keeps `BubbleColumn`
	// shrink-to-fit: the percentage cap then resolves against the row's known
	// width, not against a parent the editor's textarea would get to decide.
	return (
		<Message
			align={isOwnMessage ? "end" : "start"}
			className={cn("items-start", className)}
		>
			{AvatarSlot}
			<MessageContent
				className={cn("gap-1", isOwnMessage ? "items-end" : "items-start")}
			>
				{HeaderNode}
				{MessageRow}
				{showTimestamp ? (
					<MessageFooter className="h-4 gap-2 px-0">
						{TimestampNode}
					</MessageFooter>
				) : null}
			</MessageContent>
		</Message>
	);
});
