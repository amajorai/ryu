import { cn } from "@ryu/ui/lib/utils";
import styles from "./elements-one.module.css";
import type { AgentGeometryStyle } from "./elements-one-style.ts";
import {
	formatUsageReset,
	usagePercent,
	usageTimeCursor,
} from "./stats-footer-format.ts";
import type {
	deriveSessionStats,
	StatsPreferences,
	StatsUsageMetric,
} from "./stats-model.ts";

export function MetricChip({
	label,
	value,
	testId,
}: {
	label: string;
	testId?: string;
	value: string | null;
}) {
	if (!value) {
		return null;
	}
	return (
		<span
			className="inline-flex items-center gap-1 rounded-lg bg-muted px-1.5 py-0.5 text-muted-foreground text-xs tabular-nums"
			data-testid={testId}
		>
			<span className="text-muted-foreground">{label}</span>
			<span className="text-foreground">{value}</span>
		</span>
	);
}

export function DetailRow({
	label,
	value,
}: {
	label: string;
	value: string | null;
}) {
	if (!value) {
		return null;
	}
	return (
		<div className="flex items-center justify-between gap-6">
			<span className="text-muted-foreground">{label}</span>
			<span className="font-mono text-foreground tabular-nums">{value}</span>
		</div>
	);
}

function UsageBar({
	label,
	metric,
	now,
	preferences,
	testId,
}: {
	label: string;
	metric: StatsUsageMetric | undefined;
	now: number;
	preferences: StatsPreferences;
	testId: string;
}) {
	if (!metric || metric.percent === undefined) {
		return null;
	}
	const cursor = usageTimeCursor(metric, now);
	const percent = usagePercent(metric.percent, preferences.usagePercentMode);
	return (
		<div className="mt-1.5" data-testid={testId}>
			<div className="mb-1 flex items-center justify-between gap-3">
				<span className="text-muted-foreground">{label}</span>
				<span className="font-mono text-foreground tabular-nums">
					{percent}
				</span>
			</div>
			<div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
				<div
					className={cn(
						styles.widthTransition,
						"h-full rounded-full bg-primary"
					)}
					style={
						{
							"--agent-width": `${percent ? Number.parseInt(percent, 10) : 0}%`,
						} satisfies AgentGeometryStyle as AgentGeometryStyle
					}
				/>
				{preferences.usageShowTimeCursor && cursor !== undefined ? (
					<div
						className={cn(
							styles.cursor,
							"absolute inset-y-0 w-px bg-foreground/70"
						)}
						style={
							{
								"--agent-cursor": `${cursor}%`,
							} satisfies AgentGeometryStyle as AgentGeometryStyle
						}
					/>
				) : null}
			</div>
		</div>
	);
}

export function UsageDetails({
	now,
	preferences,
	usage,
}: {
	now: number;
	preferences: StatsPreferences;
	usage: ReturnType<typeof deriveSessionStats>["usage"];
}) {
	if (!usage) {
		return null;
	}
	return (
		<>
			<UsageBar
				label="Session Usage"
				metric={usage.session}
				now={now}
				preferences={preferences}
				testId="stats-session-usage-bar"
			/>
			<DetailRow
				label="Session Reset Timer"
				value={formatUsageReset(usage.session, now, preferences)}
			/>
			<UsageBar
				label="Weekly Usage"
				metric={usage.weekly}
				now={now}
				preferences={preferences}
				testId="stats-weekly-usage-bar"
			/>
			<DetailRow
				label="Weekly Reset Timer"
				value={formatUsageReset(usage.weekly, now, preferences)}
			/>
			<DetailRow
				label="Weekly Sonnet Usage"
				value={
					usage.sonnet
						? `${usagePercent(usage.sonnet.percent, preferences.usagePercentMode)}`
						: null
				}
			/>
			<DetailRow
				label="Weekly Opus Usage"
				value={
					usage.opus
						? `${usagePercent(usage.opus.percent, preferences.usagePercentMode)}`
						: null
				}
			/>
			<DetailRow
				label="Weekly Fable Usage"
				value={
					usage.fable
						? `${usagePercent(usage.fable.percent, preferences.usagePercentMode)}`
						: null
				}
			/>
			<DetailRow
				label="Extra Usage Utilization"
				value={
					usage.extraUtilization === undefined
						? null
						: usagePercent(usage.extraUtilization, preferences.usagePercentMode)
				}
			/>
			<DetailRow
				label="Extra Usage Remaining"
				value={
					usage.extraRemaining === undefined
						? null
						: `${usage.extraRemaining.toFixed(2)}${usage.extraCurrency ? ` ${usage.extraCurrency}` : ""}`
				}
			/>
			<DetailRow
				label="Extra Usage Used"
				value={
					usage.extraUsed === undefined
						? null
						: `${usage.extraUsed.toFixed(2)}${usage.extraCurrency ? ` ${usage.extraCurrency}` : ""}`
				}
			/>
			<DetailRow
				label="Block Timer"
				value={formatUsageReset(usage.blockTimer, now, preferences)}
			/>
			<DetailRow
				label="Block Reset Timer"
				value={formatUsageReset(usage.blockReset, now, preferences)}
			/>
		</>
	);
}
