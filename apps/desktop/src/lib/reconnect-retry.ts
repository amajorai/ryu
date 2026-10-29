import { z } from "zod";
import type { RunSummary } from "@/src/hooks/useRuns.ts";
import { type ApiTarget, apiUrl, makeHeaders } from "./api/client.ts";
import {
	runSnapshotInputSchema,
	runSummarySchema,
} from "./api/run-wire-contracts.ts";

export const RECONNECT_RETRY_PLUGIN_ID = "@ryu/reconnect-retry";
export const RECONNECT_RETRY_FEATURE_KIND = "reconnect-retry";
export const CHAT_RETRY_STARTED_EVENT = "ryu:chat-retry-started";
export const CHAT_RECOVERY_STOP_EVENT = "ryu:chat-recovery-stop";
export const CHAT_TURN_STARTED_EVENT = "ryu:chat-turn-started";

export const RECONNECT_RETRY_TTL_MS = 30 * 60 * 1000;
export const RECONNECT_RETRY_MAX_ATTEMPTS = 1;

export interface RetryCandidate {
	attempts: number;
	capturedAt: number;
	conversationId: string;
}

export interface RetrySelection {
	retained: RetryCandidate[];
	retry: RetryCandidate[];
}

export interface StoppedConversation {
	capturedAt: number;
	conversationId: string;
}

const stoppedHistorySchema = z.array(z.unknown());
type StoppedHistoryInput = Parameters<typeof stoppedHistorySchema.parse>[0];
const stoppedConversationSchema = z.object({
	conversationId: z.string().refine((id) => id.trim().length > 0),
	capturedAt: z.number(),
}) satisfies z.ZodType<StoppedConversation>;
const retryCandidateSchema = stoppedConversationSchema.extend({
	attempts: z.number().refine((value) => Number.isInteger(value) && value >= 0),
}) satisfies z.ZodType<RetryCandidate>;
// Saved queues historically reject a null row as a whole; invalid non-null rows
// are individually skipped. Keep that durable fallback while decoding records.
const savedRetryQueueSchema = z.array(
	z.unknown().refine((value) => value !== null && value !== undefined)
);

export function normalizeStoppedConversations(
	value: StoppedHistoryInput,
	now = Date.now()
): StoppedConversation[] {
	const history = stoppedHistorySchema.safeParse(value);
	if (!history.success) {
		return [];
	}
	const records = new Map<string, StoppedConversation>();
	for (const entry of history.data) {
		const parsed = stoppedConversationSchema.safeParse(entry);
		if (
			!parsed.success ||
			parsed.data.capturedAt > now ||
			now - parsed.data.capturedAt > RECONNECT_RETRY_TTL_MS
		) {
			continue;
		}
		const record = parsed.data;
		const previous = records.get(record.conversationId);
		if (!previous || previous.capturedAt < record.capturedAt) {
			records.set(record.conversationId, {
				conversationId: record.conversationId,
				capturedAt: record.capturedAt,
			});
		}
	}
	return [...records.values()];
}

/** Null means storage is unavailable, so the hook retains its memory fallback. */
export function loadStoppedConversations(
	storageKey: string
): StoppedConversation[] | null {
	try {
		const raw = localStorage.getItem(`${storageKey}:stopped`);
		return raw ? normalizeStoppedConversations(JSON.parse(raw)) : [];
	} catch {
		return null;
	}
}

export function saveStoppedConversations(
	storageKey: string,
	records: readonly StoppedConversation[]
): boolean {
	try {
		const normalized = normalizeStoppedConversations(records);
		if (normalized.length === 0) {
			localStorage.removeItem(`${storageKey}:stopped`);
		} else {
			localStorage.setItem(`${storageKey}:stopped`, JSON.stringify(normalized));
		}
		return true;
	} catch {
		return false;
	}
}

/** Keep only safe, recent candidate records from local storage. */
export function normalizeRetryCandidates(
	candidates: readonly RetryCandidate[],
	now = Date.now()
): RetryCandidate[] {
	const byConversation = new Map<string, RetryCandidate>();
	for (const value of candidates) {
		const parsed = retryCandidateSchema.safeParse(value);
		if (
			!parsed.success ||
			parsed.data.capturedAt > now ||
			now - parsed.data.capturedAt > RECONNECT_RETRY_TTL_MS
		) {
			continue;
		}
		const candidate = parsed.data;
		const previous = byConversation.get(candidate.conversationId);
		if (!previous || candidate.capturedAt > previous.capturedAt) {
			byConversation.set(candidate.conversationId, {
				conversationId: candidate.conversationId,
				capturedAt: candidate.capturedAt,
				attempts: candidate.attempts,
			});
		}
	}
	return [...byConversation.values()];
}

