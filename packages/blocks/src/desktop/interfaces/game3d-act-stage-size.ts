import { type RefObject, useEffect, useState } from "react";

/**
 * The stage's CSS size (for `overlayBudget(width, { height })`), `initial`
 * until measured: a stage squeezed beside a thread view is short.
 */
export function useStageSize(
	ref: RefObject<HTMLElement | null>,
	initial: { height: number; width: number } = { height: 800, width: 1280 }
): { height: number; width: number } {
	const [size, setSize] = useState(initial);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			if (entry) {
				setSize({
					height: entry.contentRect.height,
					width: entry.contentRect.width,
				});
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

/** The stage's CSS width (for `overlayBudget`), `initial` until measured. */
export function useStageWidth(
	ref: RefObject<HTMLElement | null>,
	initial = 1280
): number {
	const [width, setWidth] = useState(initial);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			if (entry) {
				setWidth(entry.contentRect.width);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}
