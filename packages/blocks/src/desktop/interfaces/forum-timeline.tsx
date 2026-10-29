import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronsDown, ChevronsUp } from "lucide-react";
import {
	type KeyboardEvent,
	type PointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { postFraction, progressPost } from "./forum-model.ts";
import { ICON_BUTTON } from "./forum-parts.tsx";

function isVerticalScroller(element: Element): element is HTMLElement {
	if (!(element instanceof HTMLElement)) {
		return false;
	}
	const overflow = getComputedStyle(element).overflowY;
	return (
		(overflow === "auto" || overflow === "scroll") &&
		element.scrollHeight > element.clientHeight + 1
	);
}

/** The first element inside the host's chat surface that scrolls vertically. */
function findScroller(root: HTMLElement): HTMLElement | null {
	for (const element of root.querySelectorAll("*")) {
		if (isVerticalScroller(element)) {
			return element;
		}
	}
	return null;
}

export interface ThreadScroll {
	/** 0 at the top of the replies, 1 at the bottom. */
	fraction: number;
	scrollable: boolean;
	scrollTo: (fraction: number, smooth: boolean) => void;
}

/**
 * Follows the scroll position of whatever scrolls inside the host's chat
 * surface (found by looking, never by reaching into its internals), so the
 * timeline can show and move it. Streaming replies re-measure it.
 */
export function useThreadScroll(
	rootRef: RefObject<HTMLElement | null>,
	key: string | null
): ThreadScroll {
	const scrollerRef = useRef<HTMLElement | null>(null);
	const [fraction, setFraction] = useState(1);
	const [scrollable, setScrollable] = useState(false);

	useEffect(() => {
		const root = rootRef.current;
		if (!root || key === undefined) {
			return;
		}
		let frame = 0;
		const measure = () => {
			frame = 0;
			const known = scrollerRef.current;
			const scroller =
				known && root.contains(known) && isVerticalScroller(known)
					? known
					: findScroller(root);
			scrollerRef.current = scroller;
			if (!scroller) {
				setScrollable(false);
				setFraction(1);
				return;
			}
			const max = scroller.scrollHeight - scroller.clientHeight;
			setScrollable(max > 1);
			setFraction(max > 1 ? scroller.scrollTop / max : 1);
		};
		const schedule = () => {
			if (frame === 0) {
				frame = window.requestAnimationFrame(measure);
			}
		};
		const onScroll = (event: Event) => {
			if (event.target instanceof Element && isVerticalScroller(event.target)) {
				scrollerRef.current = event.target;
			}
			schedule();
		};
		root.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", schedule);
		const mutations =
			typeof MutationObserver === "undefined"
				? null
				: new MutationObserver(schedule);
		mutations?.observe(root, {
			characterData: true,
			childList: true,
			subtree: true,
		});
		schedule();
		return () => {
			root.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", schedule);
			mutations?.disconnect();
			if (frame !== 0) {
				window.cancelAnimationFrame(frame);
			}
		};
	}, [rootRef, key]);

	const scrollTo = useCallback(
		(next: number, smooth: boolean) => {
			const root = rootRef.current;
			const scroller =
				scrollerRef.current ?? (root ? findScroller(root) : null);
			if (!scroller) {
				return;
			}
			const max = scroller.scrollHeight - scroller.clientHeight;
			scroller.scrollTo({
				behavior: smooth ? "smooth" : "auto",
				top: Math.max(0, Math.min(1, next)) * max,
			});
		},
		[rootRef]
	);

	return { fraction, scrollTo, scrollable };
}

const TRACK_HEIGHT = 200;
const HANDLE_HEIGHT = 40;

export interface TopicTimelineProps {
	/** Label for the bottom jump: the age of the latest activity. */
	lastLabel: string;
	reduceMotion: boolean;
	scroll: ThreadScroll;
	/** Posts in the topic (at least 1). */
	total: number;
}

function stepFor(key: string, total: number): number | "end" | "start" | null {
	const page = Math.max(1, Math.round(total / 5));
	switch (key) {
		case "ArrowDown":
		case "ArrowRight":
			return 1;
		case "ArrowUp":
		case "ArrowLeft":
			return -1;
		case "PageDown":
			return page;
		case "PageUp":
			return -page;
		case "Home":
			return "start";
		case "End":
			return "end";
		default:
			return null;
	}
}

/**
 * Discourse's topic timeline: jump to the top, a scrubber whose handle shows
 * where you are ("3 / 9"), and a jump to the latest reply. The scrubber is a
 * slider: drag or click the track, or use the arrow, Page, Home and End keys.
 */
export function TopicTimeline({
	lastLabel,
	reduceMotion,
	scroll,
	total,
}: TopicTimelineProps) {
	const tl = useLiteralMessages();
	const trackRef = useRef<HTMLDivElement>(null);
	const dragging = useRef(false);
	const post = progressPost(scroll.fraction, total);
	const offset = Math.round(
		Math.min(1, Math.max(0, scroll.fraction)) * (TRACK_HEIGHT - HANDLE_HEIGHT)
	);

	const seek = (clientY: number) => {
		const track = trackRef.current;
		if (!track) {
			return;
		}
		const rect = track.getBoundingClientRect();
		const usable = rect.height - HANDLE_HEIGHT;
		const next = (clientY - rect.top - HANDLE_HEIGHT / 2) / usable;
		scroll.scrollTo(next, false);
	};

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (!scroll.scrollable) {
			return;
		}
		dragging.current = true;
		event.currentTarget.setPointerCapture(event.pointerId);
		event.currentTarget.focus();
		seek(event.clientY);
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		if (dragging.current) {
			seek(event.clientY);
		}
	};
	const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		dragging.current = false;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = stepFor(event.key, total);
		if (step === null) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (step === "start" || step === "end") {
			scroll.scrollTo(step === "start" ? 0 : 1, !reduceMotion);
			return;
		}
		scroll.scrollTo(postFraction(post + step, total), !reduceMotion);
	};

	const jumpClass =
		"inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 -mx-1.5 text-muted-foreground text-sm outline-none transition-colors duration-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50";

	return (
		<nav
			aria-label="Topic progress"
			className="flex select-none flex-col gap-2"
			data-testid="forum-timeline"
		>
			<button
				className={jumpClass}
				disabled={!scroll.scrollable}
				onClick={() => scroll.scrollTo(0, !reduceMotion)}
				type="button"
			>
				<ChevronsUp aria-hidden="true" className="size-4" strokeWidth={2} />
				First post
			</button>
			<div
				aria-label="Position in topic"
				aria-valuemax={total}
				aria-valuemin={1}
				aria-valuenow={post}
				aria-valuetext={tl("Post {post} of {total}", { post, total })}
				className="group/track relative ml-[7px] cursor-pointer touch-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-4 focus-visible:ring-offset-background"
				onKeyDown={onKeyDown}
				onPointerCancel={onPointerUp}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				ref={trackRef}
				role="slider"
				style={{ height: TRACK_HEIGHT }}
				tabIndex={0}
			>
				<span
					aria-hidden="true"
					className="absolute inset-y-0 left-0 w-px bg-border"
				/>
				<span
					aria-hidden="true"
					className={cn(
						"absolute left-[-1px] w-[3px] rounded-full bg-primary",
						!reduceMotion && "transition-[top] duration-150 ease-out"
					)}
					style={{ height: HANDLE_HEIGHT, top: offset }}
				/>
				<span
					aria-hidden="true"
					className={cn(
						"absolute left-3 flex h-10 flex-col justify-center",
						!reduceMotion && "transition-[top] duration-150 ease-out"
					)}
					style={{ top: offset }}
				>
					<span className="font-semibold text-foreground text-sm tabular-nums leading-5">
						{post} / {total}
					</span>
				</span>
			</div>
			<button
				className={jumpClass}
				disabled={!scroll.scrollable}
				onClick={() => scroll.scrollTo(1, !reduceMotion)}
				type="button"
			>
				<ChevronsDown aria-hidden="true" className="size-4" strokeWidth={2} />
				{lastLabel}
			</button>
		</nav>
	);
}

/** The narrow-width timeline: jump buttons around the position. */
export function CompactTimeline({
	reduceMotion,
	scroll,
	total,
}: Omit<TopicTimelineProps, "lastLabel">) {
	const post = progressPost(scroll.fraction, total);
	return (
		<nav
			aria-label="Topic progress"
			className="flex shrink-0 items-center gap-1"
		>
			<button
				aria-label="Jump to first post"
				className={ICON_BUTTON}
				disabled={!scroll.scrollable}
				onClick={() => scroll.scrollTo(0, !reduceMotion)}
				type="button"
			>
				<ChevronsUp aria-hidden="true" className="size-4" strokeWidth={2} />
			</button>
			<span className="min-w-12 text-center font-medium text-foreground text-sm tabular-nums">
				{post} / {total}
			</span>
			<button
				aria-label="Jump to latest reply"
				className={ICON_BUTTON}
				disabled={!scroll.scrollable}
				onClick={() => scroll.scrollTo(1, !reduceMotion)}
				type="button"
			>
				<ChevronsDown aria-hidden="true" className="size-4" strokeWidth={2} />
			</button>
		</nav>
	);
}
