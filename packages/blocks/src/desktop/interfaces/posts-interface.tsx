import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useEffectEvent,
	useMemo,
	useRef,
	useState,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { PostsComposer } from "./posts-composer.tsx";
import {
	PostList,
	PostSections,
	PostsEmpty,
	PostsEmptyAction,
	PostsSkeleton,
} from "./posts-feed.tsx";
import { PostsHeader, PostsSidebarToggle } from "./posts-header.tsx";
import {
	DETAILS_INLINE_MIN_WIDTH,
	ownsKeys,
	SIDEBAR_INLINE_MIN_WIDTH,
	STEP_KEYS,
	useElementWidth,
	useMinuteClock,
} from "./posts-interface-layout.ts";
import {
	ALL_VIEW,
	homeCount as countHome,
	emptyDraft,
	HOME_VIEW,
	homeSections,
	type PostDraft,
	type PostSpace,
	type PostsView,
	postItem,
	postSpaces,
	postStartInput,
	resolveView,
	stepPost,
	viewHeader,
	viewKey,
	viewPosts,
} from "./posts-model.ts";
import { PostPage } from "./posts-page.tsx";
import { PostsSidebar } from "./posts-sidebar.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * Posts: Campsite-style async team posts. Each thread is a post filed in a
 * space (its team or project, else General); agents are the members. Home
 * collects posts that need you, Posts shows everything, and a space or member
 * narrows the feed. Opening a post shows it as a page whose comments are the
 * host's real conversation, with a details rail beside them.
 */
