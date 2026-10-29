import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { Check, Ellipsis, Hourglass, Plus, Reply, Star } from "lucide-react";
import { motion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { compactAge } from "./interface-renderer.ts";
import { PathChest, PathTrophy } from "./path-art.tsx";
import type { PathStop, PathTone, PathUnit } from "./path-model.ts";
import { PATH_NEUTRAL_FILL, PATH_TONES } from "./path-tone.ts";

/**
 * Marks every focusable stop, for arrow-key travel along the path. Its value
 * is the stop's key (a thread id, or `add:<unit id>` for a unit's `+`), so the
 * path can keep a single tab stop (a roving tabindex).
 */
export const PATH_STOP_ATTRIBUTE = "data-path-stop";

export function pathAddKey(unitId: string): string {
	return `add:${unitId}`;
}

/**
 * How much room a row's art takes beyond the plain 64px coin and its 8px lip
 * (0 to 72px): a ring reaches 16px above and 8px below, the callout another
 * 56px above that, the dashed `+` and the chest sit inside it. Each row pads
 * by its own reach, so the air between any two neighbors is one 32px gap.
 */
export type PathRowFit = "add" | "art" | "callout" | "coin" | "ring";

const ROW_FIT = {
	add: "-mt-3 pb-5",
	art: "-mt-2 pb-6",
	callout: "pt-[72px] pb-10",
	coin: "pb-8",
	ring: "pt-4 pb-10",
} as const satisfies Record<PathRowFit, string>;

/**
 * One row of the path. Its 72px art box sits at the path's center plus
 * `swing` steps, so the path winds left and right; the steps and center are
 * CSS variables the list narrows on small widths.
 */
export function PathRow({
	children,
	className,
	done = false,
	fit,
	swing,
}: {
	children: ReactNode;
	className?: string;
	/** A finished stop: the trail up to it is trodden. */
	done?: boolean;
	fit: PathRowFit;
	swing: number;
}) {
	return (
		<li
			className={cn("relative", ROW_FIT[fit], className)}
			// SAFETY: React's CSSProperties omits custom properties; `--path-swing`
			// is a plain number the art box's margin calc multiplies by the step.
			style={{ "--path-swing": swing } as CSSProperties}
		>
			<div
				className="relative ml-[calc(var(--path-center)+var(--path-swing)*var(--path-step)-32px)] h-[72px] w-16"
				data-done={done ? "" : undefined}
			>
				{children}
			</div>
		</li>
	);
}

/** Labels sit on the open side of the swing; narrow paths keep them right. */
function labelPlacement(swing: number): string {
	const base =
		"absolute top-[32px] w-max max-w-60 -translate-y-1/2 rounded-xl border-(--gk-edge)/15 border-2 bg-(--gk-plate)/92 px-3 py-1.5 shadow-[0_2px_0_var(--gk-shadow)] @max-[519px]/col:right-auto @max-[519px]/col:left-full @max-[519px]/col:ml-5 @max-[519px]/col:mr-0 @max-[519px]/col:w-[min(15rem,calc(74cqw-var(--path-step)*1.6-3.5rem))] @max-[519px]/col:text-left";
	return swing > 0
		? cn(base, "right-full mr-5 text-right")
		: cn(base, "left-full ml-5 text-left");
}

function StopLabel({
	className,
	interactive = false,
	meta,
	metaClassName,
	swing,
	title,
	titleClassName,
}: {
	/** Extra placement classes (a smaller node sits its label closer). */
	className?: string;
	/** Underline the title on hover, when the label belongs to a button. */
	interactive?: boolean;
	meta: ReactNode;
	metaClassName?: string;
	swing: number;
	title: string;
	titleClassName?: string;
}) {
	return (
		<span aria-hidden="true" className={cn(labelPlacement(swing), className)}>
			<span
				className={cn(
					"line-clamp-2 font-bold text-(--gk-ink) text-[15px] leading-5 decoration-2 underline-offset-4",
					interactive && "group-hover/stop:underline",
					titleClassName
				)}
			>
				{title}
			</span>
			<span
				className={cn(
					"mt-0.5 block truncate font-semibold text-(--gk-ink-muted) text-[13px] leading-5",
					metaClassName
				)}
			>
				{meta}
			</span>
		</span>
	);
}

/**
 * A chunky, pressable coin: a solid face over a darker lip of the same color
 * (the face color through a brightness filter, so it works for any token).
 * Pressing drops the face onto the lip.
 */
function Coin({
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

const PRESS_BUTTON =
	"group/stop absolute inset-x-0 top-0 h-[72px] w-16 cursor-pointer rounded-full outline-none";

/** Keyboard focus rings the face only, like the open stop's halo. */
const FACE_FOCUS =
	"group-focus-visible/stop:ring-[3px] group-focus-visible/stop:ring-ring group-focus-visible/stop:ring-offset-4 group-focus-visible/stop:ring-offset-(--gk-plate)";

/**
 * A ring around the coin: a quiet track for the current stop, a moving arc
 * for a live run. The arc only turns when motion is allowed.
 */
function StopRing({
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
function PathFlag({ swing }: { swing: number }) {
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
function Callout({
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

function StopIcon({ stop }: { stop: PathStop }) {
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

function faceFor(stop: PathStop, tone: PathTone) {
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

function leadName(stop: PathStop): string {
	return stop.agents[0]?.name ?? "No agent";
}

/** The meta line under a stop's title, in the user's terms. */
export function stopMeta(stop: PathStop): string {
	switch (stop.state) {
		case "attention":
			return stop.thread.runState === "interrupted"
				? "Run stopped"
				: "Run failed";
		case "current":
			return stop.status === "attention"
				? "Run failed · needs you"
				: `Your turn · ${leadName(stop)} replied`;
		case "done":
			return "Done";
		case "reply":
			return `Your turn · ${leadName(stop)} replied`;
		case "working":
			return `${leadName(stop)} is working`;
		case "waiting":
			return stop.agents[0] ? `Waiting on ${leadName(stop)}` : "No agent yet";
		default:
			return THREAD_STATUS_LABELS[stop.status];
	}
}

/** The meta line's color: failures and live runs carry their status hue. */
export function stopMetaTone(state: PathStop["state"]): string | undefined {
	if (state === "attention") {
		return "text-status-destructive";
	}
	return state === "working" ? "text-status-success" : undefined;
}

/**
 * The callout's verb: a failed run is there to review, a reply to continue,
 * and a thread nobody has opened yet to start.
 */
export function stopAction(stop: PathStop): string {
	if (stop.status === "attention") {
		return "Review";
	}
	return stop.status === "quiet" ? "Start" : "Continue";
}

export function stopTitle(stop: PathStop): string {
	return stop.thread.title.trim() || "Untitled thread";
}

export function PathStopItem({
	now,
	onOpen,
	reduceMotion,
	selected,
	stop,
	swing,
	tabStop,
	tone,
}: {
	now: number;
	onOpen: (threadId: string) => void;
	reduceMotion: boolean;
	selected: boolean;
	stop: PathStop;
	swing: number;
	/** The path's one Tab stop; the rest are reached with the arrow keys. */
	tabStop: boolean;
	tone: PathTone;
}) {
	const title = stopTitle(stop);
	const meta = stopMeta(stop);
	const age = compactAge(stop.thread.updatedAt, now);
	const current = stop.state === "current";
	const ringed = current || stop.state === "working";
	const action = stopAction(stop);
	const { face, onFace } = faceFor(stop, tone);
	const currentInk = PATH_TONES[tone].ink;
	let fit: PathRowFit = "coin";
	if (current) {
		fit = "callout";
	} else if (ringed) {
		fit = "ring";
	}
	return (
		<PathRow done={stop.state === "done"} fit={fit} swing={swing}>
			{current ? <PathFlag swing={swing} /> : null}
			{ringed ? (
				<StopRing
					reduceMotion={reduceMotion}
					selected={selected}
					tone={tone}
					working={stop.state === "working"}
				/>
			) : null}
			{current ? (
				<Callout
					border={PATH_TONES[tone].border}
					ink={currentInk}
					label={action}
					reduceMotion={reduceMotion}
				/>
			) : null}
			<button
				aria-current={selected ? "true" : undefined}
				aria-label={`${current ? `${action}: ` : ""}${title}. ${meta}${age ? `, ${age === "now" ? "just now" : `${age} ago`}` : ""}.`}
				className={PRESS_BUTTON}
				data-thread-id={stop.thread.id}
				onClick={() => onOpen(stop.thread.id)}
				tabIndex={tabStop ? 0 : -1}
				type="button"
				{...{ [PATH_STOP_ATTRIBUTE]: stop.thread.id }}
			>
				<Coin
					face={face}
					halo={!ringed}
					onFace={cn(onFace, stop.state === "waiting" && "opacity-70")}
					selected={selected}
				>
					<StopIcon stop={stop} />
				</Coin>
				<StopLabel
					interactive
					meta={age ? `${meta} · ${age}` : meta}
					metaClassName={
						current && stop.status !== "attention"
							? currentInk
							: stopMetaTone(
									stop.status === "attention" ? "attention" : stop.state
								)
					}
					swing={swing}
					title={title}
				/>
			</button>
		</PathRow>
	);
}

/** The milestone's one-line caption. */
export function milestoneCaption(done: number, total: number): string {
	return done === total ? "Unit complete" : `${done} of ${total} finished`;
}

export function PathMilestoneItem({
	swing,
	unit,
}: {
	swing: number;
	unit: PathUnit;
}) {
	const total = unit.stops.length;
	const complete = unit.milestone === "trophy";
	return (
		<PathRow fit="art" swing={swing}>
			<div
				aria-label={
					complete
						? `Unit ${unit.index} complete: all ${total} finished`
						: `Unit ${unit.index} milestone: ${unit.doneCount} of ${total} finished`
				}
				className="absolute inset-x-0 top-0 flex h-[72px] items-center justify-center"
				role="img"
			>
				{complete ? (
					<PathTrophy />
				) : (
					<PathChest progress={unit.doneCount / total} />
				)}
				<MilestoneLabel
					swing={swing}
					text={milestoneCaption(unit.doneCount, total)}
				/>
			</div>
		</PathRow>
	);
}

/** A milestone's caption: one line, vertically centered on the art. */
function MilestoneLabel({ swing, text }: { swing: number; text: string }) {
	return (
		<span aria-hidden="true" className={labelPlacement(swing)}>
			<span className="block truncate font-bold text-(--gk-ink-muted) text-[15px] leading-5">
				{text}
			</span>
		</span>
	);
}

/**
 * The end of the path: one trophy for everything on it, lit once every stop
 * is finished.
 */
export function PathFinishItem({
	done,
	swing,
	total,
}: {
	done: number;
	swing: number;
	total: number;
}) {
	const complete = total > 0 && done === total;
	return (
		<PathRow fit="art" swing={swing}>
			<div
				aria-label={`End of the path: ${done} of ${total} finished`}
				className="absolute inset-x-0 top-0 flex h-[72px] items-center justify-center"
				role="img"
			>
				<PathTrophy locked={!complete} />
				<MilestoneLabel
					swing={swing}
					text={complete ? "Path complete" : `${done} of ${total} finished`}
				/>
			</div>
		</PathRow>
	);
}

export function PathAddItem({
	label,
	meta,
	onStart,
	stopKey,
	swing,
	tabStop,
}: {
	label: string;
	meta: string;
	onStart: () => void;
	stopKey: string;
	swing: number;
	tabStop: boolean;
}) {
	return (
		<PathRow fit="add" swing={swing}>
			<button
				aria-label={label}
				className={PRESS_BUTTON}
				onClick={onStart}
				tabIndex={tabStop ? 0 : -1}
				type="button"
				{...{ [PATH_STOP_ATTRIBUTE]: stopKey }}
			>
				<span
					aria-hidden="true"
					className="absolute top-2 left-2 flex size-12 items-center justify-center rounded-full border-(--gk-edge)/45 border-[3px] border-dashed bg-(--gk-plate) text-(--gk-ink-muted) transition-colors duration-100 group-hover/stop:border-primary group-hover/stop:text-primary group-focus-visible/stop:ring-[3px] group-focus-visible/stop:ring-ring group-focus-visible/stop:ring-offset-(--gk-plate) group-focus-visible/stop:ring-offset-4 group-active/stop:bg-primary/10"
				>
					<Plus className="size-6" strokeWidth={3} />
				</span>
				<StopLabel
					className={cn("@max-[519px]/col:ml-3", swing > 0 ? "mr-3" : "ml-3")}
					interactive
					meta={meta}
					swing={swing}
					title="New thread"
					titleClassName="text-(--gk-ink-muted) group-hover/stop:text-(--gk-ink)"
				/>
			</button>
		</PathRow>
	);
}
