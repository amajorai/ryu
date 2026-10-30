import { type RefObject, useEffect, useLayoutEffect, useState } from "react";
import type { RecordsObject } from "./records-model.ts";

const MINUTE = 60_000;
/** At or above this width the objects rail shows; below it, a menu. */
export const NAV_MIN_WIDTH = 768;
/** At or above this width an open thread docks; below it, it floats. */
export const DOCK_MIN_WIDTH = 1100;
/** Content width below which a record's attributes move into the page. */
export const DETAILS_ASIDE_MIN_WIDTH = 760;
/** Main-column width at which inline attributes split into two columns. */
export const DETAILS_TWO_COLUMN_MIN_WIDTH = 720;
/** Width of the objects rail (w-56). */
export const NAV_WIDTH = 224;
/** The docked thread panel's width: clamp(380px, 40%, 560px). */
export const DOCK_MIN = 380;
export const DOCK_MAX = 560;
export const DOCK_SHARE = 0.4;
/** Width assumed before the first measurement. */
const UNMEASURED_WIDTH = 1440;

/** Wall clock that ticks once a minute so relative times stay honest. */
export function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/** The element's rendered width, kept current with a ResizeObserver. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
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
		const observer = new ResizeObserver((entries) => {
			const next = entries[0]?.contentRect.width;
			if (next !== undefined) {
				setWidth(next);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width || UNMEASURED_WIDTH;
}

/** True for targets whose keys belong to typing or to the host's chat. */
export function ownsKeys(target: EventTarget): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.closest("[data-testid='records-thread-panel']") !== null
	);
}

export function cursorStep(
	key: string
): "first" | "last" | "next" | "previous" | null {
	switch (key) {
		case "ArrowDown":
		case "j":
			return "next";
		case "ArrowUp":
		case "k":
			return "previous";
		case "Home":
			return "first";
		case "End":
			return "last";
		default:
			return null;
	}
}

export interface OpenRecord {
	id: string;
	object: RecordsObject;
}
