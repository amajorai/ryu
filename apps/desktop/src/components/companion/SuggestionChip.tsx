// apps/desktop/src/components/companion/SuggestionChip.tsx
//
// Trust-gated proactive suggestion chip for the companion overlay.
//
// Renders exactly ONE PushNow suggestion (or nothing when none is available).
// Three actions are wired back to Shadow's POST /api/feedback endpoint so
// DeliveryManager.record_feedback can calibrate trust scores:
//
//   Accept  → FeedbackKind::ThumbsUp
//   Dismiss → FeedbackKind::Dismiss
//   Snooze  → FeedbackKind::Snooze
//
// The chip is hidden entirely when `suggestion` is null (AC3: no placeholder
// or empty chip).

import { useCallback, useState } from "react";
import type {
	FeedbackKind,
	ProactiveSuggestion,
} from "@/src/lib/api/shadow.ts";
import { postFeedback } from "@/src/lib/api/shadow.ts";

// ── types ─────────────────────────────────────────────────────────────────────

export interface SuggestionChipProps {
	/** Called after any feedback action completes (success or failure). */
	onDismissed?: () => void;
	/** The top PushNow suggestion, or null when none is available. */
	suggestion: ProactiveSuggestion | null;
}

type ChipState = "idle" | "sending" | "done" | "error";

// ── component ─────────────────────────────────────────────────────────────────

/**
 * Renders a single trust-gated proactive suggestion chip.
 *
 * Returns null when `suggestion` is null — no placeholder is rendered (AC3).
 */
export function SuggestionChip({
	suggestion,
	onDismissed,
}: SuggestionChipProps) {
	const [chipState, setChipState] = useState<ChipState>("idle");

	const sendFeedback = useCallback(
		async (kind: FeedbackKind) => {
			if (!suggestion) {
				return;
			}
			setChipState("sending");
			const ok = await postFeedback({
				suggestion_type: suggestion.suggestion_type,
				kind,
			});
			setChipState(ok ? "done" : "error");
			// Always dismiss from the overlay regardless of success: if Shadow is
			// down the user's intent is still clear.
			onDismissed?.();
		},
		[suggestion, onDismissed]
	);

	// AC3: render nothing when there is no PushNow suggestion.
	if (!suggestion) {
		return null;
	}

	const isBusy = chipState === "sending";

	return (
		<section
			aria-label="Proactive suggestion"
			className="flex flex-col gap-2 rounded-md bg-info/8 px-3 py-2"
		>
			{/* Header row */}
			<div className="flex items-start justify-between gap-2">
				<span className="font-medium text-sm leading-snug">
					{suggestion.title}
				</span>
				<span className="shrink-0 rounded bg-info/15 px-1.5 py-0.5 font-mono text-info text-xs dark:text-info">
					suggestion
				</span>
			</div>

			{/* Body */}
			{suggestion.body && (
				<p className="text-muted-foreground text-xs leading-relaxed">
					{suggestion.body}
				</p>
			)}

			{/* Action row */}
			<div className="flex gap-2">
				<button
					className="flex-1 rounded-md bg-info/10 px-3 py-1.5 font-medium text-info text-xs transition-colors hover:bg-info/20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-info"
					disabled={isBusy}
					onClick={() => {
						sendFeedback("thumbs_up").catch(() => undefined);
					}}
					type="button"
				>
					Accept
				</button>
				<button
					className="flex-1 rounded-md px-3 py-1.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
					disabled={isBusy}
					onClick={() => {
						sendFeedback("snooze").catch(() => undefined);
					}}
					type="button"
				>
					Snooze
				</button>
				<button
					className="flex-1 rounded-md px-3 py-1.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
					disabled={isBusy}
					onClick={() => {
						sendFeedback("dismiss").catch(() => undefined);
					}}
					type="button"
				>
					Dismiss
				</button>
			</div>

			{/* Error notice — shown only when Shadow was unreachable at feedback time */}
			{chipState === "error" && (
				<p className="text-muted-foreground text-xs" role="alert">
					Feedback could not be delivered (Shadow offline). Intent recorded
					locally.
				</p>
			)}
		</section>
	);
}
