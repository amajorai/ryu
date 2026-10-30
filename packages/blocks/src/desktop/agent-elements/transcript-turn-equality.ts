import type { MessageListScope } from "./message-list-scope.ts";

type TranscriptTurn = MessageListScope["turns"][number];

/** One turn's derived values, shared by its user and assistant renders. */
export interface TranscriptTurnContext {
	continuesRun: boolean;
	groupPosition: MessageListScope["userRunPositions"][number];
	hasAssistantText: boolean;
	hasUnreadMessage: boolean;
	isLastTurn: boolean;
	isSearchActive: boolean;
	separatorKey: string | undefined;
	turn: TranscriptTurn;
	turnAnchorId: string | null;
	turnIndex: number;
	turnKey: string;
}

export interface TranscriptTurnRowProps {
	scope: MessageListScope;
	turnContext: TranscriptTurnContext;
}

type ScopeKey = keyof MessageListScope;

/**
 * Scope bindings a turn row reads only on the LAST turn (the planning row,
 * Answer now, the live stats footer, the streaming flag). They change with
 * every streamed chunk, so a settled turn must not compare them.
 */
const LAST_TURN_KEYS = new Set<ScopeKey>([
	"answerNow",
	"isStreaming",
	"messages",
	"planningLabel",
	"planningLeading",
	"showPlanning",
	"statsUsage",
]);

/**
 * Scope bindings that are rebuilt per chunk but that a row either never reads
 * (scroll, rail and day-grouping state) or reads through a per-turn check in
 * `turnSpecificScopeEqual` below. A new row binding that changes per chunk
 * belongs in one of these two places; anything else is compared by identity,
 * so a binding missing here can only cost a render, never a stale row.
 */
const NOT_COMPARED_KEYS = new Set<ScopeKey>([
	"assistantHiddenTurns",
	"classNames",
	"currentAnchorId",
	"dayGroups",
	"dividersKey",
	"firstUnreadMessageId",
	"following",
	"isBubbleEntering",
	"isScrollingUp",
	"messageActionStates",
	"messageReadReceipts",
	"normalizedMessages",
	"pinnedMessage",
	"railItems",
	"searchActiveMessageId",
	"separatorKeys",
	"turnIndexByAnchorId",
	"turns",
	"unreadMessageCount",
	"unreadMessageLabel",
	"userRunPositions",
	// Read only by the list shell around the rows (older-history loading, the
	// thread notices, selection actions, the scroller root), never by a row.
	// `slots` reaches rows only through `CustomUserMessage` and
	// `CustomToolRenderer`, which are compared.
	"className",
	"conversationKey",
	"hasOlderMessages",
	"historyNotice",
	"historyNotices",
	"initialScrollBehavior",
	"loadingOlderMessages",
	"onContributedSelectionAction",
	"onLoadOlderMessages",
	"onMessageVisible",
	"selectionActions",
	"slots",
]);

function turnMessageIds(turn: TranscriptTurn): string[] {
	const ids = turn.assistantMsgs.map((msg) => msg.id);
	if (turn.userMsg) {
		ids.push(turn.userMsg.id);
	}
	return ids;
}

function contextEqual(
	prev: TranscriptTurnContext,
	next: TranscriptTurnContext
): boolean {
	return (
		prev.turn === next.turn &&
		prev.turnIndex === next.turnIndex &&
		prev.turnKey === next.turnKey &&
		prev.isLastTurn === next.isLastTurn &&
		prev.separatorKey === next.separatorKey &&
		prev.groupPosition === next.groupPosition &&
		prev.turnAnchorId === next.turnAnchorId &&
		prev.continuesRun === next.continuesRun &&
		prev.hasUnreadMessage === next.hasUnreadMessage &&
		prev.hasAssistantText === next.hasAssistantText &&
		prev.isSearchActive === next.isSearchActive
	);
}

function turnSpecificScopeEqual(
	prev: MessageListScope,
	next: MessageListScope,
	{ turn, hasUnreadMessage }: TranscriptTurnContext
): boolean {
	// Reply/quote hand the chain length (turns after this one) to the host.
	if (
		prev.turns.length !== next.turns.length ||
		prev.classNames?.userMessage !== next.classNames?.userMessage
	) {
		return false;
	}
	if (
		prev.assistantHiddenTurns.has(turn) !== next.assistantHiddenTurns.has(turn)
	) {
		return false;
	}
	if (
		hasUnreadMessage &&
		(prev.firstUnreadMessageId !== next.firstUnreadMessageId ||
			prev.unreadMessageLabel !== next.unreadMessageLabel)
	) {
		return false;
	}
	for (const id of turnMessageIds(turn)) {
		if (
			prev.isBubbleEntering(id) !== next.isBubbleEntering(id) ||
			prev.messageActionStates?.get(id) !== next.messageActionStates?.get(id) ||
			prev.messageReadReceipts?.get(id) !== next.messageReadReceipts?.get(id)
		) {
			return false;
		}
	}
	return true;
}

/**
 * `React.memo` comparator for a transcript turn row: while a reply streams,
 * every settled turn keeps its turn object (see `reuseSettledTurns`) and every
 * binding it reads, so only the live turn renders per chunk.
 */
export function transcriptTurnRowPropsEqual(
	prev: TranscriptTurnRowProps,
	next: TranscriptTurnRowProps
): boolean {
	if (!contextEqual(prev.turnContext, next.turnContext)) {
		return false;
	}
	const lastTurn = prev.turnContext.isLastTurn || next.turnContext.isLastTurn;
	const keys = new Set<ScopeKey>([
		...(Object.keys(prev.scope) as ScopeKey[]),
		...(Object.keys(next.scope) as ScopeKey[]),
	]);
	for (const key of keys) {
		if (NOT_COMPARED_KEYS.has(key)) {
			continue;
		}
		if (!lastTurn && LAST_TURN_KEYS.has(key)) {
			continue;
		}
		if (!Object.is(prev.scope[key], next.scope[key])) {
			return false;
		}
	}
	return turnSpecificScopeEqual(prev.scope, next.scope, next.turnContext);
}
