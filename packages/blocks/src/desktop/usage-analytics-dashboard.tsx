"use client";

import { Calendar03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedText } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { Calendar, useDisplayToday } from "@ryu/ui/components/calendar";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@ryu/ui/components/chart";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@ryu/ui/components/toggle-group";
import { formatCount, formatMicroUsd } from "@ryu/ui/lib/number-format.ts";
import { formatDate } from "@ryu/ui/lib/timezone.ts";
import {
	type ComponentProps,
	type CSSProperties,
	type ReactNode,
	useId,
	useMemo,
	useState,
} from "react";
import {
	Area,
	Bar,
	CartesianGrid,
	ComposedChart,
	Line,
	Pie,
	PieChart,
	XAxis,
	YAxis,
} from "recharts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./settings-items.tsx";
import {
	cacheReuseRatio,
	GRANULARITY_LABELS,
	isLabelledPurposeKey,
	PLUGIN_PURPOSE_LABEL,
	pluginIdForPurpose,
	type UsageAnalyticsData,
	type UsageBreakdownRow,
	type UsageDateRange,
	type UsageGranularity,
	type UsageScope,
	usageCacheSeries,
	usageProviderLabel,
} from "./usage-analytics.ts";
import styles from "./usage-analytics-dashboard.module.css";
import { formatForecastChange, type UsageForecast } from "./usage-forecast.ts";
import {
	usagePresetRange,
	usageRangeDays,
	usageRangeFromDays,
} from "./usage-range-days.ts";
import {
	buildUsageTrendChart,
	type UsageTrendChartModel,
	type UsageTrendForecastGap,
	type UsageTrendMetric,
	type UsageTrendView,
} from "./usage-trend-forecast.ts";

const SCOPE_LABELS = {
	node: "This node",
	organization: "Organization",
	you: "You",
} satisfies Record<UsageScope, string>;

const SCOPE_VALUES: UsageScope[] = ["you", "organization", "node"];
const GRANULARITY_VALUES: UsageGranularity[] = [
	"15m",
	"hourly",
	"daily",
	"weekly",
	"monthly",
];

const CHART_COLORS = [
	"#0099ff",
	"oklch(0.62 0.19 306)",
	"oklch(0.68 0.16 164)",
	"oklch(0.76 0.16 76)",
	"oklch(0.68 0.18 24)",
	"oklch(0.65 0.16 200)",
] as const;

const KPI_COLORS = {
	"active days": "oklch(0.68 0.16 164)",
	"active members": "oklch(0.68 0.16 164)",
	"active nodes": "oklch(0.65 0.16 200)",
	"avg latency": "oklch(0.76 0.16 76)",
	"credit spend": "oklch(0.76 0.16 76)",
	errors: "oklch(0.68 0.18 24)",
	requests: "#0099ff",
	tokens: "oklch(0.62 0.19 306)",
} as const;

type TrendMetric = UsageTrendMetric;

interface UsageTrendMetricDefinition {
	color: string;
	key: TrendMetric;
	label: string;
}
const TREND_METRICS = [
	{ color: KPI_COLORS.requests, key: "requests", label: "Requests" },
	{ color: KPI_COLORS.tokens, key: "tokens", label: "Tokens" },
	{ color: KPI_COLORS.errors, key: "errors", label: "Errors" },
	{ color: KPI_COLORS["credit spend"], key: "spend", label: "Credit spend" },
] as const satisfies readonly UsageTrendMetricDefinition[];

interface UsageMarkerStyle extends CSSProperties {
	"--usage-marker-background": string | undefined;
	"--usage-marker-foreground": string | undefined;
	"--usage-marker-opacity": number | undefined;
	"--usage-marker-width": string | undefined;
}
interface UsageMarkerProps
	extends Omit<ComponentProps<"span">, "style" | "color" | "ref"> {
	backgroundColor?: string;
	color?: string;
	element?: "span" | "div";
	opacity?: number;
	width?: string;
}
function UsageMarker({
	backgroundColor,
	color,
	element: Element = "span",
	opacity,
	width,
	className,
	...props
}: UsageMarkerProps) {
	const markerStyle: UsageMarkerStyle = {
		"--usage-marker-background": backgroundColor,
		"--usage-marker-foreground": color,
		"--usage-marker-width": width,
		"--usage-marker-opacity": opacity,
	};
	return (
		<Element
			{...props}
			className={[
				className,
				backgroundColor !== undefined && styles.background,
				color !== undefined && styles.foreground,
				opacity !== undefined && styles.intensity,
				width !== undefined && styles.width,
			]
				.filter(Boolean)
				.join(" ")}
			style={markerStyle}
		/>
	);
}

