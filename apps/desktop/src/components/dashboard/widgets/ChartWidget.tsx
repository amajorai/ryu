// Chart widget: line / bar / area / pie, rendered through the shared shadcn chart
// wrapper (recharts under the hood). The widget value is an array of data points;
// config picks the x axis and series. Consistent styling comes from the wrapper.

import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@ryu/ui/components/chart";
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
import { asRecord, resolveArray, toNumber } from "./data.ts";
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
function rows(value: unknown, dataKey?: string): Record<string, unknown>[] {
	return resolveArray(value, dataKey)
		.map((r) => asRecord(r))
		.filter((r): r is Record<string, unknown> => r !== null);
}

function firstKeyWhere(
	row: Record<string, unknown> | undefined,
	predicate: (v: unknown) => boolean
): string | undefined {
	if (!row) {
		return undefined;
	}
	return Object.keys(row).find((k) => predicate(row[k]));
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
	// Unique prefix so multiple area-chart widgets on one grid don't share a
	// `<linearGradient id>` (duplicate ids make later charts reuse the first fill).
	const gradientId = useId();
	const cfg = parseConfig(chartConfigSchema, config);
	const data = rows(value, cfg.data_key);
	if (data.length === 0) {
		return <EmptyChart />;
	}

	if (kind === "pie_chart") {
		const nameKey =
			cfg.name_key ??
			firstKeyWhere(data[0], (v) => typeof v === "string") ??
			"name";
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
			<ChartContainer className="h-full w-full" config={chartConfig}>
				<PieChart>
					<ChartTooltip content={<ChartTooltipContent />} />
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
		cfg.x_key ?? firstKeyWhere(data[0], (v) => typeof v === "string") ?? "x";
	const series =
		cfg.series && cfg.series.length > 0
			? cfg.series
			: Object.keys(data[0]).filter(
					(k) => k !== xKey && toNumber(data[0][k]) !== null
				);
	const chartConfig: ChartConfig = Object.fromEntries(
		series.map((s, i) => [s, { label: s, color: PALETTE[i % PALETTE.length] }])
	);

	const axes = (
		<>
			<CartesianGrid vertical={false} />
			<XAxis axisLine={false} dataKey={xKey} tickLine={false} tickMargin={8} />
			<YAxis axisLine={false} tickLine={false} width={32} />
			<ChartTooltip content={<ChartTooltipContent />} />
		</>
	);

	if (kind === "bar_chart") {
		return (
			<ChartContainer className="h-full w-full" config={chartConfig}>
				<BarChart data={data}>
					{axes}
					{series.map((s) => (
						<Bar dataKey={s} fill={`var(--color-${s})`} key={s} radius={4} />
					))}
				</BarChart>
			</ChartContainer>
		);
	}

	if (kind === "area_chart") {
		return (
			<ChartContainer className="h-full w-full" config={chartConfig}>
				<AreaChart data={data}>
					<defs>
						{series.map((s) => {
							const id = `${gradientId}-${s}`;
							return (
								<linearGradient id={id} key={s} x1="0" x2="0" y1="0" y2="1">
									<stop
										offset="5%"
										stopColor={`var(--color-${s})`}
										stopOpacity={0.7}
									/>
									<stop
										offset="95%"
										stopColor={`var(--color-${s})`}
										stopOpacity={0.05}
									/>
								</linearGradient>
							);
						})}
					</defs>
					{axes}
					{series.map((s) => (
						<Area
							dataKey={s}
							fill={`url(#${gradientId}-${s})`}
							key={s}
							stroke={`var(--color-${s})`}
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
		<ChartContainer className="h-full w-full" config={chartConfig}>
			<LineChart data={data}>
				{axes}
				{series.map((s) => (
					<Line
						dataKey={s}
						dot={false}
						key={s}
						stroke={`var(--color-${s})`}
						strokeWidth={2}
						type="monotone"
					/>
				))}
			</LineChart>
		</ChartContainer>
	);
}
