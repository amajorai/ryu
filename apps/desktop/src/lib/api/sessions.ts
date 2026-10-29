// apps/desktop/src/lib/api/sessions.ts
//
// Read-only client for Core's per-Runnable sessions (`/api/sessions*`). A session
// binds a run of a Runnable (agent/workflow/…) to a conversation and tracks its
// lifecycle status. The desktop surfaces these read-only (which runs happened on a
// conversation and how they ended); creation/status mutation is driven by Core
// itself during a run, not by the user.

import { z } from "zod";

import { type ApiTarget, authenticatedFetch } from "./client.ts";

export type SessionStatus = "idle" | "running" | "completed" | "failed";

export interface Session {
	conversationId: string;
	createdAt: number;
	id: string;
	runnableId: string;
	/** Runnable kind as serialized by Core (agent/workflow/tool/…). */
	runnableKind: string;
	status: SessionStatus;
	updatedAt: number;
}

const sessionWireSchema = z.object({
	conversation_id: z.string(),
	created_at: z.number(),
	id: z.string(),
	runnable_id: z.string(),
	runnable_kind: z.string(),
	status: z.enum(["idle", "running", "completed", "failed"]),
	updated_at: z.number(),
});
type SessionWire = z.infer<typeof sessionWireSchema>;
const sessionsResponseSchema = z.object({
	sessions: z.array(sessionWireSchema).nullish(),
});

function toSession(s: SessionWire): Session {
	return {
		id: s.id,
		conversationId: s.conversation_id,
		runnableId: s.runnable_id,
		runnableKind: String(s.runnable_kind),
		status: s.status,
		createdAt: s.created_at,
		updatedAt: s.updated_at,
	};
}

/** List the sessions that ran on a conversation, newest activity first. */
export async function listSessionsForConversation(
	target: ApiTarget,
	conversationId: string
): Promise<Session[]> {
	const resp = await authenticatedFetch(
		target,
		`/api/conversations/${conversationId}/sessions`
	);
	if (!resp.ok) {
		throw new Error(`Failed to load sessions: ${resp.status}`);
	}
	const body = sessionsResponseSchema.parse(await resp.json());
	return (body.sessions ?? [])
		.map(toSession)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}
