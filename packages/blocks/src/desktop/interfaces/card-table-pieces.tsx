import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent, ThreadStatus } from "@ryuhq/protocol/interfaces";
import { animate } from "motion/react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useCardTableLook } from "./card-table-look.tsx";
import { jitter, type SeatTone, STATUS_SUIT } from "./card-table-model.ts";
import {
	CARD_BACK_BORDER,
	CHIP_COLORS,
	CHIP_DROP,
	CHIP_RIM,
	CHIP_SEAM,
	cardBackFor,
	chipEdge,
	chipFace,
	TIMER_TRACK,
} from "./card-table-palette.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/** Text tone for a status suit and label; the suit shape carries it too. */
export const SUIT_TONE: Record<ThreadStatus, string> = {
	attention: "text-status-destructive",
	quiet: "text-muted-foreground",
	waiting: "text-muted-foreground",
	working: "text-status-success",
	"your-turn": "text-card-foreground",
};

const RING_TONE: Record<Exclude<SeatTone, "working">, string> = {
	attention: "border-destructive",
	idle: "border-border",
	"your-turn": "border-primary",
};

const AVATAR_SIZE = {
	28: "size-7",
	36: "size-9",
	44: "size-11",
} as const;

export type SeatAvatarSize = keyof typeof AVATAR_SIZE;

/** How long one lap of a working agent's action timer takes. */
const TIMER_SECONDS = 14;
/** Where the timer's arc is held when motion is reduced: three quarters left. */
const TIMER_REDUCED_SHARE = 0.25;

/**
 * How far into its current lap the action timer is, in seconds: the live
 * run's elapsed time, so the arc does not start over on every mount.
 */
export function timerLapSeconds(
	since: string | undefined,
	now: number
): number {
	const started = since ? Date.parse(since) : Number.NaN;
	if (Number.isNaN(started)) {
		return 0;
	}
	const elapsed = Math.max(0, (now - started) / 1000);
	return elapsed % TIMER_SECONDS;
}

/**
 * The poker action timer around a working agent's face: a success-colored
 * arc over a track that runs down and restarts. Each lap starts where the
 * live run's elapsed time puts it; with reduced motion it holds still at three
 * quarters.
 */
function ActionTimer({ box, since }: { box: number; since?: string }) {
	const reduceMotion = useReducedMotion();
	const arcRef = useRef<SVGCircleElement>(null);
	const radius = box / 2 - 2;
	const circumference = 2 * Math.PI * radius;
	// Read once: the lap keeps running on its own after mount.
	const [lap] = useState(() => timerLapSeconds(since, Date.now()));
	// Driven imperatively, so a surrounding AnimatePresence that skips its
	// children's first animation (a drawer open on load) cannot freeze it.
	useEffect(() => {
		const arc = arcRef.current;
		if (!arc || reduceMotion) {
			return;
		}
		const controls = animate(
			arc,
			{ strokeDashoffset: [0, circumference] },
			{
				// A negative delay starts the first lap part way through.
				delay: -lap,
				duration: TIMER_SECONDS,
				ease: "linear",
				repeat: Number.POSITIVE_INFINITY,
			}
		);
		return () => controls.stop();
	}, [circumference, lap, reduceMotion]);
	const offset = reduceMotion
		? circumference * TIMER_REDUCED_SHARE
		: (lap / TIMER_SECONDS) * circumference;
	return (
		<svg
			className="absolute inset-0 -rotate-90"
			data-action-timer=""
			height={box}
			viewBox={`0 0 ${box} ${box}`}
			width={box}
		>
			<circle
				cx={box / 2}
				cy={box / 2}
				fill="none"
				r={radius}
				stroke={TIMER_TRACK}
				strokeWidth={2.5}
			/>
			<circle
				className="stroke-success"
				cx={box / 2}
				cy={box / 2}
				data-timer-arc=""
				fill="none"
				r={radius}
				ref={arcRef}
				strokeDasharray={circumference}
				strokeDashoffset={offset}
				strokeLinecap="round"
				strokeWidth={2.5}
			/>
		</svg>
	);
}

/**
 * The card room's working mark over a seat's name plate: the poker action
 * timer running round a chip, so a working seat reads in 3D as well as on
 * the flat table. Decorative; the seat's name says it is working.
 */
