import { memo } from "react";
import { isGoalMessage } from "./goal-message.ts";
import {
	isMemoryCitationsAction,
	isMessageReactionAction,
} from "./message-action-types.ts";
import {
	contextMenuReactionsFor,
	MessageToolbar,
	VersionPager,
} from "./message-actions.tsx";
import { MessageContextMenu } from "./message-context-menu.tsx";
import { getTextFromParts } from "./message-list-helpers.ts";
import type { MessageListScope } from "./message-list-scope.ts";
import type { TranscriptTurnContext } from "./transcript-turn.tsx";
import type { ContributedMessageAction } from "./types.ts";
import { GoalMessageAnnotation } from "./user-message.tsx";
import {
	messageIsEphemeral,
	messageIsPersisted,
} from "./utils/live-message-observations.ts";

type UserMessage = NonNullable<TranscriptTurnContext["turn"]["userMsg"]>;
type ActionStates = NonNullable<MessageListScope["messageActionStates"]>;
type ReadReceipts = NonNullable<MessageListScope["messageReadReceipts"]>;

type TranscriptUserTurnProps = Pick<
	MessageListScope,
	| "CustomUserMessage"
	| "currentUser"
	| "enableImagePreview"
	| "markCopied"
	| "mentionItems"
	| "messageActions"
	| "onAnnotateImage"
	| "onBranch"
	| "onContributedMessageAction"
	| "onEditMessage"
	| "onOpenFile"
	| "onOpenLink"
	| "onOpenMention"
	| "onQuote"
	| "onReply"
	| "onRewindMessage"
	| "onSelectVersion"
	| "previewResolvers"
	| "registerAnchor"
	| "registerTranscriptAnchor"
	| "setEditingId"
	| "showCopyToolbar"
> & {
	bubbleEntering: boolean;
	/** Turns from this one to the end, handed to the host on reply. */
	chainLength: number;
	copyVisible: boolean;
	editing: boolean;
	groupPosition: TranscriptTurnContext["groupPosition"];
	readReceipt: ReturnType<ReadReceipts["get"]>;
	userActionState: ReturnType<ActionStates["get"]>;
	userMessageClassName: string | undefined;
	userMsg: UserMessage;
	userVersion: NonNullable<MessageListScope["versions"]>[string] | undefined;
};

/** The user side of a turn: the message bubble and its toolbar. */
export function renderTranscriptUserTurn(
	scope: MessageListScope,
	turnContext: TranscriptTurnContext
) {
	const { groupPosition, turn, turnIndex } = turnContext;
	// Called only for a turn that has a user message.
	if (!turn.userMsg) {
		return null;
	}
	const userMsgId = turn.userMsg.id;
	return (
		<TranscriptUserTurn
			bubbleEntering={scope.isBubbleEntering(userMsgId)}
			CustomUserMessage={scope.CustomUserMessage}
			chainLength={scope.turns.length - turnIndex}
			copyVisible={scope.activeCopyId === `user-${userMsgId}`}
			currentUser={scope.currentUser}
			editing={scope.editingId === userMsgId}
			enableImagePreview={scope.enableImagePreview}
			groupPosition={groupPosition}
			markCopied={scope.markCopied}
			mentionItems={scope.mentionItems}
			messageActions={scope.messageActions}
			onAnnotateImage={scope.onAnnotateImage}
			onBranch={scope.onBranch}
			onContributedMessageAction={scope.onContributedMessageAction}
			onEditMessage={scope.onEditMessage}
			onOpenFile={scope.onOpenFile}
			onOpenLink={scope.onOpenLink}
			onOpenMention={scope.onOpenMention}
			onQuote={scope.onQuote}
			onReply={scope.onReply}
			onRewindMessage={scope.onRewindMessage}
			onSelectVersion={scope.onSelectVersion}
			previewResolvers={scope.previewResolvers}
			readReceipt={scope.messageReadReceipts?.get(userMsgId)}
			registerAnchor={scope.registerAnchor}
			registerTranscriptAnchor={scope.registerTranscriptAnchor}
			setEditingId={scope.setEditingId}
			showCopyToolbar={scope.showCopyToolbar}
			userActionState={scope.messageActionStates?.get(userMsgId)}
			userMessageClassName={scope.classNames?.userMessage}
			userMsg={turn.userMsg}
			userVersion={scope.versions?.[userMsgId]}
		/>
	);
}

/**
 * The user's message of one turn, memoised on the values it reads. While the
 * reply under it streams, the live turn row renders per chunk; its user
 * message, context menu and toolbar must not render with it.
 */
