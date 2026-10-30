import { useCallback, useEffect, useState } from "react";
import { displayWallDate } from "./calendar-model.ts";
import { TIMELINE_EVENT_ATTRIBUTE } from "./timeline-parts.tsx";

export const EVENT_SELECTOR = `[${TIMELINE_EVENT_ATTRIBUTE}]`;
/** How long a jumped-to day stays tinted. */
const HIGHLIGHT_MS = 1200;

/** A day key that is tinted briefly after a jump, then clears itself. */
export function useTransientHighlight(): [
	string | null,
	(key: string) => void,
] {
	const [key, setKey] = useState<string | null>(null);
	useEffect(() => {
		if (!key) {
			return;
		}
		const timer = window.setTimeout(() => setKey(null), HIGHLIGHT_MS);
		return () => window.clearTimeout(timer);
	}, [key]);
	// A repeated jump to the same day restarts the tint.
	const flash = useCallback((next: string) => {
		setKey(null);
		requestAnimationFrame(() => setKey(next));
	}, []);
	return [key, flash];
}

/**
 * The current time as the display time zone's wall clock, refreshed every half
 * minute so "Today" and "now" stay true, and at once when the zone changes.
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

export function focusEvent(target: HTMLElement | null | undefined): boolean {
	if (!target) {
		return false;
	}
	target.focus();
	target.scrollIntoView({ block: "nearest", inline: "nearest" });
	return true;
}

/** Arrow keys in the day list: step through threads in reading order. */
export function moveInDayList(
	root: HTMLElement,
	from: HTMLElement,
	key: string
) {
	const events = [...root.querySelectorAll<HTMLElement>(EVENT_SELECTOR)];
	const index = events.indexOf(from);
	const next: Record<string, number> = {
		ArrowDown: index + 1,
		ArrowUp: index - 1,
		End: events.length - 1,
		Home: 0,
	};
	const target = next[key];
	if (target === undefined) {
		return false;
	}
	focusEvent(events[target]);
	return true;
}

export function chipAt(root: HTMLElement, column: number, row: number) {
	return root.querySelector<HTMLElement>(
		`${EVENT_SELECTOR}[data-column="${column}"][data-row="${row}"]`
	);
}

/**
 * Arrow keys in the week grid: up/down through a day by time, left/right to
 * the nearest thread in the next day that has any.
 */
export function moveInWeek(root: HTMLElement, from: HTMLElement, key: string) {
	const column = Number(from.dataset.column);
	const row = Number(from.dataset.row);
	if (key === "ArrowDown" || key === "ArrowUp") {
		focusEvent(chipAt(root, column, row + (key === "ArrowDown" ? 1 : -1)));
		return true;
	}
	if (key !== "ArrowLeft" && key !== "ArrowRight") {
		return false;
	}
	const step = key === "ArrowRight" ? 1 : -1;
	for (let next = column + step; next >= 0 && next < 7; next += step) {
		const count = root.querySelectorAll(
			`${EVENT_SELECTOR}[data-column="${next}"]`
		).length;
		if (count > 0) {
			focusEvent(chipAt(root, next, Math.min(row, count - 1)));
			return true;
		}
	}
	return true;
}
