import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { Composer } from "./community-composer.tsx";
import { FeedList, type PostActions, SortBar } from "./community-feed.tsx";
import { CommunityHeader, TopBar } from "./community-header.tsx";
import {
	handleCommunityKeyDown,
	useRowRegistry,
} from "./community-interface-keys.ts";
import { CommunityNavDrawer } from "./community-interface-nav-drawer.tsx";
import { usePostReactions } from "./community-interface-reactions.ts";
import { useCopiedShare } from "./community-interface-share.ts";
import {
	type EmptyCopy,
	readViewMode,
	useMinuteClock,
	writeViewMode,
} from "./community-interface-view-state.ts";
import {
	buildCommunities,
	buildPosts,
	type Community,
	type CommunityDraft,
	type CommunityPost,
	type CommunityScope,
	type CommunitySort,
	type CommunityViewMode,
	communityFeed,
	communityLabel,
	draftStartInput,
	emptyDraft,
	messageInput,
	PROFILE_KEY,
	rankedCommunities,
} from "./community-model.ts";
import { CommunityNav } from "./community-nav.tsx";
import { CommunityEmpty, FeedSkeleton } from "./community-parts.tsx";
import { PostPage } from "./community-post-page.tsx";
import { AboutCard, CommunitiesCard } from "./community-sidebar.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * Community: a Reddit-style front page over the user's threads. Projects,
 * teams, and agents are communities; each thread is a post filed in one, its
 * score comes from its messages, and its replies are the comments. Posts
 * open as a page whose comments are the host's real conversation.
 */
