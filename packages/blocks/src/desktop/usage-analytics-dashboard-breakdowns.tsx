"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@ryu/ui/components/chart";
import { formatMicroUsd } from "@ryu/ui/lib/number-format.ts";
import type { ReactNode } from "react";
import { Pie, PieChart } from "recharts";
import { SettingsCard, SettingsSection } from "./settings-items.tsx";
import {
	isLabelledPurposeKey,
	PLUGIN_PURPOSE_LABEL,
	pluginIdForPurpose,
	type UsageAnalyticsData,
	type UsageBreakdownRow,
} from "./usage-analytics.ts";
import {
	CHART_COLORS,
	formatBreakdownValue,
	formatCompact,
	LocalizedLiteral,
	UsageMarker,
} from "./usage-analytics-dashboard-shared.tsx";

export function UsageDonut({
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

export function ActivityHeatmap({ data }: { data: UsageAnalyticsData }) {
	const tl = useLiteralMessages();
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
									title={tl("{label}: {count} requests", {
										count: formatCompact(point.requests),
										label: point.label,
									})}
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

/** Ranked request-share bars, used for feature and purpose attribution. */
export function FeatureMix({
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
export function PurposeLabel({ entry }: { entry: UsageBreakdownRow }) {
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

export function PurposeMix({ data }: { data: UsageBreakdownRow[] }) {
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

export function RankedBreakdown({
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
