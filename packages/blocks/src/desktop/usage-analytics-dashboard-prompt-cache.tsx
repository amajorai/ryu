"use client";

import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@ryu/ui/components/chart";
import { useMemo } from "react";
import {
	Bar,
	CartesianGrid,
	ComposedChart,
	Line,
	XAxis,
	YAxis,
} from "recharts";
import { SettingsCard, SettingsSection } from "./settings-items.tsx";
import {
	cacheReuseRatio,
	type UsageAnalyticsData,
	usageCacheSeries,
} from "./usage-analytics.ts";
import {
	CHART_COLORS,
	formatCompact,
	LocalizedLiteral,
	MetricTile,
	TrendTooltipRow,
} from "./usage-analytics-dashboard-shared.tsx";

export const CACHE_COLORS = {
	read: CHART_COLORS[2],
	reuse: CHART_COLORS[1],
	write: CHART_COLORS[3],
} as const;

export function formatPercent(value: number | null): string {
	return value === null ? "—" : `${String(Math.round(value * 100))}%`;
}

/**
 * Prompt-cache volume per bucket. Read and written tokens are the primary
 * marks; reuse (reads ÷ (reads + writes)) is a secondary line, shown only when
 * the provider reports writes at all. Providers that only report reads would
 * otherwise pin it at 100%.
 */
export function PromptCacheTrend({ data }: { data: UsageAnalyticsData }) {
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
