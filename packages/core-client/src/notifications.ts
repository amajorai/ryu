// apps/desktop/src/lib/api/notifications.ts (minus the per-user SSE stream —
// the shared client mirrors the desktop surface without the socket, the same
// split as the quests client)
//
// Typed client for Core's app-inbox notification API (`/api/notifications/*`):
// the per-user feed a `notify_user` workflow node writes to. Field names are
// snake_case to match Core's serde shapes exactly.

import { type ApiTarget, request } from "./client.ts";

/** A stored inbox notification row (newest first from the list endpoint). */
export interface AppNotification {
	ack_required: boolean;
	acked: boolean;
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
