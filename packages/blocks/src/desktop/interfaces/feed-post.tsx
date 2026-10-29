import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { FeedPost, InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import {
	Copy,
	Ellipsis,
	ExternalLink,
	Mail,
	MessageCircle,
	Pin,
	Users,
} from "lucide-react";
import type { Ref } from "react";
import {
	type FeedStatusMarker,
	feedPostStatus,
	feedStatusMarker,
	feedThreadOf,
} from "./feed-model.ts";
import {
	AuthorName,
	compactCount,
	FEED_FOCUS_INSET,
	FEED_META,
	type FeedAuthor,
	FeedAvatar,
	feedAuthor,
	fullTimestamp,
	LiveDot,
	lastSpeaker,
	sameAuthor,
} from "./feed-parts.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";

/**
 * Status words read as part of the meta line: muted like the age beside
 * them, except a failed run, the one state that takes the destructive tone.
 * A running thread says "Live" with its dot instead.
 */
function markerTone(marker: FeedStatusMarker): string {
	return marker.status === "attention" ? "text-destructive" : FEED_META;
}

/** "Atlas @atlas · 18m • Live": name, handle, age and run state on one line. */
function PostHeader({
	author,
	marker,
	running = false,
	updatedAt,
}: {
	author: FeedAuthor;
	marker: FeedStatusMarker | null;
	running?: boolean;
	updatedAt?: string;
}) {
	return (
		<div className="flex min-w-0 items-center gap-1 text-[15px] leading-5">
			<AuthorName author={author} />
			<span className={cn("truncate", FEED_META)}>{author.handle}</span>
			{updatedAt ? (
				<>
					<span aria-hidden="true" className={cn("shrink-0", FEED_META)}>
						·
					</span>
					<time
						className={cn("shrink-0", FEED_META)}
						dateTime={updatedAt}
						title={fullTimestamp(updatedAt)}
					>
						{compactAge(updatedAt)}
					</time>
				</>
			) : null}
			{running ? (
				// The live dot stands in for the middot, so the line never
				// reads "1m · • Live" with two separators in a row.
				<span className="flex shrink-0 items-center gap-1 text-foreground">
					<span className="flex w-2.5 justify-center">
						<LiveDot size="sm" />
					</span>
					Live
				</span>
			) : null}
			{!running && marker ? (
				<>
					<span aria-hidden="true" className={cn("shrink-0", FEED_META)}>
						·
					</span>
					<span className={cn("shrink-0", markerTone(marker))}>
						{marker.short}
					</span>
				</>
			) : null}
		</div>
	);
}

/**
 * Someone else's newest message (the user's, or another agent's), framed
 * like a quoted post. It is plain content: a click falls through to the
 * row's own button, so the post keeps a single hit target.
 */
function QuoteCard({
	excerpt,
	speaker,
	updatedAt,
}: {
	excerpt: string;
	speaker: FeedAuthor;
	updatedAt: string;
}) {
	return (
		<div className="mt-3 overflow-hidden rounded-2xl border border-border p-3 text-foreground">
			<span className="flex min-w-0 items-center gap-1 text-[15px] leading-5">
				<FeedAvatar author={speaker} size="xs" />
				<span className="ml-0.5 flex min-w-0 items-center gap-1">
					<AuthorName author={speaker} />
					<span className={cn("truncate", FEED_META)}>{speaker.handle}</span>
					<span aria-hidden="true" className={cn("shrink-0", FEED_META)}>
						·
					</span>
					<span className={cn("shrink-0", FEED_META)}>
						{compactAge(updatedAt)}
					</span>
				</span>
			</span>
			<p className="mt-1 line-clamp-3 break-words text-[15px] text-foreground leading-5">
				{excerpt}
			</p>
		</div>
	);
}

const ACTION =
	"group/action pointer-events-auto relative z-10 -my-1.5 flex items-center rounded-full text-[13px] outline-none transition-colors hover:text-primary focus-visible:text-primary data-popup-open:text-primary";
/**
 * The circular halo carries hover and keyboard focus, as the nav rail does:
 * a primary tint plus a hairline ring drawn inside the 34px circle, so the
 * ring never reaches the count beside it.
 */
const ACTION_HALO =
	"-m-2 flex size-[34px] items-center justify-center rounded-full transition-colors group-hover/action:bg-primary/10 group-focus-visible/action:bg-primary/10 group-focus-visible/action:ring-1 group-focus-visible/action:ring-primary/40 group-focus-visible/action:ring-inset group-data-popup-open/action:bg-primary/10";
const STAT = "flex items-center text-[13px]";

/** X's top-right "More" button on every post: Open post and Copy text. */
function PostMoreMenu({ onOpen, text }: { onOpen: () => void; text: string }) {
	const copyText = () => {
		navigator.clipboard?.writeText(text).catch(() => {
			// Clipboard access can be refused (no focus, no permission); the
			// menu simply closes and the post stays as it was.
		});
	};
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label="More"
				className={cn(ACTION, FEED_META, "shrink-0")}
			>
				<span className={ACTION_HALO}>
					<Ellipsis aria-hidden="true" className="size-[18px]" />
				</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-48">
				<DropdownMenuItem onClick={onOpen}>
					<ExternalLink aria-hidden="true" />
					Open post
				</DropdownMenuItem>
				<DropdownMenuItem onClick={copyText}>
					<Copy aria-hidden="true" />
					Copy text
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function replyNoun(count: number): string {
	if (count === 0) {
		return "no replies";
	}
	return count === 1 ? "reply" : "replies";
}

/** A count beside its icon, hidden at zero the way the timeline does. */
function StatCount({ value }: { value: number }) {
	return value > 0 ? (
		<span aria-hidden="true" className="tabular-nums">
			{compactCount(value)}
		</span>
	) : null;
}

/**
 * The row under a post, spread across the column the way X spreads its
 * actions: reply (the whole row opens the post too), the agents in the
 * thread, and a direct message to the author on the far end.
 */
function ActionBar({
	agentCount,
	authorName,
	onMessage,
	onOpen,
	post,
}: {
	agentCount: number;
	authorName: string | null;
	onMessage: (() => void) | null;
	onOpen: () => void;
	post: FeedPost;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="mt-3 flex h-5 max-w-[425px] items-center justify-between">
			<button
				className={cn(ACTION, FEED_META, "w-fit")}
				onClick={onOpen}
				type="button"
			>
				<span className={ACTION_HALO}>
					<MessageCircle aria-hidden="true" className="size-[18px]" />
				</span>
				<span className="sr-only">Reply, </span>
				{/* The count reads with its noun; at zero only the icon shows. */}
				<span className="min-w-8 pl-3 tabular-nums">
					{post.replyCount > 0 ? compactCount(post.replyCount) : null}
					<span className="sr-only"> {replyNoun(post.replyCount)}</span>
				</span>
			</button>
			<span className={cn(STAT, "w-fit", FEED_META)}>
				<span className="-m-2 flex size-[34px] items-center justify-center">
					<Users aria-hidden="true" className="size-[18px]" />
				</span>
				<span className="min-w-8 pl-3">
					{/* A lone agent is the default; the count appears once others join. */}
					<StatCount value={agentCount > 1 ? agentCount : 0} />
				</span>
				<span className="sr-only">
					{tl(
						"{agentCount, plural, one {# agent in this thread} other {# agents in this thread}}",
						{ agentCount }
					)}
				</span>
			</span>
			{onMessage && authorName ? (
				<button
					aria-label={tl("Message {authorName}", { authorName })}
					className={cn(ACTION, FEED_META, "w-fit")}
					onClick={onMessage}
					type="button"
				>
					<span className={ACTION_HALO}>
						<Mail aria-hidden="true" className="size-[18px]" />
					</span>
				</button>
			) : (
				<span aria-hidden="true" className="w-[18px]" />
			)}
		</div>
	);
}

/**
 * X's social-context line above a pinned post: a 16px pin right-aligned to
 * the avatar gutter, then "Pinned" on the author column's left edge.
 */
function PinnedContext() {
	return (
		<div
			className={cn(
				"pointer-events-none flex h-5 items-center gap-3 pb-1 font-semibold text-[13px] leading-4",
				FEED_META
			)}
		>
			<span className="flex w-10 translate-y-px justify-end">
				<Pin aria-hidden="true" className="size-4" strokeWidth={2.25} />
			</span>
			Pinned
		</div>
	);
}

/** One timeline post: the thread's title, its newest message, its activity. */
export function FeedPostRow({
	active,
	buttonRef,
	onMessage,
	onOpen,
	post,
	snapshot,
}: {
	active: boolean;
	buttonRef: Ref<HTMLButtonElement>;
	/** Starts a new thread with an agent: the post's author. */
	onMessage: (agentId: string) => void;
	onOpen: () => void;
	post: FeedPost;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const author = feedAuthor(agentById(snapshot, post.authorAgentId));
	const authorId = author.agent?.id;
	const thread = feedThreadOf(snapshot, post.threadId);
	const marker = feedStatusMarker(feedPostStatus(snapshot, post), thread);
	const title = post.title || "Untitled";
	const speaker = lastSpeaker(snapshot, thread);
	const hasLatest = Boolean(post.excerpt) && post.excerpt !== post.title.trim();
	// One post per thread, as X's timeline shows it: the author's own newest
	// message continues the post body; anyone else's is quoted beneath it.
	const continues = hasLatest && sameAuthor(author, speaker);
	const quoted = hasLatest && !continues;
	return (
		<article
			aria-label={`${author.name}: ${title}`}
			className={cn(
				"group relative flex cursor-pointer flex-col border-border border-b px-4 pt-3 pb-3 transition-colors hover:bg-muted/50",
				active && "bg-muted/70"
			)}
		>
			{/* The whole row opens the post; actions sit above this layer. */}
			<button
				aria-current={active ? "true" : undefined}
				aria-label={tl("Open post by {name}: {title}", {
					name: author.name,
					title,
				})}
				className={cn("absolute inset-0 z-0 cursor-pointer", FEED_FOCUS_INSET)}
				data-feed-post={post.threadId}
				onClick={onOpen}
				ref={buttonRef}
				type="button"
			/>
			{post.pinned ? <PinnedContext /> : null}
			<div className="pointer-events-none flex gap-3">
				<div className="w-10 shrink-0">
					<FeedAvatar author={author} working={post.running} />
				</div>
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex items-center gap-2">
						<div className="min-w-0 flex-1">
							<PostHeader
								author={author}
								marker={marker}
								running={post.running}
								updatedAt={post.updatedAt}
							/>
						</div>
						<PostMoreMenu
							onOpen={onOpen}
							text={post.excerpt ? `${title}\n\n${post.excerpt}` : title}
						/>
					</div>
					{/* One bold run per post, as on X: the name. The title is the body. */}
					<p className="mt-0.5 line-clamp-2 whitespace-pre-line break-words text-[15px] text-foreground leading-5">
						{title}
					</p>
					{continues ? (
						<p className="mt-0.5 line-clamp-4 break-words text-[15px] text-foreground leading-5">
							{post.excerpt}
						</p>
					) : null}
					{quoted ? (
						<QuoteCard
							excerpt={post.excerpt}
							speaker={speaker}
							updatedAt={post.updatedAt}
						/>
					) : null}
					<ActionBar
						agentCount={thread?.agentIds.length ?? 0}
						authorName={authorId ? author.name : null}
						onMessage={authorId ? () => onMessage(authorId) : null}
						onOpen={onOpen}
						post={post}
					/>
				</div>
			</div>
		</article>
	);
}

/** The focused post at the top of the post page: its title is the hero. */
export function FocusedPost({
	post,
	snapshot,
}: {
	post: FeedPost;
	snapshot: InterfaceSnapshot;
}) {
	const author = feedAuthor(agentById(snapshot, post.authorAgentId));
	const thread = feedThreadOf(snapshot, post.threadId);
	const marker = feedStatusMarker(feedPostStatus(snapshot, post), thread);
	const agentCount = thread?.agentIds.length ?? 0;
	const title = post.title || "Untitled";
	// No excerpt here: the host's thread view right below opens with the
	// prompt and the newest reply, so the post page shows each line once.
	return (
		<article
			aria-label={`${author.name}: ${title}`}
			className="shrink-0 px-4 pt-3"
		>
			{post.pinned ? <PinnedContext /> : null}
			<div className="flex items-center gap-3">
				<FeedAvatar author={author} working={post.running} />
				<div className="flex min-w-0 flex-col text-[15px] leading-5">
					<AuthorName author={author} />
					<span className={cn("truncate", FEED_META)}>{author.handle}</span>
				</div>
			</div>
			<p className="mt-3 whitespace-pre-line break-words text-[17px] text-foreground leading-6">
				{title}
			</p>
			<p
				className={cn(
					"flex flex-wrap items-center gap-x-1 py-4 text-[15px] leading-5",
					FEED_META
				)}
			>
				<time dateTime={post.updatedAt}>{fullTimestamp(post.updatedAt)}</time>
				{post.running ? (
					<>
						<span aria-hidden="true">·</span>
						<span className="flex items-center gap-1 text-foreground">
							<span className="flex w-2.5 justify-center">
								<LiveDot pulse size="sm" />
							</span>
							Live now
						</span>
					</>
				) : null}
				{!post.running && marker ? (
					<>
						<span aria-hidden="true">·</span>
						<span className={markerTone(marker)}>{marker.long}</span>
					</>
				) : null}
			</p>
			<div
				className={cn(
					"flex flex-wrap items-center gap-x-5 gap-y-1 border-border border-y py-4 text-[15px] leading-5",
					FEED_META
				)}
			>
				<span>
					<span className="font-semibold text-foreground tabular-nums">
						{compactCount(post.replyCount)}
					</span>{" "}
					{post.replyCount === 1 ? "Reply" : "Replies"}
				</span>
				{agentCount > 1 ? (
					<span>
						<span className="font-semibold text-foreground tabular-nums">
							{agentCount}
						</span>{" "}
						Agents
					</span>
				) : null}
			</div>
		</article>
	);
}
