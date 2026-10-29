// apps/desktop/src/lib/api/chat-checkpoints.ts
//
// Typed client for Core's chat rewind checkpoints:
//   - `GET /api/conversations/:id/checkpoints`
//   - `GET /api/conversations/:id/checkpoints/:checkpointId/changes`
//   - `POST /api/conversations/:id/checkpoints/:checkpointId/restore`
//
// Core snapshots the chat's folder before every user turn, for every agent and
// provider, so a rewind can restore code and/or conversation.

import { z } from "zod";
import { type ApiTarget, apiUrl, makeHeaders, readJsonBody } from "./client.ts";

const chatCheckpointSchema = z.object({
	id: z.string(),
	messageId: z.string().nullable(),
	kind: z.enum(["turn", "preRestore"]),
	workspace: z.string().nullable(),
	hasFiles: z.boolean(),
	skipReason: z.string().nullable(),
	preview: z.string().nullable(),
	createdAt: z.string(),
});

export type ChatCheckpoint = z.infer<typeof chatCheckpointSchema>;

const listSchema = z.object({ checkpoints: z.array(chatCheckpointSchema) });

const fileChangeSchema = z.object({
	path: z.string(),
	kind: z.enum(["added", "modified", "deleted"]),
});

export type CheckpointFileChange = z.infer<typeof fileChangeSchema>;

const changesSchema = z.object({
	workspace: z.string(),
	changes: z.array(fileChangeSchema),
});

const skippedPathSchema = z.object({
	path: z.string(),
	reason: z.enum(["notSaved", "pathBlocked", "symlinkParent", "writeFailed"]),
});

export type CheckpointSkippedPath = z.infer<typeof skippedPathSchema>;

const restoreSchema = z.object({
	files: z
		.object({
			restored: z.array(z.string()),
			removed: z.array(z.string()),
			skipped: z.array(skippedPathSchema),
			undoCheckpoint: chatCheckpointSchema.nullable(),
		})
		.nullable(),
	conversation: z
		.object({
			rewoundMessageId: z.string(),
			rewoundText: z.string(),
			activeLeafMessageId: z.string().nullable(),
			resendAsEdit: z.boolean(),
		})
		.nullable(),
});

export type CheckpointRestoreResult = z.infer<typeof restoreSchema>;

export type CheckpointRestoreMode =
	| "codeAndConversation"
	| "conversation"
	| "code";

function checkpointsPath(conversationId: string, suffix = ""): string {
	return `/api/conversations/${encodeURIComponent(conversationId)}/checkpoints${suffix}`;
}

export async function listChatCheckpoints(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<ChatCheckpoint[]> {
	const response = await fetch(
		apiUrl(target, checkpointsPath(conversationId)),
		{
			headers: makeHeaders(target.token, target.userJwt),
			signal,
		}
	);
	const { data, error } = await readJsonBody(
		response,
		"checkpoints",
		listSchema
	);
	if (error) {
		throw new Error(error);
	}
	if (!data) {
		throw new Error("invalid checkpoints response");
	}
	return data.checkpoints;
}

export async function fetchCheckpointChanges(
	target: ApiTarget,
	conversationId: string,
	checkpointId: string,
	signal?: AbortSignal
): Promise<CheckpointFileChange[]> {
	const response = await fetch(
		apiUrl(
			target,
			checkpointsPath(
				conversationId,
				`/${encodeURIComponent(checkpointId)}/changes`
			)
		),
		{ headers: makeHeaders(target.token, target.userJwt), signal }
	);
	const { data, error } = await readJsonBody(
		response,
		"checkpoint changes",
		changesSchema
	);
	if (error) {
		throw new Error(error);
	}
	if (!data) {
		throw new Error("invalid checkpoint changes response");
	}
	return data.changes;
}

export async function restoreChatCheckpoint(
	target: ApiTarget,
	conversationId: string,
	checkpointId: string,
	mode: CheckpointRestoreMode
): Promise<CheckpointRestoreResult> {
	const response = await fetch(
		apiUrl(
			target,
			checkpointsPath(
				conversationId,
				`/${encodeURIComponent(checkpointId)}/restore`
			)
		),
		{
			body: JSON.stringify({ mode }),
			headers: makeHeaders(target.token, target.userJwt),
			method: "POST",
		}
	);
	const { data, error } = await readJsonBody(
		response,
		"checkpoint restore",
		restoreSchema
	);
	if (error) {
		throw new Error(error);
	}
	if (!data) {
		throw new Error("invalid checkpoint restore response");
	}
	return data;
}
