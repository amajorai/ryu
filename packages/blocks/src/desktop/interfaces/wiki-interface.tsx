import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import {
	type KeyboardEvent,
	type ReactNode,
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
import { WikiHeader, WikiMainMenu } from "./wiki-chrome.tsx";
import { PageHeader, type TabSpec } from "./wiki-interface-page-header.tsx";
import {
	ChatTalk,
	RouteArticle,
	RouteTalk,
} from "./wiki-interface-route-bodies.tsx";
import {
	routeHasTalk,
	WIKI_MAIN,
	type WikiRoute,
	type WikiTab,
	wikiGroup,
	wikiPageHeading,
	wikiThread,
	wikiThreadTitle,
} from "./wiki-model.ts";
import { HistoryPage } from "./wiki-pages.tsx";
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
