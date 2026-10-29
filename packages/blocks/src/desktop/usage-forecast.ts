/**
 * Trend forecasts for usage charts.
 *
 * A least-squares linear trend fitted to the most recent completed buckets,
 * with an 80% prediction range from the fit's residuals — the same "forecast
 * plus range" reading as cloud cost explorers. Four weeks of daily buckets
 * spans whole weekday/weekend cycles, so the trend is not skewed by where in
 * the week it is read. Inputs are plain series so every usage surface can
 * share it.
 */

/** Two-sided 80% prediction range, z for the 90th percentile. */
const PREDICTION_Z = 1.2816;
const DEFAULT_FIT_WINDOW = 28;
const MIN_FIT_SAMPLES = 4;
const MIN_ACTIVE_SAMPLES = 2;
const FLAT_CHANGE_PERCENT = 5;

export interface UsageForecastPoint {
	lower: number;
	upper: number;
	value: number;
}

export type UsageForecastDirection = "up" | "down" | "flat";

export interface UsageForecast {
	/** Projected mean per bucket compared with the trailing actual mean. */
	changePercent: number | null;
	direction: UsageForecastDirection;
	/** Number of trailing buckets the trend was fitted on. */
	fittedSamples: number;
	points: UsageForecastPoint[];
	total: UsageForecastPoint;
}

export interface UsageForecastOptions {
	/** Most recent buckets considered. Older history adds lag, not signal. */
	fitWindow?: number;
}

function finiteNonNegative(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function mean(values: readonly number[]): number {
	return values.length === 0
		? 0
		: values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Forecast `horizon` future buckets from a series of completed buckets.
 * Returns `null` when there is too little recent activity to project honestly.
 */
export function forecastUsageSeries(
	series: readonly number[],
	horizon: number,
	{ fitWindow = DEFAULT_FIT_WINDOW }: UsageForecastOptions = {}
): UsageForecast | null {
	const steps = Math.max(0, Math.floor(horizon));
	const values = series.slice(-Math.max(1, fitWindow)).map(finiteNonNegative);
	const count = values.length;
	const activeSamples = values.filter((value) => value > 0).length;
	if (
		steps === 0 ||
		count < MIN_FIT_SAMPLES ||
		activeSamples < MIN_ACTIVE_SAMPLES
	) {
		return null;
	}

	const meanX = (count - 1) / 2;
	const meanY = mean(values);
	let sumXX = 0;
	let sumXY = 0;
	for (const [index, value] of values.entries()) {
		sumXX += (index - meanX) ** 2;
		sumXY += (index - meanX) * (value - meanY);
	}
	const slope = sumXY / sumXX;
	const intercept = meanY - slope * meanX;
	let squaredResiduals = 0;
	for (const [index, value] of values.entries()) {
		squaredResiduals += (value - (intercept + slope * index)) ** 2;
	}
	const residualError = Math.sqrt(squaredResiduals / (count - 2));

	const points: UsageForecastPoint[] = [];
	for (let step = 1; step <= steps; step += 1) {
		const x = count - 1 + step;
		const value = Math.max(0, intercept + slope * x);
		const spread =
			PREDICTION_Z *
			residualError *
			Math.sqrt(1 + 1 / count + (x - meanX) ** 2 / sumXX);
		points.push({
			lower: Math.max(0, value - spread),
			upper: Math.max(value, value + spread),
			value,
		});
	}

	const total = points.reduce<UsageForecastPoint>(
		(sum, point) => ({
			lower: sum.lower + point.lower,
			upper: sum.upper + point.upper,
			value: sum.value + point.value,
		}),
		{ lower: 0, upper: 0, value: 0 }
	);
	const trailingMean = mean(values.slice(-Math.min(steps, count)));
	const projectedMean = total.value / steps;
	const changePercent =
		trailingMean > 0
			? ((projectedMean - trailingMean) / trailingMean) * 100
			: null;
	let direction: UsageForecastDirection = "flat";
	if (
		changePercent !== null &&
		Math.abs(changePercent) >= FLAT_CHANGE_PERCENT
	) {
		direction = changePercent > 0 ? "up" : "down";
	}
	return {
		changePercent,
		direction,
		fittedSamples: count,
		points,
		total,
	};
}

/**
 * Straight-line projection of a month-to-date total to the end of its month,
 * the run-rate reading for cumulative counters without a bucketed series.
 * Returns `null` until a full hour of the period has elapsed.
 */
export function projectPeriodTotal(
	toDate: number,
	periodStart: number,
	periodEnd: number,
	now = Date.now()
): number | null {
	const elapsed = now - periodStart;
	const length = periodEnd - periodStart;
	if (
		!(Number.isFinite(toDate) && Number.isFinite(elapsed)) ||
		length <= 0 ||
		elapsed < 60 * 60 * 1000
	) {
		return null;
	}
	if (elapsed >= length) {
		return Math.max(0, toDate);
	}
	return Math.max(0, toDate) * (length / elapsed);
}

/** UTC bounds of the calendar month containing `now`, or of a `YYYY-MM` key. */
export function utcMonthBounds(
	month: string | null | undefined,
	now = Date.now()
): { end: number; start: number } {
	const match = /^(\d{4})-(\d{2})$/.exec(month ?? "");
	const reference = new Date(now);
	const year = match ? Number(match[1]) : reference.getUTCFullYear();
	const monthIndex = match ? Number(match[2]) - 1 : reference.getUTCMonth();
	return {
		end: Date.UTC(year, monthIndex + 1, 1),
		start: Date.UTC(year, monthIndex, 1),
	};
}

export function formatForecastChange(forecast: UsageForecast): string {
	if (forecast.changePercent === null) {
		return "No recent baseline";
	}
	if (forecast.direction === "flat") {
		return "Steady";
	}
	const rounded = Math.round(Math.abs(forecast.changePercent));
	return `${forecast.direction === "up" ? "↑" : "↓"} ${rounded}%`;
}
