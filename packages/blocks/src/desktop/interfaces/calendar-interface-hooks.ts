import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { type CalendarScale, displayWallDate } from "./calendar-model.ts";

export type Zone = "main" | "mini";

export interface FocusRequest {
	key: string;
	zone: Zone;
}

/** "M" and "W" switch the scale, like the reference's shortcuts. */
export const SCALE_KEYS: Partial<Record<string, CalendarScale>> = {
	m: "month",
	w: "week",
};

/**
 * The current time on the display zone's wall clock ({@link displayWallDate}),
 * refreshed every half minute, and at once when the display-timezone
 * preference (`revision`) changes, so "today" and "now" stay true.
 */
export function useNow(revision: string): Date {
	const [now, setNow] = useState(() => displayWallDate(Date.now()));
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new display-timezone revision moves the wall clock now, not on the next tick.
	useEffect(() => {
		setNow(displayWallDate(Date.now()));
		const timer = window.setInterval(
			() => setNow(displayWallDate(Date.now())),
			30_000
		);
		return () => window.clearInterval(timer);
	}, [revision]);
	return now;
}

/**
 * Whether a media query matches. Server renders (and tests without layout)
 * assume a wide desktop window, which is where the calendar usually lives.
 */
export function useMediaMatch(query: string): boolean {
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (typeof window === "undefined" || !window.matchMedia) {
				return () => undefined;
			}
			const list = window.matchMedia(query);
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		},
		[query]
	);
	return useSyncExternalStore(
		subscribe,
		() =>
			typeof window !== "undefined" && window.matchMedia
				? window.matchMedia(query).matches
				: false,
		() => false
	);
}

/** Keys typed into a field belong to the field (or the host's composer). */
export function isEditable(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !== null
	);
}

export function zoneOf(target: HTMLElement): Zone | null {
	const zone = target.closest<HTMLElement>("[data-calendar-zone]")?.dataset
		.calendarZone;
	return zone === "main" || zone === "mini" ? zone : null;
}
