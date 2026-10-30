import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Logo } from "@ryu/ui/components/logo.tsx";
import { Tabs, TabsContent } from "@ryu/ui/components/tabs.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { type FeedParams, projectFeed } from "@ryuhq/protocol/interfaces";
import { ArrowLeft } from "lucide-react";
import { motion } from "motion/react";
import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { FeedComposer } from "./feed-composer.tsx";
import { FeedAside } from "./feed-interface-aside.tsx";
import {
	FeedEmpty,
	type HomeTab,
	HomeTabs,
	isHomeTab,
	matchesQuery,
	onTimelineKeyDown,
	postsForView,
	StickyHeader,
	VIEW_TITLES,
	ViewTitle,
} from "./feed-interface-chrome.tsx";
import { FeedMobileNav } from "./feed-mobile-nav.tsx";
import { feedPostStatus } from "./feed-model.ts";
import { FeedNavRail, type FeedView } from "./feed-nav.tsx";
import {
	FEED_FOCUS,
	FEED_META,
	FEED_SCROLLBAR,
	FeedAvatar,
	FeedTints,
	YOU,
} from "./feed-parts.tsx";
import { FeedPostRow, FocusedPost } from "./feed-post.tsx";
import {
	AgentRow,
	AgentsCard,
	FeedSearch,
	sortAgents,
	WhatsHappening,
} from "./feed-sidebar.tsx";
import { FeedSkeleton } from "./feed-skeleton.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * Social-timeline interface: every thread is a post, newest activity first,
 * and opening a post shows its conversation as the reply chain — laid out
 * as a three-column timeline (navigation rail, timeline, sidebar).
 */