export function TimerChip({
	elapsed,
	since,
}: {
	/** How long the run has gone ("12m"), shown beside the ring. */
	elapsed?: string;
	since?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className="gk-display flex h-7 items-center gap-1 whitespace-nowrap rounded-full border-(--gk-edge) border-2 bg-(--gk-plate) ps-0.5 pe-2 text-(--gk-ink) text-[12px] tabular-nums leading-none shadow-[0_2px_0_var(--gk-edge)]"
			data-timer-chip=""
		>
			<span className="relative grid size-5 place-items-center">
				<ActionTimer box={20} since={since} />
				<span className="absolute size-1.5 rounded-full bg-success" />
			</span>
			{elapsed}
		</span>
	);
}

/**
 * An agent's face with its status ring. A working agent gets the poker action
 * timer instead (see {@link ActionTimer}). Decorative; the seat's accessible
 * name carries the status.
 */
export function SeatAvatar({
	agent,
	since,
	size,
	tone,
}: {
	agent: InterfaceAgent;
	/** When the agent's live run last moved, for the action timer's lap. */
	since?: string;
	size: SeatAvatarSize;
	tone: SeatTone;
}) {
	const seed = ditherAvatarSeed({ id: agent.id, name: agent.name });
	const box = size + 10;
	return (
		<span
			aria-hidden="true"
			className="relative grid shrink-0 place-items-center"
			style={{ height: box, width: box }}
		>
			{tone === "working" ? (
				<ActionTimer box={box} since={since} />
			) : (
				<span
					className={cn(
						"absolute inset-0.5 rounded-full border-2",
						RING_TONE[tone]
					)}
				/>
			)}
			<Avatar className={cn(AVATAR_SIZE[size], "bg-muted")}>
				{agent.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
				<AvatarFallback
					appearance="artwork"
					className="overflow-hidden bg-muted"
				>
					<DitherAvatar animate={false} className="size-full" name={seed} />
				</AvatarFallback>
			</Avatar>
		</span>
	);
}

function chipColor(colorIndex: number): string {
	return CHIP_COLORS[colorIndex % CHIP_COLORS.length] ?? "var(--primary)";
}

/**
 * A short stack of chips seen at a slant: one chip per thread, capped by the
 * caller. Each chip is an elliptical face over an inlaid edge, with a hairline
 * seam where it sits on the chip below, so one, two and three chips are three
 * clearly different heights.
 */
export function ChipStack({
	chips,
	colorIndex,
	size = 22,
}: {
	chips: number;
	colorIndex: number;
	size?: number;
}) {
	const color = chipColor(colorIndex);
	const thickness = Math.max(5, Math.round(size / 5.5));
	const faceHeight = Math.round(size * 0.5);
	const height = faceHeight + thickness * chips;
	const edgeRadius = `${size / 2}px / ${faceHeight / 2}px`;
	const period = Math.round(size / 3.2);
	return (
		<span
			aria-hidden="true"
			className="relative block"
			style={{ height, width: size }}
		>
			{Array.from({ length: chips }, (_, chip) => (
				<span
					className="absolute left-0 block"
					// biome-ignore lint/suspicious/noArrayIndexKey: chips are identical and never reorder
					key={chip}
					style={{
						bottom: chip * thickness,
						height: faceHeight + thickness,
						width: size,
					}}
				>
					<span
						className="absolute inset-0 block"
						style={{
							backgroundImage: chipEdge(color, period),
							backgroundPositionX: Math.round(((chip * 0.43) % 1) * period),
							borderRadius: edgeRadius,
							boxShadow:
								chip === 0
									? `0 1px 0 ${CHIP_SEAM}, 0 2px 4px ${CHIP_DROP}`
									: `0 1px 0 ${CHIP_SEAM}`,
						}}
					/>
					<span
						className="absolute inset-x-0 top-0 block rounded-[50%]"
						style={{
							background: chipFace(color),
							boxShadow: `inset 0 0 0 1px ${CHIP_RIM}`,
							height: faceHeight,
						}}
					/>
				</span>
			))}
		</span>
	);
}

/** Loose chips scattered in front of the pot's stacks, at most. */
const MAX_LOOSE_CHIPS = 4;

/**
 * The pot: a pile of stacks, one per live run, in two staggered rows (the
 * back row sits higher and behind), with a few loose chips tossed in front.
 * Every offset is derived from the run ids, so the pile never twitches.
 */
export function ChipPile({
	ids,
	size = 34,
}: {
	ids: readonly string[];
	size?: number;
}) {
	const shown = ids.slice(0, 6);
	if (shown.length === 0) {
		return null;
	}
	const step = size * 0.74;
	const loose = Math.min(MAX_LOOSE_CHIPS, shown.length + 2);
	const reach = ((shown.length - 1) / 2) * step;
	const width = Math.round(reach * 2 + size * 3.2);
	const height = Math.round(size * 2.6);
	const looseChips = Array.from({ length: loose }, (_, index) => {
		const side = index % 2 === 0 ? -1 : 1;
		const ring = Math.floor(index / 2);
		const seed = `${shown[index % shown.length] ?? "pot"}:${index}`;
		return {
			bottom: Math.round(
				-size * 0.08 + ring * size * 0.22 + jitter(seed, 4) * 3
			),
			colorIndex: index + 2,
			key: seed,
			left: Math.round(
				width / 2 -
					size / 2 +
					side * (reach + size * (0.82 + ring * 0.62)) +
					jitter(seed, 5) * 4
			),
			rotate: jitter(seed, 6) * 9,
		};
	});
	return (
		<span
			aria-hidden="true"
			className="relative block"
			data-testid="card-table-pile"
			style={{ height, width }}
		>
			{shown.map((id, index) => {
				const back = index % 2 === 1;
				return (
					<span
						className="absolute"
						key={id}
						style={{
							bottom: Math.round(
								(back ? size * 0.34 : size * 0.06) + jitter(id, 8) * 2
							),
							left: Math.round(
								width / 2 -
									size / 2 +
									(index - (shown.length - 1) / 2) * step +
									jitter(id, 7) * 4
							),
							zIndex: back ? 1 : 2,
						}}
					>
						<ChipStack
							chips={3 + Math.round((jitter(id, 9) + 1) * 1.5)}
							colorIndex={index}
							size={size}
						/>
					</span>
				);
			})}
			{looseChips.map((chip) => (
				<span
					className="absolute z-[3]"
					key={chip.key}
					style={{
						bottom: chip.bottom,
						left: chip.left,
						transform: `rotate(${chip.rotate}deg)`,
					}}
				>
					<ChipStack chips={1} colorIndex={chip.colorIndex} size={size} />
				</span>
			))}
		</span>
	);
}

/** A face-down card: the theme's primary lattice inside a white-ish border. */
export function CardBack({
	className,
	style,
}: {
	className?: string;
	style?: CSSProperties;
}) {
	const { deck } = useCardTableLook();
	return (
		<span
			aria-hidden="true"
			className={cn(
				"block rounded-[5px] border-2 shadow-sm ring-1 ring-foreground/10",
				className
			)}
			style={{
				background: cardBackFor(deck),
				borderColor: CARD_BACK_BORDER,
				...style,
			}}
		/>
	);
}

/** The status suit, colored by status. Decorative unless labelled by the caller. */
export function SuitGlyph({
	className,
	status,
}: {
	className?: string;
	status: ThreadStatus;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn("leading-none", SUIT_TONE[status], className)}
		>
			{STATUS_SUIT[status]}
		</span>
	);
}

/**
 * Two face-down cards on the felt in front of a seat: the agent is holding the
 * action (a live run, or a message it has not answered yet). The seat's
 * tooltip says so in words.
 */
export function HoleCards({ width }: { width: number }) {
	const height = Math.round(width * 1.4);
	return (
		<span
			aria-hidden="true"
			className="relative block shrink-0"
			data-hole-cards=""
			style={{ height: height + 4, width: Math.round(width * 1.42) }}
		>
			<CardBack
				className="absolute bottom-0.5 left-0"
				style={{ height, transform: "rotate(-10deg)", width }}
			/>
			<CardBack
				className="absolute right-0 bottom-0"
				style={{ height, transform: "rotate(6deg)", width }}
			/>
		</span>
	);
}
