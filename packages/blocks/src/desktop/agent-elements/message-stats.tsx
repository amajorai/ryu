import { useLiteralMessages } from "@ryu/i18n/react";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card";
import { NumberTicker } from "@ryu/ui/components/number-ticker";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { resolveAcpElapsedMs } from "./acp-elapsed.ts";
import { ContextRing, deriveCacheMissTokens } from "./context-usage.tsx";
import {
	extractGenerationStats,
	extractNativeAcpUsage,
	inferenceNumber,
	isInferenceNumber,
	type NativeInferenceFields,
} from "./message-stats-native.ts";
import {
	addCompletionTokens,
	formatSessionCurrency,
	type NativeTokenOperand,
	tokenCountLabel,
} from "./native-token-count.mjs";
import type { RenderedMessage } from "./utils/native-sdk-observation.ts";

function StatRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between gap-6">
			<span className="text-muted-foreground">{label}</span>
			<span className="font-mono tabular-nums">{value}</span>
		</div>
	);
}

/**
 * Footer shown under a completed assistant turn: generation speed plus, when
 * the model's context size is known, a context-usage ring. Hovering reveals a
 * breakdown of token counts and timings.
 */
export function MessageStats({
	msg,
	contextSize,
	className,
}: {
	msg: Pick<RenderedMessage, "parts">;
	/** The active model's context window, used as the ring denominator. */
	contextSize?: number;
	className?: string;
}) {
	const tl = useLiteralMessages();
	const stats = useMemo(() => extractGenerationStats(msg), [msg]);
	if (!stats) {
		return null;
	}

	const speed = Math.round(stats.tokensPerSecond);
	const used = stats.currentUsage ?? stats.current_usage ?? stats.totalTokens;
	const window = stats.contextWindow ?? stats.context_window ?? contextSize;
	const hasRing =
		isInferenceNumber(window) && window > 0 && isInferenceNumber(used);
	const pct = hasRing ? (used / window) * 100 : 0;
	const remaining = hasRing ? Math.max(0, window - used) : 0;

	// Base UI carries the open/close delays on the TRIGGER (`delay`), not on the
	// root — where they sat as unknown props that were silently dropped, so the
	// card actually used the 600ms/300ms defaults.
	return (
		<HoverCard>
			<HoverCardTrigger
				appearance="statistics"
				className={cn("flex w-fit select-none items-center", className)}
				closeDelay={80}
				delay={120}
			>
				{hasRing ? <ContextRing pct={pct} /> : null}
				<span className="tabular-nums">
					{tl("{speed} tok/s", { speed: String(speed) })}
				</span>
			</HoverCardTrigger>
			<HoverCardContent className="w-60" typography="compact">
				<div className="flex flex-col gap-1.5">
					<StatRow
						label="Generation"
						value={`${stats.tokensPerSecond.toFixed(2)} tok/s`}
					/>
					{isInferenceNumber(stats.promptPerSecond) ? (
						<StatRow
							label="Reading"
							value={`${stats.promptPerSecond.toFixed(2)} tok/s`}
						/>
					) : null}
					<StatRow
						label="Completion"
						value={tokenCountLabel(stats.completionTokens)}
					/>
					{isInferenceNumber(stats.promptTokens) ? (
						<StatRow label="Prompt" value={`${stats.promptTokens} tokens`} />
					) : null}
					{isInferenceNumber(stats.cacheReadTokens ?? stats.cachedTokens) ? (
						<StatRow
							label="Cache hits"
							value={tokenCountLabel(
								stats.cacheReadTokens ?? stats.cachedTokens
							)}
						/>
					) : null}
					{isInferenceNumber(stats.cacheWriteTokens) ? (
						<StatRow
							label="Cache writes"
							value={`${stats.cacheWriteTokens} tokens`}
						/>
					) : null}
					{isInferenceNumber(stats.cacheMissTokens) ? (
						<StatRow
							label="Cache misses"
							value={`${stats.cacheMissTokens} tokens`}
						/>
					) : null}
					{isInferenceNumber(stats.reasoningTokens) ? (
						<StatRow
							label="Reasoning"
							value={`${stats.reasoningTokens} tokens`}
						/>
					) : null}
					{isInferenceNumber(stats.ttftMs) ? (
						<StatRow label="First token" value={`${stats.ttftMs} ms`} />
					) : null}
					{hasRing ? (
						<>
							<div className="my-0.5 h-px bg-border" />
							<StatRow
								label="Context"
								value={`${used} / ${window} (${Math.round(pct)}%)`}
							/>
							<StatRow label="Remaining" value={`${remaining} tokens`} />
						</>
					) : null}
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}

/**
 * Live inference stats streamed by Core for ACP agents as a `data-acp-usage`
 * part. Unlike the local-engine `data-ryu-stats` part (finalized once), Core
 * emits repeated frames sharing `"id":"acp-usage"` so the AI SDK reconciles
 * them in place: token counts tick up during the turn, and the FINAL frame
 * sets `done:true` with the finalized duration + tokens/sec. See
 * `apps/core/src/sidecar/adapters/mod.rs` (`ui_data`).
 */
type AcpUsage = NativeInferenceFields;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/** Format a millisecond duration as "12s" (<60s) or "1m 23s" (>=60s). */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) {
		return "0s";
	}
	const totalSeconds = Math.round(ms / MS_PER_SECOND);
	if (totalSeconds < SECONDS_PER_MINUTE) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
	const seconds = totalSeconds % SECONDS_PER_MINUTE;
	return `${minutes}m ${seconds}s`;
}

