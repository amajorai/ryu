import type {
	InterfaceParamsByRenderer,
	InterfaceSettingValue,
	ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { AnimatePresence, motion } from "motion/react";
import {
	type ComponentType,
	type CSSProperties,
	type KeyboardEvent,
	lazy,
	type PointerEvent,
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import {
	KnowledgeControls,
	KnowledgeControlsButton,
} from "./knowledge-controls.tsx";
import { KnowledgeFlat } from "./knowledge-flat.tsx";
import {
	useHidden,
	useKnowledgeTheme,
	useNow,
	useSize,
	useWidth,
} from "./knowledge-hooks.ts";
import {
	adjacency,
	buildKnowledgeGraph,
	createLayout,
	cycleNode,
	DEFAULT_SETTINGS,
	displayLabel,
	type ForceSettings,
	filterGraph,
	KIND_LABELS,
	type KnowledgeGraph,
	type KnowledgeNode,
	type KnowledgeSettings,
	type Layout,
	nodeId,
	orderNodes,
	plural,
	reheat,
	replayLayout,
	sameSettings,
	searchNodes,
	settingsFromParams,
	settleLayout,
	warmTicks,
} from "./knowledge-model.ts";
import { cssColor, knowledgePalette } from "./knowledge-palette.ts";
import { KnowledgePanel, type KnowledgePanelView } from "./knowledge-panel.tsx";
import {
	KnowledgeEmpty,
	KnowledgeLabels,
	KnowledgeLegend,
	KnowledgeLegendButton,
	KnowledgeNodeList,
	KnowledgeSceneBoundary,
	KnowledgeSkeleton,
	KnowledgeZoom,
	type SkeletonOutline,
} from "./knowledge-parts.tsx";
import {
	buildStyles,
	type CameraApi,
	chromeObstacles,
	createProjection,
	type KnowledgeRendererProps,
	openingPose,
	pickNode,
	projectPose,
	syncLabels,
} from "./knowledge-stage.ts";
import { useWebGLSupport } from "./planets-hooks.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/** Stands in when the WebGL chunk fails to load: hands over to 2D at once. */
function SceneUnavailable({ onLost }: KnowledgeRendererProps) {
	useEffect(() => {
		onLost?.();
	}, [onLost]);
	return null;
}

const KnowledgeScene = lazy<ComponentType<KnowledgeRendererProps>>(() =>
	import("./knowledge-scene.tsx").catch(() => ({ default: SceneUnavailable }))
);

const EMPTY_GRAPH: KnowledgeGraph = { links: [], nodes: [] };

/** Ticks run up front under reduced motion, so the graph appears settled. */
const SETTLE_TICKS = 320;
/**
 * Below this width the settings panel starts folded, and a side panel that
 * leaves the graph less than this folds it while it is open.
 */
const COMPACT_WIDTH = 1100;
/** If the 3D view has not drawn a frame by now, the 2D renderer takes over. */
const FIRST_FRAME_TIMEOUT_MS = 12_000;
/** Room the settings card takes on the right (its width plus gutters). */
const CARD_INSET = 288;
/** Pointer travel (px) that turns a click into a drag. */
const DRAG_SLOP = 5;

function forcesOf(settings: KnowledgeSettings, aspect: number): ForceSettings {
	return {
		aspect,
		centerForce: settings.centerForce,
		linkDistance: settings.linkDistance,
		linkForce: settings.linkForce,
		repelForce: settings.repelForce,
	};
}

/**
 * Height over width of the room the graph gets (clear of the header and the
 * legend), in tenths so a resize only re-shapes the layout when the shape
 * really changes. Measured on the whole interface, not the stage, so opening
 * a side panel or the settings card never re-shapes the graph.
 */
function stageAspect(size: { height: number; width: number } | null): number {
	if (!size || size.width <= 0 || size.height <= 0) {
		return 1;
	}
	const width = Math.max(120, size.width - 32);
	const height = Math.max(120, size.height - 116);
	return Math.round((height / width) * 10) / 10;
}

/** Escape and arrow keys inside a text field belong to the field. */
function isTextField(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.closest("input, textarea, select, [contenteditable='true']") !==
				null)
	);
}

