import type { UIMessage } from "ai";
import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

function getUserMessageText(message: UIMessage): string {
	return (message.parts ?? [])
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: string }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string"
		)
		.map((part) => part.text)
		.join("");
}

/**
 * How far BELOW the election line an anchor must fall before the pin is
 * released, over and above the line itself.
 *
 * The pin bar is `sticky` but sits IN FLOW at the top of the scroller viewport,
 * so mounting it pushes every anchor below it down by the bar's own height. With
 * a single threshold, an anchor sitting within one bar-height of the line gets
 * un-elected the instant the bar it just elected appears — which unmounts the
 * bar, which lifts the anchor back over the line, which re-elects it. That
 * ping-pong is synchronous inside the measuring effect, so React's nested-update
 * counter runs away and the app dies with "Maximum update depth exceeded"
 * (minified React error #185).
 *
 * Releasing therefore uses a strictly looser line than electing. The live bar is
 * measured when it exists (see `PINNED_BAR_SLOT`); this constant is the floor
 * used before the bar has laid out, sized to comfortably clear a collapsed bar.
 */
const PIN_RELEASE_SLACK = 96;

/** `data-slot` stamped on the sticky pin bar wrapper by the message list. */
const PINNED_BAR_SLOT = '[data-slot="pinned-user-message-bar"]';

/**
 * Tracks which user message should appear in the sticky pin bar while scrolling
 * upward through a long assistant reply (Cursor-style). Returns the message to
 * pin when its bubble has scrolled above the viewport top; the caller hides the
 * bar while the reader scrolls down, matching the direction-aware chrome in
 * common messaging apps.
 */
