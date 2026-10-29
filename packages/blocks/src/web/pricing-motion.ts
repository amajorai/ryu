import { type RefObject, useEffect } from "react";

/** Set while the element is outside the viewport; read by `pricing-motion.module.css`. */
export const MOTION_OFFSCREEN_ATTRIBUTE = "data-motion-offscreen";

// One observer for every card on the page: its callback only flips an
// attribute on the entry's own element, so nothing is per-card but the target.
let sharedObserver: IntersectionObserver | null = null;
let observedCount = 0;

function observer(): IntersectionObserver {
	sharedObserver ??= new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				entry.target.toggleAttribute(
					MOTION_OFFSCREEN_ATTRIBUTE,
					!entry.isIntersecting
				);
			}
		},
		// Resume a little before the card scrolls in, so it never enters frozen.
		{ rootMargin: "120px 0px" }
	);
	return sharedObserver;
}

/**
 * Marks `ref`'s element with {@link MOTION_OFFSCREEN_ATTRIBUTE} while it is off
 * screen, so its decorative loops (pricing-motion.module.css `offscreenAware`)
 * pause there and stop costing a style recalculation every frame.
 *
 * The attribute is written straight to the DOM rather than through state: the
 * card never re-renders for it. Without IntersectionObserver (tests, old
 * engines) nothing is marked and the motion simply runs, as it did before.
 */
export function usePauseMotionOffscreen(
	ref: RefObject<HTMLElement | null>
): void {
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof IntersectionObserver === "undefined") {
			return;
		}
		const shared = observer();
		shared.observe(element);
		observedCount += 1;
		return () => {
			shared.unobserve(element);
			element.removeAttribute(MOTION_OFFSCREEN_ATTRIBUTE);
			observedCount -= 1;
			if (observedCount === 0) {
				shared.disconnect();
				sharedObserver = null;
			}
		};
	}, [ref]);
}
