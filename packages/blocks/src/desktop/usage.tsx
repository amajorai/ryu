"use client";

// Presentational layer of the desktop Usage tab. The live app
// (`apps/desktop/src/pages/UsagePage.tsx`) is a thin container that loads via
// `useUsageStatement()`; the storyboard renders this same component with mock
// data. One source of truth, so editing this block changes the real desktop too.
//
// Deliberately NOT a `<Table>`: desktop has no table convention, and the sibling
// `credits.tsx` renders its ledger as a div list. A statement that looks like a
// spreadsheet in one settings tab and a list in the next reads as two different
// products.

import { Alert02Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@ryu/ui/components/chart";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Separator } from "@ryu/ui/components/separator";
import { Spinner } from "@ryu/ui/components/spinner";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { formatMicroUsd } from "./credits.tsx";
import {
	UsageAnalyticsDashboard,
	type UsageAnalyticsDashboardProps,
} from "./usage-analytics-dashboard.tsx";

/** Ledger reason → the words a customer would use. */
const REASON_LABELS: Record<string, string> = {
	adjustment: "Adjustment",
	campaign_grant: "Campaign credit",
	composio: "Tool calls",
	gateway_usage: "Model usage",
	openrouter: "Model usage",
	plan_grant: "Plan credit",
	referral_grant: "Referral credit",
	sandbox: "Sandbox compute",
	subscription_offset: "Subscription offset",
	topup: "Top-up",
	transfer_in: "Transfer in",
	transfer_out: "Transfer out",
};

export const usageReasonLabel = (reason: string): string =>
	REASON_LABELS[reason] ?? reason;

/**
 * Milliseconds → a compact duration. Null renders as an em dash, never "0ms":
 * a row with no measured duration did not take no time, it was not timed.
 */
export function formatDurationMs(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms)) {
		return "—";
	}
	if (ms < 1000) {
		return `${Math.round(ms)}ms`;
	}
	const seconds = ms / 1000;
	if (seconds < 60) {
		return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	}
	return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** One row of the statement, already mapped by the container. */
export interface UsageRow {
	balanceAfter: number;
	createdAtLabel: string;
	delta: number;
	durationMs: number | null;
	id: string;
	inputTokens: number | null;
	isCredit: boolean;
	model: string | null;
	outputTokens: number | null;
	provider: string | null;
	reason: string;
	taskLabel: string | null;
}

export interface UsageSummaryData {
	byModel: UsageBreakdownRow[];
	byProvider: UsageBreakdownRow[];
	byReason: UsageBreakdownRow[];
	creditedMicroUsd: number;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	spentMicroUsd: number;
	transactions: number;
}

export interface UsageBreakdownRow {
	amountMicroUsd: number;
	count: number;
	key: string | null;
}

function SummaryTile({
	color,
	label,
	value,
}: {
	color: string;
	label: string;
	value: string;
}) {
	return (
		<div className="flex flex-col gap-2 rounded-3xl border border-border/60 bg-card/80 p-4 shadow-sm">
			<span className="flex items-center gap-2 text-muted-foreground text-xs">
				<span
					aria-hidden="true"
					className="size-2 shrink-0 rounded-full"
					style={{ backgroundColor: color }}
				/>
				{label}
			</span>
			<span className="font-medium text-lg tabular-nums">{value}</span>
		</div>
	);
}

type UsageBreakdownKind = "model" | "provider" | "reason";

const BREAKDOWN_TITLES: Record<UsageBreakdownKind, string> = {
	model: "By model",
	provider: "By provider",
	reason: "By type",
};

const USAGE_CHART_CONFIG = {
	amount: {
		color: "var(--chart-1)",
		label: "Credit spend",
	},
} satisfies ChartConfig;

function breakdownLabel(kind: UsageBreakdownKind, key: string | null): string {
	if (key === null) {
		return "Unattributed";
	}
	return kind === "reason" ? usageReasonLabel(key) : key;
}