/** Width the side panel takes beside the graph (its widest breakpoint). */
function sidePanelWidth(threadOpen: boolean, nodeSelected: boolean): number {
	if (threadOpen) {
		return 480;
	}
	return nodeSelected ? 360 : 0;
}

/**
 * Knowledge: the workspace as an Obsidian-style knowledge graph, in 3D.
 * Agents, projects, teams, conversations and the topics they share are nodes
 * in a force-directed layout; hover lights a node's neighbourhood, search
 * dims everything it does not match, and the settings panel filters kinds,
 * switches to a local graph around the selection and tunes the forces.
 * Selecting a node opens a side panel with its links; selecting a
 * conversation shows the host's own thread view there.
 */
export function KnowledgeInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<InterfaceParamsByRenderer["knowledge"]>) {
	const rootRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const focusHeading = useRef(false);
	const cameraApi = useRef<CameraApi | null>(null);
	const labels = useRef(new Map<string, HTMLElement>());
	const pointer = useRef<{ x: number; y: number } | null>(null);
	const previousLayout = useRef<Layout | null>(null);
	/** The last global layout: leaving local mode returns nodes to it. */
	const globalLayout = useRef<Layout | null>(null);
	const chromeRef = useRef<HTMLDivElement>(null);

	const reduced = useReducedMotion();
	const webgl = useWebGLSupport();
	const theme = useKnowledgeTheme(rootRef);
	const agentNames = snapshot.agents.map((agent) => agent.name).join("\n");
	const palette = useMemo(
		() => knowledgePalette(theme, agentNames ? agentNames.split("\n") : []),
		[theme, agentNames]
	);
	const hidden = useHidden(rootRef);
	const now = useNow();
	const width = useWidth(rootRef);
	const rootSize = useSize(rootRef);
	const stageSectionRef = useRef<HTMLElement>(null);
	const stageSize = useSize(stageSectionRef);

	// The Graph settings panel: the live params, changed in place and saved
	// through `updateSettings`; a new param from the host replaces them.
	const fromParams = settingsFromParams(params);
	const [settings, setSettings] = useState<KnowledgeSettings>(fromParams);
	const [seenParams, setSeenParams] = useState<KnowledgeSettings>(fromParams);
	if (!sameSettings(seenParams, fromParams)) {
		setSeenParams(fromParams);
		setSettings(fromParams);
	}
	const [query, setQuery] = useState("");
	const [controlsOpen, setControlsOpen] = useState<boolean | null>(null);
	/** The user reopened the settings while a side panel had folded them. */
	const [controlsOverride, setControlsOverride] = useState(false);
	const [hovered, setHovered] = useState<string | null>(null);
	const [cursor, setCursor] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [originId, setOriginId] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState("");
	/** The WebGL view failed (lost context, failed chunk, no first frame). */
	const [glFailed, setGlFailed] = useState(false);
	/** Which renderer ("3d" or "2d") has drawn its first frame. */
	const [drawn, setDrawn] = useState<"2d" | "3d" | null>(null);

	const graph = useMemo(
		() => buildKnowledgeGraph(snapshot, { messages: settings.messages }),
		[snapshot, settings.messages]
	);
	const topicCount = useMemo(
		() => graph.nodes.filter((node) => node.kind === "topic").length,
		[graph]
	);
	const nodesById = useMemo(
		() => new Map(graph.nodes.map((node) => [node.id, node])),
		[graph]
	);
	const threadOpen = threadView !== null;
	const activeThread = activeThreadId
		? snapshot.threads.find((thread) => thread.id === activeThreadId)
		: undefined;
	const threadNodeId = activeThread
		? nodeId.conversation(activeThread.id)
		: null;
	let selected: string | null = null;
	if (threadOpen) {
		selected = threadNodeId;
	} else if (selectedId && nodesById.has(selectedId)) {
		selected = selectedId;
	}
	const selectedNode = selected ? nodesById.get(selected) : undefined;

	const local =
		settings.mode === "local" && selected
			? { depth: settings.depth, id: selected }
			: null;
	const visible = useMemo(
		() =>
			filterGraph(graph, {
				agents: settings.agents,
				conversations: settings.conversations,
				groups: settings.groups,
				local,
				orphans: settings.orphans,
				topics: settings.topics,
			}),
		[
			graph,
			settings.agents,
			settings.conversations,
			settings.groups,
			settings.orphans,
			settings.topics,
			local?.id,
			local?.depth,
		]
	);
	const links = useMemo(() => adjacency(visible.links), [visible]);
	const ordered = useMemo(() => orderNodes(visible.nodes), [visible]);

	const flat = webgl?.supported === false || glFailed;
	const dims = flat ? 2 : 3;
	const rendererKind = flat ? "2d" : "3d";
	const sceneReady = drawn === rendererKind;
	// The settings card starts folded on narrow windows; after that it stays
	// as the user left it, except that it folds while a side panel leaves the
	// graph cramped, and comes back as it was when the panel closes.
	const panelWidth = sidePanelWidth(threadOpen, selectedNode !== undefined);
	const cramped =
		panelWidth > 0 &&
		width !== null &&
		width > 0 &&
		width - panelWidth < COMPACT_WIDTH;
	const isEmpty =
		!loading && snapshot.agents.length === 0 && snapshot.threads.length === 0;
	useEffect(() => {
		if (controlsOpen === null && width !== null && width > 0) {
			setControlsOpen(width >= COMPACT_WIDTH);
		}
	}, [controlsOpen, width]);
	useEffect(() => {
		if (!cramped) {
			setControlsOverride(false);
		}
	}, [cramped]);
	// A zero width means "not laid out yet" (first frame, tests): stay open.
	const preferControls =
		controlsOpen ?? !(width !== null && width > 0 && width < COMPACT_WIDTH);
	const showControls = preferControls && (!cramped || controlsOverride);
	const openControls = () => {
		setControlsOpen(true);
		if (cramped) {
			setControlsOverride(true);
		}
	};
	// Beside a side panel on a narrow window the reopened card floats over
	// the graph: the fit uses the whole stage rather than a strip beside it.
	const insetRight =
		showControls && !cramped && !(loading || isEmpty) ? CARD_INSET : 0;
	// The layout's shape comes from the whole interface, not the stage, so a
	// side panel or the settings card never re-shapes the graph.
	const aspect = stageAspect(rootSize);
	const forces = forcesOf(settings, aspect);
	const forcesRef = useRef(forces);
	forcesRef.current = forces;
	const isLocal = local !== null;
	// The layout waits for the interface's and the stage's sizes (read
	// before the first paint), so it settles once, for the shape it is shown
	// in, and never visibly drifts into shape after mount.
	const sized = rootSize !== null && stageSize !== null;
	const layout = useMemo(() => {
		if (!sized) {
			return createLayout(EMPTY_GRAPH, dims);
		}
		// Back from a local graph, nodes return to where the global graph
		// left them (as in Obsidian); otherwise they keep their last spot.
		const seed = isLocal
			? previousLayout.current
			: (globalLayout.current ?? previousLayout.current);
		const next = createLayout(visible, dims, seed);
		settleLayout(
			next,
			forcesRef.current,
			reduced ? SETTLE_TICKS : warmTicks(next.ids.length)
		);
		return next;
	}, [visible, dims, reduced, isLocal, sized]);
	useEffect(() => {
		previousLayout.current = layout;
		if (!isLocal) {
			globalLayout.current = layout;
		}
	}, [layout, isLocal]);
	const projection = useMemo(
		() => createProjection(layout.ids.length),
		[layout]
	);

	// A force change wakes the layout (or re-settles it at once). The
	// layout's shape follows the whole interface (a window resize), never a
	// side panel or the settings card: those reframe the camera but never
	// rearrange the graph.
	const forceKey = `${aspect}|${settings.centerForce}|${settings.linkDistance}|${settings.linkForce}|${settings.repelForce}`;
	const lastForce = useRef({ key: forceKey, layout });
	useEffect(() => {
		const last = lastForce.current;
		lastForce.current = { key: forceKey, layout };
		// A new layout was settled with the current forces already.
		if (last.key === forceKey || last.layout !== layout) {
			return;
		}
		reheat(layout, 0.5);
		if (reduced) {
			settleLayout(layout, forcesRef.current, SETTLE_TICKS);
		}
	}, [forceKey, layout, reduced]);

	const matches = useMemo(
		() => searchNodes(visible.nodes, query),
		[visible, query]
	);
	const results = useMemo(
		() => ordered.filter((node) => matches.has(node.id)),
		[ordered, matches]
	);
	const emphasisHover = hovered ?? cursor;
	const styles = useMemo(
		() =>
			buildStyles(
				visible,
				layout,
				links,
				palette,
				{
					hovered: emphasisHover,
					matches,
					query: query.trim().length > 0,
					selected,
				},
				settings.nodeSize
			),
		[
			visible,
			layout,
			links,
			palette,
			emphasisHover,
			matches,
			query,
			selected,
			settings.nodeSize,
		]
	);
	const legend = useMemo(() => {
		const statuses = new Set<ThreadStatus>();
		const kinds = new Set<KnowledgeNode["kind"]>();
		const agents: string[] = [];
		for (const node of visible.nodes) {
			kinds.add(node.kind);
			if (node.status) {
				statuses.add(node.status);
			}
			if (node.kind === "agent") {
				agents.push(node.label);
			}
		}
		return { agents, kinds, statuses };
	}, [visible]);

	// The camera eases to whatever gets selected (a renderer that mounts
	// later picks the selection up through `focusId`). Hover is re-picked by
	// the next pointer move, so a stale neighbourhood never outlives a change.
	useEffect(() => {
		setHovered(null);
		if (selected) {
			cameraApi.current?.focus(selected);
		}
	}, [selected]);

	let view: KnowledgePanelView | null = null;
	if (threadOpen) {
		view = {
			kind: "thread",
			origin: (originId && nodesById.get(originId)) || null,
			thread: activeThread,
		};
	} else if (selectedNode) {
		view = { kind: "node", node: selectedNode };
	}
	const viewKey = view
		? `${view.kind}:${selected ?? ""}:${activeThreadId ?? ""}`
		: "";
	useLayoutEffect(() => {
		if (!(viewKey && focusHeading.current)) {
			return;
		}
		focusHeading.current = false;
		headingRef.current?.focus();
	}, [viewKey]);

	const register = useCallback((id: string, element: HTMLElement | null) => {
		if (element) {
			labels.current.set(id, element);
		} else {
			labels.current.delete(id);
		}
	}, []);

	const select = (id: string, options: { focus?: boolean } = {}) => {
		const node = nodesById.get(id);
		if (!node) {
			return;
		}
		focusHeading.current = options.focus ?? true;
		if (node.kind === "conversation") {
			if (selectedNode && selectedNode.kind !== "conversation") {
				setOriginId(selectedNode.id);
			} else if (!threadOpen) {
				setOriginId(null);
			}
			setSelectedId(id);
			port.openThread(node.refId);
			setAnnouncement(`Opened ${node.label}`);
			return;
		}
		if (threadOpen) {
			port.closeThread();
		}
		setSelectedId(id);
		setAnnouncement(`${KIND_LABELS[node.kind]} ${displayLabel(node)} selected`);
	};
	const openThread = (threadId: string) => {
		select(nodeId.conversation(threadId));
	};
	const close = () => {
		if (threadOpen) {
			port.closeThread();
		}
		setSelectedId(null);
		setOriginId(null);
		setAnnouncement("Selection cleared");
	};
	const back = () => {
		port.closeThread();
		focusHeading.current = originId !== null;
		setSelectedId(originId);
		setOriginId(null);
	};
	const newThread = (node: KnowledgeNode) => {
		if (node.kind === "agent") {
			port.startThread({ agentId: node.refId });
		} else if (node.kind === "project") {
			port.startThread({ projectId: node.refId });
		} else if (node.kind === "team") {
			port.startThread({ teamId: node.refId });
		} else {
			port.startThread({});
		}
	};
	const saveSettings = (next: Partial<KnowledgeSettings>) => {
		setSettings((previous) => ({ ...previous, ...next }));
		port.updateSettings?.(next as Record<string, InterfaceSettingValue>);
	};
	// Restore defaults: forget the user's settings so the interface's own
	// defaults and params apply (they arrive as new params). Without the
	// port's reset, save the renderer's defaults instead.
	const restoreSettings = () => {
		if (port.resetSettings) {
			port.resetSettings();
			setSettings(fromParams);
			return;
		}
		saveSettings(DEFAULT_SETTINGS);
	};

	/** Escape steps out: thread → its origin, selection → none, search → empty. */
	const stepBack = (): boolean => {
		if (threadOpen) {
			back();
			return true;
		}
		if (selected) {
			close();
			return true;
		}
		if (query) {
			setQuery("");
			return true;
		}
		return false;
	};
	const stepBackRef = useRef(stepBack);
	stepBackRef.current = stepBack;
	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key !== "Escape" ||
			event.defaultPrevented ||
			isTextField(event.target) ||
			(event.target instanceof HTMLElement &&
				event.target.closest("[data-knowledge-thread]") !== null)
		) {
			return;
		}
		if (stepBackRef.current()) {
			event.preventDefault();
		}
	};

	/** The graph region's keys: arrows walk nodes, Enter opens, +/- zoom. */
	const onSceneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.target !== event.currentTarget) {
			return;
		}
		const key = event.key;
		if (
			key === "ArrowRight" ||
			key === "ArrowDown" ||
			key === "ArrowLeft" ||
			key === "ArrowUp"
		) {
			event.preventDefault();
			const next = cycleNode(
				ordered,
				cursor ?? selected,
				key === "ArrowRight" || key === "ArrowDown" ? 1 : -1
			);
			setCursor(next);
			setHovered(null);
			const node = next ? nodesById.get(next) : undefined;
			if (node) {
				cameraApi.current?.reveal(node.id);
				setAnnouncement(
					`${displayLabel(node)}, ${KIND_LABELS[node.kind].toLowerCase()}, ${plural(node.degree, "link")}`
				);
			}
		} else if (key === "Enter" || key === " ") {
			event.preventDefault();
			const target = cursor ?? ordered[0]?.id;
			if (target) {
				select(target, { focus: false });
			}
		} else if (key === "+" || key === "=") {
			event.preventDefault();
			cameraApi.current?.zoom(0.74);
		} else if (key === "-" || key === "_") {
			event.preventDefault();
			cameraApi.current?.zoom(1.35);
		} else if (key === "0") {
			event.preventDefault();
			cameraApi.current?.reset();
		} else if (key === "/") {
			event.preventDefault();
			if (searchRef.current) {
				searchRef.current.focus();
				return;
			}
			openControls();
			requestAnimationFrame(() => searchRef.current?.focus());
		}
	};

	const pick = (event: PointerEvent<HTMLDivElement>) => {
		const stage = stageRef.current;
		if (!stage) {
			return null;
		}
		const rect = stage.getBoundingClientRect();
		return pickNode(
			layout,
			projection,
			event.clientX - rect.left,
			event.clientY - rect.top
		);
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		if (event.buttons !== 0) {
			return;
		}
		const id = pick(event);
		if (id !== hovered) {
			setHovered(id);
		}
	};
	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		pointer.current = { x: event.clientX, y: event.clientY };
		setCursor(null);
	};
	const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		const start = pointer.current;
		pointer.current = null;
		if (
			!start ||
			event.button !== 0 ||
			Math.hypot(event.clientX - start.x, event.clientY - start.y) > DRAG_SLOP
		) {
			return;
		}
		const id = pick(event);
		if (id) {
			select(id, { focus: false });
		}
	};

	const hasGraph = !(loading || isEmpty) && sized;
	const ready = hasGraph && webgl !== null;

	// The loading outline is the layout projected through the pose the 3D
	// view opens with, measured before the first paint (labels included,
	// since the fit leaves room for them), so nodes fade in exactly where
	// their outline sat.
	const [outline, setOutline] = useState<SkeletonOutline | null>(null);
	const needsOutline = hasGraph && !flat && !sceneReady;
	useLayoutEffect(() => {
		if (!(needsOutline && stageSize)) {
			return;
		}
		const stage = { ...stageSize, insetRight };
		const pose = openingPose(
			layout,
			stage,
			labels.current,
			forcesRef.current.linkDistance
		);
		const pairs: [number, number][] = [];
		for (let link = 0; link < layout.links.length / 2; link += 1) {
			pairs.push([
				layout.links[link * 2] ?? 0,
				layout.links[link * 2 + 1] ?? 0,
			]);
		}
		const nodes = projectPose(layout, pose, stageSize, settings.nodeSize);
		const count = layout.ids.length;
		const paint = {
			agents: layout.ids.map((_, index) => (styles.agent[index] ?? 0) > 0),
			background: cssColor(palette.background),
			link: cssColor(palette.link, palette.linkAlpha),
			nodes: layout.ids.map((_, index) =>
				cssColor(
					[
						Math.round((styles.colors[index * 3] ?? 0) * 255),
						Math.round((styles.colors[index * 3 + 1] ?? 0) * 255),
						Math.round((styles.colors[index * 3 + 2] ?? 0) * 255),
					],
					styles.alpha[index] ?? 1
				)
			),
		};
		// Labels take their places for the preview too, from the same
		// projection, so the first frame reads in full before WebGL is up.
		const preview = createProjection(count);
		for (const [index, [x, y, radius]] of nodes.entries()) {
			preview.x[index] = x;
			preview.y[index] = y;
			preview.radius[index] = radius;
			preview.visible[index] = 1;
		}
		syncLabels(layout, preview, styles, styles.alpha, labels.current, {
			height: stageSize.height,
			obstacles: chromeObstacles(stageRef.current, [
				...(stageSectionRef.current?.querySelectorAll<HTMLElement>(
					"[data-knowledge-chrome]"
				) ?? []),
			]),
			textFade: settings.textFade,
			width: stageSize.width,
		});
		setOutline({
			height: stageSize.height,
			links: pairs,
			nodes,
			paint,
			width: stageSize.width,
		});
	}, [
		needsOutline,
		layout,
		stageSize,
		insetRight,
		settings.nodeSize,
		settings.textFade,
		styles,
		palette,
	]);

	// The chrome over the stage (settings sections folding, the legend)
	// changes shape without new props: ask the renderer for a frame so the
	// labels move clear of it.
	useEffect(() => {
		const row = chromeRef.current;
		if (!row || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(() => cameraApi.current?.invalidate());
		for (const element of row.querySelectorAll<HTMLElement>(
			"[data-knowledge-chrome]"
		)) {
			observer.observe(element);
		}
		observer.observe(row);
		return () => observer.disconnect();
	});

	// The 3D view must draw within a while; a stalled one (no frame, no
	// error) hands over to 2D rather than leaving an empty stage.
	useEffect(() => {
		if (!ready || flat || sceneReady || hidden) {
			return;
		}
		const timer = window.setTimeout(
			() => setGlFailed(true),
			FIRST_FRAME_TIMEOUT_MS
		);
		return () => window.clearTimeout(timer);
	}, [ready, flat, sceneReady, hidden]);
	const onReady = useCallback(() => setDrawn(rendererKind), [rendererKind]);
	const onLost = useCallback(() => setGlFailed(true), []);
	const obstacles = useCallback(
		() =>
			chromeObstacles(stageRef.current, [
				...(stageSectionRef.current?.querySelectorAll<HTMLElement>(
					"[data-knowledge-chrome]"
				) ?? []),
			]),
		[]
	);
	const replay = () => {
		replayLayout(layout);
		if (reduced) {
			settleLayout(layout, forcesRef.current, SETTLE_TICKS);
		}
		cameraApi.current?.reset();
		setAnnouncement("Layout restarted");
	};
	const localTitle =
		settings.mode === "local" && selectedNode
			? `Local graph of ${displayLabel(selectedNode)}`
			: "Knowledge graph";
	const sceneLabel = loading
		? "Knowledge graph, loading"
		: `${localTitle}: ${plural(visible.nodes.length, "node")} and ${plural(visible.links.length, "link")}. Arrow keys move between nodes, Enter opens one, plus and minus zoom, slash searches.`;
	const rendererProps: KnowledgeRendererProps = {
		cameraApi,
		focusId: selected,
		forces,
		insetRight,
		labels: labels.current,
		layout,
		linkWidth: settings.linkWidth,
		obstacles,
		onLost,
		onReady,
		palette,
		paused: hidden,
		projection,
		quality: webgl?.quality ?? "low",
		reduced,
		styles,
		textFade: settings.textFade,
	};

	let settingsControl: ReactNode = null;
	if (hasGraph && showControls) {
		settingsControl = (
			<KnowledgeControls
				hasSelection={selected !== null}
				onAnimate={replay}
				onChange={saveSettings}
				onClose={() => {
					setControlsOpen(false);
					setControlsOverride(false);
				}}
				onPick={(id) => {
					setQuery("");
					select(id);
				}}
				onQueryChange={setQuery}
				onQuerySubmit={() => {
					const first = results[0];
					if (first) {
						setQuery("");
						select(first.id);
					}
				}}
				onReset={restoreSettings}
				query={query}
				results={results}
				searchRef={searchRef}
				settings={settings}
				topicCount={topicCount}
			/>
		);
	} else if (hasGraph) {
		settingsControl = <KnowledgeControlsButton onOpen={openControls} />;
	}

	return (
		<div
			className="@container/knowledge relative flex size-full min-h-0 overflow-hidden bg-background text-foreground"
			data-mode={palette.mode}
			data-testid="interface-knowledge"
			onKeyDown={onRootKeyDown}
			ref={rootRef}
		>
			<section
				aria-busy={loading}
				aria-label="Knowledge"
				className="@container/stage relative isolate min-h-0 min-w-0 flex-1 overflow-hidden"
				ref={stageSectionRef}
				style={
					{
						"--knowledge-halo": cssColor(palette.background),
						backgroundColor: cssColor(palette.background),
					} as CSSProperties
				}
			>
				<div
					aria-label={sceneLabel}
					aria-roledescription="knowledge graph"
					className="absolute inset-0 opacity-0 outline-none transition-opacity duration-300 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset data-[hover=true]:cursor-pointer data-[ready=true]:opacity-100 data-[cursor=true]:ring-0 motion-reduce:transition-none"
					data-cursor={cursor ? "true" : "false"}
					data-hover={hovered ? "true" : "false"}
					data-ready={sceneReady || outline?.paint ? "true" : "false"}
					onBlur={() => setCursor(null)}
					onKeyDown={onSceneKeyDown}
					onPointerDown={onPointerDown}
					onPointerLeave={() => setHovered(null)}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					ref={stageRef}
					role="application"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the graph is a keyboard-driven canvas (role="application").
					tabIndex={0}
				>
					{ready && !flat ? (
						<KnowledgeSceneBoundary onError={onLost}>
							<Suspense fallback={null}>
								<KnowledgeScene {...rendererProps} />
							</Suspense>
						</KnowledgeSceneBoundary>
					) : null}
					{ready && flat ? <KnowledgeFlat {...rendererProps} /> : null}
					{hasGraph ? (
						<KnowledgeLabels nodes={visible.nodes} register={register} />
					) : null}
				</div>

				<AnimatePresence>
					{loading || needsOutline ? (
						<motion.div
							animate={{ opacity: 1 }}
							className="pointer-events-none absolute inset-0"
							exit={{ opacity: 0, transition: { duration: 0.2 } }}
							initial={false}
							key="skeleton"
						>
							<KnowledgeSkeleton outline={loading ? null : outline} />
						</motion.div>
					) : null}
				</AnimatePresence>

				<div
					className="pointer-events-none absolute inset-0 z-20 flex flex-col justify-between gap-3 p-3 sm:p-4"
					ref={chromeRef}
				>
					<div className="flex min-h-0 items-start justify-between gap-3">
						<header
							className="flex min-w-0 flex-col gap-0.5 pt-1.5"
							data-knowledge-chrome="band"
						>
							<h2 className="truncate font-semibold text-base text-foreground leading-6">
								{localTitle}
							</h2>
							<p className="text-[13px] text-muted-foreground tabular-nums leading-5">
								{loading
									? "Loading workspace"
									: `${plural(visible.nodes.length, "node")} · ${plural(visible.links.length, "link")}`}
							</p>
						</header>
						{settingsControl}
					</div>
					{ready ? (
						<div className="flex items-end justify-between gap-3">
							<div
								className="@min-[620px]/stage:block hidden min-w-0"
								data-knowledge-chrome=""
							>
								<KnowledgeLegend
									agents={legend.agents}
									kinds={legend.kinds}
									palette={palette}
									statuses={legend.statuses}
								/>
							</div>
							<div
								className="@min-[620px]/stage:hidden"
								data-knowledge-chrome=""
							>
								<KnowledgeLegendButton
									agents={legend.agents}
									kinds={legend.kinds}
									palette={palette}
									statuses={legend.statuses}
								/>
							</div>
							<div className="ms-auto" data-knowledge-chrome="">
								<KnowledgeZoom
									onFit={() => cameraApi.current?.reset()}
									onZoom={(factor) => cameraApi.current?.zoom(factor)}
								/>
							</div>
						</div>
					) : null}
				</div>

				<AnimatePresence>
					{isEmpty ? (
						<motion.div
							animate={{ opacity: 1 }}
							className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-6"
							initial={reduced ? false : { opacity: 0 }}
							key="empty"
						>
							<KnowledgeEmpty onStart={() => port.startThread({})} />
						</motion.div>
					) : null}
				</AnimatePresence>
				{ready ? (
					<KnowledgeNodeList
						nodes={ordered}
						onSelect={(id) => select(id)}
						selectedId={selected}
					/>
				) : null}
				<p aria-live="polite" className="sr-only">
					{announcement}
				</p>
			</section>
			{view ? (
				<KnowledgePanel
					graph={graph}
					headingRef={headingRef}
					now={now}
					onBack={back}
					onClose={close}
					onNewThread={newThread}
					onOpenThread={openThread}
					onSelect={(id) => select(id)}
					palette={palette}
					snapshot={snapshot}
					threadView={threadView}
					view={view}
				/>
			) : null}
		</div>
	);
}
