import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { Bookmark, MessageCircle, Pin, Share } from "lucide-react";
import { motion } from "motion/react";
import { useId } from "react";
import {
	absoluteTime,
	type Community,
	type CommunityPost,
	type CommunityViewMode,
	type CommunityVote,
	communityLabel,
	displayScore,
	posterLabel,
	redditAge,
	shortCount,
} from "./community-model.ts";
import {
	ACTION_PILL,
	CommunityIcon,
	CommunityLink,
	MetaDot,
	MetaLink,
	PostFlair,
	VoteColumn,
	VotePill,
} from "./community-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

export interface PostActions {
	copiedId: string | null;
	onOpen: (threadId: string) => void;
	onSave: (threadId: string) => void;
	onSelectCommunity: (community: Community) => void;
	onSelectPoster: (post: CommunityPost) => void;
	onShare: (post: CommunityPost) => void;
	onVote: (threadId: string, vote: CommunityVote) => void;
	saved: ReadonlySet<string>;
	votes: Readonly<Record<string, CommunityVote>>;
}

export interface PostItemProps {
	actions: PostActions;
	/** Hide the community link inside its own community's feed. */
	inCommunity: boolean;
	now: number;
	post: CommunityPost;
	registerRow: (threadId: string, element: HTMLButtonElement | null) => void;
}

function Age({ iso, now }: { iso: string; now: number }) {
	return (
		<time
			className="shrink-0 text-muted-foreground"
			dateTime={iso}
			title={absoluteTime(iso)}
		>
			{redditAge(iso, now)}
		</time>
	);
}

function PinnedMark() {
	return (
		<span className="flex shrink-0 items-center text-status-success">
			<Pin aria-hidden="true" className="size-3.5" strokeWidth={2} />
			<span className="sr-only">Pinned</span>
		</span>
	);
}

/**
 * The meta row over a post. On Home it leads with the community; inside a
 * community it leads with the poster, the way Reddit does.
 */
function PostMeta({
	actions,
	inCommunity,
	now,
	post,
}: {
	actions: PostActions;
	inCommunity: boolean;
	now: number;
	post: CommunityPost;
}) {
	const tl = useLiteralMessages();
	const poster = (
		<MetaLink
			className={cn(inCommunity ? "font-semibold text-foreground" : "")}
			label={tl("Open {0}", { 0: posterLabel(post.poster) })}
			onClick={() => actions.onSelectPoster(post)}
		>
			{posterLabel(post.poster)}
		</MetaLink>
	);
	// A post on the user's profile is by the user, so the poster would repeat it.
	const onProfile = post.community.kind === "profile";
	return (
		<div className="flex h-6 min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
			{inCommunity ? (
				<span className="flex min-w-0 items-center gap-2">
					<CommunityIcon community={post.community} size={24} />
					{poster}
				</span>
			) : (
				<>
					<CommunityLink
						community={post.community}
						onSelect={actions.onSelectCommunity}
					/>
					{onProfile ? null : (
						<>
							<MetaDot />
							{poster}
						</>
					)}
				</>
			)}
			<MetaDot />
			<Age iso={post.thread.updatedAt} now={now} />
			{post.thread.pinned ? <PinnedMark /> : null}
		</div>
	);
}

