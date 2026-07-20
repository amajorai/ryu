import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card";
import { NumberTicker } from "@ryu/ui/components/number-ticker";
import { cn } from "@ryu/ui/lib/utils";
import type { UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { ContextRing } from "./context-usage.tsx";

/**
 * Per-message inference statistics streamed by Core as a `data-ryu-stats`
 * part (see `build_stats_part` in `apps/core/src/sidecar/adapters/mod.rs`).
 * Mirrors Jan AI's persisted shape: the engine's own token speed when
 * available, with token counts and timing context.
 */
interface RyuStats {
	completionTokens: number;
	durationMs?: number;
	promptPerSecond?: number;
	promptTokens?: number;
	tokensPerSecond: number;
	totalTokens?: number;
	ttftMs?: number;
}

const STATS_PART_TYPE = "data-ryu-stats";

function extractStats(msg: UIMessage): RyuStats | null {
	const parts = (msg.parts ?? []) as Array<{ type?: string; data?: unknown }>;
	for (const part of parts) {
		if (part?.type === STATS_PART_TYPE && part.data) {
			const data = part.data as Partial<RyuStats>;
			if (typeof data.tokensPerSecond === "number") {
				return data as RyuStats;
			}
		}
	}
	return null;
}

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
	msg: UIMessage;
	/** The active model's context window, used as the ring denominator. */
	contextSize?: number;
	className?: string;
}) {
	const stats = useMemo(() => extractStats(msg), [msg]);
	if (!stats) {
		return null;
	}

	const speed = Math.round(stats.tokensPerSecond);
	const used = stats.totalTokens;
	const hasRing =
		typeof contextSize === "number" &&
		contextSize > 0 &&
		typeof used === "number";
	const pct = hasRing ? (used / contextSize) * 100 : 0;
	const remaining = hasRing ? Math.max(0, contextSize - used) : 0;

	return (
		<HoverCard closeDelay={80} openDelay={120}>
			<HoverCardTrigger
				className={cn(
					"flex w-fit cursor-default select-none items-center gap-1.5 text-muted-foreground",
					className
				)}
			>
				{hasRing ? <ContextRing pct={pct} /> : null}
				<span className="tabular-nums">{speed} tok/s</span>
			</HoverCardTrigger>
			<HoverCardContent className="w-60 text-xs">
				<div className="flex flex-col gap-1.5">
					<StatRow
						label="Generation"
						value={`${stats.tokensPerSecond.toFixed(2)} tok/s`}
					/>
					{typeof stats.promptPerSecond === "number" ? (
						<StatRow
							label="Reading"
							value={`${stats.promptPerSecond.toFixed(2)} tok/s`}
						/>
					) : null}
					<StatRow
						label="Completion"
						value={`${stats.completionTokens} tokens`}
					/>
					{typeof stats.promptTokens === "number" ? (
						<StatRow label="Prompt" value={`${stats.promptTokens} tokens`} />
					) : null}
					{typeof stats.ttftMs === "number" ? (
						<StatRow label="First token" value={`${stats.ttftMs} ms`} />
					) : null}
					{hasRing ? (
						<>
							<div className="my-0.5 h-px bg-border" />
							<StatRow
								label="Context"
								value={`${used} / ${contextSize} (${Math.round(pct)}%)`}
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
interface AcpUsage {
	completionTokens?: number;
	/** True on the finalized frame; false/absent while still streaming. */
	done?: boolean;
	durationMs?: number;
	id?: string;
	promptTokens?: number;
	tokensPerSecond?: number;
	/** The model's context window, ring denominator. */
	total?: number;
	totalTokens?: number;
	/** Context tokens used (conversation), for the optional usage ring. */
	used?: number;
}

const ACP_USAGE_PART_TYPE = "data-acp-usage";
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

function extractAcpUsage(msg: UIMessage): AcpUsage | null {
	const part = (msg.parts ?? []).find(
		(p) => (p as { type?: string })?.type === ACP_USAGE_PART_TYPE
	) as { type?: string; data?: AcpUsage } | undefined;
	return part?.data ?? null;
}

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

/** Best-effort total-token count across the fields Core may populate. */
function usageTokenCount(usage: AcpUsage): number {
	if (typeof usage.totalTokens === "number") {
		return usage.totalTokens;
	}
	if (typeof usage.completionTokens === "number") {
		return (usage.promptTokens ?? 0) + usage.completionTokens;
	}
	return usage.used ?? 0;
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
}: {
	msg: UIMessage;
	className?: string;
}) {
	// No useMemo: extractAcpUsage is a cheap array.find — memoizing it with
	// [msg] can stale during streaming when the AI SDK reconciles data parts in
	// place without replacing the message object reference.
	const usage = extractAcpUsage(msg);

	// Live elapsed timer: record when the component first mounts with usage data,
	// then tick every second while the turn is still streaming.
	const startRef = useRef<number | null>(null);
	const [now, setNow] = useState(() => Date.now());

	if (usage && startRef.current === null) {
		startRef.current = Date.now();
	}

	useEffect(() => {
		if (!usage || usage.done) {
			return;
		}
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [usage, usage?.done]);

	if (!usage) {
		return null;
	}

	const tokens = usageTokenCount(usage);
	const speed =
		typeof usage.tokensPerSecond === "number"
			? Math.round(usage.tokensPerSecond)
			: null;

	// Use the backend's finalized duration when available, otherwise the live
	// client-side elapsed time.
	const elapsedMs = usage.done
		? typeof usage.durationMs === "number"
			? usage.durationMs
			: null
		: startRef.current
			? now - startRef.current
			: null;
	const duration = elapsedMs === null ? null : formatDuration(elapsedMs);

	return (
		<span
			className={cn(
				"flex w-fit select-none items-center gap-1.5 text-muted-foreground tabular-nums",
				className
			)}
		>
			<span className="inline-flex items-center gap-1">
				<NumberTicker startOnView={false} value={tokens} />
				<span>tokens</span>
			</span>
			{usage.done && speed !== null ? (
				<>
					<span aria-hidden="true">·</span>
					<span>{speed} tok/s</span>
				</>
			) : null}
			{duration ? (
				<>
					<span aria-hidden="true">·</span>
					<span>{duration}</span>
				</>
			) : null}
		</span>
	);
}
