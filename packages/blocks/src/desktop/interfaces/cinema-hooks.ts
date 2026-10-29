import { type RefObject, useEffect, useLayoutEffect, useState } from "react";

const MINUTE = 60_000;

/** Size assumed before the first measurement (and where layout is absent). */
const UNMEASURED = { height: 900, width: 1440 } as const;

export interface CinemaSize {
	height: number;
	width: number;
}

/** Wall clock that ticks once a minute so relative ages stay honest. */
export function useCinemaClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/** The element's rendered size, kept current with a ResizeObserver. */
export function useCinemaSize(ref: RefObject<HTMLElement | null>): CinemaSize {
	const [size, setSize] = useState<CinemaSize | null>(null);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const rect = element.getBoundingClientRect();
		if (rect.width > 0) {
			setSize({ height: rect.height, width: rect.width });
		}
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const box = entries[0]?.contentRect;
			if (box && box.width > 0) {
				setSize({ height: box.height, width: box.width });
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size ?? UNMEASURED;
}

/** True for targets whose keys belong to typing or to the host's chat. */
export function cinemaOwnsKeys(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.closest("[data-cinema-thread-view]") !== null
	);
}
