import {
	type ChartConfig,
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartTooltip,
	ChartTooltipContent,
} from "@ryu/ui/components/chart.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { ComponentProps } from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Line,
	LineChart,
	Pie,
	PieChart,
	Sector,
	XAxis,
	YAxis,
} from "recharts";
import { z } from "zod";
import { CHART_COLORS, CHART_MAX_POINTS, CHART_MAX_SERIES } from "./catalog.ts";
import { agentUiComputedFunctions } from "./computed.ts";
import type { AgentUiGeometryStyle, Render } from "./registry-shared.ts";

type ChartColor = (typeof CHART_COLORS)[number];
type ChartValueFormat = "number" | "compact" | "percent" | "currency";
interface ChartSeriesProps {
	color?: ChartColor;
	key: string;
	label?: string;
}
type ChartRow = Record<string, string | number | null>;

// Chart data may arrive through `$state`, so re-check it at render time rather
// than trusting the catalog schema: anything that isn't a list of plain rows
// draws an empty chart instead of throwing inside recharts. Raw arrays are
// capped *before* per-entry validation so an oversized state array costs no
// more than the advertised limits, and invalid entries are dropped (not
// blanked) so a list of junk still reaches the empty state.
const chartRowSchema = z.record(
	z.string(),
	z.union([z.string(), z.number(), z.null()])
);
const chartSeriesEntrySchema = z.object({
	key: z.string(),
	label: z.string().optional(),
	color: z.enum(CHART_COLORS).optional(),
});

function parseCapped<T>(
	raw: readonly T[],
	limit: number,
	schema: z.ZodType<T>
): T[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const parsed: T[] = [];
	for (const entry of raw.slice(0, limit)) {
		const result = schema.safeParse(entry);
		if (result.success) {
			parsed.push(result.data);
		}
	}
	return parsed;
}

/** The shared tooltip forwards Recharts formatter values; chart ticks and Stat
 * numbers are members of that same value domain. */
type ChartFormattedValue = Parameters<
	NonNullable<ComponentProps<typeof ChartTooltipContent>["formatter"]>
>[0];

const DEFAULT_CHART_HEIGHT = 240;

function chartColor(series: ChartSeriesProps, index: number): string {
	return `var(--${series.color ?? CHART_COLORS[index % CHART_COLORS.length]})`;
}

export function formatChartValue(
	value: ChartFormattedValue | undefined,
	format: ChartValueFormat | undefined,
	currency: string | undefined
): string {
	const formatted = agentUiComputedFunctions.format.run({
		value,
		style: format ?? "number",
		digits: format === "percent" ? 1 : 2,
		currency,
	});
	return isNativeText(formatted) ? formatted : String(value ?? "");
}

