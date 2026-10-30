import { cn } from "@ryu/ui/lib/utils";
import { Check, Ellipsis, Hourglass, Reply, Star } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import type { PathStop, PathTone } from "./path-model.ts";
import { PATH_NEUTRAL_FILL, PATH_TONES } from "./path-tone.ts";

/**
 * A chunky, pressable coin: a solid face over a darker lip of the same color
 * (the face color through a brightness filter, so it works for any token).
 * Pressing drops the face onto the lip.
 */
export function Coin({
	children,
	face,
	halo = true,
	onFace,
	selected = false,
}: {
	children: ReactNode;
	face: string;
	/** Draw the selection ring here (stops with their own ring draw it there). */
	halo?: boolean;
	onFace: string;
	/**
	 * The open thread's stop: the coin stays pressed onto its lip, inside a
	 * primary ring, so "open" never reads like the raised current stop.
	 */
	selected?: boolean;
}) {
	return (
		<>
			{selected && halo ? (
				<span
					aria-hidden="true"
					className="absolute -top-1.5 -left-2.5 size-[84px] rounded-full ring-[3px] ring-primary"
				/>
			) : null}
			<span
				aria-hidden="true"
				className={cn(
					"absolute inset-x-0 top-2 h-16 rounded-full brightness-[0.78]",
					face
				)}
			/>
			<span
				aria-hidden="true"
				className={cn(
					"absolute inset-x-0 top-0 flex h-16 items-center justify-center rounded-full transition-[translate,filter] duration-100 ease-out group-active/stop:translate-y-2 group-active/stop:brightness-100",
					selected ? "translate-y-2" : "group-hover/stop:brightness-[1.06]",
					FACE_FOCUS,
					face,
					onFace
				)}
			>
				{children}
			</span>
		</>
	);
}

/** Keyboard focus rings the face only, like the open stop's halo. */
const FACE_FOCUS =
	"group-focus-visible/stop:ring-[3px] group-focus-visible/stop:ring-ring group-focus-visible/stop:ring-offset-4 group-focus-visible/stop:ring-offset-(--gk-plate)";

/**
 * A ring around the coin: a quiet track for the current stop, a moving arc
 * for a live run. The arc only turns when motion is allowed.
 */
export function StopRing({
	reduceMotion,
	selected,
	tone,
	working,
}: {
	reduceMotion: boolean;
	/** The open thread's stop: the ring follows the pressed coin, in primary. */
	selected: boolean;
	tone: PathTone;
	working: boolean;
}) {
	return (
		<svg
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute -left-4 size-24",
				selected ? "-top-2" : "-top-4"
			)}
			viewBox="0 0 96 96"
		>
			<circle
				className={cn(
					"fill-none",
					selected ? "stroke-primary" : "stroke-muted-foreground/20"
				)}
				cx="48"
				cy="48"
				r="44"
				strokeWidth="7"
			/>
			{working ? (
				<g
					className={cn(
						"origin-center",
						reduceMotion || "motion-safe:animate-[spin_2.4s_linear_infinite]"
					)}
				>
					<circle
						className={cn("fill-none", PATH_TONES[tone].stroke)}
						cx="48"
						cy="48"
						pathLength="100"
						r="44"
						strokeDasharray="30 70"
						strokeLinecap="round"
						strokeWidth="7"
						transform="rotate(-90 48 48)"
					/>
				</g>
			) : null}
		</svg>
	);
}

/**
 * "You are here": a pennant planted on the trail beside the current stop, on
 * the side away from its label (narrow paths keep labels right, so it goes
 * left). Decorative; the stop's own label and callout say it.
 */
export function PathFlag({ swing }: { swing: number }) {
	return (
		<svg
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute -top-9 h-[84px] w-14",
				swing > 0
					? "@max-[519px]/col:right-full @max-[519px]/col:left-auto left-full @max-[519px]/col:mr-1 @max-[519px]/col:ml-0 ml-1"
					: "right-full mr-1"
			)}
			viewBox="0 0 56 84"
		>
			<ellipse className="fill-(--gk-edge)/25" cx="16" cy="78" rx="12" ry="4" />
			<rect
				className="fill-(--gk-edge)"
				height="74"
				rx="2.5"
				width="5"
				x="13.5"
				y="4"
			/>
			<path
				className="fill-(--gk-accent) stroke-(--gk-edge)"
				d="M18 7 L52 17 L18 29 Z"
				strokeLinejoin="round"
				strokeWidth="3"
			/>
			<path
				className="fill-(--gk-plate)"
				d="M29 13.5 l1.8 3.7 4 .6 -2.9 2.8 .7 4 -3.6-1.9 -3.6 1.9 .7-4 -2.9-2.8 4-.6 Z"
			/>
			<circle
				className="fill-(--gk-gold) stroke-(--gk-edge)"
				cx="16"
				cy="5"
				r="4.5"
				strokeWidth="2.5"
			/>
		</svg>
	);
}

/** The callout above the current stop, as a speech bubble pointing down. */
export function Callout({
	border,
	ink,
	label,
	reduceMotion,
}: {
	/** Outline color, matched to the coin under it. */
	border: string;
	/** Text color, matched to the coin under it. */
	ink: string;
	label: string;
	reduceMotion: boolean;
}) {
	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute bottom-full left-1/2 mb-7 -translate-x-1/2"
		>
			<motion.span
				animate={reduceMotion ? undefined : { y: [0, -4, 0] }}
				className="relative block"
				transition={{
					duration: 1.6,
					ease: "easeInOut",
					repeat: Number.POSITIVE_INFINITY,
				}}
			>
				<span
					className={cn(
						"gk-display relative z-10 block whitespace-nowrap rounded-xl border-2 border-b-4 bg-(--gk-plate) px-4 py-2 text-[17px] uppercase leading-5 tracking-wide",
						border,
						ink
					)}
				>
					{label}
				</span>
				<span
					className={cn(
						"absolute top-full left-1/2 z-10 size-3.5 -translate-x-1/2 -translate-y-[9px] rotate-45 border-r-4 border-b-4 bg-(--gk-plate)",
						border
					)}
				/>
			</motion.span>
		</span>
	);
}

export function StopIcon({ stop }: { stop: PathStop }) {
	switch (stop.state) {
		case "attention":
			return <span className="font-black text-3xl leading-none">!</span>;
		case "current":
			return stop.status === "attention" ? (
				<span className="font-black text-3xl leading-none">!</span>
			) : (
				<Star className="size-7 fill-current" strokeWidth={2} />
			);
		case "done":
			return <Check className="size-8" strokeWidth={4} />;
		case "reply":
			return <Reply className="size-8" strokeWidth={3.25} />;
		case "working":
			return <Ellipsis className="size-8" strokeWidth={3.5} />;
		case "waiting":
			return <Hourglass className="size-7" strokeWidth={2.75} />;
		default:
			return <Star className="size-7" strokeWidth={2.75} />;
	}
}

export function faceFor(stop: PathStop, tone: PathTone) {
	if (
		stop.state === "attention" ||
		(stop.state === "current" && stop.status === "attention")
	) {
		return { face: "bg-destructive", onFace: "text-background" };
	}
	if (stop.state === "waiting" || stop.state === "fresh") {
		return { face: PATH_NEUTRAL_FILL, onFace: "text-muted-foreground" };
	}
	return { face: PATH_TONES[tone].fill, onFace: PATH_TONES[tone].onFill };
}
