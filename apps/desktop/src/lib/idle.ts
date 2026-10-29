/**
 * Run deferrable startup work (SDK downloads) once the main thread is idle, so
 * it never competes with the first render. Runs the task exactly once.
 *
 * WebKit has no `requestIdleCallback`, so it waits for the next frame instead.
 * WebKit suspends frames while the page is hidden (a window started hidden at
 * login), which would hold the task until the window is shown; a hidden page
 * paints nothing, so there the task runs once the document has loaded. With
 * neither API (tests, workers) it runs now. Never uses timers.
 */
export function runWhenIdle(task: () => void, timeoutMs = 3000): void {
	if (typeof globalThis.requestIdleCallback === "function") {
		globalThis.requestIdleCallback(() => task(), { timeout: timeoutMs });
		return;
	}
	if (typeof globalThis.requestAnimationFrame !== "function") {
		task();
		return;
	}
	const page: Document | undefined = globalThis.document;
	if (!page) {
		globalThis.requestAnimationFrame(() => task());
		return;
	}
	let done = false;
	const onPageChange = () => {
		if (page.visibilityState === "hidden" && page.readyState === "complete") {
			run();
		}
	};
	const run = () => {
		if (done) {
			return;
		}
		done = true;
		globalThis.cancelAnimationFrame?.(frame);
		page.removeEventListener("visibilitychange", onPageChange);
		page.removeEventListener("readystatechange", onPageChange);
		task();
	};
	const frame = globalThis.requestAnimationFrame(run);
	page.addEventListener("visibilitychange", onPageChange);
	page.addEventListener("readystatechange", onPageChange);
	onPageChange();
}
