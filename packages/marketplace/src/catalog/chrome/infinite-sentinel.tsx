// packages/marketplace/src/catalog/chrome/infinite-sentinel.tsx
//
// Moved verbatim from apps/desktop/src/components/store/InfiniteSentinel.tsx.
// Shared by the catalog sections; the desktop path re-exports this.

import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useEffect, useRef } from "react";

/**
 * A bottom-of-list marker that calls `onLoadMore` when scrolled into view, for
 * infinite-scroll lists. Both catalog lists scroll inside their own
 * `overflow-auto` container (not the viewport), so the observer's `root` must be
 * that container — passing `null` would observe the viewport and misfire. The
 * caller supplies the scroll element via `root`.
 */
export default function InfiniteSentinel({
	onLoadMore,
	hasMore,
	loading,
	root,
}: {
	onLoadMore: () => void;
	hasMore: boolean;
	loading: boolean;
	root: HTMLElement | null;
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
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) {
					onLoadMoreRef.current();
				}
			},
			{ root, rootMargin: "200px" }
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
