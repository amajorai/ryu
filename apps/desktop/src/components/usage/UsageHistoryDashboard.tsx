"use client";

import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { formatForecastChange } from "@ryu/blocks/desktop/usage-forecast.ts";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@ryu/ui/components/chart.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { formatCurrency, formatNumber } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useMemo, useState } from "react";
import {
	Area,
	CartesianGrid,
	ComposedChart,
	Line,
	XAxis,
	YAxis,
} from "recharts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	useHistoryTargetRevision,
	useUsageHistory,
} from "@/src/hooks/useUsageHistory.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type HistoryBucket,
	type HistoryImportReport,
	type HistoryImportRequest,
	type HistoryScope,
	historyProcessedTokens,
	type UsageHistoryReport,
} from "@/src/lib/api/usage-history.ts";
import { ProviderBrandLogo } from "@/src/lib/provider-brand.tsx";
import {
	type DailyForecast,
	forecastDailyValues,
	HISTORY_FORECAST_DAYS,
} from "./history-forecast.ts";
import {
	formatHistoryTokens,
	historyCounterDisplay,
} from "./history-format.ts";
import { UsageHistoryAccountImport } from "./UsageHistoryAccountImport.tsx";
import usageVisualStyles from "./usage-visual-indicators.module.css";
import type { UsageVisualStyle } from "./usage-visual-style.ts";

const COLORS = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
];
const PERIODS = [
	{ label: "All time", value: "all", days: null },
	{ label: "30 days", value: "30", days: 30 },
	{ label: "7 days", value: "7", days: 7 },
] as const;

const SCOPES = [
	{ value: "session", label: "Session history" },
	{ value: "account", label: "Account reports" },
	{ value: "organization", label: "Organization reports" },
	{ value: "unattributed", label: "Unattributed usage" },
	{ value: "unreconciled", label: "Unreconciled live usage" },
] as const satisfies readonly { value: HistoryScope; label: string }[];

function money(value: number | null): string {
	return value === null
		? "Unknown"
		: formatCurrency(value, "USD", {
				maximumFractionDigits: 2,
				minimumFractionDigits: 2,
			});
}

/**
 * The iOS segmented control for a one-of choice. Items stay `aria-pressed`
 * buttons (not tabs), so a choice keeps its button role and accessible name.
 */
