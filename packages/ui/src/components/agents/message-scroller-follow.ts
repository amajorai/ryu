import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { isNativeFunction } from "../../lib/native-primitive-observation.ts";
import type { useMessageScrollerRail } from "./message-scroller-rail-sync.ts";
import type { MessageScrollerBaseScope } from "./message-scroller-scope.ts";

/** How long after the last scroll event the document stops reporting it. */
const SCROLLING_IDLE_MS = 150;
let scrollingIdleTimer: number | undefined;

/**
 * Mark the document while a transcript scrolls (`html[data-scrolling]`), so
 * the shell can drop its remaining backdrop blur for those frames. Shared by
 * every scroller; it clears itself once scrolling has been idle briefly.
 */
function markDocumentScrolling() {
	const root = globalThis.document?.documentElement;
	if (!root) {
		return;
	}
	if (!root.hasAttribute("data-scrolling")) {
		root.setAttribute("data-scrolling", "");
	}
	window.clearTimeout(scrollingIdleTimer);
	scrollingIdleTimer = window.setTimeout(() => {
		root.removeAttribute("data-scrolling");
	}, SCROLLING_IDLE_MS);
}

export type UseMessageScrollerFollowInput = MessageScrollerBaseScope &
	ReturnType<typeof useMessageScrollerRail>;

