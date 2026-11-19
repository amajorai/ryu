import { useEffect, useLayoutEffect, useState } from "react";
import type { JournalView } from "./journal-model.ts";

const MINUTE = 60_000;
/** Below this width the timeline and the page take turns. */
export const STACK_BELOW = 720;
/** Below this width the timeline narrows to give the page room. */
export const NARROW_BELOW = 1100;
const SERIF_KEY = "ryu.interfaces.journal.serif";
export const EASE = [0.22, 1, 0.36, 1] as const;

export const VIEWS: { id: JournalView; label: string }[] = [
	{ id: "day", label: "Day" },
	{ id: "calendar", label: "Calendar" },
	{ id: "stats", label: "Stats" },
];

export function readSerif(): boolean {
	try {
		return window.localStorage.getItem(SERIF_KEY) !== "off";
	} catch {
		return true;
	}
}

export function writeSerif(serif: boolean): void {
	try {
		window.localStorage.setItem(SERIF_KEY, serif ? "on" : "off");
	} catch {
		// Storage can be blocked; the choice then lasts for this session only.
	}
}

/** Wall clock that ticks once a minute so "today" rolls over at midnight. */
export function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/** The element's width, kept current with a ResizeObserver. */
export function useElementWidth(ref: { current: HTMLElement | null }): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		setWidth(element.getBoundingClientRect().width);
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((records) => {
			const rect = records[0]?.contentRect;
			if (rect) {
				setWidth(rect.width);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

export function isEditable(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.tagName === "INPUT" ||
			target.tagName === "TEXTAREA" ||
			target.tagName === "SELECT")
	);
}

/** Whether the element is rendered (not detached or inside display: none). */
export function isShown(element: HTMLElement): boolean {
	if (!element.isConnected) {
		return false;
	}
	return typeof element.checkVisibility === "function"
		? element.checkVisibility()
		: element.getClientRects().length > 0;
}

/** Escapes a value for a quoted CSS attribute selector. */
export function cssString(value: string): string {
	return value.replace(/["\\]/g, "\\$&");
}

export interface JournalPager {
	atToday: boolean;
	nextKeys?: string[];
	nextLabel: string;
	nextShortcut?: string;
	onStep: (direction: -1 | 1) => void;
	onToday: () => void;
	previousKeys?: string[];
	previousLabel: string;
	previousShortcut?: string;
}

const ARROW_GLYPH = { Left: "←", Right: "→" } as const;

/**
 * The day step for an Alt+Arrow key on the day page. The pager runs along the
 * inline axis, so under a right-to-left layout ArrowRight goes back a day and
 * ArrowLeft goes forward; any other key does not step.
 */
export function dayStepForKey(key: string, sign: 1 | -1): -1 | 0 | 1 {
	if (key === "ArrowRight") {
		return sign;
	}
	if (key === "ArrowLeft") {
		return sign === 1 ? -1 : 1;
	}
	return 0;
}

/**
 * The toolbar's previous / Today / next group for the day and month pages.
 * `sign` is `-1` under a right-to-left layout, where the key caps and
 * shortcuts point the other way.
 */
export function pagerFor(
	view: JournalView,
	{
		sign = 1,
		...actions
	}: Pick<JournalPager, "atToday" | "onStep" | "onToday"> & { sign?: 1 | -1 }
): JournalPager | null {
	if (view === "day") {
		const forward = sign === 1 ? "Right" : "Left";
		const back = sign === 1 ? "Left" : "Right";
		return {
			...actions,
			nextKeys: ["⌥", ARROW_GLYPH[forward]],
			nextLabel: "Next day",
			nextShortcut: `Alt+Arrow${forward}`,
			previousKeys: ["⌥", ARROW_GLYPH[back]],
			previousLabel: "Previous day",
			previousShortcut: `Alt+Arrow${back}`,
		};
	}
	if (view === "calendar") {
		return {
			...actions,
			nextLabel: "Next month",
			previousLabel: "Previous month",
		};
	}
	return null;
}
