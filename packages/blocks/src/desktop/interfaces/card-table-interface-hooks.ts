import {
	type KeyboardEvent as ReactKeyboardEvent,
	type RefObject,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { StageSize } from "./card-table-model.ts";
import { isInterfaceCovered } from "./interface-keys.ts";

/**
 * The Card Table renderer's own hooks: the stage and root measurements, the
 * minute clock, the drawer tracking, the clipped-frame scroll guard and the
 * table's document keys. Split out of `card-table-interface.tsx`.
 */

/** Laid out at this size until the stage is measured (and in static renders). */
export const DEFAULT_STAGE: StageSize = { height: 760, width: 1180 };
/** How long after mount layout moves start animating. */
const SETTLE_MS = 600;
/** How long seats follow the stage frame by frame while the drawer moves. */
const DRAWER_TRACK_MS = 700;
const MINUTE_MS = 60_000;

/**
 * The stage's size, measured before paint and kept current. `settled` turns
 * true shortly after mount: the table only animates seat and felt moves from
 * then on, so it does not visibly grow from the default size (or follow the
 * host's own first layout passes) while the hand is being dealt.
 */
export function useStageSize(ref: RefObject<HTMLDivElement | null>): {
	settled: boolean;
	size: StageSize;
} {
	const [size, setSize] = useState<StageSize>(DEFAULT_STAGE);
	const [settled, setSettled] = useState(false);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const measure = () => {
			const rect = element.getBoundingClientRect();
			// Detached or unlaid-out stages (tests, hidden tabs) keep the default.
			if (rect.width > 0 && rect.height > 0) {
				setSize({ height: rect.height, width: rect.width });
			}
		};
		measure();
		const timer = setTimeout(() => setSettled(true), SETTLE_MS);
		if (typeof ResizeObserver === "undefined") {
			return () => clearTimeout(timer);
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => {
			clearTimeout(timer);
			observer.disconnect();
		};
	}, [ref]);
	return { settled, size };
}

/**
 * Where an element ends below its offset parent's top (px), kept current;
 * 0 until laid out (and in static renders).
 */
export function useBottomEdge(
	ref: RefObject<HTMLDivElement | null>,
	on: boolean
) {
	const [bottom, setBottom] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!(on && element)) {
			setBottom(0);
			return;
		}
		const measure = () =>
			setBottom(Math.ceil(element.offsetTop + element.offsetHeight));
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [on, ref]);
	return bottom;
}

/** The time, refreshed every minute so ages and timers move on their own. */
export function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
		return () => clearInterval(timer);
	}, []);
	return now;
}

/**
 * An element's width, kept current. `ready` turns true one frame after the
 * first real measurement, so layout that depends on it can jump into place on
 * mount and only animate the changes that follow.
 */
export function useElementWidth(
	ref: RefObject<HTMLDivElement | null>,
	fallback: number
): { ready: boolean; width: number } {
	const [width, setWidth] = useState(fallback);
	const [measured, setMeasured] = useState(false);
	const [ready, setReady] = useState(false);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const measure = () => {
			const next = element.getBoundingClientRect().width;
			if (next > 0) {
				setWidth(next);
				setMeasured(true);
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
	useEffect(() => {
		if (!measured || ready) {
			return;
		}
		const frame = requestAnimationFrame(() => setReady(true));
		return () => cancelAnimationFrame(frame);
	}, [measured, ready]);
	return { ready, width };
}

/**
 * True for a moment after the drawer opens or closes. The stage then resizes
 * every frame with the drawer, and seats follow it directly instead of easing
 * after it (an eased seat lags, and can slip off the shrinking stage).
 */
export function useDrawerTracking(panelOpen: boolean): boolean {
	const [tracking, setTracking] = useState(false);
	const previous = useRef(panelOpen);
	useEffect(() => {
		if (previous.current === panelOpen) {
			return;
		}
		previous.current = panelOpen;
		setTracking(true);
		const timer = setTimeout(() => setTracking(false), DRAWER_TRACK_MS);
		return () => clearTimeout(timer);
	}, [panelOpen]);
	return tracking;
}

/** Escape and arrows inside a text field belong to the field. */
export function isEditable(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !== null
	);
}

/** Escape on the table (outside a text field) closes the open thread. */
export function escapeCloses(panelOpen: boolean, close: () => void) {
	return (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (
			event.key === "Escape" &&
			panelOpen &&
			!event.defaultPrevented &&
			!isEditable(event.target)
		) {
			event.preventDefault();
			close();
		}
	};
}

/**
 * Closing the drawer takes away whatever had focus inside it (it is still
 * sliding out); put focus back on the card that was in play (or the hand)
 * instead of leaving it in a closing drawer or dropping it to <body>.
 */
export function useDrawerFocusReturn({
	cardRefs,
	closingRef,
	cursorId,
	panelOpen,
	rootRef,
}: {
	cardRefs: RefObject<Map<string, HTMLButtonElement>>;
	closingRef: RefObject<boolean>;
	cursorId: string | null;
	panelOpen: boolean;
	rootRef: RefObject<HTMLDivElement | null>;
}) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable; it runs when the drawer or cursor changes.
	useLayoutEffect(() => {
		if (panelOpen || !closingRef.current) {
			return;
		}
		closingRef.current = false;
		const active = document.activeElement;
		if (
			active &&
			active !== document.body &&
			rootRef.current?.contains(active) &&
			!active.closest("[data-card-table-drawer]")
		) {
			return;
		}
		const target =
			(cursorId ? cardRefs.current.get(cursorId) : undefined) ??
			cardRefs.current.values().next().value;
		target?.focus();
	}, [panelOpen, cursorId]);
}

