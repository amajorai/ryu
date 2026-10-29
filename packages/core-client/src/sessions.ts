// apps/desktop/src/lib/api/sessions.ts
//
// Read-only client for Core's per-Runnable sessions (`/api/sessions*`). A session
// binds a run of a Runnable (agent/workflow/…) to a conversation and tracks its
// lifecycle status. The desktop surfaces these read-only (which runs happened on a
// conversation and how they ended); creation/status mutation is driven by Core
// itself during a run, not by the user.

import { z } from "zod";

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
	execution_profile?: ExecutionProfile | null;
	id: string;
	native_session_id?: string | null;
	parent_session_id?: string | null;
	runnable_id: string;
	runnable_kind: string;
	status: SessionStatus;
	updated_at: number;
}

const sessionExecutionProfileFields = z.object({
	approval: z.enum(["inherit", "on_risk", "always", "never"]),
	cwd: z.string().optional(),
	kind: z.enum(["local", "worktree", "remote", "cloud"]),
	network: z.enum(["inherit", "denied", "gateway_only", "allow"]),
	sandbox: z.enum(["inherit", "workspace", "strict"]),
	worktreeBranch: z.string().optional(),
	worktreeIsolation: z.boolean(),
});
const sessionExecutionProfileResponse = z.custom<
	z.output<typeof sessionExecutionProfileFields>
>((value) => sessionExecutionProfileFields.safeParse(value).success);
const sessionWireFields = z.object({
	id: z.string(),
	conversation_id: z.string(),
	runnable_id: z.string(),
	runnable_kind: z.string(),
	status: z.enum(["idle", "running", "completed", "failed"]),
	execution_profile: sessionExecutionProfileResponse.nullable().optional(),
	parent_session_id: z.string().nullable().optional(),
	native_session_id: z.string().nullable().optional(),
	created_at: z.number(),
	updated_at: z.number(),
});
const sessionsResponseFields = z.object({
	conversation_id: z.string().optional(),
	sessions: z.array(sessionWireFields).nullable().optional(),
});
const sessionsResponse = z.custom<z.output<typeof sessionsResponseFields>>(
	(value) => sessionsResponseFields.safeParse(value).success
);

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
	const body = sessionsResponse.parse(await resp.json());
	return (body.sessions ?? [])
		.map(toSession)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}
