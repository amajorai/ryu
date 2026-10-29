import { cn } from "@ryu/ui/lib/utils";
import type { CanvasParams } from "@ryuhq/protocol/interfaces";
import { AnimatePresence, animate } from "motion/react";
import {
	type CSSProperties,
	type FocusEvent,
	type KeyboardEvent,
	type MouseEvent,
	type PointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CanvasCard } from "./canvas-card.tsx";
import { CanvasComposer } from "./canvas-composer.tsx";
import { CanvasFrame } from "./canvas-frame.tsx";
import {
	isBoardTarget,
	isTypingTarget,
	useElementSize,
	useMinuteClock,
} from "./canvas-hooks.ts";
import {
	CanvasMinimap,
	MINIMAP_HEIGHT,
	MINIMAP_WIDTH,
	type MinimapCard,
} from "./canvas-minimap.tsx";
import {
	buildCanvasLayout,
	CARD_HEIGHT,
	CARD_WIDTH,
	type CanvasArrange,
	type CanvasCamera,
	type CanvasClearance,
	type CanvasEdge,
	type CanvasLayout,
	type CanvasPoint,
	type CanvasPositions,
	type CanvasRect,
	type CanvasViewport,
	COMPACT_ZOOM,
	canvasSummary,
	cardPosition,
	cardRect,
	centerOn,
	contentBounds,
	FRAME_HEADER,
	findFreeSpot,
	fitCameraClear,
	fitCameraInsets,
	fitFrames,
	gridSpacing,
	interpolateCamera,
	loadPositions,
	NUDGE,
	NUDGE_LARGE,
	newThreadIds,
	offscreenCards,
	openingCamera,
	overridesForThreads,
	placeClearSticky,
	rectInView,
	rectsOverlap,
	revealRect,
	savePositions,
	screenToWorld,
	stepZoom,
	unionRects,
	visibleWorldRect,
	worldToScreen,
	zoomAt,
} from "./canvas-model.ts";
import { CanvasThreadPanel } from "./canvas-panel.tsx";
import {
	CanvasEdgeHints,
	CanvasEmpty,
	CanvasHeader,
	CanvasSkeleton,
} from "./canvas-parts.tsx";
import { type CanvasTool, CanvasToolbar } from "./canvas-toolbar.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { useInterfaceSetting } from "./use-interface-setting.ts";

/** Below this width the open thread covers the canvas instead of docking. */
const DOCK_MIN_WIDTH = 768;
/** Pointer travel (px) before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 3;
/** A dropped sticky waits this long for the host to create its thread. */
const DROP_TIMEOUT_MS = 15_000;
const SAFE_TOP = 64;
const SAFE_BOTTOM = 76;
/** The minimap can show from this viewport width up. */
const MINIMAP_MIN_WIDTH = 640;
/** Below this width it starts hidden, so it does not sit on the stickies. */
const MINIMAP_DEFAULT_WIDTH = 1100;
/** A window narrower than that fits the opening board down to this zoom. */
const NARROW_FLOOR = 0.5;
/**
 * Off-screen pills sit in the dock's row, never over a sticky: "left" before
 * the tools, the rest after them. A phone-width dock has no room beside it,
 * so there only "below" joins the dock and the others float at their edge.
 */
const DOCK_EDGES_BEFORE: readonly CanvasEdge[] = ["left"];
const DOCK_EDGES_AFTER: readonly CanvasEdge[] = ["top", "bottom", "right"];
const NO_EDGES: readonly CanvasEdge[] = [];
const PHONE_DOCK_EDGES: readonly CanvasEdge[] = ["bottom"];
const PHONE_SIDE_EDGES: readonly CanvasEdge[] = ["left", "right", "top"];
/** Below this zoom the compact stickies drop their footer for a longer title. */
const TINY_ZOOM = 0.5;
/** How long a camera move (fit, reveal, zoom step) glides. */
const CAMERA_GLIDE_MS = 340;
/**
 * Opening zoom floor. A desktop-wide window opens at 100%, the way FigJam
 * and tldraw open a board: the stickies' 11px meta stays 11px on screen, and
 * a board wider than the window runs off its edge to be panned to, instead of
 * every sticky shrinking to fit. A narrow window fits the board (stickies
 * show their compact face there), down to half size; a phone fits the
 * board's width and scrolls down the column of frames. Switching the
 * arrangement and resetting the layout open the new board the same way.
 */
function openingFloor(width: number, boardWidth: number): number {
	if (width < MINIMAP_MIN_WIDTH) {
		const widthFit = (width - SAFE_INSETS.left * 2 - 32) / boardWidth;
		return Math.min(0.75, Math.max(0.3, widthFit));
	}
	return width < MINIMAP_DEFAULT_WIDTH ? NARROW_FLOOR : 1;
}

function sameCamera(a: CanvasCamera, b: CanvasCamera): boolean {
	return (
		Math.abs(a.x - b.x) < 0.5 &&
		Math.abs(a.y - b.y) < 0.5 &&
		Math.abs(a.zoom - b.zoom) < 0.001
	);
}

/** The minimap's corner, which a fit keeps clear of every frame and sticky. */
function minimapClearance(
	shown: boolean,
	viewport: CanvasViewport,
	pieces: readonly CanvasRect[]
): CanvasClearance | undefined {
	if (!shown) {
		return undefined;
	}
	return {
		blockedRight: MINIMAP_WIDTH + 24,
		obstacles: [
			{
				height: MINIMAP_HEIGHT,
				width: MINIMAP_WIDTH,
				x: viewport.width - 16 - MINIMAP_WIDTH,
				y: viewport.height - 16 - MINIMAP_HEIGHT,
			},
		],
		pieces,
	};
}

function stickyRects(
	layout: CanvasLayout,
	overrides: Readonly<Record<string, CanvasPoint>>
): CanvasRect[] {
	return layout.cards.map((card) => cardRect(cardPosition(card, overrides)));
}

