import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card";
import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import styles from "./elements-one.module.css";
import type { AgentGeometryStyle } from "./elements-one-style.ts";
import {
	DEFAULT_STATS_PREFERENCES,
	deriveSessionStats,
	formatStatsCount,
	formatStatsDuration,
	type StatsMessage,
	type StatsPreferences,
	type StatsUsageMetric,
	type StatsUsageSnapshot,
	statsPreferenceFields,
} from "./stats-model.ts";

const STORAGE_KEY = "ryu:stats-plugin-preferences";
const authoredStoredPreferences = z.object(statsPreferenceFields).partial();
// Every current authored field is checked; unobserved future JSON fields remain
// on the original decoded object and retain native object-spread persistence.
const storedPreferencesSchema = z.custom<Partial<StatsPreferences>>(
	(value) => authoredStoredPreferences.safeParse(value).success
);

function readPreferences(): StatsPreferences {
	if (globalThis.window === undefined) {
		return DEFAULT_STATS_PREFERENCES;
	}
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return DEFAULT_STATS_PREFERENCES;
		}
		const parsed = storedPreferencesSchema.parse(JSON.parse(raw));
		return { ...DEFAULT_STATS_PREFERENCES, ...parsed };
	} catch {
		return DEFAULT_STATS_PREFERENCES;
	}
}

function formatSpeed(value: number | undefined): string | null {
	if (value === undefined || !Number.isFinite(value) || value <= 0) {
		return null;
	}
	return `${value.toFixed(value >= 100 ? 0 : 1)} tok/s`;
}

function formatPercent(value: number | undefined): string | null {
	if (value === undefined || !Number.isFinite(value)) {
		return null;
	}
	return `${Math.round(value * 100)}%`;
}

function formatPercentagePoints(value: number | undefined): string | null {
	if (value === undefined || !Number.isFinite(value)) {
		return null;
	}
	return `${value < 1 ? value.toFixed(1) : Math.round(value)}%`;
}

function formatCost(
	amount: number | undefined,
	currency: string | undefined
): string | null {
	if (amount === undefined || !Number.isFinite(amount)) {
		return null;
	}
	try {
		return new Intl.NumberFormat(undefined, {
			currency: currency ?? "USD",
			maximumFractionDigits: 4,
			minimumFractionDigits: 2,
			style: "currency",
		}).format(amount);
	} catch {
		return `${amount.toFixed(2)} ${currency ?? "USD"}`;
	}
}

