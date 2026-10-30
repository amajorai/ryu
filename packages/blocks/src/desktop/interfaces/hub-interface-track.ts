import {
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import { isHubTypingTarget, stepHubCard } from "./hub-model.ts";

/** Mouse travel before a press on the cards becomes a drag. */
const DRAG_PX = 6;
/**
 * Longest a programmatic scroll owns the active card. It normally releases as
 * soon as the row arrives; this only covers a scroll the user interrupts.
 */
const SCROLL_SETTLE_MS = 2000;
/** When a smooth scroll that has not arrived is finished without animation. */
const SCROLL_ASSERT_MS = 900;

/** Mark which ends of the row have cards cut off, for the edge fades. */
function markTrackEdges(track: HTMLElement) {
	const start = track.scrollLeft > 1;
	const end = track.scrollLeft + track.clientWidth < track.scrollWidth - 1;
	track.dataset.edgeStart = String(start);
	track.dataset.edgeEnd = String(end);
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
		const gutter = Number.parseFloat(getComputedStyle(track).paddingLeft) || 0;
		const maxLeft = Math.max(0, track.scrollWidth - track.clientWidth);
		const left = Math.min(maxLeft, Math.max(0, card.offsetLeft - gutter));
		const target = { left, until: Date.now() + SCROLL_SETTLE_MS };
		scrollTargetRef.current = target;
		track.scrollTo?.({ behavior: reduceMotion ? "auto" : "smooth", left });
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
		if (!target || Math.abs(track.scrollLeft - target.left) <= 2) {
			return;
		}
		track.scrollTo?.({ behavior: "auto", left: target.left });
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
		if (target) {
			const landed = Math.abs(track.scrollLeft - target.left) <= 2;
			if (landed || Date.now() > target.until) {
				scrollTargetRef.current = null;
			}
			return;
		}
		const current = activeRef.current;
		const gutter = Number.parseFloat(getComputedStyle(track).paddingLeft) || 0;
		const atEnd = track.scrollLeft >= track.scrollWidth - track.clientWidth - 4;
		const viewRight = track.scrollLeft + track.clientWidth;
		const fullyVisible = (card: HTMLElement | null | undefined) =>
			card !== null &&
			card !== undefined &&
			card.offsetLeft >= track.scrollLeft &&
			card.offsetLeft + card.offsetWidth <= viewRight + 1;
		if (atEnd && fullyVisible(cardRefs.current[current])) {
			return;
		}
		let nearest = 0;
		let distance = Number.POSITIVE_INFINITY;
		for (const [index, card] of cardRefs.current.entries()) {
			if (!card) {
				continue;
			}
			const gap = Math.abs(card.offsetLeft - gutter - track.scrollLeft);
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
		const moved = track.scrollLeft - drag.scrollLeft;
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