const RANGE_LABEL_FORMAT = {
	day: "numeric",
	month: "short",
	year: "numeric",
} as const satisfies Intl.DateTimeFormatOptions;

/** The range's first and last day, named in the display zone and language. */
function dateRangeLabel(range: UsageDateRange): string {
	const lastDay = new Date(range.to.getTime() - 1);
	return `${formatDate(range.from, RANGE_LABEL_FORMAT)} – ${formatDate(lastDay, RANGE_LABEL_FORMAT)}`;
}

function formatCompact(value: number): string {
	return formatCount(value) ?? "—";
}

function formatMilliseconds(value: number | null): string {
	return value === null ? "—" : `${formatCompact(value)} ms`;
}

function formatSpend(value: number | null): string {
	return value === null ? "Not billed" : formatMicroUsd(value);
}

function trendMetricTotal(
	data: UsageAnalyticsData,
	metric: TrendMetric
): number | null {
	switch (metric) {
		case "errors":
			return data.totals.errors;
		case "requests":
			return data.totals.requests;
		case "spend":
			return data.totals.spendMicroUsd;
		case "tokens":
			return data.totals.inputTokens + data.totals.outputTokens;
	}
}

function formatTrendValue(metric: TrendMetric, value: number): string {
	// Forecasts are fractional; counts read as whole requests, tokens, errors.
	return metric === "spend"
		? formatMicroUsd(value)
		: formatCompact(Math.round(value));
}

function formatBreakdownValue(entry: UsageBreakdownRow): string {
	const requests = `${formatCompact(entry.requests)} req`;
	return entry.spendMicroUsd === null
		? requests
		: `${formatMicroUsd(entry.spendMicroUsd)} · ${requests}`;
}

function KpiCard({
	color,
	label,
	value,
	detail,
}: {
	color?: string;
	detail?: string;
	label: string;
	value: string;
}) {
	// A flat tile: the KPI row shares one settings card instead of a card each.
	return (
		<div
			className="flex min-w-0 flex-col gap-1"
			data-testid={`usage-kpi-${label.toLowerCase().replaceAll(" ", "-")}`}
		>
			<span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
				<UsageMarker
					aria-hidden="true"
					backgroundColor={color}
					className="size-2 shrink-0 rounded-full"
				/>
				<span className="truncate">{label}</span>
			</span>
			<span className="truncate font-medium text-xl tabular-nums">{value}</span>
			{detail ? (
				<span className="text-muted-foreground text-xs">{detail}</span>
			) : null}
		</div>
	);
}

function MetricTile({
	color,
	label,
	selected = false,
	value,
}: {
	color: string;
	label: string;
	selected?: boolean;
	value: string;
}) {
	return (
		<div
			className={`flex min-w-0 flex-col gap-1 transition-opacity ${selected ? "" : "opacity-60"}`}
		>
			<div className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
				<UsageMarker
					aria-hidden="true"
					backgroundColor={color}
					className="size-2 shrink-0 rounded-full"
				/>
				<span className="truncate">{label}</span>
			</div>
			<span className="truncate font-medium text-sm tabular-nums">{value}</span>
		</div>
	);
}

const FORECAST_COLOR = "var(--muted-foreground)";

const FORECAST_GAP_MESSAGES = {
	disabled: "",
	"insufficient-data": "Not enough recent activity to project a trend yet.",
	"range-ended": "Forecasts appear when the selected range includes now.",
	"too-detailed": "Choose a coarser resolution to see a forecast.",
} satisfies Record<UsageTrendForecastGap, string>;

function forecastTone(forecast: UsageForecast): string {
	if (forecast.direction === "up") {
		return "text-status-warning";
	}
	if (forecast.direction === "down") {
		return "text-status-success";
	}
	return "text-muted-foreground";
}

function TrendTooltipRow({
	color,
	label,
	value,
}: {
	color?: string;
	label: string;
	value: string;
}) {
	return (
		<div className="flex w-full items-center justify-between gap-3">
			<span className="flex items-center gap-1.5 text-muted-foreground">
				<UsageMarker
					aria-hidden="true"
					backgroundColor={color}
					className="size-2 shrink-0 rounded-[2px]"
				/>
				{label}
			</span>
			<span className="font-medium font-mono text-foreground tabular-nums">
				{value}
			</span>
		</div>
	);
}

