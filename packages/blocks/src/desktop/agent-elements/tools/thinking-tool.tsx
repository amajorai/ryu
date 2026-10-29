import { useLiteralMessages } from "@ryu/i18n/react";
import { AgentActivity } from "@ryu/ui/components/agents/agent-activity";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { memo, useMemo } from "react";
import { useToolComplete } from "../hooks/use-tool-complete.ts";
import type { StepState, TimelineStep } from "../types/timeline.ts";
import type { NativeSdkValue } from "../utils/native-sdk-observation.ts";
import {
	mapToolInvocationToStep,
	mapToolStateToStepState,
} from "../utils/tool-adapters.ts";
import { resolveThinkingStepState } from "./thinking-state.ts";

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

export interface ThinkingCollapsedProps {
	defaultOpen?: boolean;
	expanded?: boolean;
	onComplete: () => void;
	onToggleExpand?: () => void;
	outputDurationMs?: NativeSdkValue;
	startedAt?: number;
	state: StepState;
	step: Extract<TimelineStep, { type: "tool-call" }>;
	tokenCount?: NativeSdkValue;
}

export function ThinkingCollapsed({
	step,
	state,
	onComplete,
	defaultOpen,
	outputDurationMs,
	tokenCount,
}: ThinkingCollapsedProps) {
	const tl = useLiteralMessages();
	useToolComplete(state === "animating", step.duration, onComplete);

	const isAnimating = state === "animating";
	const reasoningText = step.thoughtContent ?? "";
	const hasContent = reasoningText.length > 0;

	// Duration: prefer an engine-reported number, else freeze the wall-clock
	// elapsed time measured while streaming. A thought loaded from history with
	// no reported duration yields null so no bogus badge is shown.
	const durationLabel = useMemo(() => {
		if (isNativeNumber(outputDurationMs) && outputDurationMs > 0) {
			return formatDuration(outputDurationMs);
		}
		return null;
	}, [outputDurationMs]);

	const sizeHint = useMemo(() => {
		if (isNativeNumber(tokenCount) && tokenCount > 0) {
			return `${tokenCount} tokens`;
		}
		const trimmed = reasoningText.trim();
		if (!trimmed) {
			return null;
		}
		return `${trimmed.split(/\s+/).filter(Boolean).length} words`;
	}, [reasoningText, tokenCount]);

	const summary = durationLabel
		? tl("Thought for {durationLabel}", { durationLabel })
		: "Thought";

	const items = useMemo(
		() => [
			{
				id: step.id ?? "thinking",
				type: "step" as const,
				label: hasContent ? reasoningText : "Thinking",
				status: isAnimating ? ("active" as const) : ("complete" as const),
				meta: isAnimating
					? [durationLabel, sizeHint].filter(Boolean).join(" · ") || undefined
					: (sizeHint ?? undefined),
			},
		],
		[hasContent, isAnimating, reasoningText, sizeHint, durationLabel, step.id]
	);

	return (
		<AgentActivity
			activeLabel="Thinking"
			collapseOnComplete={!hasContent}
			contentType="step"
			defaultOpen={defaultOpen ?? (isAnimating && hasContent)}
			items={items}
			status={isAnimating ? "working" : "complete"}
			summary={summary}
		/>
	);
}

export interface ThinkingToolProps {
	/**
	 * The chat's own status, in `getToolStatus` terms: only `"streaming"` (or
	 * `"submitted"`) means a thought derived from `part` may still be running.
	 * Without it a thought whose closing frame never landed (crash, Stop, Core
	 * restart) shimmers and counts up forever — including when the thread is
	 * reopened days later. Every other tool row gets this guard via
	 * `getToolStatus`; this one was called without it.
	 */
	chatStatus?: string;
	defaultOpen?: boolean;
	expanded?: boolean;
	onComplete?: () => void;
	onToggleExpand?: () => void;
	part?: any;
	state?: StepState;
	step?: Extract<TimelineStep, { type: "tool-call" }>;
}

export const ThinkingTool = memo(function ThinkingTool({
	chatStatus,
	part,
	step: externalStep,
	state: externalState,
	onComplete: externalOnComplete,
	defaultOpen,
}: ThinkingToolProps) {
	let step: Extract<TimelineStep, { type: "tool-call" }>;
	let stepState: StepState;
	let onComplete: () => void;
	// Whether `stepState` was derived from the message part or handed down by a
	// caller that drives this row itself. Only the payload-derived value is
	// suspect — see the freeze below.
	let stateFromPart = false;

	if (externalStep && externalState && externalOnComplete) {
		step = externalStep;
		stepState = externalState;
		onComplete = externalOnComplete;
	} else if (part) {
		stateFromPart = true;
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

	// A turn that ended without its closing frame must not keep shimmering; see
	// resolveThinkingStepState for why the chat's status is the deciding vote.
	stepState = resolveThinkingStepState({
		chatStatus,
		stateFromPart,
		stepState,
	});

	// Timing + size metadata, read with the same conventions sibling tools use
	// (see subagent-tool.tsx): the engine may stamp `startedAt` in provider
	// metadata and report a final duration / reasoning-token count on the output.
	const outputDurationMs =
		part?.output?.totalDurationMs ??
		part?.output?.duration ??
		part?.output?.duration_ms;
	const tokenCount =
		part?.output?.reasoningTokens ??
		part?.callProviderMetadata?.custom?.reasoningTokens;

	return (
		<ThinkingCollapsed
			defaultOpen={defaultOpen}
			onComplete={onComplete}
			outputDurationMs={outputDurationMs}
			state={stepState}
			step={step}
			tokenCount={tokenCount}
		/>
	);
});