/**
 * Best-effort total-token count across the fields Core may populate — `null`
 * when the agent reported none of them.
 *
 * `null`, never 0: ACP's token usage is an UNSTABLE optional capability that
 * most agents do not implement, and the old `?? 0` tail meant every one of those
 * turns rendered a confident, wrong "0 tokens". Absence is not zero, and the
 * caller suppresses the segment instead.
 */
function usageTokenCount(usage: AcpUsage): NativeTokenOperand | null {
	if (isInferenceNumber(usage.totalTokens)) {
		return usage.totalTokens;
	}
	if (isInferenceNumber(usage.completionTokens)) {
		return addCompletionTokens(usage.promptTokens, usage.completionTokens);
	}
	// `used` is NOT this turn's spend — it is context-window occupancy for the
	// whole session (ACP `UsageUpdate.used`, and the cumulative total on the final
	// frame). It is a fine LIVE ticker (it moves while the agent works, and it is
	// the only signal most agents give), but publishing it as the finished turn's
	// token count reprints the whole session's tokens under every reply and grows
	// monotonically — the same inflation the per-turn delta exists to kill.
	if (usage.done) {
		return null;
	}
	return usage.used ?? null;
}

/**
 * Hover-card rows for an ACP turn, mirroring the local-engine card.
 *
 * Every row is emitted ONLY when Core actually carried the field. ACP's usage
 * capability is unstable and optional, support differs per agent AND per agent
 * version, so per-field degradation is the design — an omitted row is correct,
 * a zero-valued row is a lie.
 */
function acpBreakdownRows(usage: AcpUsage): Array<{
	label: string;
	value: string;
}> {
	const rows: Array<{ label: string; value: string }> = [];
	const cacheMissTokens =
		usage.cacheMissTokens ??
		deriveCacheMissTokens(
			inferenceNumber(usage.promptTokens),
			inferenceNumber(usage.cachedReadTokens),
			inferenceNumber(usage.cachedWriteTokens)
		);
	const push = (label: string, value: NativeTokenOperand, unit: string) => {
		if (isInferenceNumber(value)) {
			rows.push({ label, value: `${formatCount(value) ?? "—"} ${unit}` });
		}
	};
	if (isInferenceNumber(usage.tokensPerSecond) && usage.tokensPerSecond > 0) {
		rows.push({
			label: "Generation",
			value: `${usage.tokensPerSecond.toFixed(2)} tok/s`,
		});
	}
	push("Completion", usage.completionTokens, "tokens");
	push(
		isInferenceNumber(cacheMissTokens) ? "Cache misses" : "Prompt",
		isInferenceNumber(cacheMissTokens) ? cacheMissTokens : usage.promptTokens,
		"tokens"
	);
	push("Reasoning", usage.thoughtTokens, "tokens");
	push("Cache hits", usage.cachedReadTokens, "tokens");
	push("Cache writes", usage.cachedWriteTokens, "tokens");
	// Deliberately NOT "First token": on a session's first turn this includes the
	// agent process spawning and `session/new`, so it is not the local engine's
	// metric under the same name.
	push("First response", usage.ttftMs, "ms");
	if (isInferenceNumber(usage.durationMs) && usage.done) {
		// Whole-turn wall clock — it spans tool calls, MCP round-trips and any
		// approval the user sat on. Labelled "Turn" so it is not read as the
		// model's generation window.
		rows.push({ label: "Turn", value: formatDuration(usage.durationMs) });
	}
	push("Session total", usage.sessionTotalTokens, "tokens");
	if (isInferenceNumber(usage.sessionCostAmount) && usage.sessionCostCurrency) {
		rows.push({
			label: "Session cost",
			value: formatSessionCurrency(
				usage.sessionCostAmount,
				usage.sessionCostCurrency,
				{
					maximumFractionDigits: 4,
					minimumFractionDigits: 2,
				}
			),
		});
	}
	if (
		isInferenceNumber(usage.used) &&
		usage.used > 0 &&
		isInferenceNumber(usage.total) &&
		usage.total > 0
	) {
		const pct = (usage.used / usage.total) * 100;
		rows.push({
			label: "Context window",
			value: `${formatCount(usage.used) ?? "—"} / ${formatCount(usage.total) ?? "—"} (${Math.round(pct)}%)`,
		});
		rows.push({
			label: "Remaining",
			value: `${formatCount(Math.max(0, usage.total - usage.used)) ?? "—"} tokens`,
		});
	}
	return rows;
}

