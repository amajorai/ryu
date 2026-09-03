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
		return "text-warning";
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

/* ── Context breakdown (workspace Context panel) ──────────────────────────────
 *
 * The ring answers "how full"; the panel answers "full of what". Core computes
 * the itemization at the send seam (`apps/core/src/sidecar/adapters/
 * context_breakdown.rs`) and serves it from `GET /api/conversations/:id/context`
 * — the client cannot derive it, because it never sees the assembled prompt.
 *
 * The category model lives HERE, next to the ring, for the reason this file's
 * header already gives: the surfaces that draw the same conversation's fullness
 * share one source of truth for color and math. The panel is the third.
 */

/** One itemized slice, as Core serves it. */
export interface ContextCategory {
	/** Stable machine id — the key for {@link CATEGORY_META}. */
	id: string;
	label: string;
	tokens: number;
}

/** The snapshot `GET /api/conversations/:id/context` returns. */
export interface ContextBreakdown {
	agentId?: string | null;
	categories: ContextCategory[];
	estimatedTotal: number;
	model: string;
	/** `"openai"` (Core assembles the whole prompt) or `"acp"` (it does not). */
	plane: string;
	/** The provider's own prompt-token count, once the turn reported one. */
	reportedInput?: number | null;
	updatedAt: number;
	/** Context window Core knows about, or 0 — callers fall back to their own. */
	window: number;
}

/**
 * Per-category color and display order.
 *
 * The app's global `--chart-*` tokens are deliberately monochrome, which cannot
 * carry a ten-slice stacked bar, so this defines its own palette scoped to the
 * context surfaces — the same call (and the same mid-lightness oklch approach,
 * legible on both themes) that `dashboard/widgets/ChartWidget.tsx` documents.
 *
 * `order` is a *semantic* order — the fixed overhead a user can act on (system,
 * skills, tools) first, then the conversation itself, then the residual rows.
 * The bar and the legend both follow it, so a slice that grows between turns
 * stays in the same place instead of jumping as it overtakes its neighbours.
 */
export const CATEGORY_META: Record<
	string,
	{ color: string; order: number; hint?: string }
> = {
	system: {
		color: "oklch(0.62 0.19 256)",
		order: 0,
		hint: "Base instructions, the agent's persona, and recalled long-term memory.",
	},
	skills: {
		color: "oklch(0.56 0.18 306)",
		order: 1,
		hint: "Instructions injected by the skills enabled for this agent.",
	},
	output_style: {
		color: "oklch(0.64 0.21 1)",
		order: 2,
		hint: "The assigned personality profile's formatting instructions.",
	},
	tools: {
		color: "oklch(0.78 0.16 76)",
		order: 3,
		hint: "Tool and MCP definitions — names, descriptions, parameter schemas.",
	},
	plugin_context: {
		color: "oklch(0.7 0.12 182)",
		order: 4,
		hint: "Text a plugin's context hook added on its way out.",
	},
	documents: {
		color: "oklch(0.63 0.19 149)",
		order: 5,
		hint: "Extracted text from files attached to the conversation.",
	},
	history_replay: {
		color: "oklch(0.55 0.13 232)",
		order: 6,
		hint: "Earlier turns replayed to the agent as conversation context.",
	},
	history_user: { color: "oklch(0.68 0.14 264)", order: 7 },
	history_assistant: { color: "oklch(0.6 0.1 286)", order: 8 },
	history_tool: {
		color: "oklch(0.72 0.15 42)",
		order: 9,
		hint: "Output the agent's tool calls returned. Usually the largest slice of a long coding session.",
	},
	history_system: { color: "oklch(0.58 0.08 256)", order: 10 },
	images: { color: "oklch(0.66 0.14 330)", order: 11 },
	agent_baseline: {
		color: "oklch(0.5 0.03 256)",
		order: 12,
		hint: "The agent's own system prompt, tool definitions and the turns it has accumulated in its session. Ryu does not assemble any of these — it only injects a preamble — so they can only be measured together, as what is left over.",
	},
	unaccounted: {
		color: "oklch(0.5 0.03 256)",
		order: 13,
		hint: "Tokens the provider counted that the estimate does not explain. Ryu has no tokenizer, so category sizes are approximations.",
	},
	free: { color: "var(--muted)", order: 14 },
};

/** Fallback for a category id a newer Core introduced. */
const UNKNOWN_CATEGORY = { color: "oklch(0.6 0.05 256)", order: 99 };

export function categoryMeta(id: string) {
	return CATEGORY_META[id] ?? UNKNOWN_CATEGORY;
}

/** A slice ready to draw: a category plus its share of the window. */
export interface ContextSlice extends ContextCategory {
	color: string;
	/** Share of the window (0–100), or of the used tokens when no window is known. */
	pct: number;
}

/**
 * Turn a snapshot into the slices the panel draws, in semantic order.
 *
 * Two derived rows are appended rather than folded into the categories, because
 * both are honest statements about what Core does NOT know:
 *
 * - **agent_baseline / unaccounted** — the provider's own prompt count minus the
 *   sum of the estimates. On the ACP plane that gap is mostly the agent's own
 *   prompt (which Core never assembles), so it is labelled as such; elsewhere it
 *   is estimator drift and says so. Normalizing the categories up to the
 *   reported total instead would produce a chart that adds up and lies.
 * - **free** — the rest of the window, drawn so the bar reads as *occupancy*
 *   rather than a share-of-used pie.
 *
 * `window` falls back to the caller's own known context size (the model's launch
 * config), since Core only learns the window on the ACP plane.
 */
export function contextSlices(
	breakdown: ContextBreakdown,
	fallbackWindow?: number
): { slices: ContextSlice[]; used: number; window: number } {
	const window =
		breakdown.window > 0 ? breakdown.window : (fallbackWindow ?? 0);
	const reported = breakdown.reportedInput ?? 0;
	const remainder = Math.max(0, reported - breakdown.estimatedTotal);
	const rows: ContextCategory[] = [...breakdown.categories];
	if (remainder > 0) {
		rows.push(
			breakdown.plane === "acp"
				? {
						id: "agent_baseline",
						label: "Agent session",
						tokens: remainder,
					}
				: { id: "unaccounted", label: "Unaccounted", tokens: remainder }
		);
	}
	// The reported count wins when it is larger: it is the provider's own truth,
	// and the remainder row already carries the difference.
	const used = Math.max(reported, breakdown.estimatedTotal);
	if (window > used) {
		rows.push({ id: "free", label: "Free space", tokens: window - used });
	}
	const denominator = window > 0 ? window : used;
	const slices = rows
		.map((row) => ({
			...row,
			color: categoryMeta(row.id).color,
			pct: denominator > 0 ? (row.tokens / denominator) * 100 : 0,
		}))
		.sort((a, b) => categoryMeta(a.id).order - categoryMeta(b.id).order);
	return { slices, used, window };
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
