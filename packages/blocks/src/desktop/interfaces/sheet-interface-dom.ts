import { type RefObject, useEffect, useLayoutEffect, useState } from "react";

const MINUTE = 60_000;
/** Width assumed before the first measurement (and where layout is absent). */
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
export function ownsKeys(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.closest("[data-sheet-thread-view]") !== null
	);
}

/** True when a document-level key event belongs to this sheet (or to nobody). */
export function keyIsOurs(
	root: HTMLElement | null,
	target: EventTarget | null
) {
	if (!root) {
		return false;
	}
	if (target === document.body || target === document.documentElement) {
		return true;
	}
	return target instanceof Node && root.contains(target);
}

/** Mirror the scroll offsets onto the container for the frozen-edge shadows. */
export function markScrolled(element: HTMLElement) {
	const x = String(element.scrollLeft > 0);
	const y = String(element.scrollTop > 0);
	// Columns cut off at the right edge: a cast shadow says there is more.
	const right = String(
		element.scrollWidth - element.clientWidth - element.scrollLeft > 1
	);
	if (element.dataset.scrolledX !== x) {
		element.dataset.scrolledX = x;
	}
	if (element.dataset.scrolledY !== y) {
		element.dataset.scrolledY = y;
	}
	if (element.dataset.overflowRight !== right) {
		element.dataset.overflowRight = right;
	}
}
