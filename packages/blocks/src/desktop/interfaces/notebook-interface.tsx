import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import { FolderClosed, House, Users } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import {
	agentById,
	type InterfaceRendererProps,
} from "./interface-renderer.ts";
import { NotebookHome } from "./notebook-home.tsx";
import {
	allExpandableIds,
	ancestorIdsOf,
	buildNotebookTree,
	groupNodeId,
	initialNotebookExpanded,
	type NotebookGroup,
	notebookEditedLabel,
	notebookNeedsYou,
	notebookPageTitle,
	notebookPlacement,
	notebookStartInput,
	sectionNodeId,
} from "./notebook-model.ts";
import {
	type NotebookCrumb,
	type NotebookPageContext,
	NotebookThreadPage,
	NotebookTopbar,
} from "./notebook-page.tsx";
import { NotebookAgentArt, NotebookPageGlyph } from "./notebook-parts.tsx";
import { NotebookSidebar } from "./notebook-sidebar.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const MINUTE = 60_000;
/** Below this width the sidebar floats over the page instead of beside it. */
const OVERLAY_BELOW = 760;
/** Below this height the properties block starts folded, to keep the chat tall. */
const PROPERTIES_FOLD_BELOW = 720;
const SIDEBAR_WIDTH = 248;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 380;

function clampSidebar(width: number): number {
	return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)));
}

/**
 * Notion's sidebar edge: drag to resize, double-click to reset. Pointer only
 * (like the Sheet's column handles); the fold button covers keyboard users.
 */
function SidebarResizeHandle({
	onResize,
	onResizingChange,
	width,
}: {
	onResize: (width: number) => void;
	onResizingChange: (resizing: boolean) => void;
	width: number;
}) {
	const origin = useRef<{ width: number; x: number } | null>(null);
	const onPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		origin.current = { width, x: event.clientX };
		onResizingChange(true);
	};
	const onPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
		const start = origin.current;
		if (start) {
			onResize(clampSidebar(start.width + event.clientX - start.x));
		}
	};
	const onPointerEnd = (event: PointerEvent<HTMLSpanElement>) => {
		if (!origin.current) {
			return;
		}
		origin.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		onResizingChange(false);
	};
	return (
		<span
			aria-hidden="true"
			className="group/resize absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none"
			onDoubleClick={() => onResize(SIDEBAR_WIDTH)}
			onPointerCancel={onPointerEnd}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
		>
			<span className="absolute inset-y-0 right-0 w-0.5 bg-transparent transition-colors duration-150 group-hover/resize:bg-ring/50 group-active/resize:bg-ring" />
		</span>
	);
}

interface StartInput {
	agentId?: string;
	projectId?: string;
	teamId?: string;
}

/** Wall clock that ticks once a minute so relative times stay honest. */
function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/** The element's size, kept current with a ResizeObserver. */
function useElementSize(ref: { current: HTMLElement | null }): {
	height: number;
	width: number;
} {
	const [size, setSize] = useState({ height: 0, width: 0 });
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const box = element.getBoundingClientRect();
		setSize({ height: box.height, width: box.width });
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			if (rect) {
				setSize({ height: rect.height, width: rect.width });
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

const ICON = "size-4 shrink-0 text-muted-foreground";

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
	const rootRef = useRef<HTMLDivElement>(null);
	const size = useElementSize(rootRef);
	const now = useMinuteClock();
	const reduceMotion = useReducedMotion();
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
	const [draft, setDraft] = useState<StartInput>({});
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
		rootRef.current
			?.querySelector<HTMLElement>('header button[aria-label="Open sidebar"]')
			?.focus();
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
		(input: StartInput) => {
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
					'nav[aria-label="Notebook"] input[type="search"]'
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

	// Ctrl+\ and Ctrl+Shift+F work from anywhere in the window, as the
	// tooltips promise, but leave other apps' text fields alone.
	useEffect(() => {
		const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			const key = event.key.toLowerCase();
			const isSidebarChord = key === "\\" && !event.shiftKey;
			const isSearchChord = key === "f" && event.shiftKey;
			if (
				event.defaultPrevented ||
				!(isSidebarChord || isSearchChord) ||
				!(event.metaKey || event.ctrlKey) ||
				event.altKey
			) {
				return;
			}
			const target = event.target instanceof HTMLElement ? event.target : null;
			const inside = target ? rootRef.current?.contains(target) : false;
			if (!inside && target?.closest("input, textarea, [contenteditable]")) {
				return;
			}
			event.preventDefault();
			if (isSearchChord) {
				focusSearch();
			} else {
				toggleSidebar();
			}
		};
		window.addEventListener("keydown", onWindowKeyDown);
		return () => window.removeEventListener("keydown", onWindowKeyDown);
	}, [focusSearch, toggleSidebar]);

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

	// The page's place in the tree: from the thread, or from how a new page
	// was started (its project, team, or agent).
	const placementSource = thread ?? {
		agentIds: draft.agentId ? [draft.agentId] : [],
		projectId: draft.projectId ?? null,
		teamId: draft.teamId ?? null,
	};
	const placement = notebookPlacement(snapshot, placementSource);
	const context: NotebookPageContext = {
		agents: placementSource.agentIds
			.map((id) => agentById(snapshot, id))
			.filter((agent) => agent !== undefined),
		project:
			snapshot.groups.find(
				(group) =>
					group.kind === "project" && group.id === placementSource.projectId
			)?.name ?? null,
		team:
			snapshot.groups.find(
				(group) => group.kind === "team" && group.id === placementSource.teamId
			)?.name ?? null,
	};
	if (!thread && context.agents.length === 0 && placement.group) {
		const members =
			snapshot.groups.find((group) => group.id === placement.group?.id)
				?.memberAgentIds ?? [];
		context.agents = members
			.map((id) => agentById(snapshot, id))
			.filter((agent) => agent !== undefined);
	}

	let crumbs: NotebookCrumb[];
	if (pageOpen) {
		// Notion's crumbs start at the top-level page: the sidebar section is a
		// heading, not a page, so it is not a crumb.
		const sectionId = sectionNodeId(placement.section);
		crumbs = [];
		const group = placement.group;
		if (group) {
			const groupId = groupNodeId(group.kind, group.id);
			let icon: ReactNode;
			if (group.kind === "agent") {
				icon = (
					<NotebookAgentArt
						agent={agentById(snapshot, group.id)}
						className="size-4"
						shape="tile"
					/>
				);
			} else if (group.kind === "team") {
				icon = <Users aria-hidden="true" className={ICON} />;
			} else {
				icon = <FolderClosed aria-hidden="true" className={ICON} />;
			}
			crumbs.push({
				icon,
				id: groupId,
				label: group.label,
				onSelect: () => reveal([sectionId, groupId]),
			});
		}
		crumbs.push({
			icon: <NotebookPageGlyph />,
			id: "page",
			label: thread ? notebookPageTitle(thread) : "Untitled",
		});
	} else {
		crumbs = [
			{
				icon: <House aria-hidden="true" className={ICON} />,
				id: "home",
				label: "Home",
			},
		];
	}

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
								className="absolute inset-y-0 left-0 z-30 w-[min(17rem,86%)] overflow-hidden border-sidebar-border border-r shadow-2xl"
								exit={{ x: "-100%" }}
								initial={{ x: "-100%" }}
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
							className="relative h-full shrink-0 overflow-hidden border-sidebar-border border-r"
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
					pageOpen ? (thread ? notebookPageTitle(thread) : "Untitled") : "Home"
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
