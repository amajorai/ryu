import {
	type FocusEvent,
	type KeyboardEvent,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { ArcadeMode } from "./arcade-palette.ts";

function readMode(element: HTMLElement): ArcadeMode {
	return element.closest(".dark") === null ? "light" : "dark";
}

/**
 * Light or dark floor, following the `.dark` class the theme sets on an
 * ancestor (re-read whenever the document's class changes).
 */
export function useArcadeMode(ref: RefObject<HTMLElement | null>): ArcadeMode {
	const [mode, setMode] = useState<ArcadeMode>("light");
	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const update = () => setMode(readMode(element));
		update();
		if (typeof MutationObserver === "undefined") {
			return;
		}
		const observer = new MutationObserver(update);
		const options = { attributeFilter: ["class"], attributes: true };
		observer.observe(element.ownerDocument.documentElement, options);
		if (element.ownerDocument.body) {
			observer.observe(element.ownerDocument.body, options);
		}
		return () => observer.disconnect();
	}, [ref]);
	return mode;
}

/** False while the tab is hidden, so the floor can pause its lights and reels. */
export function usePageVisible(): boolean {
	const [visible, setVisible] = useState(true);
	useEffect(() => {
		const update = () => setVisible(document.visibilityState !== "hidden");
		update();
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	return visible;
}

/**
 * Ids that should spin briefly as feedback (a message just went in), each
 * clearing itself after `durationMs`.
 */
export function useSpinFeedback(durationMs: number): {
	spin: (id: string) => void;
	spinning: ReadonlySet<string>;
} {
	const [spinning, setSpinning] = useState<ReadonlySet<string>>(new Set());
	const [timers] = useState(
		() => new Map<string, ReturnType<typeof setTimeout>>()
	);
	useEffect(
		() => () => {
			for (const timer of timers.values()) {
				clearTimeout(timer);
			}
			timers.clear();
		},
		[timers]
	);
	const spin = (id: string) => {
		const existing = timers.get(id);
		if (existing) {
			clearTimeout(existing);
		}
		setSpinning((previous) => new Set(previous).add(id));
		timers.set(
			id,
			setTimeout(() => {
				timers.delete(id);
				setSpinning((previous) => {
					const next = new Set(previous);
					next.delete(id);
					return next;
				});
			}, durationMs)
		);
	};
	return { spin, spinning };
}

export interface ElementSize {
	height: number;
	width: number;
}

/**
 * The element's content box, kept current as it resizes (0 x 0 before
 * layout). `layoutKey` re-measures synchronously after a commit that moves
 * the element's edges (a side panel opening beside it), so the first paint
 * after that commit already uses the new size instead of waiting a frame
 * for the resize observer.
 */
export function useElementSize(
	ref: RefObject<HTMLElement | null>,
	layoutKey?: string
): ElementSize {
	const [size, setSize] = useState<ElementSize>({ height: 0, width: 0 });
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const width = element.clientWidth;
		const height = element.clientHeight;
		setSize((previous) =>
			previous.width === width && previous.height === height
				? previous
				: { height, width }
		);
		// layoutKey is the trigger: a commit that changes it moved the box.
	}, [ref, layoutKey]);
	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const update = () =>
			setSize((previous) =>
				previous.width === element.clientWidth &&
				previous.height === element.clientHeight
					? previous
					: { height: element.clientHeight, width: element.clientWidth }
			);
		update();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

const STOP_SELECTOR = "[data-arcade-stop]";

function enabledStops(container: HTMLElement): HTMLElement[] {
	const stops: HTMLElement[] = [];
	for (const element of container.querySelectorAll<HTMLElement>(
		STOP_SELECTOR
	)) {
		if (!element.hasAttribute("disabled")) {
			stops.push(element);
		}
	}
	return stops;
}

function stopKey(element: Element | null): string | null {
	return (
		element?.closest<HTMLElement>(STOP_SELECTOR)?.dataset.arcadeStop ?? null
	);
}

/**
 * One tab stop per machine: the controls marked `data-arcade-stop` share a
 * roving tabindex, so Tab moves machine to machine and the arrow keys (and
 * Home, End) move between one machine's reels, buttons, tickets and lever.
 * The machine remembers the control last focused; it starts on `initial`.
 */
export function useRovingStops(
	ref: RefObject<HTMLElement | null>,
	initial: string
): {
	onFocus: (event: FocusEvent<HTMLElement>) => void;
	onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
} {
	const current = useRef(initial);
	const apply = () => {
		const container = ref.current;
		if (!container) {
			return;
		}
		const stops = enabledStops(container);
		const target =
			stops.find((stop) => stop.dataset.arcadeStop === current.current) ??
			stops.find((stop) => stop.dataset.arcadeStop === initial) ??
			stops[0];
		for (const stop of container.querySelectorAll<HTMLElement>(STOP_SELECTOR)) {
			stop.tabIndex = stop === target ? 0 : -1;
		}
	};
	// Every commit can add or remove controls (tickets come and go), so the
	// tab stop is re-applied after each one.
	useLayoutEffect(apply);
	const onFocus = (event: FocusEvent<HTMLElement>) => {
		const key = stopKey(event.target);
		if (key && key !== current.current) {
			current.current = key;
			apply();
		}
	};
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		const container = ref.current;
		if (!container || event.altKey || event.ctrlKey || event.metaKey) {
			return;
		}
		const stops = enabledStops(container);
		const from = stops.findIndex((stop) => stop.contains(event.target as Node));
		if (from < 0) {
			return;
		}
		let to = from;
		if (event.key === "ArrowRight" || event.key === "ArrowDown") {
			to = (from + 1) % stops.length;
		} else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
			to = (from - 1 + stops.length) % stops.length;
		} else if (event.key === "Home") {
			to = 0;
		} else if (event.key === "End") {
			to = stops.length - 1;
		} else {
			return;
		}
		event.preventDefault();
		stops[to]?.focus();
	};
	return { onFocus, onKeyDown };
}
