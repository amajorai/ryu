import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowLeft, Bookmark, MessageCircle, Pin, Share } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, type Ref, useId } from "react";
import type { PostActions } from "./community-feed.tsx";
import {
	absoluteTime,
	type Community,
	type CommunityPost,
	communityLabel,
	displayScore,
	posterLabel,
	redditAge,
	shortCount,
} from "./community-model.ts";
import {
	ACTION_PILL,
	CommunityIcon,
	MetaDot,
	MetaLink,
	PostFlair,
	VotePill,
} from "./community-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

export interface PostPageProps {
	actions: PostActions;
	/** The rail beside the post: the community's About card. */
	aside: ReactNode;
	/** The community a brand-new thread is going into, before the host lists it. */
	fallbackCommunity: Community | null;
	now: number;
	onBack: () => void;
	/** Null while the host has not listed the thread yet (a new post). */
	post: CommunityPost | null;
	ref?: Ref<HTMLElement>;
	threadView: ReactNode;
}

/**
 * A post's own page, as Reddit lays it out: a back button beside the
 * community and poster, the title, flair and action row, then the comments,
 * which are the host's real conversation.
 */
export function PostPage({
	actions,
	aside,
	fallbackCommunity,
	now,
	onBack,
	post,
	ref,
	threadView,
}: PostPageProps) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const headingId = useId();
	const community = post?.community ?? fallbackCommunity;
	const thread = post?.thread;
	const saved = thread ? actions.saved.has(thread.id) : false;
	const copied = thread ? actions.copiedId === thread.id : false;
	return (
		<motion.section
			animate={{ opacity: 1 }}
			aria-labelledby={headingId}
			className="flex min-h-0 min-w-0 flex-1 outline-none"
			data-testid="community-post-page"
			initial={reduceMotion ? false : { opacity: 0 }}
			ref={ref}
			tabIndex={-1}
			transition={{ duration: 0.14, ease: "easeOut" }}
		>
			<div className="mx-auto flex min-h-0 w-full max-w-[1120px] gap-4 @[640px]/community:px-6 px-4">
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<header className="flex shrink-0 flex-col gap-2 pt-4 pb-3">
						<div className="flex items-center gap-2">
							<button
								aria-label="Back"
								className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground outline-none transition-colors duration-100 hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_8%)] focus-visible:ring-2 focus-visible:ring-ring/50"
								onClick={onBack}
								type="button"
							>
								<ArrowLeft
									aria-hidden="true"
									className="size-4"
									strokeWidth={2}
								/>
							</button>
							{community ? (
								<CommunityIcon community={community} size={32} />
							) : null}
							<div className="flex min-w-0 flex-col">
								<div className="flex min-w-0 items-center gap-1.5 text-xs leading-4">
									{community ? (
										<MetaLink
											className="font-semibold text-foreground"
											label={tl("Open {community}", {
												community: communityLabel(community),
											})}
											onClick={() => actions.onSelectCommunity(community)}
										>
											{communityLabel(community)}
										</MetaLink>
									) : null}
									{thread ? (
										<>
											<MetaDot />
											<time
												className="shrink-0 text-muted-foreground"
												dateTime={thread.updatedAt}
												title={absoluteTime(thread.updatedAt)}
											>
												{redditAge(thread.updatedAt, now)}
											</time>
											{thread.pinned ? (
												<span className="flex items-center text-status-success">
													<Pin
														aria-hidden="true"
														className="size-3.5"
														strokeWidth={2}
													/>
													<span className="sr-only">Pinned</span>
												</span>
											) : null}
										</>
									) : null}
								</div>
								{post && post.community.kind !== "profile" ? (
									<MetaLink
										className="self-start text-muted-foreground text-xs leading-4"
										label={tl("Open {poster}", {
											poster: posterLabel(post.poster),
										})}
										onClick={() => actions.onSelectPoster(post)}
									>
										{posterLabel(post.poster)}
									</MetaLink>
								) : null}
							</div>
						</div>
						<h1
							className="mt-1 font-bold! text-2xl text-foreground leading-8 tracking-tight"
							id={headingId}
						>
							{thread?.title ?? "New post"}
						</h1>
						{post ? (
							<div className="flex">
								<PostFlair post={post} />
							</div>
						) : null}
						{post && thread ? (
							<div className="flex flex-wrap items-center gap-2 pt-2">
								<VotePill
									onVote={(vote) => actions.onVote(thread.id, vote)}
									score={displayScore(post, actions.votes[thread.id])}
									title={thread.title}
									vote={actions.votes[thread.id]}
								/>
								<span className={cn(ACTION_PILL, "pointer-events-none")}>
									<MessageCircle aria-hidden="true" strokeWidth={1.75} />
									{shortCount(post.comments)}
									<span className="sr-only">comments</span>
								</span>
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
						) : null}
					</header>
					<div
						aria-label="Comments"
						className="flex min-h-0 flex-1 flex-col overflow-hidden border-border border-t"
						data-testid="community-thread-view"
						role="region"
					>
						{threadView}
					</div>
				</div>
				<aside
					aria-label="About this community"
					className="@[1100px]/community:block hidden w-[316px] shrink-0 overflow-y-auto py-4"
				>
					{aside}
				</aside>
			</div>
		</motion.section>
	);
}
