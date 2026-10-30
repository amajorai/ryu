import { Marker, MarkerContent, MarkerIcon } from "@ryu/ui/components/marker";
import type React from "react";
import { Fragment, memo, useMemo } from "react";
import { AssistantParts } from "./assistant-parts.tsx";
import type { AssistantPartsProps } from "./assistant-parts-types.ts";
import {
	isMemoryCitationsAction,
	isMessageReactionAction,
} from "./message-action-types.ts";
import { contextMenuReactionsFor, MessageToolbar } from "./message-actions.tsx";
import { messageGroupPositionFor } from "./message-bubble.ts";
import { MessageContextMenu } from "./message-context-menu.tsx";
import { getTextFromParts } from "./message-list-helpers.ts";
import type { MessageListScope } from "./message-list-scope.ts";
import type { TranscriptTurnContext } from "./transcript-turn.tsx";
import type { ContributedMessageAction } from "./types.ts";
import { messageIsEphemeral } from "./utils/live-message-observations.ts";

/** What the assistant turn computed once for every message it draws. */
export interface TranscriptAssistantTurnState {
	goalCompletionNode: React.ReactNode;
	isTurnStreaming: boolean;
	reactionAction:
		| NonNullable<MessageListScope["messageActions"]>[number]
		| undefined;
	/** The reply's send time, shown in the last message's hover action row. */
	timestampNode: React.ReactNode;
}

type TranscriptAssistantPartsProps = Omit<
	AssistantPartsProps,
	"onRetryError"
> & {
	msgIsEphemeral: boolean;
	onRegenerateMessage?: (messageId: string) => void;
	/** The failed-request row's own retry. */
	onRetryError?: () => void;
};

/**
 * One message's parts, memoised on its props. A live turn can hold several
 * assistant messages (multi-agent replies); only the one streaming changes per
 * chunk, so the others must not rebuild their parts. The per-message retry is
 * bound here, where it can be memoised, instead of inline in the turn.
 */
const TranscriptAssistantParts = memo(function TranscriptAssistantParts({
	msgIsEphemeral,
	onRegenerateMessage,
	onRetryError,
	...props
}: TranscriptAssistantPartsProps) {
	const messageId = props.msg.id;
	const retry = useMemo(() => {
		if (messageId === "agent-chat-error") {
			return onRetryError;
		}
		return onRegenerateMessage && !msgIsEphemeral
			? () => onRegenerateMessage(messageId)
			: undefined;
	}, [messageId, msgIsEphemeral, onRegenerateMessage, onRetryError]);
	return <AssistantParts {...props} onRetryError={retry} />;
});

