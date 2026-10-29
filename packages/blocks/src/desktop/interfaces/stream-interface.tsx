import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { ArrowLeft } from "lucide-react";
import { motion } from "motion/react";
import {
	type ReactNode,
	type Ref,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { StreamComposer } from "./stream-composer.tsx";
import {
	activityCount,
	agentsByActivity,
	defaultComposerAgent,
	feedPosts,
	profileFor,
	projectStreamPosts,
	type StreamActivityFilter,
	type StreamFeed,
	type StreamPost,
	type StreamProfileTab,
	type StreamView,
	threadCounts,
} from "./stream-model.ts";
import {
	onStreamTabKeyDown,
	StreamEmpty,
	StreamSkeleton,
	streamPanelId,
	streamTabId,
} from "./stream-parts.tsx";
import {
	STREAM_TEXT,
	type StreamPostActions,
	StreamPostItem,
} from "./stream-post.tsx";
import { STREAM_FOCUS, StreamRail, StreamTabBar } from "./stream-rail.tsx";
import {
	StreamActivityView,
	StreamProfileView,
	StreamSearchView,
} from "./stream-views.tsx";

const FEEDS: { label: string; value: StreamFeed }[] = [
	{ label: "For you", value: "for-you" },
	{ label: "Working", value: "working" },
];

const TITLES: Record<Exclude<StreamView, "home">, string> = {
	activity: "Activity",
	profile: "Profile",
	search: "Search",
};

type PendingFocus = "composer" | "search" | null;

/** The centred header above the column: feed tabs on Home, else a title. */
function StreamHeader({
	backRef,
	feed,
	feedsId,
	onBack,
	onFeed,
	title,
}: {
	backRef: Ref<HTMLButtonElement>;
	feed: StreamFeed;
	feedsId: string;
	onBack: (() => void) | null;
	onFeed: ((feed: StreamFeed) => void) | null;
	title: string | null;
}) {
	return (
		<header className="grid h-15 shrink-0 grid-cols-[1fr_auto_1fr] items-center @min-[640px]:px-0 px-6">
			<div className="flex">
				{onBack ? (
					<button
						aria-label="Back"
						className={cn(
							"flex size-8 items-center justify-center rounded-full border border-border bg-card text-foreground transition-colors duration-150 hover:bg-muted",
							STREAM_FOCUS
						)}
						onClick={onBack}
						ref={backRef}
						type="button"
					>
						<ArrowLeft aria-hidden="true" className="size-4" strokeWidth={2} />
					</button>
				) : null}
			</div>
			{onFeed ? (
				<div
					aria-label="Feeds"
					className="flex items-center gap-6"
					role="tablist"
				>
					{FEEDS.map((option) => {
						const selected = option.value === feed;
						return (
							<button
								aria-controls={streamPanelId(feedsId)}
								aria-selected={selected}
								className={cn(
									"-mx-1 rounded-md px-1 font-semibold transition-colors duration-150",
									STREAM_TEXT,
									selected
										? "text-foreground"
										: "text-muted-foreground hover:text-foreground",
									STREAM_FOCUS
								)}
								id={streamTabId(feedsId, option.value)}
								key={option.value}
								onClick={() => onFeed(option.value)}
								onKeyDown={(event) =>
									onStreamTabKeyDown(event, feedsId, FEEDS, feed, onFeed)
								}
								role="tab"
								tabIndex={selected ? 0 : -1}
								type="button"
							>
								{option.label}
							</button>
						);
					})}
				</div>
			) : (
				<h1 className={cn("text-foreground", STREAM_TEXT)}>
					{/* Weight on a span: the shared base pins heading weights. */}
					<span className="font-semibold">{title}</span>
				</h1>
			)}
			<div />
		</header>
	);
}

/**
 * Stream: conversations as a monochrome social feed, after the reference's
 * web layout. A slim icon rail, one centred column with a "What's new?" row,
 * and each thread drawn as a post by its lead agent with the thread line
 * running down to its repliers. Opening a post shows it on top with the host's
 * real conversation (`threadView`) below as the replies.
 */
export function StreamInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["stream"]>) {
	const reduceMotion = useReducedMotion();
	const [view, setView] = useState<StreamView>("home");
	const [feed, setFeed] = useState<StreamFeed>("for-you");
	const [activityFilter, setActivityFilter] =
		useState<StreamActivityFilter>("all");
	const [profileAgentId, setProfileAgentId] = useState<string | null>(null);
	const [profileTab, setProfileTab] = useState<StreamProfileTab>("threads");
	const [query, setQuery] = useState("");
	const [pickedAgentId, setPickedAgentId] = useState<string | null>(null);
	const [pendingFocus, setPendingFocus] = useState<PendingFocus>(null);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const hostRef = useRef<HTMLDivElement>(null);
	const backRef = useRef<HTMLButtonElement>(null);
	const feedsId = useId();

	const posts = useMemo(() => projectStreamPosts(snapshot), [snapshot]);
	const agents = useMemo(
		() => agentsByActivity(snapshot, posts),
		[snapshot, posts]
	);
	const counts = useMemo(() => threadCounts(posts), [posts]);
	const waiting = useMemo(() => activityCount(posts), [posts]);
	const profile = useMemo(
		() => profileFor(snapshot, posts, profileAgentId ?? agents[0]?.id ?? null),
		[snapshot, posts, profileAgentId, agents]
	);
	const composerAgent = defaultComposerAgent(agents, pickedAgentId);

	const pageOpen = threadView !== null;
	const openPost: StreamPost | undefined = activeThreadId
		? posts.find((post) => post.threadId === activeThreadId)
		: undefined;

	// Focus lands after the target view renders (Create from another page,
	// or Search from the rail).
	useEffect(() => {
		if (pendingFocus === "composer" && !pageOpen) {
			composerRef.current?.focus();
			setPendingFocus(null);
		} else if (pendingFocus === "search" && !pageOpen) {
			searchRef.current?.focus();
			setPendingFocus(null);
		}
	}, [pendingFocus, pageOpen]);

	// Opening a post from a list unmounts the row that had focus; land on Back
	// so keyboard users keep their place instead of falling to the document.
	// A page already open on mount keeps the host's focus as it is.
	const wasOpenRef = useRef(pageOpen);
	useEffect(() => {
		const opened = pageOpen && !wasOpenRef.current;
		wasOpenRef.current = pageOpen;
		if (!opened) {
			return;
		}
		const active = backRef.current?.ownerDocument.activeElement;
		if (!active || active === backRef.current?.ownerDocument.body) {
			backRef.current?.focus();
		}
	}, [pageOpen]);

	const leavePage = () => {
		if (pageOpen) {
			port.closeThread();
		}
	};

	const navigate = (next: StreamView) => {
		leavePage();
		if (next === view) {
			scrollRef.current?.scrollTo({ top: 0 });
		}
		setView(next);
		if (next === "search") {
			setPendingFocus("search");
		}
	};

	const create = () => {
		if (!composerAgent) {
			port.startThread({});
			return;
		}
		leavePage();
		setView("home");
		setFeed("for-you");
		setPendingFocus("composer");
	};

	// Reply on the post page hands off to the host's own composer: focus its
	// field when it has one, else bring the conversation into view.
	const replyInHost = () => {
		const host = hostRef.current;
		const field = host?.querySelector<HTMLElement>(
			'textarea, [contenteditable="true"], input[type="text"]'
		);
		if (field) {
			field.focus();
			return;
		}
		host?.scrollIntoView?.({ block: "start" });
	};

	const actions: StreamPostActions = {
		onNewThread: (agentId) => port.startThread({ agentId }),
		onOpen: (threadId) => {
			if (threadId !== activeThreadId || !pageOpen) {
				port.openThread(threadId);
			}
		},
		onProfile: (agentId) => {
			leavePage();
			setProfileAgentId(agentId);
			setProfileTab("threads");
			setView("profile");
		},
	};

	let title: string | null = null;
	if (pageOpen) {
		title = openPost ? "Thread" : "New thread";
	} else if (view !== "home") {
		title = TITLES[view];
	}

	let content: ReactNode;
	if (pageOpen) {
		content = (
			<div className="flex size-full min-h-0 flex-col">
				{openPost ? (
					<>
						<div className="max-h-[45%] shrink-0 overflow-y-auto">
							<StreamPostItem
								actions={actions}
								onReply={replyInHost}
								page
								post={openPost}
							/>
						</div>
						<div className="flex h-12 shrink-0 items-center border-border border-y px-6">
							<h2 className={cn("text-foreground", STREAM_TEXT)}>
								<span className="font-semibold">Replies</span>
							</h2>
						</div>
					</>
				) : null}
				<div
					className="min-h-0 flex-1"
					data-testid="stream-thread-view"
					ref={hostRef}
				>
					{threadView}
				</div>
			</div>
		);
	} else if (loading) {
		content = <StreamSkeleton />;
	} else if (view === "search") {
		content = (
			<StreamSearchView
				actions={actions}
				agents={agents}
				counts={counts}
				inputRef={searchRef}
				onQuery={setQuery}
				posts={posts}
				query={query}
			/>
		);
	} else if (view === "activity") {
		content = (
			<StreamActivityView
				filter={activityFilter}
				onFilter={setActivityFilter}
				onOpen={actions.onOpen}
				posts={posts}
			/>
		);
	} else if (view === "profile") {
		content = profile ? (
			<StreamProfileView
				actions={actions}
				agents={agents}
				onTab={setProfileTab}
				profile={profile}
				tab={profileTab}
			/>
		) : (
			<StreamEmpty
				action={
					<Button
						className="h-9 rounded-xl px-4 font-semibold"
						onClick={() => navigate("home")}
						variant="outline"
					>
						Back to Home
					</Button>
				}
				description="Profiles appear once you add an agent."
				title="No agents yet"
			/>
		);
	} else {
		const shown = feedPosts(posts, feed);
		content = (
			<>
				{composerAgent ? (
					<StreamComposer
						agent={composerAgent}
						agents={agents}
						fieldRef={composerRef}
						onPickAgent={setPickedAgentId}
						onPost={({ agentId, prompt }) =>
							port.startThread({ agentId, prompt })
						}
					/>
				) : null}
				<div
					aria-labelledby={streamTabId(feedsId, feed)}
					id={streamPanelId(feedsId)}
					role="tabpanel"
				>
					{shown.length > 0 ? (
						<ul aria-label={feed === "working" ? "Working" : "For you"}>
							{shown.map((post) => (
								<li key={post.threadId}>
									<StreamPostItem actions={actions} post={post} />
								</li>
							))}
						</ul>
					) : (
						<FeedEmpty
							feed={feed}
							hasAgents={composerAgent !== undefined}
							hasThreads={posts.length > 0}
						/>
					)}
				</div>
			</>
		);
	}

	const pageKey = pageOpen ? `page:${activeThreadId ?? "new"}` : view;

	return (
		<div
			className="@container size-full min-h-0 overflow-hidden bg-background text-foreground"
			data-testid="interface-stream"
		>
			<div className="flex size-full min-h-0 @min-[640px]:flex-row flex-col">
				<StreamRail
					activityCount={waiting}
					current={view}
					onCreate={create}
					onNavigate={navigate}
				/>
				<div className="flex min-h-0 min-w-0 flex-1 justify-center @min-[640px]:pr-[76px]">
					<div className="flex min-h-0 w-full max-w-[640px] flex-col">
						<StreamHeader
							backRef={backRef}
							feed={feed}
							feedsId={feedsId}
							onBack={pageOpen ? port.closeThread : null}
							onFeed={!pageOpen && view === "home" ? setFeed : null}
							title={title}
						/>
						<main
							aria-label={title ?? "Home"}
							className="relative flex min-h-0 flex-1 flex-col overflow-hidden @min-[640px]:rounded-t-[28px] border-border @min-[640px]:border-x border-t bg-card"
						>
							<motion.div
								animate={{ opacity: 1, y: 0 }}
								className={cn(
									"min-h-0 flex-1",
									pageOpen
										? "flex flex-col"
										: "overflow-y-auto [scrollbar-width:thin]"
								)}
								initial={reduceMotion ? false : { opacity: 0, y: 6 }}
								key={pageKey}
								ref={pageOpen ? undefined : scrollRef}
								transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
							>
								{content}
							</motion.div>
						</main>
					</div>
				</div>
				<StreamTabBar
					activityCount={waiting}
					current={view}
					onCreate={create}
					onNavigate={navigate}
				/>
			</div>
		</div>
	);
}

function FeedEmpty({
	feed,
	hasAgents,
	hasThreads,
}: {
	feed: StreamFeed;
	hasAgents: boolean;
	hasThreads: boolean;
}) {
	if (feed === "working" && hasThreads) {
		return (
			<StreamEmpty
				description="Threads with a live run show up here while the agent works."
				title="No agent is working"
			/>
		);
	}
	return (
		<StreamEmpty
			description={
				hasAgents
					? "Write above to start your first thread."
					: "Add an agent to start your first thread."
			}
			title="No threads yet"
		/>
	);
}
