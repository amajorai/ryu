import { type RefObject, useEffect, useLayoutEffect, useState } from "react";
import {
	EMPTY_KNOWLEDGE_THEME,
	type KnowledgeTheme,
	readKnowledgeTheme,
} from "./knowledge-palette.ts";

/**
 * The theme tokens at `ref`, re-read whenever the document's class, style or
 * theme attribute changes (theme switches rewrite one of them).
 */
export function useKnowledgeTheme(
	ref: RefObject<HTMLElement | null>
): KnowledgeTheme {
	const [theme, setTheme] = useState<KnowledgeTheme>(EMPTY_KNOWLEDGE_THEME);
	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const update = () => {
			const next = readKnowledgeTheme(element);
			setTheme((previous) =>
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
	return theme;
}

/**
 * True while the element cannot be seen: the tab is hidden or the element is
 * scrolled or collapsed out of view. Renderers stop their frame loop then.
 */
export function useHidden(ref: RefObject<HTMLElement | null>): boolean {
	const [tabHidden, setTabHidden] = useState(false);
	const [offscreen, setOffscreen] = useState(false);
	useEffect(() => {
		const onVisibility = () => setTabHidden(document.hidden);
		onVisibility();
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, []);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof IntersectionObserver === "undefined") {
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			const entry = entries.at(-1);
			if (entry) {
				setOffscreen(!entry.isIntersecting);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return tabHidden || offscreen;
}

/** The element's content width, tracked with a ResizeObserver. */
export function useWidth(ref: RefObject<HTMLElement | null>): number | null {
	const [width, setWidth] = useState<number | null>(null);
	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		setWidth(element.clientWidth);
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(() => setWidth(element.clientWidth));
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

/**
 * The current time, refreshed every `intervalMs` (relative ages in the side
 * panel stay current without reading the clock during render).
 */
export function useNow(intervalMs = 30_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
		return () => window.clearInterval(timer);
	}, [intervalMs]);
	return now;
}

/**
 * The element's content box, tracked with a ResizeObserver. Read before the
 * first paint, so the loading outline can be placed on the first frame.
 */
export function useSize(
	ref: RefObject<HTMLElement | null>
): { height: number; width: number } | null {
	const [size, setSize] = useState<{ height: number; width: number } | null>(
		null
	);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const update = () =>
			setSize((previous) =>
				previous?.width === element.clientWidth &&
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
