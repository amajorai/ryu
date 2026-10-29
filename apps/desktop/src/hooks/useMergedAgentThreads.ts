// apps/desktop/src/hooks/useMergedAgentThreads.ts
//
// The data behind the messaging-style "one thread per agent" chat view.
//
// Ryu stores a conversation per thread; WhatsApp/Telegram show one endless
// scroll per contact. This hook bridges the two WITHOUT touching storage: it
// lists every conversation an agent takes part in, and loads the messages of the
// older ones so the chat page can render them above the live thread. Nothing is
// merged server-side, nothing is migrated, and turning the view off leaves the
// threads exactly as they were.
//
// Membership uses the same `participants ?? agentId` rule the sidebar's agent
// chips use, so a council thread an agent merely joined still shows up.
//
// Two caps keep a busy agent from stalling the tab. Both are reported back
// (`droppedThreads` / `truncatedThreads`) so the UI can say what it left out
// rather than implying the scroll is complete.

import { useEffect, useMemo, useState } from "react";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { conversationParticipantIds } from "@/src/lib/agent-conversation-groups.ts";
import type { Conversation, Message } from "@/types/chat.ts";

/** How many older threads are loaded above the live one. */
export const MERGED_THREAD_LIMIT = 5;
/** How many messages are kept from each of those older threads (the newest). */
export const MERGED_MESSAGES_PER_THREAD = 40;

/** Prefix marking a message that came from a thread other than the live one.
 *  Every per-message action checks for it — see `isMergedHistoryId`. */
const MERGED_ID_PREFIX = "merged:";

/** True when this id belongs to prepended history rather than the live thread.
 *  Edit / branch / regenerate / feedback all target the LIVE conversation, so
 *  they must refuse these ids instead of writing into the wrong thread. */
export function isMergedHistoryId(id: string): boolean {
	return id.startsWith(MERGED_ID_PREFIX);
}

/** The conversation a merged-history message came from, or null if the id is a
 *  live-thread id. Lets a click on foreign history open its own thread. */
export function mergedHistorySource(id: string): string | null {
	if (!isMergedHistoryId(id)) {
		return null;
	}
	// `merged:<conversationId>:<messageId>` — conversation ids are uuids, so the
	// second segment is unambiguous.
	return id.slice(MERGED_ID_PREFIX.length).split(":")[0] ?? null;
}

/** A rendered history message, shaped like the AI SDK UIMessages the chat page
 *  already passes to `AgentChat`. */
export interface MergedHistoryMessage {
	createdAt: Date;
	id: string;
	parts: { text: string; type: "text" }[];
	role: "assistant" | "user";
}

export interface MergedAgentThreads {
	/** Older threads whose messages were not loaded because of the cap. */
	droppedThreads: number;
	/** True while the older threads are still being fetched. */
	loading: boolean;
	/** Read-only messages from every older thread, oldest first. */
	messages: MergedHistoryMessage[];
	/** Every non-archived thread this agent takes part in, newest first. */
	threads: Conversation[];
	/** Threads that had more messages than the per-thread cap. */
	truncatedThreads: number;
}

/** Every non-archived conversation this agent takes part in, newest activity
 *  first. Exported so the composer's thread picker and the merged transcript
 *  agree on one list. */
export function useAgentThreads(agentId: string | null): Conversation[] {
	const { conversations } = useChatHistoryContext();
	return useMemo(() => {
		if (!agentId) {
			return [];
		}
		const stampOf = (c: Conversation) => c.lastMessageAt ?? c.updatedAt;
		return conversations
			.filter((conv) => {
				if (conv.archived) {
					return false;
				}
				return conversationParticipantIds(conv).includes(agentId);
			})
			.sort((a, b) => stampOf(b) - stampOf(a));
	}, [agentId, conversations]);
}

/** A Telegram-style "which thread is this from" marker, prepended to the first
 *  message of each block. Bold markdown rather than a bespoke part type: the
 *  council agent labels in ChatPage already use exactly this trick, so it
 *  renders through the existing pipeline with no renderer changes.
 *
 *  The caps ride along in the heading, because a stitched scroll that silently
 *  stops short reads as "this is everything" when it is not. */
function threadHeading({
	droppedThreads,
	title,
	truncated,
}: {
	droppedThreads: number;
	title: string;
	truncated: boolean;
}): string {
	const notes: string[] = [];
	if (droppedThreads > 0) {
		notes.push(
			`${droppedThreads} older thread${droppedThreads === 1 ? "" : "s"} not shown`
		);
	}
	if (truncated) {
		notes.push("earlier messages in this thread not shown");
	}
	return notes.length > 0
		? `**${title}** · _${notes.join(" · ")}_`
		: `**${title}**`;
}

