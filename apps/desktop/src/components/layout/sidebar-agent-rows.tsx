import {
	ArrowDown01Icon,
	GitBranchIcon,
	Mail01Icon,
	MailReply01Icon,
	MoreHorizontalIcon,
	PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { useDisplayDayRevision } from "@ryu/ui/lib/display-day.ts";
import { useCallback } from "react";
import { UsageBar } from "@/components/agent-elements/input/usage-bar.tsx";
import { useModifierClickHold } from "@/src/hooks/useModifierClickHold.ts";
import { useQuickPreviewModifier } from "@/src/hooks/useQuickPreviewModifier.ts";
import {
	quickReplyModifierMatches,
	readQuickReplyModifier,
} from "@/src/hooks/useQuickReplyModifier.ts";
import { useTimezoneRevision } from "@/src/hooks/useTimezone.ts";
import {
	conversationParticipantIds,
	isForkedConversation,
	isGroupConversation,
} from "@/src/lib/agent-conversation-groups.ts";
import { AgentAvatar, engineForAgent } from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import { conversationRunStatusMeta } from "@/src/lib/conversation-run-status.ts";
import {
	type DateBucketCivilStarts,
	dateBucketKey,
	toEpoch,
} from "@/src/lib/sidebar/date-buckets.ts";
import { buildSidebarConversationPreviewStates } from "@/src/lib/sidebar-conversation-preview.ts";
import { compactAge } from "@/src/lib/time.ts";
import {
	formatDate,
	formatTime,
	startOfDisplayDayMs,
} from "@/src/lib/timezone.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import type { Conversation } from "@/types/chat.ts";
import { AnimatedTitle } from "./animated-title.tsx";
import { SidebarTodoProgress } from "./SidebarTodoProgress.tsx";
import { SidebarConversationPreview } from "./sidebar-conversation-preview.tsx";
import type { ChatRowHandlers } from "./sidebar-conversation-rows.tsx";
import { UnreadMessageCountBadge } from "./sidebar-conversation-rows.tsx";
import { sidebarUnreadRowAttributes } from "./sidebar-more-unreads.tsx";

/** The newest direct conversation each agent appears in, keyed by agent id.
 *
 *  Group conversations have their own group-chat row in Other chats. Keeping them
 *  out here prevents one council/team thread from being duplicated under every
 *  participating bot while preserving the direct-chat preview on each bot row.
 */
export function latestConversationByAgent(
	convs: Conversation[]
): Map<string, Conversation> {
	const out = new Map<string, Conversation>();
	const stampOf = (c: Conversation) => toEpoch(c.lastMessageAt ?? c.updatedAt);
	for (const conv of convs) {
		if (conv.archived || isGroupConversation(conv)) {
			continue;
		}
		const ids = conversationParticipantIds(conv);
		for (const id of ids) {
			const existing = out.get(id);
			if (!existing || stampOf(existing) < stampOf(conv)) {
				out.set(id, conv);
			}
		}
	}
	return out;
}

/** The right-aligned stamp on a messaging-style row: a clock time today, a
 *  weekday inside the last week, a short date beyond that — the shape every
 *  messaging app uses. Buckets come from `dateBucketKey` so this and the Chats
 *  section can never disagree about where "yesterday" ends. */
export function sidebarCivilStarts(now: number): DateBucketCivilStarts {
	return {
		yesterday: startOfDisplayDayMs(now, 1),
		lastWeek: startOfDisplayDayMs(now, 7),
		lastMonth: startOfDisplayDayMs(now, 30),
		lastYear: startOfDisplayDayMs(now, 365),
	};
}

function messagingRowStamp(ts: number): string {
	const now = Date.now();
	switch (
		dateBucketKey(ts, startOfDisplayDayMs(now), sidebarCivilStarts(now))
	) {
		case "today":
			return formatTime(ts, {
				hour: "numeric",
				minute: "2-digit",
			});
		case "yesterday":
			return "Yesterday";
		case "last-week":
			return formatDate(ts, { weekday: "short" });
		default:
			return formatDate(ts, {
				day: "2-digit",
				month: "2-digit",
				year: "2-digit",
			});
	}
}

/** The inside of a messaging-style agent row, on one 32px line: a 20px avatar,
 *  the name, and the last-activity stamp, which swaps for the thread and edit
 *  actions on hover.
 *
 *  The newest-message preview (whatever Core returned on the conversation
 *  summary, or "No messages yet") and the agent's title live in the name's
 *  tooltip rather than a second line. */
export function MessagingAgentRowBody({
	agent,
	conversation,
	loadMessages,
	nodeUrl,
	onEdit,
	onToggleThreads,
	showEdit = true,
	threadsExpanded,
	threadCount,
	usageBarVisible,
}: {
	agent: AgentSummary;
	conversation: Conversation | undefined;
	loadMessages?: ChatRowHandlers["loadMessages"];
	nodeUrl?: string;
	onEdit: () => void;
	onToggleThreads: () => void;
	showEdit?: boolean;
	threadsExpanded: boolean;
	threadCount: number;
	usageBarVisible: boolean;
}) {
	// Subscribes to the display time zone so the stamp repaints the moment it
	// changes; `messagingRowStamp` reads the zone at call time.
	useTimezoneRevision();
	useDisplayDayRevision();
	const tl = useLiteralMessages();
	const threadCountLabel = String(threadCount);
	const stampAt = conversation?.lastMessageAt ?? conversation?.updatedAt;
	const stamp = stampAt ? messagingRowStamp(toEpoch(stampAt)) : null;
	const conversationStatus = conversationRunStatusMeta(conversation?.runStatus);
	const previewStates = buildSidebarConversationPreviewStates({
		lastMessage: conversation?.lastMessage,
		lastMessageRole: conversation?.lastMessageRole,
		statusLabel: conversationStatus?.label,
		statusVisible:
			conversationStatus?.isRunning || conversationStatus?.needsAttention,
	});

	const threadLabel = tl(
		threadsExpanded
			? "Hide {threadCount, plural, one {{threadCountLabel} thread} other {{threadCountLabel} threads}}"
			: "Show {threadCount, plural, one {{threadCountLabel} thread} other {{threadCountLabel} threads}}",
		{ threadCount, threadCountLabel }
	);
	const threadAgentLabel = tl(
		threadsExpanded
			? "Hide {threadCount, plural, one {{threadCountLabel} thread} other {{threadCountLabel} threads}} for {name}"
			: "Show {threadCount, plural, one {{threadCountLabel} thread} other {{threadCountLabel} threads}} for {name}",
		{ name: agent.name, threadCount, threadCountLabel }
	);

	return (
		<>
			{conversation && nodeUrl ? (
				<SidebarTodoProgress
					conversation={conversation}
					loadMessages={loadMessages}
					nodeUrl={nodeUrl}
				/>
			) : null}
			<AgentAvatar
				className="size-5 shrink-0"
				engine={engineForAgent(agent)}
				glyph={agent.avatarGlyph}
				presentation="compact"
				size="20px"
			/>
			{/* One line: the name. Title, latest message and run state live in the
			    tooltip, so every agent row has the same 32px height. Agent name and
			    title are user data, never UI copy, so the DOM localizer skips them;
			    the preview, usage bar and stamp stay outside that zone. */}
			<Tooltip>
				<TooltipTrigger
					render={
						<span
							className="fade-text-edge min-w-0 flex-1 overflow-hidden whitespace-nowrap text-sm"
							data-ryu-i18n="off"
						/>
					}
				>
					{agent.name}
				</TooltipTrigger>
				<TooltipContent align="start" className="max-w-64" side="right">
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="truncate" data-ryu-i18n="off">
							{agent.title?.trim()
								? `${agent.name} · ${agent.title.trim()}`
								: agent.name}
						</span>
						<SidebarConversationPreview
							className={conversation?.lastMessage ? "" : "italic"}
							states={previewStates}
							testId={`agent-chat-preview-${agent.id}`}
						/>
					</span>
				</TooltipContent>
			</Tooltip>
			{usageBarVisible ? (
				<UsageBar
					agentId={agent.id}
					className="shrink-0"
					visible={usageBarVisible}
				/>
			) : null}
			{stamp ? (
				<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums group-focus-within/row:hidden group-hover/row:hidden">
					{stamp}
				</span>
			) : null}
			<span className="hidden shrink-0 items-center gap-0.5 group-focus-within/row:flex group-hover/row:flex">
				{threadCount > 0 ? (
					<Button
						aria-expanded={threadsExpanded}
						aria-label={threadAgentLabel}
						className="size-6 rounded-lg"
						onClick={(e) => {
							e.stopPropagation();
							onToggleThreads();
						}}
						size="icon-xs"
						title={threadLabel}
						type="button"
						variant="ghost-muted"
					>
						<HugeiconsIcon
							className={`size-3.5 transition-transform duration-150 ${threadsExpanded ? "" : "-rotate-90"}`}
							icon={ArrowDown01Icon}
						/>
					</Button>
				) : null}
				{showEdit && (
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									aria-label={tl("Edit {name}", { name: agent.name })}
									className="size-6 rounded-lg"
									onClick={(e) => {
										e.stopPropagation();
										onEdit();
									}}
									size="icon-xs"
									type="button"
									variant="ghost-muted"
								>
									<HugeiconsIcon className="size-3.5" icon={PencilEdit01Icon} />
								</Button>
							}
						/>
						<TooltipContent>Edit agent</TooltipContent>
					</Tooltip>
				)}
			</span>
		</>
	);
}

