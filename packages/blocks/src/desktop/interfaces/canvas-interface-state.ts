import type { CanvasParams } from "@ryuhq/protocol/interfaces";
import { animate } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useElementSize, useMinuteClock } from "./canvas-hooks.ts";
import {
	CAMERA_GLIDE_MS,
	type ComposerState,
	DROP_TIMEOUT_MS,
	MINIMAP_DEFAULT_WIDTH,
	MINIMAP_MIN_WIDTH,
	type PendingDrop,
} from "./canvas-interface-constants.ts";
import type {
	CanvasBaseScope,
	CanvasBoardScope,
	CanvasCameraScope,
} from "./canvas-interface-scope.ts";
import {
	buildCanvasLayout,
	type CanvasArrange,
	type CanvasCamera,
	type CanvasPoint,
	type CanvasPositions,
	canvasSummary,
	cardPosition,
	interpolateCamera,
	loadPositions,
	newThreadIds,
	overridesForThreads,
	savePositions,
} from "./canvas-model.ts";
import type { CanvasTool } from "./canvas-toolbar.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { useInterfaceSetting } from "./use-interface-setting.ts";

/** The canvas's host inputs, measured elements and arrangement. */
export function useCanvasBase(
	props: Pick<
		InterfaceRendererProps<CanvasParams>,
		"activeThreadId" | "loading" | "params" | "port" | "snapshot" | "threadView"
	>
) {
	const { activeThreadId, loading, params, port, snapshot, threadView } = props;
	const reduceMotion = useReducedMotion();
	const now = useMinuteClock();
	const rootRef = useRef<HTMLDivElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const rootSize = useElementSize(rootRef);
	const viewport = useElementSize(viewportRef);
	const viewportRefSize = useRef(viewport);
	viewportRefSize.current = viewport;

	// Arrangement: the host's param, which the header can switch locally.
	const [arrange, setArrange] = useInterfaceSetting<CanvasArrange>(
		port,
		"arrange",
		params.arrange
	);
	const summary = useMemo(() => canvasSummary(snapshot), [snapshot]);
	return {
		activeThreadId,
		loading,
		params,
		port,
		snapshot,
		threadView,
		reduceMotion,
		now,
		rootRef,
		viewportRef,
		rootSize,
		viewport,
		viewportRefSize,
		arrange,
		setArrange,
		summary,
	};
}

/** Per-viewer positions, the pending drop and the board layout. */
export function useCanvasBoard(scope: CanvasBaseScope) {
	const { arrange, rootSize, snapshot } = scope;
	// Per-viewer positions, persisted in browser storage.
	const [positions, setPositions] = useState<CanvasPositions>(loadPositions);
	const positionsDirty = useRef(false);
	const updatePositions = useCallback(
		(update: (previous: CanvasPositions) => CanvasPositions) => {
			positionsDirty.current = true;
			setPositions(update);
		},
		[]
	);
	useEffect(() => {
		if (positionsDirty.current) {
			savePositions(positions);
		}
	}, [positions]);

	// A sticky written from the composer lands where it was written, from the
	// first frame the host's new thread appears in (never in a frame slot).
	const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);
	const createdId = useMemo(
		() =>
			pendingDrop
				? newThreadIds(pendingDrop.known, snapshot.threads)[0]
				: undefined,
		[pendingDrop, snapshot.threads]
	);
	useEffect(() => {
		if (!pendingDrop) {
			return;
		}
		const timer = window.setTimeout(
			() => setPendingDrop(null),
			DROP_TIMEOUT_MS
		);
		return () => window.clearTimeout(timer);
	}, [pendingDrop]);

	const overrides = useMemo(() => {
		const known = overridesForThreads(positions[arrange], snapshot.threads);
		if (pendingDrop && createdId && pendingDrop.arrange === arrange) {
			known[createdId] = {
				x: Math.round(pendingDrop.world.x),
				y: Math.round(pendingDrop.world.y),
			};
		}
		return known;
	}, [positions, arrange, snapshot.threads, pendingDrop, createdId]);

	// A phone-width canvas stacks the frames in one scrolling column.
	const rootWidth = rootSize.width;
	const portrait = rootWidth > 0 && rootWidth < MINIMAP_MIN_WIDTH;
	const layout = useMemo(
		() => buildCanvasLayout(snapshot, arrange, overrides, { portrait }),
		[snapshot, arrange, overrides, portrait]
	);
	const cardsById = useMemo(
		() => new Map(layout.cards.map((card) => [card.id, card])),
		[layout]
	);
	/** The layout as it would be with one sticky moved to `point`. */
	const projectLayout = useCallback(
		(id: string, point: CanvasPoint) => {
			const next = { ...overrides, [id]: point };
			return {
				layout: buildCanvasLayout(snapshot, arrange, next, { portrait }),
				overrides: next,
			};
		},
		[snapshot, arrange, overrides, portrait]
	);
	const projectLayoutRef = useRef(projectLayout);
	useEffect(() => {
		projectLayoutRef.current = projectLayout;
	}, [projectLayout]);
	const layoutRef = useRef(layout);
	useEffect(() => {
		layoutRef.current = layout;
	}, [layout]);
	return {
		positions,
		updatePositions,
		pendingDrop,
		setPendingDrop,
		createdId,
		overrides,
		rootWidth,
		portrait,
		layout,
		cardsById,
		projectLayoutRef,
		layoutRef,
	};
}

