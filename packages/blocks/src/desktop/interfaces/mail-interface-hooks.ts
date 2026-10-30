import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

const MINUTE = 60_000;
/** Below this width the navigation starts as Gmail's icon rail. */
export const NAV_RAIL_BELOW = 1100;
/** Below this width the navigation hides behind the menu button. */
export const NAV_HIDDEN_BELOW = 720;
/** At or above this width an open conversation sits beside the list. */
export const SPLIT_MIN_WIDTH = 1100;
/** At or above this width the reading pane previews the cursor row at rest. */
export const PREVIEW_MIN_WIDTH = 1280;
/** Rows go stacked when the list is narrower than this. */
export const LINE_MIN_LIST_WIDTH = 600;
/** Width assumed before the first measurement (and where layout is absent). */
const UNMEASURED_WIDTH = 1440;

/** Wall clock that ticks once a minute so relative times stay honest. */
export function useMinuteClock(): [number, () => void] {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	const refresh = useCallback(() => setNow(Date.now()), []);
	return [now, refresh];
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
		target.closest("[data-testid='mail-thread-view']") !== null ||
		target.closest("[role='dialog'], [role='menu'], [role='listbox']") !== null
	);
}

/**
 * A stable callback that always runs the latest closure, so the document
 * listener is attached once and never reads stale state.
 */
export function useEffectEventLike<Args extends unknown[]>(
	handler: (...args: Args) => void
): (...args: Args) => void {
	const handlerRef = useRef(handler);
	useLayoutEffect(() => {
		handlerRef.current = handler;
	});
	return useCallback((...args: Args) => handlerRef.current(...args), []);
}
