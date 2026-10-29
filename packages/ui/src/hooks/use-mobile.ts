import { useEffect, useState } from "react";

/** Phone-ish widths: the sidebar becomes a Sheet, docks become overlays. */
const MOBILE_BREAKPOINT = 768;
/** Phone + small-tablet widths: side-by-side chrome (rails, splits) is off. */
const COMPACT_BREAKPOINT = 1024;

function matches(query: string): boolean {
	if (globalThis.window === undefined || !window.matchMedia) {
		return false;
	}
	return window.matchMedia(query).matches;
}

/**
 * Subscribe to a media query. Seeded synchronously from `matchMedia` so the
 * first paint is already correct — a lazily-seeded value renders the desktop
 * chrome for one frame and flashes a 288px sidebar onto a 375px screen.
 */
export function useMediaQuery(query: string): boolean {
	const [value, setValue] = useState(() => matches(query));

	useEffect(() => {
		if (globalThis.window === undefined || !window.matchMedia) {
			return;
		}
		const mql = window.matchMedia(query);
		const onChange = (e: MediaQueryListEvent) => setValue(e.matches);
		setValue(mql.matches);
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, [query]);

	return value;
}

const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;
const COMPACT_QUERY = `(max-width: ${COMPACT_BREAKPOINT - 1}px)`;

/** True below 768px — the width at which the sidebar becomes a Sheet. */
export function useIsMobile(): boolean {
	return useMediaQuery(MOBILE_QUERY);
}

/**
 * True below 1024px. Wider than {@link useIsMobile}: use it for chrome that
 * needs real horizontal room (the assistant's 380px rail, split panes, docked
 * side panels) but that a phone-only check would leave broken on tablets.
 */
export function useIsCompact(): boolean {
	return useMediaQuery(COMPACT_QUERY);
}
