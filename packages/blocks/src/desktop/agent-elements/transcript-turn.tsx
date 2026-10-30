import { cn } from "@ryu/ui/lib/utils";
import { memo } from "react";
import { AnswerNowButton } from "./answer-now-button.tsx";
import { dayLabel } from "./date-groups.ts";
import { DateSeparator } from "./date-separator.tsx";
import { getTextFromParts } from "./message-list-helpers.ts";
import type { MessageListScope } from "./message-list-scope.ts";
import { renderTranscriptAssistantTurn } from "./transcript-assistant-turn.tsx";
import {
	type TranscriptTurnContext,
	type TranscriptTurnRowProps,
	transcriptTurnRowPropsEqual,
} from "./transcript-turn-equality.ts";
import { renderTranscriptUserTurn } from "./transcript-user-turn.tsx";
import { TypingIndicator } from "./typing-indicator.tsx";

export type { TranscriptTurnContext } from "./transcript-turn-equality.ts";

type TranscriptTurn = MessageListScope["turns"][number];

// Whether a turn's reply has any prose yet. Keyed on the turn object, which
// stays the same object while its messages do (see `reuseSettledTurns`).
const assistantTextByTurn = new WeakMap<TranscriptTurn, boolean>();
function turnHasAssistantText(turn: TranscriptTurn): boolean {
	const cached = assistantTextByTurn.get(turn);
	if (cached !== undefined) {
		return cached;
	}
	const hasText = turn.assistantMsgs.some(
		(msg) => getTextFromParts(msg.parts ?? [], "\n\n").trim().length > 0
	);
	assistantTextByTurn.set(turn, hasText);
	return hasText;
}

function getTranscriptTurnContext(
	scope: MessageListScope,
	turn: TranscriptTurn,
	turnIndex: number
): TranscriptTurnContext {
	const {
		firstUnreadMessageId,
		searchActiveMessageId,
		separatorKeys,
		turns,
		userRunPositions,
	} = scope;
	const isLastTurn = turnIndex === turns.length - 1;
	const turnKey = turn.userMsg?.id ?? `turn-${turnIndex}`;
	// Present only on the turn that OPENS a day run, and never
	// for the undated head run (subagent transcripts, the
	// storyboard and the e2e fixtures carry no `createdAt`, so
	// they get no separators at all).
	const separatorKey = separatorKeys.get(turnIndex);
	// Where this turn's USER row sits in its sender run. Also the
	// spacing key: a row that continues a run sits 4px under its
	// predecessor; every other turn opens 24px below the last.
	const groupPosition = userRunPositions[turnIndex] ?? "single";
	const turnAnchorId = turn.userMsg?.id ?? turn.assistantMsgs[0]?.id ?? null;
	const continuesRun = groupPosition === "middle" || groupPosition === "last";
	const hasUnreadMessage = turn.assistantMsgs.some(
		(msg) => msg.id === firstUnreadMessageId
	);
	const hasAssistantText = turnHasAssistantText(turn);
	const isSearchActive =
		searchActiveMessageId === turn.userMsg?.id ||
		turn.assistantMsgs.some((msg) => msg.id === searchActiveMessageId);
	return {
		turn,
		turnIndex,
		isLastTurn,
		turnKey,
		separatorKey,
		groupPosition,
		turnAnchorId,
		continuesRun,
		hasUnreadMessage,
		hasAssistantText,
		isSearchActive,
	};
}

/**
 * One turn row. Memoised so that, while a reply streams, only the live turn
 * renders per chunk; see `transcriptTurnRowPropsEqual` for what a settled turn
 * compares.
 */
const TranscriptTurnRow = memo(function TranscriptTurnRow({
	scope,
	turnContext,
}: TranscriptTurnRowProps) {
	const {
		animationsEnabled,
		answerNow,
		assistantHiddenTurns,
		planningLabel,
		planningLeading,
		registerTranscriptAnchor,
		showPlanning,
		startOfToday,
	} = scope;
	const {
		continuesRun,
		groupPosition,
		hasAssistantText,
		hasUnreadMessage,
		isLastTurn,
		isSearchActive,
		separatorKey,
		turn,
		turnAnchorId,
		turnKey,
	} = turnContext;

	return (
		// A fragment, NOT a wrapper element: the separator and the
		// turn must both be DIRECT children of Content, so the
		// separator can never be picked as a scroll target. beUI
		// has no item primitive, so the turn is a plain div that
		// carries the item data-slot the grouping specs read.
		<>
			{separatorKey === undefined ? null : (
				<DateSeparator
					dayKey={separatorKey}
					label={dayLabel(separatorKey, startOfToday)}
				/>
			)}
			<div
				className={cn(
					"relative space-y-6",
					!(isLastTurn || isSearchActive) &&
						"[contain-intrinsic-size:auto_10rem] [content-visibility:auto]",
					continuesRun ? "mt-1" : "mt-6",
					isSearchActive && "rounded-xl bg-muted"
				)}
				data-chat-search-active={isSearchActive ? "true" : undefined}
				data-group-position={groupPosition}
				data-message-id={turn.userMsg ? turnKey : undefined}
				data-slot="message-scroller-item"
				data-transcript-anchor-id={
					turn.userMsg ? undefined : (turnAnchorId ?? undefined)
				}
				ref={(element) => {
					if (!turn.userMsg && turnAnchorId) {
						registerTranscriptAnchor(turnAnchorId, element);
					}
				}}
			>
				{turn.userMsg && renderTranscriptUserTurn(scope, turnContext)}

				{turn.assistantMsgs.length > 0 &&
					// Detail level "None" and this turn was pure tool
					// work: no reply bubble at all. The turn itself
					// survives here only because it carries the user's
					// own message (or the planning row) — see the
					// filter above.
					!assistantHiddenTurns.has(turn) &&
					// Keep the thinking-only row compact until output starts, then
					// render arriving prose alongside the live status indicator.
					!(
						isLastTurn &&
						showPlanning &&
						!hasUnreadMessage &&
						!hasAssistantText
					) &&
					renderTranscriptAssistantTurn(scope, turnContext)}

				{isLastTurn && showPlanning && (
					<div
						className="flex items-center gap-2 py-0.5"
						data-bubble-enter={animationsEnabled ? "" : undefined}
					>
						{planningLeading}
						<TypingIndicator label={planningLabel} />
					</div>
				)}
				{isLastTurn && answerNow ? (
					<div className={cn("flex", planningLeading ? "pl-6" : undefined)}>
						<AnswerNowButton control={answerNow} />
					</div>
				) : null}
			</div>
		</>
	);
}, transcriptTurnRowPropsEqual);

/** Every turn of the transcript: the user's message, the assistant's reply and the turn's footer rows. */
export function renderTranscriptTurns(scope: MessageListScope) {
	return scope.turns.map((turn, turnIndex) => {
		const turnContext = getTranscriptTurnContext(scope, turn, turnIndex);
		return (
			<TranscriptTurnRow
				key={turnContext.turnKey}
				scope={scope}
				turnContext={turnContext}
			/>
		);
	});
}
