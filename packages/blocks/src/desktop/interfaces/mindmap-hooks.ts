import {
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	fitView,
	type MindmapBounds,
	type MindmapPlaced,
	type MindmapSize,
	type MindmapView,
	revealBox,
	zoomAt,
} from "./mindmap-model.ts";

/** Framing pads the map this far from the viewport edges (px). */
const FIT_PADDING = 56;
/** Framing may grow a small map to 125%, so it fills the window. */
const AUTO_FIT_MAX_ZOOM = 1.25;

/** Steps the zoom buttons and shortcuts take. */
export const MINDMAP_ZOOM_STEP = 1.25;

/**
 * Zoom per wheel unit: a mouse notch (clamped to 50) is about 22%, while a
 * trackpad pinch's many small deltas zoom smoothly.
 */
const WHEEL_ZOOM_RATE = 0.004;

/** Automatic framing never shrinks labels below this, so text stays legible. */
const MINDMAP_AUTO_FIT_MIN = 0.7;

function sameView(a: MindmapView, b: MindmapView): boolean {
	return (
		Math.abs(a.k - b.k) < 0.001 &&
		Math.abs(a.x - b.x) < 0.5 &&
		Math.abs(a.y - b.y) < 0.5
	);
}

/** Pointer travel (px) before a press on the background becomes a pan. */
const DRAG_THRESHOLD = 3;

interface DragState {
	moved: boolean;
	pointerId: number;
	startX: number;
	startY: number;
	view: MindmapView;
}

export interface MindmapViewController {
	fit: () => void;
	onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
	onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
	onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
	panning: boolean;
	resetZoom: () => void;
	reveal: (box: MindmapPlaced) => void;
	size: MindmapSize;
	/** True while a programmatic move should ease (buttons, fit, keyboard). */
	smooth: boolean;
	/** Stop refitting on resize: the person has arranged the view. */
	touch: () => void;
	view: MindmapView;
	viewportRef: RefObject<HTMLDivElement | null>;
	zoomBy: (factor: number) => void;
}

function readSize(element: HTMLElement | null): MindmapSize {
	if (!element) {
		return { height: 0, width: 0 };
	}
	const rect = element.getBoundingClientRect();
	return { height: rect.height, width: rect.width };
}

/** Elements a press should act on rather than pan the map. */
function isInteractive(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		target.closest("[data-mindmap-node],[data-mindmap-handle],button,a") !==
			null
	);
}

/**
 * Pan and zoom for the map: drag the background (or scroll) to pan,
 * Ctrl/Cmd + wheel or pinch to zoom around the pointer, and fit-to-screen
 * until the person moves the view themselves.
 */
