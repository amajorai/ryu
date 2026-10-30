"use client";

import { formatForecastChange } from "@ryu/blocks/desktop/usage-forecast.ts";
import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@ryu/ui/components/chart.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useMemo, useState } from "react";
import {
	Area,
	CartesianGrid,
	ComposedChart,
	Line,
	XAxis,
	YAxis,
} from "recharts";
import { Segmented } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	type HistoryBucket,
	type HistoryScope,
	historyProcessedTokens,
	type UsageHistoryReport,
} from "@/src/lib/api/usage-history.ts";
import {
	type DailyForecast,
	forecastDailyValues,
	HISTORY_FORECAST_DAYS,
} from "./history-forecast.ts";
import { formatHistoryTokens } from "./history-format.ts";
import { COLORS, money } from "./UsageHistoryDashboard-shared.tsx";
import usageVisualStyles from "./usage-visual-indicators.module.css";
import type { UsageVisualStyle } from "./usage-visual-style.ts";

type HistoryChartRow = Record<
	string,
	string | number | null | [number, number]
>;

function bucketMetricValue(
	bucket: HistoryBucket,
	metric: "tokens" | "estimate"
): number | null {
	if (metric === "estimate") {
		return bucket.estimatedCostUsd;
	}
	const tokensUnknown =
		bucket.records > 0 &&
		[
			bucket.totals.missingInputRecords,
			bucket.totals.missingOutputRecords,
			bucket.totals.missingCacheReadRecords,
			bucket.totals.missingCacheWriteRecords,
		].every((missing) => missing === bucket.records);
	return tokensUnknown ? null : historyProcessedTokens(bucket.totals);
}

function forecastChange(forecast: DailyForecast["forecast"]) {
	return {
		label: formatForecastChange(forecast),
		tone:
			forecast.direction === "up"
				? "text-status-warning"
				: forecast.direction === "down"
					? "text-status-success"
					: "text-muted-foreground",
	};
}

