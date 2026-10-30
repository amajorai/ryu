import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceChannel,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { type KeyboardEvent, useRef } from "react";
import { ChannelIntro, DayDivider } from "./channels-messages-intro.tsx";
import { type MessageAuthor, MessageRow } from "./channels-messages-row.tsx";
import {
	type ChannelSearchHit,
	PaneNote,
	SearchBanner,
	SearchEmpty,
} from "./channels-messages-search.tsx";
import { dayKey, dayLabel, withinWindow } from "./channels-time.ts";
import { agentById } from "./interface-renderer.ts";

export type { ChannelSearchHit } from "./channels-messages-search.tsx";

/** A sender's follow-ups fold into one block within this window. */
const COLLAPSE_WINDOW_MS = 5 * 60_000;

function authorOf(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): MessageAuthor {
	// A thread you just started has only your opening message so far.
	const startedByYou =
		thread.messageCount <= 1 && thread.lastMessageRole === "user";
	const agent = agentById(snapshot, thread.agentIds[0]);
	if (agent && !startedByYou) {
		return { agent, isAgent: true, key: agent.id, name: agent.name };
	}
	return { isAgent: false, key: "you", name: "You" };
}

type ListItem =
	| { key: string; kind: "day"; label: string }
	| {
			/** First message under a day divider: keep its toolbar off the rule. */
			afterDivider: boolean;
			author: MessageAuthor;
			compact: boolean;
			key: string;
			kind: "message";
			/** Tag the author as an app once per day, not on every message. */
			showAppTag: boolean;
			thread: InterfaceThread;
	  };

function buildItems(
	snapshot: InterfaceSnapshot,
	threads: InterfaceThread[],
	now: number
): ListItem[] {
	const items: ListItem[] = [];
	let previousDay: string | null = null;
	let previous: { author: string; at: string } | null = null;
	let taggedToday = new Set<string>();
	for (const thread of threads) {
		const day = dayKey(thread.updatedAt);
		if (day !== previousDay) {
			items.push({
				key: `day:${day}`,
				kind: "day",
				label: dayLabel(thread.updatedAt, now),
			});
			previousDay = day;
			previous = null;
			taggedToday = new Set<string>();
		}
		const afterDivider = previous === null;
		const author = authorOf(snapshot, thread);
		const compact =
			previous !== null &&
			!thread.pinned &&
			previous.author === author.key &&
			withinWindow(previous.at, thread.updatedAt, COLLAPSE_WINDOW_MS);
		const showAppTag =
			author.isAgent && !compact && !taggedToday.has(author.key);
		if (showAppTag) {
			taggedToday.add(author.key);
		}
		items.push({
			afterDivider,
			author,
			compact,
			key: thread.id,
			kind: "message",
			showAppTag,
			thread,
		});
		previous = { at: thread.updatedAt, author: author.key };
	}
	return items;
}

/**
 * The channel's history: every thread is a parent message with
 * its thread bar, oldest first, anchored to the bottom (column-reverse keeps
 * the newest message in view without scroll effects).
 */
export function ChannelsMessageList({
	activeThreadId,
	channel,
	channelLabel,
	description,
	members,
	onClearSearch,
	onOpenThread,
	onSelectChannel,
	otherHits,
	pinnedOnly,
	searchQuery,
	snapshot,
	threads,
}: {
	activeThreadId: string | null;
	channel: InterfaceChannel;
	channelLabel: string;
	description: string;
	members: InterfaceAgent[];
	onClearSearch: () => void;
	onOpenThread: (threadId: string) => void;
	onSelectChannel: (channel: InterfaceChannel) => void;
	/** Other channels whose messages match the search. */
	otherHits: ChannelSearchHit[];
	/** The Pinned tab: only pinned threads, no channel intro. */
	pinnedOnly: boolean;
	/** Set when `threads` is narrowed by the title-bar search. */
	searchQuery: string | null;
	snapshot: InterfaceSnapshot;
	/** The channel's threads, oldest first. */
	threads: InterfaceThread[];
}) {
	const tl = useLiteralMessages();
	const listRef = useRef<HTMLDivElement>(null);
	const now = Date.now();
	const items = buildItems(snapshot, threads, now);

	// Arrow keys walk between the message actions; Tab still reaches every
	// control in order.
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
			return;
		}
		const controls = [
			...(listRef.current?.querySelectorAll<HTMLButtonElement>(
				"[data-message-action]"
			) ?? []),
		];
		const index = controls.indexOf(document.activeElement as HTMLButtonElement);
		if (index === -1) {
			return;
		}
		event.preventDefault();
		const step = event.key === "ArrowDown" ? 1 : -1;
		controls[Math.min(controls.length - 1, Math.max(0, index + step))]?.focus();
	};

	const displayLabel =
		channel.kind === "agent" ? channelLabel : `#${channelLabel}`;
	if (searchQuery !== null && threads.length === 0) {
		return (
			<SearchEmpty
				channelLabel={displayLabel}
				hits={otherHits}
				onClear={onClearSearch}
				onSelectChannel={onSelectChannel}
				query={searchQuery}
				snapshot={snapshot}
			/>
		);
	}
	if (pinnedOnly && threads.length === 0) {
		return (
			<PaneNote
				description="Pinned threads stay at the top of this tab, so the ones you keep coming back to are one click away."
				title={tl("Nothing pinned in {displayLabel}", { displayLabel })}
			/>
		);
	}

	// Search results and the pinned list read down from the top; history
	// reads up from the composer.
	const topAnchored = pinnedOnly || searchQuery !== null;
	const showIntro = !(pinnedOnly || searchQuery !== null);

	return (
		<>
			{searchQuery === null ? null : (
				<SearchBanner
					channelLabel={displayLabel}
					count={threads.length}
					onClear={onClearSearch}
					query={searchQuery}
				/>
			)}
			<div
				className={cn(
					// Day dividers stick to the top edge as the history scrolls.
					"flex min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]",
					topAnchored ? "flex-col" : "flex-col-reverse"
				)}
			>
				<div className={cn("flex flex-col pb-4", topAnchored && "pt-2")}>
					{showIntro ? (
						<ChannelIntro
							channel={channel}
							channelLabel={channelLabel}
							description={description}
							members={members}
							snapshot={snapshot}
						/>
					) : null}
					<div
						aria-busy="false"
						aria-label={
							pinnedOnly ? "Pinned threads" : "Threads in this channel"
						}
						className="flex flex-col"
						onKeyDown={onKeyDown}
						ref={listRef}
						role="feed"
					>
						{items.map((item) =>
							item.kind === "day" ? (
								<DayDivider
									key={item.key}
									label={item.label}
									// Read from the top, the first day sits right under
									// the tab rule: a second hairline would stack on it.
									ruled={!(topAnchored && item === items[0])}
								/>
							) : (
								<MessageRow
									active={item.thread.id === activeThreadId}
									afterDivider={item.afterDivider}
									author={item.author}
									compact={item.compact}
									highlight={searchQuery}
									key={item.key}
									now={now}
									onOpenThread={onOpenThread}
									showAppTag={item.showAppTag}
									snapshot={snapshot}
									thread={item.thread}
								/>
							)
						)}
					</div>
				</div>
			</div>
		</>
	);
}
