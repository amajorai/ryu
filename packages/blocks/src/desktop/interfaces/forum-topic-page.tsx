import { cn } from "@ryu/ui/lib/utils";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useRef } from "react";
import { FORUM_WRAP } from "./forum-header.tsx";
import { type ForumTopic, fullDate, plural } from "./forum-model.ts";
import {
	CategoryBadge,
	ForumAvatar,
	TEXT_BUTTON,
	TopicStatusNote,
} from "./forum-parts.tsx";
import {
	CompactTimeline,
	TopicTimeline,
	useThreadScroll,
} from "./forum-timeline.tsx";
import { compactAge } from "./interface-renderer.ts";

function MapStat({ children, label }: { children: ReactNode; label: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<dt className="order-2 text-muted-foreground text-xs leading-4">
				{label}
			</dt>
			<dd className="order-1 flex h-6 items-center font-medium text-foreground text-sm tabular-nums">
				{children}
			</dd>
		</div>
	);
}

/** The opening post: author, age, the latest message, and the topic map. */
function OpeningPost({ now, topic }: { now: number; topic: ForumTopic }) {
	const { thread } = topic;
	const author = topic.author;
	const users = topic.posters.length;
	return (
		<section
			aria-label="Opening post"
			className="grid shrink-0 grid-cols-[40px_minmax(0,1fr)] gap-x-3 border-border border-t pt-5"
			data-testid="forum-opening-post"
		>
			<ForumAvatar agent={author} size={40} />
			<div className="min-w-0">
				<div className="flex h-5 min-w-0 items-baseline gap-2">
					<span className="truncate font-semibold text-foreground text-sm">
						{author?.name ?? "You"}
					</span>
					{author ? (
						<span className="@min-[560px]:inline hidden truncate text-muted-foreground text-sm">
							{author.description}
						</span>
					) : null}
					<time
						className="ml-auto shrink-0 text-muted-foreground text-sm"
						dateTime={thread.updatedAt}
						title={fullDate(thread.updatedAt)}
					>
						{compactAge(thread.updatedAt, now)}
					</time>
				</div>
				<p className="mt-1.5 line-clamp-4 max-w-[70ch] text-[15px] text-foreground leading-6">
					{thread.lastMessage ?? (
						<span className="text-muted-foreground">No messages yet.</span>
					)}
				</p>
				<dl className="mt-4 flex flex-wrap items-start gap-x-8 gap-y-3 border-border border-t py-3">
					<MapStat label={topic.replies === 1 ? "reply" : "replies"}>
						{topic.replies}
					</MapStat>
					<MapStat label={topic.views === 1 ? "view" : "views"}>
						{topic.views}
					</MapStat>
					<MapStat label={users === 1 ? "user" : "users"}>
						{users > 0 ? (
							<span className="flex items-center gap-2">
								<span>{users}</span>
								<span aria-hidden="true" className="flex gap-1">
									{topic.posters.slice(0, 5).map((agent) => (
										<ForumAvatar agent={agent} key={agent.id} size={20} />
									))}
								</span>
								<span className="sr-only">
									{topic.posters.map((agent) => agent.name).join(", ")}
								</span>
							</span>
						) : (
							0
						)}
					</MapStat>
				</dl>
			</div>
		</section>
	);
}

export interface TopicPageProps {
	/** Name of the list the reader came from, for the breadcrumb. */
	backLabel: string;
	now: number;
	onBack: () => void;
	onSelectCategory: (categoryId: string) => void;
	reduceMotion: boolean;
	threadView: ReactNode;
	/** null while the host shows a new, not yet listed thread. */
	topic: ForumTopic | null;
}

/**
 * A Discourse topic: breadcrumb, title and category, the opening post, then
 * the host's real conversation as the replies, with the timeline gutter on
 * the right that tracks and moves through them.
 */
export function TopicPage({
	backLabel,
	now,
	onBack,
	onSelectCategory,
	reduceMotion,
	threadView,
	topic,
}: TopicPageProps) {
	const titleId = useId();
	const repliesRef = useRef<HTMLDivElement>(null);
	const scroll = useThreadScroll(repliesRef, topic?.thread.id ?? null);
	const total = Math.max(1, topic?.thread.messageCount ?? 1);
	const age = topic ? compactAge(topic.thread.updatedAt, now) : "";
	const lastLabel = age === "now" || !age ? "Latest" : `${age} ago`;

	return (
		<article
			aria-labelledby={titleId}
			className="flex min-h-0 flex-1 flex-col"
			data-testid="forum-topic"
		>
			<div className={cn(FORUM_WRAP, "flex min-h-0 flex-1 gap-10 pt-5")}>
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<header className="shrink-0 pb-5">
						<nav aria-label="Breadcrumb">
							<ol className="flex min-w-0 items-center gap-1.5 text-sm">
								<li>
									<button
										className={cn(
											TEXT_BUTTON,
											"text-muted-foreground hover:text-foreground"
										)}
										onClick={onBack}
										type="button"
									>
										{backLabel}
									</button>
								</li>
								{topic ? (
									<>
										<li aria-hidden="true">
											<ChevronRight
												className="size-3.5 text-muted-foreground/70"
												strokeWidth={2}
											/>
										</li>
										<li className="min-w-0">
											<CategoryBadge
												category={topic.category}
												className="text-sm"
												onSelect={onSelectCategory}
											/>
										</li>
									</>
								) : null}
							</ol>
						</nav>
						<div className="mt-2 flex items-start gap-4">
							<h1
								className="min-w-0 flex-1 text-balance font-medium text-2xl text-foreground leading-8 tracking-tight"
								id={titleId}
							>
								{topic?.thread.title || "New topic"}
							</h1>
							{topic ? (
								<div className="@min-[960px]:hidden pt-0.5">
									<CompactTimeline
										reduceMotion={reduceMotion}
										scroll={scroll}
										total={total}
									/>
								</div>
							) : null}
						</div>
						{topic ? (
							<div className="mt-2 flex min-h-4 flex-wrap items-center gap-x-3 gap-y-1">
								<TopicStatusNote topic={topic} />
								{topic.thread.pinned ? (
									<span className="text-muted-foreground text-xs leading-4">
										Pinned
									</span>
								) : null}
								<span className="text-muted-foreground text-xs leading-4">
									{plural(total, "post", "posts")}
								</span>
							</div>
						) : null}
					</header>
					{topic ? <OpeningPost now={now} topic={topic} /> : null}
					<div
						aria-label="Replies"
						className="flex min-h-0 flex-1 flex-col border-border border-t"
						data-testid="forum-thread-view"
						ref={repliesRef}
						role="region"
					>
						{threadView}
					</div>
				</div>
				{topic ? (
					<aside
						aria-label="Topic timeline"
						className="@min-[960px]:block hidden w-36 shrink-0 pt-[88px]"
					>
						<TopicTimeline
							lastLabel={lastLabel}
							reduceMotion={reduceMotion}
							scroll={scroll}
							total={total}
						/>
					</aside>
				) : null}
			</div>
		</article>
	);
}
