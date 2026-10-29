import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import {
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { AgentArticle, GroupArticle, ThreadArticle } from "./wiki-articles.tsx";
import { WikiHeader, WikiMainMenu } from "./wiki-chrome.tsx";
import {
	byRecency,
	routeHasTalk,
	WIKI_MAIN,
	type WikiRoute,
	type WikiTab,
	wikiAgent,
	wikiGroup,
	wikiPageHeading,
	wikiRouteTitle,
	wikiThread,
	wikiThreadTitle,
} from "./wiki-model.ts";
import {
	CategoryPage,
	HistoryPage,
	MainPage,
	RecentChangesPage,
	SearchPage,
	TalkPage,
	ThreadListPage,
} from "./wiki-pages.tsx";
import { type WikiNav, WikiNavProvider, WikiSkeleton } from "./wiki-parts.tsx";

const MINUTE = 60_000;
/** Below this width the main menu leaves the sidebar for the header dropdown. */
const SIDEBAR_BELOW = 1000;

/** Wall clock that ticks once a minute so relative times stay honest. */
function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/** The element's width, kept current with a ResizeObserver (0 until measured). */
function useElementWidth(ref: { current: HTMLElement | null }): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		setWidth(element.getBoundingClientRect().width);
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			if (rect) {
				setWidth(rect.width);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

function routeKey(route: WikiRoute): string {
	switch (route.kind) {
		case "agent":
		case "group":
		case "thread":
			return `${route.kind}:${route.id}`;
		case "index":
			return `index:${route.index}`;
		case "search":
			return `search:${route.query}`;
		default:
			return route.kind;
	}
}

function isTyping(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.tagName === "INPUT" ||
			target.tagName === "TEXTAREA" ||
			target.tagName === "SELECT")
	);
}

// ---------------------------------------------------------------------------
// Page header: title, Article / Talk, Read / View history, tagline
// ---------------------------------------------------------------------------

interface TabSpec {
	id: string;
	label: string;
	onSelect: () => void;
	selected: boolean;
}

function TabButton({ tab }: { tab: TabSpec }) {
	return (
		<li>
			<button
				aria-current={tab.selected ? "page" : undefined}
				className={cn(
					"relative h-10 cursor-pointer rounded-t-[2px] px-2 text-sm outline-none transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
					tab.selected
						? "text-foreground after:bg-foreground"
						: "text-primary hover:after:bg-border"
				)}
				onClick={tab.onSelect}
				type="button"
			>
				{tab.label}
			</button>
		</li>
	);
}

function PageHeader({
	heading,
	headingRef,
	hideTitle,
	leftTabs,
	rightTabs,
	tagline,
}: {
	heading: string;
	headingRef: RefObject<HTMLHeadingElement | null>;
	hideTitle?: boolean;
	leftTabs: TabSpec[];
	rightTabs: TabSpec[];
	tagline: boolean;
}) {
	return (
		<header className="shrink-0">
			{hideTitle ? (
				<h1 className="sr-only" ref={headingRef} tabIndex={-1}>
					{heading}
				</h1>
			) : (
				<h1
					className="border-border border-b pt-6 pb-1 font-normal font-serif text-[28px] text-foreground leading-9 outline-none [overflow-wrap:anywhere]"
					ref={headingRef}
					tabIndex={-1}
				>
					{heading}
				</h1>
			)}
			<div
				className={cn(
					"flex items-end justify-between gap-4",
					hideTitle && "border-border border-b pt-2"
				)}
			>
				<nav aria-label="Namespaces">
					<ul className="-ml-2 flex">
						{leftTabs.map((tab) => (
							<TabButton key={tab.id} tab={tab} />
						))}
					</ul>
				</nav>
				{rightTabs.length > 0 ? (
					<nav aria-label="Views">
						<ul className="-mr-2 flex">
							{rightTabs.map((tab) => (
								<TabButton key={tab.id} tab={tab} />
							))}
						</ul>
					</nav>
				) : null}
			</div>
			{tagline ? (
				<p className="mt-2 text-[13px] text-muted-foreground leading-5">
					From the workspace wiki
				</p>
			) : null}
		</header>
	);
}

// ---------------------------------------------------------------------------
// Wiki
// ---------------------------------------------------------------------------

/**
 * Wiki: the workspace as an encyclopedia in the Vector 2022 layout. Agents,
 * teams, projects and threads each get an article with an infobox, a lead
 * built from live counts, contents and sections; a thread's Talk tab is the
 * host's real conversation (`threadView`).
 */
