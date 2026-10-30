"use client";

// The proactive suggestion chip inside the morphing island (Island U4).
//
// Renders a single surfaced suggestion: title + one-line body, with the host's
// actions (Accept, Dismiss, and Snooze behind a "More" toggle in the Island) on
// one row inside the chip. The view stays presentational: the host owns what the
// actions do. Auto-collapse is driven by a timer in the island's suggestion
// queue (use-suggestion-queue), not by this view.
//
// Prior art: apps/desktop/src/components/companion/SuggestionChip.tsx.

import type { ReactNode } from "react";

/** Structural shape of a surfaced suggestion (matches the island queue item). */
export interface IslandSuggestionView {
	body: string;
	title: string;
}

export interface IslandSuggestionChipProps {
	/** The host's action buttons, drawn on one row under the text. */
	actions?: ReactNode;
	suggestion?: IslandSuggestionView;
	/**
	 * Let the title/body wrap onto more lines instead of truncating each to one.
	 * Only safe on a surface whose height tracks its content (the desktop island
	 * pill measures this chip and grows); the web island's chip sits in a
	 * fixed-height shape, so it keeps the single-line default.
	 */
	wrap?: boolean;
}

const DEMO_SUGGESTION: IslandSuggestionView = {
	title: "Summarize this PR diff?",
	body: "You have been reviewing changes for 4 minutes",
};

export function IslandSuggestionChip({
	actions,
	suggestion = DEMO_SUGGESTION,
	wrap = false,
}: IslandSuggestionChipProps) {
	const lineClass = wrap ? "break-words" : "truncate";
	return (
		<section
			aria-label="Proactive suggestion"
			className="flex w-full items-start gap-2 px-1 py-1"
		>
			<span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground" />
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<div className="min-w-0">
					<p className={`font-medium text-foreground text-sm ${lineClass}`}>
						{suggestion.title}
					</p>
					{suggestion.body.trim().length > 0 ? (
						<p className={`text-detail text-muted-foreground ${lineClass}`}>
							{suggestion.body}
						</p>
					) : null}
				</div>
				{actions ? (
					<div className="flex items-center gap-1">{actions}</div>
				) : null}
			</div>
		</section>
	);
}
