import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

export interface FlowSize {
	height: number;
	width: number;
}

export interface FlowView {
	/** Zoom factor. */
	k: number;
	x: number;
	y: number;
}

export const FLOW_ZOOM_MIN = 0.4;
export const FLOW_ZOOM_MAX = 2;

const ZERO: FlowSize = { height: 0, width: 0 };

/** The element's content-box size, kept current with a ResizeObserver. */
export function useFlowSize(ref: RefObject<HTMLElement | null>): FlowSize {
	const [size, setSize] = useState<FlowSize>(ZERO);
	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const measure = () => {
			const width = element.clientWidth;
			const height = element.clientHeight;
			setSize((previous) =>
				previous.width === width && previous.height === height
					? previous
					: { height, width }
			);
		};
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

/** Wall-clock time that ticks once a minute, for log times and the chart. */
export function useFlowClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

export function clampZoom(k: number): number {
	return Math.min(FLOW_ZOOM_MAX, Math.max(FLOW_ZOOM_MIN, k));
}

/**
 * The view that centers `bounds` in `size`, never zooming past `maxZoom`
 * (100% unless a caller lets a small flow grow into the window) or below
 * `minZoom`. When the flow still overflows at `minZoom`, it is pinned to the
 * top-left padding so the origin stays on screen.
 */
export function fitView(
	bounds: { maxX: number; maxY: number; minX: number; minY: number },
	size: FlowSize,
	minZoom: number = FLOW_ZOOM_MIN,
	maxZoom = 1
): FlowView {
	const padding = size.width < 640 ? 24 : 64;
	const width = Math.max(1, bounds.maxX - bounds.minX);
	const height = Math.max(1, bounds.maxY - bounds.minY);
	const k = Math.max(
		clampZoom(minZoom),
		clampZoom(
			Math.min(
				maxZoom,
				(size.width - padding * 2) / width,
				(size.height - padding * 2) / height
			)
		)
	);
	const x =
		width * k > size.width - padding * 2
			? padding - bounds.minX * k
			: size.width / 2 - (bounds.minX + width / 2) * k;
	const y =
		height * k > size.height - padding * 2
			? padding - bounds.minY * k
			: size.height / 2 - (bounds.minY + height / 2) * k;
	return { k, x, y };
}

/** Zooms by `factor` keeping the screen point (px, py) fixed. */
export function zoomAt(
	view: FlowView,
	factor: number,
	px: number,
	py: number
): FlowView {
	const k = clampZoom(view.k * factor);
	const ratio = k / view.k;
	return { k, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio };
}

/**
 * Drag-to-pan on the empty canvas plus wheel pan and Ctrl/Cmd+wheel zoom.
 * Drags that start on a control (button, input, menu) are left alone.
 */
export function useFlowPanZoom(
	ref: RefObject<HTMLElement | null>,
	onChange: (update: (view: FlowView) => FlowView) => void
): { panning: boolean } {
	const [panning, setPanning] = useState(false);
	const change = useRef(onChange);
	change.current = onChange;
	const drag = useRef<{ id: number; x: number; y: number } | null>(null);

	const onWheel = useCallback(
		(event: WheelEvent) => {
			const element = ref.current;
			if (
				!element ||
				(event.target instanceof Element &&
					event.target.closest("[data-flow-scroll]"))
			) {
				return;
			}
			event.preventDefault();
			if (event.ctrlKey || event.metaKey) {
				const rect = element.getBoundingClientRect();
				const factor = Math.exp(-event.deltaY * 0.0025);
				change.current((view) =>
					zoomAt(
						view,
						factor,
						event.clientX - rect.left,
						event.clientY - rect.top
					)
				);
				return;
			}
			change.current((view) => ({
				...view,
				x: view.x - event.deltaX,
				y: view.y - event.deltaY,
			}));
		},
		[ref]
	);

	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const onDown = (event: PointerEvent) => {
			if (
				event.button !== 0 ||
				(event.target instanceof Element &&
					event.target.closest(
						"button, input, textarea, a, [role='menu'], [data-flow-scroll]"
					))
			) {
				return;
			}
			drag.current = {
				id: event.pointerId,
				x: event.clientX,
				y: event.clientY,
			};
			element.setPointerCapture?.(event.pointerId);
			setPanning(true);
		};
		const onMove = (event: PointerEvent) => {
			const start = drag.current;
			if (!start || start.id !== event.pointerId) {
				return;
			}
			const dx = event.clientX - start.x;
			const dy = event.clientY - start.y;
			drag.current = { ...start, x: event.clientX, y: event.clientY };
			change.current((view) => ({ ...view, x: view.x + dx, y: view.y + dy }));
		};
		const onUp = (event: PointerEvent) => {
			if (drag.current?.id !== event.pointerId) {
				return;
			}
			drag.current = null;
			element.releasePointerCapture?.(event.pointerId);
			setPanning(false);
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		element.addEventListener("pointerdown", onDown);
		element.addEventListener("pointermove", onMove);
		element.addEventListener("pointerup", onUp);
		element.addEventListener("pointercancel", onUp);
		return () => {
			element.removeEventListener("wheel", onWheel);
			element.removeEventListener("pointerdown", onDown);
			element.removeEventListener("pointermove", onMove);
			element.removeEventListener("pointerup", onUp);
			element.removeEventListener("pointercancel", onUp);
		};
	}, [onWheel, ref]);

	return { panning };
}

/** Whether a key press belongs to a text field, not the canvas. */
export function isFlowTypingTarget(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.closest("textarea, input, select") !== null)
	);
}

/**
 * The smallest change to `view` that shows `box` (world space) inside the
 * screen rectangle `area`: zoom out only when the box cannot fit, then pan.
 * When it is taller than the area, its top edge wins.
 */
export function keepInView(
	view: FlowView,
	box: { maxX: number; maxY: number; minX: number; minY: number },
	area: { bottom: number; left: number; right: number; top: number }
): FlowView {
	const areaW = area.right - area.left;
	const areaH = area.bottom - area.top;
	if (areaW <= 0 || areaH <= 0) {
		return view;
	}
	const boxW = Math.max(1, box.maxX - box.minX);
	const k = clampZoom(Math.min(view.k, areaW / boxW));
	// Zoom about the box's top-left corner so it stays where the eye left it.
	let x = view.x + box.minX * (view.k - k);
	let y = view.y + box.minY * (view.k - k);
	const right = x + box.maxX * k;
	const bottom = y + box.maxY * k;
	if (right > area.right) {
		x += area.right - right;
	}
	if (x + box.minX * k < area.left) {
		x = area.left - box.minX * k;
	}
	if (bottom > area.bottom) {
		y += area.bottom - bottom;
	}
	if (y + box.minY * k < area.top) {
		y = area.top - box.minY * k;
	}
	if (x === view.x && y === view.y && k === view.k) {
		return view;
	}
	return { k, x, y };
}
