import { useLiteralMessages } from "@ryu/i18n/react";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// Chart widget: line / bar / area / pie, rendered through the shared shadcn chart
// wrapper (recharts under the hood). The widget value is an array of data points;
// config picks the x axis and series. Consistent styling comes from the wrapper.

import {
	type ChartConfig,
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartTooltip,
	ChartTooltipContent,
	chartColorVariableName,
} from "@ryu/ui/components/chart.tsx";
import { useId } from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	Line,
	LineChart,
	Pie,
	PieChart,
	XAxis,
	YAxis,
} from "recharts";
import type { WidgetKind } from "@/src/lib/api/dashboard.ts";
import { asRecord, type JsonValue, resolveArray, toNumber } from "./data.ts";
import { chartConfigSchema, parseConfig } from "./schema.ts";

// A vibrant, theme-agnostic palette. The app's global `--chart-*` tokens are
// intentionally monochrome, so dashboard charts define their own colors here
// (scoped to this widget, not the whole app). Mid-lightness oklch values read
// well on both light and dark backgrounds.
const PALETTE = [
	"oklch(0.62 0.19 256)", // blue
	"oklch(0.56 0.18 306)", // purple
	"oklch(0.64 0.21 1)", // pink
	"oklch(0.78 0.16 76)", // amber
	"oklch(0.7 0.12 182)", // teal
	"oklch(0.63 0.19 149)", // green
];

/** Rows of records from the widget value. */
function rows<TValue>(
	value: TValue,
	dataKey?: string
): NonNullable<ReturnType<typeof asRecord>>[] {
	return resolveArray(value, dataKey)
		.map((r) => asRecord(r))
		.filter((r) => r !== null);
}

function firstKeyWhere(
	row: NonNullable<ReturnType<typeof asRecord>> | undefined,
	predicate: (v: JsonValue | undefined) => boolean
): string | undefined {
	if (!row) {
		return undefined;
	}
	return Object.keys(row).find((k) => predicate(row[k]));
}

function humanizeKey(key: string): string {
	return key
		.replaceAll("_", " ")
		.replace(/\b\w/g, (character) => character.toUpperCase());
}

function EmptyChart() {
	return (
		<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
			No data
		</div>
	);
}

