import {
	isPositiveContextCount,
	nativeContextPct,
	nativeContextRemaining,
} from "./native-context-usage.mjs";
import type { NativeTokenOperand } from "./native-token-count.mjs";
/**
 * The pure half of the Context panel: the wire types Core sends, the fixed
 * category palette, and the band math. Kept free of React so the reconciliation
 * rules (what counts as unattributed, what a category is coloured) are
 * unit-testable on their own — the rendering half is `context-breakdown.tsx`.
 *
 * Producer: `apps/core/src/sidecar/adapters/context_breakdown.rs`.
 */
/** A category of context, as Core attributes it. Mirrors `ContextSegment`. */
export interface ContextBreakdownSegment {
	/** Optional sub-label ("24 tools across 5 servers"). */
	detail?: string;
	/** Stable category id — the key into {@link SEGMENT_STYLES}. */
	kind: string;
	label: string;
	tokens: number;
}
/** One turn's attribution. Mirrors `ContextBreakdown`. */
export interface ContextBreakdownData {
	/** Sum of `segments` — what Core could account for. */
	attributed: number;
	/** Which plane assembled the prompt. */
	plane: "acp" | "openai";
	/** Tokens held back for the reply; 0 when no app-level budget is set. */
	reserveOutput: number;
	segments: ContextBreakdownSegment[];
	/** Core's view of the window size; 0 when unknown. */
	window: number;
}
/**
 * Fixed hue per category. Colour follows the ENTITY, never its rank — "skills"
 * is the same hue whether it is the largest band or the smallest, so comparing
 * two conversations is possible at a glance.
 *
 * The eight hues are the validated categorical order (adjacent-pair CVD ΔE 9.1
 * light / 8.4 dark, normal-vision 19.6 / 19.3), stepped separately for the dark
 * surface rather than flipped. Three light-mode steps fall below 3:1 against
 * white, which obliges the relief rule — every band therefore also has a
 * labelled row below the bar, so identity is never carried by colour alone.
 *
 * Categories beyond the eight slots (persona, compaction summaries) render in
 * muted ink rather than a ninth invented hue; their rows still carry a text
 * label, which is what identifies them.
 */
/** Authored segment classes plus the existing mutable extension-key port. */
export interface ContextSegmentStyleRegistry {
	documents: string;
	images: string;
	instructions: string;
	memory: string;
	messages: string;
	recall: string;
	skills: string;
	tools: string;
	[kind: string]: string;
}
export const SEGMENT_STYLES: ContextSegmentStyleRegistry = {
	documents: "bg-[#4a3aa7] dark:bg-[#9085e9]",
	images: "bg-[#e34948] dark:bg-[#e66767]",
	instructions: "bg-[#008300] dark:bg-[#008300]",
	memory: "bg-[#eda100] dark:bg-[#c98500]",
	messages: "bg-[#2a78d6] dark:bg-[#3987e5]",
	recall: "bg-[#e87ba4] dark:bg-[#d55181]",
	skills: "bg-[#eb6834] dark:bg-[#d95926]",
	tools: "bg-[#1baf7a] dark:bg-[#199e70]",
};
/** Fallback fill for a category with no dedicated slot. */
export const OTHER_STYLE = "bg-muted-foreground";
/** The band for context Core could not attribute (agent-side prompt, tool results). */
export const UNATTRIBUTED_STYLE = "bg-muted-foreground/40";
export function segmentStyle(kind: string): string {
	return SEGMENT_STYLES[kind] ?? OTHER_STYLE;
}
/** One row of the bar: a fill class plus the tokens it represents. */
export interface ContextBand {
	className: string;
	detail?: string;
	key: string;
	label: string;
	tokens: number;
}
/**
 * Assemble the bands to draw, in bar order: attributed categories largest-first
 * (Core already sorts them), then the unattributed remainder.
 *
 * `reported` is the provider's prompt-token count when known. When it exceeds
 * what Core attributed, the difference is real context that Core cannot see —
 * shown, not swallowed. When it is SMALLER (Core over-estimates, e.g. its
 * `len / 3.5` heuristic on dense text), no negative band is produced; the panel
 * reports the delta numerically instead.
 */
export function contextBands(
	breakdown: ContextBreakdownData,
	reported?: NativeTokenOperand
): ContextBand[] {
	const bands: ContextBand[] = breakdown.segments.map((s) => ({
		className: segmentStyle(s.kind),
		detail: s.detail,
		key: s.kind,
		label: s.label,
		tokens: s.tokens,
	}));
	const unattributed = nativeContextRemaining(
		() => reported ?? 0,
		() => breakdown.attributed
	);
	if (unattributed > 0) {
		bands.push({
			className: UNATTRIBUTED_STYLE,
			detail: "Agent-side prompt and tool results Core cannot measure",
			key: "unattributed",
			label: "Unattributed",
			tokens: unattributed,
		});
	}
	return bands;
}
/** `tokens` as a percentage of `total`; 0 when the total is unknown. */
export function contextPct(
	tokens: NativeTokenOperand,
	total: NativeTokenOperand
): number {
	if (!isPositiveContextCount(total)) {
		return 0;
	}
	return nativeContextPct(tokens, total);
}
/** One-decimal percentage, with a floor label so a tiny band never reads "0.0%". */
export function formatContextPct(value: number): string {
	if (value > 0 && value < 0.1) {
		return "<0.1%";
	}
	return `${value.toFixed(1)}%`;
}
