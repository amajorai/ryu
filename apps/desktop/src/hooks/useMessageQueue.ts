// apps/desktop/src/hooks/useMessageQueue.ts
//
// Client-side message queue for the chat composer (Codex / Claude-app style).
// While a run is streaming, messages the user submits are stashed here instead
// of being dropped; they auto-drain one at a time as each turn completes. The
// user can also force a queued message to the front ("send now") or collapse the
// whole queue into a single turn ("send all").
//
// Why this lives entirely on the client (and needs no ACP/Core change): the
// queue never issues a second `sendMessage` until `status` returns to "ready",
// so there is never more than one in-flight turn. From Core's perspective it is
// ordinary multi-turn chat, just automated — the same approach Zed takes over
// ACP. The queue is purely a desktop-side turn scheduler.

import { toast } from "@ryu/ui/components/sileo.tsx";
import type { ChatStatus } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
	QueuedAttachment,
	QueuedMessage,
} from "@/components/agent-elements/queue/queue-bar.tsx";
import { useQueueDrainMode } from "@/src/hooks/useQueueDrainMode.ts";

type SendFn = (message: {
	attachments?: QueuedAttachment[];
	content: string;
	role: "user";
}) => void;

export interface UseMessageQueueOptions {
	/** When true (Core/Gateway unreachable), draining is suspended. */
	blocked?: boolean;
	/** The real send path (ChatPage's handleSend). Receives one queued turn. */
	send: SendFn;
	/** The live chat status from `useChat` — drives auto-drain on "ready". */
	status: ChatStatus;
	/** Abort the in-flight run (useChat's `stop`) — used by force-send actions. */
	stop: () => void;
}

export interface MessageQueue {
	/** Discard the whole queue. */
	clear: () => void;
	/** Replace the content of a queued message. */
	edit: (id: string, content: string) => void;
	/** Stash a message to send when the current run finishes. */
	enqueue: (content: string, attachments?: QueuedAttachment[]) => void;
	queue: QueuedMessage[];
	/** Drop a queued message without sending it. */
	remove: (id: string) => void;
	/** Move a message to a new queue position. */
	reorder: (id: string, toIndex: number) => void;
	/** Combine every queued message into one turn and send it now. */
	sendAll: () => void;
	/** Jump a queued message to the front and send it now (interrupts a run). */
	sendNow: (id: string) => void;
}

let queueSeq = 0;
function makeId(): string {
	queueSeq += 1;
	return `q-${Date.now()}-${queueSeq}`;
}

/**
 * A turn that ERRORED is finished — there is nothing left to wait for.
 *
 * This is the trap the state used to be: `useChat` parks at `"error"` and never
 * returns to `"ready"` on its own, so a queue that only drained on `"ready"`
 * held its messages forever and "send now" had a run to interrupt that was not
 * running. Sending from `"error"` is safe — the AI SDK's `makeRequest` sets
 * `{ status: "submitted", error: undefined }` before it issues the request, so
 * the next send clears the error itself.
 */
export function isTerminalChatStatus(status: ChatStatus): boolean {
	return status === "ready" || status === "error";
}

/** The inputs the drain decision is made from — see {@link shouldDrainQueue}. */
export interface QueueDrainSignal {
	/** Core/Gateway unreachable: draining is suspended entirely. */
	blocked: boolean;
	prevQueueLen: number;
	prevStatus: ChatStatus;
	queueLen: number;
	status: ChatStatus;
}

/**
 * Whether this render should dispatch one queued turn.
 *
 * Two triggers, deliberately asymmetric:
 *
 *  - an EDGE into a terminal status (busy → ready, busy → error). Edge, not
 *    level: `send` churns identity on every message update while streaming, so
 *    a level-triggered effect would re-fire through a whole turn.
 *  - the queue GROWING while already parked in `"error"`. There is no status
 *    edge left to wait for in that state — the turn errored before the message
 *    was typed — so without this the first message after a failure would sit in
 *    the queue for the rest of the session. Scoped to `"error"` on purpose: the
 *    ready path keeps its original edge-only semantics, since nothing enqueues
 *    while ready (an idle composer sends straight through).
 */