/**
 * Footer for ACP agent turns. While the turn streams (`done` false), it shows a
 * live-ticking token count and a live elapsed timer. Once finalized (`done:true`)
 * it freezes the count and appends tokens/sec and the final duration. Renders
 * nothing until the first `data-acp-usage` frame arrives, so non-ACP turns are
 * unaffected.
 */
export function AcpUsageStats({
	msg,
	className,
	isLive = true,
}: {
	msg: Pick<RenderedMessage, "parts">;
	className?: string;
	/**
	 * Whether this turn is the one currently streaming. Defaults to true so a
	 * caller that does not know keeps the old behaviour; message-list passes the
	 * chat's own status, which is `effectiveStatus` (resumed turns included), so
	 * a genuinely live reply still ticks.
	 */
	isLive?: boolean;
}) {
	const tl = useLiteralMessages();
	// No useMemo: extractAcpUsage is a cheap array.find — memoizing it with
	// [msg] can stale during streaming when the AI SDK reconciles data parts in
	// place without replacing the message object reference.
	const usage = extractNativeAcpUsage(msg);

	// Live elapsed timer: record when the component first mounts with usage data,
	// then tick every second while the turn is still streaming.
	const startRef = useRef<number | null>(null);
	const frozenRef = useRef<number | null>(null);
	const [now, setNow] = useState(() => Date.now());

	if (usage && startRef.current === null) {
		startRef.current = Date.now();
	}

	// `usage` is a NEW object on every streamed frame (the AI SDK replaces the
	// data part), so depending on it tore the interval down and rebuilt it every
	// frame. The two booleans below are all this effect actually reacts to.
	const isRunning = Boolean(usage) && usage?.done !== true && isLive;

	useEffect(() => {
		if (!isRunning) {
			return;
		}
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [isRunning]);

	const elapsedMs = usage
		? resolveAcpElapsedMs({
				done: usage.done === true,
				durationMs: inferenceNumber(usage.durationMs),
				frozenMs: frozenRef.current,
				isLive,
				now,
				startedAt: startRef.current,
			})
		: null;

	// Remember the last live measurement so an interrupted turn freezes at the
	// number the user was watching instead of dropping it.
	useEffect(() => {
		if (isRunning && elapsedMs !== null) {
			frozenRef.current = elapsedMs;
		}
	}, [isRunning, elapsedMs]);

	if (!usage) {
		return null;
	}

	const tokens = usageTokenCount(usage);
	// `> 0`, not merely present: a turn that genuinely produced tokens in under a
	// millisecond does not exist, so a rounded 0 tok/s is always noise.
	const speed =
		isInferenceNumber(usage.tokensPerSecond) && usage.tokensPerSecond > 0
			? Math.round(usage.tokensPerSecond)
			: null;

	const duration = elapsedMs === null ? null : formatDuration(elapsedMs);
	const showSpeed = Boolean(usage.done) && speed !== null;
	const contextUsed = usage.used;
	const contextWindow = usage.total;
	const hasContextWindow =
		isInferenceNumber(contextUsed) &&
		contextUsed > 0 &&
		isInferenceNumber(contextWindow) &&
		contextWindow > 0;
	const contextPct = hasContextWindow ? (contextUsed / contextWindow) * 100 : 0;

	// Nothing measurable at all (an agent that reports no usage on a turn that
	// also produced no timing) — render nothing rather than an empty footer row.
	if (tokens === null && !(showSpeed || duration || hasContextWindow)) {
		return null;
	}

	const row = (
		<span
			className={cn(
				"flex w-fit select-none items-center gap-1.5 text-muted-foreground tabular-nums",
				className
			)}
		>
			{hasContextWindow ? (
				<>
					<ContextRing pct={contextPct} />
					<span>{Math.round(contextPct)}%</span>
				</>
			) : null}
			{tokens === null ? null : (
				<span className="inline-flex items-center gap-1">
					<NumberTicker startOnView={false} value={tokens} />
					<span>tokens</span>
				</span>
			)}
			{showSpeed ? (
				<>
					{tokens === null ? null : <span aria-hidden="true">·</span>}
					<span>{tl("{speed} tok/s", { speed: String(speed) })}</span>
				</>
			) : null}
			{duration ? (
				<>
					{tokens === null && !showSpeed ? null : (
						<span aria-hidden="true">·</span>
					)}
					<span>{duration}</span>
				</>
			) : null}
		</span>
	);

	const breakdown = acpBreakdownRows(usage);
	if (breakdown.length === 0) {
		return row;
	}
	return (
		<HoverCard>
			<HoverCardTrigger closeDelay={80} delay={120}>
				{row}
			</HoverCardTrigger>
			<HoverCardContent className="w-60" typography="compact">
				<div className="flex flex-col gap-1.5">
					{breakdown.map((r) => (
						<StatRow key={r.label} label={r.label} value={r.value} />
					))}
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}
