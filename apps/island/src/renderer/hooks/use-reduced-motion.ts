// Tracks the user's `prefers-reduced-motion` setting (Island U4).
//
// Used to swap the suggestion chip's animated countdown ring for a static
// affordance and to suppress non-essential motion. Lives as its own hook so any
// island surface can opt into motion-safe rendering.

import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/** Returns true when the OS requests reduced motion. */
export function useReducedMotion(): boolean {
	const [reduced, setReduced] = useState<boolean>(() => {
		if (typeof window === "undefined" || !window.matchMedia) {
			return false;
		}
		return window.matchMedia(QUERY).matches;
	});

	useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) {
			return;
		}
		const media = window.matchMedia(QUERY);
		const onChange = (event: MediaQueryListEvent): void => {
			setReduced(event.matches);
		};
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, []);

	return reduced;
}
