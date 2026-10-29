import { isNativeFunction } from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

/**
 * The scroll-derived state the desktop transcript used to get from the shadcn
 * message-scroller's `useMessageScrollerVisibility` / `useMessageScroller`:
 *
 *  - `currentAnchorId` — which user message is at the top of the viewport,
 *    feeding the floating date header and the chat TOC's active marker;
 *  - `scrollToMessage` — the imperative jump ChatToc and the `ryu:scroll-to-message`
 *    deep link use.
 *
 * The beUI MessageScroller is deliberately self-contained (it owns follow-at-edge
 * and rail navigation) and exposes no anchor API, so this hook reconstructs just
 * the two facts the desktop still needs from a scroll listener over the viewport
 * it already refs. Deliberately minimal: no new ResizeObserver, no setState in a
 * layout pass — a rAF-deferred read writes one boolean-ish string per scroll tick.
 */
export function useTranscriptAnchor({
	anchorIds,
	enabled = true,
	topOffset = 12,
	viewportRef,
}: {
	/** The ids to consider anchors, in DOM order (a turn's user-message id). */
	anchorIds: readonly string[];
	enabled?: boolean;
	/** How far past the viewport top an anchor may sit and still count as current. */
	topOffset?: number;
	viewportRef: RefObject<HTMLElement | null>;
}) {
	const [currentAnchorId, setCurrentAnchorId] = useState<string | null>(null);
	const elementsRef = useRef(new Map<string, HTMLElement>());
	const frameRef = useRef<number | undefined>(undefined);
	const lastIdRef = useRef<string | null>(null);

	const registerAnchor = useCallback((id: string, el: HTMLElement | null) => {
		if (el) {
			elementsRef.current.set(id, el);
		} else {
			elementsRef.current.delete(id);
		}
	}, []);

	const scrollToMessage = useCallback(
		(messageId: string, options?: { behavior?: ScrollBehavior }) => {
			const viewport = viewportRef.current;
			const el = elementsRef.current.get(messageId);
			if (!(viewport && el)) {
				return false;
			}
			const behavior = options?.behavior ?? "smooth";
			const top = el.offsetTop - topOffset;
			if (isNativeFunction(viewport.scrollTo)) {
				viewport.scrollTo({ top, behavior });
			} else {
				viewport.scrollTop = top;
			}
			return true;
		},
		[topOffset, viewportRef]
	);

	useEffect(() => {
		if (!enabled) {
			lastIdRef.current = null;
			setCurrentAnchorId(null);
			return;
		}
		const viewport = viewportRef.current;
		if (!viewport) {
			return;
		}

		const update = () => {
			const line = viewport.getBoundingClientRect().top + topOffset;
			let current: string | null = null;
			for (const id of anchorIds) {
				const el = elementsRef.current.get(id);
				if (!el) {
					continue;
				}
				if (el.getBoundingClientRect().top <= line) {
					current = id;
				}
			}
			if (current === lastIdRef.current) {
				return;
			}
			lastIdRef.current = current;
			setCurrentAnchorId(current);
		};

		const frame = requestAnimationFrame(update);
		const onScroll = () => {
			if (frameRef.current) {
				cancelAnimationFrame(frameRef.current);
			}
			frameRef.current = requestAnimationFrame(update);
		};
		viewport.addEventListener("scroll", onScroll, { passive: true });

		return () => {
			cancelAnimationFrame(frame);
			if (frameRef.current) {
				cancelAnimationFrame(frameRef.current);
			}
			viewport.removeEventListener("scroll", onScroll);
		};
	}, [anchorIds, enabled, topOffset, viewportRef]);

	return { currentAnchorId, registerAnchor, scrollToMessage };
}
