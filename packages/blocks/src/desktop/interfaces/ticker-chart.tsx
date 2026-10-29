import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import { type KeyboardEvent, useId, useState } from "react";
import { useReducedMotion } from "./reduced-motion.ts";
import {
	formatClock,
	formatDay,
	formatPrice,
	formatShortDay,
	formatWeekdayClock,
	plural,
	seriesDirection,
	seriesPeriod,
	shownPercent,
	TICKER_RANGE_LABELS,
	TICKER_RANGE_NAMES,
	TICKER_RANGES,
	type TickerDay,
	type TickerDirection,
	type TickerRange,
	type TickerSeries,
} from "./ticker-model.ts";
import {
	ChangeText,
	DIRECTION_STROKE,
	DIRECTION_TEXT,
} from "./ticker-parts.tsx";

/** Plot padding, in percent of the plot height, so the line never kisses an edge. */
const PLOT_TOP = 8;
const PLOT_BOTTOM = 8;
const DAY_MS = 86_400_000;

/** A faint wash under the line in the move's colour. */
const AREA_FILL: Record<TickerDirection, string> = {
	down: "fill-destructive/8",
	flat: "fill-muted-foreground/8",
	up: "fill-success/10",
};

const DOT_FILL: Record<TickerDirection, string> = {
	down: "bg-destructive",
	flat: "bg-muted-foreground",
	up: "bg-success",
};
const AXIS_LABEL =
	"absolute -end-10 w-8 -translate-y-1/2 text-end text-muted-foreground text-xs tabular-nums";

interface PricePlot {
	/** The line closed down to the baseline, for the soft fill under it. */
	area: string;
	high: number;
	line: string;
	low: number;
	/** Vertical position (percent from the top) of a price. */
	y: (value: number) => number;
}

/** Horizontal centre of bucket `index` of `count`, in percent. */
function columnX(index: number, count: number): number {
	return ((index + 0.5) / count) * 100;
}

/**
 * The price line in a 0–100 box: straight segments from the opening price at
 * the left edge through each bucket's close at the bucket's centre, ending at
 * the endpoint dot. The scale hugs the range (like a stock chart, not from
 * zero).
 */
function pricePlot(buckets: TickerDay[], opening: number): PricePlot {
	let low = opening;
	let high = opening;
	for (const bucket of buckets) {
		low = Math.min(low, bucket.close);
		high = Math.max(high, bucket.close);
	}
	const span = high - low;
	const y = (value: number) =>
		span === 0
			? 50
			: PLOT_TOP + (1 - (value - low) / span) * (100 - PLOT_TOP - PLOT_BOTTOM);
	const points = buckets.map(
		(bucket, index) =>
			`L${columnX(index, buckets.length).toFixed(2)},${y(bucket.close).toFixed(2)}`
	);
	const line = `M0,${y(opening).toFixed(2)} ${points.join(" ")}`;
	const lastX =
		buckets.length > 0 ? columnX(buckets.length - 1, buckets.length) : 0;
	const floor = (100 - PLOT_BOTTOM).toFixed(2);
	const area = `${line} L${lastX.toFixed(2)},${floor} L0,${floor} Z`;
	return { area, high, line, low, y };
}

function moveDirection(move: number): TickerDirection {
	if (move > 0) {
		return "up";
	}
	return move < 0 ? "down" : "flat";
}

/** A bucket's printed name: its day, or its weekday and start time. */
function bucketLabel(bucket: TickerDay, unit: TickerSeries["unit"]): string {
	return unit === "day"
		? formatDay(bucket.date)
		: formatWeekdayClock(bucket.date);
}

/** The x-axis label at the start and middle of a series. */
function axisLabel(
	bucket: TickerDay,
	series: TickerSeries,
	now: number
): string {
	if (series.unit === "day") {
		return formatShortDay(bucket.date);
	}
	return now - bucket.date > DAY_MS
		? formatWeekdayClock(bucket.date)
		: formatClock(bucket.date);
}

function bucketText(bucket: TickerDay, unit: TickerSeries["unit"]): string {
	return `${bucketLabel(bucket, unit)}: ${plural(bucket.close, "message")}, ${plural(bucket.threads, "thread")} active`;
}

