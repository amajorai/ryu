import {
	type RefObject,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { probeWebGL, type WebGLProbe } from "./game3d-toon.ts";
import {
	EMPTY_THEME,
	readThemeColors,
	type ThemeColors,
} from "./kitchen-palette.ts";

/** `null` until checked on the client, then whether the 3D scene can run. */
export function useWebGLSupport(): WebGLProbe | null {
	const [support, setSupport] = useState<WebGLProbe | null>(null);
	useEffect(() => {
		setSupport(probeWebGL());
	}, []);
	return support;
}

/**
 * One shared one-second clock for every timer on screen (tickets, rings,
 * the service clock), so they tick together and only timers re-render.
 */
const listeners = new Set<() => void>();
let clockNow = Date.now();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(listener: () => void) {
	listeners.add(listener);
	if (clockTimer === null) {
		clockNow = Date.now();
		clockTimer = setInterval(() => {
			clockNow = Date.now();
			for (const notify of listeners) {
				notify();
			}
		}, 1000);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && clockTimer !== null) {
			clearInterval(clockTimer);
			clockTimer = null;
		}
	};
}

function readClock() {
	return clockNow;
}

/** The current time, updated once a second while anything listens. */
export function useNow(): number {
	return useSyncExternalStore(subscribeClock, readClock, readClock);
}

/**
 * Whether the stage is on screen and the tab is visible: the scene stops
 * drawing frames otherwise.
 */
export function useStageVisible(ref: RefObject<HTMLElement | null>): boolean {
	const [inView, setInView] = useState(true);
	const [pageVisible, setPageVisible] = useState(true);
	useEffect(() => {
		const update = () => setPageVisible(document.visibilityState !== "hidden");
		update();
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof IntersectionObserver === "undefined") {
			return;
		}
		const observer = new IntersectionObserver(([entry]) => {
			if (entry) {
				setInView(entry.isIntersecting);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return inView && pageVisible;
}

/**
 * The theme colours at `ref`, re-read whenever the document's class or
 * inline variables change (theme switches rewrite one or the other).
 */
export function useThemeColors(
	ref: RefObject<HTMLElement | null>
): ThemeColors {
	const [colors, setColors] = useState<ThemeColors>(EMPTY_THEME);
	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const update = () => {
			const next = readThemeColors(element);
			setColors((previous) =>
				JSON.stringify(previous) === JSON.stringify(next) ? previous : next
			);
		};
		update();
		if (typeof MutationObserver === "undefined") {
			return;
		}
		const observer = new MutationObserver(update);
		const options = {
			attributeFilter: ["class", "style", "data-theme"],
			attributes: true,
		};
		observer.observe(element.ownerDocument.documentElement, options);
		if (element.ownerDocument.body) {
			observer.observe(element.ownerDocument.body, options);
		}
		return () => observer.disconnect();
	}, [ref]);
	return colors;
}
