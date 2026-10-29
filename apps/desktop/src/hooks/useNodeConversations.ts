// apps/desktop/src/hooks/useNodeConversations.ts
//
// A READ-ONLY thread list for one non-default computer, for the "All computers"
// sidebar. Deliberately lighter than a `ChatHistoryProvider`: the sidebar never
// writes to another computer (rename, delete, pin, move all happen inside the
// thread's own tab, whose provider owns that node's authority), so a cached
// react-query read is all it needs.
//
// Cost and privacy rules this hook holds:
// - It fetches only while the computer is online, its group is expanded and the
//   window is visible. Core decrypts every title for this call, so N computers
//   polling from a hidden window would be N wasted decrypt sweeps.
// - It never asks for `?preview=1` (one more decrypt per row) and never writes
//   to localStorage: titles are encrypted at rest on the computer, and a
//   desktop cache would undo that. Last-known rows live in the in-memory query
//   cache only, so a computer that drops offline keeps its threads for the
//   session, and a cold start with it offline shows no stale titles.
// - The query key is the computer's name and URL, never its credentials. A
//   managed computer's delegation rotates every few minutes; keying on it would
//   wipe the last-known list on each rotation. The credentials are read from
//   the store when the request is made.

import { asGlyphValue } from "@ryu/ui/components/glyph.ts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { z } from "zod";
import {
	type CoreConversationSummary,
	summaryToConversation,
} from "@/src/contexts/ChatHistoryContext.tsx";
import { authenticatedFetch, toTarget } from "@/src/lib/api/client.ts";
import { type Node, useNodeStore } from "@/src/store/useNodeStore.ts";
import type { Conversation } from "@/types/chat.ts";

export const NODE_CONVERSATIONS_INTERVAL_MS = 30_000;

const nullableText = z.string().nullable().default(null);
const optionalText = z.string().optional();

const conversationSummarySchema = z.object({
	agent_id: nullableText,
	archived: z.boolean().optional(),
	branch: nullableText,
	// RNP "Continued on" marker; `summaryToConversation` parses it.
	continued_on: z.unknown().optional(),
	coordination: optionalText,
	created_at: z.number(),
	folder_path: nullableText,
	icon: z
		.unknown()
		.optional()
		.transform((value) => asGlyphValue(value)),
	id: z.string(),
	message_count: z.number().default(0),
	owner_id: optionalText,
	owner_kind: optionalText,
	participants: z.array(z.string()).optional(),
	pinned: z.boolean().optional(),
	project_id: optionalText,
	run_status: nullableText,
	spawned_by_conversation_id: optionalText,
	spawned_by_message_id: optionalText,
	thread_role: optionalText,
	title: nullableText,
	updated_at: z.number(),
	visibility: optionalText,
	worktree_path: nullableText,
});

const conversationListSchema = z.object({
	conversations: z.array(conversationSummarySchema).default([]),
});

/** The one Core read this file makes. Kept as a single wrapper so a future
 *  codec-taking request helper is a one-line change here. */
async function getConversationList(
	node: Node,
	signal?: AbortSignal
): Promise<CoreConversationSummary[]> {
	const response = await authenticatedFetch(
		toTarget(node),
		"/api/conversations",
		{ signal }
	);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	return conversationListSchema.parse(await response.json()).conversations;
}

/** Fetch `nodeName`'s threads with its CURRENT credentials, archived dropped. */
export async function fetchNodeConversations(
	nodeName: string,
	signal?: AbortSignal
): Promise<Conversation[]> {
	const node = useNodeStore.getState().nodes.find((n) => n.name === nodeName);
	if (!node) {
		throw new Error(`Computer ${nodeName} is no longer configured`);
	}
	const summaries = await getConversationList(node, signal);
	return summaries
		.filter((summary) => summary.archived !== true)
		.map(summaryToConversation);
}

export function nodeConversationsQueryKey(node: Pick<Node, "name" | "url">) {
	return ["node-conversations", node.name, node.url] as const;
}

function subscribeVisibility(onChange: () => void): () => void {
	document.addEventListener("visibilitychange", onChange);
	return () => document.removeEventListener("visibilitychange", onChange);
}

function documentVisible(): boolean {
	return document.visibilityState !== "hidden";
}

export interface NodeConversations {
	/** Last-known threads, or `undefined` before the first successful read. */
	conversations: Conversation[] | undefined;
	/** The last read failed (rows shown, if any, are last-known). */
	isError: boolean;
	/** Epoch ms of the last successful read; 0 when there has been none. */
	updatedAt: number;
}

export function useNodeConversations(
	node: Pick<Node, "name" | "url">,
	{ online, expanded }: { online: boolean | null; expanded: boolean }
): NodeConversations {
	const visible = useSyncExternalStore(
		subscribeVisibility,
		documentVisible,
		() => true
	);
	const { data, dataUpdatedAt, isError } = useQuery({
		queryKey: nodeConversationsQueryKey(node),
		queryFn: ({ signal }) => fetchNodeConversations(node.name, signal),
		enabled: online === true && expanded && visible,
		refetchInterval: NODE_CONVERSATIONS_INTERVAL_MS,
		refetchOnWindowFocus: true,
		gcTime: Number.POSITIVE_INFINITY,
		placeholderData: keepPreviousData,
		// A LAN or tailnet computer is reachable without internet; reachability is
		// already gated on `online`, so the browser's own online flag is ignored.
		networkMode: "always",
		retry: false,
	});
	return { conversations: data, isError, updatedAt: dataUpdatedAt };
}
