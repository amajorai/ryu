// apps/desktop/src/lib/api/quests.ts
//
// Typed client for the Core quests API (`/api/quests/*`): the auto-detecting
// todo list. Field names are snake_case to match Core's serde shapes exactly.
// The event SSE stream uses fetch + ReadableStream (not EventSource) so the
// bearer token can be attached, mirroring the monitors alert stream.

import { type ApiTarget, request } from "./client.ts";
import { streamChannel } from "./eventStream.ts";

export type QuestStatus = "open" | "done" | "dismissed";
export type CompletionSource = "manual" | "detected";
export type DetectionMode = "off" | "suggest" | "auto_high" | "auto_all";

export interface Suggestion {
	confidence: number;
	evidence?: string | null;
	reason: string;
	suggested_at: string;
}

export interface Quest {
	completed_at?: string | null;
	completion_condition: string;
	completion_source?: CompletionSource | null;
	created_at: string;
	detail?: string | null;
	id: string;
	last_judged_at?: string | null;
	snoozed_until?: string | null;
	status: QuestStatus;
	suggestion?: Suggestion | null;
	title: string;
	updated_at: string;
}

export interface QuestInput {
	completion_condition: string;
	detail?: string | null;
	title: string;
}

export interface DetectionConfig {
	effort: string;
	interval: string;
	mode: DetectionMode;
	model: string;
}

// Internally-tagged union mirroring Core's `QuestEvent` (`{ "type": ... }`).
export type QuestEvent =
	| { type: "suggested"; quest: Quest; confidence: number; reason: string }
	| { type: "completed"; quest: Quest; auto: boolean }
	| { type: "updated"; quest: Quest }
	| { type: "deleted"; id: string };

export async function listQuests(target: ApiTarget): Promise<Quest[]> {
	const json = await request<{ quests?: Quest[] }>(target, "/api/quests");
	return json.quests ?? [];
}

export async function createQuest(
	target: ApiTarget,
	data: QuestInput
): Promise<Quest> {
	const json = await request<{ quest?: Quest; error?: string }>(
		target,
		"/api/quests",
		{ method: "POST", body: data }
	);
	if (!json.quest) {
		throw new Error(json.error ?? "failed to create quest");
	}
	return json.quest;
}

export async function updateQuest(
	target: ApiTarget,
	id: string,
	data: QuestInput
): Promise<Quest> {
	const json = await request<{ quest?: Quest; error?: string }>(
		target,
		`/api/quests/${id}`,
		{ method: "PUT", body: data }
	);
	if (!json.quest) {
		throw new Error(json.error ?? "failed to update quest");
	}
	return json.quest;
}

export async function deleteQuest(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(target, `/api/quests/${id}`, { method: "DELETE" });
}

export async function completeQuest(
	target: ApiTarget,
	id: string
): Promise<Quest> {
	return await mutateQuest(target, `/api/quests/${id}/complete`);
}

export async function dismissQuest(
	target: ApiTarget,
	id: string
): Promise<Quest> {
	return await mutateQuest(target, `/api/quests/${id}/dismiss`);
}

export async function acceptSuggestion(
	target: ApiTarget,
	id: string
): Promise<Quest> {
	return await mutateQuest(target, `/api/quests/${id}/suggestion/accept`);
}

export async function dismissSuggestion(
	target: ApiTarget,
	id: string
): Promise<Quest> {
	return await mutateQuest(target, `/api/quests/${id}/suggestion/dismiss`);
}

async function mutateQuest(target: ApiTarget, path: string): Promise<Quest> {
	const json = await request<{ quest?: Quest; error?: string }>(target, path, {
		method: "POST",
	});
	if (!json.quest) {
		throw new Error(json.error ?? "quest update failed");
	}
	return json.quest;
}

export interface JudgeResult {
	confidence?: number;
	met?: boolean;
	reason?: string;
	skipped?: boolean;
}

export async function judgeQuest(
	target: ApiTarget,
	id: string
): Promise<JudgeResult> {
	return await request<JudgeResult>(target, `/api/quests/${id}/judge`, {
		method: "POST",
	});
}

export async function getDetectionConfig(
	target: ApiTarget
): Promise<DetectionConfig> {
	return await request<DetectionConfig>(target, "/api/quests/detection-config");
}

export async function setDetectionConfig(
	target: ApiTarget,
	data: Partial<DetectionConfig>
): Promise<void> {
	await request(target, "/api/quests/detection-config", {
		method: "PUT",
		body: data,
	});
}

/**
 * Subscribe to quest events and invoke `onEvent` for every event. Resolves when
 * `signal` aborts. Shares the single multiplexed node connection
 * (`/api/events/all`, see eventStream.ts) instead of its own HTTP socket.
 */
export function streamQuestEvents(
	target: ApiTarget,
	onEvent: (event: QuestEvent) => void,
	signal?: AbortSignal
): Promise<void> {
	return streamChannel(target, "quests", onEvent, signal);
}
