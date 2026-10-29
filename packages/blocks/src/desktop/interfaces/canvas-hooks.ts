import { type RefObject, useEffect, useState } from "react";
import type { CanvasViewport } from "./canvas-model.ts";

const ZERO: CanvasViewport = { height: 0, width: 0 };

/** The element's content-box size, kept current with a ResizeObserver. */
export function useElementSize(
	ref: RefObject<HTMLElement | null>
): CanvasViewport {
	const [size, setSize] = useState<CanvasViewport>(ZERO);
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

/** Wall-clock time that ticks once a minute, for relative ages on stickies. */
export function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/** Whether a key press belongs to a text field or dialog, not the canvas. */
export function isTypingTarget(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.closest("textarea, input, select, [role='dialog']") !== null)
	);
}

/**
 * Whether a key press landed on the board itself (the viewport or a sticky)
 * rather than its chrome. Space, Enter, the arrows and +/- belong to the
 * board only there; on a toolbar or header button they keep their native
 * meaning (Space and Enter press the button).
 */
export function isBoardTarget(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		(target.hasAttribute("data-canvas-viewport") ||
			target.closest("[data-canvas-card]") !== null)
	);
}
