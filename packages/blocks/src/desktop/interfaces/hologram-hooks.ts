import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * The current time, re-read on each `intervalMs` boundary so a seconds clock
 * flips with the system clock rather than drifting from mount time.
 */
export function useHoloNow(intervalMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const schedule = () => {
			const current = Date.now();
			timer = setTimeout(
				() => {
					setNow(Date.now());
					schedule();
				},
				intervalMs - (current % intervalMs)
			);
		};
		schedule();
		return () => clearTimeout(timer);
	}, [intervalMs]);
	return now;
}

/** Width and height of an element, tracked with a ResizeObserver. */
export function useElementSize(ref: RefObject<HTMLElement | null>): {
	height: number;
	width: number;
} {
	const [size, setSize] = useState({ height: 0, width: 0 });
	useEffect(() => {
		const node = ref.current;
		if (!node) {
			return;
		}
		const measure = () => {
			const width = Math.round(node.clientWidth);
			const height = Math.round(node.clientHeight);
			setSize((current) =>
				current.width === width && current.height === height
					? current
					: { height, width }
			);
		};
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

/** Characters per second the briefing types at. */
const TYPE_RATE = 48;

/**
 * Types `text` out one character at a time, the first time only: later
 * changes (new counts) swap in at once. Returns the visible prefix; with
 * `instant` (reduced motion) it is the whole line from the start.
 */
export function useTypedText(text: string, instant: boolean): string {
	const [shown, setShown] = useState(instant ? Number.POSITIVE_INFINITY : 0);
	const typedRef = useRef(instant);
	useEffect(() => {
		if (instant || typedRef.current) {
			typedRef.current = true;
			setShown(Number.POSITIVE_INFINITY);
			return;
		}
		let count = 0;
		const timer = setInterval(() => {
			count += 1;
			setShown(count);
			if (count >= text.length) {
				typedRef.current = true;
				setShown(Number.POSITIVE_INFINITY);
				clearInterval(timer);
			}
		}, 1000 / TYPE_RATE);
		return () => clearInterval(timer);
	}, [text, instant]);
	return text.slice(0, shown);
}

/** Degrees per second the agent ring turns. */
const SPIN_RATE = 2;
/**
 * The ring advances in ticks, not every frame: at this rate a node moves
 * about a pixel per tick, which reads as a smooth drift, keeps style writes
 * to ten a second, and leaves the node still between ticks so a press lands.
 */
const SPIN_STEP_MS = 100;

/** The ring stops by itself after this many degrees: one full turn. */
const SPIN_LIMIT = 360;

/**
 * Turns the agent ring by writing `--holo-spin` (degrees) on `ref`, without
 * re-rendering. Stops while `paused` (a menu is open, the pointer or focus is
 * on the ring, or the viewer paused it), when motion is reduced, and when the
 * page is hidden. After one full turn it settles and calls `onSettle`, so the
 * motion never runs on unattended. `angleRef` always holds the current angle,
 * so a radial menu can open on the side of a node that faces away from the
 * core.
 */
export function useRingSpin(
	ref: RefObject<HTMLElement | null>,
	angleRef: { current: number },
	enabled: boolean,
	paused: boolean,
	onSettle: () => void
): void {
	const travelledRef = useRef(0);
	const settleRef = useRef(onSettle);
	useEffect(() => {
		settleRef.current = onSettle;
	}, [onSettle]);
	useEffect(() => {
		const node = ref.current;
		if (!node) {
			return;
		}
		node.style.setProperty("--holo-spin", `${angleRef.current}deg`);
		if (!enabled || paused || typeof requestAnimationFrame === "undefined") {
			return;
		}
		if (travelledRef.current >= SPIN_LIMIT) {
			// Resumed after settling: run another full turn.
			travelledRef.current = 0;
		}
		let frame = 0;
		let last: number | null = null;
		const tick = (time: number) => {
			if (last === null || document.hidden) {
				last = time;
			} else if (time - last >= SPIN_STEP_MS) {
				const step = (Math.min(250, time - last) / 1000) * SPIN_RATE;
				angleRef.current = (angleRef.current + step) % 360;
				travelledRef.current += step;
				node.style.setProperty("--holo-spin", `${angleRef.current}deg`);
				last = time;
				if (travelledRef.current >= SPIN_LIMIT) {
					settleRef.current();
					return;
				}
			}
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [ref, angleRef, enabled, paused]);
}

/**
 * How many list rows sit wholly or partly below a scroll container's fold.
 * Re-checked on scroll and whenever the container or its content resizes, so
 * a panel can say "3 more" instead of silently clipping its list. A body that
 * overflows without rows (free text) counts as one. `content` re-attaches the
 * observers when the rows are replaced.
 */
export function useHiddenBelow(
	ref: RefObject<HTMLElement | null>,
	content: unknown
): number {
	const [hidden, setHidden] = useState(0);
	useEffect(() => {
		const node = ref.current;
		if (!node) {
			return;
		}
		const measure = () => {
			const fold = node.getBoundingClientRect().bottom;
			if (node.scrollHeight - node.scrollTop - node.clientHeight <= 2) {
				setHidden(0);
				return;
			}
			let count = 0;
			for (const row of node.querySelectorAll("li")) {
				if (row.getBoundingClientRect().bottom > fold + 2) {
					count += 1;
				}
			}
			setHidden(Math.max(1, count));
		};
		measure();
		node.addEventListener("scroll", measure, { passive: true });
		if (typeof ResizeObserver === "undefined") {
			return () => node.removeEventListener("scroll", measure);
		}
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		for (const child of node.children) {
			observer.observe(child);
		}
		return () => {
			node.removeEventListener("scroll", measure);
			observer.disconnect();
		};
	}, [ref, content]);
	return hidden;
}
