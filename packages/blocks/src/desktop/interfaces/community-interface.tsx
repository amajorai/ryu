import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, motion } from "motion/react";
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
	buildCommunities,
	buildPosts,
	type Community,
	type CommunityDraft,
	type CommunityPost,
	type CommunityScope,
	type CommunitySort,
	type CommunityViewMode,
	type CommunityVote,
	communityFeed,
	communityLabel,
	draftStartInput,
	emptyDraft,
	messageInput,
	nextVote,
	PROFILE_KEY,
	plural,
	rankedCommunities,
	stepPost,
} from "./community-model.ts";
import { CommunityNav } from "./community-nav.tsx";
import { CommunityEmpty, FeedSkeleton } from "./community-parts.tsx";
import { PostPage } from "./community-post-page.tsx";
import { AboutCard, CommunitiesCard } from "./community-sidebar.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

const MINUTE = 60_000;
const COPIED_MS = 1600;
const VIEW_KEY = "ryu.interfaces.community.view";

function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

function readViewMode(): CommunityViewMode {
	try {
		return window.localStorage.getItem(VIEW_KEY) === "compact"
			? "compact"
			: "card";
	} catch {
		return "card";
	}
}

function writeViewMode(mode: CommunityViewMode) {
	try {
		window.localStorage.setItem(VIEW_KEY, mode);
	} catch {
		// Storage can be blocked; the choice still holds for this session.
	}
}

/** True for targets whose keys belong to typing, menus, tabs, or the host's chat. */
function ownsKeys(target: EventTarget): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.closest("[role='menu']") !== null ||
		target.closest("[role='tablist']") !== null ||
		target.closest("[data-testid='community-thread-view']") !== null
	);
}

const STEP_KEYS: Record<string, number> = {
	ArrowDown: 1,
	ArrowUp: -1,
	j: 1,
	k: -1,
};

interface EmptyCopy {
	action: { label: string; onClick: () => void } | null;
	body: string;
	title: string;
}

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
	const reduceMotion = useReducedMotion();
	const now = useMinuteClock();
	const pageRef = useRef<HTMLElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const titleRef = useRef<HTMLInputElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const rowElements = useRef(new Map<string, HTMLButtonElement>());
	const lastOpenedId = useRef<string | null>(null);
	const pendingCommunity = useRef<string | null>(null);
	const copiedTimer = useRef<number | null>(null);
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
	const [votes, setVotes] = useState<Record<string, CommunityVote>>({});
	const [saved, setSaved] = useState<ReadonlySet<string>>(() => new Set());
	const [copiedId, setCopiedId] = useState<string | null>(null);

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

	useEffect(
		() => () => {
			if (copiedTimer.current !== null) {
				window.clearTimeout(copiedTimer.current);
			}
		},
		[]
	);

	// A scope whose community disappeared falls back to Home.
	useEffect(() => {
		if (scope.kind === "community" && !scopedCommunity) {
			setScope({ kind: "home" });
		}
	}, [scope, scopedCommunity]);

	const registerRow = useCallback(
		(threadId: string, element: HTMLButtonElement | null) => {
			if (element) {
				rowElements.current.set(threadId, element);
			} else {
				rowElements.current.delete(threadId);
			}
		},
		[]
	);

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

	const share = (post: CommunityPost) => {
		const text = `${post.thread.title} (${communityLabel(post.community)})`;
		try {
			navigator.clipboard?.writeText(text).catch(() => undefined);
		} catch {
			// Clipboard access can be denied; the label still confirms the action.
		}
		setCopiedId(post.thread.id);
		if (copiedTimer.current !== null) {
			window.clearTimeout(copiedTimer.current);
		}
		copiedTimer.current = window.setTimeout(() => {
			setCopiedId(null);
			copiedTimer.current = null;
		}, COPIED_MS);
	};

	const actions: PostActions = {
		copiedId,
		onOpen: openPost,
		onSave: (threadId) =>
			setSaved((previous) => {
				const next = new Set(previous);
				if (next.has(threadId)) {
					next.delete(threadId);
				} else {
					next.add(threadId);
				}
				return next;
			}),
		onSelectCommunity: selectCommunity,
		onSelectPoster: selectPoster,
		onShare: share,
		onVote: (threadId, vote) =>
			setVotes((previous) => {
				const next = { ...previous };
				const value = nextVote(previous[threadId], vote);
				if (value === undefined) {
					delete next[threadId];
				} else {
					next[threadId] = value;
				}
				return next;
			}),
		saved,
		votes,
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.defaultPrevented ||
			event.metaKey ||
			event.ctrlKey ||
			event.altKey
		) {
			return;
		}
		if (event.key === "Escape") {
			if (navOpen) {
				event.preventDefault();
				setNavOpen(false);
				return;
			}
			if (pageOpen && !ownsKeys(event.target)) {
				event.preventDefault();
				port.closeThread();
				return;
			}
		}
		if (ownsKeys(event.target)) {
			return;
		}
		if (event.key === "/") {
			event.preventDefault();
			searchRef.current?.focus();
			searchRef.current?.select();
			return;
		}
		const step = STEP_KEYS[event.key];
		if (step === undefined || pageOpen || composing) {
			return;
		}
		const order = feed.map((post) => post.thread.id);
		const focused = [...rowElements.current].find(
			([, element]) => element === document.activeElement
		)?.[0];
		const next = stepPost(order, focused ?? null, step);
		if (next) {
			event.preventDefault();
			const element = rowElements.current.get(next);
			element?.focus();
			element?.scrollIntoView?.({ block: "nearest" });
		}
	};

	let empty: EmptyCopy | null = null;
	if (feed.length === 0) {
		if (searching) {
			empty = {
				action: { label: "Clear search", onClick: () => setQuery("") },
				body: "Check the spelling, or search for a community or agent name.",
				title: `No results for “${query.trim()}”`,
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
				title: `${communityLabel(scopedCommunity)} has no posts yet`,
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
					{plural(feed.length, "post")} for “{query.trim()}”
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
				<AnimatePresence>
					{navOpen ? (
						<>
							<motion.button
								animate={{ opacity: 1 }}
								aria-label="Close navigation"
								className="absolute inset-0 z-20 @[860px]/community:hidden bg-foreground/20"
								exit={{ opacity: 0 }}
								initial={reduceMotion ? false : { opacity: 0 }}
								key="scrim"
								onClick={() => setNavOpen(false)}
								tabIndex={-1}
								transition={{ duration: 0.15 }}
								type="button"
							/>
							<motion.div
								animate={{ x: 0 }}
								className="absolute inset-y-0 left-0 z-30 flex @[860px]/community:hidden w-[272px] max-w-[85%] flex-col border-border border-r bg-background shadow-lg"
								data-testid="community-nav-drawer"
								exit={reduceMotion ? { opacity: 0 } : { x: "-100%" }}
								initial={reduceMotion ? false : { x: "-100%" }}
								key="drawer"
								transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
							>
								{nav}
							</motion.div>
						</>
					) : null}
				</AnimatePresence>
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