export function AgentThreadRow({
	loadMessages,
	nodeUrl,
	onMarkRead,
	onMarkUnread,
	onOpen,
	onOpenQuickPreview,
	onOpenQuickReply,
	thread,
	unreadIds,
}: {
	loadMessages?: ChatRowHandlers["loadMessages"];
	nodeUrl?: string;
	onMarkRead?: ChatRowHandlers["onMarkRead"];
	onMarkUnread?: ChatRowHandlers["onMarkUnread"];
	onOpen: (conversationId: string) => void;
	onOpenQuickPreview?: ChatRowHandlers["onOpenQuickPreview"];
	onOpenQuickReply?: ChatRowHandlers["onOpenQuickReply"];
	thread: Conversation;
	unreadIds?: Set<string>;
}) {
	const tl = useLiteralMessages();
	const forked = isForkedConversation(thread);
	const preview = thread.lastMessage?.trim();
	const isUnread = unreadIds?.has(thread.id) === true;
	const unreadMessageCount = useConversationFlagsStore((state) =>
		state.unreadIds.has(thread.id)
			? (state.unreadMessageCounts.get(thread.id) ?? 1)
			: 0
	);
	const hasActions = Boolean(onMarkRead && onMarkUnread && onOpenQuickReply);
	const [quickPreviewModifier] = useQuickPreviewModifier();
	const handleOpenQuickPreview = useCallback(
		() => onOpenQuickPreview?.(thread.id),
		[onOpenQuickPreview, thread.id]
	);
	const quickPreviewHold = useModifierClickHold({
		modifier: onOpenQuickPreview ? quickPreviewModifier : "none",
		onTrigger: handleOpenQuickPreview,
	});

	return (
		<SidebarMenuItem>
			<ContextMenu>
				<ContextMenuTrigger>
					{/* thread row owns nested menu controls */}
					<div
						aria-label={tl("Open thread: {title}", { title: thread.title })}
						className="group/thread relative flex min-h-9 w-full items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-sidebar-accent/60 hover:duration-0"
						data-testid={`agent-thread-row-${thread.id}`}
						{...sidebarUnreadRowAttributes(isUnread)}
						onClick={(event) => {
							if (quickPreviewHold.consumeTriggered()) {
								event.preventDefault();
								return;
							}
							if (
								onOpenQuickReply &&
								quickReplyModifierMatches(event, readQuickReplyModifier())
							) {
								event.preventDefault();
								onOpenQuickReply(thread.id);
								return;
							}
							onOpen(thread.id);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								onOpen(thread.id);
							}
						}}
						onPointerCancel={quickPreviewHold.onPointerCancel}
						onPointerDown={quickPreviewHold.onPointerDown}
						onPointerUp={quickPreviewHold.onPointerUp}
						role="button"
						tabIndex={0}
					>
						{nodeUrl ? (
							<SidebarTodoProgress
								celebrate={isUnread}
								conversation={thread}
								loadMessages={loadMessages}
								nodeUrl={nodeUrl}
							/>
						) : null}
						<span
							aria-hidden="true"
							className="absolute top-1/2 -left-[5px] size-2 -translate-y-1/2 rounded-full bg-sidebar-foreground/35 ring-2 ring-sidebar"
						/>
						<HugeiconsIcon
							className={`size-3.5 shrink-0 ${forked ? "text-foreground" : "text-muted-foreground"}`}
							icon={GitBranchIcon}
						/>
						<span className="min-w-0 flex-1">
							<span className="flex min-w-0 items-center gap-1.5">
								<span className="min-w-0 flex-1 truncate text-foreground/85 text-xs">
									<AnimatedTitle text={thread.title} />
								</span>
								<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
									{compactAge(thread.updatedAt)}
								</span>
							</span>
							{preview ? (
								<span className="mt-0.5 block truncate text-muted-foreground/70 text-xs">
									{preview}
								</span>
							) : null}
						</span>
						<UnreadMessageCountBadge
							conversationId={thread.id}
							count={unreadMessageCount}
						/>
						{hasActions ? (
							<DropdownMenu>
								<DropdownMenuTrigger
									aria-label={tl("More actions for {title}", {
										title: thread.title,
									})}
									className="flex size-5 shrink-0 items-center justify-center"
									onClick={(event) => event.stopPropagation()}
									reveal="thread"
									variant="muted"
								>
									<HugeiconsIcon icon={MoreHorizontalIcon} size={14} />
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem
										onClick={(event) => {
											event.stopPropagation();
											onOpenQuickReply?.(thread.id);
										}}
									>
										<HugeiconsIcon className="size-4" icon={MailReply01Icon} />
										Quick reply
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={(event) => {
											event.stopPropagation();
											if (isUnread) {
												onMarkRead?.(thread.id);
											} else {
												onMarkUnread?.(thread.id);
											}
										}}
									>
										<HugeiconsIcon className="size-4" icon={Mail01Icon} />
										{isUnread ? "Mark as read" : "Mark as unread"}
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						) : null}
					</div>
				</ContextMenuTrigger>
				{hasActions ? (
					<ContextMenuContent>
						<ContextMenuItem onClick={() => onOpenQuickReply?.(thread.id)}>
							<HugeiconsIcon className="size-4" icon={MailReply01Icon} />
							Quick reply
						</ContextMenuItem>
						<ContextMenuItem
							onClick={() =>
								isUnread ? onMarkRead?.(thread.id) : onMarkUnread?.(thread.id)
							}
						>
							<HugeiconsIcon className="size-4" icon={Mail01Icon} />
							{isUnread ? "Mark as read" : "Mark as unread"}
						</ContextMenuItem>
					</ContextMenuContent>
				) : null}
			</ContextMenu>
		</SidebarMenuItem>
	);
}
