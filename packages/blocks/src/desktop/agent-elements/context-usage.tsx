import { cn } from "@ryu/ui/lib/utils";
import type { UIMessage } from "ai";

/**
 * Shared context-window usage model. Both the per-message footer
 * (`message-stats.tsx`) and the composer meter (`input/context-meter.tsx`)
 * render the SAME conversation's fullness, so the ring SVG, the color
 * thresholds, and the message-derivation live here — one source of truth so the
 * two surfaces never diverge in color or math.
 *
 * Thresholds mirror assistant-ui's ContextDisplay (warn at 65%, critical at
 * 85%) rather than Jan's later 85/100 split, so the composer warns with more
 * runway. The base state stays theme-neutral (`muted-foreground`) instead of a
 * loud emerald, because the composer ring is always on screen.
 */
export const CONTEXT_WARN_PCT = 65;
export const CONTEXT_CRITICAL_PCT = 85;

/** Token breakdown streamed by Core, normalized across the two stat parts. */
export interface ContextUsage {
	/** Cached input tokens (prompt-cache hits), when the provider reports them. */
	cachedTokens?: number;
	/** Output/completion tokens for the last turn. */
	completionTokens?: number;
	/** Input/prompt tokens for the last turn. */
	promptTokens?: number;
	/** Reasoning tokens (o-series / thinking models), when reported. */
	reasoningTokens?: number;
	/** The model's context window (ring denominator). 0 when unknown. */
	total: number;
	/** Prompt + completion for the last turn. */
	totalTokens?: number;
	/** Tokens currently occupying the context window (ring numerator). */
	used: number;
}

/** Severity color for a usage percentage. Returns a Tailwind text-color class. */
export function contextRingColor(pct: number): string {
	if (pct >= CONTEXT_CRITICAL_PCT) {
		return "text-destructive";
	}
	if (pct >= CONTEXT_WARN_PCT) {
		return "text-amber-500";
	}
	return "text-muted-foreground";
}

/**
 * Twitter-style circular usage indicator: a donut ring that fills and shifts
 * color (muted → amber → red) as the conversation approaches the model's
 * context limit. `pct` may exceed 100 (the fill clamps; the color still flips
 * to destructive).
 */
export function ContextRing({
	pct,
	size = 14,
	stroke = 2,
	className,
}: {
	pct: number;
	size?: number;
	stroke?: number;
	className?: string;
}) {
	const clamped = Math.min(Math.max(pct, 0), 100);
	const radius = (size - stroke) / 2;
	const circumference = 2 * Math.PI * radius;
	const offset = circumference * (1 - clamped / 100);
	const center = size / 2;
	return (
		<svg
			aria-hidden="true"
			className={cn("shrink-0", contextRingColor(pct), className)}
			height={size}
			viewBox={`0 0 ${size} ${size}`}
			width={size}
		>
			<circle
				className="opacity-25"
				cx={center}
				cy={center}
				fill="none"
				r={radius}
				stroke="currentColor"
				strokeWidth={stroke}
			/>
			<circle
				cx={center}
				cy={center}
				fill="none"
				r={radius}
				stroke="currentColor"
				strokeDasharray={circumference}
				strokeDashoffset={offset}
				strokeLinecap="round"
				strokeWidth={stroke}
				transform={`rotate(-90 ${center} ${center})`}
			/>
		</svg>
	);
}

// Data-part types Core streams (see `build_stats_part` and the `acp-usage`
// emitter in apps/core/src/sidecar/adapters/mod.rs). Kept loose (all optional)
// because a frame may carry only a subset while streaming.
interface RyuStatsPart {
	cachedTokens?: number;
	completionTokens?: number;
	promptTokens?: number;
	reasoningTokens?: number;
	totalTokens?: number;
}

interface AcpUsagePart {
	cachedTokens?: number;
	completionTokens?: number;
	promptTokens?: number;
	reasoningTokens?: number;
	total?: number;
	totalTokens?: number;
	used?: number;
}

const RYU_STATS_PART_TYPE = "data-ryu-stats";
const ACP_USAGE_PART_TYPE = "data-acp-usage";

function partData<T>(msg: UIMessage, type: string): T | null {
	const parts = (msg.parts ?? []) as Array<{ type?: string; data?: unknown }>;
	for (const part of parts) {
		if (part?.type === type && part.data) {
			return part.data as T;
		}
	}
	return null;
}

/**
 * Derive the current context-window usage for the composer meter by scanning
 * the conversation backwards for the most recent turn that reported token
 * usage. Prefers the live ACP meter (`data-acp-usage`, which carries the
 * agent-reported window as `total`); falls back to the local-engine
 * `data-ryu-stats` part, whose denominator is the passed `contextSize` (from
 * the model's launch config / models.dev). Returns null when nothing usable is
 * found — usage is live-only and not replayed on history reload, so a freshly
 * loaded chat shows no meter until the next turn.
 */
export function deriveContextUsage(
	messages: readonly UIMessage[],
	contextSize?: number
): ContextUsage | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role !== "assistant") {
			continue;
		}

		const acp = partData<AcpUsagePart>(msg, ACP_USAGE_PART_TYPE);
		if (acp) {
			const used =
				acp.used ??
				acp.totalTokens ??
				(acp.promptTokens ?? 0) + (acp.completionTokens ?? 0);
			const total = acp.total ?? contextSize ?? 0;
			if (used > 0) {
				return {
					used,
					total,
					promptTokens: acp.promptTokens,
					cachedTokens: acp.cachedTokens,
					completionTokens: acp.completionTokens,
					reasoningTokens: acp.reasoningTokens,
					totalTokens: acp.totalTokens,
				};
			}
		}

		const stats = partData<RyuStatsPart>(msg, RYU_STATS_PART_TYPE);
		if (stats) {
			const used =
				stats.totalTokens ??
				(stats.promptTokens ?? 0) + (stats.completionTokens ?? 0);
			if (used > 0) {
				return {
					used,
					total: contextSize ?? 0,
					promptTokens: stats.promptTokens,
					cachedTokens: stats.cachedTokens,
					completionTokens: stats.completionTokens,
					reasoningTokens: stats.reasoningTokens,
					totalTokens: stats.totalTokens,
				};
			}
		}
	}
	return null;
}
