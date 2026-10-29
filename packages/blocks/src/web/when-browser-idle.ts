/**
 * Run `task` once the browser is idle, so non-essential work (smooth scrolling,
 * eager prefetches) stays off the hydration critical path. Where
 * `requestIdleCallback` is missing (Safari), the task runs on the first frame
 * after `load`. `timeoutMs` caps the idle wait on both paths. Returns a cancel
 * function, and is a no-op on the server.
 */
export function whenBrowserIdle(
	task: () => void,
	timeoutMs = 2000
): () => void {
	if (typeof window === "undefined") {
		return noop;
	}
	if (typeof window.requestIdleCallback === "function") {
		const handle = window.requestIdleCallback(() => task(), {
			timeout: timeoutMs,
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
	cap = setTimeout(run, timeoutMs);
	return () => {
		done = true;
		clear();
	};
}

function noop(): void {
	// Nothing was scheduled.
}