function ForecastSummary({
	horizonLabel,
	metric,
	model,
}: {
	horizonLabel: string;
	metric: TrendMetric;
	model: UsageTrendChartModel;
}) {
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
						Forecast · {horizonLabel}
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
					Forecast by provider for the {horizonLabel}
				</caption>
				<thead className="border-border/50 border-b text-muted-foreground">
					<tr>
						<th className="py-2 font-normal">Provider</th>
						<th className="px-3 text-right font-normal">In range</th>
						<th className="px-3 text-right font-normal">
							Forecast · {horizonLabel}
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
										title={`80% range ${formatTrendValue(metric, series.forecast.total.lower)} – ${formatTrendValue(metric, series.forecast.total.upper)}`}
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

function UsageTrend({ data }: { data: UsageAnalyticsData }) {
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
				caption={`${metricDefinition.label} at ${GRANULARITY_LABELS[
					data.granularity
				].toLowerCase()} resolution${
					showForecast
						? `, with a trend forecast for the ${model.horizonLabel}.`
						: "."
				}`}
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
							{metricDefinition.label.toLowerCase()} in range
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
							No {metricDefinition.label.toLowerCase()} in this range.
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

function UsageDonut({
	data,
	title,
	description,
	testId,
}: {
	data: UsageBreakdownRow[];
	description: string;
	testId: string;
	title: string;
}) {
	const shown = data
		.filter(
			(entry) =>
				entry.requests > 0 ||
				(entry.spendMicroUsd !== null && entry.spendMicroUsd > 0)
		)
		.slice(0, 6);
	const chartData = shown.map((entry, index) => ({
		...entry,
		color: CHART_COLORS[index % CHART_COLORS.length],
		colorKey: `item${index}`,
		fill: `var(--color-item${index})`,
		chartValue:
			entry.requests > 0 ? entry.requests : (entry.spendMicroUsd ?? 0),
	}));
	const total = shown.reduce((sum, entry) => sum + entry.requests, 0);
	const totalSpend = shown.reduce(
		(sum, entry) => sum + (entry.spendMicroUsd ?? 0),
		0
	);
	const config: ChartConfig = Object.fromEntries(
		chartData.map((entry, index) => [
			`item${index}`,
			{ color: entry.color, label: entry.label },
		])
	);

	return (
		<div className="min-w-0" data-testid={`usage-analytics-${testId}`}>
			<SettingsSection caption={description} title={title}>
				<SettingsCard>
					{chartData.length > 0 ? (
						<div className="flex flex-col gap-4 sm:flex-row sm:items-center">
							<div className="relative mx-auto h-[180px] w-[180px] shrink-0">
								<ChartContainer className="h-full w-full" config={config}>
									<PieChart accessibilityLayer>
										<ChartTooltip content={<ChartTooltipContent hideLabel />} />
										<Pie
											data={chartData}
											dataKey="chartValue"
											innerRadius={54}
											nameKey="label"
											outerRadius={78}
											paddingAngle={3}
											strokeWidth={0}
										/>
									</PieChart>
								</ChartContainer>
								<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
									<span className="font-medium text-xl tabular-nums">
										{total > 0
											? formatCompact(total)
											: formatMicroUsd(totalSpend)}
									</span>
									<span className="type-caption text-muted-foreground">
										{total > 0 ? "requests" : "credit spend"}
									</span>
								</div>
							</div>
							<div className="flex min-w-0 flex-1 flex-col gap-2" role="list">
								{chartData.map((entry) => (
									<div
										className="flex items-center justify-between gap-3 py-1 text-xs"
										key={entry.key}
										role="listitem"
									>
										<span className="flex min-w-0 items-center gap-2">
											<UsageMarker
												aria-hidden="true"
												backgroundColor={entry.color}
												className="size-2 shrink-0 rounded-full"
											/>
											<span className="truncate" title={entry.label}>
												{entry.label}
											</span>
										</span>
										<span className="shrink-0 text-right text-muted-foreground tabular-nums">
											{formatBreakdownValue(entry)}
										</span>
									</div>
								))}
							</div>
						</div>
					) : (
						<div className="flex h-[180px] items-center justify-center text-muted-foreground text-sm">
							No breakdown yet.
						</div>
					)}
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}

function ActivityHeatmap({ data }: { data: UsageAnalyticsData }) {
	const points = data.buckets.slice(-56);
	const max = points.reduce(
		(highest, point) => Math.max(highest, point.requests),
		0
	);
	const leadingEmpty = (7 - (points.length % 7)) % 7;
	const cells: Array<UsageAnalyticsData["buckets"][number] | null> = [
		...Array.from({ length: leadingEmpty }, () => null),
		...points,
	];
	const axisLabels = points.slice(-7);
	const peak = points.reduce(
		(highest, point) => Math.max(highest, point.requests),
		0
	);
	return (
		<div className="min-w-0" data-testid="usage-analytics-chart-heatmap">
			<SettingsSection
				caption="Quickly spot quiet periods and sustained usage."
				headerAction={
					<span className="flex items-baseline gap-1.5 text-xs">
						<span className="font-medium text-foreground tabular-nums">
							{peak}
						</span>
						<span className="text-muted-foreground">peak requests</span>
					</span>
				}
				title="Activity rhythm"
			>
				<SettingsCard className="flex flex-col gap-3">
					<div className="type-caption flex items-center justify-end gap-2 text-muted-foreground">
						<span>Less</span>
						{[0.08, 0.3, 0.55, 0.8, 1].map((opacity) => (
							<UsageMarker
								aria-hidden="true"
								className="size-3 rounded-sm bg-primary"
								key={opacity}
								opacity={opacity}
							/>
						))}
						<span>More</span>
					</div>
					<div
						aria-label="Usage activity heatmap"
						className="grid grid-cols-7 gap-1.5"
						role="img"
					>
						{cells.map((point, index) => {
							if (!point) {
								return (
									<span
										aria-hidden="true"
										className="aspect-square rounded-sm"
										key={`empty-${index}`}
									/>
								);
							}
							const intensity = max > 0 ? point.requests / max : 0;
							return (
								<UsageMarker
									className="aspect-square rounded-sm bg-primary transition-opacity"
									key={point.start}
									opacity={point.requests === 0 ? 0.08 : 0.2 + intensity * 0.8}
									title={`${point.label}: ${formatCompact(point.requests)} requests`}
								/>
							);
						})}
					</div>
					<div className="type-compact grid grid-cols-7 gap-1.5 text-center text-muted-foreground">
						{axisLabels.map((point) => (
							<span className="truncate" key={point.start}>
								{point.label}
							</span>
						))}
					</div>
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}

/** Route an English source literal through the shared i18n literal boundary. */
function LocalizedLiteral({ value }: { value: string }) {
	return <>{useLocalizedText(value, { literal: true })}</>;
}

/** Ranked request-share bars, used for feature and purpose attribution. */
function FeatureMix({
	data,
	description = "Which product surfaces are driving the activity.",
	emptyMessage = "No feature attribution in this range.",
	renderLabel,
	testId = "chart-feature-mix",
	title = "Usage by feature",
}: {
	data: UsageBreakdownRow[];
	description?: string;
	emptyMessage?: string;
	renderLabel?: (entry: UsageBreakdownRow) => ReactNode;
	testId?: string;
	title?: string;
}) {
	const shown = data.filter((entry) => entry.requests > 0).slice(0, 5);
	const max = shown.reduce(
		(highest, entry) => Math.max(highest, entry.requests),
		0
	);
	const total = shown.reduce((sum, entry) => sum + entry.requests, 0);
	return (
		<div className="min-w-0" data-testid={`usage-analytics-${testId}`}>
			<SettingsSection caption={description} title={title}>
				<SettingsCard>
					{shown.length > 0 ? (
						<div className="flex flex-col gap-3">
							{shown.map((entry, index) => (
								<div className="flex flex-col gap-1" key={entry.key}>
									<div className="flex items-center justify-between gap-3 text-xs">
										<span className="flex min-w-0 items-center gap-2">
											<UsageMarker
												aria-hidden="true"
												backgroundColor={
													CHART_COLORS[index % CHART_COLORS.length]
												}
												className="size-2 shrink-0 rounded-full"
											/>
											<span className="truncate" title={entry.label}>
												{renderLabel ? renderLabel(entry) : entry.label}
											</span>
										</span>
										<span className="shrink-0 text-muted-foreground tabular-nums">
											{formatCompact(entry.requests)} ·{" "}
											{total > 0
												? `${String(Math.round((entry.requests / total) * 100))}%`
												: "0%"}
										</span>
									</div>
									<div className="h-2.5 overflow-hidden rounded-full bg-muted/70">
										<UsageMarker
											backgroundColor={
												CHART_COLORS[index % CHART_COLORS.length]
											}
											className="h-full rounded-full"
											element="div"
											width={`${Math.max(3, (entry.requests / max) * 100)}%`}
										/>
									</div>
								</div>
							))}
						</div>
					) : (
						<p className="text-muted-foreground text-sm">{emptyMessage}</p>
					)}
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}

/**
 * Purpose rows keep their raw Gateway key. First-party labels go through the
 * literal i18n boundary; plugin ids and unknown tags are data and stay as-is.
 */
function PurposeLabel({ entry }: { entry: UsageBreakdownRow }) {
	if (isLabelledPurposeKey(entry.key)) {
		return <LocalizedLiteral value={entry.label} />;
	}
	const pluginId = pluginIdForPurpose(entry.key);
	if (pluginId === null) {
		return <>{entry.key}</>;
	}
	return (
		<>
			<LocalizedLiteral value={PLUGIN_PURPOSE_LABEL} /> · {pluginId}
		</>
	);
}

function PurposeMix({ data }: { data: UsageBreakdownRow[] }) {
	return (
		<FeatureMix
			data={data}
			description="Calls Ryu makes on your behalf, such as compaction, titles and suggestions, next to your own turns."
			emptyMessage="No background calls in this range."
			renderLabel={(entry) => <PurposeLabel entry={entry} />}
			testId="chart-purpose"
			title="Model calls by purpose"
		/>
	);
}

const CACHE_COLORS = {
	read: CHART_COLORS[2],
	reuse: CHART_COLORS[1],
	write: CHART_COLORS[3],
} as const;

function formatPercent(value: number | null): string {
	return value === null ? "—" : `${String(Math.round(value * 100))}%`;
}

/**
 * Prompt-cache volume per bucket. Read and written tokens are the primary
 * marks; reuse (reads ÷ (reads + writes)) is a secondary line, shown only when
 * the provider reports writes at all. Providers that only report reads would
 * otherwise pin it at 100%.
 */
function PromptCacheTrend({ data }: { data: UsageAnalyticsData }) {
	const points = useMemo(() => usageCacheSeries(data.buckets), [data.buckets]);
	const { cacheReadTokens, cacheWriteTokens } = data.totals;
	const reportsWrites = cacheWriteTokens > 0;
	const reuse = cacheReuseRatio(cacheReadTokens, cacheWriteTokens);
	const config: ChartConfig = {
		read: { color: CACHE_COLORS.read, label: "Cache reads" },
		ratio: { color: CACHE_COLORS.reuse, label: "Reuse" },
		write: { color: CACHE_COLORS.write, label: "Cache writes" },
	};
	const tiles = [
		{
			color: CACHE_COLORS.read,
			label: "Cache reads",
			value: formatCompact(cacheReadTokens),
		},
		{
			color: CACHE_COLORS.write,
			label: "Cache writes",
			value: formatCompact(cacheWriteTokens),
		},
	];
	return (
		<div className="min-w-0" data-testid="usage-analytics-chart-prompt-cache">
			<SettingsSection
				caption="Prompt tokens served from the provider cache, and tokens written to it."
				headerAction={
					reportsWrites ? (
						<span className="flex items-baseline gap-1.5 text-xs">
							<span
								className="font-medium text-foreground tabular-nums"
								data-testid="usage-prompt-cache-reuse"
							>
								{formatPercent(reuse)}
							</span>
							<span className="text-muted-foreground">
								<LocalizedLiteral value="reads vs writes" />
							</span>
						</span>
					) : null
				}
				title="Prompt cache"
			>
				<SettingsCard className="flex flex-col gap-4">
					<ChartContainer className="h-[220px] w-full" config={config}>
						<ComposedChart
							accessibilityLayer
							data={points}
							margin={{ left: 4, right: 8, top: 8 }}
						>
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
								tickFormatter={(value) => formatCompact(Number(value))}
								tickLine={false}
								width={36}
								yAxisId="tokens"
							/>
							{reportsWrites ? (
								<YAxis
									axisLine={false}
									domain={[0, 1]}
									orientation="right"
									tickFormatter={(value) => formatPercent(Number(value))}
									tickLine={false}
									width={36}
									yAxisId="ratio"
								/>
							) : null}
							<ChartTooltip
								content={
									<ChartTooltipContent
										formatter={(value, name) => {
											const key = String(name);
											return (
												<TrendTooltipRow
													color={config[key]?.color}
													label={String(config[key]?.label ?? key)}
													value={
														key === "ratio"
															? formatPercent(Number(value))
															: formatCompact(Number(value))
													}
												/>
											);
										}}
										indicator="line"
									/>
								}
								cursor={{ fill: "var(--muted)", fillOpacity: 0.35 }}
							/>
							<Bar
								dataKey="read"
								fill="var(--color-read)"
								isAnimationActive={false}
								maxBarSize={24}
								stackId="cache"
								yAxisId="tokens"
							/>
							<Bar
								dataKey="write"
								fill="var(--color-write)"
								isAnimationActive={false}
								maxBarSize={24}
								radius={[4, 4, 0, 0]}
								stackId="cache"
								yAxisId="tokens"
							/>
							{reportsWrites ? (
								<Line
									connectNulls={false}
									dataKey="ratio"
									dot={false}
									isAnimationActive={false}
									stroke="var(--color-ratio)"
									strokeWidth={2}
									type="monotone"
									yAxisId="ratio"
								/>
							) : null}
						</ComposedChart>
					</ChartContainer>
					{reportsWrites ? null : (
						<p className="text-muted-foreground text-xs">
							The providers in this range report cache reads but not cache
							writes, so no reuse ratio is shown.
						</p>
					)}
					<div className="grid grid-cols-2 gap-2">
						{tiles.map((tile) => (
							<MetricTile key={tile.label} selected {...tile} />
						))}
					</div>
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}

function RankedBreakdown({
	data,
	description,
	testId,
	title,
}: {
	data: UsageBreakdownRow[];
	description: string;
	testId: string;
	title: string;
}) {
	const shown = data
		.filter(
			(entry) =>
				entry.requests > 0 ||
				(entry.spendMicroUsd !== null && entry.spendMicroUsd > 0)
		)
		.slice(0, 6);
	const max = shown.reduce(
		(highest, entry) => Math.max(highest, entry.requests),
		0
	);
	const maxSpend = shown.reduce(
		(highest, entry) => Math.max(highest, entry.spendMicroUsd ?? 0),
		0
	);
	const denominator = max > 0 ? max : maxSpend;
	return (
		<div className="min-w-0" data-testid={`usage-analytics-${testId}`}>
			<SettingsSection caption={description} title={title}>
				<SettingsCard>
					{shown.length > 0 ? (
						<div className="flex flex-col gap-3">
							{shown.map((entry, index) => (
								<div className="flex flex-col gap-1" key={entry.key}>
									<div className="flex items-center justify-between gap-3 text-xs">
										<span className="flex min-w-0 items-center gap-2">
											<UsageMarker
												className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground tabular-nums"
												color={CHART_COLORS[index % CHART_COLORS.length]}
											>
												{index + 1}
											</UsageMarker>
											<span className="truncate" title={entry.label}>
												{entry.label}
											</span>
										</span>
										<span className="shrink-0 text-right text-muted-foreground tabular-nums">
											{formatBreakdownValue(entry)}
										</span>
									</div>
									<div className="h-2 overflow-hidden rounded-full bg-muted/70">
										<UsageMarker
											backgroundColor={
												CHART_COLORS[index % CHART_COLORS.length]
											}
											className="h-full rounded-full"
											element="div"
											width={`${Math.max(
												3,
												((max > 0
													? entry.requests
													: (entry.spendMicroUsd ?? 0)) /
													denominator) *
													100
											)}%`}
										/>
									</div>
								</div>
							))}
						</div>
					) : (
						<p className="text-muted-foreground text-sm">
							No breakdown in this range.
						</p>
					)}
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}

function DateRangeControl({
	range,
	onChange,
}: {
	onChange: (range: UsageDateRange) => void;
	range: UsageDateRange;
}) {
	const [open, setOpen] = useState(false);
	// Days are civil dates in the display zone. Reading today through the
	// subscribed hook also re-renders the label and the highlight at that zone's
	// midnight and when the zone changes.
	const today = useDisplayToday();
	const selected = usageRangeDays(range);
	const choosePreset = (days: number) => {
		onChange(usagePresetRange(days));
		setOpen(false);
	};
	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger aria-label="Choose usage date range" variant="date-range">
				<HugeiconsIcon icon={Calendar03Icon} size={16} />
				<span className="max-w-48 truncate">{dateRangeLabel(range)}</span>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-auto">
				<div className="flex flex-col gap-3">
					<div className="flex flex-wrap gap-1">
						{[
							[1, "24 hours"],
							[7, "7 days"],
							[30, "30 days"],
							[90, "90 days"],
							[365, "12 months"],
						].map(([days, label]) => (
							<Button
								key={String(days)}
								onClick={() => choosePreset(Number(days))}
								size="sm"
								type="button"
								variant="ghost"
							>
								{label}
							</Button>
						))}
					</div>
					<Calendar
						defaultMonth={selected.from}
						disabled={{ after: today }}
						mode="range"
						numberOfMonths={2}
						onSelect={(next) => {
							if (!next?.from) {
								return;
							}
							onChange(usageRangeFromDays(next.from, next.to));
							if (next.to) {
								setOpen(false);
							}
						}}
						selected={selected}
					/>
				</div>
			</PopoverContent>
		</Popover>
	);
}

export interface UsageAnalyticsDashboardProps {
	analytics: UsageAnalyticsData | null;
	failed?: boolean;
	granularity: UsageGranularity;
	loading: boolean;
	model: string | null;
	modelOptions?: string[];
	onGranularityChange: (value: UsageGranularity) => void;
	onModelChange: (value: string | null) => void;
	onProviderChange: (value: string | null) => void;
	onRangeChange: (value: UsageDateRange) => void;
	onRefresh?: () => void;
	onScopeChange: (value: UsageScope) => void;
	provider: string | null;
	providerOptions?: string[];
	range: UsageDateRange;
	scope: UsageScope;
}

export function UsageAnalyticsDashboard({
	analytics,
	failed = false,
	granularity,
	loading,
	model,
	onGranularityChange,
	onModelChange,
	onProviderChange,
	onRangeChange,
	onRefresh,
	onScopeChange,
	provider,
	providerOptions,
	modelOptions,
	range,
	scope,
}: UsageAnalyticsDashboardProps) {
	const providers = providerOptions ?? analytics?.providerOptions ?? [];
	const models = modelOptions ?? analytics?.modelOptions ?? [];
	const totals = analytics?.totals;
	const purposeRows = analytics?.byPurpose ?? [];
	const hasPurposes = purposeRows.some((row) => row.requests > 0);
	const hasPromptCache =
		(totals?.cacheReadTokens ?? 0) + (totals?.cacheWriteTokens ?? 0) > 0;
	return (
		<section
			aria-label="Usage analytics"
			className="flex flex-col gap-6"
			data-testid="usage-analytics-dashboard"
		>
			<SettingsSection title="Usage analytics">
				<div data-testid="usage-filter-rail">
					<SettingsGroup>
						<SettingsItem
							actions={
								<ToggleGroup
									appearance="segmented"
									aria-label="Usage scope"
									className="h-auto max-w-full flex-wrap"
									multiple={false}
									onValueChange={(values: string[]) => {
										const [value] = values;
										const selection = SCOPE_VALUES.find(
											(candidate) => candidate === value
										);
										if (selection) {
											onScopeChange(selection);
										}
									}}
									spacing={0}
									value={[scope]}
									variant="default"
								>
									{SCOPE_VALUES.map((value) => (
										<ToggleGroupItem
											density="segmented"
											key={value}
											value={value}
										>
											{SCOPE_LABELS[value]}
										</ToggleGroupItem>
									))}
								</ToggleGroup>
							}
							description={
								analytics?.caption ?? "Choose a scope to explore consumption."
							}
							title="Scope"
						/>
						<SettingsItem
							actions={
								<ToggleGroup
									appearance="segmented"
									aria-label="Usage granularity"
									className="h-auto max-w-full flex-wrap"
									multiple={false}
									onValueChange={(values: string[]) => {
										const [value] = values;
										const selection = GRANULARITY_VALUES.find(
											(candidate) => candidate === value
										);
										if (selection) {
											onGranularityChange(selection);
										}
									}}
									spacing={0}
									value={[granularity]}
									variant="default"
								>
									{GRANULARITY_VALUES.map((value) => (
										<ToggleGroupItem
											density="segmented"
											key={value}
											value={value}
										>
											{GRANULARITY_LABELS[value]}
										</ToggleGroupItem>
									))}
								</ToggleGroup>
							}
							title="Resolution"
						/>
						<SettingsItem
							actions={
								<DateRangeControl onChange={onRangeChange} range={range} />
							}
							title="Date range"
						/>
						<SettingsItem
							actions={
								<Select
									onValueChange={(value) =>
										onProviderChange(value === "all" ? null : value)
									}
									value={provider ?? "all"}
								>
									<SelectTrigger
										appearance="filter"
										aria-label="Filter by provider"
										className="min-w-40"
										size="sm"
										variant="default"
									>
										<span className="max-w-40 truncate">
											{provider
												? usageProviderLabel(provider)
												: "All providers"}
										</span>
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											<SelectLabel>Provider</SelectLabel>
											<SelectItem value="all">All providers</SelectItem>
											{providers.map((value) => (
												<SelectItem key={value} value={value}>
													{usageProviderLabel(value)}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
							}
							title="Provider"
						/>
						<SettingsItem
							actions={
								<Select
									onValueChange={(value) =>
										onModelChange(value === "all" ? null : value)
									}
									value={model ?? "all"}
								>
									<SelectTrigger
										appearance="filter"
										aria-label="Filter by model"
										className="min-w-44"
										size="sm"
										variant="default"
									>
										<span
											className="max-w-44 truncate"
											title={model ?? "All models"}
										>
											{model ?? "All models"}
										</span>
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											<SelectLabel>Model</SelectLabel>
											<SelectItem value="all">All models</SelectItem>
											{models.map((value) => (
												<SelectItem key={value} value={value}>
													{value}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
							}
							title="Model"
						/>
					</SettingsGroup>
				</div>

				{analytics?.availability?.supported === false ? (
					<SettingsCard className="text-muted-foreground text-sm">
						<p data-testid="usage-analytics-availability">
							{analytics.availability.message}
						</p>
					</SettingsCard>
				) : null}

				{loading && !analytics ? (
					<SettingsCard className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
						<Spinner /> Loading analytics…
					</SettingsCard>
				) : null}

				{analytics ? (
					<SettingsCard
						className={`grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 ${
							scope === "organization" ? "xl:grid-cols-7" : "xl:grid-cols-6"
						}`}
					>
						<KpiCard
							color={KPI_COLORS.requests}
							detail="Across the selected range"
							label="Requests"
							value={formatCompact(totals?.requests ?? 0)}
						/>
						<KpiCard
							color={KPI_COLORS.tokens}
							detail="Input + output"
							label="Tokens"
							value={formatCompact(
								(totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0)
							)}
						/>
						<KpiCard
							color={KPI_COLORS["credit spend"]}
							detail={
								scope === "node"
									? "Only if this node bills through Ryu"
									: "Debit-only consumption"
							}
							label="Credit spend"
							value={formatSpend(totals?.spendMicroUsd ?? null)}
						/>
						<KpiCard
							color={KPI_COLORS.errors}
							detail="Successful + failed calls"
							label="Errors"
							value={formatCompact(totals?.errors ?? 0)}
						/>
						<KpiCard
							color={KPI_COLORS["avg latency"]}
							detail="Average observed latency"
							label="Avg latency"
							value={formatMilliseconds(totals?.averageLatencyMs ?? null)}
						/>
						<KpiCard
							color={
								KPI_COLORS[scope === "you" ? "active days" : "active members"]
							}
							detail={
								scope === "organization"
									? "Members with activity"
									: scope === "node"
										? "Members observed"
										: "Days with activity"
							}
							label={scope === "you" ? "Active days" : "Active members"}
							value={formatCompact(
								scope === "you"
									? (totals?.activeDays ?? 0)
									: (totals?.activeMembers ?? 0)
							)}
						/>
						{scope === "organization" ? (
							<KpiCard
								color={KPI_COLORS["active nodes"]}
								detail="Nodes with activity"
								label="Active nodes"
								value={formatCompact(totals?.activeNodes ?? 0)}
							/>
						) : null}
					</SettingsCard>
				) : loading || failed ? null : (
					<SettingsGroup>
						<SettingsItem
							actions={
								onRefresh ? (
									<Button onClick={onRefresh} size="sm" variant="outline">
										Refresh analytics
									</Button>
								) : null
							}
							title={
								<span className="text-muted-foreground">
									No analytics loaded. Choose a scope and range to explore
									usage.
								</span>
							}
						/>
					</SettingsGroup>
				)}
			</SettingsSection>

			{analytics ? (
				<>
					<div className="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(300px,1fr)]">
						<UsageTrend data={analytics} />
						<UsageDonut
							data={analytics.bySource}
							description="Managed credits are only one possible billing source."
							testId="chart-source"
							title="Consumption source"
						/>
					</div>
					<div className="grid gap-6 md:grid-cols-2">
						<UsageDonut
							data={analytics.byProvider}
							description="Compare providers before narrowing the dashboard."
							testId="chart-provider"
							title="Provider mix"
						/>
						<FeatureMix data={analytics.byFeature} />
					</div>
					{hasPurposes || hasPromptCache ? (
						<div className="grid gap-6 md:grid-cols-2">
							{hasPurposes ? <PurposeMix data={purposeRows} /> : null}
							{hasPromptCache ? <PromptCacheTrend data={analytics} /> : null}
						</div>
					) : null}
					<div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
						<RankedBreakdown
							data={analytics.byModel}
							description="Most observed model calls in this scope."
							testId="chart-model"
							title="Top models"
						/>
						<RankedBreakdown
							data={analytics.byProvider}
							description="Request volume by provider."
							testId="chart-provider-ranking"
							title="Provider breakdown"
						/>
						<ActivityHeatmap data={analytics} />
					</div>
				</>
			) : null}
		</section>
	);
}
