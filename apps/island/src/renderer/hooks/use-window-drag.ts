import { useCallback, useRef } from "react";
import { useIslandState } from "../store/island-state.ts";

/** Window-control API as exposed by the preload bridge. */
function winApi() {
	return window.island?.win;
}

/**
 * Pointer handlers for the island element. Three responsibilities:
 *
 * 1. Click-through capture: the BrowserWindow is oversized and click-through by
 *    default, so we tell main to capture the mouse on `pointerenter` and release
 *    it on `pointerleave` (clicks outside the island shape pass through).
 * 2. Manual drag: a pointer drag on the pill region moves the window via IPC
 *    deltas, then clamps + persists on release.
 * 3. Tap detection: a press-and-release that never moved fires the handle's tap
 *    callback, used to expand/collapse the island. A real drag never counts as a
 *    tap. The pointer-up handler is a factory (`makePointerUp`) so different
 *    handles on the same island (the logo circle vs. the detail pill) can run
 *    different tap actions while sharing one drag gesture (the `dragging`/`moved`
 *    refs stay shared, so the group's capture handling stays correct mid-drag).
 */
export function useWindowDrag() {
	const dragging = useRef(false);
	const last = useRef<{ x: number; y: number } | null>(null);
	// True once the pointer has actually moved, so a plain click never starts the
	// snap-zone overlay or repositions the island.
	const moved = useRef(false);
	const state = useIslandState((store) => store.state);

	const onPointerEnter = useCallback(() => {
		winApi()?.setMouseCapture(true);
	}, []);

	const onPointerLeave = useCallback(() => {
		// Keep capture while a drag is mid-flight even if the pointer briefly
		// leaves the shape; otherwise release so clicks fall through. Also keep it
		// while expanded: the panel / command palette is an interactive surface that
		// can be hotkey-summoned with the pointer nowhere near it, so releasing on
		// leave would make it click-through and unusable. Capture is restored to
		// click-through when the island collapses (see Island.tsx).
		if (!dragging.current && state !== "expanded") {
			winApi()?.setMouseCapture(false);
		}
	}, [state]);

	const onDragPointerDown = useCallback((event: React.PointerEvent) => {
		// Only start a drag on primary button presses on the drag region.
		if (event.button !== 0) {
			return;
		}
		dragging.current = true;
		moved.current = false;
		last.current = { x: event.screenX, y: event.screenY };
		event.currentTarget.setPointerCapture(event.pointerId);
	}, []);

	const onDragPointerMove = useCallback((event: React.PointerEvent) => {
		if (!(dragging.current && last.current)) {
			return;
		}
		const dx = event.screenX - last.current.x;
		const dy = event.screenY - last.current.y;
		if (dx !== 0 || dy !== 0) {
			// First movement of this gesture: show the snap-zone overlay, telling
			// main where the *visible* island shape sits inside the oversized
			// window so the snap aligns the pill (not the window) to a zone. The
			// drag handle is a child of the shape, so its parent is that element.
			if (!moved.current) {
				moved.current = true;
				const shape = event.currentTarget.parentElement;
				const rect = shape?.getBoundingClientRect();
				winApi()?.dragStart({
					x: rect?.left ?? 0,
					y: rect?.top ?? 0,
					width: rect?.width ?? event.currentTarget.clientWidth,
					height: rect?.height ?? event.currentTarget.clientHeight,
				});
			}
			winApi()?.moveBy(dx, dy);
			last.current = { x: event.screenX, y: event.screenY };
		}
	}, []);

	// Build a pointer-up handler bound to a specific tap action. Each handle
	// (logo, detail pill) gets its own so a bare click can do different things
	// while every handle shares the drag gesture above.
	const makePointerUp = useCallback(
		(onTap?: () => void) => (event: React.PointerEvent) => {
			if (!dragging.current) {
				return;
			}
			dragging.current = false;
			last.current = null;
			event.currentTarget.releasePointerCapture(event.pointerId);
			// Only snap/persist when an actual drag happened, not on a bare click.
			if (moved.current) {
				moved.current = false;
				winApi()?.dragEnd();
				return;
			}
			// No movement: treat the press-release as a tap.
			onTap?.();
		},
		[]
	);

	// Moving the window under the cursor can make the OS fire `pointercancel`
	// instead of `pointerup`, which would skip `makePointerUp` and strand the snap
	// overlay on screen. End the drag the same way here (snap/persist if it moved),
	// but never fire the tap action — a cancel is not a click.
	const onDragPointerCancel = useCallback((event: React.PointerEvent) => {
		if (!dragging.current) {
			return;
		}
		dragging.current = false;
		last.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		if (moved.current) {
			moved.current = false;
		}
		// Always tell main the drag is over so it snaps/persists and tears down the
		// zone overlay, even if no `pointerup` ever arrives.
		winApi()?.dragEnd();
	}, []);

	return {
		onPointerEnter,
		onPointerLeave,
		onDragPointerDown,
		onDragPointerMove,
		onDragPointerCancel,
		makePointerUp,
	};
}
