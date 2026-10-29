import {
	appJsonValueSchema,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import { z } from "zod";

// Complete ConversationSummary and flattened ThreadHierarchy publishers from
// Core's conversations.rs/conversations_hierarchy.rs. Optional fields retain
// the older list shapes; string dates retain the original CLI legacy display.
const conversationFields = z.object({
	id: z.string(),
	title: z.string().nullish(),
	agent_id: z.string().nullish(),
	created_at: z.number().optional(),
	updated_at: z.union([z.string(), z.number()]).nullish(),
	message_count: z.number().nullish(),
	folder_path: z.string().nullish(),
	branch: z.string().nullish(),
	worktree_path: z.string().nullish(),
	run_status: z.string().nullish(),
	participants: z.array(z.string()).optional(),
	pinned: z.boolean().nullish(),
	archived: z.boolean().nullish(),
	icon: appJsonValueSchema.optional(),
	visibility: z.string().optional(),
	last_message: z.string().nullish(),
	last_message_role: z.string().nullish(),
	last_message_at: z.number().nullish(),
	project_id: z.string().nullish(),
	thread_role: z.string().optional(),
	owner_kind: z.string().nullish(),
	owner_id: z.string().nullish(),
	coordination: z.string().nullish(),
	spawned_by_conversation_id: z.string().nullish(),
	spawned_by_message_id: z.string().nullish(),
	// Existing historical CLI organization buckets precede native hierarchy keys.
	folder: z.string().nullish(),
	project: z.string().nullish(),
});
const conversationListFields = z.union([
	z.array(conversationFields),
	z.object({ conversations: z.array(conversationFields).optional() }),
]);
export type ConversationWire = z.output<typeof conversationFields>;
export const conversationListResponseSchema = z.custom<
	z.output<typeof conversationListFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		conversationListFields.safeParse(value).success
);

const numericDateSchema = z.number();
const textDateSchema = z.string();
/** Native epoch-millisecond dates now display; legacy strings keep their exact
 * previous first-T segment, and out-of-Date-range native timestamps are empty. */
export function conversationDate(
	value: ConversationWire["updated_at"]
): string | null {
	const numeric = numericDateSchema.safeParse(value);
	if (numeric.success) {
		return Math.abs(numeric.data) <= 8_640_000_000_000_000
			? (new Date(numeric.data).toISOString().split("T")[0] ?? null)
			: null;
	}
	const text = textDateSchema.safeParse(value);
	const date = text.success ? text.data.split("T") : undefined;
	return date?.[0] && date[0].length > 0 ? date[0] : null;
}
