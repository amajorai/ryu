"use client";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties } from "react";
import styles from "./usage.module.css";

interface UsageMetricStyle extends CSSProperties {
	"--usage-metric-color": string;
}

// Presentational layer of the desktop Usage tab. The live app
// (`apps/desktop/src/pages/UsagePage.tsx`) is a thin container that loads via
// `useUsageStatement()`; the storyboard renders this same component with mock
// data. One source of truth, so editing this block changes the real desktop too.
//
// Deliberately NOT a `<Table>`: desktop has no table convention, and the sibling
// `credits.tsx` renders its ledger as a div list. A statement that looks like a
// spreadsheet in one settings tab and a list in the next reads as two different
// products.

import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@ryu/ui/components/chart";
import { Spinner } from "@ryu/ui/components/spinner";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { formatMicroUsd } from "./credits.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./settings-items.tsx";
import { ledgerProviderLabel, RYU_ROUTER_LABEL } from "./usage-analytics.ts";
import {
	UsageAnalyticsDashboard,
	type UsageAnalyticsDashboardProps,
} from "./usage-analytics-dashboard.tsx";

/** Ledger reason → the words a customer would use. */
const REASON_LABELS = new Map(
	Object.entries({
		adjustment: "Adjustment",
		box: "Box compute and storage",
		campaign_grant: "Campaign credit",
		composio: "Tool calls",
		composed_tool_earnings: "Composed tool earnings",
		connect_composed: "Composed tool fees",
		connect_native: "Connect tool calls",
		connect_vendor: "Connect vendor calls (Ryu key)",
		gateway_usage: "Model usage",
		mail: "Mail overage",
		managed_agents: "Managed Agents",
		messaging: "Messaging (SMS, WhatsApp, voice)",
		notify: "Notify events",
		openrouter: "Model usage",
		passport: "Passport connections and fetches",
		plan_grant: "Plan credit",
		referral_grant: "Referral credit",
		sandbox: "Sandbox compute",
		subscription_offset: "Subscription offset",
		topup: "Top-up",
		transfer_in: "Transfer in",
		transfer_out: "Transfer out",
		web_search: "Web search",
	})
);

export const usageReasonLabel = (reason: string): string =>
	REASON_LABELS.get(reason) ?? reason;

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
	upstreamProvider: string | null;
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
		<div className="flex min-w-0 flex-col gap-2">
			<span className="flex items-center gap-2 text-muted-foreground text-xs">
				<span
					aria-hidden="true"
					className={cn("size-2 shrink-0 rounded-full", styles.metricDot)}
					style={
						{
							"--usage-metric-color": color,
						} satisfies UsageMetricStyle as UsageMetricStyle
					}
				/>
				{label}
			</span>
			<span className="font-medium text-lg tabular-nums">{value}</span>
		</div>
	);
}

type UsageBreakdownKind = "model" | "provider" | "reason";

const BREAKDOWN_TITLES = {
	model: "By model",
	provider: "By provider",
	reason: "By type",
} satisfies Record<UsageBreakdownKind, string>;

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
	if (kind === "reason") {
		return usageReasonLabel(key);
	}
	return kind === "provider" ? ledgerProviderLabel(key) : key;
}

function UsageBreakdownChart({
	kind,
	rows,
}: {
	kind: UsageBreakdownKind;
	rows: UsageBreakdownRow[];
}) {
	const tl = useLiteralMessages();
	const shown = rows.filter((row) => row.amountMicroUsd > 0).slice(0, 6);
	const title = BREAKDOWN_TITLES[kind];
	const total = shown.reduce((sum, row) => sum + row.amountMicroUsd, 0);
	const chartData = shown.map((row) => ({
		amount: row.amountMicroUsd,
		count: row.count,
		label: breakdownLabel(kind, row.key),
	}));

	return (
		<SettingsCard className="flex h-full flex-col gap-4">
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
					aria-label={tl("{title} credit spend chart", { title })}
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
		</SettingsCard>
	);
}

function UsageAnalytics({ summary }: { summary: UsageSummaryData }) {
	const tl = useLiteralMessages();
	return (
		<section aria-label="Credit usage analytics">
			<SettingsSection
				caption="Where this organization's credits are being spent."
				title="Credit usage analytics"
			>
				<SettingsCard className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
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
				</SettingsCard>
				<div className="grid gap-3 md:grid-cols-3">
					{(
						[
							["reason", summary.byReason],
							["model", summary.byModel],
							["provider", summary.byProvider],
						] as const
					).map(([kind, rows]) => (
						<div
							aria-label={tl("{title} credit spend chart", {
								title: BREAKDOWN_TITLES[kind],
							})}
							data-testid={`usage-chart-${kind}`}
							key={kind}
							role="group"
						>
							<UsageBreakdownChart kind={kind} rows={rows} />
						</div>
					))}
				</div>
			</SettingsSection>
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
	const providerName = row.provider && ledgerProviderLabel(row.provider);
	// Ryu Router never names the supplier that served a request, so the
	// upstream ("via …") is shown only for traffic that is not Ryu Router's.
	const provider =
		row.upstreamProvider && providerName !== RYU_ROUTER_LABEL
			? `${providerName ?? "Provider"} via ${row.upstreamProvider}`
			: providerName;
	const meta = [provider, tokens, formatDurationMs(row.durationMs)].filter(
		(part): part is string => Boolean(part) && part !== "—"
	);
	return (
		<div className="flex items-start justify-between gap-3 px-3.5 py-2.5">
			<div className="flex min-w-0 flex-col gap-1">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant={row.isCredit ? "default" : "secondary"}>
						{usageReasonLabel(row.reason)}
					</Badge>
					{row.model ? (
						<span className="truncate font-medium text-sm" title={row.model}>
							{row.model}
						</span>
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
						row.isCredit ? "text-status-success" : "text-foreground"
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
		<div className="flex flex-col gap-6" data-testid="credit-usage-view">
			{errorMessage ? (
				<SettingsGroup>
					<SettingsItem
						actions={
							<Button
								disabled={loading}
								onClick={onRefresh}
								size="sm"
								type="button"
								variant="outline"
							>
								Retry
							</Button>
						}
						title={
							<span className="text-status-destructive" title={errorMessage}>
								{"Couldn't load usage."}
							</span>
						}
					/>
				</SettingsGroup>
			) : null}

			{analyticsDashboard ? (
				<UsageAnalyticsDashboard {...analyticsDashboard} />
			) : null}

			{summary ? <UsageAnalytics summary={summary} /> : null}

			<SettingsSection
				headerAction={
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
				}
				title="Transactions"
			>
				{loading && rows.length === 0 ? (
					<SettingsCard className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
						<Spinner />
						Loading usage…
					</SettingsCard>
				) : null}

				{!loading && rows.length === 0 ? (
					<SettingsCard className="py-6 text-center text-muted-foreground text-sm">
						No usage yet. Spend on models, tools or sandboxes will appear here
						with what it was for.
					</SettingsCard>
				) : null}

				{rows.length > 0 ? (
					<SettingsGroup>
						{rows.map((row) => (
							<UsageRowItem key={row.id} row={row} />
						))}
						{hasMore ? (
							<div className="flex justify-center py-1.5" key="load-more">
								<Button
									disabled={loadingMore}
									onClick={onLoadMore}
									size="sm"
									type="button"
									variant="ghost"
								>
									{loadingMore ? "Loading…" : "Load more"}
								</Button>
							</div>
						) : null}
					</SettingsGroup>
				) : null}
			</SettingsSection>
		</div>
	);
}
