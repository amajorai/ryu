import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronRight, Ellipsis, MessageCircle, Pin, Send } from "lucide-react";
import type { ReactNode } from "react";
import { compactAge } from "./interface-renderer.ts";
import { StreamAvatar, StreamFacepile } from "./stream-avatar.tsx";
import {
	replyLabel,
	type StreamPost,
	type StreamStatusLine,
	statusLine,
} from "./stream-model.ts";
import { STREAM_FOCUS } from "./stream-rail.tsx";

/** Body copy: the reference's single 15px reading size. */
export const STREAM_TEXT = "text-[15px] leading-[21px]";
/** Opaque menus: the shared surface is translucent, which the feed shows through. */
export const STREAM_MENU =
	"border-border bg-popover shadow-lg backdrop-blur-none";
const ICON_BUTTON = cn(
	"flex size-9 items-center justify-center rounded-full text-foreground transition-colors duration-150 hover:bg-muted active:bg-muted/70",
	STREAM_FOCUS
);

export interface StreamPostActions {
	onNewThread: (agentId: string) => void;
	onOpen: (threadId: string) => void;
	onProfile: (agentId: string) => void;
}

function fullDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime())
		? ""
		: date.toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			});
}

/** The status phrase, colored only when it asks something of the user. */
export function StreamStatus({ line }: { line: StreamStatusLine }) {
	const dot = line.tone === "live" || line.tone === "strong";
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5",
				line.tone === "attention" && "text-destructive",
				line.tone === "strong" && "font-semibold text-foreground",
				line.tone === "live" && "text-foreground"
			)}
		>
			{dot ? (
				<span
					aria-hidden="true"
					className={cn(
						"size-1.5 shrink-0 rounded-full",
						line.tone === "live"
							? "bg-success motion-safe:animate-pulse"
							: "bg-foreground"
					)}
				/>
			) : null}
			{line.text}
		</span>
	);
}

/** The parts of the line beside the facepile: who is in it and where it stands. */
function metaParts(
	post: StreamPost,
	withReplies: boolean
): { key: string; node: ReactNode }[] {
	const status = statusLine(post);
	const parts: { key: string; node: ReactNode }[] = [];
	if (withReplies && post.replyCount > 0) {
		parts.push({ key: "replies", node: replyLabel(post.replyCount) });
	}
	if (post.participants.length > 1) {
		parts.push({ key: "agents", node: `${post.participants.length} agents` });
	}
	if (status) {
		parts.push({ key: "status", node: <StreamStatus line={status} /> });
	}
	return parts;
}

/** "3 agents · Forge is replying" beside the facepile. */
function MetaLine({
	className,
	parts,
}: {
	className?: string;
	parts: { key: string; node: ReactNode }[];
}) {
	if (parts.length === 0) {
		return null;
	}
	return (
		<p
			className={cn(
				"flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground",
				className ?? STREAM_TEXT
			)}
		>
			{parts.map((part, index) => (
				<span className="inline-flex items-center gap-1.5" key={part.key}>
					{index > 0 ? <span aria-hidden="true">·</span> : null}
					{part.node}
				</span>
			))}
		</p>
	);
}

