import { abortableDelay } from "@/src/lib/abortable-delay.ts";

// apps/desktop/src/lib/api/channelStatus.ts
//
// Live connection status for channel bots (Telegram/Slack/…), consumed by the
// sidebar to paint an online/offline dot next to the bound agent.
//
// Like channels.ts this targets the control plane (:3000, BACKEND_URL), not a
// Core node — so it can't ride the shared node SSE mux (eventStream.ts). Instead
// it opens ONE reconnecting socket to `/api/channels/status/stream` and fans the
// latest per-channel state out to subscribers. The socket is reference-counted:
// it opens on the first subscriber, closes when the last leaves, and reconnects
// with backoff (re-fetching a snapshot on each reconnect so a missed heartbeat
// while disconnected self-heals).

import { activityJsonValueSchema } from "@ryuhq/core-client/activity.ts";
import { z } from "zod";
import { BACKEND_URL, getActiveToken } from "@/lib/auth-client.ts";

/** Effective liveness state as computed by the control plane. */
export type ChannelLiveState =
	| "online"
	| "connecting"
	| "error"
	| "offline"
	| "unknown";

/** One channel's liveness, as returned by `/status` and streamed by `/status/stream`. */
export interface ChannelStatus {
	detail: string | null;
	id: string;
	lastHeartbeatAt: string | null;
	state: ChannelLiveState;
}

const channelStatusFieldsSchema = z.object({
	detail: z.string().nullable(),
	id: z.string(),
	lastHeartbeatAt: z.string().nullable(),
	state: z.enum(["online", "connecting", "error", "offline", "unknown"]),
});
export const channelStatusSchema = z.custom<ChannelStatus>(
	(value) =>
		activityJsonValueSchema.safeParse(value).success &&
		channelStatusFieldsSchema.safeParse(value).success
);
const channelStatusesReplySchema = z.object({
	statuses: z.array(channelStatusSchema).nullish(),
});

type StatusMap = Map<string, ChannelLiveState>;
type Listener = (statuses: StatusMap) => void;

const BASE = `${BACKEND_URL.replace(/\/$/, "")}/api/channels`;
const FRAME_SEP = "\n\n";
const EVENT_PREFIX = "event:";
const DATA_PREFIX = "data:";
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

/** Latest known state per channel id, shared by every subscriber. */
const current: StatusMap = new Map();
const listeners = new Set<Listener>();
let controller: AbortController | null = null;
let running = false;

function authToken(): string | null {
	try {
		return getActiveToken();
	} catch {
		return null;
	}
}

/** Notify subscribers with a fresh copy so React state updates are detected. */
function emit(): void {
	const snapshot = new Map(current);
	for (const listener of listeners) {
		listener(snapshot);
	}
}

/** Merge one channel's state, emitting only when it actually changed. */
function applyStatus(status: ChannelStatus): void {
	if (current.get(status.id) !== status.state) {
		current.set(status.id, status.state);
		emit();
	}
}

/** Fetch the current snapshot so state is correct immediately on (re)connect. */
async function loadSnapshot(token: string, signal: AbortSignal): Promise<void> {
	const resp = await fetch(`${BASE}/status`, {
		headers: { Authorization: `Bearer ${token}` },
		signal,
	});
	if (!resp.ok) {
		throw new Error(`status snapshot failed: ${resp.status}`);
	}
	const body = channelStatusesReplySchema.parse(await resp.json());
	for (const status of body.statuses ?? []) {
		if (signal.aborted) {
			return;
		}
		applyStatus(status);
	}
}

/** Parse one SSE frame and apply its status payload. */
function dispatchFrame(frame: string): void {
	let event: string | null = null;
	const dataLines: string[] = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith(EVENT_PREFIX)) {
			event = line.slice(EVENT_PREFIX.length).trim();
		} else if (line.startsWith(DATA_PREFIX)) {
			dataLines.push(line.slice(DATA_PREFIX.length).trim());
		}
	}
	if (event !== "status" || dataLines.length === 0) {
		// Pings and untagged frames carry no state — ignore them.
		return;
	}
	try {
		applyStatus(channelStatusSchema.parse(JSON.parse(dataLines.join("\n"))));
	} catch {
		// Ignore malformed frames; the next heartbeat self-heals.
	}
}

/** Read the SSE stream until it ends, applying frames as they arrive. */
async function pump(token: string, signal: AbortSignal): Promise<void> {
	const resp = await fetch(`${BASE}/status/stream`, {
		headers: { Authorization: `Bearer ${token}` },
		signal,
	});
	if (!(resp.ok && resp.body)) {
		throw new Error(`status stream failed: ${resp.status}`);
	}
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (!signal.aborted) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let sep = buffer.indexOf(FRAME_SEP);
			while (sep !== -1 && !signal.aborted) {
				dispatchFrame(buffer.slice(0, sep));
				buffer = buffer.slice(sep + FRAME_SEP.length);
				sep = buffer.indexOf(FRAME_SEP);
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

/** Run (and keep reconnecting) the shared connection until it is torn down. */
async function runConnection(signal: AbortSignal): Promise<void> {
	let backoff = INITIAL_BACKOFF_MS;
	while (running && !signal.aborted) {
		const token = authToken();
		if (token) {
			try {
				await loadSnapshot(token, signal);
				if (signal.aborted) {
					return;
				}
				await pump(token, signal);
				backoff = INITIAL_BACKOFF_MS; // a clean end resets the backoff
			} catch {
				// Connect/read failed (sign-out, control-plane restart) — reconnect.
			}
		}
		if (!running || signal.aborted) {
			break;
		}
		// When signed out we have no token; wait a full interval before retrying
		// so we pick up a later sign-in without hot-looping.
		await abortableDelay(token ? backoff : MAX_BACKOFF_MS, signal);
		backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
	}
}

/**
 * Subscribe to channel liveness. The listener is called immediately with the
 * current snapshot and again whenever any channel's state changes. Opens the
 * shared socket on the first subscriber and closes it when the last leaves.
 * Returns an unsubscribe function (idempotent).
 */
export function subscribeChannelStatus(listener: Listener): () => void {
	listeners.add(listener);
	listener(new Map(current));

	if (!running) {
		running = true;
		controller = new AbortController();
		// runConnection swallows its own errors and loops until torn down; the
		// catch keeps the promise non-floating without a disallowed `void`.
		runConnection(controller.signal).catch(() => {
			// Unreachable — runConnection never rejects.
		});
	}

	let unsubscribed = false;
	return () => {
		if (unsubscribed) {
			return;
		}
		unsubscribed = true;
		listeners.delete(listener);
		if (listeners.size === 0) {
			running = false;
			controller?.abort();
			controller = null;
			current.clear();
		}
	};
}
