import { type RefObject, useEffect } from "react";
import { EASE_OUT_CSS } from "../lib/ease.ts";

// Drop preview for drag targets whose drop logic lives elsewhere (Plate's
// `useDropLine`): instead of a drawn line, the hovered element and its
// neighbour on the drop side ease apart, opening a gap where the drop lands.
// Each side moves half the gap so the opening stays centred on the boundary.
//
// Only transforms move, so layout is untouched. The drop logic's hit testing
// reads the transformed boxes (Plate measures with getBoundingClientRect), and
// half a 12px gap only adds a little hysteresis at the boundary. Styles are
// written imperatively and restored on cleanup because the elements belong to
// the editor renderer.

/** The gap opened between the two neighbours, in px. */
const NUDGE_GAP = 12;
const NUDGE_TRANSITION = `transform 180ms ${EASE_OUT_CSS}`;

export type DropSide = "top" | "bottom" | "left" | "right";

function nudge(el: Element | null, offset: number, axis: "X" | "Y") {
	if (!(el instanceof HTMLElement)) {
		return () => undefined;
	}
	const reducedMotion =
		window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
	const previousTransform = el.style.transform;
	const previousTransition = el.style.transition;
	if (!reducedMotion) {
		el.style.transition = NUDGE_TRANSITION;
	}
	el.style.transform = `translate${axis}(${offset}px)`;
	return () => {
		el.style.transform = previousTransform;
		if (reducedMotion) {
			return;
		}
		// Ease back, then hand the element its own transition again.
		const restore = () => {
			el.style.transition = previousTransition;
			el.removeEventListener("transitionend", restore);
		};
		el.addEventListener("transitionend", restore);
		window.setTimeout(restore, 400);
	};
}

/**
 * Opens a gap on `side` of the element behind `ref` while `side` is set.
 * `side` is the drop line Plate reports for that element.
 */
export function useDropNudge(
	ref: RefObject<HTMLElement | null>,
	side: DropSide | "" | null | undefined
) {
	useEffect(() => {
		const el = ref.current;
		if (!(el && side)) {
			return;
		}
		const axis = side === "left" || side === "right" ? "X" : "Y";
		const opensBefore = side === "top" || side === "left";
		// Logical left/right follow the writing direction.
		const rtl = axis === "X" && getComputedStyle(el).direction === "rtl";
		const half = (NUDGE_GAP / 2) * (rtl ? -1 : 1);
		const neighbour = opensBefore
			? el.previousElementSibling
			: el.nextElementSibling;
		const undoSelf = nudge(el, opensBefore ? half : -half, axis);
		const undoNeighbour = nudge(neighbour, opensBefore ? -half : half, axis);
		return () => {
			undoSelf();
			undoNeighbour();
		};
	}, [ref, side]);
}