function PostMenu({
	actions,
	page,
	post,
}: {
	actions: StreamPostActions;
	page: boolean;
	post: StreamPost;
}) {
	const tl = useLiteralMessages();
	const author = post.author;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={tl("More options for {title}", { title: post.title })}
				className={cn(
					ICON_BUTTON,
					"-my-1.5 -mr-2 size-8 text-muted-foreground hover:text-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
				)}
			>
				<Ellipsis aria-hidden="true" className="size-5" />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className={cn("w-56", STREAM_MENU)}
				drawerLabel={post.title}
			>
				{page ? null : (
					<DropdownMenuItem onClick={() => actions.onOpen(post.threadId)}>
						Open thread
					</DropdownMenuItem>
				)}
				{author ? (
					<>
						<DropdownMenuItem onClick={() => actions.onProfile(author.id)}>
							{tl("View {name}’s profile", { name: author.name })}
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => actions.onNewThread(author.id)}>
							{tl("New thread with {name}", { name: author.name })}
						</DropdownMenuItem>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Name, topic and age on one line, with the overflow menu at the far edge. */
function PostHeader({
	actions,
	page,
	post,
}: {
	actions: StreamPostActions;
	page: boolean;
	post: StreamPost;
}) {
	const author = post.author;
	return (
		<div className={cn("flex min-w-0 items-center gap-1.5", STREAM_TEXT)}>
			{author ? (
				<button
					className={cn(
						"min-w-0 shrink truncate rounded-sm font-semibold text-foreground hover:underline",
						STREAM_FOCUS
					)}
					onClick={() => actions.onProfile(author.id)}
					type="button"
				>
					{author.name}
				</button>
			) : (
				<span className="shrink-0 font-semibold text-foreground">You</span>
			)}
			{post.topic ? (
				<span className="flex min-w-0 items-center gap-1 text-foreground">
					<ChevronRight
						aria-hidden="true"
						className="size-3.5 shrink-0 text-muted-foreground"
						strokeWidth={2}
					/>
					<span className="sr-only">in</span>
					<span className="truncate">{post.topic}</span>
				</span>
			) : null}
			<time
				className="shrink-0 text-muted-foreground"
				dateTime={post.updatedAt}
				title={fullDate(post.updatedAt)}
			>
				{compactAge(post.updatedAt)}
			</time>
			<span className="ml-auto flex shrink-0 items-center">
				<PostMenu actions={actions} page={page} post={post} />
			</span>
		</div>
	);
}

/** The title, then the newest message, the way a post reads top to bottom. */
function PostBody({ page, post }: { page: boolean; post: StreamPost }) {
	return (
		<>
			<span className={cn("block font-semibold text-foreground", STREAM_TEXT)}>
				{post.title}
			</span>
			{post.body ? (
				<span
					className={cn(
						"mt-0.5 block text-foreground/90",
						STREAM_TEXT,
						page ? "line-clamp-6" : "line-clamp-4"
					)}
				>
					{post.bodyRole === "user" ? (
						<span className="text-muted-foreground">You: </span>
					) : null}
					{post.body}
				</span>
			) : null}
		</>
	);
}

function ActionRow({
	actions,
	onReply,
	post,
}: {
	actions: StreamPostActions;
	onReply: () => void;
	post: StreamPost;
}) {
	const tl = useLiteralMessages();
	const author = post.author;
	const replies = post.replyCount;
	return (
		<div className="-ml-2 flex items-center gap-1">
			<button
				aria-label={
					replies > 0
						? tl(
								"Reply to {title}, {replyCount, plural, one {1 reply} other {{replyCountText} replies}}",
								{
									replyCount: replies,
									replyCountText: String(replies),
									title: post.title,
								}
							)
						: tl("Reply to {title}", { title: post.title })
				}
				className={cn(ICON_BUTTON, "w-auto min-w-9 gap-1 px-2")}
				onClick={onReply}
				type="button"
			>
				<MessageCircle
					aria-hidden="true"
					className="size-5"
					strokeWidth={1.75}
				/>
				{replies > 0 ? (
					<span className="text-[13px] text-muted-foreground tabular-nums leading-5">
						{replies}
					</span>
				) : null}
			</button>
			{author ? (
				<button
					aria-label={tl("Message {name}", { name: author.name })}
					className={ICON_BUTTON}
					onClick={() => actions.onNewThread(author.id)}
					type="button"
				>
					<Send aria-hidden="true" className="size-5" strokeWidth={1.75} />
				</button>
			) : null}
		</div>
	);
}

/** The author's avatar; a pointer shortcut to the profile the name also opens. */
function PostAvatar({
	actions,
	post,
}: {
	actions: StreamPostActions;
	post: StreamPost;
}) {
	const tl = useLiteralMessages();
	const author = post.author;
	if (!author) {
		return <StreamAvatar agent={undefined} name="You" size={36} />;
	}
	return (
		<button
			aria-label={tl("View {name}’s profile", { name: author.name })}
			className={cn("shrink-0 rounded-full", STREAM_FOCUS)}
			onClick={() => actions.onProfile(author.id)}
			tabIndex={-1}
			type="button"
		>
			<StreamAvatar agent={author} name={author.name} size={36} />
		</button>
	);
}

/**
 * The opened post at the top of the post page: the byline on one row, the
 * title and message across the full width, the date and where the
 * conversation stands, then the actions. Reply hands focus to the host's own
 * composer below.
 */
function PagePost({
	actions,
	onReply,
	post,
}: {
	actions: StreamPostActions;
	onReply: () => void;
	post: StreamPost;
}) {
	const authorName = post.author?.name ?? "You";
	const parts = metaParts(post, false);
	const date = fullDate(post.updatedAt);
	return (
		<article
			aria-label={`${authorName}: ${post.title}`}
			className="px-6 pt-4 pb-2"
			data-thread-id={post.threadId}
		>
			<div className="flex items-center gap-3">
				<PostAvatar actions={actions} post={post} />
				<div className="min-w-0 flex-1">
					<PostHeader actions={actions} page post={post} />
				</div>
			</div>
			<div className="mt-3">
				<PostBody page post={post} />
			</div>
			<div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground leading-5">
				{date ? <time dateTime={post.updatedAt}>{date}</time> : null}
				{parts.length > 0 ? (
					<>
						{date ? <span aria-hidden="true">·</span> : null}
						<MetaLine className="text-[13px] leading-5" parts={parts} />
					</>
				) : null}
			</div>
			<div className="mt-2">
				<ActionRow actions={actions} onReply={onReply} post={post} />
			</div>
		</article>
	);
}

/**
 * One conversation as a post: the lead agent's avatar with the signature
 * thread line running down to the reply facepile, the title and newest message
 * as the body, then the actions with the reply count. In `page` mode it heads
 * the post page instead (see `PagePost`).
 */
export function StreamPostItem({
	actions,
	onReply,
	page = false,
	post,
}: {
	actions: StreamPostActions;
	/** Page mode: where Reply sends the user (the host's composer). */
	onReply?: () => void;
	page?: boolean;
	post: StreamPost;
}) {
	const open = () => actions.onOpen(post.threadId);
	if (page) {
		return <PagePost actions={actions} onReply={onReply ?? open} post={post} />;
	}
	const authorName = post.author?.name ?? "You";
	const parts = metaParts(post, false);
	// The line runs down to the faces only when there is something to say
	// beside them; a lone agent's count already sits in the action row.
	const threaded = post.replyCount > 0 && parts.length > 0;
	return (
		<article
			aria-label={`${authorName}: ${post.title}`}
			className="border-border border-b px-6 pt-3 pb-2"
			data-thread-id={post.threadId}
		>
			{post.pinned ? (
				<p className="mb-1 flex items-center gap-1.5 pl-12 font-medium text-[13px] text-muted-foreground leading-5">
					<Pin aria-hidden="true" className="size-3.5" strokeWidth={2} />
					Pinned
				</p>
			) : null}
			<div className="flex gap-3">
				<div className="flex w-9 shrink-0 flex-col items-center">
					<PostAvatar actions={actions} post={post} />
					{threaded ? (
						<>
							<span
								aria-hidden="true"
								className="my-1.5 w-0.5 flex-1 rounded-full bg-border"
							/>
							<StreamFacepile agents={post.faces} />
						</>
					) : null}
				</div>
				<div className="min-w-0 flex-1">
					<PostHeader actions={actions} page={false} post={post} />
					<button
						className={cn(
							"mt-0.5 block w-full rounded-md text-left",
							STREAM_FOCUS
						)}
						onClick={open}
						type="button"
					>
						<PostBody page={false} post={post} />
					</button>
					<div className="mt-1.5">
						<ActionRow actions={actions} onReply={open} post={post} />
					</div>
					{threaded ? (
						<div className="flex h-9 items-center">
							<MetaLine parts={parts} />
						</div>
					) : (
						<MetaLine className={cn("pb-1", STREAM_TEXT)} parts={parts} />
					)}
				</div>
			</div>
		</article>
	);
}
