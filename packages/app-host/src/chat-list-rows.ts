import { z } from "zod";
import { allowlistRecord, allowlistRows } from "./allowlist-projection.ts";

// Rows of chat.list, which rides the ask-to-send grant chat.sendFollowUp. The
// Gateway approves that grant for any app id, so a frame gets what a picker
// shows and sorts by (an id, a title, the agent, a state flag or two and
// times), built as a new object by allowlistRecord. Message text (Core's
// last_message preview), folder and worktree paths, the branch, participants,
// linked pull requests and whatever Core adds later stay on the host.
//
// A host that serves chat.list parses Core's rows with chatListRowsSchema
// before it hands them to dispatchRpc. created_at is listed because the reply
// schema of dispatchRpc requires it.

/** One conversation as an app frame may see it in a picker. */
export const chatListRowSchema = allowlistRecord(
	z.object({
		agent_id: z.string().nullable(),
		archived: z.boolean().optional(),
		created_at: z.number(),
		id: z.string(),
		last_message_at: z.number().optional(),
		message_count: z.number(),
		run_status: z.string().nullable(),
		title: z.string().nullable(),
		updated_at: z.number(),
	})
);
export type ChatListRow = z.output<typeof chatListRowSchema>;

/** The whole chat.list reply. Parsing returns a new array of new objects. */
export const chatListRowsSchema = allowlistRows(chatListRowSchema);
