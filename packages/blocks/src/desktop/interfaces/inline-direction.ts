/**
 * Reading-direction helpers for interface skins that scroll or resize along
 * the inline axis. Under `dir="rtl"` the inline start is the physical right:
 * pointer deltas flip sign and modern engines report `scrollLeft` as zero at
 * the start and negative toward the end.
 */

import { useDirection } from "@ryu/ui/components/direction.tsx";

/** `-1` when the element lays out right-to-left, otherwise `1`. */
export function inlineSign(element: Element | null | undefined): 1 | -1 {
	if (!element || typeof getComputedStyle === "undefined") {
		return 1;
	}
	return getComputedStyle(element).direction === "rtl" ? -1 : 1;
}

/**
 * `-1` while the surrounding UI reads right-to-left, otherwise `1`. Multiply a
 * physical motion `x` offset by it so a panel docked at the inline end slides
 * in from (and out toward) that end in either direction.
 */
export function useInlineSign(): 1 | -1 {
	return useDirection() === "rtl" ? -1 : 1;
}

/** How far a horizontal scroller has moved from its inline start, in px. */
export function inlineScrollOffset(element: HTMLElement): number {
	return Math.abs(element.scrollLeft);
}

/** Scroll a horizontal scroller by `delta` px toward its inline end. */
export function scrollInlineBy(
	element: HTMLElement,
	delta: number,
	behavior: ScrollBehavior = "smooth"
) {
	element.scrollBy({ behavior, left: delta * inlineSign(element) });
}

/**
 * A horizontal scroller measured from its inline start, so the same math
 * works under `dir="rtl"` (where `scrollLeft` runs from 0 to negative).
 */
export interface LogicalScroll {
	/** The furthest logical position, in px. */
	max: number;
	/** How far the scroller has moved from its inline start, in px. */
	position: number;
	/** Scroll to `position` px from the inline start. */
	scrollToLogical: (position: number, behavior?: ScrollBehavior) => void;
	/** `-1` when the scroller lays out right-to-left, otherwise `1`. */
	sign: 1 | -1;
}

export function logicalScroll(element: HTMLElement): LogicalScroll {
	const sign = inlineSign(element);
	return {
		max: Math.max(0, element.scrollWidth - element.clientWidth),
		position: Math.abs(element.scrollLeft),
		scrollToLogical: (position, behavior) => {
			const left = position * sign;
			// jsdom and some embedded engines lack element scrolling methods.
			element.scrollTo?.(behavior ? { behavior, left } : { left });
		},
		sign,
	};
}

/**
 * A box's span along `container`'s inline axis, in px from the container's
 * inline start edge (its physical right under `dir="rtl"`).
 */
export function logicalSpan(
	rect: { left: number; right: number },
	container: { left: number; right: number },
	sign: 1 | -1
): { end: number; start: number } {
	if (sign === -1) {
		return {
			end: container.right - rect.left,
			start: container.right - rect.right,
		};
	}
	return {
		end: rect.right - container.left,
		start: rect.left - container.left,
	};
}

/**
 * The arrow key as it reads in `element`'s direction: under `dir="rtl"`
 * ArrowLeft moves toward the inline end, so it is reported as ArrowRight
 * (and vice versa). Other keys pass through unchanged.
 */
export function logicalArrowKey<Key extends string>(
	key: Key,
	element: Element | null | undefined
): Key | "ArrowLeft" | "ArrowRight" {
	if (key !== "ArrowLeft" && key !== "ArrowRight") {
		return key;
	}
	if (inlineSign(element) === 1) {
		return key;
	}
	return key === "ArrowLeft" ? "ArrowRight" : "ArrowLeft";
}

/** `1` for the key that moves toward the inline end, `-1` toward the start, else `0`. */
export function inlineArrowStep(
	key: string,
	element: Element | null | undefined
): -1 | 0 | 1 {
	const logical = logicalArrowKey(key, element);
	if (logical === "ArrowRight") {
		return 1;
	}
	return logical === "ArrowLeft" ? -1 : 0;
}
