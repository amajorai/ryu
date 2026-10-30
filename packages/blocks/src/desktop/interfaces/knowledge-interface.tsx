import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import {
	type ReactNode,
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
import {
	useHidden,
	useKnowledgeTheme,
	useNow,
	useSize,
	useWidth,
} from "./knowledge-hooks.ts";
import { useKnowledgeInteractions } from "./knowledge-interface-interactions.ts";
import {
	CARD_INSET,
	COMPACT_WIDTH,
	FIRST_FRAME_TIMEOUT_MS,
	SETTLE_TICKS,
	sidePanelWidth,
	useKnowledgeLayout,
} from "./knowledge-interface-layout.ts";
import { useKnowledgeOutline } from "./knowledge-interface-outline.ts";
import { useKnowledgeStyles } from "./knowledge-interface-styles.ts";
import { KnowledgeInterfaceView } from "./knowledge-interface-view.tsx";
import {
	buildKnowledgeGraph,
	displayLabel,
	filterGraph,
	type KnowledgeSettings,
	nodeId,
	orderNodes,
	replayLayout,
	sameSettings,
	settingsFromParams,
	settleLayout,
} from "./knowledge-model.ts";
import { knowledgePalette } from "./knowledge-palette.ts";
import type { KnowledgePanelView } from "./knowledge-panel.tsx";
import {
	type CameraApi,
	chromeObstacles,
	type KnowledgeRendererProps,
} from "./knowledge-stage.ts";
import { useWebGLSupport } from "./planets-hooks.ts";
import { useReducedMotion } from "./reduced-motion.ts";

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
	const chromeRef = useRef<HTMLDivElement>(null);

	const tl = useLiteralMessages();
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
	const isLocal = local !== null;
	const { forces, forcesRef, layout, projection, sized } = useKnowledgeLayout({
		dims,
		isLocal,
		reduced,
		rootSize,
		settings,
		stageSize,
		visible,
	});

	const { legend, results, styles } = useKnowledgeStyles({
		cursor,
		hovered,
		layout,
		ordered,
		palette,
		query,
		selected,
		settings,
		visible,
	});

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
	const actions = useKnowledgeInteractions({
		cameraApi,
		cursor,
		focusHeading,
		fromParams,
		hovered,
		layout,
		nodesById,
		openControls,
		ordered,
		originId,
		port,
		projection,
		query,
		searchRef,
		selected,
		selectedNode,
		setAnnouncement,
		setCursor,
		setHovered,
		setOriginId,
		setQuery,
		setSelectedId,
		setSettings,
		stageRef,
		threadOpen,
	});
	const { restoreSettings, saveSettings, select } = actions;

	const hasGraph = !(loading || isEmpty) && sized;
	const ready = hasGraph && webgl !== null;

	const { needsOutline, outline } = useKnowledgeOutline({
		flat,
		forcesRef,
		hasGraph,
		insetRight,
		labels,
		layout,
		palette,
		sceneReady,
		settings,
		stageRef,
		stageSectionRef,
		stageSize,
		styles,
	});

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
			? tl("Local graph of {name}", { name: displayLabel(selectedNode) })
			: "Knowledge graph";
	const sceneLabel = loading
		? "Knowledge graph, loading"
		: tl(
				"{localTitle}: {nodes, plural, one {{nodeCount} node} other {{nodeCount} nodes}} and {links, plural, one {{linkCount} link} other {{linkCount} links}}. Arrow keys move between nodes, Enter opens one, plus and minus zoom, slash searches.",
				{
					linkCount: String(visible.links.length),
					links: visible.links.length,
					localTitle,
					nodeCount: String(visible.nodes.length),
					nodes: visible.nodes.length,
				}
			);
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
		<KnowledgeInterfaceView
			actions={actions}
			announcement={announcement}
			cameraApi={cameraApi}
			chromeRef={chromeRef}
			cursor={cursor}
			flat={flat}
			graph={graph}
			hasGraph={hasGraph}
			headingRef={headingRef}
			hovered={hovered}
			isEmpty={isEmpty}
			legend={legend}
			loading={loading}
			localTitle={localTitle}
			needsOutline={needsOutline}
			now={now}
			onLost={onLost}
			ordered={ordered}
			outline={outline}
			palette={palette}
			port={port}
			ready={ready}
			reduced={reduced}
			register={register}
			rendererProps={rendererProps}
			rootRef={rootRef}
			sceneLabel={sceneLabel}
			sceneReady={sceneReady}
			selected={selected}
			setCursor={setCursor}
			setHovered={setHovered}
			settingsControl={settingsControl}
			snapshot={snapshot}
			stageRef={stageRef}
			stageSectionRef={stageSectionRef}
			threadView={threadView}
			view={view}
			visible={visible}
		/>
	);
}