function Segmented<TValue extends string>({
	className,
	label,
	onChange,
	options,
	value,
}: {
	className?: string;
	label: string;
	onChange: (value: TValue) => void;
	options: readonly { label: string; value: TValue }[];
	value: TValue;
}) {
	return (
		<ToggleGroup
			appearance="segmented"
			aria-label={label}
			className={cn("h-auto max-w-full flex-wrap", className)}
			multiple={false}
			onValueChange={(values: string[]) => {
				const next = options.find((option) => option.value === values[0]);
				if (next) {
					onChange(next.value);
				}
			}}
			spacing={0}
			value={[value]}
			variant="default"
		>
			{options.map((option) => (
				<ToggleGroupItem
					density="segmented"
					key={option.value}
					value={option.value}
				>
					{option.label}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}

/** A flat stat tile: no border or fill of its own, it sits inside one card. */
function Stat({
	label,
	value,
	detail,
	valueTestId,
}: {
	label: string;
	value: string;
	detail: string;
	valueTestId?: string;
}) {
	return (
		<div className="min-w-0">
			<div className="text-muted-foreground text-xs">{label}</div>
			<div
				className="mt-1 font-medium text-xl tabular-nums"
				data-testid={valueTestId}
			>
				{value}
			</div>
			<div className="type-caption mt-1 text-muted-foreground">{detail}</div>
		</div>
	);
}

function CounterCell({
	value,
	missing,
	records,
}: {
	value: number;
	missing: number | readonly number[];
	records: number;
}) {
	const display = historyCounterDisplay(value, missing, records);
	return (
		<span title={display.detail}>
			{display.value}
			{display.detail.endsWith("Partial") ? (
				<span className="type-compact block text-muted-foreground">
					Partial counters
				</span>
			) : null}
		</span>
	);
}

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

function DailyChart({
	report,
	scope,
}: {
	report: UsageHistoryReport;
	scope: HistoryScope;
}) {
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
														<span className="font-medium font-mono tabular-nums">
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
												title={`80% range ${format(forecast.forecast.total.lower, true)} – ${format(forecast.forecast.total.upper, true)}`}
											>
												· next {HISTORY_FORECAST_DAYS}d ≈{" "}
												{format(forecast.forecast.total.value)}{" "}
												<span className={change.tone}>{change.label}</span>
											</span>
										) : null}
									</span>
								);
							})}
						</div>
						{totalForecast ? (
							<div
								className="flex flex-wrap items-center justify-between gap-3 border-border/50 border-t pt-3 text-xs"
								data-testid="history-forecast"
							>
								<span>
									<span className="text-muted-foreground">
										Forecast · next {HISTORY_FORECAST_DAYS} days{" "}
									</span>
									<span className="font-medium tabular-nums">
										{format(totalForecast.forecast.total.value)}
									</span>
								</span>
								<span className="text-muted-foreground tabular-nums">
									80% range {format(totalForecast.forecast.total.lower)} –{" "}
									{format(totalForecast.forecast.total.upper)}
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

function Breakdown({
	report,
	scope,
}: {
	report: UsageHistoryReport;
	scope: HistoryScope;
}) {
	const [kind, setKind] = useState<"model" | "day">("model");
	const [all, setAll] = useState(false);
	const rows = kind === "model" ? report.summary.models : report.summary.daily;
	const shown = all ? rows : rows.slice(0, 20);
	return (
		<SettingsSection
			caption="Unknown prices and missing counters stay visible."
			headerAction={
				<Segmented
					label="Breakdown grouping"
					onChange={(value) => {
						setKind(value);
						setAll(false);
					}}
					options={[
						{ label: "By model", value: "model" },
						{ label: "By day", value: "day" },
					]}
					value={kind}
				/>
			}
			title="Usage breakdown"
		>
			<SettingsCard className="py-2">
				<div className="overflow-x-auto">
					<table className="w-full text-left text-xs">
						<caption className="sr-only">
							Historical usage grouped by {kind}
						</caption>
						<thead className="border-border/50 border-b text-muted-foreground">
							<tr>
								<th className="py-2 font-normal">
									{kind === "model"
										? "Model"
										: scope === "unattributed"
											? "Observed date"
											: "Date"}
								</th>
								<th className="px-3 font-normal">Source</th>
								<th className="px-3 text-right font-normal">
									{scope === "unattributed" ? "Ryu conversations" : "Sessions"}
								</th>
								<th className="px-3 text-right font-normal">Tokens</th>
								<th className="px-3 text-right font-normal">Cached input</th>
								<th className="py-2 text-right font-normal">API estimate</th>
							</tr>
						</thead>
						<tbody>
							{shown.map((row: HistoryBucket) => (
								<tr
									className="border-border/30 border-b last:border-0"
									key={`${row.date}:${row.sourceId}:${row.modelId}`}
								>
									<td className="py-3 font-medium">
										{kind === "model"
											? (row.modelId ?? "Unknown model")
											: row.date}
									</td>
									<td className="px-3 text-muted-foreground">
										{report.sources.find((source) => source.id === row.sourceId)
											?.label ?? row.sourceId}
									</td>
									<td className="px-3 text-right tabular-nums">
										{scope === "unattributed" &&
										row.records > 0 &&
										row.sessions === 0
											? "Not reported"
											: formatNumber(row.sessions)}
									</td>
									<td className="px-3 text-right tabular-nums">
										<CounterCell
											missing={[
												row.totals.missingInputRecords,
												row.totals.missingOutputRecords,
												row.totals.missingCacheReadRecords,
												row.totals.missingCacheWriteRecords,
											]}
											records={row.records}
											value={historyProcessedTokens(row.totals)}
										/>
									</td>
									<td className="px-3 text-right tabular-nums">
										<CounterCell
											missing={row.totals.missingCacheReadRecords}
											records={row.records}
											value={row.totals.cacheReadTokens}
										/>
									</td>
									<td className="text-right tabular-nums">
										{money(row.estimatedCostUsd)}
										{row.unpricedRecords ? (
											<span className="type-compact block text-muted-foreground">
												Partial estimate
											</span>
										) : null}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				{rows.length === 0 ? (
					<p className="py-6 text-center text-muted-foreground text-xs">
						No usage records in this period.
					</p>
				) : null}
				{rows.length > 20 ? (
					<Button
						className="mt-1"
						onClick={() => setAll(!all)}
						size="sm"
						variant="ghost"
					>
						{all ? "Show fewer" : `Show all ${formatNumber(rows.length)} rows`}
					</Button>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}

export interface UsageHistoryViewProps {
	days: number | null;
	error: string | null;
	importError: string | null;
	importing: boolean;
	importReport: HistoryImportReport | null;
	loading: boolean;
	onDaysChange: (days: number | null) => void;
	onImport: (request: HistoryImportRequest) => Promise<void>;
	onRefresh: () => void;
	refreshing: boolean;
	report: UsageHistoryReport | null;
	scope: HistoryScope;
}

export function UsageHistoryView({
	scope,
	report,
	loading,
	refreshing,
	error,
	importing,
	importReport,
	importError,
	days,
	onDaysChange,
	onRefresh,
	onImport,
}: UsageHistoryViewProps) {
	const [selected, setSelected] = useState<string[] | null>(null);
	const [path, setPath] = useState("");
	const [exportAccount, setExportAccount] = useState("");
	const [pathSource, setPathSource] = useState("");
	const sources = report?.sources ?? [];
	const localSources = sources.filter(
		(source) => source.transport === "localFiles"
	);
	const customSources = sources.filter(
		(source) =>
			(source.transport === "localFiles" && source.id !== "ryu-sessions") ||
			source.transport === "metadataExport"
	);
	const sourceIds =
		selected ??
		localSources
			.filter((source) => source.available)
			.map((source) => source.id);
	const summary = report?.summary;
	const counterFields = summary
		? [
				summary.totals.missingInputRecords,
				summary.totals.missingOutputRecords,
				summary.totals.missingCacheReadRecords,
				summary.totals.missingCacheWriteRecords,
			]
		: [];
	const missingCounters =
		counterFields.some((missing) => missing > 0) ||
		Boolean(
			summary?.totals.missingCachedOutputRecords ||
				summary?.totals.missingReasoningRecords
		);
	const counters = summary
		? {
				processed: historyCounterDisplay(
					historyProcessedTokens(summary.totals),
					counterFields,
					summary.records
				),
				input: historyCounterDisplay(
					summary.totals.inputTokens,
					summary.totals.missingInputRecords,
					summary.records
				),
				output: historyCounterDisplay(
					summary.totals.outputTokens,
					summary.totals.missingOutputRecords,
					summary.records
				),
				cacheRead: historyCounterDisplay(
					summary.totals.cacheReadTokens,
					summary.totals.missingCacheReadRecords,
					summary.records
				),
				cacheWrite: historyCounterDisplay(
					summary.totals.cacheWriteTokens,
					summary.totals.missingCacheWriteRecords,
					summary.records
				),
				cachedOutput: historyCounterDisplay(
					summary.totals.cachedOutputTokens,
					summary.totals.missingCachedOutputRecords,
					summary.records
				),
			}
		: null;
	const customSource = pathSource || customSources[0]?.id || "";
	const runImport = (retryFailed = false) => {
		void onImport({
			sourceIds,
			roots:
				path.trim() && customSource
					? [
							{
								sourceId: customSource,
								path: path.trim(),
								...(exportAccount.trim()
									? { accountId: exportAccount.trim() }
									: undefined),
							},
						]
					: [],
			maxFiles: 25,
			retryFailed,
		}).catch(() => undefined);
	};
	const sourceColor = (sourceId: string) =>
		COLORS[
			Math.max(
				0,
				sources.findIndex((item) => item.id === sourceId)
			) % COLORS.length
		];
	const overviewNotes = summary
		? [
				"List-price estimate. Subscription charges and invoices are separate.",
				summary.unpricedRecords
					? `${formatNumber(summary.unpricedRecords)} records have unknown prices.`
					: null,
				missingCounters
					? "Some records omit token counters. Totals include only reported values."
					: null,
			]
				.filter(Boolean)
				.join(" ")
		: undefined;
	return (
		<section
			aria-label="Historical usage"
			className="flex flex-col gap-6"
			data-testid="usage-history-dashboard"
		>
			<SettingsSection title="Import on this node">
				<SettingsGroup>
					{localSources.map((source) => (
						<SettingsItem
							actions={
								<span className="text-muted-foreground text-xs">
									{source.available ? "Found" : "No default history"}
								</span>
							}
							key={source.id}
							title={
								<label className="flex cursor-pointer items-center gap-2.5">
									<Checkbox
										checked={sourceIds.includes(source.id)}
										disabled={importing}
										onCheckedChange={(checked) =>
											setSelected(
												checked
													? [...sourceIds, source.id]
													: sourceIds.filter((id) => id !== source.id)
											)
										}
									/>
									{source.label}
								</label>
							}
						/>
					))}
					<details className="px-3.5 py-2.5" key="custom-location">
						<summary className="cursor-pointer text-sm">
							Custom location or provider metadata export
						</summary>
						<div className="mt-3 flex flex-wrap gap-2">
							<label className="sr-only" htmlFor="history-path-source">
								History source
							</label>
							<select
								className="h-9 rounded-lg border border-input bg-background px-2 text-xs"
								disabled={importing}
								id="history-path-source"
								onChange={(event) => setPathSource(event.target.value)}
								value={customSource}
							>
								{customSources.map((source) => (
									<option key={source.id} value={source.id}>
										{source.label}
									</option>
								))}
							</select>
							<label className="sr-only" htmlFor="history-scan-path">
								Explicit history path on selected node
							</label>
							<Input
								className="min-w-48 flex-1"
								disabled={importing}
								id="history-scan-path"
								onChange={(event) => setPath(event.target.value)}
								placeholder="Absolute path on the selected node"
								value={path}
							/>
							<label className="sr-only" htmlFor="history-export-account">
								Export account alias
							</label>
							<Input
								disabled={importing}
								id="history-export-account"
								onChange={(event) => setExportAccount(event.target.value)}
								placeholder="Account alias for provider exports"
								value={exportAccount}
							/>
						</div>
						<p className="mt-2 text-muted-foreground text-xs">
							Use a retained history folder or JSON usage export. Account
							reports require an export authorized by the account or
							organization owner.
						</p>
					</details>
					<SettingsItem
						actions={
							<div className="flex flex-wrap items-center justify-end gap-2">
								{importReport && importReport.errorCount > 0 ? (
									<Button
										disabled={importing}
										onClick={() => runImport(true)}
										size="sm"
										variant="outline"
									>
										Retry failed files
									</Button>
								) : null}
								<Button
									disabled={
										loading ||
										importing ||
										(sourceIds.length === 0 && !path.trim())
									}
									onClick={() => runImport()}
									size="sm"
								>
									{importing
										? "Importing…"
										: importReport?.hasMore
											? "Continue import"
											: "Import history"}
								</Button>
							</div>
						}
						description="Bring in usage from before you installed Ryu. Read-only scans store token metadata; prompts, messages, and credentials stay out of the usage ledger. Imports resume from saved checkpoints and skip unchanged records."
						key="import"
						title={`${formatNumber(sourceIds.length)} ${sourceIds.length === 1 ? "source" : "sources"} selected`}
					/>
				</SettingsGroup>
				{importError ? (
					<p className="px-3.5 text-destructive text-xs" role="alert">
						{importError}
					</p>
				) : null}
				{importReport ? (
					<SettingsCard className="text-xs">
						<div role="status">
							{importing ? (
								<p className="mb-1 text-muted-foreground">
									Import running on this node. Progress refreshes automatically.
								</p>
							) : null}
							<p>
								{formatNumber(importReport.importedRecords)} new records ·{" "}
								{formatNumber(importReport.updatedRecords)} updated ·{" "}
								{formatNumber(importReport.duplicateRecords)} unchanged ·{" "}
								{formatNumber(importReport.scannedFiles)} items scanned
							</p>
							{importReport.hasMore ? (
								<p className="mt-1 text-muted-foreground">
									More files remain. Continue import to resume.
								</p>
							) : null}
							{importReport.errorCount ? (
								<p className="mt-1 text-destructive">
									{formatNumber(importReport.errorCount)} files could not be
									read. {importReport.errors.slice(0, 2).join(" ")}
								</p>
							) : null}
						</div>
					</SettingsCard>
				) : null}
			</SettingsSection>

			<SettingsSection
				caption={overviewNotes}
				headerAction={
					<div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
						<Segmented
							label="History period"
							onChange={(value) =>
								onDaysChange(
									PERIODS.find((period) => period.value === value)?.days ?? null
								)
							}
							options={PERIODS}
							value={
								PERIODS.find((period) => period.days === days)?.value ?? "all"
							}
						/>
						<Button
							disabled={refreshing}
							onClick={onRefresh}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon icon={Refresh01Icon} size={16} />
							Refresh
						</Button>
					</div>
				}
				title="Overview"
			>
				{error ? (
					<SettingsGroup>
						<SettingsItem
							actions={
								<Button onClick={onRefresh} size="sm" variant="outline">
									Retry
								</Button>
							}
							title={
								<span
									className="text-status-destructive"
									role="alert"
									title={error}
								>
									{"Couldn't load usage history."}
								</span>
							}
						/>
					</SettingsGroup>
				) : null}
				{loading && !report ? (
					<SettingsCard>
						<SkeletonRows label="Loading usage history…" />
					</SettingsCard>
				) : null}
				{summary && counters ? (
					<SettingsCard className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3">
						<Stat
							detail={`${
								scope === "unattributed"
									? summary.records > 0 && summary.sessions === 0
										? "Ryu conversation count not reported"
										: `${formatNumber(summary.sessions)} retained Ryu conversations`
									: `${formatNumber(summary.sessions)} ${summary.sessions === 1 ? "session" : "sessions"}`
							} · ${formatNumber(summary.records)} usage records`}
							label="API-equivalent estimate"
							value={money(summary.estimatedCostUsd)}
							valueTestId="history-estimated-cost"
						/>
						<Stat
							detail={counters.processed.detail}
							label="Processed tokens"
							value={counters.processed.value}
						/>
						<Stat
							detail={`Read ${counters.cacheRead.detail} · Written ${counters.cacheWrite.detail}`}
							label="Cached input"
							value={counters.cacheRead.value}
						/>
						<Stat
							detail={counters.input.detail}
							label="Uncached input"
							value={counters.input.value}
						/>
						<Stat
							detail={`${counters.output.detail} · Cached output ${counters.cachedOutput.detail}`}
							label="Output"
							value={counters.output.value}
						/>
						<Stat
							detail={
								summary.unpricedRecords ||
								summary.totals.missingCacheReadRecords
									? "Known cache rates only · Partial estimate"
									: "Known cache rates only"
							}
							label="Estimated cache savings"
							value={
								summary.records > 0 &&
								summary.totals.missingCacheReadRecords === summary.records
									? "Unknown"
									: money(summary.cacheSavingsUsd)
							}
						/>
					</SettingsCard>
				) : null}
			</SettingsSection>

			{summary && report ? (
				<>
					{summary.sources.length > 0 ? (
						<SettingsSection title="Estimate by source">
							<SettingsGroup>
								{summary.sources.map((source) => (
									<SettingsItem
										actions={
											<span className="text-sm tabular-nums">
												{money(source.estimatedCostUsd)}
											</span>
										}
										key={source.sourceId}
										title={
											<span className="flex min-w-0 items-center gap-2">
												<span
													className={`size-2 shrink-0 rounded-full ${usageVisualStyles.sourceColor}`}
													style={
														// SAFETY: The literal satisfies full React CSSProperties and the named native CSS slots.
														// This checked owner assertion only clears fresh-literal metadata for React style.
														{
															"--usage-source-color": sourceColor(
																source.sourceId
															),
														} satisfies UsageVisualStyle as UsageVisualStyle
													}
												/>
												<ProviderBrandLogo
													providerKey={source.sourceId}
													size={16}
												/>
												<span className="truncate">
													{sources.find((item) => item.id === source.sourceId)
														?.label ?? source.sourceId}
												</span>
											</span>
										}
									/>
								))}
							</SettingsGroup>
						</SettingsSection>
					) : null}
					<SettingsSection title="Reported costs">
						<SettingsGroup>
							<SettingsItem
								actions={
									<span className="text-sm tabular-nums">
										{money(summary.sourceEstimatedCostUsd)}
									</span>
								}
								description="May be a tool estimate. No billed charge is inferred."
								title="Source-reported estimate"
							/>
							<SettingsItem
								actions={
									<span className="text-sm tabular-nums">
										{money(summary.billedCostUsd)}
									</span>
								}
								description="Only explicit billing fields. Separate usage and cost reports may cover the same activity."
								title="Provider-reported billed cost"
							/>
						</SettingsGroup>
					</SettingsSection>
					<DailyChart report={report} scope={scope} />
					<Breakdown report={report} scope={scope} />
					{summary.accounts?.some((account) => account.accountId) ? (
						// `data-slot="card"` scopes the recorded-accounts block (title and
						// rows) for the usage-history reconciliation proof.
						<div data-slot="card">
							<SettingsSection
								caption="Retained account IDs. Unknown identities are kept separate."
								title="Recorded accounts"
							>
								<SettingsGroup>
									{summary.accounts.map((account) => {
										const counter = historyCounterDisplay(
											historyProcessedTokens(account.totals),
											[
												account.totals.missingInputRecords,
												account.totals.missingOutputRecords,
												account.totals.missingCacheReadRecords,
												account.totals.missingCacheWriteRecords,
											],
											account.records
										);
										return (
											<SettingsItem
												key={JSON.stringify([
													account.sourceId,
													account.accountId ?? null,
												])}
												title={
													<span className="break-all">
														{account.accountId ?? "Account not retained"}
													</span>
												}
											>
												<p className="break-all text-muted-foreground text-xs">
													{account.sourceId} · {formatNumber(account.records)}{" "}
													usage records ·{" "}
													<span title={counter.detail}>{counter.value}</span>{" "}
													tokens
													{counter.detail.includes("Partial")
														? " · Partial"
														: null}
												</p>
											</SettingsItem>
										);
									})}
								</SettingsGroup>
							</SettingsSection>
						</div>
					) : null}
				</>
			) : null}
			{sources.length ? (
				<SettingsSection
					caption="Cursor and other account histories need authorized provider data. Signing in alone may expose current quota without historical tokens. Ryu does not read browser cookies or infer missing history."
					title="Source coverage and account access"
				>
					<SettingsGroup>
						{sources.map((source) => (
							<SettingsItem
								actions={
									<Badge variant="outline">
										{source.transport === "localFiles"
											? "Local history"
											: "Explicit export"}
									</Badge>
								}
								key={source.id}
								title={source.label}
							>
								<p className="text-muted-foreground text-xs">
									{source.limitations}
								</p>
							</SettingsItem>
						))}
					</SettingsGroup>
				</SettingsSection>
			) : null}
		</section>
	);
}

export function UsageHistoryDashboard({ target }: { target: ApiTarget }) {
	const [days, setDays] = useState<number | null>(null);
	const [scope, setScope] = useState<HistoryScope>("session");
	const history = useUsageHistory(target, days, scope);
	const revision = useHistoryTargetRevision(target);
	return (
		<div className="flex flex-col gap-6">
			<SettingsSection
				caption={
					scope === "unattributed"
						? "This usage lacks reliable native session, model, or usage-date attribution and may overlap other reports. Totals stay separate. Snapshot dates show when metadata was observed. Conversation counts include only retained Ryu conversation IDs."
						: scope === "unreconciled"
							? "These live turns retain their native session identity. Imported native history exists for the same session, but shared turn IDs were not retained to prove overlap. All unmatched live counters, including newer turns, stay here. Do not add this subtotal to Session history."
							: undefined
				}
				title="Usage history"
			>
				<Segmented
					label="History report scope"
					onChange={setScope}
					options={SCOPES}
					value={scope}
				/>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Track future ACP usage"
								checked={history.trackingEnabled}
								disabled={
									!history.trackingAvailable || history.trackingUpdating
								}
								onCheckedChange={(enabled) => {
									void history.toggleTracking(enabled);
								}}
							/>
						}
						description="Session history, account reports, and organization reports can overlap. Each view has its own totals. Future ACP tracking stores only reported model and token metadata. Live turns with unresolved native-history overlap stay in Unreconciled live usage and are excluded from Session history totals."
						title="Track future ACP usage"
					/>
				</SettingsGroup>
				{history.trackingError ? (
					<p className="px-3.5 text-destructive text-xs" role="alert">
						{history.trackingError}
					</p>
				) : null}
			</SettingsSection>
			<UsageHistoryView
				key={`${revision}:${scope}`}
				{...history}
				days={days}
				onDaysChange={setDays}
				onImport={history.runImport}
				onRefresh={history.refresh}
				scope={scope}
			/>
			<UsageHistoryAccountImport
				key={revision}
				nextCursor={history.nextCursor}
				onSync={history.syncAccount}
				pending={history.importing}
			/>
		</div>
	);
}
