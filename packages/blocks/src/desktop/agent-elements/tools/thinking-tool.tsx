import { memo, useEffect, useRef, useState } from "react";
import { useToolComplete } from "../hooks/use-tool-complete.ts";
import type { StepState, TimelineStep } from "../types/timeline.ts";
import {
	mapToolInvocationToStep,
	mapToolStateToStepState,
} from "../utils/tool-adapters.ts";
import { ToolRowBase } from "./tool-row-base.tsx";

const WHITESPACE_RE = /\s+/;

// Compact "1.2k" / "12k" formatter for a count, keeping one decimal below 10k.
function formatCompact(n: number): string {
	if (n < 1000) {
		return String(n);
	}
	const k = Math.round(n / 100) / 10;
	if (k >= 10) {
		return `${Math.round(k)}k`;
	}
	return `${k}k`;
}

// "Thought for {N}s" duration, promoting to "{m}m {s}s" past a minute.
function formatDuration(ms: number): string {
	const totalSec = Math.max(0, Math.round(ms / 1000));
	if (totalSec < 60) {
		return `${totalSec}s`;
	}
	const minutes = Math.floor(totalSec / 60);
	const seconds = totalSec % 60;
	return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

// Size hint for a reasoning block: prefer a real token count when the part
// carries one, else fall back to word (or, failing that, character) count of
// the reasoning text so the badge degrades gracefully.
function formatSizeHint(
	tokenCount: number | undefined,
	text: string
): string | null {
	if (typeof tokenCount === "number" && tokenCount > 0) {
		return `${formatCompact(tokenCount)} tokens`;
	}
	const trimmed = text.trim();
	if (!trimmed) {
		return null;
	}
	const words = trimmed.split(WHITESPACE_RE).filter(Boolean).length;
	if (words > 0) {
		return `${formatCompact(words)} words`;
	}
	return `${formatCompact(trimmed.length)} chars`;
}

// Duration of a reasoning block, in ms, or null when it can't be known.
//
// Prefers an explicit `output.totalDurationMs` reported by the engine. Otherwise
// it measures wall-clock elapsed time while the part is streaming — anchored to
// the part's `startedAt` when present, else to component mount — and freezes the
// last measured value the moment streaming ends. A thought loaded from history
// (never observed streaming, no reported duration) yields null so no bogus badge
// is shown.
function useThoughtDurationMs(
	isAnimating: boolean,
	startedAt: number | undefined,
	outputDurationMs: number | undefined
): number | null {
	const mountRef = useRef(Date.now());
	const anchor = typeof startedAt === "number" ? startedAt : mountRef.current;
	const [elapsedMs, setElapsedMs] = useState(0);

	useEffect(() => {
		if (!isAnimating) {
			return;
		}
		const update = () => setElapsedMs(Math.max(0, Date.now() - anchor));
		update();
		const id = setInterval(update, 500);
		return () => clearInterval(id);
	}, [isAnimating, anchor]);

	if (typeof outputDurationMs === "number" && outputDurationMs > 0) {
		return outputDurationMs;
	}
	return elapsedMs > 0 ? elapsedMs : null;
}

export interface ThinkingCollapsedProps {
	defaultOpen?: boolean;
	expanded?: boolean;
	onComplete: () => void;
	onToggleExpand?: () => void;
	outputDurationMs?: number;
	startedAt?: number;
	state: StepState;
	step: Extract<TimelineStep, { type: "tool-call" }>;
	tokenCount?: number;
}

export function ThinkingCollapsed({
	step,
	state,
	onComplete,
	defaultOpen,
	expanded,
	onToggleExpand,
	startedAt,
	outputDurationMs,
	tokenCount,
}: ThinkingCollapsedProps) {
	useToolComplete(state === "animating", step.duration, onComplete);

	const isAnimating = state === "animating";
	const reasoningText = step.thoughtContent ?? "";
	const hasContent = reasoningText.length > 0;

	// Auto-open when thought content first arrives during streaming, and
	// auto-collapse once streaming ends — while never fighting a manual toggle.
	const [open, setOpen] = useState(defaultOpen ?? (isAnimating && hasContent));
	const userToggledRef = useRef(false);
	const wasAnimatingRef = useRef(isAnimating);

	useEffect(() => {
		if (userToggledRef.current) {
			wasAnimatingRef.current = isAnimating;
			return;
		}
		if (isAnimating && hasContent) {
			setOpen(true);
		} else if (!isAnimating && wasAnimatingRef.current) {
			// Reasoning just completed — collapse to a tidy one-line summary.
			setOpen(false);
		}
		wasAnimatingRef.current = isAnimating;
	}, [isAnimating, hasContent]);

	const durationMs = useThoughtDurationMs(
		isAnimating,
		startedAt,
		outputDurationMs
	);
	const durationLabel = durationMs === null ? null : formatDuration(durationMs);
	const sizeHint = formatSizeHint(tokenCount, reasoningText);

	// When complete the duration lives in the label ("Thought for 5s"), so the
	// detail carries only the size hint. While streaming the label shimmers
	// ("Thinking"), so surface the live duration + size in the detail instead.
	const completeLabel = durationLabel
		? `Thought for ${durationLabel}`
		: "Thought";
	const detail = isAnimating
		? [durationLabel, sizeHint].filter(Boolean).join(" · ") || undefined
		: (sizeHint ?? undefined);

	const body = (
		<div className="max-h-[175px] overflow-y-auto">
			<p className="whitespace-pre-wrap text-muted-foreground text-sm">
				{reasoningText}
			</p>
		</div>
	);

	// If controlled from outside, delegate fully to the caller.
	if (expanded !== undefined) {
		return (
			<ToolRowBase
				completeLabel={completeLabel}
				detail={detail}
				expandable={hasContent}
				expanded={expanded}
				isAnimating={isAnimating}
				onToggleExpand={onToggleExpand}
				shimmerLabel="Thinking"
			>
				{body}
			</ToolRowBase>
		);
	}

	const handleToggle = () => {
		userToggledRef.current = true;
		setOpen((prev) => !prev);
	};

	return (
		<ToolRowBase
			completeLabel={completeLabel}
			detail={detail}
			expandable={hasContent}
			expanded={open}
			isAnimating={isAnimating}
			onToggleExpand={handleToggle}
			shimmerLabel="Thinking"
		>
			{body}
		</ToolRowBase>
	);
}

export interface ThinkingToolProps {
	defaultOpen?: boolean;
	expanded?: boolean;
	onComplete?: () => void;
	onToggleExpand?: () => void;
	part?: any;
	state?: StepState;
	step?: Extract<TimelineStep, { type: "tool-call" }>;
}

export const ThinkingTool = memo(function ThinkingTool({
	part,
	step: externalStep,
	state: externalState,
	onComplete: externalOnComplete,
	defaultOpen,
	expanded,
	onToggleExpand,
}: ThinkingToolProps) {
	let step: Extract<TimelineStep, { type: "tool-call" }>;
	let stepState: StepState;
	let onComplete: () => void;

	if (externalStep && externalState && externalOnComplete) {
		step = externalStep;
		stepState = externalState;
		onComplete = externalOnComplete;
	} else if (part) {
		step = mapToolInvocationToStep(part.toolCallId ?? part.id ?? "thinking", {
			toolName: "Thinking",
			args: part.input ?? part.args ?? {},
			state:
				part.state === "output-available"
					? "result"
					: part.state === "input-streaming"
						? "partial-call"
						: "call",
			result: part.output ?? part.result,
		});
		stepState = mapToolStateToStepState(
			part.state === "output-available"
				? "result"
				: part.state === "input-streaming"
					? "partial-call"
					: "call"
		);
		onComplete = () => {};
	} else {
		return null;
	}

	// Timing + size metadata, read with the same conventions sibling tools use
	// (see subagent-tool.tsx): the engine may stamp `startedAt` in provider
	// metadata and report a final duration / reasoning-token count on the output.
	const startedAt =
		(part?.callProviderMetadata?.custom?.startedAt as number | undefined) ??
		(part?.startedAt as number | undefined);
	const outputDurationMs =
		(part?.output?.totalDurationMs as number | undefined) ??
		(part?.output?.duration as number | undefined) ??
		(part?.output?.duration_ms as number | undefined);
	const tokenCount =
		(part?.output?.reasoningTokens as number | undefined) ??
		(part?.callProviderMetadata?.custom?.reasoningTokens as number | undefined);

	return (
		<ThinkingCollapsed
			defaultOpen={defaultOpen}
			expanded={expanded}
			onComplete={onComplete}
			onToggleExpand={onToggleExpand}
			outputDurationMs={outputDurationMs}
			startedAt={startedAt}
			state={stepState}
			step={step}
			tokenCount={tokenCount}
		/>
	);
});
