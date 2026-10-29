// Hover/focus intent prefetch for tab routes.
//
// Any element carrying `data-prefetch-path="/some/route"` warms that route's
// code (and any data its registry entry preloads) when the pointer rests on it
// or keyboard focus lands on it, so the click usually finds everything cached.
// One delegated listener covers the sidebar, palette and any other surface that
// opts in with the attribute; no per-link handlers are needed.
//
// After the shell settles, the same attribute list is warmed in idle time, so
// the routes a user can see in the sidebar are ready before they reach for them.

import { contributionRegistry } from "@/src/contributions/registry.ts";

export const PREFETCH_PATH_ATTR = "data-prefetch-path";

/** A short dwell filters out a pointer sweeping across the sidebar. */
const HOVER_INTENT_MS = 60;
const IDLE_WARM_DELAY_MS = 1500;
/** Chunks are memoised forever, but route data goes stale, so a path may be
 *  re-warmed after this window (prefetchQuery skips fresh data by itself). */
const REWARM_AFTER_MS = 30_000;

const warmedAt = new Map<string, number>();

function recentlyWarmed(path: string): boolean {
	const at = warmedAt.get(path);
	return at !== undefined && Date.now() - at < REWARM_AFTER_MS;
}

export function prefetchRoute(path: string): void {
	if (!path || recentlyWarmed(path)) {
		return;
	}
	warmedAt.set(path, Date.now());
	contributionRegistry.preload(path);
}

function pathFromEventTarget(target: EventTarget | null): string | null {
	if (!(target instanceof Element)) {
		return null;
	}
	return (
		target
			.closest(`[${PREFETCH_PATH_ATTR}]`)
			?.getAttribute(PREFETCH_PATH_ATTR) ?? null
	);
}

interface IdleHandle {
	cancel: () => void;
}

function scheduleIdle(run: () => void): IdleHandle {
	if (window.requestIdleCallback !== undefined) {
		const id = window.requestIdleCallback(run, { timeout: 5000 });
		return { cancel: () => window.cancelIdleCallback(id) };
	}
	const id = window.setTimeout(run, 0);
	return { cancel: () => window.clearTimeout(id) };
}

/** Install the delegated intent listeners plus the idle warm-up. Returns teardown. */
export function installRoutePrefetch(root: Document = document): () => void {
	let hoverTimer: ReturnType<typeof setTimeout> | null = null;
	let hoverPath: string | null = null;

	const clearHover = () => {
		if (hoverTimer) {
			clearTimeout(hoverTimer);
			hoverTimer = null;
		}
		hoverPath = null;
	};

	const onPointerOver = (event: Event) => {
		const path = pathFromEventTarget(event.target);
		if (path === hoverPath) {
			return;
		}
		clearHover();
		if (!path || recentlyWarmed(path)) {
			return;
		}
		hoverPath = path;
		hoverTimer = setTimeout(() => {
			hoverTimer = null;
			prefetchRoute(path);
		}, HOVER_INTENT_MS);
	};

	const onFocusIn = (event: Event) => {
		const path = pathFromEventTarget(event.target);
		if (path) {
			prefetchRoute(path);
		}
	};

	// Pointer-down beats the click by ~100ms; start then even without a hover
	// (touch, or a very fast click).
	const onPointerDown = onFocusIn;

	root.addEventListener("pointerover", onPointerOver, { passive: true });
	root.addEventListener("focusin", onFocusIn);
	root.addEventListener("pointerdown", onPointerDown, { passive: true });

	let idle: IdleHandle | null = null;
	const warmTimer = setTimeout(() => {
		idle = scheduleIdle(() => {
			for (const element of root.querySelectorAll(`[${PREFETCH_PATH_ATTR}]`)) {
				const path = element.getAttribute(PREFETCH_PATH_ATTR);
				if (path) {
					prefetchRoute(path);
				}
			}
		});
	}, IDLE_WARM_DELAY_MS);

	return () => {
		clearHover();
		clearTimeout(warmTimer);
		idle?.cancel();
		root.removeEventListener("pointerover", onPointerOver);
		root.removeEventListener("focusin", onFocusIn);
		root.removeEventListener("pointerdown", onPointerDown);
	};
}