/**
 * Focusing a card of the tucked fan (below the edge) must not scroll the
 * clipped game frame: put any such scroll straight back.
 */
export function useClippedScrollReset(
	rootRef: RefObject<HTMLDivElement | null>
) {
	useEffect(() => {
		const root = rootRef.current;
		if (!root) {
			return;
		}
		const settle = (event: Event) => {
			const target = event.target;
			// Only clipped frames (overflow hidden); real scrollers keep scrolling.
			if (
				target instanceof HTMLElement &&
				root.contains(target) &&
				target.scrollTop !== 0 &&
				getComputedStyle(target).overflowY === "hidden"
			) {
				target.scrollTop = 0;
			}
		};
		root.addEventListener("scroll", settle, { capture: true });
		return () => root.removeEventListener("scroll", settle, { capture: true });
	}, [rootRef]);
}

interface TableKeyOptions {
	activeThreadId: string | null;
	cardRefs: RefObject<Map<string, HTMLButtonElement>>;
	close: () => void;
	cursorId: string | null;
	dealt: readonly { id: string }[];
	isSpread: boolean;
	panelOpen: boolean;
	rootRef: RefObject<HTMLDivElement | null>;
	setCursorId: (id: string) => void;
}

/**
 * Keys with nothing focused (after a click on the felt) still reach the
 * table: arrows pick up the hand, Escape closes the open thread. The handler
 * reads the latest hand; the listener is added once.
 */
export function useTableDocumentKeys(options: TableKeyOptions) {
	const onDocumentKeyDown = useEffectEvent(
		(event: globalThis.KeyboardEvent) => {
			const { cardRefs, cursorId, dealt, rootRef } = options;
			if (
				event.defaultPrevented ||
				event.target !== document.body ||
				isInterfaceCovered(rootRef.current)
			) {
				return;
			}
			if (event.key === "Escape" && options.panelOpen) {
				event.preventDefault();
				options.close();
				return;
			}
			if (
				options.isSpread ||
				(event.key !== "ArrowLeft" && event.key !== "ArrowRight")
			) {
				return;
			}
			if (dealt.length === 0) {
				return;
			}
			event.preventDefault();
			const current = dealt.findIndex(
				(thread) => thread.id === (cursorId ?? options.activeThreadId)
			);
			let index = current;
			if (current === -1) {
				index = event.key === "ArrowLeft" ? dealt.length - 1 : 0;
			} else {
				index = Math.min(
					dealt.length - 1,
					Math.max(0, current + (event.key === "ArrowLeft" ? -1 : 1))
				);
			}
			const target = dealt[index];
			if (target) {
				options.setCursorId(target.id);
				cardRefs.current.get(target.id)?.focus();
			}
		}
	);
	useEffect(() => {
		const listener = (event: globalThis.KeyboardEvent) =>
			onDocumentKeyDown(event);
		document.addEventListener("keydown", listener);
		return () => document.removeEventListener("keydown", listener);
	}, []);
}
