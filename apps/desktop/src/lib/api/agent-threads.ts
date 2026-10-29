import { z } from "zod";
// apps/desktop/src/lib/api/agent-threads.ts
//
// Client for importing an agent's *own* on-disk thread history (Claude Code /
// Codex) into a Ryu conversation — the "import agent thread" feature (parity
// with how Zed imports and VS Code auto-surfaces past agent threads). List the
// threads Core found in the agent's native history store, then import one into a
// fresh Ryu conversation the desktop can open like any other.

import { type ApiTarget, authenticatedFetch } from "./client.ts";

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
	const resp = await authenticatedFetch(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/threads${query}`
	);
	if (!resp.ok) {
		throw new Error(`Failed to load agent threads: ${resp.status}`);
	}
	const body = z
		.object({
			engine: z.string().optional(),
			supported: z.boolean().optional(),
			threads: z
				.array(
					z.object({
						cwd: z.string().optional(),
						engine: z.string(),
						git_branch: z.string().optional(),
						id: z.string(),
						message_count: z.number(),
						native_session_id: z.string().optional(),
						title: z.string(),
						updated_at: z.number(),
					})
				)
				.optional(),
		})
		.parse(await resp.json());
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
	 * existing conversation, updated with any new native messages, rather than a
	 * freshly created one. */
	alreadyImported: boolean;
	conversationId: string | null;
	/** Workspace folder the thread ran in, if the transcript recorded one. Used
	 * to register the folder as a project so the chat appears grouped. */
	cwd?: string;
	dryRun: boolean;
	messageCount: number;
	/** Messages appended to the Ryu conversation by this import. */
	messagesAdded: number;
	title: string;
	truncated: boolean;
	wouldCreate: boolean;
}

/**
 * Import a native thread into a fresh Ryu conversation. Returns the new
 * conversation id so the caller can open it in a chat tab.
 */
export async function importAgentThread(
	target: ApiTarget,
	agentId: string,
	threadId: string,
	options?: { dryRun?: boolean }
): Promise<ImportedThreadResult> {
	const resp = await authenticatedFetch(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/threads/import`,
		{
			method: "POST",
			body: JSON.stringify({
				dry_run: options?.dryRun ?? false,
				thread_id: threadId,
			}),
		}
	);
	if (!resp.ok) {
		throw new Error(`Failed to import thread: ${resp.status}`);
	}
	const body = z
		.object({
			already_imported: z.boolean().optional(),
			conversation_id: z.string().nullish(),
			cwd: z.string().optional(),
			dry_run: z.boolean().optional(),
			message_count: z.number().optional(),
			messages_added: z.number().optional(),
			truncated: z.boolean().optional(),
			title: z.string().optional(),
			would_create: z.boolean().optional(),
		})
		.parse(await resp.json());
	return {
		alreadyImported: body.already_imported ?? false,
		conversationId: body.conversation_id ?? null,
		cwd: body.cwd,
		dryRun: body.dry_run ?? false,
		messageCount: body.message_count ?? 0,
		messagesAdded: body.messages_added ?? body.message_count ?? 0,
		truncated: body.truncated ?? false,
		title: body.title ?? "Imported thread",
		wouldCreate: body.would_create ?? false,
	};
}