/** Comment, share, and save pills after the vote pill. */
function PostActionRow({
	actions,
	post,
}: {
	actions: PostActions;
	post: CommunityPost;
}) {
	const tl = useLiteralMessages();
	const { thread } = post;
	const saved = actions.saved.has(thread.id);
	const copied = actions.copiedId === thread.id;
	return (
		<div className="flex flex-wrap items-center gap-2">
			<VotePill
				onVote={(vote) => actions.onVote(thread.id, vote)}
				score={displayScore(post, actions.votes[thread.id])}
				title={thread.title}
				vote={actions.votes[thread.id]}
			/>
			<button
				aria-label={tl("{comments} comments on “{title}”", {
					comments: String(post.comments),
					title: thread.title,
				})}
				className={ACTION_PILL}
				onClick={() => actions.onOpen(thread.id)}
				type="button"
			>
				<MessageCircle aria-hidden="true" strokeWidth={1.75} />
				{shortCount(post.comments)}
			</button>
			<button
				aria-label={
					copied
						? "Title copied"
						: tl("Share “{title}”", { title: thread.title })
				}
				className={ACTION_PILL}
				onClick={() => actions.onShare(post)}
				type="button"
			>
				<Share aria-hidden="true" strokeWidth={1.75} />
				<span aria-live="polite">{copied ? "Copied" : "Share"}</span>
			</button>
			<button
				aria-label={
					saved
						? tl("Unsave “{title}”", { title: thread.title })
						: tl("Save “{title}”", { title: thread.title })
				}
				aria-pressed={saved}
				className={cn(ACTION_PILL, saved && "text-primary")}
				onClick={() => actions.onSave(thread.id)}
				type="button"
			>
				<Bookmark
					aria-hidden="true"
					fill={saved ? "currentColor" : "none"}
					strokeWidth={1.75}
				/>
				{saved ? "Saved" : "Save"}
			</button>
		</div>
	);
}

const TITLE_LINK =
	"rounded-sm text-left outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * Reddit's card view: meta row, title, flair, a short preview of the newest
 * message, then the action row. The whole card opens the post; the inner
 * links and buttons sit above that hit area.
 */
export function PostCard({
	actions,
	inCommunity,
	now,
	post,
	registerRow,
}: PostItemProps) {
	const { excerpt, thread } = post;
	const titleId = useId();
	return (
		<article
			aria-labelledby={titleId}
			className="relative flex flex-col gap-1 rounded-2xl px-4 py-2 transition-colors duration-100 has-[[data-row-link]:hover]:bg-muted/60"
			data-status={post.status}
			data-thread-id={thread.id}
		>
			<PostMeta
				actions={actions}
				inCommunity={inCommunity}
				now={now}
				post={post}
			/>
			<h2
				className="font-semibold! text-foreground text-lg leading-6"
				id={titleId}
			>
				<button
					className={TITLE_LINK}
					data-row-link=""
					onClick={() => actions.onOpen(thread.id)}
					ref={(element) => registerRow(thread.id, element)}
					type="button"
				>
					{thread.title}
				</button>
			</h2>
			<div className="flex">
				<PostFlair post={post} />
			</div>
			{excerpt ? (
				<p className="line-clamp-3 text-foreground/80 text-sm leading-5">
					{excerpt}
				</p>
			) : null}
			<div className="pt-2 pb-1">
				<PostActionRow actions={actions} post={post} />
			</div>
		</article>
	);
}

/**
 * Reddit's compact view: a vote column, a small community thumbnail, the
 * title with its flair, and one meta line with text actions.
 */
