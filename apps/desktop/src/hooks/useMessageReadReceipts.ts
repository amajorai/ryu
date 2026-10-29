import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	listMessageReadReceipts,
	markMessageRead,
} from "@/src/lib/api/message-read-receipts.ts";
import type {
	MessageReadReceipt,
	MessageReadReceiptUser,
	ReadReceiptFrameInput,
} from "@/src/lib/read-receipts.ts";
import {
	mergeReadReceipts,
	readReceiptFromFrame,
} from "@/src/lib/read-receipts.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseMessageReadReceiptsResult {
	/** Apply a `conversation.readReceipt` realtime frame. */
	applyRealtimeFrame: (data: ReadReceiptFrameInput) => void;
	/** Read markers grouped by message id, in durable read order. */
	byMessage: ReadonlyMap<string, MessageReadReceipt[]>;
	/** Queue one visible message for a debounced, idempotent acknowledgement. */
	markVisible: (messageId: string) => void;
	/** Scoped names and avatars for people represented in the receipt snapshot. */
	users: readonly MessageReadReceiptUser[];
}

const FLUSH_DELAY_MS = 80;

export function useMessageReadReceipts(
	conversationId: string | null,
	currentUserId: string | null
): UseMessageReadReceiptsResult {
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.url, node.token, node.userJwt]
	);
	const [receipts, setReceipts] = useState<MessageReadReceipt[]>([]);
	const conversationIdRef = useRef(conversationId);
	const currentUserIdRef = useRef(currentUserId);
	const targetRef = useRef(target);
	const knownKeysRef = useRef(new Set<string>());
	const [users, setUsers] = useState<MessageReadReceiptUser[]>([]);
	const pendingIdsRef = useRef(new Set<string>());
	const queuedIdsRef = useRef(new Set<string>());
	const requestGenerationRef = useRef(0);
	const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	conversationIdRef.current = conversationId;
	currentUserIdRef.current = currentUserId;
	targetRef.current = target;

	const merge = useCallback((next: readonly MessageReadReceipt[]) => {
		if (next.length === 0) {
			return;
		}
		setReceipts((current) => {
			const merged = mergeReadReceipts(current, next);
			knownKeysRef.current = new Set(
				merged.map((receipt) => `${receipt.messageId}\u0000${receipt.userId}`)
			);
			return merged;
		});
	}, []);

	const flush = useCallback(async () => {
		flushTimerRef.current = null;
		const activeConversationId = conversationIdRef.current;
		const userId = currentUserIdRef.current;
		const requestGeneration = requestGenerationRef.current;
		const messageIds = [...queuedIdsRef.current];
		queuedIdsRef.current.clear();
		if (!(activeConversationId && userId && messageIds.length > 0)) {
			return;
		}
		for (const messageId of messageIds) {
			pendingIdsRef.current.add(messageId);
		}
		try {
			const next = await markMessageRead(
				targetRef.current,
				activeConversationId,
				messageIds
			);
			if (requestGenerationRef.current === requestGeneration) {
				merge(next);
			}
		} catch {
			// The next visibility event retries the marker. A read affordance is
			// best-effort and must never make the transcript fail.
		} finally {
			if (requestGenerationRef.current === requestGeneration) {
				for (const messageId of messageIds) {
					pendingIdsRef.current.delete(messageId);
				}
			}
		}
	}, [merge]);

	useEffect(() => {
		requestGenerationRef.current += 1;
		const requestGeneration = requestGenerationRef.current;
		knownKeysRef.current.clear();
		pendingIdsRef.current.clear();
		queuedIdsRef.current.clear();
		if (flushTimerRef.current !== null) {
			clearTimeout(flushTimerRef.current);
			flushTimerRef.current = null;
		}
		setReceipts([]);
		setUsers([]);
		if (!conversationId) {
			return;
		}
		let cancelled = false;
		listMessageReadReceipts(target, conversationId)
			.then(({ receipts: next, users: nextUsers }) => {
				if (!cancelled && requestGenerationRef.current === requestGeneration) {
					setUsers(nextUsers);
					merge(next);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
			requestGenerationRef.current += 1;
		};
	}, [conversationId, merge, target]);

	useEffect(
		() => () => {
			if (flushTimerRef.current !== null) {
				clearTimeout(flushTimerRef.current);
			}
		},
		[]
	);

	const markVisible = useCallback(
		(messageId: string) => {
			const activeConversationId = conversationIdRef.current;
			const userId = currentUserIdRef.current;
			if (!(activeConversationId && userId && messageId)) {
				return;
			}
			const key = `${messageId}\u0000${userId}`;
			if (
				knownKeysRef.current.has(key) ||
				pendingIdsRef.current.has(messageId)
			) {
				return;
			}
			queuedIdsRef.current.add(messageId);
			if (flushTimerRef.current !== null) {
				clearTimeout(flushTimerRef.current);
			}
			flushTimerRef.current = setTimeout(() => {
				void flush();
			}, FLUSH_DELAY_MS);
		},
		[flush]
	);

	const applyRealtimeFrame = useCallback(
		(data: ReadReceiptFrameInput) => {
			const receipt = readReceiptFromFrame(data, conversationIdRef.current);
			if (receipt) {
				merge([receipt]);
			}
		},
		[merge]
	);

	const byMessage = useMemo(() => {
		const grouped = new Map<string, MessageReadReceipt[]>();
		for (const receipt of receipts) {
			const existing = grouped.get(receipt.messageId);
			if (existing) {
				existing.push(receipt);
			} else {
				grouped.set(receipt.messageId, [receipt]);
			}
		}
		return grouped;
	}, [receipts]);

	return { applyRealtimeFrame, byMessage, markVisible, users };
}