/** One assistant message of a turn, with its toolbar. */
export function renderTranscriptAssistantMessage(
	scope: MessageListScope,
	turnContext: TranscriptTurnContext,
	assistantTurn: TranscriptAssistantTurnState,
	msg: TranscriptTurnContext["turn"]["assistantMsgs"][number],
	i: number
) {
	const {
		CustomToolRenderer,
		activeCopyId,
		agentMessageContext,
		firstUnreadMessageId,
		isBubbleEntering,
		markCopied,
		mentionItems,
		messageActionStates,
		messageActions,
		onAgentUiSubmit,
		onAnnotateImage,
		onBranch,
		onContributedMessageAction,
		onOpenFile,
		onOpenLink,
		onOpenMention,
		onQuote,
		onRegenerateMessage,
		onReply,
		onRetryError,
		onRetryGeneration,
		onSpeak,
		onWorkflowResume,
		previewResolvers,
		showCopyToolbar,
		suppressQuestionTool,
		toolRenderers,
		turns,
		unreadMarkerRef,
		unreadMessageLabel,
	} = scope;
	const { isLastTurn, turn, turnIndex } = turnContext;
	const { goalCompletionNode, isTurnStreaming, reactionAction, timestampNode } =
		assistantTurn;
	const closesTurn = i === turn.assistantMsgs.length - 1;
	const isLastMsg = isLastTurn && closesTurn;
	const assistantGroupPosition = messageGroupPositionFor(
		i,
		turn.assistantMsgs.length
	);
	const messageText = getTextFromParts(msg.parts ?? [], "\n\n");
	const hasMessageText = Boolean(messageText.trim());
	const messageCopyKey = `assistant-${msg.id}`;
	const messageActionState = messageActionStates?.get(msg.id);
	// Client-only rows (live voice-call turns) have
	// no persisted id: offer only client-side actions.
	const msgIsEphemeral = messageIsEphemeral(msg);
	const assistantActions = msgIsEphemeral
		? undefined
		: messageActions?.filter(
				(a) =>
					(a.target === "assistant" || a.target === "any") &&
					!isMessageReactionAction(a) &&
					(!isMemoryCitationsAction(a) ||
						Boolean(messageActionState?.memoryCitations?.length))
			);
	const onBranchMessage =
		onBranch && !msgIsEphemeral ? () => onBranch(msg.id) : undefined;
	const onSpeakMessage =
		onSpeak && hasMessageText ? () => onSpeak(messageText) : undefined;
	const onReplyMessage =
		hasMessageText && (onReply || onQuote)
			? () => {
					if (onReply && !msgIsEphemeral) {
						onReply({
							chainLength: turns.length - turnIndex,
							messageId: msg.id,
							text: messageText,
						});
						return;
					}
					onQuote?.(messageText);
				}
			: undefined;
	const onRegenerateMessageForMessage =
		onRegenerateMessage && !msgIsEphemeral
			? () => onRegenerateMessage(msg.id)
			: undefined;
	const onContributedActionMessage =
		onContributedMessageAction && !msgIsEphemeral
			? (action: ContributedMessageAction, value?: string) =>
					onContributedMessageAction(action, {
						messageId: msg.id,
						value,
					})
			: undefined;
	const messageGoalCompletion = isLastMsg ? goalCompletionNode : null;
	const showMessageToolbar =
		!isTurnStreaming &&
		(Boolean(messageGoalCompletion) ||
			((showCopyToolbar ||
				Boolean(onSpeakMessage) ||
				Boolean(onReplyMessage) ||
				Boolean(reactionAction) ||
				Boolean(onBranchMessage) ||
				Boolean(onRegenerateMessageForMessage) ||
				Boolean(assistantActions?.length)) &&
				hasMessageText));
	const shouldRenderToolbar =
		showMessageToolbar || activeCopyId === messageCopyKey;
	return (
		<Fragment key={msg.id}>
			{msg.id === firstUnreadMessageId ? (
				<div data-slot="unread-message-marker" ref={unreadMarkerRef}>
					<Marker
						aria-label={unreadMessageLabel}
						className="my-1"
						role="status"
						tone="primary"
						variant="separator"
					>
						<MarkerIcon>
							<span className="size-2 rounded-full bg-primary" />
						</MarkerIcon>
						<MarkerContent>{unreadMessageLabel}</MarkerContent>
					</Marker>
				</div>
			) : null}
			{/* Plain prose with the hover action row BELOW it, never beside: a
			    reply has no bubble edge for a toolbar to sit against. */}
			<div
				className="group/assistant-message flex w-full min-w-0 flex-col items-start gap-1"
				data-bubble-enter={isBubbleEntering(msg.id) ? "" : undefined}
			>
				<MessageContextMenu
					actionState={messageActionState}
					contributedActions={assistantActions}
					disabled={isTurnStreaming}
					onBranch={onBranchMessage}
					onContributedAction={onContributedActionMessage}
					onCopied={() => markCopied(messageCopyKey)}
					onRegenerate={onRegenerateMessageForMessage}
					onReply={onReplyMessage}
					onSpeak={onSpeakMessage}
					reactions={contextMenuReactionsFor(
						reactionAction,
						msg.id,
						messageActionState,
						onContributedActionMessage
					)}
					text={showCopyToolbar && hasMessageText ? messageText : ""}
				>
					<TranscriptAssistantParts
						agentMessageContext={agentMessageContext}
						deferTurnEndCards={!isTurnStreaming}
						groupPosition={assistantGroupPosition}
						isLast={isLastMsg}
						// Only the live turn streams. A settled turn's row is memoised
						// on that, so it must not read the conversation-wide flag.
						isStreaming={isTurnStreaming}
						mentionItems={mentionItems}
						msg={msg}
						msgIsEphemeral={msgIsEphemeral}
						onAgentUiSubmit={onAgentUiSubmit}
						onAnnotateImage={onAnnotateImage}
						onOpenFile={onOpenFile}
						onOpenLink={onOpenLink}
						onOpenMention={onOpenMention}
						onRegenerateMessage={onRegenerateMessage}
						onRetryError={onRetryError}
						onRetryGeneration={onRetryGeneration}
						onWorkflowResume={onWorkflowResume}
						previewResolvers={previewResolvers}
						suppressQuestionTool={suppressQuestionTool}
						ToolRendererComponent={CustomToolRenderer}
						toolRenderers={toolRenderers}
					/>
				</MessageContextMenu>
				{shouldRenderToolbar ? (
					<MessageToolbar
						actionState={messageActionState}
						alignClass=""
						contributedActions={assistantActions}
						goalCompletion={messageGoalCompletion}
						heightClass="h-6"
						hoverClass="group-hover/assistant-message:pointer-events-auto group-hover/assistant-message:opacity-100 group-hover/assistant-message:duration-0"
						isVisible={isLastMsg || activeCopyId === messageCopyKey}
						menuAlign="start"
						// Every turn's closing reply carries its send time in the hover row.
						meta={closesTurn ? timestampNode : undefined}
						onBranch={onBranchMessage}
						onContributedAction={onContributedActionMessage}
						onCopied={() => markCopied(messageCopyKey)}
						onRegenerate={onRegenerateMessageForMessage}
						onReply={onReplyMessage}
						onSpeak={onSpeakMessage}
						reactionAction={msgIsEphemeral ? undefined : reactionAction}
						reactionMessageId={msg.id}
						text={showCopyToolbar ? messageText : ""}
					/>
				) : null}
			</div>
		</Fragment>
	);
}