export function WikiInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const rootRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const idPrefix = useId().replace(/[^a-zA-Z0-9-]/g, "");
	const width = useElementWidth(rootRef);
	const now = useMinuteClock();
	const reduceMotion = useReducedMotion();
	// Unmeasured (server render, tests): assume a desktop window.
	const wide = width === 0 || width >= SIDEBAR_BELOW;

	const [route, setRoute] = useState<WikiRoute>(() =>
		activeThreadId && threadView
			? { id: activeThreadId, kind: "thread" }
			: WIKI_MAIN
	);
	const [tab, setTab] = useState<WikiTab>(() =>
		activeThreadId && threadView ? "talk" : "article"
	);
	const [menuPinned, setMenuPinned] = useState(true);
	const [menuOpen, setMenuOpen] = useState(false);
	const [scrolled, setScrolled] = useState(false);

	const chatOpen = threadView !== null && threadView !== undefined;

	// The host opened a thread (from here or elsewhere): show its Talk page,
	// and keep its article as the page to fall back to when the chat closes.
	useEffect(() => {
		if (chatOpen && activeThreadId) {
			setRoute((current) =>
				current.kind === "thread" && current.id === activeThreadId
					? current
					: { id: activeThreadId, kind: "thread" }
			);
			setTab("talk");
		}
	}, [chatOpen, activeThreadId]);

	let shownTab: WikiTab = tab;
	if (chatOpen) {
		shownTab = "talk";
	} else if (route.kind === "thread" && tab === "talk") {
		shownTab = "article";
	} else if (!routeHasTalk(route)) {
		shownTab = "article";
	}

	const closeChat = useCallback(() => {
		if (chatOpen) {
			port.closeThread();
		}
	}, [chatOpen, port]);

	const go = useCallback(
		(next: WikiRoute) => {
			closeChat();
			setMenuOpen(false);
			setRoute(next);
			setTab("article");
		},
		[closeChat]
	);

	const pageKey = `${routeKey(route)}|${shownTab}|${chatOpen ? "chat" : "page"}`;
	const headingRef = useRef<HTMLHeadingElement>(null);
	const firstPage = useRef(true);
	// A new page starts at the top. When the reader got here from inside the
	// wiki (a link, a tab), focus moves to the new heading, as a page load would.
	useEffect(() => {
		scrollRef.current?.scrollTo({ top: 0 });
		setScrolled(false);
		if (firstPage.current) {
			firstPage.current = false;
			return;
		}
		const active = document.activeElement;
		const fromInside =
			active instanceof HTMLElement &&
			active !== document.body &&
			rootRef.current?.contains(active);
		if (fromInside && !pageKey.endsWith("|chat")) {
			headingRef.current?.focus({ preventScroll: true });
		}
	}, [pageKey]);

	const nav = useMemo<WikiNav>(
		() => ({ current: route, go, idPrefix }),
		[route, go, idPrefix]
	);

	const selectTab = (next: WikiTab) => {
		if (next === "talk" && route.kind === "thread") {
			setTab("talk");
			port.openThread(route.id);
			return;
		}
		closeChat();
		setTab(next);
	};
	// A prompt is sent at once, so this only runs on the user's own submit.
	const startThread = (input: { agentId?: string; prompt: string }) => {
		const { prompt } = input;
		if (route.kind === "agent") {
			port.startThread({ agentId: route.id, prompt });
			return;
		}
		if (route.kind === "group") {
			const group = wikiGroup(snapshot, route.id);
			if (group?.kind === "team") {
				port.startThread({ prompt, teamId: group.id });
				return;
			}
			if (group) {
				port.startThread({ projectId: group.id, prompt });
				return;
			}
		}
		port.startThread(
			input.agentId ? { agentId: input.agentId, prompt } : { prompt }
		);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key === "/" &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey &&
			!isTyping(event.target)
		) {
			event.preventDefault();
			searchRef.current?.focus();
		}
	};

	// --- Heading and tabs -----------------------------------------------------
	const activeThread = wikiThread(snapshot, activeThreadId);
	let heading: string;
	if (chatOpen) {
		heading = `Talk:${activeThread ? wikiThreadTitle(activeThread) : "New thread"}`;
	} else {
		heading = wikiPageHeading(snapshot, route, shownTab);
	}
	const articleLabel = route.kind === "main" ? "Main Page" : "Article";
	let leftTabs: TabSpec[];
	let rightTabs: TabSpec[] = [];
	if (routeHasTalk(route) || chatOpen) {
		leftTabs = [
			{
				id: "article",
				label: articleLabel,
				onSelect: () => selectTab("article"),
				selected: shownTab === "article",
			},
			{
				id: "talk",
				label: "Talk",
				onSelect: () => selectTab("talk"),
				selected: shownTab === "talk",
			},
		];
		rightTabs = [
			{
				id: "read",
				label: "Read",
				onSelect: () =>
					selectTab(shownTab === "history" ? "article" : shownTab),
				selected: shownTab !== "history",
			},
			{
				id: "history",
				label: "View history",
				onSelect: () => selectTab("history"),
				selected: shownTab === "history",
			},
		];
	} else {
		leftTabs = [
			{
				id: "special",
				label:
					route.kind === "index" && route.index !== "threads"
						? "Category"
						: route.kind === "index"
							? "Article"
							: "Special page",
				onSelect: () => undefined,
				selected: true,
			},
		];
	}

	// --- Body -----------------------------------------------------------------
	let body: ReactNode;
	if (loading) {
		body = null;
	} else if (chatOpen) {
		body = (
			<ChatTalk
				snapshot={snapshot}
				threadId={activeThreadId}
				threadView={threadView}
			/>
		);
	} else if (shownTab === "history") {
		body = <HistoryPage route={route} snapshot={snapshot} />;
	} else if (shownTab === "talk") {
		body = (
			<RouteTalk
				now={now}
				onOpenThread={(id) => port.openThread(id)}
				onStart={startThread}
				route={route}
				snapshot={snapshot}
			/>
		);
	} else {
		body = (
			<RouteArticle
				now={now}
				onOpenTalk={() => selectTab("talk")}
				onSearch={(query) => go({ kind: "search", query })}
				onStart={startThread}
				route={route}
				snapshot={snapshot}
			/>
		);
	}

	const showSidebar = wide && menuPinned;
	const fadeIn = reduceMotion
		? { duration: 0 }
		: { duration: 0.14, ease: "easeOut" as const };

	return (
		<WikiNavProvider value={nav}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: listens for the "/" search shortcut bubbling from the page. */}
			<div
				className="@container/wiki flex size-full flex-col overflow-hidden bg-background text-foreground"
				data-testid="interface-wiki"
				onKeyDown={onKeyDown}
				ref={rootRef}
			>
				<WikiHeader
					menuOpen={menuOpen}
					menuPinned={showSidebar}
					onMenuOpenChange={setMenuOpen}
					onPin={
						wide
							? () => {
									setMenuPinned(true);
									setMenuOpen(false);
								}
							: undefined
					}
					onSearch={(query) => go({ kind: "search", query })}
					scrolled={scrolled}
					searchRef={searchRef}
					showMenuButton={!showSidebar}
					snapshot={snapshot}
				/>
				<div
					className={cn(
						"min-h-0 flex-1",
						chatOpen ? "overflow-hidden" : "overflow-y-auto"
					)}
					onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
					ref={scrollRef}
				>
					<div
						className={cn(
							"mx-auto flex w-full max-w-[1280px] gap-8 @[640px]/wiki:px-6 px-4",
							chatOpen && "h-full"
						)}
					>
						{showSidebar ? (
							<aside className="sticky top-0 w-44 shrink-0 self-start pt-6">
								<WikiMainMenu onPinToggle={() => setMenuPinned(false)} pinned />
							</aside>
						) : null}
						<main
							aria-label={heading}
							className={cn(
								"@container/article min-w-0 flex-1",
								chatOpen && "flex h-full flex-col pb-4"
							)}
						>
							{loading ? (
								<WikiSkeleton />
							) : (
								<>
									<PageHeader
										heading={heading}
										headingRef={headingRef}
										hideTitle={
											route.kind === "main" &&
											shownTab === "article" &&
											!chatOpen
										}
										leftTabs={leftTabs}
										rightTabs={rightTabs}
										tagline={
											chatOpen ||
											((route.kind === "agent" ||
												route.kind === "group" ||
												route.kind === "thread") &&
												shownTab !== "history")
										}
									/>
									<motion.div
										animate={{ opacity: 1 }}
										className={cn(chatOpen && "flex min-h-0 flex-1 flex-col")}
										initial={{ opacity: 0 }}
										key={pageKey}
										transition={fadeIn}
									>
										{body}
									</motion.div>
								</>
							)}
						</main>
					</div>
				</div>
			</div>
		</WikiNavProvider>
	);
}

