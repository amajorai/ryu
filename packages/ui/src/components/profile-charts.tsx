"use client";

// Pure, presentational chart + ranked-list components for the profile stats
// panels (desktop Stats tab, web account Stats panel, public profile). They
// take numbers and render lightweight SVG/CSS — no data fetching, no effects,
// SSR-safe. Rendered in both apps so the visual language stays identical, the
// same way ContributionsGraph is. The donut and feature bars are hand-rolled so
// they don't depend on a charting library (and the ui package's recharts 3.8
// deprecates the `Cell` API they would otherwise need); the activity trend line
// uses the shared shadcn chart wrapper.

import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@ryu/ui/components/chart.tsx";
import { formatCount as formatSharedCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

// Vibrant, theme-agnostic palette. The app's global `--chart-*` tokens are
// intentionally monochrome, so these define their own colors (the same family
// the desktop dashboard chart widgets use). Mid-lightness oklch values read
// well on both light and dark backgrounds.
const PALETTE = [
	"oklch(0.62 0.19 256)", // blue
	"oklch(0.56 0.18 306)", // purple
	"oklch(0.64 0.21 1)", // pink
	"oklch(0.78 0.16 76)", // amber
	"oklch(0.7 0.12 182)", // teal
	"oklch(0.63 0.19 149)", // green
];

const formatSharedCountValue = (value: number): string =>
	formatSharedCount(value) ?? "—";

function EmptyPanel({ text }: { text: string }) {
	return (
		<div className="flex h-[200px] items-center justify-center text-muted-foreground text-sm">
			{text}
		</div>
	);
}

export interface TransportBreakdown {
	acp: number;
	gateway: number;
	openAiCompat: number;
	other: number;
}

const TRANSPORT_ORDER: Array<{ key: keyof TransportBreakdown; label: string }> =
	[
		{ key: "gateway", label: "Gateway" },
		{ key: "acp", label: "ACP" },
		{ key: "openAiCompat", label: "OpenAI-compatible" },
		{ key: "other", label: "Other" },
	];

/**
 * Donut of observed runs by transport (Gateway / ACP / OpenAI-compatible /
 * other), with the lifetime total in the center — a chart and a headline number
 * in one unit. Rendered as SVG ring segments with the center overlaid as HTML,
 * so the number never gets clipped by the canvas.
 */
export function TransportDonut({
	formatCount = formatSharedCountValue,
	transport,
}: {
	formatCount?: (value: number) => string;
	transport: TransportBreakdown;
}) {
	const data = TRANSPORT_ORDER.map(({ key, label }) => ({
		name: label,
		value: transport[key] ?? 0,
	})).filter((entry) => entry.value > 0);
	const total = data.reduce((sum, entry) => sum + entry.value, 0);

	if (data.length === 0) {
		return <EmptyPanel text="No transport data yet." />;
	}

	const size = 176;
	const stroke = 18;
	const radius = (size - stroke) / 2;
	const circumference = 2 * Math.PI * radius;
	// A tiny seam between segments reads as intentional spacing, not data loss.
	const seam = 2;
	let accumulated = 0;

	return (
		<div className="flex items-center justify-center">
			<div className="relative size-[176px]">
				<svg
					aria-label="Observed runs by transport"
					className="size-full -rotate-90"
					role="img"
					viewBox={`0 0 ${size} ${size}`}
				>
					<circle
						cx={size / 2}
						cy={size / 2}
						fill="none"
						r={radius}
						stroke="var(--color-muted)"
						strokeWidth={stroke}
					/>
					{data.map((entry, index) => {
						const segmentLength = (entry.value / total) * circumference;
						const visibleLength = Math.max(segmentLength - seam, 1);
						const offset = -accumulated;
						accumulated += segmentLength;
						return (
							<circle
								cx={size / 2}
								cy={size / 2}
								fill="none"
								key={entry.name}
								r={radius}
								stroke={PALETTE[index % PALETTE.length]}
								strokeDasharray={`${visibleLength} ${circumference - visibleLength}`}
								strokeDashoffset={offset}
								strokeWidth={stroke}
							>
								<title>{`${entry.name}: ${formatSharedCount(entry.value)}`}</title>
							</circle>
						);
					})}
				</svg>
				<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
					<span className="font-medium text-foreground text-xl tabular-nums">
						{formatCount(total)}
					</span>
					<span className="text-muted-foreground text-xs">observed runs</span>
				</div>
			</div>
		</div>
	);
}

export interface FeatureTotals {
	agentSeconds: number;
	chat: number;
	island: number;
	predictAccepted: number;
}

const BAR_CHART_HEIGHT = 132;

/**
 * Bar chart of lifetime usage split by feature (agent / chat / island /
 * autocomplete), one colored bar each. Agent seconds are shown as hours so the
 * four series share a comparable scale. Pure CSS bars — no charting library.
 */
export function FeatureMixBar({
	featureTotals,
}: {
	featureTotals: FeatureTotals;
}) {
	const data = [
		{ name: "Agent", value: Math.round(featureTotals.agentSeconds / 3600) },
		{ name: "Chat", value: featureTotals.chat },
		{ name: "Island", value: featureTotals.island },
		{ name: "Autocomplete", value: featureTotals.predictAccepted },
	];

	if (data.every((entry) => entry.value === 0)) {
		return <EmptyPanel text="No feature activity yet." />;
	}

	const maxValue = data.reduce((max, entry) => Math.max(max, entry.value), 0);

	return (
		<div className="flex h-[200px] items-end justify-center gap-5 px-2">
			{data.map((entry, index) => {
				const height =
					maxValue > 0
						? Math.max((entry.value / maxValue) * BAR_CHART_HEIGHT, 4)
						: 4;
				return (
					<div
						className="flex h-full flex-col items-center justify-end gap-2"
						key={entry.name}
					>
						<div
							aria-hidden="true"
							className="w-8 rounded-t-lg transition-all"
							style={{
								backgroundColor: PALETTE[index % PALETTE.length],
								height: `${height}px`,
							}}
							title={`${entry.name}: ${formatSharedCount(entry.value)}`}
						/>
						<span className="text-muted-foreground text-xs">{entry.name}</span>
					</div>
				);
			})}
		</div>
	);
}

export interface ActivityPoint {
	count: number;
	day: string;
}

/**
 * Area chart of per-day activity over the trailing `days` window — the numeric
 * rhythm behind the heatmap, as a smooth trend line.
 */
export function ActivityArea({
	data,
	days = 30,
	formatCount = formatSharedCountValue,
}: {
	data: ActivityPoint[];
	days?: number;
	formatCount?: (value: number) => string;
}) {
	const recent = data.slice(-days);

	if (recent.length === 0 || recent.every((entry) => entry.count === 0)) {
		return <EmptyPanel text="No recent activity yet." />;
	}

	const chartConfig = {
		count: {
			color: "oklch(0.62 0.19 256)",
			label: "Requests",
		},
	} satisfies ChartConfig;

	return (
		<ChartContainer className="h-[160px] w-full" config={chartConfig}>
			<AreaChart data={recent} margin={{ left: 8, right: 8 }}>
				<defs>
					<linearGradient
						id="profile-activity-fill"
						x1="0"
						x2="0"
						y1="0"
						y2="1"
					>
						<stop
							offset="5%"
							stopColor="var(--color-count)"
							stopOpacity={0.35}
						/>
						<stop
							offset="95%"
							stopColor="var(--color-count)"
							stopOpacity={0.03}
						/>
					</linearGradient>
				</defs>
				<CartesianGrid strokeOpacity={0.4} vertical={false} />
				<XAxis
					axisLine={false}
					dataKey="day"
					minTickGap={48}
					tickFormatter={(value: string) => value.slice(5)}
					tickLine={false}
					tickMargin={8}
				/>
				<YAxis
					axisLine={false}
					tickFormatter={(value) => formatCount(Number(value))}
					tickLine={false}
					width={40}
				/>
				<ChartTooltip content={<ChartTooltipContent />} cursor={false} />
				<Area
					dataKey="count"
					fill="url(#profile-activity-fill)"
					stroke="var(--color-count)"
					strokeWidth={2}
					type="monotone"
				/>
			</AreaChart>
		</ChartContainer>
	);
}

export interface RankedItem {
	count: number;
	id: string;
}

/**
 * A "most used X" leaderboard where every row carries a proportional bar — the
 * ranking as a mini bar chart, not just a pair of numbers.
 */
export function RankedList({
	empty,
	formatCount = formatSharedCountValue,
	icon,
	items,
	title,
}: {
	empty: string;
	formatCount?: (value: number) => string;
	icon?: ReactNode;
	items: RankedItem[];
	title: string;
}) {
	const maxCount = items.reduce((max, item) => Math.max(max, item.count), 0);

	return (
		<div className={cn("flex flex-col gap-3 rounded-2xl border bg-card p-4")}>
			<div className="flex items-center gap-2 font-medium text-sm">
				{icon}
				{title}
			</div>
			{items.length > 0 ? (
				<div className="space-y-2.5">
					{items.map((item) => {
						const share = maxCount > 0 ? (item.count / maxCount) * 100 : 0;
						return (
							<div className="space-y-1" key={item.id}>
								<div className="flex items-center justify-between gap-3 text-sm">
									<span className="truncate font-medium">{item.id}</span>
									<span className="shrink-0 text-muted-foreground tabular-nums">
										{formatCount(item.count)} runs
									</span>
								</div>
								<div
									aria-hidden="true"
									className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
								>
									<div
										className="h-full rounded-full bg-primary transition-all"
										style={{ width: `${share}%` }}
									/>
								</div>
							</div>
						);
					})}
				</div>
			) : (
				<p className="text-muted-foreground text-sm">{empty}</p>
			)}
		</div>
	);
}