export function PostRow({
	actions,
	inCommunity,
	now,
	post,
	registerRow,
}: PostItemProps) {
	const tl = useLiteralMessages();
	const { thread } = post;
	const titleId = useId();
	const saved = actions.saved.has(thread.id);
	const copied = actions.copiedId === thread.id;
	const textAction =
		"relative z-10 flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-semibold outline-none transition-colors duration-100 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3.5";
	return (
		<article
			aria-labelledby={titleId}
			className="relative flex items-start gap-2 rounded-xl py-2 pr-3 transition-colors duration-100 has-[[data-row-link]:hover]:bg-muted/60"
			data-status={post.status}
			data-thread-id={thread.id}
		>
			<VoteColumn
				onVote={(vote) => actions.onVote(thread.id, vote)}
				score={displayScore(post, actions.votes[thread.id])}
				title={thread.title}
				vote={actions.votes[thread.id]}
			/>
			<CommunityIcon
				className="mt-1 @[560px]/community:flex hidden"
				community={post.community}
				size={40}
			/>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					<h2
						className="min-w-0 font-semibold! text-foreground text-sm leading-5"
						id={titleId}
					>
						<button
							className={cn(TITLE_LINK, "after:rounded-xl")}
							data-row-link=""
							onClick={() => actions.onOpen(thread.id)}
							ref={(element) => registerRow(thread.id, element)}
							type="button"
						>
							{thread.title}
						</button>
					</h2>
					<PostFlair post={post} />
				</div>
				<div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
					{inCommunity ? null : (
						<MetaLink
							className="font-semibold text-foreground"
							label={tl("Open {0}", { 0: communityLabel(post.community) })}
							onClick={() => actions.onSelectCommunity(post.community)}
						>
							{communityLabel(post.community)}
						</MetaLink>
					)}
					{inCommunity || post.community.kind !== "profile" ? (
						<>
							{inCommunity ? null : <MetaDot />}
							<MetaLink
								label={tl("Open {0}", { 0: posterLabel(post.poster) })}
								onClick={() => actions.onSelectPoster(post)}
							>
								{posterLabel(post.poster)}
							</MetaLink>
						</>
					) : null}
					<MetaDot />
					<Age iso={thread.updatedAt} now={now} />
					{thread.pinned ? <PinnedMark /> : null}
					<span className="ml-1 flex items-center gap-0.5">
						<button
							aria-label={tl("{comments} comments on “{title}”", {
								comments: String(post.comments),
								title: thread.title,
							})}
							className={textAction}
							onClick={() => actions.onOpen(thread.id)}
							type="button"
						>
							<MessageCircle aria-hidden="true" strokeWidth={2} />
							{shortCount(post.comments)}
						</button>
						<button
							aria-label={
								copied
									? "Title copied"
									: tl("Share “{title}”", { title: thread.title })
							}
							className={textAction}
							onClick={() => actions.onShare(post)}
							type="button"
						>
							<span aria-live="polite">{copied ? "Copied" : "Share"}</span>
						</button>
						<button
							aria-label={
								saved
									? tl("Unsave “{title}”", { title: thread.title })
									: tl("Save “{title}”", { title: thread.title })
							}
							aria-pressed={saved}
							className={cn(textAction, saved && "text-primary")}
							onClick={() => actions.onSave(thread.id)}
							type="button"
						>
							{saved ? "Saved" : "Save"}
						</button>
					</span>
				</div>
			</div>
		</article>
	);
}

export interface FeedListProps {
	actions: PostActions;
	inCommunity: boolean;
	mode: CommunityViewMode;
	now: number;
	posts: readonly CommunityPost[];
	registerRow: (threadId: string, element: HTMLButtonElement | null) => void;
	/** Changes with the scope or sort, so the list fades in fresh. */
	viewKey: string;
}

/** Posts separated by hairlines, the way Reddit's feed reads. */
export function FeedList({
	actions,
	inCommunity,
	mode,
	now,
	posts,
	registerRow,
	viewKey,
}: FeedListProps) {
	const reduceMotion = useReducedMotion();
	const Item = mode === "compact" ? PostRow : PostCard;
	return (
		<motion.div
			animate={{ opacity: 1 }}
			className="flex flex-col"
			data-mode={mode}
			data-testid="community-feed"
			initial={reduceMotion ? false : { opacity: 0 }}
			key={viewKey}
			transition={{ duration: 0.14, ease: "easeOut" }}
		>
			{posts.map((post, index) => (
				<div className="flex flex-col" key={post.thread.id}>
					{index > 0 ? (
						<hr
							className={cn(
								"border-border",
								mode === "card" ? "mx-4 my-1" : "mx-3"
							)}
						/>
					) : null}
					<Item
						actions={actions}
						inCommunity={inCommunity}
						now={now}
						post={post}
						registerRow={registerRow}
					/>
				</div>
			))}
		</motion.div>
	);
}

export { SortBar, type SortBarProps } from "./community-feed-sort-bar.tsx";