export const ChartRenderer: Render<{
	type: "bar" | "line" | "area" | "pie";
	data: ChartRow[];
	xKey: string;
	series: ChartSeriesProps[];
	stacked?: boolean;
	height?: number;
	valueFormat?: ChartValueFormat;
	currency?: string;
	showLegend?: boolean;
}> = ({ props }) => {
	const data = parseCapped(props.data, CHART_MAX_POINTS, chartRowSchema);
	const series = parseCapped(
		props.series,
		CHART_MAX_SERIES,
		chartSeriesEntrySchema
	);
	const height = Math.min(
		480,
		Math.max(120, props.height ?? DEFAULT_CHART_HEIGHT)
	);
	const geometry: AgentUiGeometryStyle = {
		"--agent-ui-chart-height": `${height}px`,
	};
	const config: ChartConfig = Object.fromEntries(
		series.map((entry) => [entry.key, { label: entry.label ?? entry.key }])
	);
	const formatValue = (value: ChartFormattedValue | undefined) =>
		formatChartValue(value, props.valueFormat, props.currency);
	const tooltip = (
		<ChartTooltip
			content={
				<ChartTooltipContent
					formatter={(value, name) => (
						<span className="flex w-full justify-between gap-3">
							<span className="text-muted-foreground">
								{config[String(name)]?.label ?? name}
							</span>
							<span className="font-mono tabular-nums">
								{formatValue(value)}
							</span>
						</span>
					)}
					hideLabel={props.type === "pie"}
				/>
			}
		/>
	);
	const legend =
		(props.showLegend ?? series.length > 1) ? (
			<ChartLegend content={<ChartLegendContent />} />
		) : null;
	const className = "aspect-auto h-(--agent-ui-chart-height) w-full";

	// The pie draws its first series; the guard below also narrows it for that branch.
	const [firstSeries] = series;
	if (data.length === 0 || firstSeries === undefined) {
		return (
			<div
				className="flex h-(--agent-ui-chart-height) items-center justify-center rounded-lg border border-border border-dashed text-muted-foreground text-xs"
				style={geometry}
			>
				No data
			</div>
		);
	}

	if (props.type === "pie") {
		const pieColors = new Map<object, string>(
			data.map((row, index) => [
				row,
				`var(--${CHART_COLORS[index % CHART_COLORS.length]})`,
			])
		);
		// Pie legend entries are categories (one per row), not series, so the
		// legend resolves labels through `xKey` against per-category config.
		const pieConfig: ChartConfig = { ...config };
		for (const row of data) {
			const category = String(row[props.xKey] ?? "");
			pieConfig[category] ??= { label: category };
		}
		return (
			<ChartContainer className={className} config={pieConfig} style={geometry}>
				<PieChart accessibilityLayer>
					<ChartTooltip
						content={(tooltipProps) => {
							const color = `var(--${CHART_COLORS[Number(tooltipProps.activeIndex) % CHART_COLORS.length]})`;
							return (
								<ChartTooltipContent
									active={tooltipProps.active}
									formatter={(value, name) => (
										<span className="flex w-full justify-between gap-3">
											<span className="text-muted-foreground">
												{config[String(name)]?.label ?? name}
											</span>
											<span className="font-mono tabular-nums">
												{formatValue(value)}
											</span>
										</span>
									)}
									hideLabel={props.type === "pie"}
									label={tooltipProps.label}
									labelFormatter={tooltipProps.labelFormatter}
									payload={tooltipProps.payload.map((entry) => ({
										...entry,
										color,
										fill: color,
										payload: { ...entry.payload, fill: color },
									}))}
								/>
							);
						}}
					/>
					{legend ? (
						<ChartLegend
							content={(legendProps) => (
								<ChartLegendContent
									nameKey={props.xKey}
									payload={legendProps.payload?.map((entry) => ({
										...entry,
										color: entry.payload
											? (pieColors.get(entry.payload) ?? entry.color)
											: entry.color,
									}))}
									verticalAlign={legendProps.verticalAlign}
								/>
							)}
						/>
					) : null}
					<Pie
						data={data}
						dataKey={firstSeries.key}
						innerRadius="45%"
						nameKey={props.xKey}
						outerRadius="80%"
						paddingAngle={2}
						shape={(sector) => (
							<Sector
								{...sector}
								fill={`var(--${CHART_COLORS[sector.index % CHART_COLORS.length]})`}
							/>
						)}
						strokeWidth={0}
					/>
				</PieChart>
			</ChartContainer>
		);
	}

	const axes = (
		<>
			<CartesianGrid strokeOpacity={0.35} vertical={false} />
			<XAxis
				axisLine={false}
				dataKey={props.xKey}
				minTickGap={24}
				tickLine={false}
				tickMargin={8}
			/>
			<YAxis
				axisLine={false}
				tickFormatter={formatValue}
				tickLine={false}
				width={56}
			/>
		</>
	);
	const stackId = props.stacked ? "stack" : undefined;
	const margin = { left: 4, right: 8, top: 8 };

	if (props.type === "line") {
		return (
			<ChartContainer className={className} config={config} style={geometry}>
				<LineChart accessibilityLayer data={data} margin={margin}>
					{axes}
					{tooltip}
					{legend}
					{series.map((entry, index) => (
						<Line
							dataKey={entry.key}
							dot={data.length <= 24}
							key={entry.key}
							name={entry.key}
							stroke={chartColor(entry, index)}
							strokeWidth={2}
							type="monotone"
						/>
					))}
				</LineChart>
			</ChartContainer>
		);
	}
	if (props.type === "area") {
		return (
			<ChartContainer className={className} config={config} style={geometry}>
				<AreaChart accessibilityLayer data={data} margin={margin}>
					{axes}
					{tooltip}
					{legend}
					{series.map((entry, index) => (
						<Area
							dataKey={entry.key}
							fill={chartColor(entry, index)}
							fillOpacity={0.25}
							key={entry.key}
							name={entry.key}
							stackId={stackId}
							stroke={chartColor(entry, index)}
							strokeWidth={2}
							type="monotone"
						/>
					))}
				</AreaChart>
			</ChartContainer>
		);
	}
	return (
		<ChartContainer className={className} config={config} style={geometry}>
			<BarChart accessibilityLayer data={data} margin={margin}>
				{axes}
				{tooltip}
				{legend}
				{series.map((entry, index) => (
					<Bar
						dataKey={entry.key}
						fill={chartColor(entry, index)}
						key={entry.key}
						name={entry.key}
						radius={props.stacked ? 0 : 4}
						stackId={stackId}
					/>
				))}
			</BarChart>
		</ChartContainer>
	);
};
