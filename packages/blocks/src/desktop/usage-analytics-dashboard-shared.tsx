"use client";

import { useLocalizedText } from "@ryu/i18n/react";
import { formatCount, formatMicroUsd } from "@ryu/ui/lib/number-format.ts";
import type { ComponentProps, CSSProperties } from "react";
import type {
	UsageAnalyticsData,
	UsageBreakdownRow,
	UsageGranularity,
	UsageScope,
} from "./usage-analytics.ts";
import styles from "./usage-analytics-dashboard.module.css";
import type { UsageTrendMetric } from "./usage-trend-forecast.ts";

export const SCOPE_LABELS = {
	node: "This node",
	organization: "Organization",
	you: "You",
} satisfies Record<UsageScope, string>;

export const SCOPE_VALUES: UsageScope[] = ["you", "organization", "node"];
export const GRANULARITY_VALUES: UsageGranularity[] = [
	"15m",
	"hourly",
	"daily",
	"weekly",
	"monthly",
];

export const CHART_COLORS = [
	"#0099ff",
	"oklch(0.62 0.19 306)",
	"oklch(0.68 0.16 164)",
	"oklch(0.76 0.16 76)",
	"oklch(0.68 0.18 24)",
	"oklch(0.65 0.16 200)",
] as const;

export const KPI_COLORS = {
	"active days": "oklch(0.68 0.16 164)",
	"active members": "oklch(0.68 0.16 164)",
	"active nodes": "oklch(0.65 0.16 200)",
	"avg latency": "oklch(0.76 0.16 76)",
	"credit spend": "oklch(0.76 0.16 76)",
	errors: "oklch(0.68 0.18 24)",
	requests: "#0099ff",
	tokens: "oklch(0.62 0.19 306)",
} as const;

export type TrendMetric = UsageTrendMetric;

export interface UsageTrendMetricDefinition {
	color: string;
	key: TrendMetric;
	label: string;
}
export const TREND_METRICS = [
	{ color: KPI_COLORS.requests, key: "requests", label: "Requests" },
	{ color: KPI_COLORS.tokens, key: "tokens", label: "Tokens" },
	{ color: KPI_COLORS.errors, key: "errors", label: "Errors" },
	{ color: KPI_COLORS["credit spend"], key: "spend", label: "Credit spend" },
] as const satisfies readonly UsageTrendMetricDefinition[];

export interface UsageMarkerStyle extends CSSProperties {
	"--usage-marker-background": string | undefined;
	"--usage-marker-foreground": string | undefined;
	"--usage-marker-opacity": number | undefined;
	"--usage-marker-width": string | undefined;
}
export interface UsageMarkerProps
	extends Omit<ComponentProps<"span">, "style" | "color" | "ref"> {
	backgroundColor?: string;
	color?: string;
	element?: "span" | "div";
	opacity?: number;
	width?: string;
}
export function UsageMarker({
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

export function formatCompact(value: number): string {
	return formatCount(value) ?? "—";
}

export function formatMilliseconds(value: number | null): string {
	return value === null ? "—" : `${formatCompact(value)} ms`;
}

export function formatSpend(value: number | null): string {
	return value === null ? "Not billed" : formatMicroUsd(value);
}

export function trendMetricTotal(
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

export function formatTrendValue(metric: TrendMetric, value: number): string {
	// Forecasts are fractional; counts read as whole requests, tokens, errors.
	return metric === "spend"
		? formatMicroUsd(value)
		: formatCompact(Math.round(value));
}

export function formatBreakdownValue(entry: UsageBreakdownRow): string {
	const requests = `${formatCompact(entry.requests)} req`;
	return entry.spendMicroUsd === null
		? requests
		: `${formatMicroUsd(entry.spendMicroUsd)} · ${requests}`;
}

export function KpiCard({
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

export function MetricTile({
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

export function TrendTooltipRow({
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

/** Route an English source literal through the shared i18n literal boundary. */
export function LocalizedLiteral({ value }: { value: string }) {
	return <>{useLocalizedText(value, { literal: true })}</>;
}