export function shouldDrainQueue({
	status,
	prevStatus,
	queueLen,
	prevQueueLen,
	blocked,
}: QueueDrainSignal): boolean {
	if (blocked || queueLen === 0 || !isTerminalChatStatus(status)) {
		return false;
	}
	if (!isTerminalChatStatus(prevStatus)) {
		return true;
	}
	// ready → error / error → ready is still an edge worth draining on; a repeat
	// of the same terminal status only drains when a new message arrived.
	return (
		status !== prevStatus || (status === "error" && queueLen > prevQueueLen)
	);
}

/** Joins multiple queued turns into a single message body. */
function combine(items: QueuedMessage[]): string {
	return items.map((m) => m.content).join("\n\n");
}

function combineAttachments(items: QueuedMessage[]): QueuedAttachment[] {
	return items.flatMap((item) => item.attachments ?? []);
}

export function useMessageQueue({
	status,
	send,
	stop,
	blocked = false,
}: UseMessageQueueOptions): MessageQueue {
	const [queue, setQueue] = useState<QueuedMessage[]>([]);

	// Mirror the queue into a ref so callbacks/effects can read the latest items
	// without re-subscribing, and so we never run send() inside a setState updater
	// (which React may invoke twice in StrictMode → double send).
	const queueRef = useRef(queue);
	queueRef.current = queue;

	// Drain order preference (oldest-first / latest-first / send-all). Mirrored
	// into a ref so the edge-triggered drain effect reads the current mode without
	// re-subscribing on every change.
	const drainMode = useQueueDrainMode();
	const drainModeRef = useRef(drainMode);
	drainModeRef.current = drainMode;

	// When a specific message is force-sent while busy ("send now"), it can't be
	// dispatched until the run we're interrupting returns to "ready". Stash its id
	// here so the next drain sends exactly that message, overriding the drain-order
	// preference (which would otherwise pick the head/tail/whole queue instead).
	const forcedNextRef = useRef<string | null>(null);

	// Edge-trigger drain: only dispatch when status *transitions* into a terminal
	// state (or, in the errored state, when a new message arrives — see
	// `shouldDrainQueue`). This is load-bearing — `send` (handleSend) churns
	// identity on every message update during streaming, so a level-triggered
	// effect would fire repeatedly; the prev-status guard makes it fire exactly
	// once per completed turn and is also tolerant of StrictMode's double-invoke.
	const prevStatusRef = useRef<ChatStatus>(status);
	const prevBlockedRef = useRef(blocked);
	const prevQueueLenRef = useRef(0);

	const enqueue = useCallback(
		(content: string, attachments?: QueuedAttachment[]) => {
			const trimmed = content.trim();
			if (!trimmed && (!attachments || attachments.length === 0)) {
				return;
			}
			setQueue((prev) => [
				...prev,
				{ id: makeId(), content: trimmed, attachments: attachments ?? [] },
			]);
		},
		[]
	);

	const remove = useCallback((id: string) => {
		setQueue((prev) => prev.filter((m) => m.id !== id));
	}, []);

	const edit = useCallback((id: string, content: string) => {
		const trimmed = content.trim();
		if (!trimmed) {
			return;
		}
		setQueue((prev) =>
			prev.map((m) => (m.id === id ? { ...m, content: trimmed } : m))
		);
	}, []);

	const clear = useCallback(() => {
		setQueue([]);
	}, []);

	const reorder = useCallback((id: string, toIndex: number) => {
		setQueue((prev) => {
			const fromIndex = prev.findIndex((item) => item.id === id);
			if (fromIndex < 0) {
				return prev;
			}
			const nextIndex = Math.max(0, Math.min(toIndex, prev.length - 1));
			if (fromIndex === nextIndex) {
				return prev;
			}
			const next = [...prev];
			const [item] = next.splice(fromIndex, 1);
			next.splice(nextIndex, 0, item);
			return next;
		});
	}, []);

	// The callback contract is synchronous. Keep records until it returns; this
	// does not acknowledge the downstream AI SDK/Core request.
	const dispatchItems = useCallback(
		(items: QueuedMessage[]) => {
			try {
				send({
					role: "user",
					content: combine(items),
					attachments: combineAttachments(items),
				});
			} catch (error) {
				toast.error("Couldn't send queued messages", {
					description: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
			const acceptedIds = new Set(items.map(({ id }) => id));
			setQueue((previous) => previous.filter(({ id }) => !acceptedIds.has(id)));
			return true;
		},
		[send]
	);

	const interrupt = useCallback(() => {
		try {
			stop();
			return true;
		} catch (error) {
			toast.error("Couldn't interrupt the current run", {
				description: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}, [stop]);

	const dispatchFront = useCallback(() => {
		const items = queueRef.current;
		if (items.length === 0) {
			return;
		}
		const forcedId = forcedNextRef.current;
		if (forcedId) {
			const forced = items.find((message) => message.id === forcedId);
			if (forced) {
				if (dispatchItems([forced])) {
					forcedNextRef.current = null;
				}
				return;
			}
			forcedNextRef.current = null;
		}
		const mode = drainModeRef.current;
		if (mode === "send-all" || mode === "auto") {
			dispatchItems(items);
			return;
		}
		const next = mode === "latest-first" ? items.at(-1) : items[0];
		if (next) {
			dispatchItems([next]);
		}
	}, [dispatchItems]);

	useEffect(() => {
		const prevStatus = prevStatusRef.current;
		const prevQueueLen = prevQueueLenRef.current;
		const wasBlocked = prevBlockedRef.current;
		prevBlockedRef.current = blocked;
		prevStatusRef.current = status;
		prevQueueLenRef.current = queue.length;
		if (
			shouldDrainQueue({
				status,
				prevStatus,
				queueLen: queue.length,
				prevQueueLen,
				blocked,
			}) ||
			(wasBlocked &&
				!blocked &&
				queue.length > 0 &&
				isTerminalChatStatus(status))
		) {
			dispatchFront();
		}
	}, [status, blocked, queue.length, dispatchFront]);

	const sendNow = useCallback(
		(id: string) => {
			const item = queueRef.current.find((message) => message.id === id);
			if (!item) {
				return;
			}
			if (isTerminalChatStatus(status) && !blocked) {
				if (dispatchItems([item]) && forcedNextRef.current === id) {
					forcedNextRef.current = null;
				}
				return;
			}
			if (!interrupt()) {
				return;
			}
			forcedNextRef.current = id;
			setQueue((previous) => [
				item,
				...previous.filter((message) => message.id !== id),
			]);
		},
		[status, blocked, dispatchItems, interrupt]
	);

	const sendAll = useCallback(() => {
		const items = queueRef.current;
		if (items.length === 0) {
			return;
		}
		if (isTerminalChatStatus(status) && !blocked) {
			if (dispatchItems(items)) {
				forcedNextRef.current = null;
			}
			return;
		}
		if (!interrupt()) {
			return;
		}
		const merged = {
			id: makeId(),
			content: combine(items),
			attachments: combineAttachments(items),
		};
		const mergedIds = new Set(items.map(({ id }) => id));
		forcedNextRef.current = merged.id;
		setQueue((previous) => [
			merged,
			...previous.filter(({ id }) => !mergedIds.has(id)),
		]);
	}, [status, blocked, dispatchItems, interrupt]);

	return { queue, enqueue, edit, remove, reorder, clear, sendNow, sendAll };
}
