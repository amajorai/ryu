"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	CHART_COLORS,
	formatTrendValue,
	type TrendMetric,
	UsageMarker,
} from "./usage-analytics-dashboard-shared.tsx";
import type { UsageForecast } from "./usage-forecast.ts";
import { formatForecastChange } from "./usage-forecast.ts";
import type {
	UsageTrendChartModel,
	UsageTrendForecastGap,
} from "./usage-trend-forecast.ts";

export const FORECAST_COLOR = "var(--muted-foreground)";

export const FORECAST_GAP_MESSAGES = {
	disabled: "",
	"insufficient-data": "Not enough recent activity to project a trend yet.",
	"range-ended": "Forecasts appear when the selected range includes now.",
	"too-detailed": "Choose a coarser resolution to see a forecast.",
} satisfies Record<UsageTrendForecastGap, string>;

export function forecastTone(forecast: UsageForecast): string {
	if (forecast.direction === "up") {
		return "text-status-warning";
	}
	if (forecast.direction === "down") {
		return "text-status-success";
	}
	return "text-muted-foreground";
}

export function ForecastSummary({
	horizonLabel,
	metric,
	model,
}: {
	horizonLabel: string;
	metric: TrendMetric;
	model: UsageTrendChartModel;
}) {
	const tl = useLiteralMessages();
	if (model.forecastGap === "disabled") {
		return null;
	}
	if (model.forecastGap !== null) {
		return (
			<p
				className="text-muted-foreground text-xs"
				data-testid="usage-trend-forecast-gap"
			>
				{FORECAST_GAP_MESSAGES[model.forecastGap]}
			</p>
		);
	}
	if (model.view === "total") {
		const forecast = model.series[0]?.forecast;
		if (!forecast) {
			return null;
		}
		return (
			<div
				className="flex flex-wrap items-center justify-between gap-3 border-border/50 border-t pt-3"
				data-testid="usage-trend-forecast"
			>
				<div className="flex min-w-0 flex-col gap-0.5">
					<span className="text-muted-foreground text-xs">
						{tl("Forecast · {horizonLabel}", { horizonLabel })}
					</span>
					<span className="font-medium text-sm tabular-nums">
						{formatTrendValue(metric, forecast.total.value)}
					</span>
				</div>
				<div className="flex min-w-0 flex-col gap-0.5 text-right">
					<span className="text-muted-foreground text-xs">80% range</span>
					<span className="text-sm tabular-nums">
						{formatTrendValue(metric, forecast.total.lower)} –{" "}
						{formatTrendValue(metric, forecast.total.upper)}
					</span>
				</div>
				<div className="flex min-w-0 flex-col gap-0.5 text-right">
					<span className="text-muted-foreground text-xs">Trend</span>
					<span className={`text-sm tabular-nums ${forecastTone(forecast)}`}>
						{formatForecastChange(forecast)}
					</span>
				</div>
			</div>
		);
	}
	return (
		<div className="overflow-x-auto" data-testid="usage-trend-forecast">
			<table className="w-full text-left text-xs">
				<caption className="sr-only">
					{tl("Forecast by provider for the {horizonLabel}", { horizonLabel })}
				</caption>
				<thead className="border-border/50 border-b text-muted-foreground">
					<tr>
						<th className="py-2 font-normal">Provider</th>
						<th className="px-3 text-right font-normal">In range</th>
						<th className="px-3 text-right font-normal">
							{tl("Forecast · {horizonLabel}", { horizonLabel })}
						</th>
						<th className="py-2 text-right font-normal">Trend</th>
					</tr>
				</thead>
				<tbody>
					{model.series.map((series, index) => (
						<tr
							className="border-border/30 border-b last:border-0"
							key={series.key}
						>
							<td className="py-2">
								<span className="flex min-w-0 items-center gap-2">
									<UsageMarker
										aria-hidden="true"
										backgroundColor={CHART_COLORS[index % CHART_COLORS.length]}
										className="size-2 shrink-0 rounded-full"
									/>
									<span className="truncate">{series.label}</span>
								</span>
							</td>
							<td className="px-3 text-right tabular-nums">
								{series.actualTotal === null
									? "—"
									: formatTrendValue(metric, series.actualTotal)}
							</td>
							<td className="px-3 text-right tabular-nums">
								{series.forecast ? (
									<span
										title={tl("80% range {lower} – {upper}", {
											lower: formatTrendValue(
												metric,
												series.forecast.total.lower
											),
											upper: formatTrendValue(
												metric,
												series.forecast.total.upper
											),
										})}
									>
										{formatTrendValue(metric, series.forecast.total.value)}
									</span>
								) : (
									<span className="text-muted-foreground">Too little data</span>
								)}
							</td>
							<td
								className={`py-2 text-right tabular-nums ${series.forecast ? forecastTone(series.forecast) : "text-muted-foreground"}`}
							>
								{series.forecast ? formatForecastChange(series.forecast) : "—"}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
