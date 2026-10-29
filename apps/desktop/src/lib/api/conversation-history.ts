import { z } from "zod";

import { type ApiTarget, request } from "./client.ts";

export interface HistoryRedactions {
	custom: number;
	pii: number;
	secrets: number;
}

export interface PortableHistoryMessage {
	agentId: string | null;
	content: string;
	createdAt: string;
	id: string;
	role: string;
}

export interface PortableHistoryTranscript {
	agentId: string | null;
	branch: string | null;
	codeCommit: string | null;
	createdAt: string;
	format: "ryu-portable-conversation";
	messages: PortableHistoryMessage[];
	omittedStructuredParts: number;
	redactionPolicy: string;
	sourceId: string;
	title: string;
	updatedAt: string;
	version: 1;
}

export interface HistoryPreview {
	checkpointId: string;
	redactions: HistoryRedactions;
	repoAvailable: boolean;
	repoError: string | null;
	repoRoot: string | null;
	transcript: PortableHistoryTranscript;
}

export interface GitHistoryEntry {
	branch: string | null;
	checkpointId: string;
	codeCommit: string;
	format: string;
	messageCount: number;
	redactions: HistoryRedactions;
	sourceId: string;
	title: string;
	updatedAt: string;
	version: number;
}

const historyPreviewInputSchema = z.json();
type HistoryPreviewInput = z.infer<typeof historyPreviewInputSchema>;
const historyPreviewEnvelopeSchema = z.object({
	transcript: z.record(z.string(), z.json()),
	redactions: z.record(z.string(), z.json()),
});
const historyIntegerSchema = z.number().refine(Number.isInteger);
const historyIdentifierSchema = z.string().regex(/^[a-fA-F0-9]{64}$/);
const portableHistoryMessageSchema = z
	.object({
		agentId: z.string().nullable(),
		content: z.string(),
		createdAt: z.string(),
		id: z.string(),
		role: z.string(),
	})
	.catchall(z.json());
const portableHistoryTranscriptSchema = z
	.object({
		agentId: z.string().nullable(),
		branch: z.string().nullable(),
		codeCommit: z.string().nullable(),
		createdAt: z.string(),
		format: z.literal("ryu-portable-conversation"),
		messages: z.array(portableHistoryMessageSchema),
		omittedStructuredParts: historyIntegerSchema,
		redactionPolicy: z.literal("locked-sensitive-v1"),
		sourceId: historyIdentifierSchema,
		title: z.string(),
		updatedAt: z.string(),
		version: z.literal(1),
	})
	.catchall(z.json());
export const historyPreviewSchema = z
	.object({
		checkpointId: historyIdentifierSchema,
		redactions: z
			.object({
				custom: historyIntegerSchema.default(0),
				pii: historyIntegerSchema,
				secrets: historyIntegerSchema,
			})
			.catchall(z.json()),
		repoAvailable: z.boolean(),
		repoError: z.string().nullable(),
		repoRoot: z.string().nullable(),
		transcript: portableHistoryTranscriptSchema,
	})
	.catchall(z.json()) satisfies z.ZodType<HistoryPreview>;

/** Versioned Core contract shared with the Rust fixture test. */
export function parseHistoryPreview(
	value: HistoryPreviewInput
): HistoryPreview {
	if (!historyPreviewEnvelopeSchema.safeParse(value).success) {
		throw new Error("Core returned an invalid history preview.");
	}
	const parsed = historyPreviewSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error("Core returned an unsupported history preview.");
	}
	return parsed.data;
}

export function getHistoryPreview(
	target: ApiTarget,
	conversationId: string,
	extraRedactions: string[] = []
): Promise<HistoryPreview> {
	const path = `/api/conversations/${encodeURIComponent(conversationId)}/history-preview`;
	return extraRedactions.length === 0
		? request(target, path, undefined, z.json()).then(parseHistoryPreview)
		: request(
				target,
				path,
				{
					method: "POST",
					body: { extraRedactions },
				},
				z.json()
			).then(parseHistoryPreview);
}

export function saveGitHistory(
	target: ApiTarget,
	conversationId: string,
	preview: HistoryPreview,
	extraRedactions: string[] = []
): Promise<SavedGitHistory> {
	if (!(preview.transcript.codeCommit && preview.repoRoot)) {
		throw new Error("A committed Git repository is required.");
	}
	return request(
		target,
		`/api/conversations/${encodeURIComponent(conversationId)}/git-history`,
		{
			method: "POST",
			body: {
				expectedCheckpointId: preview.checkpointId,
				expectedHead: preview.transcript.codeCommit,
				expectedRepoRoot: preview.repoRoot,
				extraRedactions,
			},
		},
		savedGitHistoryResponseSchema
	);
}

