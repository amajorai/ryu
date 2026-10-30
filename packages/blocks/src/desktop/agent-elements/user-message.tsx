import { CallIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Avatar, AvatarFallback, AvatarImage } from "@ryu/ui/components/avatar";
import { Bubble } from "@ryu/ui/components/bubble";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar";
import {
	Message,
	MessageAvatar,
	MessageHeader,
} from "@ryu/ui/components/message";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { formatDateTime, formatTime } from "@ryu/ui/lib/timezone.ts";
import { cn } from "@ryu/ui/lib/utils";
import type { UIMessage } from "ai";
import { memo, useRef, useState } from "react";
import { CollapsibleText } from "./collapsible-text.tsx";
import { ImageLightbox } from "./image-lightbox.tsx";
import { FileAttachment } from "./input/file-attachment.tsx";
import { Markdown } from "./markdown.tsx";
import { getMessageAttachments } from "./message-attachments.ts";
import { getAuthor } from "./message-author.ts";
import { MessageReactionBadge } from "./message-reaction-badge.tsx";
import { MessageReadReceipt } from "./message-read-receipt.tsx";
import { stripQuestionAnswerMarkers } from "./question/async-question.ts";
import {
	messageSelectableProps,
	QuoteBlock,
	splitLeadingQuote,
} from "./quote.tsx";
import { getWidgetMessageAttribution } from "./types.ts";
import styles from "./user-message.module.css";
import { UserMessageEditor } from "./user-message-editor.tsx";
import type { UserMessageProps } from "./user-message-props.ts";
import {
	MESSAGE_TIME_OPTIONS,
	MESSAGE_TOOLTIP_OPTIONS,
} from "./user-message-time-options.ts";
import type { NativeSdkValue } from "./utils/native-sdk-observation.ts";

export { GoalMessageAnnotation } from "./user-message-goal-annotation.tsx";
export type { UserMessageProps } from "./user-message-props.ts";
export {
	MESSAGE_TIME_OPTIONS,
	MESSAGE_TOOLTIP_OPTIONS,
} from "./user-message-time-options.ts";

type MessagePart = UIMessage["parts"][number];

function isTextPart(part: MessagePart): part is { type: "text"; text: string } {
	return part.type === "text" && isNativeText(part.text);
}

/**
 * Sender attribution for a user bubble, carried on the AI SDK message's
 * `metadata`. Set by the chat surface when it live-inserts a message authored by
 * another human (multi-user collaboration). Absent on the local user's own
 * optimistic messages, so only OTHER people get a name label.
 */
