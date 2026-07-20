// apps/desktop/src/lib/api/agent-threads.ts
//
// Client for importing an agent's *own* on-disk thread history (Claude Code /
// Codex) into a Ryu conversation — the "import agent thread" feature (parity
// with how Zed imports and VS Code auto-surfaces past agent threads). List the
// threads Core found in the agent's native history store, then import one into a
// fresh Ryu conversation the desktop can open like any other.

import { type ApiTarget, apiUrl, makeHeaders } from "./client.ts";

export interface NativeThread {
	cwd?: string;
	engine: string;
	gitBranch?: string;
	/** Opaque locator Core round-trips back to the on-disk transcript. */
	id: string;
	messageCount: number;
	nativeSessionId?: string;
	title: string;
	/** Epoch millis of last activity (file mtime). */
	updatedAt: number;
}

interface NativeThreadWire {
	cwd?: string;
	engine: string;
	git_branch?: string;
	id: string;
	message_count: number;
	native_session_id?: string;
	title: string;
	updated_at: number;
}

function toThread(t: NativeThreadWire): NativeThread {
	return {
		id: t.id,
		engine: t.engine,
		title: t.title,
		cwd: t.cwd,
		gitBranch: t.git_branch,
		nativeSessionId: t.native_session_id,
		messageCount: t.message_count,
		updatedAt: t.updated_at,
	};
}

export interface AgentThreadsResult {
	engine: string;
	/** False when the agent's engine has no readable native history store. */
	supported: boolean;
	threads: NativeThread[];
}

/**
 * List the importable threads in an agent's native history store, newest first.
 * Optionally filter to threads that ran in `cwd`. Unsupported engines resolve to
 * `{ supported: false, threads: [] }` rather than throwing.
 */
export async function listAgentThreads(
	target: ApiTarget,
	agentId: string,
	cwd?: string
): Promise<AgentThreadsResult> {
	const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
	const resp = await fetch(
		apiUrl(
			target,
			`/api/agents/${encodeURIComponent(agentId)}/threads${query}`
		),
		{ headers: makeHeaders(target.token) }
	);
	if (!resp.ok) {
		throw new Error(`Failed to load agent threads: ${resp.status}`);
	}
	const body = (await resp.json()) as {
		engine?: string;
		supported?: boolean;
		threads?: NativeThreadWire[];
	};
	return {
		engine: body.engine ?? "",
		supported: body.supported ?? false,
		threads: (body.threads ?? [])
			.map(toThread)
			.sort((a, b) => b.updatedAt - a.updatedAt),
	};
}

export interface ImportedThreadResult {
	/** True when this thread was already imported before — the id points at the
	 * existing conversation rather than a freshly created one. */
	alreadyImported: boolean;
	conversationId: string;
	/** Workspace folder the thread ran in, if the transcript recorded one. Used
	 * to register the folder as a project so the chat appears grouped. */
	cwd?: string;
	messageCount: number;
	title: string;
	truncated: boolean;
}

/**
 * Import a native thread into a fresh Ryu conversation. Returns the new
 * conversation id so the caller can open it in a chat tab.
 */
export async function importAgentThread(
	target: ApiTarget,
	agentId: string,
	threadId: string
): Promise<ImportedThreadResult> {
	const resp = await fetch(
		apiUrl(target, `/api/agents/${encodeURIComponent(agentId)}/threads/import`),
		{
			method: "POST",
			headers: {
				...makeHeaders(target.token),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ thread_id: threadId }),
		}
	);
	if (!resp.ok) {
		throw new Error(`Failed to import thread: ${resp.status}`);
	}
	const body = (await resp.json()) as {
		already_imported?: boolean;
		conversation_id: string;
		cwd?: string;
		message_count?: number;
		truncated?: boolean;
		title?: string;
	};
	return {
		alreadyImported: body.already_imported ?? false,
		conversationId: body.conversation_id,
		cwd: body.cwd,
		messageCount: body.message_count ?? 0,
		truncated: body.truncated ?? false,
		title: body.title ?? "Imported thread",
	};
}
