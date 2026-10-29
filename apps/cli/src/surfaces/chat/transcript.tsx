/* @jsxImportSource @opentui/react */

import type {
	BorderCharacters,
	ScrollBoxRenderable,
	MouseEvent as TuiMouseEvent,
} from "@opentui/core";
import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useTheme, useUnicode } from "@/components/ui/theme-provider.tsx";
import { TranscriptParts } from "../../components/TranscriptParts.tsx";
import type { ChatPart } from "../../core/chatTranscript.ts";
import type { ConversationRow } from "../../core/conversations.ts";
import { collapseUserTurnText } from "../../core/transcriptPresentation.ts";
import {
	RECEIPT_SEPARATOR,
	type TurnReceiptParts,
	turnReceiptParts,
} from "../../core/turnReceipt.ts";
import { tf } from "../../i18n/translate.ts";
import { CoreConnectionCard } from "../../ui/ConnectionCard.tsx";
import { EmptyStateHeader } from "./emptyState.tsx";
import type { Message } from "./types.ts";

// Left-only bar for user turns: every glyph except the vertical edge is a
// space, so `border={["left"]}` draws a single heavy rule beside the prompt.
const USER_TURN_BAR: BorderCharacters = {
	topLeft: " ",
	topRight: " ",
	bottomLeft: " ",
	bottomRight: " ",
	horizontal: " ",
	vertical: "┃",
	topT: " ",
	bottomT: " ",
	leftT: " ",
	rightT: " ",
	cross: " ",
};
const USER_TURN_BAR_ASCII: BorderCharacters = {
	...USER_TURN_BAR,
	vertical: "|",
};

// UserTurn - the submitted prompt on a raised surface behind a primary left
// bar. Prompts longer than USER_TURN_COLLAPSED_LINES collapse behind a hint;
// Ctrl+O toggles every long prompt and clicking the hint expands just this one.
function UserTurn({
	expanded,
	message,
	onExpand,
}: {
	expanded: boolean;
	message: Message;
	onExpand: (id: number) => void;
}) {
	const theme = useTheme();
	const unicode = useUnicode();
	const collapsed = useMemo(
		() => collapseUserTurnText(message.content),
		[message.content]
	);
	const isCollapsed = !expanded && collapsed.hiddenLines > 0;
	const collapsedParts = useMemo<ChatPart[]>(
		() => [{ type: "text", text: collapsed.text }],
		[collapsed.text]
	);
	return (
		<box
			backgroundColor={theme.colors.muted}
			border={["left"]}
			borderColor={theme.colors.primary}
			customBorderChars={unicode ? USER_TURN_BAR : USER_TURN_BAR_ASCII}
			flexDirection="column"
			paddingX={1}
		>
			<TranscriptParts parts={isCollapsed ? collapsedParts : message.parts} />
			{isCollapsed ? (
				<text
					fg={theme.colors.mutedForeground}
					onMouseDown={() => onExpand(message.id)}
				>
					{tf(
						"{ellipsis} {count, plural, one {{hiddenLines} more line} other {{hiddenLines} more lines}} (Ctrl+O expand)",
						{
							count: collapsed.hiddenLines,
							ellipsis: unicode ? "…" : "...",
							hiddenLines: String(collapsed.hiddenLines),
						}
					)}
				</text>
			) : null}
		</box>
	);
}

