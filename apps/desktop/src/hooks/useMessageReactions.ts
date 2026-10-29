// apps/desktop/src/hooks/useMessageReactions.ts
//
// Emoji reactions for one conversation's messages: a single bulk read, an
// optimistic toggle, and a realtime applier for other people's reactions.
//
// One query per CONVERSATION, not per message — a long thread would otherwise
// open hundreds of requests to render a chip row that is empty on most rows.

import {
	type QueryKey,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { z } from "zod";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	addReaction,
	listReactions,
	type ReactionBucket,
	removeReaction,
} from "@/src/lib/api/reactions.ts";
import { useActiveNode } from "./useActiveNode.ts";

/** The realtime frame Core fans out on every reaction write. */
export interface ReactionFrame {
	emoji?: string;
	message_id?: string;
	op?: string;
	type?: string;
	user_id?: string;
}
const reactionFrameInputSchema = z.json();
export type ReactionFrameInput =
	| z.infer<typeof reactionFrameInputSchema>
	| undefined;
export const reactionFrameSchema = z.object({
	type: z.literal("reaction"),
	message_id: z.string().min(1),
	emoji: z.string().min(1),
	op: z.enum(["add", "remove"]),
	user_id: z.string().optional().catch(undefined),
});

export interface UseMessageReactionsResult {
	/** Fold a `conversation.reaction` realtime frame into the cache. */
	applyRealtimeFrame: (
		data: ReactionFrameInput,
		myUserId: string | null
	) => void;
	/** Buckets grouped by message id, preserving Core's ordering within a message. */
	byMessage: ReadonlyMap<string, ReactionBucket[]>;
	/** Add or remove the caller's `emoji` on a message, optimistically. */
	toggle: (messageId: string, emoji: string) => void;
}

/**
 * Apply one add/remove to a bucket list, returning a NEW list.
 *
 * Exported for tests: this is the whole reducer, and every path through it
 * (first reaction, join, leave, last-one-out) is easier to pin here than
 * through the query cache.
 *
 * `mine` says whether the change belongs to the calling user, which is the only
 * thing that moves `reactedByMe`. A remote user joining a bucket the caller is
 * already in must bump the count and leave `reactedByMe` alone.
 */
export function applyReactionDelta(
	buckets: ReactionBucket[],
	messageId: string,
	emoji: string,
	op: "add" | "remove",
	mine: boolean
): ReactionBucket[];
export function applyReactionDelta(
	buckets: readonly ReactionBucket[],
	messageId: string,
	emoji: string,
	op: "add" | "remove",
	mine: boolean
): readonly ReactionBucket[];
export function applyReactionDelta(
	buckets: readonly ReactionBucket[],
	messageId: string,
	emoji: string,
	op: "add" | "remove",
	mine: boolean
): readonly ReactionBucket[] {
	const index = buckets.findIndex(
		(b) => b.messageId === messageId && b.emoji === emoji
	);
	if (index === -1) {
		// Removing from a bucket that isn't there is a no-op, not an empty bucket:
		// a zero-count chip would render as a ghost nobody can clear.
		if (op === "remove") {
			return buckets;
		}
		// Appended, never inserted — Core orders by FIRST-reaction time, so a new
		// emoji belongs at the end. Sorting here would reshuffle the row under the
		// reader's cursor.
		return [...buckets, { messageId, emoji, count: 1, reactedByMe: mine }];
	}
	const current = buckets[index];
	const delta = op === "add" ? 1 : -1;
	// A duplicate add from the same user (double click, or a frame delivered
	// twice) must not double-count: the set is keyed (message, user, emoji) in
	// Core, so the caller's own state is idempotent.
	if (mine && current.reactedByMe === (op === "add")) {
		return buckets;
	}
	const count = current.count + delta;
	const next = [...buckets];
	if (count <= 0) {
		next.splice(index, 1);
		return next;
	}
	next[index] = {
		...current,
		count,
		reactedByMe: mine ? op === "add" : current.reactedByMe,
	};
	return next;
}

// Mutation ownership belongs to the actual Query cache entry, so returning to
// an authority shares row revisions while a newly created cache cannot inherit them.
const reactionWriteResources = new WeakMap<
	object,
	{
		pending: number;
		revisions: Map<string, object>;
	}
>();