/** The camera and its glides. */
export function useCanvasCamera(scope: CanvasBoardScope) {
	const { reduceMotion, viewportRefSize } = scope;
	// Camera.
	const [camera, setCamera] = useState<CanvasCamera>({ x: 0, y: 0, zoom: 1 });
	const cameraRef = useRef(camera);
	const animationRef = useRef<{ stop: () => void } | null>(null);
	const setCameraNow = useCallback((next: CanvasCamera) => {
		cameraRef.current = next;
		setCamera(next);
	}, []);
	const moveCamera = useCallback(
		(next: CanvasCamera, animated = true) => {
			animationRef.current?.stop();
			animationRef.current = null;
			const from = cameraRef.current;
			const size = viewportRefSize.current;
			// Nothing to watch before layout (or when asked for less motion).
			if (!animated || reduceMotion || size.width <= 0) {
				setCameraNow(next);
				return;
			}
			const glide = animate(0, 1, {
				duration: CAMERA_GLIDE_MS / 1000,
				ease: [0.2, 0, 0, 1],
				onUpdate: (t) => setCameraNow(interpolateCamera(from, next, size, t)),
			});
			// The glide is driven by animation frames, which a busy or
			// background page can starve: land on the target regardless, so a
			// move asked for (a keyboard shortcut, a reveal) always happens.
			const landing = window.setTimeout(() => {
				if (animationRef.current === controls) {
					glide.stop();
					animationRef.current = null;
					setCameraNow(next);
				}
			}, CAMERA_GLIDE_MS + 80);
			const controls = {
				stop: () => {
					window.clearTimeout(landing);
					glide.stop();
				},
			};
			animationRef.current = controls;
		},
		[reduceMotion, setCameraNow]
	);
	useEffect(() => () => animationRef.current?.stop(), []);
	/** The last view the canvas chose by itself (opening fit, docking refit). */
	const autoCameraRef = useRef<CanvasCamera | null>(null);
	const moveCameraAuto = useCallback(
		(next: CanvasCamera, animated = true) => {
			autoCameraRef.current = next;
			moveCamera(next, animated);
		},
		[moveCamera]
	);
	return {
		camera,
		cameraRef,
		animationRef,
		setCameraNow,
		moveCamera,
		autoCameraRef,
		moveCameraAuto,
	};
}

/** Selection, stacking, tools, the composer and the minimap. */
export function useCanvasSelection(scope: CanvasCameraScope) {
	const { activeThreadId, cardsById, overrides, params, port, viewport } =
		scope;
	// Selection, stacking, tools.
	const [selectedId, setSelectedId] = useState<string | null>(activeThreadId);
	const [seenActive, setSeenActive] = useState(activeThreadId);
	if (seenActive !== activeThreadId) {
		setSeenActive(activeThreadId);
		if (activeThreadId) {
			setSelectedId(activeThreadId);
		}
	}
	const [raised, setRaised] = useState<string[]>([]);
	const raise = useCallback((id: string) => {
		setRaised((previous) =>
			previous.at(-1) === id
				? previous
				: [...previous.filter((item) => item !== id), id]
		);
	}, []);
	const [tool, setTool] = useState<CanvasTool>("select");
	const [spaceHeld, setSpaceHeld] = useState(false);
	const [panning, setPanning] = useState(false);
	const [drag, setDrag] = useState<{ id: string; point: CanvasPoint } | null>(
		null
	);
	// Stickies glide (not jump) when the layout repacks; `except` stays put.
	const [glide, setGlide] = useState<{ except: string | null } | null>(null);
	const glideTimerRef = useRef(0);
	const startGlide = useCallback((except: string | null = null) => {
		window.clearTimeout(glideTimerRef.current);
		setGlide({ except });
		glideTimerRef.current = window.setTimeout(() => setGlide(null), 600);
	}, []);
	useEffect(() => () => window.clearTimeout(glideTimerRef.current), []);
	const [composer, setComposer] = useState<ComposerState | null>(null);
	const [minimap, setMinimap] = useInterfaceSetting(
		port,
		"minimap",
		params.minimap
	);
	const minimapChoice = minimap === "auto" ? null : minimap === "shown";
	const minimapShown =
		viewport.width >= MINIMAP_MIN_WIDTH &&
		(minimapChoice ?? viewport.width >= MINIMAP_DEFAULT_WIDTH);
	const minimapShownRef = useRef(minimapShown);
	minimapShownRef.current = minimapShown;

	const livePosition = useCallback(
		(id: string): CanvasPoint | undefined => {
			if (drag?.id === id) {
				return drag.point;
			}
			const card = cardsById.get(id);
			return card ? cardPosition(card, overrides) : undefined;
		},
		[cardsById, drag, overrides]
	);
	const livePositionRef = useRef(livePosition);
	useEffect(() => {
		livePositionRef.current = livePosition;
	}, [livePosition]);
	return {
		selectedId,
		setSelectedId,
		raised,
		raise,
		tool,
		setTool,
		spaceHeld,
		setSpaceHeld,
		panning,
		setPanning,
		drag,
		setDrag,
		glide,
		startGlide,
		composer,
		setComposer,
		minimap,
		setMinimap,
		minimapShown,
		minimapShownRef,
		livePosition,
		livePositionRef,
	};
}
