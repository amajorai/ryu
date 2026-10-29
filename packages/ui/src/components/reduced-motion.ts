import { useSyncExternalStore } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
	if (typeof window === "undefined" || !window.matchMedia) {
		return null;
	}
	return window.matchMedia(REDUCED_MOTION_QUERY);
}

function subscribe(onChange: () => void): () => void {
	const media = reducedMotionQuery();
	media?.addEventListener?.("change", onChange);
	return () => media?.removeEventListener?.("change", onChange);
}

const getSnapshot = (): boolean => reducedMotionQuery()?.matches ?? false;
// The server cannot know the preference; hydration starts from "motion allowed"
// and React re-renders with the real value, so markup never mismatches.
const getServerSnapshot = (): boolean => false;

/** Live `prefers-reduced-motion: reduce`, hydration-safe. */
export function usePrefersReducedMotion(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