export function usePinnedUserMessage({
	enabled,
	messages,
	scrollerRef,
	pinThreshold = 12,
	pinReleaseSlack = PIN_RELEASE_SLACK,
}: {
	enabled: boolean;
	messages: UIMessage[];
	scrollerRef: RefObject<HTMLElement | null>;
	pinThreshold?: number;
	pinReleaseSlack?: number;
}) {
	const [pinnedId, setPinnedId] = useState<string | null>(null);
	const [isScrollingUp, setIsScrollingUp] = useState(false);
	// Mirrors `pinnedId` so the measuring pass can read the current election
	// without listing it as an effect dependency (which would re-register the
	// scroll listener on every pin change).
	const pinnedIdRef = useRef<string | null>(null);
	const isScrollingUpRef = useRef(false);
	const scrollIntentRef = useRef<"down" | "up" | null>(null);
	const touchYRef = useRef<number | null>(null);
	const anchorRefs = useRef(new Map<string, HTMLElement>());

	const registerAnchor = useCallback(
		(messageId: string, el: HTMLElement | null) => {
			if (el) {
				anchorRefs.current.set(messageId, el);
			} else {
				anchorRefs.current.delete(messageId);
			}
		},
		[]
	);

	const userMessages = useMemo(
		() => messages.filter((m) => m.role === "user"),
		[messages]
	);

	const pinnedMessage = useMemo(
		() => userMessages.find((m) => m.id === pinnedId) ?? null,
		[userMessages, pinnedId]
	);

	const getViewport = useCallback(() => {
		return (
			scrollerRef.current?.querySelector<HTMLElement>(
				'[data-slot="message-scroller-viewport"]'
			) ?? null
		);
	}, [scrollerRef]);
	const setScrollDirection = useCallback((direction: "down" | "up") => {
		const nextIsScrollingUp = direction === "up";
		if (isScrollingUpRef.current === nextIsScrollingUp) {
			return;
		}
		isScrollingUpRef.current = nextIsScrollingUp;
		setIsScrollingUp(nextIsScrollingUp);
	}, []);

	useEffect(() => {
		if (!enabled) {
			pinnedIdRef.current = null;
			isScrollingUpRef.current = false;
			scrollIntentRef.current = null;
			touchYRef.current = null;
			setPinnedId(null);
			setIsScrollingUp(false);
			return;
		}

		const viewport = getViewport();
		if (!viewport) {
			return;
		}
		isScrollingUpRef.current = false;
		scrollIntentRef.current = null;
		setIsScrollingUp(false);

		const setIntentFromDelta = (delta: number) => {
			if (delta !== 0) {
				const direction = delta < 0 ? "up" : "down";
				scrollIntentRef.current = direction;
				setScrollDirection(direction);
			}
		};

		const update = () => {
			const intent = scrollIntentRef.current;
			if (intent) {
				setScrollDirection(intent);
				scrollIntentRef.current = null;
			}
			const electTop = viewport.getBoundingClientRect().top + pinThreshold;
			// Hysteresis: the already-elected anchor keeps its pin until it clears
			// the line by more than the bar's own height, so the bar can never
			// un-elect the anchor that mounted it. See PIN_RELEASE_SLACK.
			const barHeight =
				viewport.querySelector<HTMLElement>(PINNED_BAR_SLOT)?.offsetHeight ?? 0;
			const releaseTop = electTop + Math.max(pinReleaseSlack, barHeight);
			const previous = pinnedIdRef.current;
			let candidate: string | null = null;

			for (const msg of userMessages) {
				const el = anchorRefs.current.get(msg.id);
				if (!el) {
					continue;
				}
				const text = getUserMessageText(msg);
				const hasParts = (msg.parts ?? []).length > 0;
				if (!(text || hasParts)) {
					continue;
				}
				const line = msg.id === previous ? releaseTop : electTop;
				if (el.getBoundingClientRect().bottom < line) {
					candidate = msg.id;
				}
			}

			if (candidate === previous) {
				return;
			}
			pinnedIdRef.current = candidate;
			setPinnedId(candidate);
		};

		// Deferred out of the effect body on purpose: a synchronous setState here
		// counts toward React's nested-update budget, and this effect re-runs
		// whenever the messages array changes identity. A RAF-scheduled write
		// cannot nest, so a borderline measurement can no longer escalate into
		// "Maximum update depth exceeded".
		const frame = requestAnimationFrame(update);
		viewport.addEventListener("scroll", update, { passive: true });
		const onWheel = (event: WheelEvent) => {
			setIntentFromDelta(event.deltaY);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
				setIntentFromDelta(-1);
				return;
			}
			if (["ArrowDown", "PageDown", "End"].includes(event.key)) {
				setIntentFromDelta(1);
			}
		};
		const onTouchStart = (event: TouchEvent) => {
			touchYRef.current = event.touches[0]?.clientY ?? null;
		};
		const onTouchMove = (event: TouchEvent) => {
			const currentY = event.touches[0]?.clientY;
			const previousY = touchYRef.current;
			if (currentY === undefined || previousY === null) {
				return;
			}
			setIntentFromDelta(previousY - currentY);
			touchYRef.current = currentY;
		};
		const onTouchEnd = () => {
			touchYRef.current = null;
		};
		viewport.addEventListener("wheel", onWheel, { passive: true });
		viewport.addEventListener("keydown", onKeyDown);
		viewport.addEventListener("touchstart", onTouchStart, { passive: true });
		viewport.addEventListener("touchmove", onTouchMove, { passive: true });
		viewport.addEventListener("touchend", onTouchEnd, { passive: true });
		const ro = new ResizeObserver(update);
		ro.observe(viewport);

		return () => {
			cancelAnimationFrame(frame);
			viewport.removeEventListener("scroll", update);
			viewport.removeEventListener("wheel", onWheel);
			viewport.removeEventListener("keydown", onKeyDown);
			viewport.removeEventListener("touchstart", onTouchStart);
			viewport.removeEventListener("touchmove", onTouchMove);
			viewport.removeEventListener("touchend", onTouchEnd);
			ro.disconnect();
		};
	}, [
		enabled,
		getViewport,
		pinReleaseSlack,
		pinThreshold,
		setScrollDirection,
		userMessages,
	]);

	const scrollToPinned = useCallback(() => {
		if (!pinnedId) {
			return;
		}
		const el = anchorRefs.current.get(pinnedId);
		el?.scrollIntoView({ behavior: "smooth", block: "start" });
	}, [pinnedId]);

	return {
		isScrollingUp,
		pinnedMessage,
		registerAnchor,
		scrollToPinned,
		setScrollDirection,
	};
}
