import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CategoriesTable } from "./forum-categories.tsx";
import { ForumComposer } from "./forum-composer.tsx";
import {
	FORUM_WRAP,
	ForumHeader,
	type ForumListView,
	ForumNav,
} from "./forum-header.tsx";
import { ForumEmpty } from "./forum-interface-empty.tsx";
import {
	CLOSED_COMPOSER,
	type ComposerState,
	ownsKeys,
	STEP_KEYS,
	useMinuteClock,
} from "./forum-interface-state.ts";
import {
	composerCategories,
	draftStartInput,
	emptyDraft,
	FORUM_SORT_EMPTY,
	FORUM_SORT_END,
	FORUM_SORT_LABELS,
	type ForumDraft,
	type ForumSort,
	forumCategories,
	forumTopic,
	plural,
	stepTopic,
	topicList,
	unreadCount,
} from "./forum-model.ts";
import { CategorySwatch } from "./forum-parts.tsx";
import { TopicPage } from "./forum-topic-page.tsx";
import { ListFooter, TopicTable, TopicTableSkeleton } from "./forum-topics.tsx";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * Forum: a Discourse-style board over the same agents and threads. Threads
 * are topics filed under categories (projects, teams, then agents); the
 * Latest, Top and Unread lists and a phpBB-style categories table lead into
 * a topic page whose replies are the host's real conversation, with
 * Discourse's timeline beside them. New topics start from a docked composer.
 */