// AssistantTurn - the reply indented under the prompt with no role label;
// route and model attribution stay in StatusLine and WorkspaceBar.
function AssistantTurn({
	isLatest,
	isStreaming,
	message,
	pendingPermissionToolCallId,
	showReceipt,
}: {
	isLatest: boolean;
	isStreaming: boolean;
	message: Message;
	/** The tool call a permission prompt is waiting on, if any. */
	pendingPermissionToolCallId: string | undefined;
	/** Show the muted agent/model/time/tokens line under a finished turn. */
	showReceipt: boolean;
}) {
	const theme = useTheme();
	const receipt: TurnReceiptParts | null =
		showReceipt && message.receipt && !isStreaming && !message.interrupted
			? turnReceiptParts({
					agentLabel: message.receipt.agentLabel,
					modelLabel: message.receipt.modelLabel,
					elapsedMs: message.receipt.elapsedMs,
					usage: message.usage,
				})
			: null;
	return (
		<box flexDirection="column" paddingLeft={2}>
			{message.parts.length > 0 ? (
				<TranscriptParts
					parts={message.parts}
					pendingPermissionToolCallId={pendingPermissionToolCallId}
					recoveryHint={isLatest}
					streaming={isStreaming}
				/>
			) : null}
			{message.parts.length === 0 && !message.interrupted ? (
				<text fg={theme.colors.mutedForeground}>{isStreaming ? "…" : ""}</text>
			) : null}
			{message.interrupted ? (
				<text fg={theme.colors.mutedForeground}>Interrupted</text>
			) : null}
			{receipt && (receipt.identity || receipt.stats) ? (
				// A narrow pane truncates the agent/model names, never the numbers.
				<box flexDirection="row" gap={1} overflow="hidden">
					{receipt.identity ? (
						<text
							fg={theme.colors.mutedForeground}
							flexShrink={1}
							truncate
							wrapMode="none"
						>
							{receipt.identity}
						</text>
					) : null}
					{receipt.stats ? (
						<text
							fg={theme.colors.mutedForeground}
							flexShrink={0}
							wrapMode="none"
						>
							{receipt.identity
								? `${RECEIPT_SEPARATOR.trimStart()}${receipt.stats}`
								: receipt.stats}
						</text>
					) : null}
				</box>
			) : null}
		</box>
	);
}

const TRANSCRIPT_SCROLL_MOUSE_EVENTS = new Set(["scroll", "drag", "up"]);

export function Transcript({
	messages,
	streaming,
	agent,
	coreDown,
	expandPrompts,
	onScrollActivity,
	onVisibleRecentsChange,
	pendingPermissionToolCallId,
	recents,
	scrollRef,
	simpleInterface,
	team,
}: {
	agent: string | null;
	coreDown: boolean;
	expandPrompts: boolean;
	messages: Message[];
	onScrollActivity: () => void;
	onVisibleRecentsChange: (count: number) => void;
	pendingPermissionToolCallId: string | undefined;
	recents: ConversationRow[];
	scrollRef: RefObject<ScrollBoxRenderable | null>;
	simpleInterface: boolean;
	streaming: boolean;
	team: string | null;
}) {
	const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());
	// Ctrl+O collapsing every prompt also drops individually expanded ones.
	useEffect(() => {
		if (!expandPrompts) {
			setExpandedIds(new Set());
		}
	}, [expandPrompts]);
	const expandOne = useCallback((id: number) => {
		setExpandedIds((current) => new Set(current).add(id));
	}, []);
	if (messages.length === 0) {
		const header = (
			<EmptyStateHeader
				agent={agent}
				onVisibleRecentsChange={onVisibleRecentsChange}
				recents={recents}
				simpleInterface={simpleInterface}
				team={team}
			/>
		);
		if (!coreDown) {
			return header;
		}
		// Core is down before the first turn: a guided banner above the greeting.
		// The composer owns every printable key here, so the card binds no s/r;
		// it auto-retries and points at Home (s start Core) instead.
		return (
			<box flexDirection="column" flexGrow={1} overflow="hidden">
				<box flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
					<CoreConnectionCard keysActive={false} />
				</box>
				{header}
			</box>
		);
	}
	return (
		<scrollbox
			// A zero basis keeps the transcript out of flex shrinking: only the
			// composer gives up rows when the chrome overflows a short terminal.
			flexBasis={0}
			flexGrow={1}
			// Listeners run before the scrollbox applies the wheel or drag, so the
			// position is re-read once the event has been handled.
			onMouse={(event: TuiMouseEvent) => {
				if (TRANSCRIPT_SCROLL_MOUSE_EVENTS.has(event.type)) {
					queueMicrotask(onScrollActivity);
				}
			}}
			paddingLeft={1}
			paddingTop={1}
			ref={scrollRef}
			stickyScroll
			stickyStart="bottom"
		>
			{messages.map((message, i) => {
				const isLast = i === messages.length - 1;
				return (
					<box
						flexDirection="column"
						key={message.id}
						marginTop={i > 0 ? 1 : 0}
					>
						{message.role === "user" ? (
							<UserTurn
								expanded={expandPrompts || expandedIds.has(message.id)}
								message={message}
								onExpand={expandOne}
							/>
						) : (
							<AssistantTurn
								isLatest={isLast}
								isStreaming={isLast && streaming}
								message={message}
								pendingPermissionToolCallId={pendingPermissionToolCallId}
								showReceipt={!simpleInterface}
							/>
						)}
					</box>
				);
			})}
		</scrollbox>
	);
}
