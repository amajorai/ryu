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

/** The toolbar's previous / Today / next group for the day and month pages. */
export function pagerFor(
	view: JournalView,
	actions: Pick<JournalPager, "atToday" | "onStep" | "onToday">
): JournalPager | null {
	if (view === "day") {
		return {
			...actions,
			nextKeys: ["⌥", "→"],
			nextLabel: "Next day",
			nextShortcut: "Alt+ArrowRight",
			previousKeys: ["⌥", "←"],
			previousLabel: "Previous day",
			previousShortcut: "Alt+ArrowLeft",
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