export function listGitHistory(
	target: ApiTarget,
	cwd: string
): Promise<GitHistoryList> {
	return request(
		target,
		`/api/git/history?cwd=${encodeURIComponent(cwd)}`,
		undefined,
		gitHistoryListResponseSchema
	);
}

export function readGitHistory(
	target: ApiTarget,
	cwd: string,
	checkpointId: string
): Promise<ReadGitHistory> {
	return request(
		target,
		`/api/git/history/${encodeURIComponent(checkpointId)}?cwd=${encodeURIComponent(cwd)}`,
		undefined,
		readGitHistoryResponseSchema
	);
}

export function importGitHistory(
	target: ApiTarget,
	cwd: string,
	checkpointId: string
): Promise<ImportedGitHistory> {
	return request(
		target,
		"/api/git/history/import",
		{
			method: "POST",
			body: { cwd, checkpointId },
		},
		importedGitHistoryResponseSchema
	);
}

export function syncGitHistory(
	target: ApiTarget,
	cwd: string,
	action: "fetch" | "push"
): Promise<SyncedGitHistory> {
	return request(
		target,
		"/api/git/history/sync",
		{
			method: "POST",
			body: { cwd, action },
		},
		syncedGitHistoryResponseSchema
	);
}

export interface SavedGitHistory {
	checkpoint: {
		checkpointId: string;
		checkpointRef: string;
		codeCommit: string;
		alreadySaved: boolean;
	};
	redactions: HistoryRedactions;
}

export interface GitHistoryList {
	entries: GitHistoryEntry[];
	skipped: number;
}

export interface ReadGitHistory {
	transcript: PortableHistoryTranscript;
}

export interface ImportedGitHistory {
	checkpointId: string;
	conversationId: string;
	messagesAdded: number;
}

export interface SyncedGitHistory {
	action: string;
	ok: boolean;
}

const gitHistoryCheckpointResponseSchema = z
	.object({
		checkpointId: z.string(),
		checkpointRef: z.string(),
		codeCommit: z.string(),
		alreadySaved: z.boolean(),
	})
	.passthrough();

const historyRedactionsResponseSchema = z
	.object({ custom: z.number(), pii: z.number(), secrets: z.number() })
	.passthrough();

const savedGitHistoryResponseSchema = z
	.object({
		checkpoint: gitHistoryCheckpointResponseSchema,
		redactions: historyRedactionsResponseSchema,
	})
	.passthrough();

const gitHistoryEntryResponseSchema = z
	.object({
		branch: z.union([z.null(), z.string()]),
		checkpointId: z.string(),
		codeCommit: z.string(),
		format: z.string(),
		messageCount: z.number(),
		redactions: historyRedactionsResponseSchema,
		sourceId: z.string(),
		title: z.string(),
		updatedAt: z.string(),
		version: z.number(),
	})
	.passthrough();

const gitHistoryListResponseSchema = z
	.object({
		entries: z.array(gitHistoryEntryResponseSchema),
		skipped: z.number(),
	})
	.passthrough();

const portableHistoryMessageResponseSchema = z
	.object({
		agentId: z.union([z.null(), z.string()]),
		content: z.string(),
		createdAt: z.string(),
		id: z.string(),
		role: z.string(),
	})
	.passthrough();

const portableHistoryTranscriptResponseSchema = z
	.object({
		agentId: z.union([z.null(), z.string()]),
		branch: z.union([z.null(), z.string()]),
		codeCommit: z.union([z.null(), z.string()]),
		createdAt: z.string(),
		format: z.literal("ryu-portable-conversation"),
		messages: z.array(portableHistoryMessageResponseSchema),
		omittedStructuredParts: z.number(),
		redactionPolicy: z.string(),
		sourceId: z.string(),
		title: z.string(),
		updatedAt: z.string(),
		version: z.literal(1),
	})
	.passthrough();

const readGitHistoryResponseSchema = z
	.object({ transcript: portableHistoryTranscriptResponseSchema })
	.passthrough();

const importedGitHistoryResponseSchema = z
	.object({
		checkpointId: z.string(),
		conversationId: z.string(),
		messagesAdded: z.number(),
	})
	.passthrough();

const syncedGitHistoryResponseSchema = z
	.object({ action: z.string(), ok: z.boolean() })
	.passthrough();
