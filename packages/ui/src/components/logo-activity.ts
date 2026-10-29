import { useEffect, useState } from "react";

const IDLE_TIMEOUT_MS = 2000;

/**
 * Run `task` once the browser is idle, so decorative work stays off the
 * hydration critical path. Without `requestIdleCallback` (Safari) the task runs
 * on the first frame after `load`. `IDLE_TIMEOUT_MS` caps the wait on both
 * paths. Returns a cancel function. This mirrors `whenBrowserIdle` in
 * `@ryu/blocks`, which depends on this package and so cannot be imported here.
 */
function whenIdle(task: () => void): () => void {
	if (typeof window.requestIdleCallback === "function") {
		const handle = window.requestIdleCallback(task, {
			timeout: IDLE_TIMEOUT_MS,
		});
		return () => window.cancelIdleCallback(handle);
	}
	let frame = 0;
	let cap: ReturnType<typeof setTimeout> | undefined;
	let done = false;
	const clear = () => {
		window.removeEventListener("load", afterLoad);
		if (frame) {
			window.cancelAnimationFrame(frame);
			frame = 0;
		}
		if (cap !== undefined) {
			clearTimeout(cap);
			cap = undefined;
		}
	};
	// Whichever of the post-load frame and the cap fires first runs the task
	// once and clears the other.
	const run = () => {
		if (done) {
			return;
		}
		done = true;
		clear();
		task();
	};
	function afterLoad() {
		frame = window.requestAnimationFrame(run);
	}
	if (document.readyState === "complete") {
		afterLoad();
	} else {
		window.addEventListener("load", afterLoad, { once: true });
	}
	// A stalled subresource can hold `load` back indefinitely, and a hidden tab
	// never paints the frame. One bounded timer, cleared once the task runs or is
	// cancelled, mirrors the `timeout` option `requestIdleCallback` gets.
	cap = setTimeout(run, IDLE_TIMEOUT_MS);
	return () => {
		done = true;
		clear();
	};
}

/**
 * Whether a logo's decorative motion (blinking, gaze, wandering) should run:
 * only after the browser has gone idle once, while `element` is on screen, and
 * while the tab is visible. Starts false, so server markup and the hydration
 * render are the resting mark.
 */
export function useLogoActivity(
	element: Element | null,
	enabled: boolean
): boolean {
	const [active, setActive] = useState(false);

	useEffect(() => {
		if (!(enabled && element)) {
			setActive(false);
			return;
		}
		let idle = false;
		let onScreen = typeof IntersectionObserver === "undefined";
		const update = () =>
			setActive(idle && onScreen && document.visibilityState === "visible");
		const observer = onScreen
			? null
			: new IntersectionObserver((entries) => {
					for (const entry of entries) {
						onScreen = entry.isIntersecting;
					}
					update();
				});
		observer?.observe(element);
		document.addEventListener("visibilitychange", update);
		const cancelIdle = whenIdle(() => {
			idle = true;
			update();
		});
		return () => {
			cancelIdle();
			observer?.disconnect();
			document.removeEventListener("visibilitychange", update);
		};
	}, [element, enabled]);

	return active;
}
