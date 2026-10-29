import type Lenis from "lenis";
import type { LenisOptions } from "lenis";
import { useEffect, useState } from "react";

/** The part of a Lenis instance the on-demand frame loop drives. */
export type FrameDrivenLenis = Pick<Lenis, "isScrolling" | "raf" | "scrollTo">;

/**
 * Advance `lenis` only while it is animating a scroll, instead of Lenis's own
 * `autoRaf` loop, which runs every frame for the life of the page even when
 * nothing moves. Every smooth scroll, wheel-driven or programmatic, starts in
 * `scrollTo`, so wrapping it wakes the loop; the loop stops on the frame the
 * animation settles (Lenis resets `isScrolling` when it completes).
 *
 * Lenis measures each step from the time it was last given, so the clock passed
 * to `raf` only advances while the loop runs: a scroll that starts after a long
 * idle gap eases from its first frame instead of jumping to the end.
 *
 * Returns a cleanup that cancels a pending frame and restores `scrollTo`.
 */
export function driveLenisOnDemand(lenis: FrameDrivenLenis): () => void {
	let frame = 0;
	let clock = performance.now();
	let lastFrameAt = clock;

	const tick = (now: number) => {
		frame = 0;
		clock += Math.max(0, now - lastFrameAt);
		lastFrameAt = now;
		lenis.raf(clock);
		if (lenis.isScrolling === "smooth") {
			frame = window.requestAnimationFrame(tick);
		}
	};
	const wake = () => {
		if (frame === 0) {
			lastFrameAt = performance.now();
			frame = window.requestAnimationFrame(tick);
		}
	};

	const hadOwnScrollTo = Object.hasOwn(lenis, "scrollTo");
	const scrollTo = lenis.scrollTo;
	const scrollToAndWake: FrameDrivenLenis["scrollTo"] = (target, options) => {
		scrollTo.call(lenis, target, options);
		wake();
	};
	lenis.scrollTo = scrollToAndWake;
	// A wheel can reach Lenis between its creation and this call; finish that
	// scroll instead of leaving it frozen until the next input.
	if (lenis.isScrolling === "smooth") {
		wake();
	}

	return () => {
		if (frame !== 0) {
			window.cancelAnimationFrame(frame);
			frame = 0;
		}
		if (lenis.scrollTo !== scrollToAndWake) {
			return;
		}
		if (hadOwnScrollTo) {
			lenis.scrollTo = scrollTo;
		} else {
			Reflect.deleteProperty(lenis, "scrollTo");
		}
	};
}

/**
 * The inputs Lenis would smooth with these options. Keyboard, scrollbar and
 * (without `syncTouch`) touch scrolling stay native even while Lenis runs.
 */
function smoothedInputEvents(options: LenisOptions): string[] {
	const events: string[] = [];
	if (options.smoothWheel !== false) {
		events.push("wheel");
	}
	if (options.syncTouch === true) {
		events.push("touchstart");
	}
	return events;
}

/**
 * Whether the visitor has used an input Lenis would smooth. Until then the page
 * scrolls natively and no Lenis instance exists: no resize observers on the
 * document, no class toggling on `<html>`, no frame loop. The first such input
 * scrolls natively in full (Lenis is created after that event has dispatched,
 * so it is neither lost nor applied twice), and Lenis smooths the ones after.
 * Options that smooth nothing create Lenis right away, as before.
 */
export function useSmoothInputIntent(
	enabled: boolean,
	options: LenisOptions
): boolean {
	const [intent, setIntent] = useState(false);
	const target = options.eventsTarget ?? null;
	const eventsKey = smoothedInputEvents(options).join(" ");

	useEffect(() => {
		if (!enabled || intent || typeof window === "undefined") {
			return;
		}
		const events = eventsKey ? eventsKey.split(" ") : [];
		if (events.length === 0) {
			setIntent(true);
			return;
		}
		const eventsTarget: EventTarget = target ?? window;
		const onIntent = () => setIntent(true);
		for (const type of events) {
			eventsTarget.addEventListener(type, onIntent, { passive: true });
		}
		return () => {
			for (const type of events) {
				eventsTarget.removeEventListener(type, onIntent);
			}
		};
	}, [enabled, eventsKey, intent, target]);

	return intent;
}