export function CommunityInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const now = useMinuteClock();
	const pageRef = useRef<HTMLElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const titleRef = useRef<HTMLInputElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const { registerRow, rowElements } = useRowRegistry();
	const lastOpenedId = useRef<string | null>(null);
	const pendingCommunity = useRef<string | null>(null);
	const sortId = useId();
	const panelId = `${sortId}-panel`;
	const headingId = `${sortId}-heading`;
	const tabId = useCallback(
		(sort: CommunitySort) => `${sortId}-${sort}`,
		[sortId]
	);

	const [scope, setScope] = useState<CommunityScope>({ kind: "home" });
	const [sort, setSort] = useState<CommunitySort>("hot");
	const [mode, setMode] = useState<CommunityViewMode>(readViewMode);
	const [query, setQuery] = useState("");
	const [composing, setComposing] = useState(false);
	const [draft, setDraft] = useState<CommunityDraft>(() => emptyDraft());
	const [navOpen, setNavOpen] = useState(false);
	const reactions = usePostReactions();
	const { copiedId, share } = useCopiedShare();

	const communities = useMemo(() => buildCommunities(snapshot), [snapshot]);
	const posts = useMemo(
		() => buildPosts(snapshot, communities),
		[snapshot, communities]
	);
	const feed = useMemo(
		() => communityFeed({ communities, now, posts, query, scope, sort }),
		[communities, now, posts, query, scope, sort]
	);
	const ranked = useMemo(() => rankedCommunities(communities), [communities]);

	const pageOpen = threadView !== null && threadView !== undefined;
	const activePost =
		posts.find((post) => post.thread.id === activeThreadId) ?? null;
	const scopedCommunity =
		scope.kind === "community"
			? (communities.find((community) => community.key === scope.key) ?? null)
			: null;
	const searching = query.trim().length > 0;

	useEffect(() => {
		if (activeThreadId) {
			lastOpenedId.current = activeThreadId;
		}
	}, [activeThreadId]);

	// Into the page when a post opens; back to its row when it closes.
	useEffect(() => {
		if (pageOpen) {
			pageRef.current?.focus({ preventScroll: true });
			return;
		}
		const id = lastOpenedId.current;
		if (id) {
			lastOpenedId.current = null;
			rowElements.current.get(id)?.focus({ preventScroll: true });
		}
	}, [pageOpen]);

	useEffect(() => {
		if (composing) {
			titleRef.current?.focus();
		}
	}, [composing]);

	// A scope whose community disappeared falls back to Home.
	useEffect(() => {
		if (scope.kind === "community" && !scopedCommunity) {
			setScope({ kind: "home" });
		}
	}, [scope, scopedCommunity]);

	const leavePage = () => {
		if (pageOpen) {
			lastOpenedId.current = null;
			port.closeThread();
		}
	};

	const go = (next: CommunityScope) => {
		setScope(next);
		setQuery("");
		setComposing(false);
		setNavOpen(false);
		leavePage();
		scrollRef.current?.scrollTo({ top: 0 });
	};

	const selectCommunity = (community: Community) =>
		go({ key: community.key, kind: "community" });

	const selectAgent = (agentId: string) =>
		go({ key: `agent:${agentId}`, kind: "community" });

	const selectPoster = (post: CommunityPost) =>
		go({
			key: post.poster ? `agent:${post.poster.id}` : PROFILE_KEY,
			kind: "community",
		});

	const openPost = (threadId: string) => {
		lastOpenedId.current = threadId;
		pendingCommunity.current = null;
		port.openThread(threadId);
	};

	const changeQuery = (value: string) => {
		setQuery(value);
		if (value.trim()) {
			setComposing(false);
			leavePage();
		}
	};

	const create = (communityKey?: string | null) => {
		leavePage();
		setNavOpen(false);
		const preset =
			communityKey === undefined
				? (scopedCommunity?.key ?? null)
				: communityKey;
		if (!(composing || draft.title || draft.body)) {
			setDraft(emptyDraft(preset));
		} else if (preset && !draft.communityKey) {
			setDraft((previous) => ({ ...previous, communityKey: preset }));
		}
		setComposing(true);
		scrollRef.current?.scrollTo({ top: 0 });
		titleRef.current?.focus();
	};

	const startInput = draftStartInput(draft, communities);

	const submit = () => {
		if (!startInput) {
			return;
		}
		pendingCommunity.current = draft.communityKey;
		port.startThread(startInput);
		setComposing(false);
		setDraft(emptyDraft());
	};

	const message = (agentId: string) => {
		if (!scopedCommunity) {
			return;
		}
		pendingCommunity.current = scopedCommunity.key;
		port.startThread(messageInput(scopedCommunity, agentId));
	};

	const changeMode = (next: CommunityViewMode) => {
		setMode(next);
		writeViewMode(next);
	};

	const actions: PostActions = {
		copiedId,
		onOpen: openPost,
		onSelectCommunity: selectCommunity,
		onSelectPoster: selectPoster,
		onShare: share,
		...reactions,
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) =>
		handleCommunityKeyDown(event, {
			composing,
			feed,
			navOpen,
			pageOpen,
			port,
			rowElements,
			searchRef,
			setNavOpen,
		});

	let empty: EmptyCopy | null = null;
	if (feed.length === 0) {
		if (searching) {
			empty = {
				action: { label: "Clear search", onClick: () => setQuery("") },
				body: "Check the spelling, or search for a community or agent name.",
				title: tl("No results for “{query}”", { query: query.trim() }),
			};
		} else if (snapshot.threads.length === 0) {
			empty = {
				action: { label: "Create post", onClick: () => create() },
				body:
					snapshot.agents.length === 0
						? "Add an agent in Ryu, then create a post. Its replies show up here as comments."
						: "Create a post to start a thread with an agent. Its replies show up as comments.",
				title: "No posts yet",
			};
		} else if (scopedCommunity) {
			empty = {
				action: { label: "Create post", onClick: () => create() },
				body: "Threads filed in this community show up here.",
				title: tl("{community} has no posts yet", {
					community: communityLabel(scopedCommunity),
				}),
			};
		} else if (scope.kind === "popular") {
			empty = {
				action: { label: "Go to Home", onClick: () => go({ kind: "home" }) },
				body: "Threads with activity in the last 24 hours show up here.",
				title: "Nothing popular right now",
			};
		}
	}

	let feedBody: ReactNode = (
		<FeedList
			actions={actions}
			inCommunity={scope.kind === "community" && !searching}
			mode={mode}
			now={now}
			posts={feed}
			registerRow={registerRow}
			viewKey={`${scope.kind}:${scope.kind === "community" ? scope.key : ""}:${sort}:${mode}`}
		/>
	);
	if (loading && snapshot.threads.length === 0) {
		feedBody = <FeedSkeleton />;
	} else if (empty) {
		feedBody = (
			<CommunityEmpty
				action={empty.action}
				body={empty.body}
				title={empty.title}
			/>
		);
	}

	let heading: ReactNode = (
		<h1 className="sr-only" id={headingId}>
			{scope.kind === "popular" ? "Popular" : "Home"}
		</h1>
	);
	if (searching) {
		heading = (
			<div className="flex flex-col gap-0.5 px-4 pb-2">
				<h1
					className="font-bold! text-2xl text-foreground leading-8 tracking-tight"
					id={headingId}
				>
					Search results
				</h1>
				<p aria-live="polite" className="text-muted-foreground text-sm">
					{tl(
						"{count, plural, one {{countText} post} other {{countText} posts}} for “{query}”",
						{
							count: feed.length,
							countText: String(feed.length),
							query: query.trim(),
						}
					)}
				</p>
			</div>
		);
	}

	const showCommunityHeader = scopedCommunity !== null && !searching;
	const pageCommunity =
		activePost?.community ??
		communities.find(
			(community) => community.key === pendingCommunity.current
		) ??
		null;
	const railCommunity = showCommunityHeader ? scopedCommunity : null;

	const agentLabel = (agentId: string) => {
		const own = communities.find(
			(community) => community.key === `agent:${agentId}`
		);
		return own ? communityLabel(own) : "r/agent";
	};

	const rail = railCommunity ? (
		<AboutCard
			agentLabel={agentLabel}
			community={railCommunity}
			now={now}
			onSelectAgent={selectAgent}
		/>
	) : (
		<CommunitiesCard communities={ranked} onSelect={selectCommunity} />
	);

	const nav = (
		<CommunityNav
			communities={communities}
			loading={loading}
			onHome={() => go({ kind: "home" })}
			onPopular={() => go({ kind: "popular" })}
			onSelect={selectCommunity}
			scope={scope}
		/>
	);

	return (
		<div
			aria-busy={loading}
			className="@container/community relative flex size-full min-h-0 flex-col bg-background text-foreground"
			data-testid="interface-community"
			onKeyDown={onKeyDown}
		>
			<TopBar
				navOpen={navOpen}
				onCreate={() => create()}
				onQueryChange={changeQuery}
				onSubmitSearch={() =>
					rowElements.current.get(feed[0]?.thread.id ?? "")?.focus()
				}
				onToggleNav={() => setNavOpen((value) => !value)}
				query={query}
				searchRef={searchRef}
			/>
			<div className="relative flex min-h-0 flex-1">
				<div className="@[860px]/community:flex hidden @[1200px]/community:w-[272px] w-[248px] shrink-0 flex-col border-border border-r">
					{nav}
				</div>
				<CommunityNavDrawer
					nav={nav}
					navOpen={navOpen}
					onClose={() => setNavOpen(false)}
					reduceMotion={reduceMotion}
				/>
				{pageOpen ? (
					<PostPage
						actions={actions}
						aside={
							pageCommunity ? (
								<AboutCard
									agentLabel={agentLabel}
									community={pageCommunity}
									now={now}
									onOpenCommunity={selectCommunity}
									onSelectAgent={selectAgent}
								/>
							) : null
						}
						fallbackCommunity={pageCommunity}
						now={now}
						onBack={() => port.closeThread()}
						post={activePost}
						ref={pageRef}
						threadView={threadView}
					/>
				) : (
					<div
						className="min-h-0 min-w-0 flex-1 overflow-y-auto"
						data-testid="community-scroll"
						ref={scrollRef}
					>
						<div className="mx-auto flex w-full max-w-[1120px] flex-col @[640px]/community:px-6 px-2 pt-4 pb-16">
							{showCommunityHeader && scopedCommunity && !composing ? (
								<div className="pb-6">
									<CommunityHeader
										community={scopedCommunity}
										headingId={headingId}
										onCreate={() => create(scopedCommunity.key)}
										onMessage={message}
									/>
								</div>
							) : null}
							<div className="flex gap-4">
								<main
									aria-labelledby={composing ? undefined : headingId}
									className="min-w-0 flex-1"
								>
									{composing ? (
										<Composer
											canPost={startInput !== null}
											communities={communities}
											draft={draft}
											onCancel={() => {
												setComposing(false);
												setDraft(emptyDraft());
											}}
											onChange={setDraft}
											onSubmit={submit}
											titleRef={titleRef}
										/>
									) : (
										<>
											{showCommunityHeader ? null : heading}
											<SortBar
												mode={mode}
												onMode={changeMode}
												onSort={setSort}
												panelId={panelId}
												sort={sort}
												tabId={tabId}
											/>
											<hr className="mx-4 mb-2 border-border" />
											<div
												aria-labelledby={tabId(sort)}
												id={panelId}
												role="tabpanel"
											>
												{feedBody}
											</div>
										</>
									)}
								</main>
								<aside
									aria-label={
										railCommunity ? "About this community" : "Communities"
									}
									className={cn(
										"@[1200px]/community:block hidden w-[316px] shrink-0"
									)}
								>
									<div className="sticky top-4 mt-2">{rail}</div>
								</aside>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
