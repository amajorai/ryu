import type { LiteralMessage } from "@ryu/i18n/react";
import type { UsageGranularity } from "./usage-analytics-types.ts";
import type { UsageTrendMetric } from "./usage-trend-forecast.ts";

// "Activity over time" copy as whole literal messages. Every `tl()` call here
// names its English source literally, so the extractor collects each key and
// translators see the metric, the resolution and the horizon in context
// instead of English labels spliced into a translated frame.

/** The translated name of a trend metric ("Requests", "Credit spend", …). */
export function trendMetricLabel(
	metric: UsageTrendMetric,
	tl: LiteralMessage
): string {
	switch (metric) {
		case "requests":
			return tl("Requests");
		case "tokens":
			return tl("Tokens");
		case "errors":
			return tl("Errors");
		case "spend":
			return tl("Credit spend");
		default:
			return metric satisfies never;
	}
}

/**
 * The translated forecast horizon for a resolution ("next 24 hours", …). The
 * English sources match `USAGE_FORECAST_HORIZON_LABELS`.
 */
export function trendHorizonLabel(
	granularity: UsageGranularity,
	tl: LiteralMessage
): string {
	switch (granularity) {
		case "15m":
			return tl("next 4 hours");
		case "hourly":
			return tl("next 24 hours");
		case "daily":
			return tl("next 14 days");
		case "weekly":
			return tl("next 4 weeks");
		case "monthly":
			return tl("next 3 months");
		default:
			return granularity satisfies never;
	}
}

function captionWithForecast(
	granularity: UsageGranularity,
	metric: string,
	tl: LiteralMessage
): string {
	switch (granularity) {
		case "15m":
			return tl(
				"{metric} at 15 min resolution, with a trend forecast for the next 4 hours.",
				{ metric }
			);
		case "hourly":
			return tl(
				"{metric} at hourly resolution, with a trend forecast for the next 24 hours.",
				{ metric }
			);
		case "daily":
			return tl(
				"{metric} at daily resolution, with a trend forecast for the next 14 days.",
				{ metric }
			);
		case "weekly":
			return tl(
				"{metric} at weekly resolution, with a trend forecast for the next 4 weeks.",
				{ metric }
			);
		case "monthly":
			return tl(
				"{metric} at monthly resolution, with a trend forecast for the next 3 months.",
				{ metric }
			);
		default:
			return granularity satisfies never;
	}
}

function captionWithoutForecast(
	granularity: UsageGranularity,
	metric: string,
	tl: LiteralMessage
): string {
	switch (granularity) {
		case "15m":
			return tl("{metric} at 15 min resolution.", { metric });
		case "hourly":
			return tl("{metric} at hourly resolution.", { metric });
		case "daily":
			return tl("{metric} at daily resolution.", { metric });
		case "weekly":
			return tl("{metric} at weekly resolution.", { metric });
		case "monthly":
			return tl("{metric} at monthly resolution.", { metric });
		default:
			return granularity satisfies never;
	}
}

/**
 * The trend chart caption: one whole message per resolution, so translators
 * choose the resolution's grammatical form. It names the forecast horizon
 * only when the chart draws a forecast.
 */
export function usageTrendCaption(
	{
		forecast,
		granularity,
		metric,
	}: {
		forecast: boolean;
		granularity: UsageGranularity;
		metric: UsageTrendMetric;
	},
	tl: LiteralMessage
): string {
	const metricLabel = trendMetricLabel(metric, tl);
	return forecast
		? captionWithForecast(granularity, metricLabel, tl)
		: captionWithoutForecast(granularity, metricLabel, tl);
}
