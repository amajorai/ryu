import { useLiteralMessages } from "@ryu/i18n/react";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils";
import {
	type ContextBand,
	type ContextBreakdownData,
	contextBands,
	contextPct,
	formatContextPct,
} from "./context-breakdown-model.ts";
import type { ContextUsage } from "./context-usage.tsx";
import styles from "./elements-one.module.css";
import type { AgentGeometryStyle } from "./elements-one-style.ts";
import {
	isPositiveContextCount,
	nativeContextMax,
	nativeContextRemaining,
} from "./native-context-usage.mjs";
import type { NativeTokenOperand } from "./native-token-count.mjs";
import { PromptCacheSummary } from "./prompt-cache-summary.tsx";

export type {
	ContextBreakdownData,
	ContextBreakdownSegment,
} from "./context-breakdown-model.ts";

/**
 * The Context panel: what is actually filling the model's context window, by
 * category — the full-size counterpart to the composer's ring.
 *
 * The ring answers "how full"; this answers "with what". Core attributes the
 * prompt it assembled (skills, tool definitions, memory, conversation history…)
 * and reports the sum as `attributed`; the provider reports the true prompt-token
 * count. Those two numbers DISAGREE, always on the ACP plane and sometimes
 * elsewhere, because an agent subprocess builds part of its own prompt. Rather
 * than hide that, the panel draws the shortfall as an explicit "Unattributed"
 * band and labels the source — a bar that silently failed to reach the
 * composer's percentage would read as a bug.
 *
 * See `apps/core/src/sidecar/adapters/context_breakdown.rs` for the producer.
 */
function BandRow({
	band,
	total,
}: {
	band: ContextBand;
	total: NativeTokenOperand;
}) {
	return (
		<div className="flex items-start gap-2.5 py-1.5">
			<span
				aria-hidden="true"
				className={cn(
					"mt-1 size-2.5 shrink-0 rounded-(--radius-glyph-compact)",
					band.className
				)}
			/>
			<div className="min-w-0 flex-1">
				<div className="truncate text-foreground text-xs">{band.label}</div>
				{band.detail ? (
					// Wraps rather than truncates: the detail is where the "why" lives
					// (what the unattributed band is, how many servers the tools came
					// from), and a clipped explanation is worse than a second line.
					<div className="type-caption text-muted-foreground">
						{band.detail}
					</div>
				) : null}
			</div>
			<div className="shrink-0 text-right">
				<div className="font-mono text-foreground text-xs tabular-nums">
					{formatCount(band.tokens)}
				</div>
				{isPositiveContextCount(total) ? (
					<div className="type-caption font-mono text-muted-foreground tabular-nums">
						{formatContextPct(contextPct(band.tokens, total))}
					</div>
				) : null}
			</div>
		</div>
	);
}
function SummaryRow({
	label,
	muted,
	value,
}: {
	label: string;
	muted?: boolean;
	value: string;
}) {
	return (
		<div className="flex items-center justify-between gap-6 text-xs">
			<span className="text-muted-foreground">{label}</span>
			<span
				className={cn(
					"font-mono tabular-nums",
					muted ? "text-muted-foreground" : "text-foreground"
				)}
			>
				{value}
			</span>
		</div>
	);
}
/**
 * The stacked bar. Segments are separated by a 2px surface gap rather than a
 * border so adjacent fills never blend into one another, and the whole bar keeps
 * a track behind it so the unused remainder is visible as free space.
 */
function BreakdownBar({
	bands,
	window: windowSize,
}: {
	bands: ContextBand[];
	window: NativeTokenOperand;
}) {
	const tl = useLiteralMessages();
	const drawn = isPositiveContextCount(windowSize)
		? windowSize
		: bands.reduce((a, b) => a + b.tokens, 0);
	if (!isPositiveContextCount(drawn)) {
		return null;
	}
	return (
		<div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
			{bands.map((band) => {
				const width = Math.max(
					0,
					Math.min(100, contextPct(band.tokens, drawn))
				);
				if (width <= 0) {
					return null;
				}
				return (
					<div
						className={cn(
							styles.width,
							"h-full first:rounded-l-full last:rounded-r-full",
							band.className
						)}
						key={band.key}
						style={
							{
								"--agent-width": `${width}%`,
							} satisfies AgentGeometryStyle as AgentGeometryStyle
						}
						title={tl("{label} — {tokenCount} tokens", {
							label: band.label,
							tokenCount: String(formatCount(band.tokens)),
						})}
					/>
				);
			})}
		</div>
	);
}
/**
 * Full context breakdown for one conversation.
 *
 * `breakdown` is Core's attribution of the last turn it assembled; `usage` is
 * the live provider-reported usage the composer ring already shows. Either may
 * be absent: with no breakdown the panel explains that the next turn will
 * produce one (attribution is per-turn and process-local), and with no usage it
 * reports estimated tokens without a percentage rather than inventing a window.
 */