export function ForumInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();
	const reduceMotion = useReducedMotion();
	const now = useMinuteClock();
	const rootRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const titleRef = useRef<HTMLInputElement>(null);
	const rowElements = useRef(new Map<string, HTMLTableRowElement>());
	const lastOpenedId = useRef<string | null>(null);

	const [view, setView] = useState<ForumListView>("latest");
	const [categoryId, setCategoryId] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [composer, setComposer] = useState<ComposerState>(CLOSED_COMPOSER);
	const [draft, setDraft] = useState<ForumDraft>(() => emptyDraft(null));

	const categories = useMemo(() => forumCategories(snapshot), [snapshot]);
	const pickable = useMemo(() => composerCategories(categories), [categories]);
	// A category that disappears from the snapshot drops the filter with it.
	const category = categories.find((item) => item.id === categoryId) ?? null;
	const scopedCategoryId = category?.id ?? null;
	const searching = search.trim().length > 0;
	const sort: ForumSort = view === "categories" ? "latest" : view;
	const showCategories = view === "categories" && !searching;

	const topics = useMemo(
		() =>
			topicList(snapshot, categories, {
				categoryId: scopedCategoryId,
				search,
				sort,
			}),
		[snapshot, categories, scopedCategoryId, search, sort]
	);
	const order = useMemo(() => topics.map((topic) => topic.thread.id), [topics]);
	const unread = useMemo(
		() => unreadCount(snapshot, scopedCategoryId, categories),
		[snapshot, scopedCategoryId, categories]
	);

	const openThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const openTopic = openThread
		? forumTopic(snapshot, openThread, categories)
		: null;
	const topicOpen = threadView !== null;

	const open = useCallback(
		(threadId: string) => {
			lastOpenedId.current = threadId;
			setSelectedId(threadId);
			port.openThread(threadId);
		},
		[port]
	);

	const selectCategory = useCallback(
		(next: string | null) => {
			setCategoryId(next);
			setSelectedId(null);
			setView((current) => (current === "categories" ? "latest" : current));
			if (topicOpen) {
				port.closeThread();
			}
		},
		[port, topicOpen]
	);

	const changeView = (next: ForumListView) => {
		setView(next);
		setSelectedId(null);
		if (next === "categories") {
			setCategoryId(null);
		}
	};

	const goHome = () => {
		setView("latest");
		setCategoryId(null);
		setSearch("");
		setSelectedId(null);
		if (topicOpen) {
			port.closeThread();
		}
	};

	const onSearch = (value: string) => {
		setSearch(value);
		setSelectedId(null);
		if (topicOpen && value.trim()) {
			port.closeThread();
		}
	};

	const openComposer = useCallback(() => {
		setDraft((current) =>
			current.title || current.body
				? current
				: emptyDraft(openTopic?.category.id ?? scopedCategoryId)
		);
		setComposer({ minimized: false, open: true });
	}, [openTopic?.category.id, scopedCategoryId]);

	const discardDraft = () => {
		setComposer(CLOSED_COMPOSER);
		setDraft(emptyDraft(scopedCategoryId));
	};

	const submitDraft = () => {
		const input = draftStartInput(draft, pickable);
		if (!input) {
			return;
		}
		port.startThread(input);
		setComposer(CLOSED_COMPOSER);
		setDraft(emptyDraft(scopedCategoryId));
	};

	// Focus the title whenever the composer opens or expands.
	useEffect(() => {
		if (composer.open && !composer.minimized) {
			titleRef.current?.focus({ preventScroll: true });
		}
	}, [composer]);

	// Back from a topic: return focus to the row that opened it.
	useEffect(() => {
		if (topicOpen) {
			return;
		}
		const id = lastOpenedId.current;
		if (!id) {
			return;
		}
		lastOpenedId.current = null;
		const row = rowElements.current.get(id);
		const title = row?.querySelector<HTMLButtonElement>("[data-topic-title]");
		title?.focus({ preventScroll: true });
		row?.scrollIntoView({ block: "nearest" });
	}, [topicOpen]);

	const rowRef = useCallback(
		(threadId: string, element: HTMLTableRowElement | null) => {
			if (element) {
				rowElements.current.set(threadId, element);
			} else {
				rowElements.current.delete(threadId);
			}
		},
		[]
	);

	const step = useCallback(
		(delta: number) => {
			const next = stepTopic(order, selectedId, delta);
			if (!next) {
				return;
			}
			setSelectedId(next);
			const row = rowElements.current.get(next);
			row
				?.querySelector<HTMLButtonElement>("[data-topic-title]")
				?.focus({ preventScroll: true });
			row?.scrollIntoView({ block: "nearest" });
		},
		[order, selectedId]
	);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const root = rootRef.current;
			const target = event.target;
			// Keys from inside the forum, or from <body> once focus falls back
			// there; never from a page or dialog the host shows over it.
			const fromPage =
				target === document.body || target === document.documentElement;
			const inside =
				fromPage || (target instanceof Node && root?.contains(target) === true);
			if (
				!inside ||
				isInterfaceCovered(root) ||
				event.defaultPrevented ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				ownsKeys(event.target)
			) {
				return;
			}
			if (event.key === "/") {
				event.preventDefault();
				searchRef.current?.focus();
				return;
			}
			if (event.key === "c") {
				event.preventDefault();
				openComposer();
				return;
			}
			if (event.key === "Escape" && topicOpen) {
				event.preventDefault();
				port.closeThread();
				return;
			}
			if (topicOpen || showCategories) {
				return;
			}
			const delta = STEP_KEYS[event.key];
			if (delta !== undefined) {
				event.preventDefault();
				step(delta);
				return;
			}
			if (event.key === "o" && selectedId) {
				event.preventDefault();
				open(selectedId);
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, openComposer, port, selectedId, showCategories, step, topicOpen]);

	const listFooterActions = (empty: boolean) => {
		const actions: { label: string; onClick: () => void }[] = [];
		if (searching) {
			actions.push({ label: "Clear search", onClick: () => onSearch("") });
			return actions;
		}
		actions.push({
			label: "Browse all categories",
			onClick: () => changeView("categories"),
		});
		if (sort !== "latest" || (empty && scopedCategoryId)) {
			actions.push({
				label: "View latest topics",
				onClick: () => {
					setView("latest");
					if (empty) {
						setCategoryId(null);
					}
				},
			});
		}
		return actions;
	};

	const nothingYet =
		snapshot.threads.length === 0 && snapshot.agents.length === 0;

	let body: ReactNode;
	if (loading) {
		body = <TopicTableSkeleton />;
	} else if (nothingYet) {
		body = <ForumEmpty onNewTopic={openComposer} />;
	} else if (showCategories) {
		body = (
			<CategoriesTable
				categories={categories}
				now={now}
				onOpen={open}
				onSelect={(id) => selectCategory(id)}
				snapshot={snapshot}
			/>
		);
	} else if (topics.length === 0) {
		body = (
			<div className="border-border border-t" data-testid="forum-topic-list">
				<ListFooter
					actions={listFooterActions(true)}
					message={
						searching
							? tl("No topics match “{query}”.", { query: search.trim() })
							: FORUM_SORT_EMPTY[sort]
					}
				/>
			</div>
		);
	} else {
		body = (
			<TopicTable
				footer={
					<ListFooter
						actions={listFooterActions(false)}
						message={
							searching
								? "There are no more search results."
								: FORUM_SORT_END[sort]
						}
					/>
				}
				now={now}
				onOpen={open}
				onSelectCategory={scopedCategoryId ? null : selectCategory}
				rowRef={rowRef}
				selectedId={selectedId}
				topics={topics}
			/>
		);
	}

	const backLabel =
		view === "categories" ? "Categories" : FORUM_SORT_LABELS[sort];
	const composerVisible = composer.open;

	return (
		<div
			className="@container relative flex size-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
			data-testid="interface-forum"
			ref={rootRef}
		>
			<ForumHeader
				onHome={goHome}
				onNewTopic={openComposer}
				onSearch={onSearch}
				search={search}
				searchRef={searchRef}
			/>
			{topicOpen ? (
				<TopicPage
					backLabel={backLabel}
					now={now}
					onBack={() => port.closeThread()}
					onSelectCategory={(id) => selectCategory(id)}
					reduceMotion={reduceMotion}
					threadView={threadView}
					topic={openTopic}
				/>
			) : (
				<main aria-label="Topics" className="min-h-0 flex-1 overflow-y-auto">
					<div className={cn(FORUM_WRAP, "pt-6 pb-10")}>
						{category ? (
							<div className="mb-6 flex items-start gap-3">
								<CategorySwatch
									category={category}
									className="mt-2 size-4 rounded-[3px]"
								/>
								<div className="min-w-0">
									<h1 className="font-medium text-2xl text-foreground leading-8 tracking-tight">
										{category.name}
									</h1>
									<p className="mt-0.5 text-muted-foreground text-sm leading-6">
										{category.description}
										{category.description ? (
											<span aria-hidden="true"> · </span>
										) : null}
										{plural(category.topicIds.length, "topic", "topics")}
									</p>
								</div>
							</div>
						) : null}
						<ForumNav
							categories={categories}
							categoryId={scopedCategoryId}
							onCategory={selectCategory}
							onView={changeView}
							unread={unread}
							view={view}
						/>
						{searching ? (
							<p
								aria-live="polite"
								className="mt-5 text-muted-foreground text-sm"
							>
								{tlRich(
									"{count, plural, one {{shown} result} other {{shown} results}} for <term>“{query}”</term>",
									{
										count: topics.length,
										query: search.trim(),
										shown: String(topics.length),
									},
									{
										term: (chunks) => (
											<span className="font-medium text-foreground">
												{chunks}
											</span>
										),
									}
								)}
							</p>
						) : null}
						<div className={searching ? "mt-2" : "mt-4"}>{body}</div>
					</div>
				</main>
			)}
			<AnimatePresence initial={false}>
				{composerVisible ? (
					<motion.section
						animate={{ height: "auto", opacity: 1 }}
						aria-label="Composer"
						className="relative z-20 shrink-0 overflow-hidden border-border border-t bg-background"
						exit={{ height: 0, opacity: reduceMotion ? 0 : 1 }}
						initial={{ height: 0, opacity: reduceMotion ? 0 : 1 }}
						key="composer"
						transition={
							reduceMotion
								? { duration: 0 }
								: { duration: 0.22, ease: [0.32, 0.72, 0, 1] }
						}
					>
						<ForumComposer
							agents={snapshot.agents}
							categories={pickable}
							draft={draft}
							minimized={composer.minimized}
							onChange={setDraft}
							onDiscard={discardDraft}
							onMinimize={(minimized) => setComposer({ minimized, open: true })}
							onSubmit={submitDraft}
							titleRef={titleRef}
						/>
					</motion.section>
				) : null}
			</AnimatePresence>
		</div>
	);
}
