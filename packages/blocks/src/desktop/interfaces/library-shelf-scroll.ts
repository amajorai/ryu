import { type RefObject, useCallback, useEffect, useState } from "react";
import { inlineScrollOffset } from "./inline-direction.ts";

/** Scroll state for a horizontal shelf, so the arrows know when to rest. */
export function useScrollEdges(
	ref: RefObject<HTMLElement | null>,
	itemCount: number
) {
	const [edges, setEdges] = useState({ end: true, start: true });
	const measure = useCallback(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const max = element.scrollWidth - element.clientWidth;
		const offset = inlineScrollOffset(element);
		setEdges({
			end: offset >= max - 1,
			start: offset <= 1,
		});
	}, [ref]);
	useEffect(() => {
		const element = ref.current;
		if (!element || itemCount === 0) {
			return;
		}
		measure();
		element.addEventListener("scroll", measure, { passive: true });
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(measure);
		observer?.observe(element);
		return () => {
			element.removeEventListener("scroll", measure);
			observer?.disconnect();
		};
	}, [ref, measure, itemCount]);
	return edges;
}
