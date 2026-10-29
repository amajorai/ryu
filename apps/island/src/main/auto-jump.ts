// Auto-jump controller: when enabled, follow the user to the desktop/monitor they
// are active on. We poll the OS cursor at a low frequency and, once it has settled
// on a *different* display than the island for a short while, move the island onto
// that display (preserving its zone). The settle debounce keeps a quick mouse
// sweep across a monitor seam from teleporting the island mid-gesture.
//
// `index.ts` seeds the enabled flag from Core before the first window is built and
// updates it on each SSE change; the window getter is read live each tick so a
// window recreation (appearance change) is handled transparently.

import type { BrowserWindow } from "electron";
import { DEFAULT_AUTO_JUMP } from "../shared/auto-jump.ts";
import { isIslandAtRest } from "./ipc/win.ts";
import { isIslandOnActiveDisplay, moveToActiveDisplay } from "./position.ts";
import { ACRYLIC_START_HEIGHT, ACRYLIC_START_WIDTH } from "./window.ts";

/** How often to sample the cursor's display while enabled. */
const POLL_INTERVAL_MS = 700;
/**
 * Consecutive samples the cursor must sit on a different display before the island
 * follows. ~1.4s of intent, so glancing across a seam does not move it.
 */
const SETTLE_TICKS = 2;
/** Slack (px) above the resting footprint that still counts as "at rest". */
const RESTING_SLACK = 8;

let enabled = DEFAULT_AUTO_JUMP;
let timer: ReturnType<typeof setInterval> | null = null;
let settled = 0;
let getWindow: () => BrowserWindow | null = () => null;
let isMaterial: () => boolean = () => false;

/**
 * Whether the island is at its resting footprint and therefore safe to relocate.
 * In either appearance an open panel, or a footprint shifted off its dock to stay
 * on-screen, is not at rest: the resting geometry would place it wrongly, and a
 * later collapse would glide back to the old dock. A translucent window never
 * changes size, so that is its whole test; a material window *is* the island and
 * grows when it morphs open, so it must also be small.
 */
function isAtRest(win: BrowserWindow): boolean {
	if (!isIslandAtRest(win)) {
		return false;
	}
	if (!isMaterial()) {
		return true;
	}
	const [width, height] = win.getSize();
	return (
		width <= ACRYLIC_START_WIDTH + RESTING_SLACK &&
		height <= ACRYLIC_START_HEIGHT + RESTING_SLACK
	);
}

function stop(): void {
	if (timer !== null) {
		clearInterval(timer);
		timer = null;
	}
	settled = 0;
}

function tick(): void {
	const win = getWindow();
	if (!win || win.isDestroyed()) {
		return;
	}
	// Never yank an open or shifted island using resting geometry; require a
	// fresh settle once it is back at rest.
	if (!isAtRest(win)) {
		settled = 0;
		return;
	}
	// Only count toward a jump while the cursor genuinely sits on another monitor;
	// reset the moment it returns to the island's display.
	if (isIslandOnActiveDisplay(win)) {
		settled = 0;
		return;
	}
	settled += 1;
	if (settled < SETTLE_TICKS) {
		return;
	}
	moveToActiveDisplay(win);
	// Re-arm the debounce: the island is now under the cursor, so the next jump
	// waits for the cursor to settle on another monitor again.
	settled = 0;
}

function start(): void {
	if (timer !== null) {
		return;
	}
	settled = 0;
	timer = setInterval(tick, POLL_INTERVAL_MS);
}

/**
 * Wire the controller to the live island window + appearance. Call once at
 * startup; the getters are read on every tick so window recreation needs no
 * re-init.
 */
export function initAutoJump(
	windowGetter: () => BrowserWindow | null,
	materialGetter: () => boolean
): void {
	getWindow = windowGetter;
	isMaterial = materialGetter;
}

/** Enable/disable auto-jump, starting or stopping the poll loop accordingly. */
export function setAutoJump(value: boolean): void {
	if (value === enabled) {
		return;
	}
	enabled = value;
	if (enabled) {
		start();
	} else {
		stop();
	}
}

/**
 * Immediately move the island to the active display, if enabled and at rest.
 * Hooked to the window `show` event so toggling visibility lands it on the
 * monitor the user is currently working on without waiting for the settle loop.
 */
export function jumpNow(): void {
	if (!enabled) {
		return;
	}
	const win = getWindow();
	if (win && !win.isDestroyed() && isAtRest(win)) {
		moveToActiveDisplay(win);
	}
	settled = 0;
}