interface LegacyTimestampObservation {
	readonly createdAt?: NativeSdkValue;
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
	onAnnotateImage,
	mentionItems,
	messageActionState,
	previewResolvers,
	readReceipt,
}: UserMessageProps) {
	const tl = useLiteralMessages();
	const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
	const lightboxOriginRef = useRef<HTMLElement | null>(null);
	const textParts = message.parts?.filter(isTextPart) ?? [];
	// Async question answers end with a hidden card marker; never show it.
	const text = stripQuestionAnswerMarkers(
		textParts.map((p) => p.text).join("")
	);

	// A message sent with a quote carries it as a leading markdown blockquote;
	// peel it back off so it renders as a styled QuoteBlock, not raw `> …` text.
	const { quote, body } = splitLeadingQuote(text);
	const attachments = getMessageAttachments(message);
	const isCallEnded =
		!quote &&
		attachments.length === 0 &&
		/^Call ended · \d{2,}:[0-5]\d$/.test(body);
	const imageAttachments = attachments.filter(
		(attachment) => attachment.isImage && attachment.url
	);
	const lightboxImages = imageAttachments.map((attachment) => ({
		filename: attachment.filename,
		id: attachment.id,
		url: safeMediaUrl(attachment.url) ?? "",
	}));

	// `editing` keeps an otherwise-empty message mounted: a turn that is only
	// attachments still has an editor to show, and returning null here would
	// unmount it mid-edit.
	if (!(text || attachments.length > 0 || editing)) {
		return null;
	}

	const remoteAuthor = getAuthor(message);
	const widgetAttribution = getWidgetMessageAttribution(message);
	// Core persists the verified author on every human message, including the
	// current user's own messages. Match that id back to the current user before
	// deciding alignment; otherwise a reload would move the user's blue bubble
	// to the remote side and label it as a teammate.
	const isOwnMessage =
		!remoteAuthor ||
		Boolean(currentUser?.id && remoteAuthor.id === currentUser.id);
	const author = isOwnMessage ? (currentUser ?? null) : remoteAuthor;
	// SAFETY: The complete SDK message remains unprojected. This optional legacy
	// member read keeps its raw receiver and promises no Date/string or presence;
	// the value is opaque until the native Date operation below consumes it.
	const createdAt = (message as UIMessage & LegacyTimestampObservation)
		.createdAt;
	// SAFETY: This assertion identifies only the immediate native Date input
	// operation, which owns coercion and rejection. It does not admit the raw
	// timestamp as a decoded date elsewhere or change the original truthy guard.
	const timestamp = createdAt
		? new Date(createdAt as ConstructorParameters<typeof Date>[0])
		: null;

	const TimestampNode = timestamp ? (
		<TooltipProvider delay={0}>
			<Tooltip>
				<TooltipTrigger
					data-slot="message-timestamp"
					render={<button className={styles.timestamp} type="button" />}
				>
					{formatTime(timestamp, MESSAGE_TIME_OPTIONS)}
				</TooltipTrigger>
				<TooltipContent>
					<p>{formatDateTime(timestamp, MESSAGE_TOOLTIP_OPTIONS)}</p>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	) : null;

	const reactionBuckets = messageActionState?.reactionBuckets ?? [];

	const MessageBubble = (
		<>
			{attachments.length > 0 && (
				<div
					className={cn(
						"flex max-w-full flex-wrap items-end gap-2",
						isOwnMessage ? "justify-end" : "justify-start"
					)}
					data-align={isOwnMessage ? "end" : "start"}
					data-slot="message-attachments"
				>
					{attachments.map((attachment) => {
						if (attachment.isImage && attachment.url) {
							const imageIndex = imageAttachments.findIndex(
								(image) => image.id === attachment.id
							);
							return (
								<button
									aria-label={tl("Open {filename}", {
										filename: attachment.filename,
									})}
									className={cn(
										styles.image,
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
										className="block size-full rounded-lg object-cover"
										src={safeMediaUrl(attachment.url) ?? undefined}
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
					onAnnotate={onAnnotateImage}
					onClose={() => setLightboxIndex(null)}
					open={lightboxIndex !== null}
					originRef={lightboxOriginRef}
				/>
			)}
			{text && (
				// `Bubble` + `BubbleContent` (@ryu/ui/components/bubble). The width cap
				// belongs to the ROW below (`max-w-[70%]`), not to the bubble — that
				// is what makes the bubble, its attachments and its hover toolbar agree
				// on one edge — so the bubble itself is uncapped.
				//
				// The fill comes from the `muted` variant's
				// `*:data-[slot=bubble-content]:bg-*` selector, which is why `data-slot`
				// must stay the primitive's own and the e2e hook is a `data-testid`. The
				// user's turn is a quiet neutral surface; the assistant's reply has no
				// bubble at all, so the two sides separate by fill rather than colour.
				<Bubble
					align={isOwnMessage ? "end" : "start"}
					// Room above the bubble for the reaction badge pinned to its corner.
					className={cn("max-w-full", reactionBuckets.length > 0 && "mt-3")}
					variant="muted"
				>
					<MessageReactionBadge
						align={isOwnMessage ? "end" : "start"}
						buckets={reactionBuckets}
					/>
					<div
						className={cn(
							"wrap-break-word text-(length:--text-comfortable) w-fit min-w-0 max-w-full overflow-hidden rounded-3xl border border-transparent px-4 py-2 text-foreground leading-(--text-comfortable--line-height) transition-colors group-data-[align=end]/bubble:self-end"
						)}
						data-chat-prose=""
						data-slot="bubble-content"
						data-testid="user-message-bubble"
					>
						{quote && <QuoteBlock text={quote} />}
						{body && (
							<CollapsibleText
								collapsedMaxHeightClass="max-h-[120px]"
								contentClassName="wrap-break-word whitespace-pre-wrap"
								contentKey={body}
								fadeToClass="to-muted"
							>
								<div
									className={
										isCallEnded
											? "flex items-center gap-2 whitespace-nowrap"
											: undefined
									}
									{...messageSelectableProps}
								>
									{isCallEnded && (
										<HugeiconsIcon
											aria-hidden="true"
											className="size-4 shrink-0 rotate-[135deg]"
											data-testid="call-ended-message-icon"
											icon={CallIcon}
										/>
									)}
									<Markdown
										className={cn(isCallEnded && "[&_p]:whitespace-nowrap")}
										content={body}
										mentionItems={mentionItems}
										onOpenFile={onOpenFile}
										onOpenLink={onOpenLink}
										onOpenMention={onOpenMention}
										previewResolvers={previewResolvers}
										wideBlocks
									/>
								</div>
							</CollapsibleText>
						)}
					</div>
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

	// Your own turn needs no face: it is the right-aligned bubble. Only a remote
	// sender (a teammate in a shared room) carries an avatar.
	const AvatarNode =
		author && !isOwnMessage ? (
			<Avatar className="size-5 shrink-0">
				<AvatarImage src={author.avatar} />
				<AvatarFallback appearance="artwork" className="overflow-hidden">
					<DitherAvatar
						className="size-full"
						name={ditherAvatarSeed({ id: author.id, name: author.name })}
					/>
				</AvatarFallback>
			</Avatar>
		) : null;

	// A remote sender is named once per run, on the row that OPENS it.
	const showName =
		!isOwnMessage &&
		Boolean(author?.name) &&
		(groupPosition === "single" || groupPosition === "first");
	const showWidgetAttribution =
		Boolean(widgetAttribution) &&
		(groupPosition === "single" || groupPosition === "first");
	// Messaging grouping: one avatar per RUN, on the row that closes it. The
	// gutter on every OTHER row stays occupied — `Message` is `flex gap-2` and
	// `MessageAvatar` is the only thing holding the 20px column open, so REMOVING
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
			// The primitive lifts the avatar above a footer and holds a 32px
			// column; the footer here is absolutely placed under the bubble, so
			// neither applies to a 20px avatar.
			className={cn(
				"size-5 min-w-5 self-start group-has-data-[slot=message-footer]/message:translate-y-0",
				// Sit level with the bubble's first line, below the name row when
				// one opens the run.
				showName || showWidgetAttribution ? "mt-8" : "mt-2",
				showAvatar ? null : "invisible"
			)}
			variant="transparent"
		>
			{AvatarNode}
		</MessageAvatar>
	) : null;

	// The name is on the OPENING row and the time is on the CLOSING row. The time
	// and the read receipt sit below the body and appear on hover only (the day
	// separator already dates the run), so a quiet transcript shows content alone.
	const showTimestamp =
		Boolean(TimestampNode) &&
		(groupPosition === "single" || groupPosition === "last");
	const showSentReceipt = isOwnMessage && readReceipt?.delivered === true;
	const showReadReceipt =
		showSentReceipt ||
		Boolean(readReceipt?.readers && readReceipt.readers.length > 0);
	// Gated as a whole — an empty `MessageHeader` still renders a 16px gapped row.
	const HeaderNode =
		showName || showWidgetAttribution ? (
			<MessageHeader className="h-4" inset="none" spacing="relaxed">
				{showName && <span>{author?.name}</span>}
				{showWidgetAttribution && widgetAttribution ? (
					<span
						className="text-muted-foreground"
						data-testid="widget-message-attribution"
						title={tl("Widget instance {widget_instance_id}", {
							widget_instance_id: widgetAttribution.widget_instance_id,
						})}
					>
						{tl("Widget · {origin_server}", {
							origin_server: widgetAttribution.origin_server,
						})}
					</span>
				) : null}
			</MessageHeader>
		) : null;

	// One shrink-to-fit column holding the body, inside a row that carries the
	// 70% cap. The cap lives on the ROW because the row's parent has a definite
	// width; a percentage on the shrink-to-fit column would resolve against its
	// own content and wrap the text early.
	const BubbleColumn = (
		<div
			className={cn(
				"flex w-fit min-w-0 max-w-full flex-col gap-1",
				isOwnMessage ? "items-end" : "items-start",
				// A textarea has no content width to shrink to, so while editing the
				// column takes the whole row and the 70% cap does the framing.
				editing && "w-full"
			)}
		>
			{BodyNode}
		</div>
	);
	const MessageRow = (
		<div
			className={cn(
				"flex w-fit min-w-0 max-w-[70%] items-center gap-2",
				isCallEnded && "max-w-none",
				editing && "w-full",
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
			<div
				className={cn(
					"wrap-break-word relative flex w-full min-w-0 flex-col gap-1 group-data-[align=end]/message:*:data-slot:self-end",
					isOwnMessage ? "items-end" : "items-start"
				)}
				data-slot="message-content"
			>
				{HeaderNode}
				{MessageRow}
				{showTimestamp || showReadReceipt ? (
					// A reserved, absolutely placed slot in the gap under the bubble, so
					// revealing it on hover never reflows the transcript. Its 4px offset
					// is padding, not margin: the slot starts right at the row's edge, so
					// a pointer moving down from the bubble to the read receipt never
					// crosses a gap that ends the hover and hides the slot.
					<div
						className="pointer-events-none absolute inset-x-0 top-full flex h-6 min-w-0 items-center gap-2 pt-1 text-muted-foreground text-xs opacity-0 transition-opacity duration-150 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-hover/message:duration-0 group-data-[align=end]/message:justify-end"
						data-slot="message-footer"
					>
						{showReadReceipt ? (
							<MessageReadReceipt
								delivered={readReceipt?.delivered}
								messageAuthorId={remoteAuthor?.id ?? currentUser?.id}
								readers={readReceipt?.readers ?? []}
								showSent={showSentReceipt}
							/>
						) : null}
						{showTimestamp ? TimestampNode : null}
					</div>
				) : null}
			</div>
		</Message>
	);
});
