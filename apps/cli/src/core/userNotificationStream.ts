import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "@ryuhq/core-client/client";
import { z } from "zod";

export interface UserNotificationEvent {
	body?: string | null;
	level?: string;
	notification_id?: string | null;
	target_user_id?: string | null;
	title: string;
}

const notificationEventSchema = z.object({
	title: z.string(),
	target_user_id: z.string().nullable().catch(null),
	body: z.string().nullable().catch(null),
	level: z.string().optional().catch(undefined),
	notification_id: z.string().nullable().catch(null),
});

const FRAME_SEPARATOR = /\r?\n\r?\n/;

function parseFrame(
	frame: string,
	userId: string | null
): UserNotificationEvent | null {
	const data = frame
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice("data:".length).trim())
		.join("\n");
	if (!data) {
		return null;
	}
	try {
		const parsed = notificationEventSchema.safeParse(JSON.parse(data));
		if (!parsed.success) {
			return null;
		}
		const event = parsed.data;
		if (event.target_user_id && userId && event.target_user_id !== userId) {
			return null;
		}
		return {
			body: event.body,
			level: event.level,
			notification_id: event.notification_id,
			target_user_id: event.target_user_id,
			title: event.title,
		};
	} catch {
		return null;
	}
}

/** Read Core's verified-user notification stream; Core scopes it to this viewer. */
export async function streamUserNotifications(
	target: ApiTarget,
	userId: string | null,
	onEvent: (event: UserNotificationEvent) => void,
	signal?: AbortSignal
): Promise<void> {
	const query = new URLSearchParams();
	if (userId) {
		query.set("user_id", userId);
	}
	const path = query.size
		? `/api/notifications/stream?${query.toString()}`
		: "/api/notifications/stream";
	const response = await fetchForTarget(target)(apiUrl(target, path), {
		method: "GET",
		headers: makeHeaders(target.token, target.userJwt),
		signal,
	});
	if (!(response.ok && response.body)) {
		throw new Error(`notifications stream failed: ${response.status}`);
	}

	const reader = response.body.getReader();
	const cancelReader = () => {
		void reader.cancel().catch(() => undefined);
	};
	signal?.addEventListener("abort", cancelReader, { once: true });
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let match = FRAME_SEPARATOR.exec(buffer);
			while (match && match.index !== undefined) {
				const frame = buffer.slice(0, match.index);
				const event = parseFrame(frame, userId);
				if (event) {
					onEvent(event);
				}
				buffer = buffer.slice(match.index + match[0].length);
				match = FRAME_SEPARATOR.exec(buffer);
			}
		}
	} finally {
		signal?.removeEventListener("abort", cancelReader);
		reader.releaseLock();
	}
}