const TranscriptUserTurn = memo(function TranscriptUserTurn({
	CustomUserMessage,
	bubbleEntering,
	chainLength,
	copyVisible: userCopyVisible,
	currentUser,
	editing: isEditingThis,
	enableImagePreview,
	groupPosition,
	markCopied,
	mentionItems,
	messageActions,
	onAnnotateImage,
	onBranch,
	onContributedMessageAction,
	onEditMessage,
	onOpenFile,
	onOpenLink,
	onOpenMention,
	onQuote,
	onReply,
	onRewindMessage,
	onSelectVersion,
	previewResolvers,
	readReceipt,
	registerAnchor,
	registerTranscriptAnchor,
	setEditingId,
	showCopyToolbar,
	userActionState,
	userMessageClassName,
	userMsg,
	userVersion,
}: TranscriptUserTurnProps) {
	const text = getTextFromParts(userMsg.parts ?? [], "");
	const hasParts = (userMsg.parts ?? []).length > 0;
	if (!(text || hasParts)) {
		return null;
	}
	const userCopyKey = `user-${userMsg.id}`;
	const userMsgId = userMsg.id;
	// Client-only rows (live voice-call turns) have no
	// persisted id: offer only client-side actions.
	const userIsEphemeral = messageIsEphemeral(userMsg);
	const onReplyUser =
		text && (onReply || onQuote)
			? () => {
					if (onReply && !userIsEphemeral) {
						onReply({
							chainLength,
							messageId: userMsgId,
							text,
						});
						return;
					}
					onQuote?.(text);
				}
			: undefined;
	const goalAnnotation = isGoalMessage(userMsg) ? (
		<GoalMessageAnnotation />
	) : null;
	const userActions = userIsEphemeral
		? undefined
		: messageActions?.filter((a) => a.target === "user" || a.target === "any");
	const reactionAction = userActions?.find(isMessageReactionAction);
	const userToolbarActions = userActions?.filter(
		(a) =>
			!isMessageReactionAction(a) &&
			(!isMemoryCitationsAction(a) ||
				Boolean(userActionState?.memoryCitations?.length))
	);
	// Only render the toolbar when it has content — copy,
	// reply, or a contributed action (all built-ins
	// require message text).
	// Otherwise a 28px-tall empty row inflates the gap to the
	// assistant reply.
	const showUserToolbar =
		Boolean(text) &&
		(showCopyToolbar ||
			Boolean(onReplyUser) ||
			Boolean(reactionAction) ||
			Boolean(userToolbarActions?.length));
	const onContributedActionUser =
		onContributedMessageAction && !userIsEphemeral
			? (action: ContributedMessageAction, value?: string) =>
					onContributedMessageAction(action, {
						messageId: userMsgId,
						value,
					})
			: undefined;
	return (
		<div
			className="group/user-message"
			data-bubble-enter={bubbleEntering ? "" : undefined}
			ref={(el) => {
				registerAnchor(userMsgId, el);
				registerTranscriptAnchor(userMsgId, el);
			}}
		>
			<MessageContextMenu
				actionState={userActionState}
				contributedActions={userToolbarActions}
				disabled={isEditingThis}
				onBranch={
					onBranch && !userIsEphemeral ? () => onBranch(userMsgId) : undefined
				}
				onContributedAction={onContributedActionUser}
				onCopied={() => markCopied(userCopyKey)}
				onEdit={
					onEditMessage && text && !userIsEphemeral
						? () => setEditingId(userMsgId)
						: undefined
				}
				onReply={onReplyUser}
				reactions={contextMenuReactionsFor(
					reactionAction,
					userMsgId,
					userActionState,
					onContributedActionUser
				)}
				text={showCopyToolbar ? text : ""}
			>
				<CustomUserMessage
					// Handed to UserMessage so it can sit on the outside
					// edge of the shrink-to-fit bubble row. A local user's
					// actions land left of the bubble; a remote sender's
					// actions land right.
					actions={
						!isEditingThis && (showUserToolbar || goalAnnotation) ? (
							<div className="flex items-center gap-2">
								{showUserToolbar && (
									<MessageToolbar
										actionState={userActionState}
										alignClass="justify-start"
										contributedActions={userToolbarActions}
										heightClass="h-[28px]"
										hoverClass="group-hover/user-message:opacity-100 group-hover/user-message:pointer-events-auto"
										isVisible={userCopyVisible}
										menuAlign="start"
										onBranch={
											onBranch && !userIsEphemeral
												? () => onBranch(userMsgId)
												: undefined
										}
										onContributedAction={onContributedActionUser}
										onCopied={() => markCopied(userCopyKey)}
										onEdit={
											onEditMessage && text && !userIsEphemeral
												? () => setEditingId(userMsgId)
												: undefined
										}
										onReply={onReplyUser}
										onRewind={
											onRewindMessage
												? () => onRewindMessage(userMsgId, text)
												: undefined
										}
										reactionAction={reactionAction}
										reactionMessageId={userMsgId}
										text={showCopyToolbar ? text : ""}
									/>
								)}
								{goalAnnotation}
							</div>
						) : null
					}
					className={userMessageClassName}
					currentUser={currentUser}
					editing={isEditingThis}
					enableImagePreview={enableImagePreview}
					groupPosition={groupPosition}
					mentionItems={mentionItems}
					message={userMsg}
					messageActionState={userActionState}
					messageActions={userActions}
					onAnnotateImage={onAnnotateImage}
					onContributedMessageAction={
						userIsEphemeral ? undefined : onContributedMessageAction
					}
					onEditCancel={() => setEditingId(null)}
					onEditSubmit={(next: string) => {
						setEditingId(null);
						onEditMessage?.(userMsgId, next);
					}}
					onOpenFile={onOpenFile}
					onOpenLink={onOpenLink}
					onOpenMention={onOpenMention}
					previewResolvers={previewResolvers}
					readReceipt={
						readReceipt ??
						(messageIsPersisted(userMsg)
							? { delivered: true, readers: [] }
							: undefined)
					}
				/>
			</MessageContextMenu>
			{!isEditingThis &&
				userVersion &&
				userVersion.count > 1 &&
				onSelectVersion && (
					<VersionPager
						alignClass="justify-end"
						count={userVersion.count}
						ids={userVersion.ids}
						index={userVersion.index}
						onSelect={onSelectVersion}
					/>
				)}
		</div>
	);
});
