"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@ryu/ui/components/chart";
import { Switch } from "@ryu/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@ryu/ui/components/toggle-group";
import { useId, useMemo, useState } from "react";
import {
	Area,
	CartesianGrid,
	ComposedChart,
	Line,
	XAxis,
	YAxis,
} from "recharts";
import { SettingsCard, SettingsSection } from "./settings-items.tsx";
import {
	GRANULARITY_LABELS,
	type UsageAnalyticsData,
} from "./usage-analytics.ts";
import {
	FORECAST_COLOR,
	ForecastSummary,
} from "./usage-analytics-dashboard-forecast.tsx";
import {
	CHART_COLORS,
	formatCompact,
	formatSpend,
	formatTrendValue,
	KPI_COLORS,
	MetricTile,
	TREND_METRICS,
	type TrendMetric,
	TrendTooltipRow,
	trendMetricTotal,
	UsageMarker,
} from "./usage-analytics-dashboard-shared.tsx";
import {
	buildUsageTrendChart,
	type UsageTrendView,
} from "./usage-trend-forecast.ts";

export function UsageTrend({ data }: { data: UsageAnalyticsData }) {
	const tl = useLiteralMessages();
	const [selectedMetric, setSelectedMetric] = useState<TrendMetric>("requests");
	const [view, setView] = useState<UsageTrendView>("total");
	const [showForecast, setShowForecast] = useState(true);
	const gradientId = `usage-trend-fill-${useId().replace(/:/g, "")}`;
	const metricDefinition =
		TREND_METRICS.find(({ key }) => key === selectedMetric) ?? TREND_METRICS[0];
	const model = useMemo(
		() =>
			buildUsageTrendChart({
				data,
				forecast: showForecast,
				metric: selectedMetric,
				metricLabel: metricDefinition.label,
				view,
			}),
		[data, metricDefinition.label, selectedMetric, showForecast, view]
	);
	const seriesColor = (index: number) =>
		model.view === "total"
			? metricDefinition.color
			: (CHART_COLORS[index % CHART_COLORS.length] ?? metricDefinition.color);
	const config: ChartConfig = {
		[model.bandKey]: { color: FORECAST_COLOR, label: "80% range" },
	};
	model.series.forEach((series, index) => {
		config[series.actualKey] = {
			color: seriesColor(index),
			label: series.label,
		};
		config[series.forecastKey] = {
			color: seriesColor(index),
			label: model.view === "total" ? "Forecast" : `${series.label} forecast`,
		};
	});
	const hasSelectedData = model.series.some(
		(series) => (series.actualTotal ?? 0) > 0
	);
	const selectedTotal = trendMetricTotal(data, selectedMetric);
	const metricTiles = [
		{
			color: KPI_COLORS.requests,
			key: "requests" as const,
			label: "Requests",
			value: formatCompact(data.totals.requests),
		},
		{
			color: KPI_COLORS.tokens,
			key: "tokens" as const,
			label: "Tokens",
			value: formatCompact(data.totals.inputTokens + data.totals.outputTokens),
		},
		{
			color: KPI_COLORS.errors,
			key: "errors" as const,
			label: "Errors",
			value: formatCompact(data.totals.errors),
		},
		{
			color: KPI_COLORS["credit spend"],
			key: "spend" as const,
			label: "Credit spend",
			value: formatSpend(data.totals.spendMicroUsd),
		},
	];
	const forecastSwitchId = useId();

	return (
		<div className="min-w-0" data-testid="usage-analytics-chart-trend">
			<SettingsSection
				caption={
					showForecast
						? tl(
								"{metric} at {resolution} resolution, with a trend forecast for the {horizon}.",
								{
									horizon: model.horizonLabel,
									metric: metricDefinition.label,
									resolution:
										GRANULARITY_LABELS[data.granularity].toLowerCase(),
								}
							)
						: tl("{metric} at {resolution} resolution.", {
								metric: metricDefinition.label,
								resolution: GRANULARITY_LABELS[data.granularity].toLowerCase(),
							})
				}
				headerAction={
					<span className="flex items-baseline gap-1.5 text-xs">
						<span
							className="font-medium text-foreground tabular-nums"
							data-testid="usage-trend-selected"
						>
							{selectedTotal === null
								? "Not billed"
								: formatTrendValue(selectedMetric, selectedTotal)}
						</span>
						<span className="text-muted-foreground">
							{tl("{metric} in range", {
								metric: metricDefinition.label.toLowerCase(),
							})}
						</span>
					</span>
				}
				title="Activity over time"
			>
				<SettingsCard className="flex flex-col gap-4">
					<div
						className="flex flex-wrap items-center gap-2"
						data-testid="usage-trend-metric"
					>
						<ToggleGroup
							appearance="segmented"
							aria-label="Usage trend metric"
							className="h-auto max-w-full flex-wrap"
							multiple={false}
							onValueChange={(values: string[]) => {
								const [value] = values;
								const metric = TREND_METRICS.find(({ key }) => key === value);
								if (metric) {
									setSelectedMetric(metric.key);
								}
							}}
							spacing={0}
							value={[selectedMetric]}
							variant="default"
						>
							{TREND_METRICS.map((metric) => (
								<ToggleGroupItem
									density="segmented"
									key={metric.key}
									value={metric.key}
								>
									<UsageMarker
										aria-hidden="true"
										backgroundColor={metric.color}
										className="mr-1.5 size-1.5 rounded-full"
									/>
									{metric.label}
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					</div>
					<div
						className="flex flex-wrap items-center justify-between gap-2"
						data-testid="usage-trend-forecast-controls"
					>
						<ToggleGroup
							appearance="segmented"
							aria-label="Usage trend grouping"
							multiple={false}
							onValueChange={(values: string[]) => {
								const [value] = values;
								if (value === "total" || value === "provider") {
									setView(value);
								}
							}}
							spacing={0}
							value={[view]}
							variant="default"
						>
							<ToggleGroupItem density="segmented" value="total">
								Total
							</ToggleGroupItem>
							<ToggleGroupItem density="segmented" value="provider">
								By provider
							</ToggleGroupItem>
						</ToggleGroup>
						<label
							className="flex items-center gap-2 text-muted-foreground text-xs"
							htmlFor={forecastSwitchId}
						>
							Forecast
							<Switch
								checked={showForecast}
								id={forecastSwitchId}
								onCheckedChange={setShowForecast}
							/>
						</label>
					</div>
					{model.providerFallback ? (
						<p className="text-muted-foreground text-xs">
							This scope reports totals only, so the chart shows the combined
							trend.
						</p>
					) : null}
					{hasSelectedData ? (
						<ChartContainer className="h-[280px] w-full" config={config}>
							<ComposedChart
								accessibilityLayer
								data={model.rows}
								margin={{ left: 4, right: 8, top: 8 }}
							>
								<defs>
									<linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
										<stop
											offset="5%"
											stopColor={metricDefinition.color}
											stopOpacity={0.35}
										/>
										<stop
											offset="95%"
											stopColor={metricDefinition.color}
											stopOpacity={0.02}
										/>
									</linearGradient>
								</defs>
								<CartesianGrid strokeOpacity={0.35} vertical={false} />
								<XAxis
									axisLine={false}
									dataKey="label"
									minTickGap={38}
									tickLine={false}
									tickMargin={8}
								/>
								<YAxis
									axisLine={false}
									tickFormatter={(value) =>
										formatTrendValue(selectedMetric, Number(value))
									}
									tickLine={false}
									width={36}
								/>
								<ChartTooltip
									content={
										<ChartTooltipContent
											formatter={(value, name) => {
												const key = String(name);
												const formatted = Array.isArray(value)
													? `${formatTrendValue(selectedMetric, Number(value[0]))} – ${formatTrendValue(selectedMetric, Number(value[1]))}`
													: formatTrendValue(selectedMetric, Number(value));
												return (
													<TrendTooltipRow
														color={config[key]?.color}
														label={String(config[key]?.label ?? key)}
														value={formatted}
													/>
												);
											}}
											indicator="line"
										/>
									}
									cursor={{
										stroke: "var(--border)",
										strokeDasharray: "4 4",
									}}
								/>
								{model.view === "total" && model.forecastGap === null ? (
									<Area
										activeDot={false}
										dataKey={model.bandKey}
										fill={FORECAST_COLOR}
										fillOpacity={0.12}
										isAnimationActive={false}
										stroke="none"
										type="monotone"
									/>
								) : null}
								{model.view === "total" ? (
									<Area
										connectNulls={selectedMetric === "spend"}
										dataKey={model.series[0]?.actualKey ?? "actual"}
										fill={`url(#${gradientId})`}
										fillOpacity={0.9}
										stroke={metricDefinition.color}
										strokeWidth={2}
										type="monotone"
									/>
								) : (
									model.series.map((series, index) => (
										<Line
											connectNulls={selectedMetric === "spend"}
											dataKey={series.actualKey}
											dot={false}
											isAnimationActive={false}
											key={series.actualKey}
											stroke={seriesColor(index)}
											strokeWidth={2}
											type="monotone"
										/>
									))
								)}
								{model.forecastGap === null
									? model.series.map((series, index) =>
											series.forecast ? (
												<Line
													dataKey={series.forecastKey}
													dot={false}
													isAnimationActive={false}
													key={series.forecastKey}
													stroke={seriesColor(index)}
													strokeDasharray="5 4"
													strokeOpacity={0.85}
													strokeWidth={2}
													type="monotone"
												/>
											) : null
										)
									: null}
							</ComposedChart>
						</ChartContainer>
					) : (
						<div className="flex h-[280px] items-center justify-center text-muted-foreground text-sm">
							{tl("No {metric} in this range.", {
								metric: metricDefinition.label.toLowerCase(),
							})}
						</div>
					)}
					{hasSelectedData ? (
						<ForecastSummary
							horizonLabel={model.horizonLabel}
							metric={selectedMetric}
							model={model}
						/>
					) : null}
					<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
						{metricTiles.map(({ key: metricKey, ...tile }) => (
							<MetricTile
								key={tile.label}
								selected={metricKey === selectedMetric}
								{...tile}
							/>
						))}
					</div>
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}
