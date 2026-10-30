import {
	type FocusEvent,
	type MouseEvent,
	type PointerEvent,
	useCallback,
	useEffect,
	useRef,
} from "react";
import {
	DRAG_THRESHOLD,
	distanceBetween,
	type Gesture,
	midpoint,
	SAFE_INSETS,
} from "./canvas-interface-constants.ts";
import type { CanvasActionScope } from "./canvas-interface-scope.ts";
import {
	CARD_HEIGHT,
	CARD_WIDTH,
	type CanvasPoint,
	cardPosition,
	cardRect,
	FRAME_HEADER,
	findFreeSpot,
	fitFrames,
	rectsOverlap,
	revealRect,
	screenToWorld,
	zoomAt,
} from "./canvas-model.ts";

/** Sticky callbacks, pointer gestures and the wheel. */
export function useCanvasPointer(scope: CanvasActionScope) {
	const {
		animationRef,
		arrange,
		cameraRef,
		composer,
		livePosition,
		livePositionRef,
		loading,
		moveCamera,
		openComposerAt,
		openThread,
		projectLayoutRef,
		raise,
		setCameraNow,
		setComposer,
		setDrag,
		setPanning,
		setSelectedId,
		spaceHeld,
		startGlide,
		tool,
		updatePositions,
		viewportRef,
		viewportRefSize,
	} = scope;
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
	return {
		onSelectCard,
		onOpenCard,
		onFocusCard,
		onBlurCard,
		onPointerDown,
		onDoubleClick,
	};
}