export function DailyChart({
	report,
	scope,
}: {
	report: UsageHistoryReport;
	scope: HistoryScope;
}) {
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();
	const [metric, setMetric] = useState<"tokens" | "estimate">("tokens");
	const [view, setView] = useState<"source" | "total">("source");
	const [showForecast, setShowForecast] = useState(true);
	// Observation dates are not usage dates, so snapshots are never forecast.
	const forecastable = scope !== "unattributed";
	const { config, forecasts, rows, series } = useMemo(() => {
		const today = new Date().toISOString().slice(0, 10);
		const sourceIds = [
			...new Set(report.summary.daily.map((row) => row.sourceId)),
		];
		const config: ChartConfig = {
			band: { color: "var(--muted-foreground)", label: "80% range" },
		};
		const series =
			view === "total"
				? [{ ids: sourceIds, key: "total" }]
				: sourceIds.map((id, index) => ({ ids: [id], key: `source${index}` }));
		for (const item of series) {
			const id = item.ids[0] ?? "";
			config[item.key] = {
				label:
					item.key === "total"
						? "All sources"
						: (report.sources.find((source) => source.id === id)?.label ?? id),
				color:
					item.key === "total"
						? "var(--chart-1)"
						: COLORS[
								Math.max(
									0,
									report.sources.findIndex((source) => source.id === id)
								) % COLORS.length
							],
			};
			config[`${item.key}Forecast`] = {
				label: `${config[item.key]?.label ?? item.key} forecast`,
				color: config[item.key]?.color,
			};
		}
		const byDay = new Map<string, HistoryChartRow>();
		const daily = new Map<string, Map<string, number>>();
		for (const bucket of report.summary.daily) {
			const row = byDay.get(bucket.date) ?? {
				date: bucket.date,
				timestamp: Date.parse(bucket.date),
			};
			const target = series.find((item) => item.ids.includes(bucket.sourceId));
			if (target) {
				const value = bucketMetricValue(bucket, metric);
				row[target.key] =
					value === null
						? (row[target.key] ?? null)
						: Number(row[target.key] ?? 0) + value;
				if (value !== null) {
					const values = daily.get(target.key) ?? new Map<string, number>();
					values.set(bucket.date, (values.get(bucket.date) ?? 0) + value);
					daily.set(target.key, values);
				}
			}
			byDay.set(bucket.date, row);
		}
		if (forecastable) {
			// A usage day without records had no usage; draw it as zero so the
			// line matches what the forecast was fitted on.
			const dates = [...byDay.keys()].sort();
			const first = dates[0];
			const last = dates.at(-1);
			if (first && last) {
				for (
					let day = Date.parse(first);
					day <= Date.parse(last);
					day += 24 * 60 * 60 * 1000
				) {
					const date = new Date(day).toISOString().slice(0, 10);
					if (!byDay.has(date)) {
						byDay.set(date, { date, timestamp: day });
					}
				}
			}
		}
		for (const row of byDay.values()) {
			for (const item of series) {
				if (!(item.key in row)) {
					row[item.key] = 0;
				}
			}
		}
		const forecasts = new Map<string, DailyForecast>();
		if (forecastable && showForecast) {
			for (const item of series) {
				const forecast = forecastDailyValues(
					daily.get(item.key) ?? new Map(),
					today
				);
				if (!forecast) {
					continue;
				}
				forecasts.set(item.key, forecast);
				const bridge = byDay.get(forecast.bridgeDate) ?? {
					date: forecast.bridgeDate,
					timestamp: Date.parse(forecast.bridgeDate),
				};
				for (const other of series) {
					bridge[other.key] ??= 0;
				}
				bridge[`${item.key}Forecast`] = forecast.bridgeValue;
				if (view === "total") {
					bridge.band = [forecast.bridgeValue, forecast.bridgeValue];
				}
				byDay.set(forecast.bridgeDate, bridge);
				forecast.dates.forEach((date, index) => {
					const point = forecast.forecast.points[index];
					if (!point) {
						return;
					}
					const row = byDay.get(date) ?? {
						date,
						timestamp: Date.parse(date),
					};
					for (const other of series) {
						row[other.key] ??= null;
					}
					row[`${item.key}Forecast`] = point.value;
					if (view === "total") {
						row.band = [point.lower, point.upper];
					}
					byDay.set(date, row);
				});
			}
		}
		const rows = [...byDay.values()].sort((left, right) =>
			String(left.date).localeCompare(String(right.date))
		);
		return { config, forecasts, rows, series };
	}, [report, metric, view, showForecast, forecastable]);
	const format = (value: number, exact = false) =>
		metric === "tokens" ? formatHistoryTokens(value, !exact) : money(value);
	const totalForecast = view === "total" ? forecasts.get("total") : undefined;
	return (
		<SettingsSection
			caption={`${
				metric === "tokens"
					? "Processed tokens"
					: "API-equivalent USD estimate. Unknown prices appear as gaps"
			} ${
				scope === "unattributed"
					? "· UTC observation dates. Snapshots may include earlier usage."
					: "· UTC dates"
			}${
				forecastable && showForecast
					? ` · Dashed lines project the next ${HISTORY_FORECAST_DAYS} days from the recent trend.`
					: ""
			}`}
			title={
				scope === "unattributed"
					? "Observed usage by source"
					: "Daily usage by source"
			}
		>
			<SettingsCard className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<Segmented
						label="Chart metric"
						onChange={setMetric}
						options={[
							{ label: "Tokens", value: "tokens" },
							{ label: "API estimate", value: "estimate" },
						]}
						value={metric}
					/>
					<Segmented
						label="Chart grouping"
						onChange={setView}
						options={[
							{ label: "By source", value: "source" },
							{ label: "All sources", value: "total" },
						]}
						value={view}
					/>
					{forecastable ? (
						<label className="ml-auto flex items-center gap-2 text-muted-foreground text-xs">
							Forecast
							<Switch
								checked={showForecast}
								onCheckedChange={setShowForecast}
							/>
						</label>
					) : null}
				</div>
				{rows.length ? (
					<>
						<ChartContainer className="h-[240px] w-full" config={config}>
							<ComposedChart
								accessibilityLayer
								data={rows}
								margin={{ left: 4, right: 12, top: 10, bottom: 0 }}
							>
								<CartesianGrid vertical={false} />
								<XAxis
									axisLine={false}
									dataKey="timestamp"
									domain={["dataMin", "dataMax"]}
									minTickGap={36}
									scale="time"
									tickFormatter={(date: number) =>
										new Date(date).toISOString().slice(5, 10)
									}
									tickLine={false}
									type="number"
								/>
								<YAxis
									axisLine={false}
									tickFormatter={(value: number) => format(value)}
									tickLine={false}
									width={52}
								/>
								<ChartTooltip
									content={
										<ChartTooltipContent
											formatter={(value, name) => {
												const key = String(name);
												const formatted = Array.isArray(value)
													? `${format(Number(value[0]), true)} – ${format(Number(value[1]), true)}`
													: format(Number(value), true);
												return (
													<span className="flex w-full items-center justify-between gap-3">
														<span className="text-muted-foreground">
															{String(config[key]?.label ?? key)}
														</span>
														<span className="font-medium tabular-nums">
															{formatted}
														</span>
													</span>
												);
											}}
											labelFormatter={(_, payload) => {
												const timestamp = Number(
													payload?.[0]?.payload?.timestamp
												);
												return Number.isFinite(timestamp)
													? new Date(timestamp).toISOString().slice(0, 10)
													: "";
											}}
										/>
									}
								/>
								{totalForecast ? (
									<Area
										activeDot={false}
										dataKey="band"
										fill="var(--muted-foreground)"
										fillOpacity={0.12}
										isAnimationActive={false}
										stroke="none"
										type="linear"
									/>
								) : null}
								{series.map((source) => (
									<Line
										dataKey={source.key}
										dot={rows.length < 3}
										isAnimationActive={false}
										key={source.key}
										stroke={config[source.key]?.color}
										strokeWidth={2}
										type="linear"
									/>
								))}
								{series.map((source) =>
									forecasts.has(source.key) ? (
										<Line
											dataKey={`${source.key}Forecast`}
											dot={false}
											isAnimationActive={false}
											key={`${source.key}Forecast`}
											stroke={config[source.key]?.color}
											strokeDasharray="5 4"
											strokeOpacity={0.85}
											strokeWidth={2}
											type="linear"
										/>
									) : null
								)}
							</ComposedChart>
						</ChartContainer>
						<div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
							{series.map((source) => {
								const forecast = forecasts.get(source.key);
								const change = forecast
									? forecastChange(forecast.forecast)
									: null;
								return (
									<span className="flex items-center gap-1.5" key={source.key}>
										<span
											className={`size-2 rounded-full ${usageVisualStyles.sourceColor}`}
											style={
												// SAFETY: The literal satisfies full React CSSProperties and the named native CSS slots.
												// This checked owner assertion only clears fresh-literal metadata for React style.
												{
													"--usage-source-color": config[source.key]?.color,
												} satisfies UsageVisualStyle as UsageVisualStyle
											}
										/>
										{config[source.key]?.label}
										{forecast && change && view === "source" ? (
											<span
												className="text-muted-foreground tabular-nums"
												title={tl("80% range {lower} – {upper}", {
													lower: format(forecast.forecast.total.lower, true),
													upper: format(forecast.forecast.total.upper, true),
												})}
											>
												{tlRich(
													"· next {days}d ≈ {value} <tone>{change}</tone>",
													{
														change: change.label,
														days: HISTORY_FORECAST_DAYS,
														value: format(forecast.forecast.total.value),
													},
													{
														tone: (chunks) => (
															<span className={change.tone}>{chunks}</span>
														),
													}
												)}
											</span>
										) : null}
									</span>
								);
							})}
						</div>
						{totalForecast ? (
							<div
								className="flex flex-wrap items-center justify-between gap-3 border-border border-t pt-3 text-xs"
								data-testid="history-forecast"
							>
								<span>
									<span className="text-muted-foreground">
										{tl("Forecast · next {days} days", {
											days: HISTORY_FORECAST_DAYS,
										})}{" "}
									</span>
									<span className="font-medium tabular-nums">
										{format(totalForecast.forecast.total.value)}
									</span>
								</span>
								<span className="text-muted-foreground tabular-nums">
									{tl("80% range {lower} – {upper}", {
										lower: format(totalForecast.forecast.total.lower),
										upper: format(totalForecast.forecast.total.upper),
									})}
								</span>
								<span className={forecastChange(totalForecast.forecast).tone}>
									{forecastChange(totalForecast.forecast).label}
								</span>
							</div>
						) : null}
						{forecastable && showForecast && forecasts.size === 0 ? (
							<p className="text-muted-foreground text-xs">
								Not enough recent daily activity to project a trend yet.
							</p>
						) : null}
					</>
				) : (
					<p className="py-12 text-center text-muted-foreground text-sm">
						Import retained session history to see your daily activity.
					</p>
				)}
			</SettingsCard>
		</SettingsSection>
	);
}