function UsageBreakdownChart({
	kind,
	rows,
}: {
	kind: UsageBreakdownKind;
	rows: UsageBreakdownRow[];
}) {
	const shown = rows.filter((row) => row.amountMicroUsd > 0).slice(0, 6);
	const title = BREAKDOWN_TITLES[kind];
	const total = shown.reduce((sum, row) => sum + row.amountMicroUsd, 0);
	const chartData = shown.map((row) => ({
		amount: row.amountMicroUsd,
		count: row.count,
		label: breakdownLabel(kind, row.key),
	}));

	return (
		<div
			aria-label={`${title} credit spend chart`}
			className="flex flex-col gap-4 rounded-3xl border border-border/60 bg-card/80 p-4 shadow-sm"
			data-testid={`usage-chart-${kind}`}
			role="group"
		>
			<div className="flex items-start justify-between gap-2">
				<div className="flex flex-col gap-1">
					<span className="font-medium text-sm">{title}</span>
					<span className="text-muted-foreground text-xs">Credit spend</span>
				</div>
				<span className="font-medium text-sm tabular-nums">
					{formatMicroUsd(total)}
				</span>
			</div>
			{shown.length > 0 ? (
				<ChartContainer
					aria-label={`${title} credit spend chart`}
					className="h-[190px] min-h-[190px] w-full"
					config={USAGE_CHART_CONFIG}
				>
					<BarChart
						accessibilityLayer
						barCategoryGap="24%"
						data={chartData}
						layout="vertical"
						margin={{ bottom: 4, left: 0, right: 8, top: 4 }}
					>
						<CartesianGrid horizontal={false} />
						<XAxis domain={[0, "dataMax"]} hide type="number" />
						<YAxis
							axisLine={false}
							dataKey="label"
							tick={{ fontSize: 11 }}
							tickLine={false}
							type="category"
							width={96}
						/>
						<ChartTooltip
							content={
								<ChartTooltipContent
									formatter={(value) => formatMicroUsd(Number(value))}
									indicator="line"
								/>
							}
						/>
						<Bar
							dataKey="amount"
							fill="var(--color-amount)"
							maxBarSize={24}
							radius={[0, 4, 4, 0]}
						/>
					</BarChart>
				</ChartContainer>
			) : (
				<p className="text-muted-foreground text-xs">
					No credit spend recorded yet.
				</p>
			)}
		</div>
	);
}

function UsageAnalytics({ summary }: { summary: UsageSummaryData }) {
	return (
		<section
			aria-label="Credit usage analytics"
			className="flex flex-col gap-3"
		>
			<div>
				<h4 className="font-medium text-sm">Credit usage analytics</h4>
				<p className="text-muted-foreground text-xs">
					Where this organization&apos;s credits are being spent.
				</p>
			</div>
			<div className="grid gap-2 md:grid-cols-3">
				{(
					[
						["reason", summary.byReason],
						["model", summary.byModel],
						["provider", summary.byProvider],
					] as const
				).map(([kind, rows]) => (
					<UsageBreakdownChart key={kind} kind={kind} rows={rows} />
				))}
			</div>
		</section>
	);
}

function UsageRowItem({ row }: { row: UsageRow }) {
	const tokens =
		row.inputTokens === null && row.outputTokens === null
			? null
			: `${formatNumber(row.inputTokens ?? 0)} in · ${formatNumber(
					row.outputTokens ?? 0
				)} out`;
	// Only the facts this row actually has. An absent model or duration is left
	// OUT rather than shown as a dash-filled column, because a list row (unlike a
	// table) has no column to keep aligned and empty slots just add noise.
	const meta = [row.provider, tokens, formatDurationMs(row.durationMs)].filter(
		(part): part is string => Boolean(part) && part !== "—"
	);
	return (
		<div className="flex items-start justify-between gap-3 py-2.5">
			<div className="flex min-w-0 flex-col gap-1">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant={row.isCredit ? "default" : "secondary"}>
						{usageReasonLabel(row.reason)}
					</Badge>
					{row.model ? (
						<span className="truncate font-medium text-sm">{row.model}</span>
					) : null}
					{row.taskLabel ? (
						<span className="text-muted-foreground text-xs">
							{row.taskLabel}
						</span>
					) : null}
				</div>
				<span className="text-muted-foreground text-xs">
					{[row.createdAtLabel, ...meta].join(" · ")}
				</span>
			</div>
			<div className="flex shrink-0 flex-col items-end gap-0.5">
				{/* Sign carried by the glyph as well as the colour, so the row still
				    reads correctly in greyscale or to a colour-blind reader. */}
				<span
					className={`font-medium text-sm tabular-nums ${
						row.isCredit
							? "text-green-600 dark:text-green-400"
							: "text-foreground"
					}`}
				>
					{row.isCredit ? "+" : "−"}
					{formatMicroUsd(Math.abs(row.delta))}
				</span>
				<span className="text-muted-foreground text-xs tabular-nums">
					{formatMicroUsd(row.balanceAfter)}
				</span>
			</div>
		</div>
	);
}

