"use client";

import { useEffect } from "react";

/**
 * Requests to hold the page's smooth scrolling still, kept apart from
 * `smooth-scroll.tsx` so a menu can ask for a pause without pulling Lenis into
 * its own bundle. Lenis loads later, on the visitor's first wheel, and reads
 * this store from there.
 */
let pauseCount = 0;
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) {
		listener();
	}
}

export function subscribeSmoothScrollPause(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function isSmoothScrollPaused(): boolean {
	return pauseCount > 0;
}

/**
 * Hold the page still while `paused`, for a menu or dialog open over it.
 *
 * Lenis moves the document with `window.scrollTo`, which a body scroll lock
 * (`overflow: hidden`) does not stop, so a wheel over a modal backdrop would
 * still scroll the page behind it. A stopped Lenis swallows that wheel instead,
 * while a surface marked `data-lenis-prevent` (the open menu's own list) keeps
 * scrolling natively. Pauses are counted, so the page resumes only once every
 * caller has let go.
 */
export function usePauseSmoothScroll(paused: boolean): void {
	useEffect(() => {
		if (!paused) {
			return;
		}
		pauseCount += 1;
		notify();
		return () => {
			pauseCount -= 1;
			notify();
		};
	}, [paused]);
}
