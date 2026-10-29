import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
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

import { activityJsonValueSchema } from "@ryuhq/core-client/activity.ts";
import {
	type AppNotification,
	type MentionTargetUser,
	mentionTargetUserSchema,
	notificationAckReplySchema,
	notificationsListReplySchema,
	type UserNotificationEvent,
	userNotificationEventSchema,
} from "@ryuhq/core-client/notifications.ts";
import { z } from "zod";
import { type ApiTarget, authenticatedFetch, request } from "./client.ts";
import { encodePathId } from "./path-id.ts";

const mentionRosterReplySchema = z.object({
	users: z.array(activityJsonValueSchema).nullish(),
});

export {
	redactConnectSuggestionEvent,
	redactConnectSuggestionNotifications,
} from "@ryu/app-host/notification-privacy";
export type {
	AppNotification,
	MentionTargetUser,
	UserNotificationEvent,
} from "@ryuhq/core-client/notifications.ts";

const DEFAULT_LIMIT = 50;

/** Read the Inbox-gated, node-scoped human roster for the chat @ picker. */
export async function listMentionTargetUsers(
	target: ApiTarget
): Promise<MentionTargetUser[]> {
	try {
		const json = mentionRosterReplySchema.parse(
			await request(
				target,
				"/api/notifications/mention-targets",
				{},
				gatewayJsonValueSchema
			)
		);
		const users: MentionTargetUser[] = [];
		for (const raw of json.users ?? []) {
			// A null roster row previously aborted the whole roster; retain that fallback.
			if (raw === null) {
				return [];
			}
			const parsed = mentionTargetUserSchema.safeParse(raw);
			if (!(parsed.success && parsed.data.userId)) {
				continue;
			}
			const user = parsed.data;
			users.push({
				id: user.userId,
				email: user.email,
				image: user.image,
				name: user.name ?? user.email?.split("@")[0] ?? user.userId,
				role: user.role,
			});
		}
		return users;
	} catch {
		return [];
	}
}

/** List the signed-in user's inbox notifications (newest first).
 *  `archived`: `false` (default) = live inbox, `true` = archived rows only. */
export async function listNotifications(
	target: ApiTarget,
	userId: string,
	limit = DEFAULT_LIMIT,
	archived?: boolean
): Promise<AppNotification[]> {
	const params = new URLSearchParams({
		user_id: userId,
		limit: String(limit),
	});
	if (archived !== undefined) {
		params.set("archived", String(archived));
	}
	const json = notificationsListReplySchema.parse(
		await request(
			target,
			`/api/notifications?${params.toString()}`,
			{},
			gatewayJsonValueSchema
		)
	);
	return json.notifications ?? [];
}

/** Mark a notification read. Idempotent server-side. */
export async function markNotificationRead(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(
		target,
		`/api/notifications/${encodePathId(id)}/read`,
		{ method: "POST" },
		gatewayJsonValueSchema
	);
}

/** Archive a notification (also marks it read). Idempotent server-side. */
export async function archiveNotification(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(
		target,
		`/api/notifications/${encodePathId(id)}/archive`,
		{ method: "POST" },
		gatewayJsonValueSchema
	);
}

/** Restore an archived notification to the live inbox. Idempotent server-side. */
export async function unarchiveNotification(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(
		target,
		`/api/notifications/${encodePathId(id)}/unarchive`,
		{
			method: "POST",
		},
		gatewayJsonValueSchema
	);
}

/**
 * Acknowledge a HITL notification gate. Returns whether the ack resumed the
 * suspended workflow run (true once the gate's policy — first/all/quorum/percentage — is met).
 */
export async function ackNotification(
	target: ApiTarget,
	id: string
): Promise<boolean> {
	const json = notificationAckReplySchema.parse(
		await request(
			target,
			`/api/notifications/${encodePathId(id)}/ack`,
			{ method: "POST" },
			gatewayJsonValueSchema
		)
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
		return userNotificationEventSchema.parse(JSON.parse(dataLines.join("\n")));
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
	const resp = await authenticatedFetch(
		target,
		`/api/notifications/stream?${params.toString()}`,
		{ method: "GET", signal }
	);
	if (!(resp.ok && resp.body)) {
		throw new Error(`notification stream failed: ${resp.status}`);
	}
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (!signal?.aborted) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let sep = buffer.indexOf(FRAME_SEP);
			while (sep !== -1 && !signal?.aborted) {
				const event = parseFrame(buffer.slice(0, sep));
				if (event) {
					onEvent(event);
				}
				buffer = buffer.slice(sep + FRAME_SEP.length);
				sep = buffer.indexOf(FRAME_SEP);
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
