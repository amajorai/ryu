import {
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import { isHubTypingTarget, stepHubCard } from "./hub-model.ts";
import { logicalScroll, logicalSpan } from "./inline-direction.ts";

/** Mouse travel before a press on the cards becomes a drag. */
const DRAG_PX = 6;
/**
 * Longest a programmatic scroll owns the active card. It normally releases as
 * soon as the row arrives; this only covers a scroll the user interrupts.
 */
const SCROLL_SETTLE_MS = 2000;
/** When a smooth scroll that has not arrived is finished without animation. */
const SCROLL_ASSERT_MS = 900;

/**
 * Mark which physical sides of the row have cards cut off, for the edge fades
 * (the masks are physical; under `dir="rtl"` the inline start is the right).
 */
function markTrackEdges(track: HTMLElement) {
	const { max, position, sign } = logicalScroll(track);
	const start = position > 1;
	const end = position < max - 1;
	track.dataset.edgeLeft = String(sign === 1 ? start : end);
	track.dataset.edgeRight = String(sign === 1 ? end : start);
}

/** The track's inline-start padding: the gutter a resting card sits behind. */
function trackGutter(track: HTMLElement): number {
	const style = getComputedStyle(track);
	return (
		Number.parseFloat(style.paddingInlineStart) ||
		Number.parseFloat(style.paddingLeft) ||
		0
	);
}

/**
 * Where `card` starts along the track's inline axis, in px from the visible
 * inline start edge (negative once scrolled past).
 */
function cardInlineStart(track: HTMLElement, card: HTMLElement) {
	return logicalSpan(
		card.getBoundingClientRect(),
		track.getBoundingClientRect(),
		logicalScroll(track).sign
	);
}

interface HubTrackOptions {
	activeRef: RefObject<number>;
	activityRef: RefObject<number>;
	awake: boolean;
	loading: boolean;
	reduceMotion: boolean;
	setActive: (index: number) => void;
}

/** The card row: moving to a card, following the active card, and mouse drag. */
export function useHubTrack({
	activeRef,
	activityRef,
	awake,
	loading,
	reduceMotion,
	setActive,
}: HubTrackOptions) {
	const trackRef = useRef<HTMLDivElement>(null);
	const cardRefs = useRef<(HTMLElement | null)[]>([]);
	const scrollTargetRef = useRef<{ left: number; until: number } | null>(null);
	const dragRef = useRef<{
		dragging: boolean;
		scrollLeft: number;
		x: number;
	} | null>(null);
	const suppressClickRef = useRef(false);
	const pendingScrollRef = useRef<number | null>(null);
	const [scrollRequest, setScrollRequest] = useState(0);

	const scrollToCard = (index: number) => {
		const track = trackRef.current;
		const card = cardRefs.current[index];
		if (!(track && card)) {
			return;
		}
		const gutter = trackGutter(track);
		const scroll = logicalScroll(track);
		const offset =
			cardInlineStart(track, card).start + scroll.position - gutter;
		const left = Math.min(scroll.max, Math.max(0, offset));
		// `left` is logical: px from the inline start, whatever the direction.
		const target = { left, until: Date.now() + SCROLL_SETTLE_MS };
		scrollTargetRef.current = target;
		scroll.scrollToLogical(left, reduceMotion ? "auto" : "smooth");
		// A smooth scroll can be cut short (a retarget mid-flight, a busy main
		// thread); if this one has not landed by now, put the row there.
		window.setTimeout(() => {
			if (scrollTargetRef.current === target) {
				settleTrack(track);
			}
		}, SCROLL_ASSERT_MS);
	};

	const settleTrack = (track: HTMLElement) => {
		const target = scrollTargetRef.current;
		const scroll = logicalScroll(track);
		if (!target || Math.abs(scroll.position - target.left) <= 2) {
			return;
		}
		scroll.scrollToLogical(target.left, "auto");
	};

	const goTo = (index: number, focus = true) => {
		const next = stepHubCard(index, 0);
		activeRef.current = next;
		setActive(next);
		// Scroll once the row has rendered: a key pressed right after waking
		// arrives before the cards have mounted.
		pendingScrollRef.current = next;
		setScrollRequest((request) => request + 1);
		// Keyboard focus follows the card only once it is already among the
		// cards; arrows from the page move the row without a focus ring.
		const focused = document.activeElement;
		if (focus && focused && trackRef.current?.contains(focused)) {
			cardRefs.current[next]?.focus({ preventScroll: true });
		}
	};

	const scrollToCardRef = useRef(scrollToCard);
	scrollToCardRef.current = scrollToCard;
	useEffect(() => {
		const pending = pendingScrollRef.current;
		if (scrollRequest === 0 || pending === null || !awake || loading) {
			return;
		}
		if (!cardRefs.current[pending]) {
			return;
		}
		pendingScrollRef.current = null;
		scrollToCardRef.current(pending);
	}, [awake, loading, scrollRequest]);

	const onTrackScroll = () => {
		activityRef.current = Date.now();
		const track = trackRef.current;
		if (!track) {
			return;
		}
		markTrackEdges(track);
		if (dragRef.current?.dragging) {
			return;
		}
		// A row moving to a chosen card keeps that card active until it lands.
		const target = scrollTargetRef.current;
		const scroll = logicalScroll(track);
		if (target) {
			const landed = Math.abs(scroll.position - target.left) <= 2;
			if (landed || Date.now() > target.until) {
				scrollTargetRef.current = null;
			}
			return;
		}
		const current = activeRef.current;
		const gutter = trackGutter(track);
		const atEnd = scroll.position >= scroll.max - 4;
		const fullyVisible = (card: HTMLElement | null | undefined) => {
			if (!card) {
				return false;
			}
			const span = cardInlineStart(track, card);
			return span.start >= -1 && span.end <= track.clientWidth + 1;
		};
		if (atEnd && fullyVisible(cardRefs.current[current])) {
			return;
		}
		let nearest = 0;
		let distance = Number.POSITIVE_INFINITY;
		for (const [index, card] of cardRefs.current.entries()) {
			if (!card) {
				continue;
			}
			const gap = Math.abs(cardInlineStart(track, card).start - gutter);
			if (gap < distance) {
				distance = gap;
				nearest = index;
			}
		}
		activeRef.current = nearest;
		setActive(nearest);
	};

	// When a scroll ends short of the chosen card, finish the move.
	const settleTrackRef = useRef(settleTrack);
	settleTrackRef.current = settleTrack;
	useEffect(() => {
		const track = trackRef.current;
		if (!(awake && track)) {
			return;
		}
		const onScrollEnd = () => settleTrackRef.current(track);
		track.addEventListener("scrollend", onScrollEnd);
		return () => track.removeEventListener("scrollend", onScrollEnd);
	}, [awake]);

	// Fade whichever edge has a card cut off behind it.
	useEffect(() => {
		const track = trackRef.current;
		if (!(awake && track)) {
			return;
		}
		markTrackEdges(track);
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(() => markTrackEdges(track));
		observer.observe(track);
		return () => observer.disconnect();
	}, [awake]);

	// Mouse drag scrolls the row; touch and trackpads scroll it natively.
	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		activityRef.current = Date.now();
		scrollTargetRef.current = null;
		const track = trackRef.current;
		if (event.pointerType !== "mouse" || event.button !== 0 || !track) {
			dragRef.current = null;
			return;
		}
		if (isHubTypingTarget(event.target)) {
			dragRef.current = null;
			return;
		}
		dragRef.current = {
			dragging: false,
			scrollLeft: track.scrollLeft,
			x: event.clientX,
		};
	};
	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		const track = trackRef.current;
		if (!(drag && track)) {
			return;
		}
		const dx = event.clientX - drag.x;
		if (!drag.dragging && Math.abs(dx) < DRAG_PX) {
			return;
		}
		if (!drag.dragging) {
			drag.dragging = true;
			track.style.scrollSnapType = "none";
			track.setPointerCapture?.(event.pointerId);
		}
		track.scrollLeft = drag.scrollLeft - dx;
	};
	const endDrag = () => {
		const drag = dragRef.current;
		dragRef.current = null;
		const track = trackRef.current;
		if (!(drag?.dragging && track)) {
			return;
		}
		suppressClickRef.current = true;
		track.style.scrollSnapType = "";
		// Physical travel, turned into steps toward the inline end.
		const moved =
			(track.scrollLeft - drag.scrollLeft) * logicalScroll(track).sign;
		const from = activeRef.current;
		const width = cardRefs.current[from]?.offsetWidth ?? 1;
		const steps = Math.round(moved / width) || Math.sign(moved);
		goTo(stepHubCard(from, steps), false);
	};

	const setCardRef = (index: number) => (element: HTMLElement | null) => {
		cardRefs.current[index] = element;
	};

	return {
		endDrag,
		goTo,
		onPointerDown,
		onPointerMove,
		onTrackScroll,
		scrollTargetRef,
		setCardRef,
		suppressClickRef,
		trackRef,
	};
}
