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

import type { ChatStatus } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import type { QueuedMessage } from "@/components/agent-elements/queue/queue-bar.tsx";
import { useQueueDrainMode } from "@/src/hooks/useQueueDrainMode.ts";

type SendFn = (message: { role: "user"; content: string }) => void;

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
	enqueue: (content: string) => void;
	queue: QueuedMessage[];
	/** Drop a queued message without sending it. */
	remove: (id: string) => void;
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

/** Joins multiple queued turns into a single message body. */
function combine(items: QueuedMessage[]): string {
	return items.map((m) => m.content).join("\n\n");
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

	// Edge-trigger drain: only dispatch when status *transitions* into "ready".
	// This is load-bearing — `send` (handleSend) churns identity on every message
	// update during streaming, so a level-triggered effect would fire repeatedly;
	// the prev-status guard makes it fire exactly once per completed turn and is
	// also tolerant of StrictMode's double-invoke.
	const prevStatusRef = useRef<ChatStatus>(status);

	const enqueue = useCallback((content: string) => {
		const trimmed = content.trim();
		if (!trimmed) {
			return;
		}
		setQueue((prev) => [...prev, { id: makeId(), content: trimmed }]);
	}, []);

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

	// Drain one "turn" from the queue, honoring the drain-order preference:
	//  - oldest-first: send the head (FIFO), the classic one-per-turn drain.
	//  - latest-first: send the tail (LIFO), so a late correction goes next.
	//  - send-all: collapse every queued message into a single combined turn.
	const dispatchFront = useCallback(() => {
		const items = queueRef.current;
		if (items.length === 0) {
			return;
		}
		// A force-sent message (see sendNow) always goes next, whatever the mode.
		const forcedId = forcedNextRef.current;
		if (forcedId) {
			forcedNextRef.current = null;
			const forced = items.find((m) => m.id === forcedId);
			if (forced) {
				setQueue((prev) => prev.filter((m) => m.id !== forced.id));
				send({ role: "user", content: forced.content });
				return;
			}
		}
		const mode = drainModeRef.current;
		if (mode === "send-all") {
			setQueue([]);
			send({ role: "user", content: combine(items) });
			return;
		}
		const next = mode === "latest-first" ? items.at(-1) : items[0];
		if (!next) {
			return;
		}
		setQueue((prev) => prev.filter((m) => m.id !== next.id));
		send({ role: "user", content: next.content });
	}, [send]);

	useEffect(() => {
		const prev = prevStatusRef.current;
		prevStatusRef.current = status;
		if (
			status === "ready" &&
			prev !== "ready" &&
			!blocked &&
			queueRef.current.length > 0
		) {
			dispatchFront();
		}
	}, [status, blocked, dispatchFront]);

	const sendNow = useCallback(
		(id: string) => {
			const item = queueRef.current.find((m) => m.id === id);
			if (!item) {
				return;
			}
			if (status === "ready" && !blocked) {
				// Idle: send immediately, dropping it from the queue.
				setQueue((prev) => prev.filter((m) => m.id !== id));
				send({ role: "user", content: item.content });
				return;
			}
			// Busy: mark it as the forced next dispatch and move it to the front,
			// then interrupt the run. The drain effect sends exactly this item when
			// status returns to "ready" — regardless of the drain-order preference.
			forcedNextRef.current = id;
			setQueue((prev) => [item, ...prev.filter((m) => m.id !== id)]);
			stop();
		},
		[status, blocked, send, stop]
	);

	const sendAll = useCallback(() => {
		const items = queueRef.current;
		if (items.length === 0) {
			return;
		}
		const merged = combine(items);
		if (status === "ready" && !blocked) {
			setQueue([]);
			send({ role: "user", content: merged });
			return;
		}
		// Busy: collapse the queue to a single combined turn at the front, then
		// interrupt so the drain effect sends it next.
		setQueue([{ id: makeId(), content: merged }]);
		stop();
	}, [status, blocked, send, stop]);

	return { queue, enqueue, edit, remove, clear, sendNow, sendAll };
}