export function useMessageReactions(
	conversationId: string | null
): UseMessageReactionsResult {
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);
	const queryClient = useQueryClient();
	const queryKey = useMemo(
		() => [
			"message-reactions",
			node.url,
			node.token ?? null,
			node.userJwt ?? null,
			conversationId,
		],
		[node.url, node.token, node.userJwt, conversationId]
	);

	const query = useQuery({
		queryKey,
		queryFn: () =>
			conversationId
				? listReactions(target, conversationId)
				: Promise.resolve([]),
		enabled: Boolean(conversationId),
		// Reactions arrive over the realtime room, so polling would only duplicate
		// what the socket already delivers.
		refetchOnWindowFocus: false,
		staleTime: 60 * 1000,
	});

	const buckets = useMemo(() => query.data ?? [], [query.data]);

	const byMessage = useMemo(() => {
		const map = new Map<string, ReactionBucket[]>();
		for (const bucket of buckets) {
			const list = map.get(bucket.messageId);
			if (list) {
				list.push(bucket);
			} else {
				map.set(bucket.messageId, [bucket]);
			}
		}
		return map;
	}, [buckets]);

	const write = useMutation<
		void,
		Error,
		{
			emoji: string;
			messageId: string;
			op: "add" | "remove";
			target: ApiTarget;
			conversationId: string;
			queryKey: QueryKey;
		},
		// Per-row rollback ownership. Declared explicitly because `onMutate`'s return
		// type is not inferred into `onError`'s `context` parameter.
		{
			query: object;
			resource: { pending: number; revisions: Map<string, object> };
			row: string;
			revision: object;
			previousIndex: number;
			queryKey: QueryKey;
		}
	>({
		mutationFn: ({ messageId, emoji, op, target, conversationId }) =>
			op === "add"
				? addReaction(target, conversationId as string, messageId, emoji)
				: removeReaction(target, conversationId as string, messageId, emoji),
		// Undo only this optimistic membership change. Restoring the whole list
		// would erase accepted concurrent emojis or newly delivered peer counts.
		onError: (_err, vars, context) => {
			if (
				!context ||
				context.resource.revisions.get(context.row) !== context.revision ||
				queryClient
					.getQueryCache()
					.find({ queryKey: context.queryKey, exact: true }) !== context.query
			)
				return;
			queryClient.setQueryData<ReactionBucket[]>(
				context.queryKey,
				(current) => {
					const old = current ?? [];
					const missing = !old.some(
						(bucket) =>
							bucket.messageId === vars.messageId && bucket.emoji === vars.emoji
					);
					const next = applyReactionDelta(
						old,
						vars.messageId,
						vars.emoji,
						vars.op === "add" ? "remove" : "add",
						true
					);
					// Restoring a removed last member keeps first-reaction ordering.
					if (
						vars.op === "remove" &&
						missing &&
						context.previousIndex >= 0 &&
						next.length > old.length
					) {
						const restored = next.pop();
						if (restored)
							next.splice(
								Math.min(context.previousIndex, next.length),
								0,
								restored
							);
					}
					return next;
				}
			);
		},
		onMutate: async ({ messageId, emoji, op, queryKey }) => {
			await queryClient.cancelQueries({ queryKey });
			const previous =
				queryClient.getQueryData<ReactionBucket[]>(queryKey) ?? [];
			queryClient.setQueryData<ReactionBucket[]>(queryKey, (old) =>
				applyReactionDelta(old ?? [], messageId, emoji, op, true)
			);
			const query = queryClient.getQueryCache().find({ queryKey, exact: true });
			if (!query)
				throw new Error(
					"Reaction query cache disappeared during optimistic update"
				);
			let resource = reactionWriteResources.get(query);
			if (!resource) {
				resource = { pending: 0, revisions: new Map() };
				reactionWriteResources.set(query, resource);
			}
			const row = JSON.stringify([messageId, emoji]);
			const revision = {};
			resource.pending++;
			resource.revisions.set(row, revision);
			return {
				query,
				resource,
				row,
				revision,
				previousIndex: previous.findIndex(
					(bucket) => bucket.messageId === messageId && bucket.emoji === emoji
				),
				queryKey,
			};
		},
		onSettled: (_data, _error, _vars, context) => {
			if (!context) return;
			context.resource.pending--;
			if (context.resource.revisions.get(context.row) === context.revision)
				context.resource.revisions.delete(context.row);
			// Read canonical membership only when all overlapping writes for this
			// cache have settled; an earlier read must not erase a still-pending chip.
			if (context.resource.pending === 0)
				void queryClient.invalidateQueries({ queryKey: context.queryKey });
		},
	});

	const toggle = useCallback(
		(messageId: string, emoji: string) => {
			if (!conversationId) {
				return;
			}
			const existing = (
				queryClient.getQueryData<ReactionBucket[]>(queryKey) ?? []
			).find((b) => b.messageId === messageId && b.emoji === emoji);
			write.mutate({
				target,
				conversationId,
				queryKey,
				messageId,
				emoji,
				op: existing?.reactedByMe ? "remove" : "add",
			});
		},
		[conversationId, target, queryClient, queryKey, write]
	);

	const applyRealtimeFrame = useCallback(
		(data: ReactionFrameInput, myUserId: string | null) => {
			const parsed = reactionFrameSchema.safeParse(data);
			if (!parsed.success) {
				return;
			}
			const { message_id: messageId, emoji, op, user_id: userId } = parsed.data;
			// Our own write already moved the cache optimistically, and Core echoes
			// it back to us like any other member. Folding it in again would
			// double-count.
			if (userId && myUserId && userId === myUserId) {
				return;
			}
			queryClient.setQueryData<ReactionBucket[]>(queryKey, (old) =>
				applyReactionDelta(old ?? [], messageId, emoji, op, false)
			);
		},
		[queryClient, queryKey]
	);

	return { byMessage, applyRealtimeFrame, toggle };
}
