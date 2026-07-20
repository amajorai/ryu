// apps/desktop/src/lib/api/notifications.ts
//
// Typed client for Core's app-inbox notification API (`/api/notifications/*`):
// the per-user feed a `notify_user` workflow node writes to. Field names are
// snake_case to match Core's serde shapes exactly.
//
// Two distinct shapes live here and must not be conflated:
//   - `AppNotification` — a stored inbox row (list endpoint / read + ack).
//   - `UserNotificationEvent` — the live SSE ping pushed to a single user.
// This is separate from the broadcast `DesktopNotification` in events.ts (the
// multiplexed `/api/events/all` `notifications` channel), which Core filters so
// user-targeted pings never arrive there. The per-user stream below is a plain
// SSE socket keyed by `user_id`, read with fetch + ReadableStream so the bearer
// token can be attached (EventSource can't set headers).

import { apiUrl, type ApiTarget, makeHeaders, request } from "./client.ts";

/** A stored inbox notification row (newest first from the list endpoint). */
export interface AppNotification {
	acked: boolean;
	ack_required: boolean;
	body?: string | null;
	created_at: string;
	id: string;
	level: string;
	node_id?: string | null;
	read_at?: string | null;
	title: string;
	user_id: string;
	workflow_run_id?: string | null;
}

/** A live, user-targeted notification ping from `/api/notifications/stream`. */
export interface UserNotificationEvent {
	body?: string | null;
	level: string;
	notification_id?: string | null;
	target_user_id?: string | null;
	title: string;
}

const DEFAULT_LIMIT = 50;

/** List the signed-in user's inbox notifications (newest first). */
export async function listNotifications(
	target: ApiTarget,
	userId: string,
	limit = DEFAULT_LIMIT
): Promise<AppNotification[]> {
	const params = new URLSearchParams({
		user_id: userId,
		limit: String(limit),
	});
	const json = await request<{ notifications?: AppNotification[] }>(
		target,
		`/api/notifications?${params.toString()}`
	);
	return json.notifications ?? [];
}

/** Mark a notification read. Idempotent server-side. */
export async function markNotificationRead(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(target, `/api/notifications/${id}/read`, { method: "POST" });
}

/**
 * Acknowledge a HITL notification gate. Returns whether the ack resumed the
 * suspended workflow run (true once the gate's policy — first/all/quorum — is met).
 */
export async function ackNotification(
	target: ApiTarget,
	id: string
): Promise<boolean> {
	const json = await request<{ ok?: boolean; resumed?: boolean }>(
		target,
		`/api/notifications/${id}/ack`,
		{ method: "POST" }
	);
	return json.resumed ?? false;
}

const FRAME_SEP = "\n\n";
const DATA_PREFIX = "data:";

/** Parse one SSE frame's `data:` lines into a UserNotificationEvent. */
function parseFrame(frame: string): UserNotificationEvent | null {
	const dataLines: string[] = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith(DATA_PREFIX)) {
			dataLines.push(line.slice(DATA_PREFIX.length).trim());
		}
	}
	if (dataLines.length === 0) {
		return null;
	}
	try {
		return JSON.parse(dataLines.join("\n")) as UserNotificationEvent;
	} catch {
		// Keep-alive comments / malformed frames carry no payload — ignore them.
		return null;
	}
}

/**
 * Subscribe to the per-user notification SSE stream and invoke `onEvent` for each
 * ping. Resolves when the stream ends or `signal` aborts. Unlike the multiplexed
 * feeds this opens its own socket (the endpoint is scoped by `user_id`), so the
 * caller owns reconnect/backoff (see useNotificationEvents).
 */
export async function streamUserNotifications(
	target: ApiTarget,
	userId: string,
	onEvent: (event: UserNotificationEvent) => void,
	signal?: AbortSignal
): Promise<void> {
	const params = new URLSearchParams({ user_id: userId });
	const resp = await fetch(
		apiUrl(target, `/api/notifications/stream?${params.toString()}`),
		{ method: "GET", headers: makeHeaders(target.token), signal }
	);
	if (!(resp.ok && resp.body)) {
		throw new Error(`notification stream failed: ${resp.status}`);
	}
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let sep = buffer.indexOf(FRAME_SEP);
		while (sep !== -1) {
			const event = parseFrame(buffer.slice(0, sep));
			if (event) {
				onEvent(event);
			}
			buffer = buffer.slice(sep + FRAME_SEP.length);
			sep = buffer.indexOf(FRAME_SEP);
		}
	}
}
