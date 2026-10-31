// Landing a rail jump on its message.
//
// Transcript rows carry `content-visibility: auto` with a 10rem placeholder, so
// a row that has never been on screen only takes its real height once a jump
// scrolls past it. The rows a smooth jump reveals above its target grow while
// the scroll runs and push the target down, away from the centre the scroll
// aimed for, and rows keep resizing for a moment after they first render.
// Left alone, the jump lands on a neighbouring message and the rail's active
// item follows that neighbour. A jump therefore holds the active item on its
// target until the scroll ends, glides the rest of the way if it fell short,
// then keeps the target centred until the layout stops moving. Wheel, touch,
// keys or a jump to the latest message cancel it.

/** A jump's target may sit this far from the viewport centre and count as landed. */
const CENTER_TOLERANCE_PX = 2;
/** The layout must hold still this long before the jump counts as landed. */
const LAYOUT_QUIET_MS = 700;
/** Upper bound on anchoring, so a transcript that never stops moving frees the rail. */
const MAX_ANCHOR_MS = 4000;
/** Without `scrollend`, a jump counts as finished once scroll events pause. */
const SCROLL_IDLE_MS = 150;
/** With `scrollend`, a backstop in case the event never arrives. */
const SCROLL_END_BACKSTOP_MS = 1000;
/** How long a smooth scroll may take to start moving before the jump settles anyway. */
const SCROLL_START_GRACE_MS = 400;
/** A smooth jump that ends further off than this glides the rest of the way. */
const SMOOTH_CORRECTION_MIN_PX = 48;
/** Smooth follow-up glides per jump before the remainder snaps into place. */
const MAX_SMOOTH_CORRECTIONS = 2;

export interface RailJump {
	/** Stop the jump where it is (the reader took over); `onSettled` is not called. */
	readonly cancel: () => void;
	/** The rail item the jump is landing on; it stays active until it settles. */
	readonly id: string;
}

export interface RailJumpInput {
	id: string;
	onSettled: () => void;
	/** The scroll that started the jump is smooth, so wait for it to end first. */
	smooth: boolean;
	target: HTMLElement;
	viewport: HTMLElement;
}

/** How far the viewport must scroll for the target to sit at its centre. */
export function railJumpCorrection(viewport: HTMLElement, target: HTMLElement) {
	const viewportRect = viewport.getBoundingClientRect();
	const targetRect = target.getBoundingClientRect();
	const offset =
		targetRect.top +
		targetRect.height / 2 -
		(viewportRect.top + viewportRect.height / 2);
	const maxScrollTop = Math.max(
		0,
		viewport.scrollHeight - viewport.clientHeight
	);
	const nextScrollTop = Math.min(
		maxScrollTop,
		Math.max(0, viewport.scrollTop + offset)
	);
	return nextScrollTop - viewport.scrollTop;
}

/** Hold a rail jump on its target until the scroll and the layout settle. */
export function startRailJump({
	id,
	viewport,
	target,
	smooth,
	onSettled,
}: RailJumpInput): RailJump {
	let active = true;
	let frame = 0;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	const stopWaiting = () => {
		viewport.removeEventListener("scrollend", onScrollEnd);
		viewport.removeEventListener("scroll", onScroll);
		clearTimeout(idleTimer);
	};

	// Anchor the target at the centre each frame until the layout has held
	// still for a while: rows keep resizing after they first render (their
	// placeholder gives way to text, then to the formatted reply).
	const settle = () => {
		let startedAt: number | undefined;
		let lastChangeAt = 0;
		let lastScrollHeight = viewport.scrollHeight;
		const step = (now: number) => {
			frame = 0;
			if (!active) {
				return;
			}
			if (startedAt === undefined) {
				startedAt = now;
				lastChangeAt = now;
			}
			const correction = railJumpCorrection(viewport, target);
			if (Math.abs(correction) > CENTER_TOLERANCE_PX) {
				viewport.scrollTop += correction;
				lastChangeAt = now;
			}
			if (viewport.scrollHeight !== lastScrollHeight) {
				lastScrollHeight = viewport.scrollHeight;
				lastChangeAt = now;
			}
			if (
				!target.isConnected ||
				now - lastChangeAt >= LAYOUT_QUIET_MS ||
				now - startedAt >= MAX_ANCHOR_MS
			) {
				active = false;
				onSettled();
				return;
			}
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
	};

	let smoothCorrections = 0;
	function onScrollEnd() {
		stopWaiting();
		if (!active) {
			return;
		}
		const correction = railJumpCorrection(viewport, target);
		if (
			smooth &&
			smoothCorrections < MAX_SMOOTH_CORRECTIONS &&
			Math.abs(correction) > SMOOTH_CORRECTION_MIN_PX &&
			typeof viewport.scrollBy === "function"
		) {
			smoothCorrections += 1;
			waitForScrollEnd();
			viewport.scrollBy({ top: correction, behavior: "smooth" });
			return;
		}
		settle();
	}

	const idleMs =
		"onscrollend" in viewport ? SCROLL_END_BACKSTOP_MS : SCROLL_IDLE_MS;
	function onScroll() {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(onScrollEnd, idleMs);
	}

	function waitForScrollEnd() {
		viewport.addEventListener("scrollend", onScrollEnd);
		viewport.addEventListener("scroll", onScroll);
		// A jump that needs no scrolling fires no scroll events at all.
		idleTimer = setTimeout(onScrollEnd, SCROLL_START_GRACE_MS);
	}

	if (smooth) {
		waitForScrollEnd();
	} else {
		settle();
	}

	return {
		id,
		cancel: () => {
			active = false;
			stopWaiting();
			if (frame) {
				cancelAnimationFrame(frame);
				frame = 0;
			}
		},
	};
}