// ---------------------------------------------------------------------------
// Route bodies
// ---------------------------------------------------------------------------

function RouteArticle({
	now,
	onOpenTalk,
	onSearch,
	onStart,
	route,
	snapshot,
}: {
	now: number;
	onOpenTalk: () => void;
	onSearch: (query: string) => void;
	onStart: (input: { agentId?: string; prompt: string }) => void;
	route: WikiRoute;
	snapshot: InterfaceRendererProps<Record<string, never>>["snapshot"];
}) {
	switch (route.kind) {
		case "agent":
			return (
				<div className="pt-4">
					<AgentArticle agentId={route.id} now={now} snapshot={snapshot} />
				</div>
			);
		case "group":
			return (
				<div className="pt-4">
					<GroupArticle groupId={route.id} now={now} snapshot={snapshot} />
				</div>
			);
		case "thread":
			return (
				<div className="pt-4">
					<ThreadArticle
						now={now}
						onOpenTalk={onOpenTalk}
						snapshot={snapshot}
						threadId={route.id}
					/>
				</div>
			);
		case "index":
			return route.index === "threads" ? (
				<ThreadListPage now={now} snapshot={snapshot} />
			) : (
				<CategoryPage index={route.index} snapshot={snapshot} />
			);
		case "changes":
			return <RecentChangesPage snapshot={snapshot} />;
		case "search":
			return (
				<SearchPage
					key={route.query}
					onSearch={onSearch}
					query={route.query}
					snapshot={snapshot}
				/>
			);
		default:
			return <MainPage now={now} onStart={onStart} snapshot={snapshot} />;
	}
}

