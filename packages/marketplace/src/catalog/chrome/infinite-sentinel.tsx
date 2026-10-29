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
	itemCount,
	root = null,
}: {
	onLoadMore: () => void;
	hasMore: boolean;
	/** True while a page request is in flight (e.g. React Query's
	 *  `isFetchingNextPage`), NOT the initial-load flag. */
	loading: boolean;
	/** Loaded row count, BEFORE any client-side filtering. Its growth is the
	 *  sentinel's only evidence that a page actually landed: a grown count
	 *  releases the latch for synchronous hosts (no in-flight flag, `loading`
	 *  stays false) and re-checks a sentinel that is still in view. Hosts that
	 *  omit it never re-check automatically; the next real scroll crossing does. */
	itemCount?: number;
	/** Optional explicit scroll container; used only if the walk finds none. */
	root?: HTMLElement | null;
}) {
	const ref = useRef<HTMLDivElement>(null);
	// Keep the latest callback without re-creating the observer each render.
	const onLoadMoreRef = useRef(onLoadMore);
	onLoadMoreRef.current = onLoadMore;
	const loadingRef = useRef(loading);
	loadingRef.current = loading;
	const requestPendingRef = useRef(false);
	// `itemCount` at the last settle check; a settle that did not grow it is a
	// failed or empty page and must not re-arm automatic paging.
	const settledCountRef = useRef(itemCount);
	const observerRef = useRef<IntersectionObserver | null>(null);

	useEffect(() => {
		const el = ref.current;
		if (!(el && hasMore)) {
			return;
		}
		const observerRoot = nearestScrollParent(el) ?? root;
		const observer = new IntersectionObserver(
			(entries) => {
				if (
					entries[0]?.isIntersecting &&
					!loadingRef.current &&
					!requestPendingRef.current
				) {
					requestPendingRef.current = true;
					onLoadMoreRef.current();
				}
			},
			{ root: observerRoot, rootMargin: "200px" }
		);
		observer.observe(el);
		observerRef.current = observer;
		return () => {
			observer.disconnect();
			observerRef.current = null;
		};
	}, [hasMore, root]);

	// A page request is considered complete when the host clears `loading` (or,
	// for synchronous hosts, when `itemCount` changes). The guard prevents an
	// intersecting sentinel from starting duplicate requests while React Query
	// (or a host equivalent) is still resolving the page.
	//
	// The observer only reports threshold CROSSINGS, so a page that does not push
	// the sentinel out of view (client-side filters over paged data, a short
	// page) would never trigger the next one. Re-observing delivers a fresh entry
	// with the current intersection state, which goes through the same guards.
	// It happens only when `itemCount` changed since the last settle: a FAILED page
	// leaves the count (and React Query's `hasNextPage`) unchanged, and
	// re-observing then would re-request it immediately, in a silent loop for as
	// long as the sentinel stays visible. A failed page only releases the latch,
	// so the user's next scroll crossing retries it.
	useEffect(() => {
		if (loading) {
			return;
		}
		requestPendingRef.current = false;
		const progressed = itemCount !== settledCountRef.current;
		settledCountRef.current = itemCount;
		const el = ref.current;
		const observer = observerRef.current;
		if (progressed && el && observer && hasMore) {
			observer.unobserve(el);
			observer.observe(el);
		}
	}, [loading, hasMore, itemCount]);

	if (!(hasMore || loading)) {
		return null;
	}

	return (
		<div className="flex justify-center py-3" ref={ref}>
			{loading ? <Spinner className="size-4" /> : <span className="h-4" />}
		</div>
	);
}
