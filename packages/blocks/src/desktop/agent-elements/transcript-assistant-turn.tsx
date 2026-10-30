import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { AgentTitleBadge } from "@ryu/ui/components/agent-title-badge.tsx";
import { Marker, MarkerContent, MarkerIcon } from "@ryu/ui/components/marker";
import {
	Message,
	MessageAvatar,
	MessageContent,
	MessageFooter,
	MessageHeader,
} from "@ryu/ui/components/message";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { formatDateTime, formatTime } from "@ryu/ui/lib/timezone.ts";
import { cn } from "@ryu/ui/lib/utils";
import { GoalCompletionFooter } from "./goal-completion.tsx";
import { getGoalElapsedMs } from "./goal-message.ts";
import { isMessageReactionAction } from "./message-action-types.ts";
import { VersionPager } from "./message-actions.tsx";
import type { MessageListScope } from "./message-list-scope.ts";
import { AcpUsageStats, MessageStats } from "./message-stats.tsx";
import { StatsFooter } from "./stats-footer.tsx";
import { renderTranscriptAssistantMessage } from "./transcript-assistant-message.tsx";
import type { TranscriptTurnContext } from "./transcript-turn.tsx";
import { deriveTurnEndCards } from "./turn-end-cards.ts";
import { TurnEndCards } from "./turn-end-cards.tsx";
import {
	MESSAGE_TIME_OPTIONS,
	MESSAGE_TOOLTIP_OPTIONS,
} from "./user-message.tsx";
import { nativeSdkNumber } from "./utils/live-file-media.ts";
import { isInterruptedMessage } from "./utils/live-message-observations.ts";
import {
	nativeCreatedAtLookup,
	nativeMessageDate,
} from "./utils/native-message-date-abi.ts";

/** The account a turn's usage was billed to, beside the stats footer. */
function UsageAccountLabel({ accountLabel }: { accountLabel: string }) {
	const tl = useLiteralMessages();
	return (
		<span
			className="truncate text-muted-foreground text-xs"
			title={tl("Usage for {accountLabel}", { accountLabel })}
		>
			{accountLabel}
		</span>
	);
}

/** The turn's stats footer, gated as a whole. */
function renderTranscriptTurnFooter(
	scope: MessageListScope,
	turnContext: TranscriptTurnContext,
	isTurnStreaming: boolean
) {
	const {
		contextSize,
		messages,
		statsEnabled,
		statsModelName,
		statsPluginEnabled,
		statsUsage,
	} = scope;
	const { isLastTurn, turn } = turnContext;
	// Gate the whole footer, not each component: an
	// empty `MessageFooter` still renders a gapped
	// row under every turn.
	if (!statsEnabled) {
		return null;
	}
	const lastAssistantMsg = turn.assistantMsgs.at(-1);
	return lastAssistantMsg ? (
		<MessageFooter spacing="relaxed">
			{statsPluginEnabled && isLastTurn ? (
				<>
					<StatsFooter
						contextSize={contextSize}
						conversationMessages={messages}
						isMainChainActive={isTurnStreaming}
						modelName={statsModelName}
						usage={statsUsage}
					/>
					{statsUsage?.accountLabel ? (
						<UsageAccountLabel accountLabel={statsUsage.accountLabel} />
					) : null}
				</>
			) : (
				<>
					{/* Local-engine (llama.cpp) finalized stats. */}
					<MessageStats contextSize={contextSize} msg={lastAssistantMsg} />
					{/* ACP agents: live-ticking token count while
	    streaming, then frozen count + tok/s +
	    duration once the frame sets done:true.
	    `isLive` is the second brake — a turn that
	    never got its done:true frame (crash, Stop,
	    Core restart) would otherwise tick forever,
	    including days later when the thread is
	    reopened. */}
					<AcpUsageStats isLive={isTurnStreaming} msg={lastAssistantMsg} />
				</>
			)}
		</MessageFooter>
	) : null;
}

