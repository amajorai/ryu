import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import {
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import {
	compactAge,
	type InterfaceRendererProps,
} from "./interface-renderer.ts";
import { MindmapCanvas } from "./mindmap-canvas.tsx";
import { MINDMAP_ZOOM_STEP, useMindmapView } from "./mindmap-hooks.ts";
import {
	buildMindmapTree,
	estimateSize,
	initialCollapsed,
	layoutMindmap,
	MINDMAP_HEIGHT,
	MINDMAP_ROOT_ID,
	type MindmapNode,
	type MindmapSize,
	mindmapStats,
	moveFocus,
	visibleAncestor,
} from "./mindmap-model.ts";
import type { MindmapNodeEvents } from "./mindmap-node.tsx";
import { MindmapThreadPanel } from "./mindmap-panel.tsx";
import {
	MindmapControls,
	MindmapEmpty,
	MindmapHeader,
	MindmapLegend,
	MindmapLoading,
} from "./mindmap-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const HOVER_LINGER_MS = 140;

function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.tagName === "SELECT"
	);
}

function platformModKey(): string {
	if (typeof navigator === "undefined") {
		return "Ctrl";
	}
	return /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
}

const NAV_KEYS = new Set([
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"Home",
]);

/**
 * Mind Map interface (MindNode / XMind): you at the centre; projects, teams,
 * and "Direct" branch out left and right; agents hang off each branch, and
 * threads are the leaves. Branches fold, the map pans and zooms, arrow keys
 * walk the tree, and an open thread docks the host's chat beside the map.
 */