/** Everything a fit keeps clear of the minimap: the frames and every sticky. */
function boardPieces(
	layout: CanvasLayout,
	overrides: Readonly<Record<string, CanvasPoint>>
): CanvasRect[] {
	return [
		...fitFrames(layout, overrides).rects.values(),
		...stickyRects(layout, overrides),
	];
}

/**
 * Screen space the header, dock and minimap cover, which "Zoom to fit" keeps
 * clear so no sticky starts out hidden under the chrome.
 */
const SAFE_INSETS = {
	bottom: SAFE_BOTTOM,
	left: 16,
	right: 16,
	top: SAFE_TOP,
} as const;

/** How far (screen px) the drop ghost may slide off the double-click to clear a sticky. */
const DROP_SEARCH_RADIUS = 96;

/**
 * Where the drop ghost goes, the way tldraw places a new shape: centred on the
 * double-click. Frames are drop targets, not obstacles; only another sticky
 * (or the minimap) nudges it, and only a short way. On a crowded spot it stays
 * at the click: overlap is fine on a canvas, a jump across the board is not.
 */
function placeDropGhost(
	desired: CanvasPoint,
	obstacles: readonly CanvasRect[],
	zoom: number
): CanvasPoint {
	const near = findFreeSpot(
		desired,
		{ height: CARD_HEIGHT, width: CARD_WIDTH },
		obstacles,
		{
			gap: 8 / zoom,
			radius: DROP_SEARCH_RADIUS / zoom,
			step: Math.max(4, 8 / zoom),
		}
	);
	const spot = near ?? desired;
	return { x: Math.round(spot.x), y: Math.round(spot.y) };
}

type Gesture =
	| {
			camera: CanvasCamera;
			fromCard: boolean;
			kind: "pan";
			moved: boolean;
			start: CanvasPoint;
	  }
	| {
			/** Where the sticky was grabbed, from its top-left (world units). */
			grab: CanvasPoint;
			id: string;
			kind: "card";
			moved: boolean;
			point: CanvasPoint;
			start: CanvasPoint;
	  }
	| {
			camera: CanvasCamera;
			distance: number;
			kind: "pinch";
			middle: CanvasPoint;
	  };

interface ComposerState {
	agentId: string | undefined;
	/** Top-left of the sticky the new thread will become, in world units. */
	world: CanvasPoint;
}

interface PendingDrop {
	arrange: CanvasArrange;
	known: Set<string>;
	world: CanvasPoint;
}

