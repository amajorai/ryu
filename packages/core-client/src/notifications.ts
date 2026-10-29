import { appResponseValueSchema } from "./app-request-json.ts";
// apps/desktop/src/lib/api/notifications.ts (minus the per-user SSE stream —
// the shared client mirrors the desktop surface without the socket, the same
// split as the quests client)
//
// Typed client for Core's app-inbox notification API (`/api/notifications/*`):
// the per-user feed a `notify_user` workflow node writes to. Field names are
// snake_case to match Core's serde shapes exactly.

import { z } from "zod";
import { activityJsonValueSchema } from "./activity.ts";
import { type ApiTarget, request } from "./client.ts";

/** A human the active node has scoped to the caller's organization. */
export interface MentionTargetUser {
	email: string | null;
	id: string;
	image: string | null;
	name: string;
	role: string | null;
}

// Complete Core store/stream publishers: notify/store.rs NotificationRow and
// events/mod.rs DesktopNotification. The list SQL requires user_id = ?1, so
// every row in this recipient-scoped projection has a present user_id.
function preserveNotificationReply<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			activityJsonValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
export const appNotificationSchema = preserveNotificationReply(
	z.object({
		ack_required: z.boolean(),
		acked: z.boolean(),
		archived_at: z.string().nullish(),
		body: z.string().nullish(),
		created_at: z.string(),
		id: z.string(),
		level: z.string(),
		node_id: z.string().nullish(),
		read_at: z.string().nullish(),
		source_app_id: z.string().nullish(),
		title: z.string(),
		user_id: z.string(),
		workflow_run_id: z.string().nullish(),
	})
);
export type AppNotification = z.output<typeof appNotificationSchema>;
export const appNotificationsSchema = preserveNotificationReply(
	z.array(appNotificationSchema)
);
export const notificationsListReplySchema = preserveNotificationReply(
	z.object({ notifications: appNotificationsSchema.nullish() })
);
export const notificationAckReplySchema = preserveNotificationReply(
	z.object({ ok: z.boolean().optional(), resumed: z.boolean().nullish() })
);
export const userNotificationEventSchema = preserveNotificationReply(
	z.object({
		body: z.string().nullish(),
		level: z.string(),
		notification_id: z.string().nullish(),
		source_app_id: z.string().nullish(),
		target_user_id: z.string().nullish(),
		title: z.string(),
	})
);
export type UserNotificationEvent = z.output<
	typeof userNotificationEventSchema
>;

const DEFAULT_LIMIT = 50;

const nullableRosterTextSchema = z
	.string()
	.transform((value) => value.trim() || null)
	.nullable()
	.catch(null);
export const mentionTargetUserSchema = z.object({
	userId: z
		.string()
		.transform((value) => value.trim())
		.catch(""),
	email: nullableRosterTextSchema,
	image: nullableRosterTextSchema,
	name: nullableRosterTextSchema,
	role: nullableRosterTextSchema,
});
const mentionTargetsResponseSchema = z.object({
	users: z.array(mentionTargetUserSchema).default([]),
});

/** Read the verified, node-scoped organization roster for workflow recipient pickers. */
export async function listMentionTargetUsers(
	target: ApiTarget
): Promise<MentionTargetUser[]> {
	try {
		const json = mentionTargetsResponseSchema.parse(
			await request(
				target,
				"/api/notifications/mention-targets",
				{},
				appResponseValueSchema
			)
		);
		return json.users.flatMap((user) =>
			user.userId
				? [
						{
							id: user.userId,
							email: user.email,
							image: user.image,
							name: user.name ?? user.email?.split("@")[0] ?? user.userId,
							role: user.role,
						},
					]
				: []
		);
	} catch {
		return [];
	}
}

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
	const json = notificationsListReplySchema.parse(
		await request(
			target,
			`/api/notifications?${params.toString()}`,
			{},
			appResponseValueSchema
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
		`/api/notifications/${id}/read`,
		{ method: "POST" },
		appResponseValueSchema
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
			`/api/notifications/${id}/ack`,
			{ method: "POST" },
			appResponseValueSchema
		)
	);
	return json.resumed ?? false;
}