function formatResetRemaining(
	resetAt: string | null,
	now: number
): string | null {
	if (!resetAt) {
		return null;
	}
	const resetMs = Date.parse(resetAt);
	if (Number.isNaN(resetMs)) {
		return null;
	}
	const seconds = Math.max(0, Math.ceil((resetMs - now) / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function usagePercent(
	percent: number | undefined,
	mode: StatsPreferences["usagePercentMode"]
): string | null {
	if (percent === undefined || !Number.isFinite(percent)) {
		return null;
	}
	const value = mode === "remaining" ? 100 - percent : percent;
	return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

function usageTimeCursor(
	metric: StatsUsageMetric,
	now: number
): number | undefined {
	if (!(metric.resetAt && metric.windowSeconds) || metric.windowSeconds <= 0) {
		return undefined;
	}
	const resetMs = Date.parse(metric.resetAt);
	if (Number.isNaN(resetMs)) {
		return undefined;
	}
	const startMs = resetMs - metric.windowSeconds * 1000;
	return Math.max(
		0,
		Math.min(100, ((now - startMs) / (resetMs - startMs)) * 100)
	);
}

function formatUsageReset(
	metric: StatsUsageMetric | null | undefined,
	now: number,
	preferences: StatsPreferences
): string | null {
	if (!metric?.resetAt) {
		return null;
	}
	if (preferences.resetTimerMode === "progress") {
		const cursor = usageTimeCursor(metric, now);
		return cursor === undefined
			? formatResetRemaining(metric.resetAt, now)
			: `${Math.round(cursor)}% elapsed`;
	}
	if (preferences.resetTimerMode === "exact") {
		const resetMs = Date.parse(metric.resetAt);
		if (Number.isNaN(resetMs)) {
			return null;
		}
		const locale =
			preferences.resetTimerLocale === "system" ||
			preferences.resetTimerLocale.trim() === ""
				? undefined
				: preferences.resetTimerLocale.trim();
		try {
			return new Intl.DateTimeFormat(locale, {
				dateStyle: "short",
				timeStyle: "short",
				timeZone: preferences.resetTimerTimezone === "utc" ? "UTC" : undefined,
			}).format(resetMs);
		} catch {
			return new Date(resetMs).toLocaleString();
		}
	}
	return formatResetRemaining(metric.resetAt, now);
}

function MetricChip({
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
			className="type-compact inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-1.5 py-0.5 text-muted-foreground tabular-nums"
			data-testid={testId}
		>
			<span className="text-muted-foreground/70">{label}</span>
			<span className="font-medium text-foreground/80">{value}</span>
		</span>
	);
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
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

function compactionValue(
	stats: ReturnType<typeof deriveSessionStats>,
	preferences: StatsPreferences
): string | null {
	const compactions = stats.compactions;
	const selected =
		preferences.compactionValue === "total"
			? compactions.count
			: preferences.compactionValue === "auto"
				? compactions.auto
				: preferences.compactionValue === "manual"
					? compactions.manual
					: preferences.compactionValue === "unknown"
						? compactions.unknown
						: compactions.reclaimedTokens;
	if (preferences.hideEmpty && selected === 0) {
		return null;
	}
	if (preferences.compactionValue === "reclaimed") {
		return `${formatStatsCount(selected) ?? "0"} tokens`;
	}
	if (
		preferences.compactionValue === "total" &&
		(preferences.compactionShowTriggers || preferences.compactionShowReclaimed)
	) {
		const details: string[] = [];
		if (preferences.compactionShowTriggers) {
			details.push(
				`${compactions.auto} auto, ${compactions.manual} manual, ${compactions.unknown} unknown`
			);
		}
		if (
			preferences.compactionShowReclaimed &&
			compactions.reclaimedTokens > 0
		) {
			details.push(`↓${formatStatsCount(compactions.reclaimedTokens)}`);
		}
		return `${formatStatsCount(selected) ?? "0"} (${details.join("; ")})`;
	}
	return formatStatsCount(selected) ?? "0";
}

function timerLabel(
	stats: ReturnType<typeof deriveSessionStats>,
	preferences: StatsPreferences
): string | null {
	const timer = stats.cacheTimer;
	if (!timer) {
		return null;
	}
	if (timer.state === "hot") {
		return `${preferences.cacheHotGlyph} HOT`;
	}
	if (timer.state === "cold") {
		return `${preferences.cacheColdGlyph} COLD`;
	}
	return `${preferences.cacheCountdownGlyph} ${formatStatsDuration(timer.remainingMs ?? 0)}`;
}

function UsageDetails({
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

function StatsPreferencesPanel({
	preferences,
	setPreferences,
}: {
	preferences: StatsPreferences;
	setPreferences: (next: Partial<StatsPreferences>) => void;
}) {
	return (
		<div className="type-caption mt-3 border-border/60 border-t pt-3">
			<div className="mb-2 font-medium text-foreground">Stats settings</div>
			<div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2">
				<label htmlFor="stats-cache-scope">Cache totals</label>
				<select
					className="type-compact rounded border border-border bg-background px-1.5 py-1"
					id="stats-cache-scope"
					onChange={(event) =>
						setPreferences({
							cacheScope: statsPreferenceFields.cacheScope.parse(
								event.target.value
							),
						})
					}
					value={preferences.cacheScope}
				>
					<option value="latest">Latest turn</option>
					<option value="session">Cumulative session</option>
				</select>
				<label htmlFor="stats-cache-ttl">Cache timer TTL</label>
				<select
					className="type-compact rounded border border-border bg-background px-1.5 py-1"
					id="stats-cache-ttl"
					onChange={(event) =>
						setPreferences({
							cacheTimerTtlMinutes:
								statsPreferenceFields.cacheTimerTtlMinutes.parse(
									Number(event.target.value)
								),
						})
					}
					value={preferences.cacheTimerTtlMinutes}
				>
					<option value="5">5 minutes</option>
					<option value="60">1 hour</option>
				</select>
				<label htmlFor="stats-rolling-window">Speed rolling window</label>
				<select
					className="type-compact rounded border border-border bg-background px-1.5 py-1"
					id="stats-rolling-window"
					onChange={(event) =>
						setPreferences({ rollingWindowSeconds: Number(event.target.value) })
					}
					value={preferences.rollingWindowSeconds}
				>
					<option value="0">Full session</option>
					<option value="5">5 seconds</option>
					<option value="15">15 seconds</option>
					<option value="30">30 seconds</option>
					<option value="60">1 minute</option>
					<option value="120">2 minutes</option>
				</select>
				<label htmlFor="stats-compaction-value">Compaction value</label>
				<select
					className="type-compact rounded border border-border bg-background px-1.5 py-1"
					id="stats-compaction-value"
					onChange={(event) =>
						setPreferences({
							compactionValue: statsPreferenceFields.compactionValue.parse(
								event.target.value
							),
						})
					}
					value={preferences.compactionValue}
				>
					<option value="total">Total count</option>
					<option value="auto">Auto count</option>
					<option value="manual">Manual count</option>
					<option value="unknown">Unknown count</option>
					<option value="reclaimed">Tokens reclaimed</option>
				</select>
				<label
					className="col-span-2 flex items-center gap-2"
					htmlFor="stats-compaction-triggers"
				>
					<input
						checked={preferences.compactionShowTriggers}
						id="stats-compaction-triggers"
						onChange={(event) =>
							setPreferences({ compactionShowTriggers: event.target.checked })
						}
						type="checkbox"
					/>
					Show compaction trigger split
				</label>
				<label
					className="col-span-2 flex items-center gap-2"
					htmlFor="stats-compaction-reclaimed"
				>
					<input
						checked={preferences.compactionShowReclaimed}
						id="stats-compaction-reclaimed"
						onChange={(event) =>
							setPreferences({ compactionShowReclaimed: event.target.checked })
						}
						type="checkbox"
					/>
					Show reclaimed tokens
				</label>
				<label htmlFor="stats-usage-percent-mode">Usage percentage</label>
				<select
					className="type-compact rounded border border-border bg-background px-1.5 py-1"
					id="stats-usage-percent-mode"
					onChange={(event) =>
						setPreferences({
							usagePercentMode: statsPreferenceFields.usagePercentMode.parse(
								event.target.value
							),
						})
					}
					value={preferences.usagePercentMode}
				>
					<option value="used">Used percentage</option>
					<option value="remaining">Remaining percentage</option>
				</select>
				<label htmlFor="stats-reset-timer-mode">Reset timer display</label>
				<select
					className="type-compact rounded border border-border bg-background px-1.5 py-1"
					id="stats-reset-timer-mode"
					onChange={(event) =>
						setPreferences({
							resetTimerMode: statsPreferenceFields.resetTimerMode.parse(
								event.target.value
							),
						})
					}
					value={preferences.resetTimerMode}
				>
					<option value="remaining">Remaining time</option>
					<option value="progress">Progress</option>
					<option value="exact">Exact date/time</option>
				</select>
				<label htmlFor="stats-reset-timezone">Reset timezone</label>
				<select
					className="type-compact rounded border border-border bg-background px-1.5 py-1"
					id="stats-reset-timezone"
					onChange={(event) =>
						setPreferences({
							resetTimerTimezone:
								statsPreferenceFields.resetTimerTimezone.parse(
									event.target.value
								),
						})
					}
					value={preferences.resetTimerTimezone}
				>
					<option value="local">Local time</option>
					<option value="utc">UTC</option>
				</select>
				<label htmlFor="stats-reset-locale">Reset locale</label>
				<input
					className="type-compact w-24 rounded border border-border bg-background px-1.5 py-1"
					id="stats-reset-locale"
					maxLength={24}
					onChange={(event) =>
						setPreferences({ resetTimerLocale: event.target.value || "system" })
					}
					placeholder="system"
					value={
						preferences.resetTimerLocale === "system"
							? ""
							: preferences.resetTimerLocale
					}
				/>
				<label htmlFor="stats-cache-hot-glyph">Cache hot glyph</label>
				<input
					className="type-compact w-14 rounded border border-border bg-background px-1.5 py-1 text-center"
					id="stats-cache-hot-glyph"
					maxLength={4}
					onChange={(event) =>
						setPreferences({ cacheHotGlyph: event.target.value })
					}
					value={preferences.cacheHotGlyph}
				/>
				<label htmlFor="stats-cache-countdown-glyph">
					Cache countdown glyph
				</label>
				<input
					className="type-compact w-14 rounded border border-border bg-background px-1.5 py-1 text-center"
					id="stats-cache-countdown-glyph"
					maxLength={4}
					onChange={(event) =>
						setPreferences({ cacheCountdownGlyph: event.target.value })
					}
					value={preferences.cacheCountdownGlyph}
				/>
				<label htmlFor="stats-cache-cold-glyph">Cache cold glyph</label>
				<input
					className="type-compact w-14 rounded border border-border bg-background px-1.5 py-1 text-center"
					id="stats-cache-cold-glyph"
					maxLength={4}
					onChange={(event) =>
						setPreferences({ cacheColdGlyph: event.target.value })
					}
					value={preferences.cacheColdGlyph}
				/>
			</div>
			<label
				className="mt-3 flex items-center gap-2"
				htmlFor="stats-hide-empty"
			>
				<input
					checked={preferences.hideEmpty}
					id="stats-hide-empty"
					onChange={(event) =>
						setPreferences({ hideEmpty: event.target.checked })
					}
					type="checkbox"
				/>
				Hide unavailable or empty metrics
			</label>
			<label
				className="mt-2 flex items-center gap-2"
				htmlFor="stats-usage-time-cursor"
			>
				<input
					checked={preferences.usageShowTimeCursor}
					id="stats-usage-time-cursor"
					onChange={(event) =>
						setPreferences({ usageShowTimeCursor: event.target.checked })
					}
					type="checkbox"
				/>
				Show usage-window time cursor
			</label>
			<label
				className="mt-2 flex items-center gap-2"
				htmlFor="stats-cache-timer"
			>
				<input
					checked={preferences.showCacheTimer}
					id="stats-cache-timer"
					onChange={(event) =>
						setPreferences({ showCacheTimer: event.target.checked })
					}
					type="checkbox"
				/>
				Show cache timer when an anchor is available
			</label>
		</div>
	);
}

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
				<span className="type-compact mr-0.5 font-medium text-muted-foreground/70 uppercase tracking-wider">
					Stats
				</span>
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