/**
 * The selected ticker's price and its history, Robinhood-style: the price in
 * large numerals with the range's move under it, then a line chart over a
 * dotted "previous close", then the range picker on a hairline. Scrubbing (pointer, or arrow keys on the
 * focused chart) moves the price and move to that point, as Robinhood's hero
 * does. The series is narrowed to the stretch with activity, so a range that
 * was quiet until today still draws a readable line; the caption then names
 * the window drawn ("Since 22:35") rather than the range.
 */
export function TickerPriceHistory({
	now,
	onRangeChange,
	price,
	range,
	series,
	symbol,
}: {
	now: number;
	onRangeChange: (range: TickerRange) => void;
	/** The live price, shown when not scrubbing. */
	price: number;
	range: TickerRange;
	series: TickerSeries;
	symbol: string;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const [scrub, setScrub] = useState<number | null>(null);
	const headingId = useId();
	const { buckets, opening, unit } = series;
	const count = buckets.length;
	const lastIndex = count - 1;
	const direction = seriesDirection(buckets);
	const plot = pricePlot(buckets, opening);
	const focusIndex = scrub ?? lastIndex;
	const focusBucket = buckets[focusIndex];
	const scrubbed = scrub === null ? undefined : buckets[scrub];
	const shownPrice = scrubbed ? scrubbed.close : price;
	const move = shownPrice - opening;
	const percent = shownPercent(
		opening === 0 ? null : (move / opening) * 100,
		opening,
		shownPrice
	);
	const middleIndex = Math.floor(lastIndex / 2);
	const middle = buckets[middleIndex];
	const mid = Math.round((plot.low + plot.high) / 2);
	const grid = [plot.high, mid].filter(
		(value, index, values) =>
			value !== opening && values.indexOf(value) === index
	);
	const drawnPeriod = seriesPeriod(series, range, now);
	let period = drawnPeriod;
	if (scrubbed) {
		period = bucketLabel(scrubbed, unit);
	}

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const current = scrub ?? lastIndex;
		const moves: Record<string, number> = {
			ArrowLeft: Math.max(0, current - 1),
			ArrowRight: Math.min(lastIndex, current + 1),
			End: lastIndex,
			Home: 0,
		};
		const next = moves[event.key];
		if (next !== undefined) {
			event.preventDefault();
			setScrub(next);
		}
	};

	return (
		<section aria-labelledby={headingId} className="flex flex-col">
			<h3 className="sr-only" id={headingId}>
				Price history
			</h3>
			<p className="flex items-baseline gap-2">
				<span
					className="font-semibold text-5xl text-foreground tabular-nums leading-none tracking-tight"
					data-testid="ticker-hero-price"
				>
					{formatPrice(shownPrice)}
				</span>
				<span className="text-muted-foreground text-sm">messages</span>
			</p>
			<p
				aria-live={scrubbed ? "polite" : undefined}
				className="mt-2 flex min-h-5 flex-wrap items-baseline gap-x-2 text-sm"
				data-testid="ticker-hero-move"
			>
				<ChangeText
					change={move}
					changePercent={percent}
					className="font-medium"
					direction={moveDirection(move)}
				/>
				<span className="text-muted-foreground">{period}</span>
			</p>
			<div
				aria-label={tl("{symbol} price, {period}", {
					period: drawnPeriod.toLowerCase(),
					symbol,
				})}
				aria-orientation="horizontal"
				aria-valuemax={lastIndex}
				aria-valuemin={0}
				aria-valuenow={focusIndex}
				aria-valuetext={focusBucket ? bucketText(focusBucket, unit) : "No data"}
				className="relative mt-6 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
				data-direction={direction}
				data-testid="ticker-price-chart"
				data-unit={unit}
				onBlur={() => setScrub(null)}
				onKeyDown={onKeyDown}
				onPointerLeave={() => setScrub(null)}
				role="slider"
				tabIndex={0}
			>
				<div aria-hidden="true" className="relative h-64 pe-10">
					<div className="relative size-full">
						{grid.map((value) => (
							<div
								className="absolute inset-x-0 border-border/70 border-t"
								key={value}
								style={{ top: `${plot.y(value)}%` }}
							>
								<span className={AXIS_LABEL}>{formatPrice(value)}</span>
							</div>
						))}
						<div
							className="absolute inset-x-0 border-muted-foreground/50 border-t border-dotted"
							style={{ top: `${plot.y(opening)}%` }}
						>
							<span className={AXIS_LABEL}>{formatPrice(opening)}</span>
						</div>
						<motion.div
							animate={{ clipPath: "inset(0 0% 0 0)" }}
							className="absolute inset-0"
							initial={reduceMotion ? false : { clipPath: "inset(0 100% 0 0)" }}
							transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
						>
							<svg
								className="size-full overflow-visible"
								preserveAspectRatio="none"
								viewBox="0 0 100 100"
							>
								<path
									className={cn("stroke-none", AREA_FILL[direction])}
									d={plot.area}
								/>
								<path
									className={cn("fill-none", DIRECTION_STROKE[direction])}
									d={plot.line}
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									vectorEffect="non-scaling-stroke"
								/>
							</svg>
						</motion.div>
						{scrub === null ? null : (
							<span
								className="absolute -top-2 -bottom-2 w-px -translate-x-1/2 bg-foreground/25"
								style={{ left: `${columnX(scrub, count)}%` }}
							/>
						)}
						{focusBucket ? (
							<motion.span
								animate={{ opacity: 1 }}
								className="absolute size-0"
								data-testid="ticker-price-dot"
								initial={reduceMotion ? false : { opacity: 0 }}
								style={{
									left: `${columnX(focusIndex, count)}%`,
									top: `${plot.y(focusBucket.close)}%`,
								}}
								transition={{ delay: 0.5, duration: 0.2, ease: "easeOut" }}
							>
								<span
									className={cn(
										"absolute -inset-1 rounded-full ring-2 ring-background",
										DOT_FILL[direction]
									)}
								/>
							</motion.span>
						) : null}
					</div>
				</div>
				<div
					aria-hidden="true"
					className="absolute inset-y-0 start-0 end-10 flex"
				>
					{buckets.map((bucket, index) => (
						<div
							className="h-full min-w-0 flex-1"
							key={bucket.key}
							onPointerEnter={() => setScrub(index)}
						/>
					))}
				</div>
			</div>
			<div aria-hidden="true" className="mt-2 pe-10">
				<div className="relative h-4 text-[13px] text-muted-foreground tabular-nums">
					{buckets[0] && lastIndex > 1 ? (
						<span className="absolute start-0">
							{axisLabel(buckets[0], series, now)}
						</span>
					) : null}
					{middle && lastIndex > 3 ? (
						<span
							className="absolute -translate-x-1/2"
							style={{ left: `${columnX(middleIndex, count)}%` }}
						>
							{axisLabel(middle, series, now)}
						</span>
					) : null}
					<span className="absolute end-0">
						{unit === "day" ? "Today" : "Now"}
					</span>
				</div>
			</div>
			<div className="mt-4 border-border border-b">
				<div
					aria-label="Chart range"
					className="-ms-2 flex items-center gap-1"
					role="group"
				>
					{TICKER_RANGES.map((option) => {
						const active = option === range;
						return (
							<button
								aria-label={TICKER_RANGE_NAMES[option]}
								aria-pressed={active}
								className={cn(
									"relative h-9 rounded-md px-2 font-medium text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
									active
										? DIRECTION_TEXT[direction]
										: "text-muted-foreground hover:bg-muted hover:text-foreground"
								)}
								key={option}
								onClick={() => {
									setScrub(null);
									onRangeChange(option);
								}}
								type="button"
							>
								{TICKER_RANGE_LABELS[option]}
								{active ? (
									<span
										aria-hidden="true"
										className={cn(
											"absolute inset-x-2 -bottom-px h-0.5",
											DOT_FILL[direction]
										)}
									/>
								) : null}
							</button>
						);
					})}
				</div>
			</div>
		</section>
	);
}