function RouteTalk({
	now,
	onOpenThread,
	onStart,
	route,
	snapshot,
}: {
	now: number;
	onOpenThread: (threadId: string) => void;
	onStart: (input: { agentId?: string; prompt: string }) => void;
	route: WikiRoute;
	snapshot: InterfaceRendererProps<Record<string, never>>["snapshot"];
}) {
	const title = wikiRouteTitle(snapshot, route);
	if (route.kind === "agent") {
		const agent = wikiAgent(snapshot, route.id);
		return (
			<TalkPage
				intro={
					<>
						This is the talk page for <b className="font-semibold">{title}</b>.
						Each topic is a thread with {title}; adding a topic sends its first
						message to {agent ? title : "the agent"} right away.
					</>
				}
				now={now}
				onOpenThread={onOpenThread}
				onStart={onStart}
				pageTitle={title}
				snapshot={snapshot}
				threads={snapshot.threads
					.filter((thread) => thread.agentIds.includes(route.id))
					.sort(byRecency)}
			/>
		);
	}
	if (route.kind === "group") {
		const group = wikiGroup(snapshot, route.id);
		const noun = group?.kind === "team" ? "team" : "project";
		return (
			<TalkPage
				intro={
					<>
						This is the talk page for the{" "}
						<b className="font-semibold">{title}</b> {noun}. Each topic is a
						thread filed under it; adding a topic starts one right away.
					</>
				}
				now={now}
				onOpenThread={onOpenThread}
				onStart={onStart}
				pageTitle={title}
				snapshot={snapshot}
				threads={snapshot.threads
					.filter((thread) =>
						group?.kind === "team"
							? thread.teamId === route.id
							: thread.projectId === route.id
					)
					.sort(byRecency)}
			/>
		);
	}
	return (
		<TalkPage
			agents={snapshot.agents}
			intro={
				<>
					This is the talk page for the{" "}
					<b className="font-semibold">Main Page</b>. Topics here are threads
					not assigned to an agent; adding a topic starts a thread right away.
				</>
			}
			now={now}
			onOpenThread={onOpenThread}
			onStart={onStart}
			pageTitle="the workspace"
			snapshot={snapshot}
			threads={snapshot.threads
				.filter((thread) => thread.agentIds.length === 0)
				.sort(byRecency)}
		/>
	);
}

/** A thread's Talk tab: the host's own conversation surface, framed. */
function ChatTalk({
	snapshot,
	threadId,
	threadView,
}: {
	snapshot: InterfaceRendererProps<Record<string, never>>["snapshot"];
	threadId: string | null;
	threadView: ReactNode;
}) {
	const thread = wikiThread(snapshot, threadId);
	const names = (thread?.agentIds ?? [])
		.map((id) => wikiAgent(snapshot, id)?.name)
		.filter((name) => name !== undefined);
	const home =
		wikiGroup(snapshot, thread?.projectId) ??
		wikiGroup(snapshot, thread?.teamId);
	let note = "A new conversation. Your first message starts the thread.";
	if (thread) {
		note =
			names.length > 0
				? `Conversation with ${names.join(", ")}${home ? `, filed under ${home.name}` : ""}.`
				: `Conversation${home ? ` filed under ${home.name}` : ""}.`;
	}
	return (
		<>
			<p className="mt-1 mb-3 text-[13px] text-muted-foreground leading-5">
				{note}
			</p>
			<div
				className="flex min-h-0 flex-1 flex-col overflow-hidden border border-border"
				data-testid="wiki-talk-thread"
			>
				{threadView}
			</div>
		</>
	);
}
