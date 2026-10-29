import {
	USAGE_FORECAST_HORIZON_LABELS,
	type UsageAnalyticsData,
	type UsageBucket,
	type UsageProviderSeries,
	usageForecastTimeline,
} from "./usage-analytics.ts";
import { forecastUsageSeries, type UsageForecast } from "./usage-forecast.ts";

export type UsageTrendMetric = "requests" | "tokens" | "errors" | "spend";
export type UsageTrendView = "total" | "provider";

/** Above this many buckets the chart is compacted and not forecast. */
const MAX_CHART_POINTS = 1000;

export type UsageTrendChartValue = string | number | null | [number, number];
export type UsageTrendChartRow = Record<string, UsageTrendChartValue>;

export interface UsageTrendSeriesModel {
	actualKey: string;
	/** Sum of known actual values in the selected range; null when none known. */
	actualTotal: number | null;
	forecast: UsageForecast | null;
	forecastKey: string;
	key: string;
	label: string;
}

export type UsageTrendForecastGap =
	| "disabled"
	| "insufficient-data"
	| "range-ended"
	| "too-detailed";

export interface UsageTrendChartModel {
	/** Row key holding the total view's `[lower, upper]` forecast range. */
	bandKey: string;
	forecastGap: UsageTrendForecastGap | null;
	horizonLabel: string;
	/** Provider view was requested but this host reports only totals. */
	providerFallback: boolean;
	rows: UsageTrendChartRow[];
	series: UsageTrendSeriesModel[];
	view: UsageTrendView;
}

interface SeriesInput {
	key: string;
	label: string;
	values: (number | null)[];
}

function bucketValue(
	bucket: UsageBucket,
	metric: UsageTrendMetric
): number | null {
	switch (metric) {
		case "errors":
			return bucket.errors;
		case "requests":
			return bucket.requests;
		case "spend":
			return bucket.spendMicroUsd;
		case "tokens":
			return bucket.inputTokens + bucket.outputTokens;
	}
}

function providerValues(
	series: UsageProviderSeries,
	metric: UsageTrendMetric
): (number | null)[] {
	return metric === "spend" ? series.spendMicroUsd : series[metric];
}

function sumKnown(values: readonly (number | null)[]): number | null {
	let total: number | null = null;
	for (const value of values) {
		if (value !== null) {
			total = (total ?? 0) + value;
		}
	}
	return total;
}

function compactRows(
	labels: string[],
	inputs: SeriesInput[],
	keys: string[]
): UsageTrendChartRow[] {
	const groupSize = Math.ceil(labels.length / MAX_CHART_POINTS);
	const rows: UsageTrendChartRow[] = [];
	for (let start = 0; start < labels.length; start += groupSize) {
		const end = Math.min(labels.length, start + groupSize);
		const first = labels[start] ?? "";
		const last = labels[end - 1] ?? first;
		const row: UsageTrendChartRow = {
			label: start === end - 1 ? first : `${first} – ${last}`,
		};
		inputs.forEach((input, index) => {
			row[keys[index] ?? input.key] = sumKnown(input.values.slice(start, end));
		});
		rows.push(row);
	}
	return rows;
}

/**
 * Chart rows for "Activity over time": actual values for each series, plus a
 * dashed forecast that starts at the last completed bucket and an 80% range
 * for the total view.
 */
export function buildUsageTrendChart({
	data,
	forecast,
	metric,
	metricLabel,
	now = Date.now(),
	view,
}: {
	data: UsageAnalyticsData;
	forecast: boolean;
	metric: UsageTrendMetric;
	metricLabel: string;
	now?: number;
	view: UsageTrendView;
}): UsageTrendChartModel {
	const providerSeries = data.providerSeries ?? [];
	const providerFallback = view === "provider" && providerSeries.length === 0;
	const effectiveView: UsageTrendView = providerFallback ? "total" : view;
	const inputs: SeriesInput[] =
		effectiveView === "provider"
			? providerSeries.map((series) => ({
					key: series.key,
					label: series.label,
					values: providerValues(series, metric),
				}))
			: [
					{
						key: "total",
						label: metricLabel,
						values: data.buckets.map((bucket) => bucketValue(bucket, metric)),
					},
				];
	const keys = inputs.map((_, index) =>
		effectiveView === "provider" ? `series${index}` : "actual"
	);
	const horizonLabel = USAGE_FORECAST_HORIZON_LABELS[data.granularity];
	const base = {
		bandKey: "band",
		horizonLabel,
		providerFallback,
		view: effectiveView,
	};
	const seriesWithoutForecast = inputs.map((input, index) => ({
		actualKey: keys[index] ?? input.key,
		actualTotal: sumKnown(input.values),
		forecast: null,
		forecastKey: `${keys[index] ?? input.key}Forecast`,
		key: input.key,
		label: input.label,
	}));

	if (data.buckets.length > MAX_CHART_POINTS) {
		return {
			...base,
			forecastGap: forecast ? "too-detailed" : "disabled",
			rows: compactRows(
				data.buckets.map((bucket) => bucket.label),
				inputs,
				keys
			),
			series: seriesWithoutForecast,
		};
	}

	const timeline = usageForecastTimeline(data.buckets, data.granularity, now);
	const rows: UsageTrendChartRow[] = data.buckets.map((bucket, bucketIndex) => {
		const row: UsageTrendChartRow = { label: bucket.label };
		const future = timeline !== null && Date.parse(bucket.start) > now;
		inputs.forEach((input, index) => {
			row[keys[index] ?? input.key] = future
				? null
				: (input.values[bucketIndex] ?? null);
		});
		return row;
	});

	if (!forecast) {
		return {
			...base,
			forecastGap: "disabled",
			rows,
			series: seriesWithoutForecast,
		};
	}
	if (!timeline) {
		return {
			...base,
			forecastGap: "range-ended",
			rows,
			series: seriesWithoutForecast,
		};
	}

	const series: UsageTrendSeriesModel[] = seriesWithoutForecast.map(
		(model, index) => ({
			...model,
			forecast: forecastUsageSeries(
				(inputs[index]?.values ?? [])
					.slice(0, timeline.fitCount)
					.map((value) => value ?? 0),
				timeline.slots.length
			),
		})
	);
	if (series.every((model) => model.forecast === null)) {
		return { ...base, forecastGap: "insufficient-data", rows, series };
	}

	const bridge = timeline.fitCount > 0 ? rows[timeline.fitCount - 1] : null;
	timeline.slots.forEach((slot, slotIndex) => {
		let row = slot.bucketIndex === null ? undefined : rows[slot.bucketIndex];
		if (!row) {
			row = { label: slot.label };
			for (const model of series) {
				row[model.actualKey] = null;
			}
			rows.push(row);
		}
		for (const model of series) {
			const point = model.forecast?.points[slotIndex];
			if (!point) {
				continue;
			}
			row[model.forecastKey] = point.value;
			if (effectiveView === "total") {
				row[base.bandKey] = [point.lower, point.upper];
			}
		}
	});
	if (bridge) {
		for (const model of series) {
			const actual = bridge[model.actualKey];
			if (model.forecast && typeof actual === "number") {
				bridge[model.forecastKey] = actual;
				if (effectiveView === "total") {
					bridge[base.bandKey] = [actual, actual];
				}
			}
		}
	}
	return { ...base, forecastGap: null, rows, series };
}