function toHistoryMessage(
	conversationId: string,
	message: Message,
	heading: string | null
): MergedHistoryMessage {
	const body = message.content ?? "";
	return {
		// Prefixed so ids can never collide with the live thread's, and so every
		// per-message handler can tell the two apart.
		id: `${MERGED_ID_PREFIX}${conversationId}:${message.id}`,
		role: message.role,
		parts: [{ type: "text", text: heading ? `${heading}\n\n${body}` : body }],
		createdAt: new Date(message.timestamp),
	};
}

/** One older thread's loaded messages, before headings are applied. */
interface LoadedThread {
	history: Message[];
	id: string;
}

/**
 * Shared empty value so "no older threads" always has the SAME identity. A fresh
 * `[]` from the reset path below commits a state change on every run of the
 * effect (`Object.is([], [])` is false), which schedules another render — the
 * exact shape that becomes an unbounded synchronous loop ("Maximum update depth
 * exceeded") the moment one of the effect's dependencies stops being stable.
 */
const NO_THREADS: LoadedThread[] = [];

/**
 * Load the read-only history that sits above the live thread in the merged view.
 *
 * `liveConversationId` is excluded — that thread is rendered live by `useChat`,
 * and duplicating it here would show every message twice.
 */
export function useMergedAgentThreads({
	agentId,
	enabled,
	liveConversationId,
}: {
	agentId: string | null;
	enabled: boolean;
	liveConversationId: string | null;
}): MergedAgentThreads {
	const { loadMessages } = useChatHistoryContext();
	const threads = useAgentThreads(agentId);
	const [loaded, setLoaded] = useState<LoadedThread[]>(NO_THREADS);
	const [loading, setLoading] = useState(false);

	// Older threads, newest first, minus the one rendered live.
	const olderThreads = useMemo(
		() => threads.filter((t) => t.id !== liveConversationId),
		[threads, liveConversationId]
	);
	const loadedIds = olderThreads.slice(0, MERGED_THREAD_LIMIT).map((t) => t.id);
	const droppedThreads = Math.max(0, olderThreads.length - MERGED_THREAD_LIMIT);

	// Key the fetch on the id list rather than the array identity: the
	// conversation list re-renders on every refresh tick, and re-fetching the
	// whole backlog each time would hammer Core.
	const key = loadedIds.join(",");

	useEffect(() => {
		if (!(enabled && key)) {
			// Functional form so React bails out when the list is already empty
			// instead of committing a new-but-equal array and scheduling a render.
			setLoaded((prev) => (prev.length === 0 ? prev : NO_THREADS));
			return;
		}
		let cancelled = false;
		setLoading(true);
		const ids = key.split(",");
		Promise.all(
			ids.map((id) =>
				loadMessages(id)
					.then((history) => ({ id, history }))
					// One unreadable thread must not blank the whole scroll.
					.catch(() => ({ id, history: [] }))
			)
		)
			.then((results) => {
				if (!cancelled) {
					setLoaded(results);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [enabled, key, loadMessages]);

	// Headings are applied here rather than baked in at fetch time: Core's
	// auto-titler renames a thread minutes after it is created, and the fetch is
	// keyed on the id list, so a heading captured during the fetch would show
	// "New Chat" forever.
	const titleOf = useMemo(
		() => new Map(olderThreads.map((t) => [t.id, t.title])),
		[olderThreads]
	);
	const messages = useMemo(() => {
		if (!enabled) {
			return [];
		}
		// Oldest thread first, so the scroll reads forwards in time and the live
		// thread lands at the bottom where the composer is. (Selecting an OLDER
		// thread as live therefore puts newer ones above it — deliberate: the
		// thread you are writing into belongs next to the composer.)
		const ordered = [...loaded].reverse();
		const out: MergedHistoryMessage[] = [];
		let first = true;
		for (const { id, history } of ordered) {
			if (history.length === 0) {
				continue;
			}
			const kept = history.slice(-MERGED_MESSAGES_PER_THREAD);
			const heading = threadHeading({
				// The "older threads not shown" count belongs on the topmost block —
				// that is where the scroll actually ends.
				droppedThreads: first ? droppedThreads : 0,
				title: titleOf.get(id) ?? "Earlier",
				truncated: history.length > kept.length,
			});
			first = false;
			out.push(
				...kept.map((m, i) => toHistoryMessage(id, m, i === 0 ? heading : null))
			);
		}
		return out;
	}, [enabled, loaded, titleOf, droppedThreads]);

	const truncatedThreads = loaded.filter(
		(t) => t.history.length > MERGED_MESSAGES_PER_THREAD
	).length;

	return {
		droppedThreads,
		loading,
		messages,
		threads,
		truncatedThreads,
	};
}