export function useMindmapView(
	bounds: MindmapBounds,
	focus?: MindmapPlaced
): MindmapViewController {
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const [size, setSize] = useState<MindmapSize>({ height: 0, width: 0 });
	const [view, setView] = useState<MindmapView>({ k: 1, x: 0, y: 0 });
	const [smooth, setSmooth] = useState(false);
	const [panning, setPanning] = useState(false);
	const autoFit = useRef(true);
	const drag = useRef<DragState | null>(null);
	const viewRef = useRef(view);
	viewRef.current = view;
	const sizeRef = useRef(size);
	sizeRef.current = size;
	const boundsRef = useRef(bounds);
	boundsRef.current = bounds;

	// Measure before the first paint so the map never flashes off-centre.
	useLayoutEffect(() => {
		const element = viewportRef.current;
		setSize(readSize(element));
		if (!element || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(() => setSize(readSize(element)));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	// Keep the whole map framed (and the focus in view) until the person
	// pans or zooms; after that, only nudge the view to keep the focus seen.
	const framed = useRef(false);
	const lastFocus = useRef<string | null>(null);
	const lastWidth = useRef(0);
	useLayoutEffect(() => {
		if (size.width === 0 || size.height === 0) {
			return;
		}
		const eased = framed.current;
		framed.current = true;
		const focusMoved =
			(focus?.id ?? null) !== lastFocus.current ||
			size.width !== lastWidth.current;
		lastFocus.current = focus?.id ?? null;
		lastWidth.current = size.width;
		if (autoFit.current) {
			let next = fitView(
				bounds,
				size,
				MINDMAP_AUTO_FIT_MIN,
				FIT_PADDING,
				AUTO_FIT_MAX_ZOOM
			);
			if (focus) {
				next = revealBox(next, focus, size);
			}
			setSmooth(eased);
			setView((current) => (sameView(current, next) ? current : next));
		} else if (focus && focusMoved) {
			setSmooth(true);
			setView((current) => revealBox(current, focus, size));
		}
	}, [bounds, focus, size]);

	const move = useCallback((next: MindmapView, eased: boolean) => {
		setSmooth(eased);
		setView(next);
	}, []);

	const touch = useCallback(() => {
		autoFit.current = false;
	}, []);

	const fit = useCallback(() => {
		autoFit.current = true;
		move(
			fitView(
				boundsRef.current,
				sizeRef.current,
				undefined,
				FIT_PADDING,
				AUTO_FIT_MAX_ZOOM
			),
			true
		);
	}, [move]);

	const zoomBy = useCallback(
		(factor: number) => {
			autoFit.current = false;
			const current = sizeRef.current;
			move(
				zoomAt(viewRef.current, factor, {
					x: current.width / 2,
					y: current.height / 2,
				}),
				true
			);
		},
		[move]
	);

	const resetZoom = useCallback(() => {
		const current = viewRef.current;
		zoomBy(1 / current.k);
	}, [zoomBy]);

	const reveal = useCallback((box: MindmapPlaced) => {
		autoFit.current = false;
		setSmooth(true);
		setView((current) => revealBox(current, box, sizeRef.current));
	}, []);

	// Wheel pans; Ctrl/Cmd + wheel (and trackpad pinch) zooms at the pointer.
	// A native listener, because React's wheel listener is passive.
	useEffect(() => {
		const element = viewportRef.current;
		if (!element) {
			return;
		}
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			autoFit.current = false;
			const scale = event.deltaMode === 1 ? 16 : 1;
			if (event.ctrlKey || event.metaKey) {
				const rect = element.getBoundingClientRect();
				const delta = Math.max(-50, Math.min(50, event.deltaY * scale));
				move(
					zoomAt(viewRef.current, Math.exp(-delta * WHEEL_ZOOM_RATE), {
						x: event.clientX - rect.left,
						y: event.clientY - rect.top,
					}),
					false
				);
				return;
			}
			const current = viewRef.current;
			move(
				{
					k: current.k,
					x: current.x - event.deltaX * scale,
					y: current.y - event.deltaY * scale,
				},
				false
			);
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => element.removeEventListener("wheel", onWheel);
	}, [move]);

	const onPointerDown = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (event.button !== 0 || isInteractive(event.target)) {
				return;
			}
			drag.current = {
				moved: false,
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				view: viewRef.current,
			};
		},
		[]
	);

	const onPointerMove = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			const state = drag.current;
			if (!state || state.pointerId !== event.pointerId) {
				return;
			}
			const dx = event.clientX - state.startX;
			const dy = event.clientY - state.startY;
			if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
				return;
			}
			if (!state.moved) {
				state.moved = true;
				autoFit.current = false;
				setPanning(true);
				event.currentTarget.setPointerCapture?.(event.pointerId);
			}
			move(
				{ k: state.view.k, x: state.view.x + dx, y: state.view.y + dy },
				false
			);
		},
		[move]
	);

	const onPointerUp = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			const state = drag.current;
			if (!state || state.pointerId !== event.pointerId) {
				return;
			}
			drag.current = null;
			setPanning(false);
			if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
		},
		[]
	);

	return {
		fit,
		onPointerDown,
		onPointerMove,
		onPointerUp,
		panning,
		resetZoom,
		reveal,
		size,
		smooth,
		touch,
		view,
		viewportRef,
		zoomBy,
	};
}
