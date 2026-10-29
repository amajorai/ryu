/** One visibility observer per document, shared by passive view refreshers. */
const listeners = new Set<() => void>();
let intersects = true;
let lastVisible = true;
let stop: (() => void) | undefined;

export function isViewVisible(): boolean {
	return (
		globalThis.document === undefined ||
		(document.visibilityState !== "hidden" && intersects)
	);
}

/** Includes CSS-hidden sandboxed frames without reading their parent document. */
export function subscribeViewVisibility(listener: () => void): () => void {
	listeners.add(listener);
	if (!stop && globalThis.document !== undefined) {
		const notify = (force = false) => {
			const visible = isViewVisible();
			if (visible === lastVisible && !force) {
				return;
			}
			lastVisible = visible;
			for (const callback of listeners) {
				callback();
			}
		};
		lastVisible = isViewVisible();
		const onDocumentVisibility = () => notify(true);
		document.addEventListener("visibilitychange", onDocumentVisibility);
		let observer: IntersectionObserver | undefined;
		if (
			globalThis.IntersectionObserver !== undefined &&
			window.parent !== window
		) {
			observer = new IntersectionObserver((entries) => {
				const entry = entries.at(-1);
				if (!entry) {
					return;
				}
				intersects = entry.isIntersecting;
				notify();
			});
			observer.observe(document.documentElement);
		}
		stop = () => {
			observer?.disconnect();
			document.removeEventListener("visibilitychange", onDocumentVisibility);
			intersects = true;
		};
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			stop?.();
			stop = undefined;
		}
	};
}