/** The assistant side of a turn: its header, messages, cards and footer. */
export function renderTranscriptAssistantTurn(
	scope: MessageListScope,
	turnContext: TranscriptTurnContext
) {
	const {
		assistantAvatar,
		assistantName,
		assistantTitle,
		goalCompletion,
		isMounted,
		isStreaming,
		messageActions,
		onAgentUiSubmit,
		onOpenFile,
		onReviewFileEdits,
		onSelectVersion,
		onUndoFileEdits,
		versions,
	} = scope;
	const { isLastTurn, turn, turnKey } = turnContext;
	const assistantParts = turn.assistantMsgs.flatMap((msg) => msg.parts ?? []);
	const isTurnStreaming = isStreaming && isLastTurn;
	const turnEndCards = deriveTurnEndCards(assistantParts, turnKey);
	// Only reserve toolbar height when there's actually
	// something to show in it. With showCopyToolbar=false the
	// toolbar would otherwise render as a 48px-tall empty box,
	// creating large gaps between assistant turns.
	// The reply's send time comes from the last
	// assistant message (the turn's final part);
	// mirrors the user row.
	const assistantCreatedAt = nativeCreatedAtLookup(
		turn.assistantMsgs.at(-1)
	)?.createdAt;
	const assistantTimestamp =
		isMounted && assistantCreatedAt
			? nativeMessageDate(assistantCreatedAt)
			: null;
	const branchMsgId = turn.assistantMsgs.at(-1)?.id;
	const isGoalCompletionTurn =
		Boolean(goalCompletion) &&
		!isTurnStreaming &&
		(goalCompletion?.messageId
			? goalCompletion.messageId === branchMsgId
			: isLastTurn);
	const completionEndMs =
		nativeSdkNumber(goalCompletion?.achievedAt) &&
		Number.isFinite(goalCompletion.achievedAt)
			? goalCompletion.achievedAt
			: assistantTimestamp?.getTime();
	const goalCompletionElapsedMs =
		isGoalCompletionTurn && goalCompletion
			? getGoalElapsedMs(goalCompletion, completionEndMs ?? Date.now())
			: null;
	const goalCompletionNode =
		goalCompletionElapsedMs === null ? null : (
			<GoalCompletionFooter
				completedAt={
					isMounted && completionEndMs ? new Date(completionEndMs) : null
				}
				elapsedMs={goalCompletionElapsedMs}
			/>
		);
	// The send time rides in the hover action row under the reply, never above
	// it: a quiet transcript shows content alone until you point at a message.
	const timestampNode = assistantTimestamp ? (
		<TooltipProvider delay={0}>
			<Tooltip>
				{/* Base UI composes through `render`, not `asChild`. */}
				<TooltipTrigger
					render={
						<span className="inline-flex items-center">
							{formatTime(assistantTimestamp, MESSAGE_TIME_OPTIONS)}
						</span>
					}
				/>
				<TooltipContent>
					<p>{formatDateTime(assistantTimestamp, MESSAGE_TOOLTIP_OPTIONS)}</p>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	) : null;
	const reactionAction = messageActions?.find(
		(a) =>
			(a.target === "assistant" || a.target === "any") &&
			isMessageReactionAction(a)
	);
	const assistantVersion = branchMsgId ? versions?.[branchMsgId] : undefined;
	const turnInterrupted = turn.assistantMsgs.some(isInterruptedMessage);
	return (
		<Message align="start" className="group/assistant-turn">
			{assistantAvatar ? (
				<MessageAvatar
					className="size-5 self-start group-has-data-[slot=message-footer]/message:translate-y-0"
					variant="transparent"
				>
					{assistantAvatar}
				</MessageAvatar>
			) : null}
			<MessageContent spacing="compact">
				{assistantName ? (
					// Named only in multi-agent threads: the host passes a name (and a
					// `size-5` avatar) when more than one agent can answer here.
					<MessageHeader
						className="text-(length:--text-detail) text-muted-foreground leading-(--text-detail--line-height)"
						inset="none"
						spacing="relaxed"
					>
						<span>{assistantName}</span>
						{assistantTitle ? <AgentTitleBadge title={assistantTitle} /> : null}
					</MessageHeader>
				) : null}
				<div
					className={cn(
						"flex min-w-0 flex-col",
						turn.assistantMsgs.length > 1 ? "gap-1" : "gap-3"
					)}
				>
					{turn.assistantMsgs.map((msg, i) =>
						renderTranscriptAssistantMessage(
							scope,
							turnContext,
							{
								goalCompletionNode,
								isTurnStreaming,
								reactionAction,
								timestampNode,
							},
							msg,
							i
						)
					)}
				</div>
				{!isTurnStreaming && turnEndCards.length > 0 ? (
					<TurnEndCards
						cards={turnEndCards}
						onAgentUiSubmit={onAgentUiSubmit}
						onOpenFile={onOpenFile}
						onReviewFileEdits={onReviewFileEdits}
						onUndoFileEdits={onUndoFileEdits}
					/>
				) : null}
				{turnInterrupted ? (
					// The turn the node died in the middle of. Driven by
					// `_interrupted` — server-stamped and reconciled at Core boot —
					// and NOT by sniffing the text, which is how this used to work:
					// the history mapper appended an "⚠️ Interrupted…" sentence as a
					// trailing text part, so a crash notice was indistinguishable
					// from something the agent wrote, came along when you copied the
					// reply, and had to be pattern-matched back out on resume.
					<Marker spacing="interrupted" tone="destructive" variant="separator">
						<MarkerIcon>
							<HugeiconsIcon icon={Alert02Icon} strokeWidth={2} />
						</MarkerIcon>
						<MarkerContent>
							Interrupted — this reply was cut off before it finished. Send a
							follow-up to continue; it will not auto-resume after a restart.
						</MarkerContent>
					</Marker>
				) : null}
				{renderTranscriptTurnFooter(scope, turnContext, isTurnStreaming)}
				{assistantVersion && assistantVersion.count > 1 && onSelectVersion && (
					<VersionPager
						alignClass="justify-start"
						count={assistantVersion.count}
						ids={assistantVersion.ids}
						index={assistantVersion.index}
						onSelect={onSelectVersion}
					/>
				)}
			</MessageContent>
		</Message>
	);
}