export function PostsInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const rootRef = useRef<HTMLDivElement>(null);
	const pageRef = useRef<HTMLElement>(null);
	const titleRef = useRef<HTMLInputElement>(null);
	const feedScrollRef = useRef<HTMLDivElement>(null);
	const rowElements = useRef(new Map<string, HTMLButtonElement>());
	const lastOpenedId = useRef<string | null>(null);
	const reduceMotion = useReducedMotion();
	const width = useElementWidth(rootRef);
	const now = useMinuteClock();
	const tl = useLiteralMessages();

	const spaces = useMemo(() => postSpaces(snapshot), [snapshot]);
	const needsYouCount = useMemo(() => countHome(snapshot), [snapshot]);
	const [chosenView, setChosenView] = useState<PostsView | null>(null);
	const [composerOpen, setComposerOpen] = useState(false);
	const [draft, setDraft] = useState<PostDraft>(() => emptyDraft(HOME_VIEW));
	const [detailsPreference, setDetailsPreference] = useState<boolean | null>(
		null
	);
	const [sidebarOpen, setSidebarOpen] = useState(false);

	const sidebarInline = width >= SIDEBAR_INLINE_MIN_WIDTH;
	const detailsFloating = width < DETAILS_INLINE_MIN_WIDTH;

	// Home when something needs you, otherwise every post. Locked once the
	// first real snapshot lands, so answering the last request does not
	// yank the reader from Home to Posts.
	const fallbackView = needsYouCount > 0 ? HOME_VIEW : ALL_VIEW;
	useEffect(() => {
		if (chosenView === null && !loading && snapshot.threads.length > 0) {
			setChosenView(fallbackView);
		}
	}, [chosenView, fallbackView, loading, snapshot.threads.length]);
	const view = resolveView(snapshot, chosenView ?? fallbackView, spaces);
	const currentKey = viewKey(view);
	const items = useMemo(
		() => viewPosts(snapshot, view, spaces),
		[snapshot, view, spaces]
	);
	const sections = useMemo(
		() => (view.kind === "home" ? homeSections(items) : []),
		[items, view.kind]
	);
	const order = useMemo(
		() =>
			view.kind === "home"
				? sections.flatMap((section) =>
						section.items.map((item) => item.thread.id)
					)
				: items.map((item) => item.thread.id),
		[items, sections, view.kind]
	);
	const header = viewHeader(snapshot, view, spaces);

	const pageOpen = threadView !== null && threadView !== undefined;
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const activeItem = activeThread
		? postItem(snapshot, activeThread, spaces)
		: null;
	const detailsOpen = detailsPreference ?? !detailsFloating;

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
		if (composerOpen) {
			titleRef.current?.focus();
		}
	}, [composerOpen]);

	useEffect(() => {
		if (sidebarInline) {
			setSidebarOpen(false);
		}
	}, [sidebarInline]);

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

	const openPost = (threadId: string) => {
		lastOpenedId.current = threadId;
		port.openThread(threadId);
	};

	const closePost = () => {
		port.closeThread();
	};

	const selectView = (next: PostsView) => {
		setChosenView(next);
		setSidebarOpen(false);
		if (composerOpen && !(draft.title || draft.body)) {
			setComposerOpen(false);
		}
		if (pageOpen) {
			lastOpenedId.current = null;
			port.closeThread();
		}
		feedScrollRef.current?.scrollTo({ top: 0 });
	};

	const selectSpace = (space: PostSpace) =>
		selectView({ id: space.id, kind: "space" });

	const newPost = () => {
		setSidebarOpen(false);
		if (pageOpen) {
			lastOpenedId.current = null;
			port.closeThread();
		}
		if (!composerOpen) {
			setDraft(emptyDraft(view));
			setComposerOpen(true);
		}
		feedScrollRef.current?.scrollTo({ top: 0 });
		titleRef.current?.focus();
	};

	const cancelPost = () => {
		setComposerOpen(false);
		setDraft(emptyDraft(view));
	};

	const submitPost = () => {
		const input = postStartInput(draft, spaces);
		if (!input) {
			return;
		}
		port.startThread(input);
		setComposerOpen(false);
		setDraft(emptyDraft(view));
	};

	/**
	 * Shortcuts listen on the document so they work with focus on the page
	 * body, but only for keys aimed at nothing in particular or at this
	 * interface: another app region, a field, a menu, or the host's chat keeps
	 * its own keys.
	 */
	const onDocumentKeyDown = useEffectEvent(
		(event: globalThis.KeyboardEvent) => {
			const target = event.target;
			const root = rootRef.current;
			const aimedHere =
				target === document.body ||
				target === document.documentElement ||
				(target instanceof Node && root?.contains(target) === true);
			if (
				!aimedHere ||
				isInterfaceCovered(root) ||
				event.defaultPrevented ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				ownsKeys(target)
			) {
				return;
			}
			if (event.key === "Escape") {
				if (sidebarOpen) {
					event.preventDefault();
					setSidebarOpen(false);
				} else if (pageOpen && detailsFloating && detailsOpen) {
					event.preventDefault();
					setDetailsPreference(false);
				} else if (pageOpen) {
					event.preventDefault();
					closePost();
				}
				return;
			}
			if (event.key === "c") {
				event.preventDefault();
				newPost();
				return;
			}
			if (event.key === "i" && pageOpen && activeItem) {
				event.preventDefault();
				setDetailsPreference(!detailsOpen);
				return;
			}
			const step = STEP_KEYS[event.key];
			if (step !== undefined && !pageOpen) {
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
			}
		}
	);

	useEffect(() => {
		const listener = (event: globalThis.KeyboardEvent) =>
			onDocumentKeyDown(event);
		document.addEventListener("keydown", listener);
		return () => document.removeEventListener("keydown", listener);
	}, []);

	const empty = !loading && snapshot.threads.length === 0;
	const sidebarToggle = sidebarInline ? null : (
		<PostsSidebarToggle onOpen={() => setSidebarOpen(true)} />
	);

	let feed: ReactNode;
	if (loading && snapshot.threads.length === 0) {
		feed = <PostsSkeleton />;
	} else if (empty) {
		feed = (
			<PostsEmpty
				action={
					composerOpen ? null : (
						<PostsEmptyAction onClick={newPost}>New post</PostsEmptyAction>
					)
				}
				body={
					snapshot.agents.length === 0
						? "Agents you add in Ryu join as members. Write a post and the agent you pick replies in its comments."
						: "Write a post and an agent replies in its comments. Each post is a thread you can return to."
				}
				title="No posts yet"
			/>
		);
	} else if (items.length === 0) {
		feed =
			view.kind === "home" ? (
				<PostsEmpty
					action={
						<PostsEmptyAction onClick={() => selectView(ALL_VIEW)}>
							View all posts
						</PostsEmptyAction>
					}
					body="Feedback requests and failed runs show up here."
					title="Nothing needs you"
				/>
			) : (
				<PostsEmpty
					action={
						composerOpen ? null : (
							<PostsEmptyAction onClick={newPost}>New post</PostsEmptyAction>
						)
					}
					body="Posts filed here show up in this feed."
					title={tl("No posts in {title} yet", { title: header.title })}
				/>
			);
	} else if (view.kind === "home") {
		feed = (
			<PostSections
				now={now}
				onOpen={openPost}
				registerRow={registerRow}
				sections={sections}
				showSpace
			/>
		);
	} else {
		feed = (
			<PostList
				items={items}
				now={now}
				onOpen={openPost}
				registerRow={registerRow}
				showSpace={view.kind !== "space"}
			/>
		);
	}

	const sidebar = (
		<PostsSidebar
			agents={snapshot.agents}
			homeCount={needsYouCount}
			loading={loading && snapshot.threads.length === 0}
			onClose={sidebarInline ? null : () => setSidebarOpen(false)}
			onNewPost={newPost}
			onSelect={selectView}
			spaces={spaces}
			viewKey={currentKey}
		/>
	);

	return (
		<div
			aria-busy={loading}
			className="relative flex size-full min-h-0 bg-background text-foreground"
			data-layout={sidebarInline ? "inline" : "folded"}
			data-testid="interface-posts"
			ref={rootRef}
		>
			{sidebarInline ? (
				<div className="w-60 shrink-0 border-sidebar-border border-r">
					{sidebar}
				</div>
			) : (
				<AnimatePresence>
					{sidebarOpen ? (
						<>
							<motion.button
								animate={{ opacity: 1 }}
								aria-label="Close sidebar"
								className="absolute inset-0 z-30 bg-foreground/20"
								exit={{ opacity: 0 }}
								initial={reduceMotion ? false : { opacity: 0 }}
								key="scrim"
								onClick={() => setSidebarOpen(false)}
								tabIndex={-1}
								transition={{ duration: 0.15 }}
								type="button"
							/>
							<motion.div
								animate={{ x: 0 }}
								className="absolute inset-y-0 left-0 z-40 w-64 max-w-[85%] border-sidebar-border border-r shadow-lg"
								exit={reduceMotion ? { opacity: 0 } : { x: "-100%" }}
								initial={reduceMotion ? false : { x: "-100%" }}
								key="sidebar"
								transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
							>
								{sidebar}
							</motion.div>
						</>
					) : null}
				</AnimatePresence>
			)}
			<main className="flex min-h-0 min-w-0 flex-1 flex-col">
				{pageOpen ? (
					<PostPage
						backLabel={header.title}
						detailsFloating={detailsFloating}
						detailsOpen={detailsOpen}
						item={activeItem}
						now={now}
						onBack={closePost}
						onCloseDetails={() => setDetailsPreference(false)}
						onSelectSpace={selectSpace}
						onToggleDetails={() => setDetailsPreference(!detailsOpen)}
						ref={pageRef}
						sidebarToggle={sidebarToggle}
						threadView={threadView}
					/>
				) : (
					<>
						<PostsHeader
							description={header.description}
							members={header.members}
							onNewPost={newPost}
							onOpenSidebar={sidebarInline ? null : () => setSidebarOpen(true)}
							title={header.title}
						/>
						<div
							className="min-h-0 flex-1 overflow-y-auto"
							data-testid="posts-feed"
							ref={feedScrollRef}
						>
							<div
								className={cn(
									"mx-auto flex w-full max-w-[800px] flex-col px-4 pb-16 sm:px-8",
									composerOpen ? "pt-6" : "pt-4"
								)}
							>
								{composerOpen ? (
									<div className="pb-4">
										<PostsComposer
											agents={snapshot.agents}
											draft={draft}
											onCancel={cancelPost}
											onChange={setDraft}
											onSubmit={submitPost}
											spaces={spaces}
											titleRef={titleRef}
										/>
									</div>
								) : null}
								{feed}
							</div>
						</div>
					</>
				)}
			</main>
		</div>
	);
}