export function ContextBreakdownPanel({
	breakdown,
	className,
	usage,
}: {
	breakdown?: ContextBreakdownData | null;
	className?: string;
	usage?: ContextUsage | null;
}) {
	const windowSize = usage?.total || breakdown?.window || 0;
	const reported = usage?.used ?? 0;
	if (!breakdown) {
		return (
			<div
				className={cn(
					"flex h-full flex-col items-center justify-center gap-1 p-6 text-center",
					className
				)}
			>
				<p className="text-foreground text-sm">No context breakdown yet</p>
				<p className="max-w-xs text-muted-foreground text-xs">
					Attribution is computed per turn. Send a message in this chat to see
					what is filling the context window.
				</p>
			</div>
		);
	}
	const bands = contextBands(breakdown, reported);
	const occupied = isPositiveContextCount(reported)
		? nativeContextMax(
				() => reported,
				() => breakdown.attributed
			)
		: breakdown.attributed;
	const free = nativeContextRemaining(
		() => windowSize,
		() => occupied
	);
	// Over-estimation: Core attributed MORE than the provider billed. Surfaced as
	// its own line so the numbers below the bar always add up on inspection.
	const overEstimate = nativeContextRemaining(
		() => breakdown.attributed,
		() => reported
	);
	return (
		<div
			className={cn(
				"scroll-fade flex h-full flex-col gap-4 overflow-y-auto p-4",
				className
			)}
		>
			<div className="flex flex-col gap-2">
				<div className="flex items-baseline justify-between gap-4">
					<h2 className="font-medium text-foreground text-sm">
						Context window
					</h2>
					{isPositiveContextCount(windowSize) ? (
						<span className="font-mono text-foreground text-sm tabular-nums">
							{formatContextPct(contextPct(occupied, windowSize))}
						</span>
					) : null}
				</div>
				<BreakdownBar bands={bands} window={windowSize} />
				<p className="type-caption text-muted-foreground">
					{breakdown.plane === "acp"
						? "Estimated — this agent builds part of its own prompt, so Core can only measure what it supplied."
						: "Estimated from the prompt Core assembled for the last turn."}
				</p>
			</div>

			<div className="flex flex-col divide-y divide-border">
				{bands.map((band) => (
					<BandRow band={band} key={band.key} total={windowSize || occupied} />
				))}
			</div>

			<div className="flex flex-col gap-1.5 border-border border-t pt-3">
				{isPositiveContextCount(reported) ? (
					<SummaryRow
						label="Reported by provider"
						value={formatCount(reported) ?? "—"}
					/>
				) : null}
				<SummaryRow
					label="Attributed by Core"
					value={formatCount(breakdown.attributed) ?? "—"}
				/>
				{overEstimate > 0 ? (
					<SummaryRow
						label="Over-estimated"
						muted
						value={`${formatCount(overEstimate)} tokens`}
					/>
				) : null}
				{breakdown.reserveOutput > 0 ? (
					<SummaryRow
						label="Reserved for reply"
						muted
						value={`${formatCount(breakdown.reserveOutput)} tokens`}
					/>
				) : null}
				{isPositiveContextCount(windowSize) ? (
					<SummaryRow
						label="Free"
						muted
						value={`${formatCount(free)} of ${formatCount(windowSize)}`}
					/>
				) : null}
			</div>

			{usage ? (
				<PromptCacheSummary
					className="border-border border-t pt-3 text-xs"
					usage={usage}
				/>
			) : null}
		</div>
	);
}
