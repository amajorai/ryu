import type { LiteralMessage } from "@ryu/i18n/react";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { type RefObject, useEffect, useLayoutEffect, useState } from "react";

export const EMPTY_SNAPSHOT: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: 1,
};

/** Seconds between position updates: smooth driving, or rare jumps. */
export const TICK_MS = 1000;
export const REDUCED_TICK_MS = 30_000;

/** Escape belongs to text fields; elsewhere it closes the open trip. */
export function escapeIsFree(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return true;
	}
	return (
		target.closest("input, textarea, select, [contenteditable='true']") === null
	);
}

/** At this width and up the trip panel floats over the map's left side. */
export const WIDE_FROM = 1000;
/** Lawn round the city, for trees and the shore. */
export const CITY_RIM = 1.8;

/** The element's width, kept current; 0 until it is measured. */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const measure = () => {
			if (element.clientWidth > 0) {
				setWidth(element.clientWidth);
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
	return width;
}

/** World units kept round the plates when the act layer frames the map. */
export const RIDES_ACT_PLATE_FIT = {
	above: 1.2,
	below: 0.8,
	max: 2.2,
	side: 1,
};

/** The panel's one-line summary under "Get a ride". */
export function panelStatus(
	counts: { arrived: number; enRoute: number },
	tl: LiteralMessage
): string {
	if (counts.enRoute === 0 && counts.arrived === 0) {
		return "No trips under way";
	}
	return tl("{enRoute} under way · {arrived} arrived", {
		arrived: String(counts.arrived),
		enRoute: String(counts.enRoute),
	});
}

/** A clock that ticks while the page is visible. */
export function useNow(intervalMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		let timer: ReturnType<typeof setInterval> | null = null;
		const start = () => {
			if (timer === null) {
				setNow(Date.now());
				timer = setInterval(() => setNow(Date.now()), intervalMs);
			}
		};
		const stop = () => {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		};
		const onVisibility = () => {
			if (document.hidden) {
				stop();
			} else {
				start();
			}
		};
		start();
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			stop();
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [intervalMs]);
	return now;
}