function distanceBetween(a: CanvasPoint, b: CanvasPoint): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: CanvasPoint, b: CanvasPoint): CanvasPoint {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Canvas: threads as sticky notes on an infinite, zoomable board, first filed
 * into labelled frames (by status or by lead agent) and then wherever the
 * viewer drags them. Pan by dragging empty space, Space+drag, or the hand
 * tool; zoom with Ctrl/Cmd+wheel, pinch, or the dock. Double-click a sticky
 * (or press Enter) to open the host's real thread beside the canvas;
 * double-click empty canvas to write a new one right there.
 */
export function CanvasInterface({
	activeThreadId,
	loading,
	params,
	port,
	snapshot,
	threadView,
}: InterfaceRendererProps<CanvasParams>) {
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

	const frameFit = useMemo(
		() => fitFrames(layout, overrides),
		[layout, overrides]
	);
	const frameFitRef = useRef(frameFit);
	useEffect(() => {
		frameFitRef.current = frameFit;
	}, [frameFit]);
	const content = useMemo(
		() => contentBounds(layout, overrides),
		[layout, overrides]
	);
	const contentRef = useRef(content);
	useEffect(() => {
		contentRef.current = content;
	}, [content]);
	/** Frames and stickies, which fits keep clear of the minimap. */
	const piecesRef = useRef<CanvasRect[]>([]);
	useEffect(() => {
		piecesRef.current = boardPieces(layout, overrides);
	}, [layout, overrides]);

	/** Fit a board centred in the view, clear of the minimap only when it would cover a sticky. */
	const boardCamera = useCallback(
		(
			rect: CanvasRect,
			pieces: readonly CanvasRect[],
			floor?: number
		): CanvasCamera => {
			const size = viewportRefSize.current;
			const clearance = minimapClearance(minimapShownRef.current, size, pieces);
			return floor === undefined
				? fitCameraClear(rect, size, SAFE_INSETS, clearance)
				: openingCamera(rect, size, SAFE_INSETS, floor, clearance);
		},
		[]
	);

	const fitView = useCallback(
		(animated = true) => {
			if (viewportRefSize.current.width <= 0) {
				return;
			}
			moveCamera(boardCamera(contentRef.current, piecesRef.current), animated);
		},
		[boardCamera, moveCamera]
	);

	const threadOpen = threadView !== null;

	// First fit, once the viewport has a size and the snapshot has settled.
	const fittedRef = useRef(false);
	useEffect(() => {
		if (fittedRef.current || loading || viewport.width <= 0 || rootWidth <= 0) {
			return;
		}
		fittedRef.current = true;
		const opening = boardCamera(
			contentRef.current,
			boardPieces(layoutRef.current, overrides),
			openingFloor(viewport.width, contentRef.current.width)
		);
		autoCameraRef.current = opening;
		setCameraNow(opening);
	}, [loading, viewport, rootWidth, overrides, boardCamera, setCameraNow]);

	// Docking a thread narrows the canvas and refits it; closing the thread
	// puts the view back where it was, unless the viewer has moved it since.
	const dockRef = useRef<{ before: CanvasCamera } | null>(null);
	const refitOnWidenRef = useRef(false);
	const wasOpenRef = useRef(false);
	useEffect(() => {
		if (threadOpen) {
			wasOpenRef.current = true;
			if (!dockRef.current && fittedRef.current) {
				dockRef.current = { before: cameraRef.current };
				autoCameraRef.current = cameraRef.current;
			}
			return;
		}
		// Only a thread that was open and has now closed puts the view back.
		if (!wasOpenRef.current) {
			return;
		}
		wasOpenRef.current = false;
		const docked = dockRef.current;
		dockRef.current = null;
		const auto = autoCameraRef.current;
		const untouched = auto !== null && sameCamera(cameraRef.current, auto);
		if (!untouched) {
			return;
		}
		if (docked) {
			moveCameraAuto(docked.before);
		} else {
			// Opened with a thread already docked: refit once the canvas widens.
			refitOnWidenRef.current = true;
		}
	}, [threadOpen, moveCameraAuto]);

	// When a thread opens, keep its sticky in view, with its whole frame when
	// that fits at the current zoom. Docking the panel never zooms the board
	// out (tldraw and FigJam keep the zoom when a panel opens): the board runs
	// under the panel's edge and only pans as far as the open sticky needs.
	const revealedRef = useRef("");
	const seenWidthRef = useRef(0);
	useEffect(() => {
		const widened =
			seenWidthRef.current > 0 && viewport.width > seenWidthRef.current;
		seenWidthRef.current = viewport.width;
		if (widened && refitOnWidenRef.current && fittedRef.current) {
			refitOnWidenRef.current = false;
			moveCameraAuto(
				boardCamera(
					contentRef.current,
					piecesRef.current,
					openingFloor(viewport.width, contentRef.current.width)
				)
			);
			return;
		}
		if (!(activeThreadId && fittedRef.current) || viewport.width <= 0) {
			return;
		}
		const key = `${activeThreadId}:${viewport.width}`;
		if (revealedRef.current === key) {
			return;
		}
		revealedRef.current = key;
		const point = livePositionRef.current(activeThreadId);
		if (!point) {
			return;
		}
		const fit = frameFitRef.current;
		const card = cardRect(point);
		const frameId = layoutRef.current.cards.find(
			(item) => item.id === activeThreadId
		)?.frameId;
		const frame =
			frameId && !fit.loose.has(activeThreadId)
				? fit.rects.get(frameId)
				: undefined;
		const current = cameraRef.current;
		const withFrame = frame ? unionRects([frame, card]) : card;
		const fits =
			withFrame.width * current.zoom <=
				viewport.width - SAFE_INSETS.left - SAFE_INSETS.right &&
			withFrame.height * current.zoom <=
				viewport.height - SAFE_INSETS.top - SAFE_INSETS.bottom;
		const focus = fits ? withFrame : card;
		if (!rectInView(current, focus, viewport, SAFE_INSETS)) {
			moveCameraAuto(revealRect(current, focus, viewport, 72));
		}
	}, [activeThreadId, viewport, boardCamera, moveCameraAuto]);

	// Once the host creates the thread, keep its drop spot for good.
	useEffect(() => {
		if (!(pendingDrop && createdId)) {
			return;
		}
		const target = pendingDrop.arrange;
		const world = {
			x: Math.round(pendingDrop.world.x),
			y: Math.round(pendingDrop.world.y),
		};
		setPendingDrop(null);
		updatePositions((previous) => ({
			...previous,
			[target]: { ...previous[target], [createdId]: world },
		}));
		setSelectedId(createdId);
		raise(createdId);
	}, [pendingDrop, createdId, updatePositions, raise]);

	const openThread = useCallback(
		(id: string) => {
			setSelectedId(id);
			raise(id);
			port.openThread(id);
		},
		[port, raise]
	);

	/**
	 * Open the new sticky at a drop spot, moving the board only if the spot is
	 * hidden: zoom out just enough to show the board and the new sticky
	 * together while the stickies keep their full face, else pan the least
	 * distance that shows the new sticky whole.
	 */
	const showComposer = useCallback(
		(drop: CanvasPoint, agentId: string | undefined) => {
			setComposer({ agentId, world: drop });
			const current = cameraRef.current;
			const size = viewportRefSize.current;
			const note = cardRect(drop);
			if (rectInView(current, note, size, SAFE_INSETS)) {
				return;
			}
			const together = boardCamera(unionRects([contentRef.current, note]), [
				...piecesRef.current,
				note,
			]);
			const readable =
				together.zoom >= COMPACT_ZOOM && together.zoom <= current.zoom + 0.001;
			moveCamera(readable ? together : revealRect(current, note, size, 32));
		},
		[boardCamera, moveCamera]
	);

	/**
	 * Open the composer at a screen point. The drop ghost is centred on the
	 * pointer (sliding a short way only to clear a sticky under it); the
	 * composer goes on whichever side of it has room. The board only moves when
	 * the ghost would sit partly under the chrome or off the view.
	 */
	const openComposerAt = useCallback(
		(screen: CanvasPoint) => {
			const current = cameraRef.current;
			const size = viewportRefSize.current;
			const world = screenToWorld(current, screen);
			const frame =
				arrange === "agent"
					? layout.frames.find(
							(item) =>
								item.agent &&
								world.x >= item.rect.x &&
								world.x <= item.rect.x + item.rect.width &&
								world.y >= item.rect.y &&
								world.y <= item.rect.y + item.rect.height
						)
					: undefined;
			const zoom = current.zoom;
			const desired = {
				x: world.x - CARD_WIDTH / 2,
				y: world.y - CARD_HEIGHT / 2,
			};
			const obstacles = stickyRects(layout, overrides);
			if (minimapShownRef.current) {
				const corner = screenToWorld(current, {
					x: size.width - 16 - MINIMAP_WIDTH,
					y: size.height - 16 - MINIMAP_HEIGHT,
				});
				obstacles.push({
					height: MINIMAP_HEIGHT / zoom,
					width: MINIMAP_WIDTH / zoom,
					...corner,
				});
			}
			const drop = placeDropGhost(desired, obstacles, zoom);
			showComposer(drop, frame?.agent?.id);
		},
		[arrange, layout, overrides, showComposer]
	);
	/**
	 * "N" or the dock's button: a new sticky in the free canvas nearest the
	 * view's centre, never on top of a frame or a sticky.
	 */
	const openComposerCentered = useCallback(() => {
		const current = cameraRef.current;
		const size = viewportRefSize.current;
		const zoom = current.zoom;
		const view = visibleWorldRect(current, size);
		const within = {
			height: view.height - (SAFE_INSETS.top + SAFE_INSETS.bottom) / zoom,
			width: view.width - (SAFE_INSETS.left + SAFE_INSETS.right) / zoom,
			x: view.x + SAFE_INSETS.left / zoom,
			y: view.y + SAFE_INSETS.top / zoom,
		};
		const obstacles = boardPieces(layout, overrides);
		if (minimapShownRef.current) {
			const corner = screenToWorld(current, {
				x: size.width - 16 - MINIMAP_WIDTH,
				y: size.height - 16 - MINIMAP_HEIGHT,
			});
			obstacles.push({
				height: MINIMAP_HEIGHT / zoom,
				width: MINIMAP_WIDTH / zoom,
				...corner,
			});
		}
		const drop = placeClearSticky(
			screenToWorld(current, { x: size.width / 2, y: size.height / 2 }),
			obstacles,
			within,
			contentBounds(layout, overrides),
			zoom
		);
		showComposer(drop, undefined);
	}, [layout, overrides, showComposer]);

	const submitComposer = (input: { agentId?: string; prompt: string }) => {
		if (!composer) {
			return;
		}
		setPendingDrop({
			arrange,
			known: new Set(snapshot.threads.map((thread) => thread.id)),
			world: composer.world,
		});
		setComposer(null);
		port.startThread(
			input.agentId
				? { agentId: input.agentId, prompt: input.prompt }
				: { prompt: input.prompt }
		);
	};
	const closeComposer = () => {
		setComposer(null);
		viewportRef.current?.focus({ preventScroll: true });
	};

	const zoomBy = useCallback(
		(direction: -1 | 1) => {
			const size = viewportRefSize.current;
			moveCamera(
				zoomAt(
					cameraRef.current,
					{ x: size.width / 2, y: size.height / 2 },
					stepZoom(cameraRef.current.zoom, direction)
				)
			);
		},
		[moveCamera]
	);
	const resetZoom = useCallback(() => {
		const size = viewportRefSize.current;
		moveCamera(
			zoomAt(cameraRef.current, { x: size.width / 2, y: size.height / 2 }, 1)
		);
	}, [moveCamera]);
	/** Shift+2: bring the selected sticky up to 100% (less if the view is small). */
	const zoomToSelection = () => {
		const point = selectedId ? livePosition(selectedId) : undefined;
		if (!point || viewportRefSize.current.width <= 0) {
			return;
		}
		moveCamera(
			fitCameraInsets(cardRect(point), viewportRefSize.current, SAFE_INSETS, {
				margin: 48,
				maxZoom: 1,
			})
		);
	};
	const resetLayout = () => {
		updatePositions((previous) => ({ ...previous, [arrange]: {} }));
		startGlide();
		if (viewportRefSize.current.width > 0) {
			const home = buildCanvasLayout(snapshot, arrange, {}, { portrait });
			moveCamera(
				boardCamera(
					home.bounds,
					boardPieces(home, {}),
					openingFloor(viewportRefSize.current.width, home.bounds.width)
				)
			);
		}
	};
	const changeArrange = (next: CanvasArrange) => {
		if (next === arrange) {
			return;
		}
		setArrange(next);
		startGlide();
		if (viewportRefSize.current.width > 0) {
			const nextOverrides = overridesForThreads(
				positions[next],
				snapshot.threads
			);
			const nextLayout = buildCanvasLayout(snapshot, next, nextOverrides, {
				portrait,
			});
			const nextContent = contentBounds(nextLayout, nextOverrides);
			moveCamera(
				boardCamera(
					nextContent,
					boardPieces(nextLayout, nextOverrides),
					openingFloor(viewportRefSize.current.width, nextContent.width)
				)
			);
		}
	};

	// Card callbacks (stable, so memoised stickies skip camera frames).
	const onSelectCard = useCallback(
		(id: string, _event: MouseEvent<HTMLButtonElement>) => {
			setSelectedId(id);
			raise(id);
		},
		[raise]
	);
	const onOpenCard = useCallback(
		(id: string, event: MouseEvent<HTMLButtonElement>) => {
			event.stopPropagation();
			openThread(id);
		},
		[openThread]
	);
	/** Set while a press is down, so the focus it gives a sticky is not a keyboard move. */
	const pointerFocusRef = useRef(false);
	/** The sticky that keyboard focus (not a click) selected, if any. */
	const keyboardSelectionRef = useRef<string | null>(null);
	const onFocusCard = useCallback(
		(id: string, _event: FocusEvent<HTMLButtonElement>) => {
			setSelectedId(id);
			raise(id);
			// A press focuses the sticky too: never pan under a drag that is starting.
			if (pointerFocusRef.current) {
				keyboardSelectionRef.current = null;
				return;
			}
			keyboardSelectionRef.current = id;
			const point = livePositionRef.current(id);
			if (point) {
				const next = revealRect(
					cameraRef.current,
					cardRect(point),
					viewportRefSize.current,
					72
				);
				if (next !== cameraRef.current) {
					moveCamera(next);
				}
			}
		},
		[moveCamera, raise]
	);
	/**
	 * Selection follows keyboard focus, so it also leaves with it: tabbing out
	 * of the stickies (to the header, the canvas, or past the board) clears it.
	 * Focus moving to another sticky, the dock, or the open thread keeps it, as
	 * does the window losing focus.
	 */
	const onBlurCard = useCallback(
		(id: string, event: FocusEvent<HTMLButtonElement>) => {
			if (keyboardSelectionRef.current !== id) {
				return;
			}
			keyboardSelectionRef.current = null;
			const next = event.relatedTarget;
			if (
				!(next instanceof Element) ||
				next.closest("[data-canvas-card], [data-canvas-keeps-selection]")
			) {
				return;
			}
			setSelectedId((current) => (current === id ? null : current));
		},
		[]
	);

	// Pointer gestures: pan, drag a sticky, pinch.
	const pointersRef = useRef(new Map<number, CanvasPoint>());
	const gestureRef = useRef<Gesture | null>(null);
	const arrangeRef = useRef(arrange);
	useEffect(() => {
		arrangeRef.current = arrange;
	}, [arrange]);

	const toLocal = useCallback((clientX: number, clientY: number) => {
		const rect = viewportRef.current?.getBoundingClientRect();
		return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
	}, []);

	/**
	 * A sticky dropped over others would hide their titles: slide it to the
	 * nearest spot clear of every other sticky (a short way at most), or leave
	 * it where it fell when the board is too crowded for that.
	 */
	const clearDrop = useCallback(
		(id: string, point: CanvasPoint): CanvasPoint => {
			// Where the other stickies will sit once this one lands (its old frame
			// repacks), not where they sat while it was held.
			const projected = projectLayoutRef.current(id, point);
			const headers = [
				...fitFrames(projected.layout, projected.overrides).rects.values(),
			].map((rect) => ({ ...rect, height: FRAME_HEADER }));
			// Other stickies, and the frame labels, stay readable.
			const others = [
				...projected.layout.cards
					.filter((card) => card.id !== id)
					.map((card) => cardRect(cardPosition(card, projected.overrides))),
				...headers,
			];
			const dropped = cardRect(point);
			if (!others.some((other) => rectsOverlap(dropped, other))) {
				return point;
			}
			const size = { height: CARD_HEIGHT, width: CARD_WIDTH };
			const search = { gap: 12, radius: CARD_HEIGHT * 2, step: 8 };
			// Prefer a spot the viewer can still see; else the nearest anywhere,
			// which the view then glides to.
			const camera = cameraRef.current;
			const view = viewportRefSize.current;
			const topLeft = screenToWorld(camera, {
				x: SAFE_INSETS.left,
				y: SAFE_INSETS.top,
			});
			const within = {
				height:
					(view.height - SAFE_INSETS.top - SAFE_INSETS.bottom) / camera.zoom,
				width:
					(view.width - SAFE_INSETS.left - SAFE_INSETS.right) / camera.zoom,
				...topLeft,
			};
			const spot =
				findFreeSpot(point, size, others, { ...search, within }) ??
				findFreeSpot(point, size, others, search);
			if (!spot) {
				return point;
			}
			const rounded = { x: Math.round(spot.x), y: Math.round(spot.y) };
			const revealed = revealRect(camera, cardRect(rounded), view, 72);
			if (view.width > 0 && revealed !== camera) {
				moveCamera(revealed);
			}
			return rounded;
		},
		[moveCamera]
	);

	const onWindowPointerMove = useCallback(
		(event: globalThis.PointerEvent) => {
			const pointers = pointersRef.current;
			if (!pointers.has(event.pointerId)) {
				return;
			}
			const point = toLocal(event.clientX, event.clientY);
			pointers.set(event.pointerId, point);
			const gesture = gestureRef.current;
			if (!gesture) {
				return;
			}
			if (gesture.kind === "pinch") {
				const [first, second] = [...pointers.values()];
				if (!(first && second)) {
					return;
				}
				const middle = midpoint(first, second);
				const zoomed = zoomAt(
					gesture.camera,
					gesture.middle,
					gesture.camera.zoom *
						(distanceBetween(first, second) / Math.max(1, gesture.distance))
				);
				setCameraNow({
					x: zoomed.x + middle.x - gesture.middle.x,
					y: zoomed.y + middle.y - gesture.middle.y,
					zoom: zoomed.zoom,
				});
				return;
			}
			const dx = point.x - gesture.start.x;
			const dy = point.y - gesture.start.y;
			if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
				return;
			}
			gesture.moved = true;
			if (gesture.kind === "pan") {
				setPanning(true);
				setCameraNow({
					x: gesture.camera.x + dx,
					y: gesture.camera.y + dy,
					zoom: gesture.camera.zoom,
				});
				return;
			}
			// Measured in world units against the live camera, so the grabbed
			// point stays under the pointer even if the view moves mid-drag.
			const under = screenToWorld(cameraRef.current, point);
			gesture.point = {
				x: Math.round(under.x - gesture.grab.x),
				y: Math.round(under.y - gesture.grab.y),
			};
			setDrag({ id: gesture.id, point: gesture.point });
		},
		[setCameraNow, toLocal]
	);

	const onWindowPointerUp = useCallback(
		(event: globalThis.PointerEvent) => {
			const pointers = pointersRef.current;
			if (!pointers.delete(event.pointerId)) {
				return;
			}
			const gesture = gestureRef.current;
			if (pointers.size > 0) {
				// One finger lifted from a pinch: carry on panning with the other.
				const [remaining] = [...pointers.values()];
				if (gesture?.kind === "pinch" && remaining) {
					gestureRef.current = {
						camera: cameraRef.current,
						fromCard: false,
						kind: "pan",
						moved: true,
						start: remaining,
					};
				}
				return;
			}
			gestureRef.current = null;
			pointerFocusRef.current = false;
			setPanning(false);
			window.removeEventListener("pointermove", onWindowPointerMove);
			window.removeEventListener("pointerup", onWindowPointerUp);
			window.removeEventListener("pointercancel", onWindowPointerUp);
			if (!gesture) {
				return;
			}
			if (gesture.kind === "card") {
				setDrag(null);
				if (gesture.moved) {
					const { id } = gesture;
					const target = arrangeRef.current;
					const point = clearDrop(id, gesture.point);
					// Its old frame may repack: the stickies left behind glide, and a
					// sticky dropped onto others glides the last bit clear of them.
					startGlide(point === gesture.point ? id : null);
					updatePositions((previous) => ({
						...previous,
						[target]: { ...previous[target], [id]: point },
					}));
				}
				return;
			}
			if (gesture.kind === "pan" && !(gesture.moved || gesture.fromCard)) {
				setSelectedId(null);
			}
		},
		[clearDrop, onWindowPointerMove, startGlide, updatePositions]
	);

	useEffect(
		() => () => {
			window.removeEventListener("pointermove", onWindowPointerMove);
			window.removeEventListener("pointerup", onWindowPointerUp);
			window.removeEventListener("pointercancel", onWindowPointerUp);
		},
		[onWindowPointerMove, onWindowPointerUp]
	);

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button === 2 || loading) {
			return;
		}
		animationRef.current?.stop();
		animationRef.current = null;
		pointerFocusRef.current = true;
		if (composer) {
			setComposer(null);
		}
		const point = toLocal(event.clientX, event.clientY);
		const pointers = pointersRef.current;
		if (pointers.size === 0) {
			window.addEventListener("pointermove", onWindowPointerMove);
			window.addEventListener("pointerup", onWindowPointerUp);
			window.addEventListener("pointercancel", onWindowPointerUp);
		}
		pointers.set(event.pointerId, point);
		if (pointers.size === 2) {
			const [first, second] = [...pointers.values()];
			if (first && second) {
				const current = gestureRef.current;
				if (current?.kind === "card") {
					setDrag(null);
				}
				gestureRef.current = {
					camera: cameraRef.current,
					distance: distanceBetween(first, second),
					kind: "pinch",
					middle: midpoint(first, second),
				};
			}
			return;
		}
		if (pointers.size > 2) {
			return;
		}
		const target = event.target instanceof Element ? event.target : null;
		const cardId = target
			?.closest("[data-canvas-card]")
			?.getAttribute("data-canvas-card");
		const handPan = tool === "hand" || spaceHeld || event.button === 1;
		if (cardId && !handPan) {
			setSelectedId(cardId);
			raise(cardId);
			const origin = livePosition(cardId) ?? { x: 0, y: 0 };
			const grabbed = screenToWorld(cameraRef.current, point);
			gestureRef.current = {
				grab: { x: grabbed.x - origin.x, y: grabbed.y - origin.y },
				id: cardId,
				kind: "card",
				moved: false,
				point: origin,
				start: point,
			};
			return;
		}
		if (event.button === 1 || cardId) {
			// Middle-button pans, and hand-tool presses on a sticky, must not
			// focus (and so select) the sticky under the pointer.
			event.preventDefault();
		}
		// Keep keyboard shortcuts working after a press on the canvas itself.
		viewportRef.current?.focus({ preventScroll: true });
		gestureRef.current = {
			camera: cameraRef.current,
			fromCard: Boolean(cardId),
			kind: "pan",
			moved: false,
			start: point,
		};
	};

	const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
		if (loading) {
			return;
		}
		const target = event.target instanceof Element ? event.target : null;
		if (target?.closest("[data-canvas-card]")) {
			return;
		}
		openComposerAt(toLocal(event.clientX, event.clientY));
	};

	// Wheel: Ctrl/Cmd (and trackpad pinch) zooms about the cursor; otherwise pan.
	useEffect(() => {
		const element = viewportRef.current;
		if (!element) {
			return;
		}
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			animationRef.current?.stop();
			const current = cameraRef.current;
			const scale = event.deltaMode === 1 ? 16 : 1;
			if (event.ctrlKey || event.metaKey) {
				const rect = element.getBoundingClientRect();
				const delta = Math.max(-48, Math.min(48, event.deltaY * scale));
				setCameraNow(
					zoomAt(
						current,
						{ x: event.clientX - rect.left, y: event.clientY - rect.top },
						current.zoom * Math.exp(-delta * 0.005)
					)
				);
				return;
			}
			const horizontal = event.shiftKey && event.deltaX === 0;
			setCameraNow({
				x: current.x - (horizontal ? event.deltaY : event.deltaX) * scale,
				y: current.y - (horizontal ? 0 : event.deltaY) * scale,
				zoom: current.zoom,
			});
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => element.removeEventListener("wheel", onWheel);
	}, [setCameraNow]);

	// Keyboard.
	const nudge = (id: string, dx: number, dy: number) => {
		const point = livePosition(id);
		if (!point) {
			return;
		}
		const next = { x: point.x + dx, y: point.y + dy };
		startGlide(id);
		updatePositions((previous) => ({
			...previous,
			[arrange]: { ...previous[arrange], [id]: next },
		}));
		const revealed = revealRect(
			cameraRef.current,
			cardRect(next),
			viewport,
			48
		);
		if (revealed !== cameraRef.current) {
			setCameraNow(revealed);
		}
	};

	const onEscape = () => {
		if (composer) {
			setComposer(null);
			return true;
		}
		if (threadView) {
			port.closeThread();
			return true;
		}
		if (selectedId) {
			setSelectedId(null);
			viewportRef.current?.focus({ preventScroll: true });
			return true;
		}
		return false;
	};

	const onArrow = (key: string, shift: boolean) => {
		const step = shift ? NUDGE_LARGE : NUDGE;
		const dx = (key === "ArrowRight" ? 1 : 0) - (key === "ArrowLeft" ? 1 : 0);
		const dy = (key === "ArrowDown" ? 1 : 0) - (key === "ArrowUp" ? 1 : 0);
		if (selectedId && cardsById.has(selectedId)) {
			nudge(selectedId, dx * step, dy * step);
			return;
		}
		const pan = shift ? 240 : 64;
		moveCamera(
			{
				x: cameraRef.current.x - dx * pan,
				y: cameraRef.current.y - dy * pan,
				zoom: cameraRef.current.zoom,
			},
			false
		);
	};

	const onShortcut = (
		event: KeyboardEvent<HTMLElement>,
		onBoard: boolean
	): boolean => {
		const modifier = event.ctrlKey || event.metaKey;
		if (event.code === "Digit1" && event.shiftKey && !modifier) {
			fitView();
			return true;
		}
		if (event.code === "Digit2" && event.shiftKey && !modifier) {
			zoomToSelection();
			return true;
		}
		if (
			(event.code === "Digit0" && (event.shiftKey || modifier)) ||
			(modifier && event.key === "0")
		) {
			resetZoom();
			return true;
		}
		if (onBoard && (event.key === "+" || event.key === "=")) {
			zoomBy(1);
			return true;
		}
		if (onBoard && (event.key === "-" || event.key === "_")) {
			zoomBy(-1);
			return true;
		}
		if (modifier || event.altKey) {
			return false;
		}
		const key = event.key.toLowerCase();
		if (key === "v") {
			setTool("select");
			return true;
		}
		if (key === "h") {
			setTool("hand");
			return true;
		}
		if (key === "n" && !loading) {
			openComposerCentered();
			return true;
		}
		return false;
	};

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (isTypingTarget(event.target)) {
			return;
		}
		if (event.key === "Escape") {
			if (onEscape()) {
				event.preventDefault();
			}
			return;
		}
		// Space, Enter, the arrows and +/- drive the board only when the board
		// (or a sticky) has focus; on a focused chrome button they keep their
		// native meaning, so Space and Enter still press it.
		const onBoard = isBoardTarget(event.target);
		if (event.key === " ") {
			if (!onBoard) {
				return;
			}
			event.preventDefault();
			if (!event.repeat) {
				setSpaceHeld(true);
			}
			return;
		}
		if (event.key === "Enter") {
			if (onBoard && selectedId && cardsById.has(selectedId)) {
				event.preventDefault();
				openThread(selectedId);
			}
			return;
		}
		if (event.key.startsWith("Arrow")) {
			if (onBoard) {
				event.preventDefault();
				onArrow(event.key, event.shiftKey);
			}
			return;
		}
		if (onShortcut(event, onBoard)) {
			event.preventDefault();
		}
	};

	const onKeyUp = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key !== " ") {
			return;
		}
		setSpaceHeld(false);
		// Only the board's own Space is swallowed: a chrome button presses on keyup.
		if (isBoardTarget(event.target)) {
			event.preventDefault();
		}
	};

	// Space+drag must not stick when focus leaves mid-press (alt-tab, etc.).
	useEffect(() => {
		const release = () => setSpaceHeld(false);
		const onVisibility = () => {
			if (document.visibilityState !== "visible") {
				release();
			}
		};
		window.addEventListener("blur", release);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("blur", release);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, []);

	// Derived render data.
	const zIndexOf = (id: string) => raised.indexOf(id) + 1;
	const minimapCards = useMemo<MinimapCard[]>(
		() =>
			layout.cards.map((card) => ({
				id: card.id,
				rect: cardRect(
					drag?.id === card.id ? drag.point : cardPosition(card, overrides)
				),
				selected: card.id === selectedId,
				status: card.status,
			})),
		[layout, overrides, drag, selectedId]
	);
	const offscreen = useMemo(
		() =>
			minimapShown || viewport.width <= 0
				? undefined
				: offscreenCards(
						minimapCards.map((card) => card.rect),
						visibleWorldRect(camera, viewport)
					),
		[minimapShown, minimapCards, camera, viewport]
	);
	const minimapFrames = useMemo(() => [...frameFit.rects.values()], [frameFit]);
	/** Stickies out of their frame now, counting one being dragged out. */
	const movedByFrame = useMemo(() => {
		const loose = drag
			? fitFrames(layout, { ...overrides, [drag.id]: drag.point }).loose
			: frameFit.loose;
		const counts = new Map<string, number>();
		for (const card of layout.cards) {
			if (loose.has(card.id)) {
				counts.set(card.frameId, (counts.get(card.frameId) ?? 0) + 1);
			}
		}
		return counts;
	}, [drag, frameFit, layout, overrides]);

	const empty = !loading && layout.cards.length === 0;
	const grid = gridSpacing(camera.zoom);
	const overlay = rootSize.width > 0 && rootSize.width < DOCK_MIN_WIDTH;
	const activeCard = activeThreadId ? cardsById.get(activeThreadId) : undefined;
	const composerScreen = composer
		? worldToScreen(camera, composer.world)
		: undefined;
	const canPan = tool === "hand" || spaceHeld;
	const compact = camera.zoom < COMPACT_ZOOM;
	const tiny = camera.zoom < TINY_ZOOM;
	// A covering (not docked) thread takes the canvas out of the tab order.
	const covered = overlay && threadOpen;
	const selectedCard = selectedId ? cardsById.get(selectedId) : undefined;
	const showEdgeHints = !(loading || empty || composer);
	const phoneDock = viewport.width < MINIMAP_MIN_WIDTH;
	const revealOffscreen = (rect: CanvasRect) =>
		moveCamera(revealRect(cameraRef.current, rect, viewport, 80));
	const selectable = selectedCard !== undefined && !(loading || empty);

	return (
		<div
			className="relative flex size-full min-h-0 overflow-hidden bg-background text-foreground"
			data-testid="interface-canvas"
			ref={rootRef}
		>
			<p aria-live="polite" className="sr-only" data-testid="canvas-announcer">
				{selectedCard
					? `Selected: ${selectedCard.thread.title.trim() || "Untitled thread"}`
					: ""}
			</p>
			<section
				aria-label="Canvas"
				className="@container relative min-w-0 flex-1 overflow-hidden"
				inert={covered}
				onKeyDown={onKeyDown}
				onKeyUp={onKeyUp}
				onScroll={(event) => event.currentTarget.scrollTo(0, 0)}
			>
				{/* The chrome comes first in tab order (header, then the tools), and
				    floats above the world. */}
				<div className="pointer-events-none absolute inset-0 z-10">
					<div className="absolute top-3 left-3 max-w-[calc(100%-1.5rem)]">
						<CanvasHeader
							arrange={arrange}
							loading={loading}
							onArrange={changeArrange}
							summary={summary}
						/>
					</div>
					<div
						className="absolute inset-x-0 bottom-4 flex items-center justify-center gap-2 px-3"
						data-canvas-keeps-selection=""
					>
						{showEdgeHints && offscreen && !phoneDock ? (
							<CanvasEdgeHints
								edges={DOCK_EDGES_BEFORE}
								inline
								offscreen={offscreen}
								onReveal={revealOffscreen}
							/>
						) : null}
						<CanvasToolbar
							canReset={Object.keys(overrides).length > 0}
							canZoomToSelection={selectable}
							disabled={loading || empty}
							minimap={
								loading || empty || viewport.width < MINIMAP_MIN_WIDTH
									? undefined
									: {
											onToggle: () =>
												setMinimap(minimapShown ? "hidden" : "shown"),
											shown: minimapShown,
										}
							}
							onFit={() => fitView()}
							onNewThread={openComposerCentered}
							onResetLayout={resetLayout}
							onResetZoom={resetZoom}
							onTool={setTool}
							onZoom={zoomBy}
							onZoomToSelection={zoomToSelection}
							tool={tool}
							zoom={camera.zoom}
						/>
						{showEdgeHints && offscreen ? (
							<CanvasEdgeHints
								edges={phoneDock ? PHONE_DOCK_EDGES : DOCK_EDGES_AFTER}
								inline
								offscreen={offscreen}
								onReveal={revealOffscreen}
							/>
						) : null}
					</div>
					{empty ? (
						<CanvasEmpty
							hasAgents={snapshot.agents.length > 0}
							onNewThread={openComposerCentered}
						/>
					) : null}
					{showEdgeHints && offscreen ? (
						<CanvasEdgeHints
							edges={phoneDock ? PHONE_SIDE_EDGES : NO_EDGES}
							offscreen={offscreen}
							onReveal={revealOffscreen}
						/>
					) : null}
					{!(loading || empty) && minimapShown ? (
						<div className="absolute right-4 bottom-4">
							<CanvasMinimap
								cards={minimapCards}
								content={content}
								frames={minimapFrames}
								onNavigate={(point) =>
									setCameraNow(centerOn(cameraRef.current, point, viewport))
								}
								visible={visibleWorldRect(camera, viewport)}
							/>
						</div>
					) : null}
					{composer && composerScreen ? (
						<CanvasComposer
							agents={snapshot.agents}
							defaultAgentId={composer.agentId}
							key={`${composer.world.x}:${composer.world.y}`}
							left={composerScreen.x}
							onClose={closeComposer}
							onSubmit={submitComposer}
							top={composerScreen.y}
							world={composer.world}
							zoom={camera.zoom}
						/>
					) : null}
				</div>

				<div
					aria-label="Thread canvas. Drag to pan, double-click to start a thread."
					aria-roledescription="canvas"
					className={cn(
						"peer absolute inset-0 touch-none select-none overflow-hidden outline-none",
						canPan && "cursor-grab",
						panning && "cursor-grabbing"
					)}
					data-canvas-viewport=""
					data-testid="canvas-viewport"
					onDoubleClick={onDoubleClick}
					onPointerDown={onPointerDown}
					onScroll={(event) => event.currentTarget.scrollTo(0, 0)}
					ref={viewportRef}
					role="application"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the canvas is a keyboard-driven pan/zoom surface (role="application").
					tabIndex={0}
				>
					<div
						aria-hidden="true"
						className="pointer-events-none absolute inset-0 text-muted-foreground/35"
						style={{
							backgroundImage:
								"radial-gradient(circle, currentColor 1px, transparent 1.3px)",
							backgroundPosition: `${camera.x}px ${camera.y}px`,
							backgroundSize: `${grid}px ${grid}px`,
						}}
					/>
					{loading ? (
						<CanvasSkeleton />
					) : (
						<div
							className={cn(
								"absolute top-0 left-0 origin-top-left will-change-transform",
								canPan && "[&_*]:cursor-[inherit]"
							)}
							data-testid="canvas-world"
							style={
								{
									"--canvas-scale": 1 / camera.zoom,
									transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.zoom})`,
								} as CSSProperties
							}
						>
							<AnimatePresence initial={false}>
								{layout.frames.map((frame) => (
									<CanvasFrame
										frame={frame}
										gliding={glide !== null}
										key={frame.id}
										moved={movedByFrame.get(frame.id) ?? 0}
										rect={frameFit.rects.get(frame.id) ?? frame.rect}
										vacant={frame.threadIds.every((id) =>
											frameFit.loose.has(id)
										)}
									/>
								))}
							</AnimatePresence>
							{layout.cards.map((card) => {
								const point =
									drag?.id === card.id
										? drag.point
										: cardPosition(card, overrides);
								return (
									<CanvasCard
										card={card}
										compact={compact}
										dragging={drag?.id === card.id}
										gliding={glide !== null && glide.except !== card.id}
										key={card.id}
										loose={frameFit.loose.has(card.id)}
										now={now}
										onBlurCard={onBlurCard}
										onFocusCard={onFocusCard}
										onOpenCard={onOpenCard}
										onSelectCard={onSelectCard}
										open={card.id === activeThreadId && threadOpen}
										selected={card.id === selectedId}
										showGroup={arrange === "status"}
										tiny={tiny}
										x={point.x}
										y={point.y}
										z={zIndexOf(card.id)}
									/>
								);
							})}
						</div>
					)}
				</div>
				{/* The canvas's focus ring, drawn above the world (frames and stickies
				    would otherwise cut it up) and under the chrome. */}
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 z-[5] rounded-[inherit] opacity-0 ring-2 ring-ring ring-inset peer-focus-visible:opacity-100"
					data-testid="canvas-focus-ring"
				/>
			</section>
			<AnimatePresence>
				{threadView ? (
					<CanvasThreadPanel
						card={activeCard}
						key="canvas-thread-panel"
						onClose={() => port.closeThread()}
						onLocate={
							activeCard
								? () => {
										const point = livePosition(activeCard.id);
										if (point) {
											setSelectedId(activeCard.id);
											moveCamera(
												centerOn(
													cameraRef.current,
													{
														x: point.x + CARD_WIDTH / 2,
														y: point.y + CARD_HEIGHT / 2,
													},
													viewport
												)
											);
										}
									}
								: undefined
						}
						overlay={overlay}
						threadView={threadView}
					/>
				) : null}
			</AnimatePresence>
		</div>
	);
}