export function FeedInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<FeedParams>) {
	const tl = useLiteralMessages();
	const posts = useMemo(
		() => projectFeed(snapshot, params),
		[snapshot, params]
	);
	const [view, setView] = useState<FeedView>("home");
	const [homeTab, setHomeTab] = useState<HomeTab>("for-you");
	const [query, setQuery] = useState("");
	const [composerFocusRequest, setComposerFocusRequest] = useState(0);
	const detailOpen = threadView !== null;
	const activePost = posts.find((post) => post.threadId === activeThreadId);
	const needle = query.trim().toLowerCase();
	const statuses = useMemo(
		() =>
			new Map(
				posts.map((post) => [post.threadId, feedPostStatus(snapshot, post)])
			),
		[posts, snapshot]
	);
	const visiblePosts = useMemo(() => {
		if (view === "search" && !needle) {
			return [];
		}
		const scoped = postsForView(posts, view, homeTab, statuses);
		return needle
			? scoped.filter((post) => matchesQuery(post, needle))
			: scoped;
	}, [posts, view, homeTab, needle, statuses]);
	const visibleAgents = useMemo(() => {
		const sorted = sortAgents(snapshot.agents);
		return needle
			? sorted.filter((agent) =>
					`${agent.name} ${agent.description}`.toLowerCase().includes(needle)
				)
			: sorted;
	}, [snapshot.agents, needle]);
	const workingCount = posts.filter((post) => post.running).length;
	// One restrained crossfade between the timeline and the post page; none
	// at all when the system asks for reduced motion.
	const reduceMotion = useReducedMotion();
	const pageFade = {
		duration: reduceMotion ? 0 : 0.16,
		ease: "easeOut",
	} as const;
	const [detailScrolled, setDetailScrolled] = useState(false);

	const timelineRef = useRef<HTMLElement>(null);
	const timelineScroll = useRef(0);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const backRef = useRef<HTMLButtonElement>(null);
	const postButtons = useRef(new Map<string, HTMLButtonElement>());
	const lastOpenedThreadId = useRef<string | null>(null);
	useEffect(() => {
		if (activeThreadId) {
			lastOpenedThreadId.current = activeThreadId;
		}
	}, [activeThreadId]);

	// The post page replaces the timeline in the center column. Keep keyboard
	// and screen-reader users in place: opening moves focus to the back
	// button; going back restores the timeline's scroll and refocuses the post.
	const wasOpen = useRef(detailOpen);
	useLayoutEffect(() => {
		if (detailOpen === wasOpen.current) {
			return;
		}
		wasOpen.current = detailOpen;
		setDetailScrolled(false);
		if (detailOpen) {
			backRef.current?.focus();
			return;
		}
		if (timelineRef.current) {
			timelineRef.current.scrollTop = timelineScroll.current;
		}
		const threadId = lastOpenedThreadId.current;
		const button = threadId ? postButtons.current.get(threadId) : undefined;
		button?.focus({ preventScroll: true });
	}, [detailOpen]);

	// "Post" in the rail jumps to the composer once Home is showing.
	useEffect(() => {
		if (composerFocusRequest > 0 && !detailOpen) {
			composerRef.current?.focus();
		}
	}, [composerFocusRequest, detailOpen]);

	// Search (offered only while the sidebar is hidden) starts in its field.
	useEffect(() => {
		if (view === "search" && !detailOpen) {
			searchRef.current?.focus();
		}
	}, [view, detailOpen]);

	const selectView = (next: FeedView) => {
		setView(next);
		if (detailOpen) {
			port.closeThread();
		}
		timelineScroll.current = 0;
		if (timelineRef.current) {
			timelineRef.current.scrollTop = 0;
		}
	};
	const focusComposer = () => {
		if (view !== "home") {
			selectView("home");
		} else if (detailOpen) {
			port.closeThread();
		}
		setComposerFocusRequest((count) => count + 1);
	};
	const messageAgent = (agentId: string) => port.startThread({ agentId });

	let emptyState: ReactNode = null;
	if (view === "search" && !needle) {
		emptyState = (
			<div className="flex flex-col gap-4 px-4 py-3">
				<WhatsHappening
					onOpen={(threadId) => port.openThread(threadId)}
					posts={posts}
					snapshot={snapshot}
				/>
				<AgentsCard
					agents={snapshot.agents}
					onMessage={messageAgent}
					onShowAll={() => selectView("agents")}
				/>
			</div>
		);
	} else if (view === "agents") {
		emptyState =
			visibleAgents.length === 0 ? (
				<FeedEmpty
					body={
						needle
							? "Try searching for something else."
							: "Create an agent and it shows up here, ready to message."
					}
					title={
						needle
							? tl("No results for “{query}”", { query: query.trim() })
							: "No agents yet"
					}
				/>
			) : null;
	} else if (visiblePosts.length === 0) {
		if (loading) {
			emptyState = <FeedSkeleton />;
		} else if (needle) {
			emptyState = (
				<FeedEmpty
					body="Try searching for something else, or clear the search."
					title={tl("No results for “{query}”", { query: query.trim() })}
				/>
			);
		} else if (posts.length === 0) {
			emptyState = (
				<FeedEmpty
					action={{ label: "Write your first post", onClick: focusComposer }}
					body="Post a task above. Each conversation with your agents shows up here as a post."
					title="Nothing here yet"
				/>
			);
		} else if (view === "pinned") {
			emptyState = (
				<FeedEmpty
					body="Pinned conversations stay at the top of your timeline and show up here."
					title="Nothing pinned yet"
				/>
			);
		} else if (view === "home") {
			emptyState = (
				<FeedEmpty
					body="Failed runs and replies waiting for you show up here."
					title="You’re all caught up"
				/>
			);
		} else {
			emptyState = (
				<FeedEmpty
					body="When an agent starts a run, its post shows up here while it works."
					title="Nobody’s working right now"
				/>
			);
		}
	}

	const timelineBody = (
		<>
			{view === "agents" ? (
				<ul aria-label="Agents">
					{visibleAgents.map((agent) => (
						<AgentRow
							agent={agent}
							bio
							key={agent.id}
							onMessage={() => messageAgent(agent.id)}
							tone="timeline"
						/>
					))}
				</ul>
			) : (
				// biome-ignore lint/a11y/noNoninteractiveElementInteractions: j/k only moves focus between the post buttons inside this list.
				<ol aria-busy={loading} onKeyDown={onTimelineKeyDown}>
					{visiblePosts.map((post) => (
						<li key={post.threadId}>
							<FeedPostRow
								active={post.threadId === activeThreadId}
								buttonRef={(node) => {
									if (node) {
										postButtons.current.set(post.threadId, node);
									} else {
										postButtons.current.delete(post.threadId);
									}
								}}
								onMessage={messageAgent}
								onOpen={() => port.openThread(post.threadId)}
								post={post}
								snapshot={snapshot}
							/>
						</li>
					))}
				</ol>
			)}
			{emptyState}
		</>
	);

	return (
		<FeedTints agents={snapshot.agents}>
			<div
				className={cn(
					"@container relative size-full min-h-0 overflow-hidden bg-background text-foreground antialiased"
				)}
				data-testid="interface-feed"
			>
				<div className="flex h-full justify-center">
					<FeedNavRail
						onPost={focusComposer}
						onSelect={selectView}
						view={view}
						workingCount={workingCount}
					/>
					<main className="relative flex h-full w-full min-w-0 max-w-[600px] flex-col border-border @min-[600px]:border-x @max-[700px]:pb-[53px]">
						<motion.section
							animate={{ opacity: detailOpen ? 0 : 1 }}
							aria-label="Feed"
							className={cn(
								"h-full overflow-y-auto overscroll-contain",
								FEED_SCROLLBAR,
								detailOpen && "hidden"
							)}
							onScroll={(event) => {
								timelineScroll.current = event.currentTarget.scrollTop;
							}}
							ref={timelineRef}
							transition={pageFade}
						>
							<Tabs
								className="block"
								onValueChange={(next) => {
									if (isHomeTab(next)) {
										setHomeTab(next);
									}
								}}
								value={homeTab}
							>
								<StickyHeader bordered={view !== "search"}>
									{view === "home" ? (
										<>
											{/* Phone-width masthead: who you are, and whose timeline. */}
											<div
												aria-hidden="true"
												className="relative @max-[700px]:flex hidden h-[53px] items-center justify-center px-4"
											>
												<span className="absolute left-4">
													<FeedAvatar author={YOU} size="sm" />
												</span>
												<Logo size="28px" tone="foreground" variant="outline" />
											</div>
											<HomeTabs />
										</>
									) : null}
									{view === "search" ? (
										<div className="px-4 py-1.5">
											<FeedSearch
												inputRef={searchRef}
												onChange={setQuery}
												query={query}
											/>
										</div>
									) : null}
									{view !== "home" && view !== "search" ? (
										<ViewTitle title={VIEW_TITLES[view]} />
									) : null}
								</StickyHeader>
								{view === "home" ? (
									<FeedComposer
										agents={snapshot.agents}
										onPost={({ agentId, prompt }) =>
											port.startThread({ agentId, prompt })
										}
										textareaRef={composerRef}
									/>
								) : null}
								{needle && view !== "search" ? (
									<div
										className={cn(
											"flex items-center justify-between gap-3 border-border border-b px-4 py-3 text-[15px] leading-5",
											FEED_META
										)}
									>
										<p className="min-w-0 truncate">
											Results for{" "}
											<span className="font-semibold text-foreground">
												“{query.trim()}”
											</span>
										</p>
										<Button
											className="h-auto shrink-0 px-1 text-[15px]"
											onClick={() => setQuery("")}
											type="button"
											variant="link"
										>
											Clear
										</Button>
									</div>
								) : null}
								{view === "home" ? (
									<TabsContent
										className="pb-16 text-[length:inherit]"
										tabIndex={-1}
										value={homeTab}
									>
										{timelineBody}
									</TabsContent>
								) : (
									<div className="pb-16">{timelineBody}</div>
								)}
							</Tabs>
						</motion.section>
						{detailOpen ? (
							<motion.section
								animate={{ opacity: 1 }}
								aria-label="Post and replies"
								className={cn(
									"h-full overflow-y-auto overscroll-contain",
									FEED_SCROLLBAR
								)}
								initial={reduceMotion ? false : { opacity: 0 }}
								onScroll={(event) => {
									setDetailScrolled(event.currentTarget.scrollTop > 0);
								}}
								transition={pageFade}
							>
								{/* The hairline appears once the post scrolls under it, as on X. */}
								<StickyHeader bordered={detailScrolled}>
									<div className="flex h-[53px] items-center gap-6 px-4">
										<button
											aria-label="Back to feed"
											className={cn(
												"-ml-2 flex size-9 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted",
												FEED_FOCUS
											)}
											onClick={port.closeThread}
											ref={backRef}
											type="button"
										>
											<ArrowLeft
												aria-hidden="true"
												className="size-5"
												strokeWidth={2.25}
											/>
										</button>
										<h2 className="font-heading font-semibold! text-foreground text-xl leading-6">
											Post
										</h2>
									</div>
								</StickyHeader>
								{activePost ? (
									<FocusedPost post={activePost} snapshot={snapshot} />
								) : null}
								{/*
								 * The host's own chat surface, in the user's theme as-is. It
								 * manages its own scrolling and reply box, so it gets the
								 * column's height below the sticky header: the column scrolls
								 * the focused post away first, then the replies take over.
								 */}
								<div className="h-[calc(100%-53px)] min-h-[320px]">
									{threadView}
								</div>
							</motion.section>
						) : null}
					</main>
					<FeedAside
						messageAgent={messageAgent}
						port={port}
						posts={posts}
						query={query}
						selectView={selectView}
						setQuery={setQuery}
						snapshot={snapshot}
						view={view}
					/>
				</div>
				<FeedMobileNav
					onPost={focusComposer}
					onSelect={selectView}
					showPostButton={!detailOpen}
					view={view}
					workingCount={workingCount}
				/>
			</div>
		</FeedTints>
	);
}
