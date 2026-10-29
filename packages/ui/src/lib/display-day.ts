import { useSyncExternalStore } from "react";
import {
	effectiveTimeZone,
	nextDisplayDayBoundaryMs,
	startOfDisplayDayMs,
	subscribeTimezone,
} from "./timezone.ts";

// One timer for all mounted rows. The bounded wake also detects clock jumps and
// historical date transitions that occur before the nominal following midnight.
const MAX_RECHECK_MS = 60_000;
const subscribers = new Set<() => void>();
let snapshot = "server";
let timeout: ReturnType<typeof setTimeout> | undefined;
let removeTimezone: (() => void) | undefined;
function read(now: number): string {
	return `${effectiveTimeZone()}:${startOfDisplayDayMs(now)}`;
}
function rearm(now: number): void {
	if (timeout !== undefined) {
		clearTimeout(timeout);
	}
	let delay = MAX_RECHECK_MS;
	try {
		const boundary = nextDisplayDayBoundaryMs(now);
		if (Number.isFinite(boundary) && boundary > now) {
			delay = Math.min(delay, boundary - now);
		}
	} catch {
		// A formatter failure cannot leave an already mounted list without a wake.
	}
	timeout = setTimeout(wake, Math.max(1, delay));
}
function wake(): void {
	if (subscribers.size === 0) {
		return;
	}
	const now = Date.now();
	const next = read(now);
	if (next !== snapshot) {
		snapshot = next;
		for (const notify of subscribers) {
			notify();
		}
	}
	rearm(now);
}
function onVisible(): void {
	if (document.visibilityState === "visible") {
		wake();
	}
}
function subscribe(notify: () => void): () => void {
	subscribers.add(notify);
	if (subscribers.size === 1) {
		snapshot = read(Date.now());
		removeTimezone = subscribeTimezone(wake);
		window.addEventListener("focus", wake);
		document.addEventListener("visibilitychange", onVisible);
		rearm(Date.now());
	}
	return () => {
		subscribers.delete(notify);
		if (subscribers.size !== 0) {
			return;
		}
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
		timeout = undefined;
		removeTimezone?.();
		removeTimezone = undefined;
		window.removeEventListener("focus", wake);
		document.removeEventListener("visibilitychange", onVisible);
	};
}
export function useDisplayDayRevision(): string {
	return useSyncExternalStore(
		subscribe,
		() => snapshot,
		() => "server"
	);
}
