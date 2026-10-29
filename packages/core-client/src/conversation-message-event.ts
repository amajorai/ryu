import { z } from "zod";
import { appJsonValueSchema } from "./app-request-json.ts";
import type { RealtimeHandlers } from "./realtime.ts";

// conversations.rs publishes six common fields for promoted temporary turns,
// and thirteen for append_message_at_with_provenance. The seven added fields
// are optional here for the genuine six-field publisher, not discarded.
const conversationMessage = z
	.object({
		id: z.string(),
		role: z.string(),
		content: z.string(),
		author_user_id: z.string().nullable(),
		created_at: z.number(),
		agent_id: z.string().nullable(),
		client_id: z.string().nullable().optional(),
		author_name: z.string().nullable().optional(),
		source: z.string().nullable().optional(),
		widget_instance_id: z.string().nullable().optional(),
		origin_server: z.string().nullable().optional(),
		// These are full serde_json::Value slots. They do not promise AI SDK parts
		// or render metadata; Chat's existing live-insert path authors a text part.
		parts: appJsonValueSchema.optional(),
		metadata: appJsonValueSchema.optional(),
	})
	.passthrough();
const conversationMessageEvent = z
	.object({
		type: z.literal("message"),
		conversation_id: z.string(),
		message: conversationMessage,
	})
	.passthrough();

/** Observe the complete current Core message publisher fields, retaining the
 * entire native raw envelope and future fields without a UIMessage claim. */
export function observeConversationMessageEvent(
	raw: Parameters<NonNullable<RealtimeHandlers["onEvent"]>>[0]
) {
	const parsed = conversationMessageEvent.safeParse(raw);
	return parsed.success ? { event: parsed.data, raw } : null;
}
