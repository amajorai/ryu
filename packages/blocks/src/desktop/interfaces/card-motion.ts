import {
	type AnimationPlaybackControls,
	arc,
	type Transition,
	useAnimate,
} from "motion/react";
import { type RefObject, useLayoutEffect, useRef } from "react";

// The one feel every card table shares. A card crossing the table (dealt,
// played, piled, taken back) arcs high, flips in flight and lands with a small
// settle; a card changing slots inside a hand only hops over its neighbours;
// anything else (a hover lift, a re-layout) is a plain hop with no arc. The arc
// length is the whole effect, so these are tuned here and not borrowed from a
// generic easing token.

/** How long a flight takes to read as landed, in seconds. */
export const CARD_FLIGHT_SECONDS = 0.55;
/** A card crossing the table. Also times the flip that happens in flight. */
export const CARD_FLIGHT: Transition = {
	bounce: 0.18,
	type: "spring",
	visualDuration: CARD_FLIGHT_SECONDS,
};
/** A card moving inside its own zone: a new slot, a hover lift, a re-fan. */
export const CARD_HOP: Transition = {
	bounce: 0.2,
	type: "spring",
	visualDuration: 0.4,
};
export const CARD_INSTANT: Transition = { duration: 0 };

// arc() bends relative to the distance travelled. A negative strength puts
// horizontal moves above the line in both directions (automatic direction
// would bend them below).
const FLIGHT_STRENGTH = -0.35;
const HOP_STRENGTH = -0.3;
// Cards in a multi-card move leave one after another, not as a single slab. A
// big move shares a fixed window, so dealing a whole hand still flows.
const STAGGER_SECONDS = 0.045;
const MAX_STAGGER_WINDOW_SECONDS = 0.6;

/** Seconds between consecutive cards when `movers` cards leave at once. */
export function cardStagger(movers: number): number {
	return movers > 1
		? Math.min(STAGGER_SECONDS, MAX_STAGGER_WINDOW_SECONDS / (movers - 1))
		: 0;
}

/**
 * A flight across the table. Each call makes a fresh arc: an arc keeps memory
 * of its last bulge side, and every flight here picks its own.
 */
export function cardFlight(delay = 0): Transition {
	return {
		...CARD_FLIGHT,
		delay,
		path: arc({ strength: FLIGHT_STRENGTH }),
	};
}

/** A hop into a new slot of the same zone. */
export function cardHop(): Transition {
	return { ...CARD_HOP, path: arc({ strength: HOP_STRENGTH }) };
}

/** A card's motion for one render: its transition and when it starts. */
export interface CardMotion {
	delay: number;
	transition: Transition;
}

/**
 * Remembers when each card's flight leaves (`performance.now()` ms). A table
 * often lays out again right after a deal (its stage settles); a card still in
 * flight then keeps flying to its new place, with what is left of its delay,
 * instead of cutting its flight short with a hop.
 */
export function useCardFlights(): {
	/** A flight for `id` leaving after `delay` seconds. */
	fly: (id: string, delay: number) => CardMotion;
	/** The rest of `id`'s flight while it is still in the air; else null. */
	flying: (id: string) => CardMotion | null;
} {
	const departures = useRef(new Map<string, number>());
	const clock = performance.now();
	return {
		fly: (id, delay) => {
			departures.current.set(id, clock + delay * 1000);
			return { delay, transition: cardFlight(delay) };
		},
		flying: (id) => {
			const departs = departures.current.get(id);
			if (departs === undefined) {
				return null;
			}
			if (clock < departs + CARD_FLIGHT_SECONDS * 1000) {
				const wait = Math.max(0, (departs - clock) / 1000);
				return { delay: wait, transition: cardFlight(wait) };
			}
			departures.current.delete(id);
			return null;
		},
	};
}

/**
 * Where a card frame sits. `scale`, `opacity` and the frame's size are left
 * alone when unset.
 */
export interface CardMoveTarget {
	height?: number;
	opacity?: number;
	rotate: number;
	scale?: number;
	width?: number;
	x: number;
	y: number;
}

/**
 * Moves one card frame to `target` with `transition` whenever the target
 * changes, including on mount (from the frame's `initial` values). Imperative
 * so each move stops the last one first: an arc drives x and y through its own
 * progress animation, which a declarative retarget does not stop, so a long
 * flight finishing after a quick hover hop would write its stale end point
 * back. Put the returned ref on a `motion` element (or any element) that owns
 * the frame's transform.
 */
export function useCardMove<T extends Element>(
	target: CardMoveTarget,
	transition: Transition
): RefObject<T | null> {
	const [frame, animateFrame] = useAnimate<T>();
	const running = useRef<AnimationPlaybackControls | null>(null);
	const { height, opacity, rotate, scale, width, x, y } = target;

	// biome-ignore lint/correctness/useExhaustiveDependencies: a move starts when the target changes; the transition belongs to that same render and must not start a move on its own.
	useLayoutEffect(() => {
		if (!frame.current) {
			return;
		}
		running.current?.stop();
		running.current = animateFrame(
			frame.current,
			{
				rotate,
				x,
				y,
				...(scale === undefined ? {} : { scale }),
				...(opacity === undefined ? {} : { opacity }),
				...(width === undefined ? {} : { width }),
				...(height === undefined ? {} : { height }),
			},
			transition
		);
	}, [height, opacity, rotate, scale, width, x, y]);

	useLayoutEffect(() => () => running.current?.stop(), []);

	return frame;
}