/** Add currently running chats to the outage queue without duplicating ids. */
export function mergeOutageCandidates(
	existing: readonly RetryCandidate[],
	runs: readonly Pick<RunSummary, "id" | "run_status">[],
	now = Date.now()
): RetryCandidate[] {
	const byConversation = new Map(
		normalizeRetryCandidates(existing, now).map((candidate) => [
			candidate.conversationId,
			candidate,
		])
	);
	for (const run of runs) {
		if (run.run_status !== "running" || run.id.trim().length === 0) {
			continue;
		}
		if (!byConversation.has(run.id)) {
			byConversation.set(run.id, {
				conversationId: run.id,
				capturedAt: now,
				attempts: 0,
			});
		}
	}
	return [...byConversation.values()];
}

/**
 * Match outage candidates against Core's fresh run snapshot. A still-running
 * chat is retained for normal stream resume; only a terminal run is retried.
 */
export function selectPendingRetries(
	candidates: readonly RetryCandidate[],
	runs: readonly Pick<RunSummary, "id" | "run_status">[],
	now = Date.now()
): RetrySelection {
	const normalized = normalizeRetryCandidates(candidates, now);
	const byConversation = new Map(runs.map((run) => [run.id, run]));
	const retry: RetryCandidate[] = [];
	const retained: RetryCandidate[] = [];

	for (const candidate of normalized) {
		const run = byConversation.get(candidate.conversationId);
		if (!run) {
			continue;
		}
		if (run.run_status === "running") {
			retained.push(candidate);
			continue;
		}
		if (
			(run.run_status === "failed" || run.run_status === "interrupted") &&
			candidate.attempts < RECONNECT_RETRY_MAX_ATTEMPTS
		) {
			retry.push({ ...candidate, attempts: candidate.attempts + 1 });
		}
	}

	return { retry, retained };
}

/** The node-local storage namespace used by the enabled plugin. */
export function reconnectRetryStorageKey(nodeUrl: string): string {
	return `ryu:reconnect-retry:${nodeUrl}`;
}

export function loadRetryCandidates(storageKey: string): RetryCandidate[] {
	try {
		const raw = localStorage.getItem(storageKey);
		if (!raw) {
			return [];
		}
		const parsed = savedRetryQueueSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			return [];
		}
		const candidates = parsed.data.flatMap((value) => {
			const candidate = retryCandidateSchema.safeParse(value);
			return candidate.success ? [candidate.data] : [];
		});
		return normalizeRetryCandidates(candidates);
	} catch {
		return [];
	}
}

export function saveRetryCandidates(
	storageKey: string,
	candidates: readonly RetryCandidate[]
): void {
	try {
		if (candidates.length === 0) {
			localStorage.removeItem(storageKey);
			return;
		}
		localStorage.setItem(storageKey, JSON.stringify(candidates));
	} catch {
		// A disabled/private storage area should not stop chat recovery.
	}
}

export async function fetchRuns(target: ApiTarget): Promise<RunSummary[]> {
	const response = await fetch(apiUrl(target, "/api/runs"), {
		headers: makeHeaders(target.token, target.userJwt),
	});
	if (!response.ok) {
		throw new Error(`run snapshot failed: ${response.status}`);
	}
	const payload = runSnapshotInputSchema.safeParse(await response.json());
	if (!payload.success) {
		return [];
	}
	return (payload.data.runs ?? []).flatMap((value) => {
		const run = runSummarySchema.safeParse(value);
		return run.success ? [run.data] : [];
	});
}

export async function retryConversation(
	target: ApiTarget,
	conversationId: string
): Promise<void> {
	const response = await fetch(
		apiUrl(target, `/api/chat/retry/${encodeURIComponent(conversationId)}`),
		{
			body: JSON.stringify({ reason: "network_reconnect" }),
			headers: makeHeaders(target.token, target.userJwt),
			method: "POST",
		}
	);
	if (!response.ok) {
		throw new Error(`chat retry rejected: ${response.status}`);
	}
}
