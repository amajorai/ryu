import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import { AnimatePresence, motion } from "motion/react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useInlineSign } from "./inline-direction.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { NotebookHome } from "./notebook-home.tsx";
import {
	SIDEBAR_WIDTH,
	SidebarResizeHandle,
	useElementSize,
	useMinuteClock,
	useNotebookChords,
} from "./notebook-interface-chrome.tsx";
import {
	type NotebookStartInput,
	notebookPageFrame,
} from "./notebook-interface-crumbs.tsx";
import {
	allExpandableIds,
	ancestorIdsOf,
	buildNotebookTree,
	initialNotebookExpanded,
	type NotebookGroup,
	notebookEditedLabel,
	notebookNeedsYou,
	notebookPageTitle,
	notebookStartInput,
} from "./notebook-model.ts";
import { NotebookThreadPage, NotebookTopbar } from "./notebook-page.tsx";
import { NotebookSidebar } from "./notebook-sidebar.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

/** Below this width the sidebar floats over the page instead of beside it. */
const OVERLAY_BELOW = 760;
/** The top bar's "Open sidebar" button, found by its shortcut: its label is
 * translated copy, so it is never a selector. */
const OPEN_SIDEBAR_BUTTON = 'header button[aria-keyshortcuts="Control+\\\\"]';
/** Below this height the properties block starts folded, to keep the chat tall. */
const PROPERTIES_FOLD_BELOW = 720;

/**
 * Notebook: threads as pages in a Notion-style workspace. The sidebar files
 * every thread under its project, team, or lead agent; opening one shows a
 * page with properties and the host's real conversation as its body. With
 * nothing open, Home greets you with recent pages and what needs you.
 */
