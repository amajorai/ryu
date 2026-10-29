import { cn } from "@ryu/ui/lib/utils";
import type { ThreadStatus } from "@ryuhq/protocol/interfaces";
import {
	formatChange,
	formatPercent,
	type TickerDirection,
} from "./ticker-model.ts";

/** Readable text tone for a move: theme success/destructive, muted when flat. */
export const DIRECTION_TEXT: Record<TickerDirection, string> = {
	down: "text-status-destructive",
	flat: "text-muted-foreground",
	up: "text-status-success",
};

/**
 * The one ticker-symbol treatment: semibold mono, plain text. Mono is reserved
 * for symbols; every figure (prices, moves, times) is sans with tabular
 * numerals. Callers set the size.
 */
export const SYMBOL_TEXT =
	"font-mono font-semibold text-foreground tracking-normal";

/** Soft fill behind a change pill, in the same hue. */
const DIRECTION_PILL: Record<TickerDirection, string> = {
	down: "bg-destructive/10 text-status-destructive",
	flat: "bg-muted/60 text-muted-foreground",
	up: "bg-success/10 text-status-success",
};

export const DIRECTION_STROKE: Record<TickerDirection, string> = {
	down: "stroke-destructive",
	flat: "stroke-muted-foreground",
	up: "stroke-success",
};

/** Solid up/down triangles (Lucide's are outlines) and a flat bar, in currentColor. */
function Glyph({ className, path }: { className?: string; path: string }) {
	return (
		<svg
			aria-hidden="true"
			className={cn("fill-current", className)}
			viewBox="0 0 10 10"
		>
			<path d={path} />
		</svg>
	);
}

const GLYPH_PATH: Record<TickerDirection, string> = {
	down: "M1 2.5h8L5 8.5z",
	flat: "M1.5 4.25h7v1.5h-7z",
	up: "M5 1.5l4 6H1z",
};

export function DirectionGlyph({
	className,
	direction,
}: {
	className?: string;
	direction: TickerDirection;
}) {
	return <Glyph className={className} path={GLYPH_PATH[direction]} />;
}

/**
 * "▲ +2 (+100.0%)" in the move's tone; the percent is left out when there was
 * nothing yesterday to compare with. Decorative: callers name the move.
 */
export function ChangeText({
	change,
	changePercent,
	className,
	direction,
}: {
	change: number;
	changePercent: number | null;
	className?: string;
	direction: TickerDirection;
}) {
	return (
		<span
			className={cn(
				"inline-flex items-baseline gap-1 tabular-nums",
				DIRECTION_TEXT[direction],
				className
			)}
		>
			<DirectionGlyph
				className="size-2.5 shrink-0 self-center"
				direction={direction}
			/>
			<span>{formatChange(change)}</span>
			{changePercent === null ? null : (
				<span>({formatPercent(changePercent)})</span>
			)}
		</span>
	);
}

/**
 * The watchlist's change pill (Robinhood's right-hand chip): the messages in
 * threads active today, the same unit as the price beside it, so every row
 * compares like with like. Fixed width, so every pill lines up on both edges. Decorative:
 * the row names its change in words.
 */
export function ChangePill({
	change,
	className,
	direction,
}: {
	change: number;
	className?: string;
	direction: TickerDirection;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-6 w-14 items-center justify-end rounded-md px-2 font-medium text-sm tabular-nums",
				DIRECTION_PILL[direction],
				className
			)}
		>
			{formatChange(change)}
		</span>
	);
}

const SPARK_WIDTH = 72;
const SPARK_HEIGHT = 24;
const SPARK_PAD = 2;

/**
 * A series of closes as a bare line, the way a watchlist row draws one.
 * Decorative: the row names its change in words.
 */
export function Sparkline({
	className,
	direction,
	values,
}: {
	className?: string;
	direction: TickerDirection;
	values: number[];
}) {
	const low = Math.min(...values);
	const span = Math.max(...values) - low;
	const step = values.length > 1 ? SPARK_WIDTH / (values.length - 1) : 0;
	const y = (value: number) =>
		span === 0
			? SPARK_HEIGHT / 2
			: SPARK_PAD + (1 - (value - low) / span) * (SPARK_HEIGHT - SPARK_PAD * 2);
	const points = values.map(
		(value, index) => `${(index * step).toFixed(2)},${y(value).toFixed(2)}`
	);
	return (
		<svg
			aria-hidden="true"
			className={cn("h-6 w-[4.5rem] overflow-visible", className)}
			viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
		>
			<path
				className={cn("fill-none", DIRECTION_STROKE[direction])}
				d={`M${points.join(" L")}`}
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

/** Label tone per status: only failures and live runs take a hue. */
export const STATUS_TEXT: Record<ThreadStatus, string> = {
	attention: "text-status-destructive",
	quiet: "text-muted-foreground",
	waiting: "text-muted-foreground",
	working: "text-status-success",
	"your-turn": "text-foreground",
};
