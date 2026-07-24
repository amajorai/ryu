// packages/marketplace/src/catalog/chrome/infinite-sentinel.tsx
//
// Moved verbatim from apps/desktop/src/components/store/InfiniteSentinel.tsx.
// Shared by the catalog sections; the desktop path re-exports this.

import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useEffect, useRef } from "react";

/** Walk up from `start` to the nearest ancestor that actually scrolls. That
 *  element is the ONLY correct IntersectionObserver root: observing a
 *  non-scrolling wrapper (or a wrapper clipped by a scrolling ancestor) makes the
 *  sentinel read as permanently intersecting, so `onLoadMore` fires once and the
 *  list stalls after ~2 pages. Returns null if nothing scrolls (→ viewport). */
function nearestScrollParent(start: HTMLElement): HTMLElement | null {
	let el: HTMLElement | null = start.parentElement;
	while (el) {
		const overflowY = getComputedStyle(el).overflowY;
		if (overflowY === "auto" || overflowY === "scroll") {
			return el;
		}
		el = el.parentElement;
	}
	return null;
}

/**
 * A bottom-of-list marker that calls `onLoadMore` when scrolled into view, for
 * infinite-scroll lists. Catalog lists scroll inside an `overflow-auto` container
 * (not the viewport), so the observer's root must be THAT container. The sentinel
 * resolves it itself by walking up to the nearest scrolling ancestor, so every
 * section pages correctly regardless of what (if anything) it passes as `root`;
 * the `root` prop is only a fallback when no scrolling ancestor is found.
 */
export default function InfiniteSentinel({
	onLoadMore,
	hasMore,
	loading,
	root = null,
}: {
	onLoadMore: () => void;
	hasMore: boolean;
	loading: boolean;
	/** Optional explicit scroll container; used only if the walk finds none. */
	root?: HTMLElement | null;
}) {
	const ref = useRef<HTMLDivElement>(null);
	// Keep the latest callback without re-creating the observer each render.
	const onLoadMoreRef = useRef(onLoadMore);
	onLoadMoreRef.current = onLoadMore;

	useEffect(() => {
		const el = ref.current;
		if (!(el && hasMore)) {
			return;
		}
		const observerRoot = nearestScrollParent(el) ?? root;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) {
					onLoadMoreRef.current();
				}
			},
			{ root: observerRoot, rootMargin: "200px" }
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [hasMore, root]);

	if (!(hasMore || loading)) {
		return null;
	}

	return (
		<div className="flex justify-center py-3" ref={ref}>
			{loading ? <Spinner className="size-4" /> : <span className="h-4" />}
		</div>
	);
}
