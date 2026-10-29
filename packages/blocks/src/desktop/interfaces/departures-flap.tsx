import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { useReducedMotion } from "./reduced-motion.ts";

/** One leaf falling: the upper half drops, then the lower half lands. */
const LEAF_SECONDS = 0.11;
/** Each character flips a beat after the one before it, left to right. */
export const CHAR_STAGGER_SECONDS = 0.014;
const LEAF_EASE_IN = [0.55, 0, 1, 0.45] as const;
const LEAF_EASE_OUT = [0, 0.55, 0.45, 1] as const;
/** One character flap on a board row: tall enough that the hinge clears the caps. */
export const FLAP_TILE = "h-7 w-[18px]";

interface FlapState {
	current: string;
	previous: string;
	/** Bumps on every change, so the falling leaves remount and run again. */
	turn: number;
}

/**
 * Track the value a flap shows and the one it is flipping away from. On the
 * first render `initial` stands in as the previous value, so a board that
 * mounts flips in from blank flaps.
 */
function useFlapState(value: string, initial: string): FlapState {
	const [state, setState] = useState<FlapState>(() => ({
		current: value,
		previous: initial,
		turn: initial === value ? 0 : 1,
	}));
	if (state.current !== value) {
		const next = {
			current: value,
			previous: state.current,
			turn: state.turn + 1,
		};
		setState(next);
		return next;
	}
	return state;
}

const HALF = "absolute inset-x-0 h-1/2 overflow-hidden";
const TOP = cn(HALF, "top-0 rounded-t-[inherit] bg-(--dep-tile-top)");
const BOTTOM = cn(HALF, "bottom-0 rounded-b-[inherit] bg-(--dep-tile-bottom)");

/** The face of a leaf: the whole value, sized to the full flap. */
function Face({
	align,
	children,
	half,
}: {
	align: "center" | "start";
	children: ReactNode;
	half: "bottom" | "top";
}) {
	return (
		<span
			className={cn(
				"absolute inset-x-0 flex h-[200%] items-center whitespace-pre",
				align === "center" ? "justify-center" : "justify-start px-[0.45em]",
				// The lower leaf sits under the seam, so its face shifts up by
				// half a flap to line the two halves into one character.
				half === "bottom" ? "-top-full" : "top-0"
			)}
		>
			<span className={align === "start" ? "truncate" : undefined}>
				{children}
			</span>
		</span>
	);
}

/**
 * A single split-flap leaf: a character (or a printed word, the way Solari
 * boards print city names on one wide flap). When the value changes the upper
 * leaf falls away and the lower one lands to show the new value. With reduced
 * motion the value simply changes.
 */
export function Flap({
	align = "center",
	className,
	delay = 0,
	flipIn = true,
	value,
}: {
	align?: "center" | "start";
	className?: string;
	/** Seconds before this flap starts flipping. */
	delay?: number;
	/** Flip in from a blank flap on mount. */
	flipIn?: boolean;
	value: string;
}) {
	const reduceMotion = useReducedMotion();
	const state = useFlapState(value, flipIn && !reduceMotion ? "" : value);
	const flipping = !reduceMotion && state.turn > 0;
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative inline-block shrink-0 select-none rounded-[0.18em] [perspective:12em]",
				className
			)}
		>
			{/* Behind the leaves: the new value on top, the old one below. */}
			<span className={TOP}>
				<Face align={align} half="top">
					{state.current}
				</Face>
			</span>
			<span className={BOTTOM}>
				<Face align={align} half="bottom">
					{flipping ? state.previous : state.current}
				</Face>
			</span>
			{flipping ? (
				<span className="contents" key={state.turn}>
					<motion.span
						animate={{ rotateX: -90 }}
						className={cn(TOP, "backface-hidden origin-bottom")}
						initial={{ rotateX: 0 }}
						transition={{
							delay,
							duration: LEAF_SECONDS,
							ease: LEAF_EASE_IN,
						}}
					>
						<Face align={align} half="top">
							{state.previous}
						</Face>
					</motion.span>
					<motion.span
						animate={{ rotateX: 0 }}
						className={cn(BOTTOM, "backface-hidden origin-top")}
						initial={{ rotateX: 90 }}
						transition={{
							delay: delay + LEAF_SECONDS,
							duration: LEAF_SECONDS,
							ease: LEAF_EASE_OUT,
						}}
					>
						<Face align={align} half="bottom">
							{state.current}
						</Face>
					</motion.span>
				</span>
			) : null}
			<Hinge />
		</span>
	);
}

/** The hinge between the leaves: a hairline just darker than the flap. */
function Hinge() {
	return (
		<span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-(--dep-tile-seam)" />
	);
}

/**
 * An unused flap: the same hardware with nothing printed on it, the way a
 * real board shows its empty lines. Static, so a board of them costs nothing.
 */
export function BlankFlap({ className }: { className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative inline-block shrink-0 rounded-[0.18em]",
				className
			)}
		>
			<span className={TOP} />
			<span className={BOTTOM} />
			<Hinge />
		</span>
	);
}

/** A fixed run of unused character flaps. */
export function BlankFlapText({
	className,
	length,
	tileClassName,
}: {
	className?: string;
	length: number;
	tileClassName?: string;
}) {
	const slots = Array.from({ length }, (_, position) => `blank-${position}`);
	return (
		<span
			aria-hidden="true"
			className={cn("inline-flex shrink-0 gap-px", className)}
		>
			{slots.map((slot) => (
				<BlankFlap className={tileClassName ?? FLAP_TILE} key={slot} />
			))}
		</span>
	);
}

/**
 * A fixed run of character flaps, like the time or flight number on a board.
 * The value is padded (or cut) to `length` so the run never changes width.
 */
export function FlapText({
	className,
	delay = 0,
	flipIn,
	length,
	tileClassName,
	value,
}: {
	className?: string;
	delay?: number;
	flipIn?: boolean;
	length: number;
	tileClassName?: string;
	value: string;
}) {
	const characters = [
		...value.toUpperCase().padEnd(length, " ").slice(0, length),
	];
	const positions = characters.map((character, position) => ({
		character,
		id: `flap-${position}`,
		position,
	}));
	return (
		<span
			aria-hidden="true"
			className={cn("inline-flex shrink-0 gap-px", className)}
		>
			{positions.map((slot) => (
				<Flap
					className={tileClassName ?? FLAP_TILE}
					delay={delay + slot.position * CHAR_STAGGER_SECONDS}
					flipIn={flipIn}
					key={slot.id}
					value={slot.character}
				/>
			))}
		</span>
	);
}
