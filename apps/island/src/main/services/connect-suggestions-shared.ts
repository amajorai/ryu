import { z } from "zod";
/** Minimal, validated projection of a Core notification row. */
export interface ConnectSuggestionNotification {
	body: string;
	createdAt: string;
	id: string;
	title: string;
}

const notificationSchema = z.object({
	source_app_id: z.literal("@ryu/island"),
	archived_at: z.union([z.null(), z.literal("")]).optional(),
	id: z.string(),
	title: z.string(),
	created_at: z.string(),
	body: z.string().catch(""),
});

/** Only live, server-authored Island notifications surface. */
export function parseConnectSuggestionNotifications(
	values: Parameters<typeof notificationSchema.safeParse>[0][]
): ConnectSuggestionNotification[] {
	return values.flatMap((value) => {
		const parsed = notificationSchema.safeParse(value);
		if (!parsed.success) {
			return [];
		}
		const row = parsed.data;
		return [
			{
				id: row.id,
				title: row.title,
				body: row.body,
				createdAt: row.created_at,
			},
		];
	});
}