export function UsageView({
	analyticsDashboard,
	errorMessage,
	hasMore,
	loading,
	loadingMore,
	onLoadMore,
	onRefresh,
	rows,
	summary,
}: {
	analyticsDashboard?: UsageAnalyticsDashboardProps;
	errorMessage?: string | null;
	hasMore: boolean;
	loading: boolean;
	loadingMore: boolean;
	onLoadMore: () => void;
	onRefresh: () => void;
	rows: UsageRow[];
	summary: UsageSummaryData | null;
}) {
	return (
		<div className="flex flex-col gap-4" data-testid="credit-usage-view">
			<div className="flex items-center justify-between gap-2">
				<div className="flex flex-col">
					<h3 className="font-medium text-base">Usage</h3>
					<p className="text-muted-foreground text-sm">
						Explore consumption across your profile, organization, or this node.
					</p>
				</div>
				<Button
					disabled={loading}
					onClick={onRefresh}
					size="sm"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon icon={Refresh01Icon} size={16} />
					Refresh
				</Button>
			</div>

			{errorMessage ? (
				<div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive text-sm">
					<HugeiconsIcon icon={Alert02Icon} size={16} />
					{errorMessage}
				</div>
			) : null}

			{analyticsDashboard ? (
				<UsageAnalyticsDashboard {...analyticsDashboard} />
			) : null}

			{summary ? (
				<>
					<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
						<SummaryTile
							color="oklch(0.76 0.16 76)"
							label="Spent"
							value={formatMicroUsd(summary.spentMicroUsd)}
						/>
						<SummaryTile
							color="oklch(0.68 0.16 164)"
							label="Credited"
							value={formatMicroUsd(summary.creditedMicroUsd)}
						/>
						<SummaryTile
							color="#0099ff"
							label="Tokens"
							value={formatNumber(summary.inputTokens + summary.outputTokens)}
						/>
						<SummaryTile
							color="oklch(0.62 0.19 306)"
							label="Billed time"
							value={formatDurationMs(summary.durationMs)}
						/>
					</div>
					<UsageAnalytics summary={summary} />
				</>
			) : null}

			{loading && rows.length === 0 ? (
				<div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
					<Spinner />
					Loading usage…
				</div>
			) : null}

			{!loading && rows.length === 0 ? (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={Alert02Icon} size={20} />
						</EmptyMedia>
						<EmptyTitle>No usage yet</EmptyTitle>
						<EmptyDescription>
							Spend on models, tools or sandboxes will appear here with what it
							was for.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button onClick={onRefresh} size="sm" variant="ghost">
							Refresh usage
						</Button>
					</EmptyContent>
				</Empty>
			) : null}

			{rows.length > 0 ? (
				<div className="flex flex-col divide-y rounded-lg border px-3">
					{rows.map((row) => (
						<UsageRowItem key={row.id} row={row} />
					))}
				</div>
			) : null}

			{hasMore ? (
				<>
					<Separator />
					<div className="flex justify-center">
						<Button
							disabled={loadingMore}
							onClick={onLoadMore}
							size="sm"
							type="button"
							variant="outline"
						>
							{loadingMore ? "Loading…" : "Load more"}
						</Button>
					</div>
				</>
			) : null}
		</div>
	);
}