/** Scrolling to the live edge, scroll handling, and the effects that keep following output. */
export function useMessageScrollerFollow({
	viewportRef,
	setFollowing,
	programmaticScrollRef,
	scrollTimerRef,
	followingRef,
	followThreshold,
	lastScrollTopRef,
	updateActiveRailItem,
	frameRef,
	followOutput,
	contentRef,
	syncUnreadMessages,
	showUnreadMessages,
	unreadStartId,
	newMessageCount,
	scheduleRailSync,
	railTargetsRef,
	setRailItems,
	setRailOverflowing,
	navigation,
	railFrameRef,
}: UseMessageScrollerFollowInput) {
	const activeRailFrameRef = useRef(0);
	const scrollToEnd = useCallback(
		(behavior: ScrollBehavior) => {
			const viewport = viewportRef.current;
			if (!viewport) {
				return;
			}

			setFollowing(true);
			programmaticScrollRef.current = true;
			if (isNativeFunction(viewport.scrollTo)) {
				viewport.scrollTo({ top: viewport.scrollHeight, behavior });
			} else {
				viewport.scrollTop = viewport.scrollHeight;
			}
			if (scrollTimerRef.current) {
				window.clearTimeout(scrollTimerRef.current);
			}
			scrollTimerRef.current = window.setTimeout(
				() => {
					programmaticScrollRef.current = false;
					// Content that grew while the smooth scroll ran (a fast stream)
					// left the animation short of the new end; finish the follow.
					const current = viewportRef.current;
					if (
						followingRef.current &&
						current &&
						current.scrollHeight - current.scrollTop - current.clientHeight >
							followThreshold
					) {
						current.scrollTop = current.scrollHeight;
					}
				},
				behavior === "smooth" ? 320 : 0
			);
		},
		[followThreshold, setFollowing]
	);

	const handleScroll = useCallback(() => {
		const viewport = viewportRef.current;
		if (!viewport) {
			return;
		}

		const distance =
			viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
		const movedUp = viewport.scrollTop < lastScrollTopRef.current;
		lastScrollTopRef.current = viewport.scrollTop;
		// Our own smooth follow passes through positions far from the end, and
		// the end moves while output streams in. Those frames are not the reader
		// leaving the live edge (wheel, touch, and keys clear the flag first).
		// The follow only ever moves DOWN, so an upward move that ends away from
		// the end is the reader leaving (scrollbar drag, Shift+Space, find in
		// page, autoscroll) even while the follow flag is still set. A shrinking
		// transcript clamps scrollTop to the end (distance 0), so it is excluded.
		if (
			programmaticScrollRef.current &&
			movedUp &&
			distance > followThreshold
		) {
			programmaticScrollRef.current = false;
		}
		if (!programmaticScrollRef.current || distance <= followThreshold) {
			setFollowing(distance <= followThreshold);
		}
		markDocumentScrolling();
		// The active rail item measures every target; do it at most once per
		// frame instead of on every scroll event.
		if (!activeRailFrameRef.current) {
			activeRailFrameRef.current = requestAnimationFrame(() => {
				activeRailFrameRef.current = 0;
				updateActiveRailItem();
			});
		}
	}, [followThreshold, setFollowing, updateActiveRailItem]);

	const leaveLiveEdge = useCallback(() => {
		programmaticScrollRef.current = false;
	}, []);

	useLayoutEffect(() => {
		setFollowing(followOutput);
		if (!followOutput) {
			return;
		}

		frameRef.current = requestAnimationFrame(() => scrollToEnd("auto"));
		return () => {
			if (frameRef.current) {
				cancelAnimationFrame(frameRef.current);
			}
		};
	}, [followOutput, scrollToEnd, setFollowing]);

	useEffect(() => {
		if (!showUnreadMessages) {
			return;
		}
		const content = contentRef.current;
		if (!content) {
			return;
		}

		syncUnreadMessages();
		const observer =
			globalThis.MutationObserver === undefined
				? null
				: new MutationObserver(syncUnreadMessages);
		// Rows are direct children of the content; streamed text inside a row
		// is not a new message, so only direct child changes are observed.
		observer?.observe(content, { childList: true });
		return () => observer?.disconnect();
	}, [showUnreadMessages, syncUnreadMessages]);

	useEffect(() => {
		if (!showUnreadMessages) {
			return;
		}
		const content = contentRef.current;
		if (!content) {
			return;
		}

		for (const node of Array.from(content.children)) {
			if (!(node instanceof HTMLElement)) {
				continue;
			}
			delete node.dataset.unreadStart;
			delete node.dataset.unreadLabel;
		}

		if (!unreadStartId || newMessageCount === 0) {
			return;
		}

		const unreadStart = Array.from(content.children).find(
			(node): node is HTMLElement =>
				node instanceof HTMLElement && node.dataset.messageId === unreadStartId
		);
		if (unreadStart) {
			unreadStart.dataset.unreadStart = "true";
			unreadStart.dataset.unreadLabel = `${newMessageCount} new messages`;
		}
	}, [newMessageCount, showUnreadMessages, unreadStartId]);

	useEffect(() => {
		const content = contentRef.current;
		if (!content || globalThis.ResizeObserver === undefined) {
			return;
		}

		// While following output, pin to the end once per frame with a plain
		// `scrollTop` write. Smooth scrolling is for user jumps only: a smooth
		// animation chasing a stream that grows every frame never lands and
		// reads as a wobble.
		let pinFrame = 0;
		const observer = new ResizeObserver(() => {
			scheduleRailSync();
			if (!(followOutput && followingRef.current) || pinFrame) {
				return;
			}
			pinFrame = requestAnimationFrame(() => {
				pinFrame = 0;
				const viewport = viewportRef.current;
				if (viewport && followingRef.current) {
					viewport.scrollTop = viewport.scrollHeight;
				}
			});
		});
		observer.observe(content);

		return () => {
			observer.disconnect();
			if (pinFrame) {
				cancelAnimationFrame(pinFrame);
			}
		};
	}, [followOutput, scheduleRailSync]);

	useEffect(() => {
		if (navigation !== "rail") {
			railTargetsRef.current.clear();
			setRailItems([]);
			setRailOverflowing(false);
			return;
		}

		const content = contentRef.current;
		const viewport = viewportRef.current;
		if (!(content && viewport)) {
			return;
		}

		scheduleRailSync();
		const mutationObserver =
			globalThis.MutationObserver === undefined
				? null
				: new MutationObserver(scheduleRailSync);
		// New turns are direct children; a streaming turn's growth is caught by
		// the ResizeObserver below, so text edits deep in a row are not watched.
		mutationObserver?.observe(content, { childList: true });

		const resizeObserver =
			globalThis.ResizeObserver === undefined
				? null
				: new ResizeObserver(scheduleRailSync);
		resizeObserver?.observe(content);
		resizeObserver?.observe(viewport);

		return () => {
			mutationObserver?.disconnect();
			resizeObserver?.disconnect();
		};
	}, [navigation, scheduleRailSync]);

	useEffect(
		() => () => {
			if (scrollTimerRef.current) {
				window.clearTimeout(scrollTimerRef.current);
			}
			if (frameRef.current) {
				cancelAnimationFrame(frameRef.current);
			}
			if (railFrameRef.current) {
				cancelAnimationFrame(railFrameRef.current);
			}
			if (activeRailFrameRef.current) {
				cancelAnimationFrame(activeRailFrameRef.current);
			}
		},
		[]
	);
	return { scrollToEnd, handleScroll, leaveLiveEdge } as const;
}