export function ChartBody({
	kind,
	value,
	config,
}: {
	kind: WidgetKind;
	value: unknown;
	config: unknown;
}) {
	const tl = useLiteralMessages();
	// Unique prefix so multiple area-chart widgets on one grid don't share a
	// `<linearGradient id>` (duplicate ids make later charts reuse the first fill).
	const gradientId = `chart-${useId().replace(/[^a-zA-Z0-9_-]/gu, "")}`;
	const cfg = parseConfig(chartConfigSchema, config);
	const data = rows(value, cfg.data_key);
	const ariaLabel = tl("{chartKind} dashboard chart", {
		chartKind: humanizeKey(kind),
	});
	if (data.length === 0) {
		return <EmptyChart />;
	}

	if (kind === "pie_chart") {
		const nameKey =
			cfg.name_key ?? firstKeyWhere(data[0], (v) => isNativeText(v)) ?? "name";
		const valueKey =
			cfg.value_key ??
			firstKeyWhere(data[0], (v) => toNumber(v) !== null) ??
			"value";
		const chartConfig: ChartConfig = Object.fromEntries(
			data.map((row, i) => [
				String(row[nameKey] ?? i),
				{
					label: String(row[nameKey] ?? i),
					color: PALETTE[i % PALETTE.length],
				},
			])
		);
		return (
			<ChartContainer
				aria-label={ariaLabel}
				className="h-full w-full"
				config={chartConfig}
				role="img"
			>
				<PieChart accessibilityLayer>
					<ChartTooltip content={<ChartTooltipContent />} />
					<ChartLegend content={<ChartLegendContent />} />
					<Pie data={data} dataKey={valueKey} nameKey={nameKey}>
						{data.map((row, i) => (
							<Cell
								fill={PALETTE[i % PALETTE.length]}
								key={String(row[nameKey] ?? i)}
							/>
						))}
					</Pie>
				</PieChart>
			</ChartContainer>
		);
	}

	// Cartesian charts (line / bar / area).
	const xKey =
		cfg.x_key ?? firstKeyWhere(data[0], (v) => isNativeText(v)) ?? "x";
	const series =
		cfg.series && cfg.series.length > 0
			? cfg.series
			: Object.keys(data[0]).filter(
					(k) => k !== xKey && toNumber(data[0][k]) !== null
				);
	const chartConfig: ChartConfig = Object.fromEntries(
		series.map((s, i) => [
			s,
			{ label: humanizeKey(s), color: PALETTE[i % PALETTE.length] },
		])
	);
	const seriesVariables = series.map((key) => ({
		key,
		name: chartColorVariableName(key),
	}));

	// Recharts does not reliably flatten a fragment supplied as a child. Keep
	// these as keyed elements so the grid, axes, tooltip, and legend all survive
	// the shared renderer path.
	const axes = [
		<CartesianGrid key="grid" strokeOpacity={0.35} vertical={false} />,
		<XAxis
			axisLine={false}
			dataKey={xKey}
			key="x-axis"
			minTickGap={32}
			tickLine={false}
			tickMargin={8}
		/>,
		<YAxis axisLine={false} key="y-axis" tickLine={false} width={40} />,
		<ChartTooltip
			content={<ChartTooltipContent indicator="line" />}
			cursor={false}
			key="tooltip"
		/>,
		...(seriesVariables.length > 1
			? [
					<ChartLegend
						content={<ChartLegendContent />}
						key="legend"
						verticalAlign="top"
					/>,
				]
			: []),
	];

	if (kind === "bar_chart") {
		return (
			<ChartContainer
				aria-label={ariaLabel}
				className="h-full w-full"
				config={chartConfig}
				role="img"
			>
				<BarChart
					accessibilityLayer
					barCategoryGap="24%"
					data={data}
					margin={{ bottom: 4, left: 0, right: 8, top: 8 }}
				>
					{axes}
					{seriesVariables.map(({ key, name }) => (
						<Bar
							dataKey={key}
							fill={`var(${name})`}
							key={key}
							maxBarSize={28}
							radius={4}
						/>
					))}
				</BarChart>
			</ChartContainer>
		);
	}

	if (kind === "area_chart") {
		return (
			<ChartContainer
				aria-label={ariaLabel}
				className="h-full w-full"
				config={chartConfig}
				role="img"
			>
				<AreaChart
					accessibilityLayer
					data={data}
					margin={{ bottom: 4, left: 0, right: 8, top: 8 }}
				>
					<defs>
						{seriesVariables.map(({ key, name }) => {
							const id = `${gradientId}-${name.slice("--color-".length)}`;
							return (
								<linearGradient id={id} key={key} x1="0" x2="0" y1="0" y2="1">
									<stop
										offset="5%"
										stopColor={`var(${name})`}
										stopOpacity={0.7}
									/>
									<stop
										offset="95%"
										stopColor={`var(${name})`}
										stopOpacity={0.05}
									/>
								</linearGradient>
							);
						})}
					</defs>
					{axes}
					{seriesVariables.map(({ key, name }) => (
						<Area
							dataKey={key}
							fill={`url(#${gradientId}-${name.slice("--color-".length)})`}
							key={key}
							stroke={`var(${name})`}
							strokeWidth={2}
							type="monotone"
						/>
					))}
				</AreaChart>
			</ChartContainer>
		);
	}

	// default: line
	return (
		<ChartContainer
			aria-label={ariaLabel}
			className="h-full w-full"
			config={chartConfig}
			role="img"
		>
			<LineChart
				accessibilityLayer
				data={data}
				margin={{ bottom: 4, left: 0, right: 8, top: 8 }}
			>
				{axes}
				{seriesVariables.map(({ key, name }) => (
					<Line
						activeDot={{ r: 3 }}
						dataKey={key}
						dot={false}
						key={key}
						stroke={`var(${name})`}
						strokeWidth={2}
						type="monotone"
					/>
				))}
			</LineChart>
		</ChartContainer>
	);
}
