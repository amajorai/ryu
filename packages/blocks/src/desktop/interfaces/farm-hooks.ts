import { type RefObject, useEffect, useLayoutEffect, useState } from "react";

export interface ElementSize {
	height: number;
	width: number;
}

/**
 * The element's content-box size, kept current with a ResizeObserver. Starts
 * from `fallback` so the first (and server) render has a sensible size, and
 * stays on it where ResizeObserver is missing.
 */
export function useElementSize(
	ref: RefObject<HTMLElement | null>,
	fallback: ElementSize
): ElementSize {
	const [size, setSize] = useState(fallback);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const measure = () => {
			const width = element.clientWidth;
			const height = element.clientHeight;
			if (width > 0 && height > 0) {
				setSize((current) =>
					current.width === width && current.height === height
						? current
						: { height, width }
				);
			}
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

/** The current time, refreshed once a minute for the HUD clock. */
export function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}
