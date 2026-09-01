// apps/desktop/src/lib/api/sessions.ts
//
// Read-only client for Core's per-Runnable sessions (`/api/sessions*`). A session
// binds a run of a Runnable (agent/workflow/…) to a conversation and tracks its
// lifecycle status. The desktop surfaces these read-only (which runs happened on a
// conversation and how they ended); creation/status mutation is driven by Core
// itself during a run, not by the user.

import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "./client.ts";
import type { ExecutionProfile } from "./harness.ts";

export type SessionStatus = "idle" | "running" | "completed" | "failed";

export interface Session {
	conversationId: string;
	createdAt: number;
	executionProfile: ExecutionProfile;
	id: string;
	nativeSessionId: string | null;
	parentSessionId: string | null;
	runnableId: string;
	/** Runnable kind as serialized by Core (agent/workflow/tool/…). */
	runnableKind: string;
	status: SessionStatus;
	updatedAt: number;
}

interface SessionWire {
	conversation_id: string;
	created_at: number;
	execution_profile?: ExecutionProfile;
	id: string;
	native_session_id?: string | null;
	parent_session_id?: string | null;
	runnable_id: string;
	runnable_kind: string;
	status: SessionStatus;
	updated_at: number;
}

function toSession(s: SessionWire): Session {
	return {
		id: s.id,
		conversationId: s.conversation_id,
		runnableId: s.runnable_id,
		runnableKind: String(s.runnable_kind),
		status: s.status,
		executionProfile: s.execution_profile ?? {
			approval: "inherit",
			kind: "local",
			network: "inherit",
			sandbox: "inherit",
			worktreeIsolation: false,
		},
		parentSessionId: s.parent_session_id ?? null,
		nativeSessionId: s.native_session_id ?? null,
		createdAt: s.created_at,
		updatedAt: s.updated_at,
	};
}

/** List the sessions that ran on a conversation, newest activity first. */
export async function listSessionsForConversation(
	target: ApiTarget,
	conversationId: string
): Promise<Session[]> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, `/api/conversations/${conversationId}/sessions`),
		{ headers: makeHeaders(target.token, target.userJwt) }
	);
	if (!resp.ok) {
		throw new Error(`Failed to load sessions: ${resp.status}`);
	}
	const body = (await resp.json()) as { sessions?: SessionWire[] };
	return (body.sessions ?? [])
		.map(toSession)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}
