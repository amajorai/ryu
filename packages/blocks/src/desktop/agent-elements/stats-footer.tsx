import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card";
import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useMemo, useState } from "react";
import styles from "./elements-one.module.css";
import type { AgentGeometryStyle } from "./elements-one-style.ts";
import {
	compactionValue,
	formatCost,
	formatPercent,
	formatPercentagePoints,
	formatSpeed,
	readPreferences,
	STORAGE_KEY,
	timerLabel,
	usagePercent,
} from "./stats-footer-format.ts";
import { DetailRow, MetricChip, UsageDetails } from "./stats-footer-parts.tsx";
import { StatsPreferencesPanel } from "./stats-footer-preferences.tsx";
import {
	deriveSessionStats,
	formatStatsCount,
	type StatsMessage,
	type StatsPreferences,
	type StatsUsageSnapshot,
} from "./stats-model.ts";

export function StatsFooter({
	className,
	contextFallback,
	contextSize,
	conversationMessages,
	isMainChainActive = false,
	modelName,
	usage,
}: {
	className?: string;
	contextFallback?: number;
	contextSize?: number;
	conversationMessages: readonly StatsMessage[];
	isMainChainActive?: boolean;
	modelName?: string;
	usage?: StatsUsageSnapshot | null;
}) {
	const [preferences, setPreferencesState] = useState(readPreferences);
	const [now, setNow] = useState(() => Date.now());
	const setPreferences = (next: Partial<StatsPreferences>) => {
		setPreferencesState((current) => ({ ...current, ...next }));
	};
	useEffect(() => {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
	}, [preferences]);
	useEffect(() => {
		if (!preferences.showCacheTimer) {
			return;
		}
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [preferences.showCacheTimer]);
	// The transcript walk is intentionally independent of the one-second display
	// clock in the default configuration. Only the opt-in rolling speed window
	// needs samples re-filtered as time advances; cache/usage countdowns below are
	// derived from already-aggregated anchors in O(1).
	const derivationClock =
		preferences.rollingWindowSeconds > 0 ? now : undefined;
	const staticStats = useMemo(
		() =>
			deriveSessionStats(conversationMessages, {
				contextFallback,
				contextWindowOverride: contextSize,
				isMainChainActive,
				modelName,
				now: derivationClock ?? Date.now(),
				preferences,
				usage,
			}),
		[
			conversationMessages,
			contextFallback,
			contextSize,
			isMainChainActive,
			modelName,
			derivationClock,
			preferences,
			usage,
		]
	);
	const stats = useMemo(() => {
		const cacheTimer = staticStats.cacheTimer;
		if (!(cacheTimer && preferences.showCacheTimer)) {
			return staticStats;
		}
		const remainingMs =
			cacheTimer.anchorAt + preferences.cacheTimerTtlMinutes * 60_000 - now;
		return {
			...staticStats,
			cacheTimer: {
				...cacheTimer,
				remainingMs: isMainChainActive ? null : Math.max(0, remainingMs),
				state: isMainChainActive
					? ("hot" as const)
					: remainingMs > 0
						? ("countdown" as const)
						: ("cold" as const),
			},
		};
	}, [isMainChainActive, now, preferences, staticStats]);
	const contextBarWidth = Math.max(0, Math.min(100, stats.contextPercent ?? 0));
	const compactions = compactionValue(stats, preferences);
	const timer = timerLabel(stats, preferences);
	const show = (value: string | null) =>
		preferences.hideEmpty && !value ? null : value;
	const usageSummary = stats.usage;
	return (
		<HoverCard>
			<HoverCardTrigger
				appearance="statistics"
				className={cn(
					"flex min-w-0 select-none flex-wrap items-center",
					className
				)}
				closeDelay={80}
				delay={120}
			>
				<span className="mr-0.5 text-muted-foreground/70 text-xs">Stats</span>
				<MetricChip
					label="Turns"
					testId="stats-turns"
					value={show(formatStatsCount(stats.turns))}
				/>
				<MetricChip
					label="Steps"
					testId="stats-steps"
					value={show(formatStatsCount(stats.steps))}
				/>
				<MetricChip
					label="Input"
					testId="stats-input"
					value={formatStatsCount(stats.inputTokens)}
				/>
				<MetricChip
					label="Output"
					testId="stats-output"
					value={formatStatsCount(stats.outputTokens)}
				/>
				<MetricChip
					label="Cached"
					testId="stats-cached"
					value={formatStatsCount(stats.cacheRead)}
				/>
				<MetricChip
					label="Total"
					testId="stats-total"
					value={formatStatsCount(stats.totalTokens)}
				/>
				<MetricChip
					label="Hit"
					testId="stats-cache-hit"
					value={formatPercent(stats.cacheHitRate)}
				/>
				<MetricChip
					label="In"
					testId="stats-input-speed"
					value={formatSpeed(stats.inputSpeed)}
				/>
				<MetricChip
					label="Out"
					testId="stats-output-speed"
					value={formatSpeed(stats.outputSpeed)}
				/>
				<MetricChip
					label="Total/s"
					testId="stats-total-speed"
					value={formatSpeed(stats.totalSpeed)}
				/>
				<MetricChip
					label="Context"
					testId="stats-context-percent"
					value={formatPercentagePoints(stats.contextPercent)}
				/>
				<MetricChip label="↻" testId="stats-compactions" value={compactions} />
				<MetricChip
					label="Cost"
					testId="stats-cost"
					value={formatCost(stats.costAmount, stats.costCurrency)}
				/>
				<MetricChip label="Cache" testId="stats-cache-timer" value={timer} />
				{usageSummary?.session ? (
					<MetricChip
						label="Session Usage"
						value={usagePercent(
							usageSummary.session.percent,
							preferences.usagePercentMode
						)}
					/>
				) : null}
				{usageSummary?.weekly ? (
					<MetricChip
						label="Weekly Usage"
						value={usagePercent(
							usageSummary.weekly.percent,
							preferences.usagePercentMode
						)}
					/>
				) : null}
			</HoverCardTrigger>
			<HoverCardContent
				align="start"
				className="w-[370px]"
				typography="compact"
			>
				<div
					className="flex flex-col gap-1.5"
					data-testid="stats-plugin-details"
				>
					<div className="mb-0.5 font-medium text-foreground">
						Current session
					</div>
					<DetailRow label="Turns" value={formatStatsCount(stats.turns)} />
					<DetailRow label="Steps" value={formatStatsCount(stats.steps)} />
					<DetailRow
						label="Tokens Input"
						value={formatStatsCount(stats.inputTokens)}
					/>
					<DetailRow
						label="Tokens Output"
						value={formatStatsCount(stats.outputTokens)}
					/>
					<DetailRow
						label="Tokens Cached"
						value={formatStatsCount(stats.cacheRead)}
					/>
					<DetailRow
						label="Tokens Total"
						value={formatStatsCount(stats.totalTokens)}
					/>
					<div className="my-0.5 h-px bg-border" />
					<DetailRow
						label="Cache Hit Rate"
						value={formatPercent(stats.cacheHitRate)}
					/>
					<DetailRow
						label="Cache Read"
						value={
							stats.cacheRead === undefined
								? null
								: `${formatStatsCount(stats.cacheRead)} (${formatPercent(stats.cacheReadShare) ?? "—"} of prompt)`
						}
					/>
					<DetailRow
						label="Cache Write"
						value={
							stats.cacheWrite === undefined
								? null
								: `${formatStatsCount(stats.cacheWrite)} (${formatPercent(stats.cacheWriteShare) ?? "—"} of prompt)`
						}
					/>
					<DetailRow label="Cache Timer" value={timer} />
					<div className="my-0.5 h-px bg-border" />
					<DetailRow
						label="Input Speed"
						value={formatSpeed(stats.inputSpeed)}
					/>
					<DetailRow
						label="Output Speed"
						value={formatSpeed(stats.outputSpeed)}
					/>
					<DetailRow
						label="Total Speed"
						value={formatSpeed(stats.totalSpeed)}
					/>
					<DetailRow
						label="Context Length"
						value={formatStatsCount(stats.contextLength)}
					/>
					<DetailRow
						label="Context Window"
						value={formatStatsCount(stats.contextWindow)}
					/>
					<DetailRow
						label="Context %"
						value={formatPercentagePoints(stats.contextPercent)}
					/>
					<DetailRow
						label="Context % (usable)"
						value={formatPercentagePoints(stats.contextPercentUsable)}
					/>
					<div
						className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
						data-testid="stats-context-bar"
					>
						<div
							className={cn(
								styles.widthTransition,
								"h-full rounded-full bg-primary"
							)}
							style={
								{
									"--agent-width": `${contextBarWidth}%`,
								} satisfies AgentGeometryStyle as AgentGeometryStyle
							}
						/>
					</div>
					<DetailRow
						label="Context Bar"
						value={
							stats.contextPercent === undefined
								? null
								: `${formatPercentagePoints(stats.contextPercent)} used`
						}
					/>
					<DetailRow label="Compaction Counter" value={compactions} />
					<DetailRow
						label="Cost"
						value={formatCost(stats.costAmount, stats.costCurrency)}
					/>
					<UsageDetails
						now={now}
						preferences={preferences}
						usage={stats.usage}
					/>
					<StatsPreferencesPanel
						preferences={preferences}
						setPreferences={setPreferences}
					/>
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}
