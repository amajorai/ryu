import {
	type RefObject,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { probeWebGL, type WebGLProbe } from "./game3d-toon.ts";
import { isInterfaceCovered } from "./interface-keys.ts";
import {
	EMPTY_THEME,
	readThemeColors,
	type ThemeColors,
} from "./town-palette.ts";

/** `null` until checked on the client, then whether the 3D town can run. */
export function useWebGLSupport(): WebGLProbe | null {
	const [support, setSupport] = useState<WebGLProbe | null>(null);
	useEffect(() => {
		setSupport(probeWebGL());
	}, []);
	return support;
}

/**
 * One shared clock for the HUD date and every petition age, ticking every
 * fifteen seconds, so they all agree and only timers re-render.
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
		}, 15_000);
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

/** The current time, refreshed every fifteen seconds while anything listens. */
export function useNow(): number {
	return useSyncExternalStore(subscribeClock, readClock, readClock);
}

/**
 * Whether the stage is on screen, the tab is visible and the interface is not
 * under a host page: the scene stops drawing frames otherwise. A page the host
 * opens over the interface (Settings, the Marketplace) neither scrolls the
 * stage out of view nor hides the tab, so the cover is read from the
 * interface root's `inert` ancestor.
 */
export function useStageVisible(ref: RefObject<HTMLElement | null>): boolean {
	const [inView, setInView] = useState(true);
	const [pageVisible, setPageVisible] = useState(true);
	const [covered, setCovered] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof MutationObserver === "undefined") {
			return;
		}
		// The renderer's own panels make parts of its tree inert; only an inert
		// ancestor of the whole interface is the host's cover.
		const shell = element.closest("[data-game-shell]") ?? element;
		const update = () => setCovered(isInterfaceCovered(shell));
		update();
		const observer = new MutationObserver(update);
		observer.observe(document.body, {
			attributeFilter: ["inert"],
			attributes: true,
			subtree: true,
		});
		return () => observer.disconnect();
	}, [ref]);
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
	return inView && pageVisible && !covered;
}

/** The element's content width, tracked with a ResizeObserver. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			if (entry) {
				setWidth(Math.round(entry.contentRect.width));
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
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
