import { useEffect } from "react";
import type { IsoFit } from "./game3d-stage-framing.ts";
import type { IsoView } from "./game3d-stage-view.tsx";

/** Zoom range on top of the fitted zoom, and the step per +/- press. */
export const MAX_ZOOM = 3;
export const MIN_ZOOM = 0.85;
export const ZOOM_STEP = 1.25;
/** A drag longer than this (px) is a pan, and swallows the click after it. */
export const CLICK_SLOP = 5;

/** The camera's zoom factor and pan on top of the fitted view. */
export interface IsoCameraState {
	factor: number;
	panRight: number;
	panUp: number;
}

/** The view's zoom commands (in, out, reset), for `IsoCamera`. */
export function useIsoCameraZoom(
	view: IsoView | undefined,
	apply: (use?: IsoFit) => void,
	state: { current: IsoCameraState }
): void {
	useEffect(
		() =>
			view?.listen((command) => {
				const current = state.current;
				if (command === "reset") {
					current.factor = 1;
					current.panRight = 0;
					current.panUp = 0;
				} else {
					const next =
						command === "in"
							? current.factor * ZOOM_STEP
							: current.factor / ZOOM_STEP;
					current.factor = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
				}
				apply();
			}),
		[apply, state, view]
	);
}

/**
 * Drag pans, the wheel zooms, and a pan's click is swallowed, for
 * `IsoCamera`; a press stops a focus glide.
 */
export function useIsoCameraPointer(
	element: HTMLCanvasElement,
	apply: (use?: IsoFit) => void,
	fit: IsoFit,
	state: { current: IsoCameraState },
	glide: { current: number }
): void {
	useEffect(() => {
		let drag: { id: number; x: number; y: number } | null = null;
		let start: { x: number; y: number } | null = null;
		let dragged = false;
		const down = (event: PointerEvent) => {
			if (event.button !== 0) {
				return;
			}
			drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
			start = { x: event.clientX, y: event.clientY };
			dragged = false;
			cancelAnimationFrame(glide.current);
		};
		const move = (event: PointerEvent) => {
			if (!drag || drag.id !== event.pointerId) {
				return;
			}
			if (
				start &&
				Math.hypot(event.clientX - start.x, event.clientY - start.y) >
					CLICK_SLOP
			) {
				dragged = true;
			}
			const zoom = fit.zoom * state.current.factor;
			state.current.panRight -= (event.clientX - drag.x) / zoom;
			state.current.panUp += (event.clientY - drag.y) / zoom;
			drag = { id: drag.id, x: event.clientX, y: event.clientY };
			apply();
		};
		const up = () => {
			drag = null;
		};
		// A pan ends in a click on whatever is under the pointer: swallow it
		// before the scene's own click handlers see it.
		const click = (event: MouseEvent) => {
			// A keyboard activation (Enter on a plate) is no pan's click.
			if (event.detail === 0) {
				dragged = false;
				return;
			}
			if (dragged) {
				dragged = false;
				event.stopPropagation();
				event.preventDefault();
			}
		};
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			const current = state.current;
			current.factor = Math.max(
				MIN_ZOOM,
				Math.min(MAX_ZOOM, current.factor * Math.exp(-event.deltaY * 0.0015))
			);
			apply();
		};
		element.addEventListener("pointerdown", down);
		element.addEventListener("pointermove", move);
		element.addEventListener("pointerup", up);
		element.addEventListener("pointerleave", up);
		element.addEventListener("wheel", wheel, { passive: false });
		element.addEventListener("click", click, { capture: true });
		return () => {
			element.removeEventListener("click", click, { capture: true });
			element.removeEventListener("pointerdown", down);
			element.removeEventListener("pointermove", move);
			element.removeEventListener("pointerup", up);
			element.removeEventListener("pointerleave", up);
			element.removeEventListener("wheel", wheel);
		};
	}, [apply, element, fit.zoom, glide, state]);
}