export function MindmapInterface({
	activeThreadId,
	loading,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["mindmap"]>) {
	const describedBy = useId();
	const reducedMotion = useReducedMotion();
	const animate = !reducedMotion;
	const rootRef = useRef<HTMLDivElement>(null);
	const treeRef = useRef<HTMLDivElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);

	const [showAll, setShowAll] = useState<ReadonlySet<string>>(() => new Set());
	const tree = useMemo(
		() => buildMindmapTree(snapshot, showAll),
		[showAll, snapshot]
	);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() =>
		initialCollapsed(buildMindmapTree(snapshot))
	);
	const [sizes, setSizes] = useState<ReadonlyMap<string, MindmapSize>>(
		() => new Map()
	);
	const sizeOf = useCallback(
		(node: MindmapNode): MindmapSize => {
			const measured = sizes.get(node.id);
			return measured
				? { height: MINDMAP_HEIGHT[node.kind], width: measured.width }
				: estimateSize(node);
		},
		[sizes]
	);
	const layout = useMemo(
		() => layoutMindmap(tree, collapsed, sizeOf),
		[collapsed, sizeOf, tree]
	);
	const threadOpen = threadView !== null && threadView !== undefined;
	// While a thread is open, its leaf stays in view as the map reflows.
	const focusBox =
		threadOpen && activeThreadId
			? layout.placed.get(`thread:${activeThreadId}`)
			: undefined;
	const controller = useMindmapView(layout.bounds, focusBox);
	const { reveal, touch } = controller;

	const [pickedId, setPickedId] = useState(MINDMAP_ROOT_ID);
	const selectedId = visibleAncestor(tree, layout, pickedId);
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingFocus = useRef<string | null>(null);

	const agents = useMemo(
		() => new Map(snapshot.agents.map((agent) => [agent.id, agent])),
		[snapshot.agents]
	);
	const threads = useMemo(
		() => new Map(snapshot.threads.map((thread) => [thread.id, thread])),
		[snapshot.threads]
	);
	const stats = useMemo(() => mindmapStats(snapshot), [snapshot]);
	const activeThread = activeThreadId ? threads.get(activeThreadId) : undefined;

	const onMeasure = useCallback((updates: Map<string, MindmapSize>) => {
		setSizes((current) => {
			const next = new Map(current);
			for (const [id, size] of updates) {
				next.set(id, size);
			}
			return next;
		});
	}, []);

	// Focus (and frame) a node once it is on the map.
	const focusNode = useCallback((id: string) => {
		pendingFocus.current = id;
		setPickedId(id);
	}, []);
	useEffect(() => {
		const id = pendingFocus.current;
		if (!id) {
			return;
		}
		const box = layout.placed.get(id);
		if (!box) {
			return;
		}
		pendingFocus.current = null;
		const element = treeRef.current?.querySelector<HTMLElement>(
			`[data-mindmap-node="${CSS.escape(id)}"]`
		);
		element?.focus({ preventScroll: true });
		reveal(box);
	});

	// An opened thread is always findable: unfold its path, then select it.
	const syncedThread = useRef<string | null>(null);
	useEffect(() => {
		if (!activeThreadId || syncedThread.current === activeThreadId) {
			return;
		}
		const nodeId = `thread:${activeThreadId}`;
		const node = tree.nodes.get(nodeId);
		if (!node) {
			for (const candidate of tree.nodes.values()) {
				if (
					candidate.kind === "more" &&
					candidate.parentId &&
					candidate.hiddenThreadIds.includes(activeThreadId)
				) {
					const parentId = candidate.parentId;
					setShowAll((current) => new Set([...current, parentId]));
					return;
				}
			}
			syncedThread.current = activeThreadId;
			return;
		}
		syncedThread.current = activeThreadId;
		const ancestors: string[] = [];
		let parentId = node.parentId;
		while (parentId) {
			ancestors.push(parentId);
			parentId = tree.nodes.get(parentId)?.parentId ?? null;
		}
		setCollapsed((current) => {
			if (!ancestors.some((id) => current.has(id))) {
				return current;
			}
			const next = new Set(current);
			for (const id of ancestors) {
				next.delete(id);
			}
			return next;
		});
		setPickedId(nodeId);
	}, [activeThreadId, tree]);

	const toggle = useCallback(
		(node: MindmapNode) => {
			if (node.kind === "root" || node.childIds.length === 0) {
				return;
			}
			touch();
			setCollapsed((current) => {
				const next = new Set(current);
				if (next.has(node.id)) {
					next.delete(node.id);
				} else {
					next.add(node.id);
				}
				return next;
			});
		},
		[touch]
	);

	const start = useCallback(
		(node: MindmapNode) => {
			const scope: { projectId?: string; teamId?: string } = {};
			if (node.groupKind === "project" && node.groupId) {
				scope.projectId = node.groupId;
			} else if (node.groupKind === "team" && node.groupId) {
				scope.teamId = node.groupId;
			}
			if (node.kind === "agent" && node.agentId) {
				port.startThread({ agentId: node.agentId, ...scope });
			} else {
				port.startThread(scope);
			}
		},
		[port]
	);

	const activate = useCallback(
		(node: MindmapNode) => {
			if (node.kind === "thread" && node.threadId) {
				port.openThread(node.threadId);
			} else if (node.kind === "more" && node.parentId) {
				const parentId = node.parentId;
				setShowAll((current) => new Set([...current, parentId]));
				focusNode(parentId);
			} else {
				toggle(node);
			}
		},
		[focusNode, port, toggle]
	);

	const handleNodeKey = useCallback(
		(node: MindmapNode, event: { key: string; preventDefault: () => void }) => {
			if (NAV_KEYS.has(event.key)) {
				event.preventDefault();
				const move = moveFocus(tree, layout, collapsed, node.id, event.key);
				if (move?.kind === "expand") {
					toggle(node);
				} else if (move) {
					focusNode(move.id);
				}
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				activate(node);
				return;
			}
			if (event.key === " ") {
				event.preventDefault();
				if (node.kind === "more") {
					activate(node);
				} else {
					toggle(node);
				}
				return;
			}
			if (
				event.key === "+" &&
				(node.kind === "agent" || node.kind === "group")
			) {
				event.preventDefault();
				start(node);
			}
		},
		[activate, collapsed, focusNode, layout, start, toggle, tree]
	);

	const setHover = useCallback((id: string | null) => {
		if (hoverTimer.current) {
			clearTimeout(hoverTimer.current);
			hoverTimer.current = null;
		}
		if (id) {
			setHoveredId(id);
			return;
		}
		hoverTimer.current = setTimeout(() => setHoveredId(null), HOVER_LINGER_MS);
	}, []);
	useEffect(
		() => () => {
			if (hoverTimer.current) {
				clearTimeout(hoverTimer.current);
			}
		},
		[]
	);

	const events = useMemo<MindmapNodeEvents>(
		() => ({
			onActivate: (node: MindmapNode, event: MouseEvent<HTMLElement>) => {
				setPickedId(node.id);
				event.currentTarget.focus({ preventScroll: true });
				if (node.kind === "thread" || node.kind === "more") {
					activate(node);
				}
			},
			onDoubleActivate: (node: MindmapNode) => {
				if (node.kind === "agent" || node.kind === "group") {
					toggle(node);
				}
			},
			onFocusNode: (node: MindmapNode) => setPickedId(node.id),
			onHover: setHover,
			onKeyDown: (node: MindmapNode, event: KeyboardEvent<HTMLElement>) =>
				handleNodeKey(node, event),
		}),
		[activate, handleNodeKey, setHover, toggle]
	);

	const allFolded = useMemo(() => {
		const root = tree.nodes.get(tree.rootId);
		return Boolean(
			root &&
				root.childIds.length > 0 &&
				root.childIds.every((id) => collapsed.has(id))
		);
	}, [collapsed, tree]);
	const toggleAll = useCallback(() => {
		touch();
		const root = tree.nodes.get(tree.rootId);
		if (allFolded || !root) {
			setCollapsed(new Set());
		} else {
			setCollapsed(new Set(root.childIds));
		}
		// Refit after the structure settles, so the overview fills the screen.
		requestAnimationFrame(() => controller.fit());
	}, [allFolded, controller, touch, tree]);

	const closeThread = useCallback(() => {
		port.closeThread();
		if (activeThreadId) {
			focusNode(`thread:${activeThreadId}`);
		}
	}, [activeThreadId, focusNode, port]);

	// Shortcuts that work anywhere in the interface (and from <body>, so the
	// map answers keys before anything is focused). Typing fields keep theirs.
	const onWindowKey = (event: globalThis.KeyboardEvent) => {
		const target = event.target;
		const fromBody = target === document.body;
		const inside =
			fromBody || (target instanceof Node && rootRef.current?.contains(target));
		if (
			!inside ||
			event.defaultPrevented ||
			isEditableTarget(target) ||
			isInterfaceCovered(rootRef.current)
		) {
			return;
		}
		const mod = event.metaKey || event.ctrlKey;
		if (event.key === "Escape" && threadOpen) {
			event.preventDefault();
			closeThread();
			return;
		}
		if (mod && (event.key === "=" || event.key === "+")) {
			event.preventDefault();
			controller.zoomBy(MINDMAP_ZOOM_STEP);
			return;
		}
		if (mod && event.key === "-") {
			event.preventDefault();
			controller.zoomBy(1 / MINDMAP_ZOOM_STEP);
			return;
		}
		if (mod && event.key === "0") {
			event.preventDefault();
			controller.resetZoom();
			return;
		}
		if (event.shiftKey && !mod && event.code === "Digit1") {
			event.preventDefault();
			controller.fit();
			return;
		}
		if (event.altKey && !mod && event.code === "Period") {
			event.preventDefault();
			toggleAll();
			return;
		}
		// From <body>, hand map keys to the selected node.
		if (fromBody && !mod) {
			const node = tree.nodes.get(selectedId);
			if (
				node &&
				(NAV_KEYS.has(event.key) ||
					event.key === "Enter" ||
					event.key === " " ||
					event.key === "+")
			) {
				handleNodeKey(node, event);
			}
		}
	};
	const onWindowKeyRef = useRef(onWindowKey);
	onWindowKeyRef.current = onWindowKey;
	useEffect(() => {
		const listener = (event: globalThis.KeyboardEvent) =>
			onWindowKeyRef.current(event);
		window.addEventListener("keydown", listener);
		return () => window.removeEventListener("keydown", listener);
	}, []);

	const ageOf = useCallback(
		(node: MindmapNode) => {
			const thread = node.threadId ? threads.get(node.threadId) : undefined;
			return thread ? compactAge(thread.updatedAt) : "";
		},
		[threads]
	);

	const activeBranch = useMemo(() => {
		const node = activeThreadId
			? tree.nodes.get(`thread:${activeThreadId}`)
			: undefined;
		let current = node;
		while (current && current.kind !== "group") {
			current = current.parentId ? tree.nodes.get(current.parentId) : undefined;
		}
		return current?.label ?? null;
	}, [activeThreadId, tree]);

	const panel = threadOpen ? (
		<MindmapThreadPanel
			animate={animate}
			branchLabel={activeBranch}
			headingRef={headingRef}
			onClose={closeThread}
			snapshot={snapshot}
			thread={activeThread}
			threadView={threadView}
		/>
	) : null;

	if (
		loading &&
		snapshot.agents.length === 0 &&
		snapshot.threads.length === 0
	) {
		return <MindmapLoading />;
	}

	if (snapshot.agents.length === 0 && snapshot.threads.length === 0) {
		return (
			<div
				className="@container relative flex size-full min-h-0 overflow-hidden bg-background text-foreground"
				data-testid="interface-mindmap"
				ref={rootRef}
			>
				<div className="flex min-w-0 flex-1 p-6">
					<MindmapEmpty onStart={() => port.startThread({})} />
				</div>
				{panel}
			</div>
		);
	}

	return (
		<div
			aria-busy={loading || undefined}
			className="@container relative flex size-full min-h-0 overflow-hidden bg-background text-foreground"
			data-testid="interface-mindmap"
			ref={rootRef}
		>
			<div className="flex min-w-0 flex-1 flex-col">
				<MindmapHeader onStart={() => port.startThread({})} stats={stats} />
				<div className="relative min-h-0 flex-1">
					<MindmapCanvas
						activeThreadId={threadOpen ? activeThreadId : null}
						agents={agents}
						ageOf={ageOf}
						animate={animate}
						collapsed={collapsed}
						controller={controller}
						describedBy={describedBy}
						events={events}
						hoveredId={hoveredId}
						layout={layout}
						onMeasure={onMeasure}
						onStart={start}
						onToggle={toggle}
						selectedId={selectedId}
						sizes={sizes}
						tree={tree}
						treeRef={treeRef}
					/>
					<MindmapLegend />
					<MindmapControls
						allFolded={allFolded}
						modKey={platformModKey()}
						onFit={controller.fit}
						onResetZoom={controller.resetZoom}
						onToggleAll={toggleAll}
						onZoomIn={() => controller.zoomBy(MINDMAP_ZOOM_STEP)}
						onZoomOut={() => controller.zoomBy(1 / MINDMAP_ZOOM_STEP)}
						zoom={controller.view.k}
					/>
					<p className="sr-only" id={describedBy}>
						Arrow keys move between a node, its parent, its children, and its
						neighbours. Space folds or unfolds a branch. Enter opens a thread.
						Plus starts a thread with the selected agent.
					</p>
				</div>
			</div>
			{panel}
		</div>
	);
}
