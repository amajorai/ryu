import { activeLocale, relativeTimeFormatter } from "@ryu/i18n/lite";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";

/** The flow overview's 24-hour activity chart. */

const CHART_W = 320;
const CHART_H = 72;

/**
 * A monotone cubic (Fritsch-Carlson) through the points, so sparse hours read
 * as a smooth line that never overshoots below zero or above the peak.
 */
export function monotonePath(points: readonly [number, number][]): string {
	const count = points.length;
	const fmt = (value: number) => value.toFixed(1);
	const [firstX, firstY] = points[0] ?? [0, 0];
	if (count === 0) {
		return "";
	}
	let path = `M ${fmt(firstX)} ${fmt(firstY)}`;
	if (count === 1) {
		return path;
	}
	const slopes: number[] = [];
	for (let index = 0; index < count - 1; index += 1) {
		const [x0, y0] = points[index] ?? [0, 0];
		const [x1, y1] = points[index + 1] ?? [0, 0];
		slopes.push((y1 - y0) / (x1 - x0 || 1));
	}
	const tangents: number[] = [];
	for (let index = 0; index < count; index += 1) {
		const before = slopes[index - 1];
		const after = slopes[index];
		if (before === undefined || after === undefined) {
			tangents.push(before ?? after ?? 0);
		} else if (before * after <= 0) {
			tangents.push(0);
		} else {
			tangents.push((2 * before * after) / (before + after));
		}
	}
	for (let index = 0; index < count - 1; index += 1) {
		const [x0, y0] = points[index] ?? [0, 0];
		const [x1, y1] = points[index + 1] ?? [0, 0];
		const third = (x1 - x0) / 3;
		const t0 = tangents[index] ?? 0;
		const t1 = tangents[index + 1] ?? 0;
		path += ` C ${fmt(x0 + third)} ${fmt(y0 + t0 * third)} ${fmt(x1 - third)} ${fmt(y1 - t1 * third)} ${fmt(x1)} ${fmt(y1)}`;
	}
	return path;
}

function peakSummary(tl: LiteralMessage, buckets: number[], peak: number) {
	const total = buckets.reduce((sum, value) => sum + value, 0);
	if (total === 0) {
		return "No activity in the last 24 hours";
	}
	const hoursAgo = buckets.length - 1 - buckets.indexOf(peak);
	return tl(
		"{total, plural, one {{total} update} other {{total} updates}} in the last 24 hours, peak {peak} {hoursAgo, plural, =0 {in the last hour} one {# hour ago} other {# hours ago}}",
		{ hoursAgo, peak, total }
	);
}

/** Per-hour activity as a smooth area, oldest hour on the left. */
export function ActivityChart({ buckets }: { buckets: number[] }) {
	const peak = Math.max(1, ...buckets);
	const step = CHART_W / Math.max(1, buckets.length - 1);
	const top = 8;
	const yFor = (value: number) => CHART_H - (value / peak) * (CHART_H - top);
	const points = buckets.map((value, index): [number, number] => [
		index * step,
		yFor(value),
	]);
	const line = monotonePath(points);
	const area = `${line} L ${CHART_W} ${CHART_H} L 0 ${CHART_H} Z`;
	const active = buckets.some((value) => value > 0);
	const tl = useLiteralMessages();
	const summary = peakSummary(tl, buckets, peak);
	return (
		<figure className="flex flex-col gap-1.5">
			<div className="relative" title={summary}>
				<svg
					aria-label={summary}
					className="h-18 w-full overflow-visible"
					preserveAspectRatio="none"
					role="img"
					viewBox={`0 0 ${CHART_W} ${CHART_H}`}
				>
					<line
						className="stroke-border"
						strokeDasharray="2 3"
						vectorEffect="non-scaling-stroke"
						x1="0"
						x2={CHART_W}
						y1={top}
						y2={top}
					/>
					{active ? (
						<>
							<path className="fill-primary/15" d={area} />
							<path
								className="stroke-primary"
								d={line}
								fill="none"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth="1.5"
								vectorEffect="non-scaling-stroke"
							/>
						</>
					) : null}
					<line
						className="stroke-border"
						vectorEffect="non-scaling-stroke"
						x1="0"
						x2={CHART_W}
						y1={CHART_H}
						y2={CHART_H}
					/>
				</svg>
				{active ? (
					// The y max sits on its own gridline, inside the plot's top-left.
					<span
						aria-hidden="true"
						className="absolute top-0 left-0 bg-background pe-1 text-[13px] text-muted-foreground tabular-nums leading-4"
					>
						{peak}
					</span>
				) : (
					<span className="absolute inset-x-0 bottom-3 text-center text-[13px] text-muted-foreground">
						No activity in the last 24 hours
					</span>
				)}
			</div>
			<figcaption className="flex justify-between text-[13px] text-muted-foreground tabular-nums">
				<span>
					{relativeTimeFormatter(activeLocale(), "narrow").format(-24, "hour")}
				</span>
				<span>
					{relativeTimeFormatter(activeLocale(), "narrow").format(-12, "hour")}
				</span>
				<span>Now</span>
			</figcaption>
		</figure>
	);
}