export function NotebookInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<Record<string, never>>) {
	const tl = useLiteralMessages();
	const rootRef = useRef<HTMLDivElement>(null);
	const size = useElementSize(rootRef);
	const now = useMinuteClock();
	const reduceMotion = useReducedMotion();
	const inlineSign = useInlineSign();
	// Unmeasured (server render, tests): assume a desktop window.
	const overlay = size.width > 0 && size.width < OVERLAY_BELOW;

	const [query, setQuery] = useState("");
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	// The docked sidebar has finished its exit; only then does the top bar
	// show "Open sidebar", so the two never draw at once.
	const [sidebarGone, setSidebarGone] = useState(false);
	const [overlayOpen, setOverlayOpen] = useState(false);
	const [fullWidth, setFullWidth] = useState(false);
	const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH);
	const [resizing, setResizing] = useState(false);
	const [propertiesChoice, setPropertiesChoice] = useState<boolean | null>(
		null
	);
	const [draft, setDraft] = useState<NotebookStartInput>({});
	const [focusRequest, setFocusRequest] = useState<{
		id: string;
		token: number;
	} | null>(null);

	const tree = useMemo(
		() => buildNotebookTree(snapshot, query),
		[snapshot, query]
	);
	const fullTree = useMemo(() => buildNotebookTree(snapshot), [snapshot]);
	const [expanded, setExpanded] = useState<Set<string>>(() =>
		initialNotebookExpanded(fullTree, activeThreadId)
	);
	const searching = query.trim() !== "";
	const shownExpanded = useMemo(
		() => (searching ? allExpandableIds(tree) : expanded),
		[searching, tree, expanded]
	);

	// Unfold to the open page once per page (it may land in the snapshot after
	// it opens); later folds by the reader stick through live updates.
	const revealedFor = useRef<string | null>(activeThreadId);
	useEffect(() => {
		if (!activeThreadId || revealedFor.current === activeThreadId) {
			return;
		}
		const ancestors = ancestorIdsOf(fullTree, activeThreadId);
		if (ancestors.length === 0) {
			return;
		}
		revealedFor.current = activeThreadId;
		setExpanded((previous) => {
			if (ancestors.every((id) => previous.has(id))) {
				return previous;
			}
			const next = new Set(previous);
			for (const id of ancestors) {
				next.add(id);
			}
			return next;
		});
	}, [fullTree, activeThreadId]);

	const setNodeExpanded = useCallback((id: string, open: boolean) => {
		setExpanded((previous) => {
			if (previous.has(id) === open) {
				return previous;
			}
			const next = new Set(previous);
			if (open) {
				next.add(id);
			} else {
				next.delete(id);
			}
			return next;
		});
	}, []);

	const sidebarVisible = overlay ? overlayOpen : !sidebarCollapsed;
	useEffect(() => {
		if (sidebarVisible) {
			setSidebarGone(false);
		}
	}, [sidebarVisible]);
	const showOpenSidebar = !sidebarVisible && (overlay || sidebarGone);
	const drawerRef = useRef<HTMLElement>(null);
	const scrimRef = useRef<HTMLButtonElement>(null);
	// Move focus into the drawer when it opens, onto the tree's tab stop.
	useEffect(() => {
		if (!(overlay && overlayOpen)) {
			return;
		}
		const frame = window.requestAnimationFrame(() => {
			const target = drawerRef.current?.querySelector<HTMLElement>(
				'[role="treeitem"][tabindex="0"]'
			);
			(
				target ?? drawerRef.current?.querySelector<HTMLElement>("input")
			)?.focus();
		});
		return () => window.cancelAnimationFrame(frame);
	}, [overlay, overlayOpen]);
	// Closing the drawer hands focus back to what opened it (the top bar's
	// "Open sidebar" button, which only mounts once the drawer is gone).
	const restoreFocus = useRef(false);
	useEffect(() => {
		if (overlayOpen || !restoreFocus.current) {
			return;
		}
		restoreFocus.current = false;
		// Leave focus alone if something outside the closing drawer took it.
		const active = document.activeElement;
		const kept =
			active instanceof HTMLElement &&
			active !== document.body &&
			rootRef.current?.contains(active) &&
			!drawerRef.current?.contains(active) &&
			active !== scrimRef.current;
		if (kept) {
			return;
		}
		rootRef.current?.querySelector<HTMLElement>(OPEN_SIDEBAR_BUTTON)?.focus();
	}, [overlayOpen]);
	const closeOverlay = useCallback(() => {
		restoreFocus.current = true;
		setOverlayOpen(false);
	}, []);
	const toggleSidebar = useCallback(() => {
		if (!overlay) {
			setSidebarCollapsed((collapsed) => !collapsed);
		} else if (overlayOpen) {
			closeOverlay();
		} else {
			setOverlayOpen(true);
		}
	}, [closeOverlay, overlay, overlayOpen]);
	const hideSidebar = useCallback(() => {
		if (overlay) {
			closeOverlay();
		} else {
			setSidebarCollapsed(true);
		}
	}, [closeOverlay, overlay]);

	const openPage = useCallback(
		(threadId: string) => {
			closeOverlay();
			setDraft({});
			port.openThread(threadId);
		},
		[closeOverlay, port]
	);
	const startPage = useCallback(
		(input: NotebookStartInput) => {
			closeOverlay();
			setDraft(input);
			port.startThread(input);
		},
		[closeOverlay, port]
	);
	const startInGroup = useCallback(
		(group: NotebookGroup) => {
			setNodeExpanded(group.id, true);
			startPage(notebookStartInput(group));
		},
		[setNodeExpanded, startPage]
	);
	const goHome = useCallback(() => {
		closeOverlay();
		setDraft({});
		if (threadView) {
			port.closeThread();
		}
	}, [closeOverlay, port, threadView]);

	/** Show a crumb's row in the sidebar: unfold to it and focus it. */
	const reveal = useCallback(
		(ids: string[]) => {
			setQuery("");
			for (const id of ids) {
				setNodeExpanded(id, true);
			}
			if (overlay) {
				setOverlayOpen(true);
			} else {
				setSidebarCollapsed(false);
			}
			const target = ids.at(-1);
			if (target) {
				setFocusRequest((previous) => ({
					id: target,
					token: (previous?.token ?? 0) + 1,
				}));
			}
		},
		[overlay, setNodeExpanded]
	);

	// Ctrl/Cmd+Shift+F jumps to Search (Mod+K is the desktop command palette
	// and Mod+F the chat search): show the sidebar, then focus
	// its field once it has mounted (after the drawer's own focus move).
	const [searchRequest, setSearchRequest] = useState(0);
	const focusSearch = useCallback(() => {
		if (overlay) {
			setOverlayOpen(true);
		} else {
			setSidebarCollapsed(false);
		}
		setSearchRequest((count) => count + 1);
	}, [overlay]);
	useEffect(() => {
		if (searchRequest === 0 || !sidebarVisible) {
			return;
		}
		let inner = 0;
		const outer = window.requestAnimationFrame(() => {
			inner = window.requestAnimationFrame(() => {
				const field = rootRef.current?.querySelector<HTMLInputElement>(
					'nav[data-notebook-nav] input[type="search"]'
				);
				field?.focus();
				field?.select();
			});
		});
		return () => {
			window.cancelAnimationFrame(outer);
			window.cancelAnimationFrame(inner);
		};
	}, [searchRequest, sidebarVisible]);

	useNotebookChords(rootRef, focusSearch, toggleSidebar);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape" && overlay && overlayOpen) {
			event.preventDefault();
			closeOverlay();
		}
	};

	const thread: InterfaceThread | null =
		(activeThreadId
			? snapshot.threads.find((item) => item.id === activeThreadId)
			: undefined) ?? null;
	const pageOpen = threadView !== null && threadView !== undefined;
	const propertiesOpen =
		propertiesChoice ??
		(size.height === 0 || size.height >= PROPERTIES_FOLD_BELOW);

	const { context, crumbs } = notebookPageFrame({
		draft,
		pageOpen,
		reveal,
		snapshot,
		thread,
		tl,
	});

	const needsYouCount = notebookNeedsYou(
		snapshot,
		Number.POSITIVE_INFINITY
	).length;
	const sidebar = (
		<NotebookSidebar
			activeThreadId={pageOpen ? activeThreadId : null}
			expanded={shownExpanded}
			focusRequest={focusRequest}
			homeActive={!pageOpen}
			loading={loading}
			needsYouCount={needsYouCount}
			onClose={hideSidebar}
			onHome={goHome}
			onNewPage={() => startPage({})}
			onOpen={openPage}
			onQueryChange={setQuery}
			onSetExpanded={setNodeExpanded}
			onStart={startInGroup}
			overlay={overlay}
			query={query}
			sections={tree}
			snapshot={snapshot}
		/>
	);
	const slide = reduceMotion
		? { duration: 0 }
		: { duration: 0.2, ease: [0.2, 0, 0, 1] as const };

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: listens for Escape bubbling from the overlay sidebar.
		<div
			className="relative flex size-full overflow-hidden bg-background text-foreground"
			data-testid="interface-notebook"
			onKeyDown={onKeyDown}
			ref={rootRef}
		>
			{overlay ? (
				<AnimatePresence>
					{overlayOpen ? (
						<>
							<motion.button
								animate={{ opacity: 1 }}
								aria-label="Close sidebar"
								className="absolute inset-0 z-20 cursor-default bg-foreground/15"
								exit={{ opacity: 0 }}
								initial={{ opacity: 0 }}
								key="scrim"
								onClick={closeOverlay}
								ref={scrimRef}
								tabIndex={-1}
								transition={slide}
								type="button"
							/>
							<motion.aside
								animate={{ x: 0 }}
								className="absolute inset-y-0 start-0 z-30 w-[min(17rem,86%)] overflow-hidden border-sidebar-border border-e shadow-2xl"
								exit={{ x: `${-100 * inlineSign}%` }}
								initial={{ x: `${-100 * inlineSign}%` }}
								key="drawer"
								ref={drawerRef}
								transition={slide}
							>
								{sidebar}
							</motion.aside>
						</>
					) : null}
				</AnimatePresence>
			) : (
				<AnimatePresence
					initial={false}
					onExitComplete={() => setSidebarGone(true)}
				>
					{sidebarVisible ? (
						<motion.aside
							animate={{ width: sidebarWidth }}
							className="relative h-full shrink-0 overflow-hidden border-sidebar-border border-e"
							exit={{ width: 0 }}
							initial={{ width: 0 }}
							key="sidebar"
							transition={resizing ? { duration: 0 } : slide}
						>
							<div className="h-full" style={{ width: sidebarWidth }}>
								{sidebar}
							</div>
							<SidebarResizeHandle
								onResize={setSidebarWidth}
								onResizingChange={setResizing}
								width={sidebarWidth}
							/>
						</motion.aside>
					) : null}
				</AnimatePresence>
			)}

			<main
				aria-label={
					pageOpen
						? thread
							? notebookPageTitle(thread)
							: tl("Untitled")
						: tl("Home")
				}
				className="@container/notebook flex min-w-0 flex-1 flex-col"
			>
				<NotebookTopbar
					crumbs={crumbs}
					edited={
						pageOpen && thread
							? {
									iso: thread.updatedAt,
									label: notebookEditedLabel(thread.updatedAt, now),
								}
							: null
					}
					fullWidth={fullWidth}
					onClosePage={pageOpen ? () => port.closeThread() : undefined}
					onShowSidebar={showOpenSidebar ? toggleSidebar : undefined}
					onToggleFullWidth={() => setFullWidth((value) => !value)}
					properties={
						pageOpen
							? {
									onToggle: () => setPropertiesChoice(!propertiesOpen),
									open: propertiesOpen,
								}
							: undefined
					}
				/>
				{pageOpen ? (
					<NotebookThreadPage
						context={context}
						fullWidth={fullWidth}
						now={now}
						onToggleProperties={() => setPropertiesChoice(!propertiesOpen)}
						propertiesOpen={propertiesOpen}
						thread={thread}
						threadView={threadView}
					/>
				) : (
					<NotebookHome
						fullWidth={fullWidth}
						loading={loading}
						now={now}
						onNewPage={() => startPage({})}
						onOpen={openPage}
						snapshot={snapshot}
					/>
				)}
			</main>
		</div>
	);
}
