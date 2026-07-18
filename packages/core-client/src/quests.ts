// Shared typed client for the Core quests API (`/api/quests/*`): the
// auto-detecting todo list. Field names are snake_case to match Core's serde
// shapes exactly (the Rust structs use no rename). This mirrors the desktop
// `apps/desktop/src/lib/api/quests.ts` client, minus the SSE event stream (the
// plugin-host bridge services CRUD only), so any surface on `@ryuhq/core-client`
// — native included — can drive the `com.ryu.quests` companion host-direct.

import { type ApiTarget, request } from "./client.ts";

export type QuestStatus = "open" | "done" | "dismissed";
export type CompletionSource = "manual" | "detected";

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

export interface JudgeResult {
	confidence?: number;
	met?: boolean;
	reason?: string;
	skipped?: boolean;
}

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

async function mutateQuest(target: ApiTarget, path: string): Promise<Quest> {
	const json = await request<{ quest?: Quest; error?: string }>(target, path, {
		method: "POST",
	});
	if (!json.quest) {
		throw new Error(json.error ?? "quest update failed");
	}
	return json.quest;
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

export async function judgeQuest(
	target: ApiTarget,
	id: string
): Promise<JudgeResult> {
	return await request<JudgeResult>(target, `/api/quests/${id}/judge`, {
		method: "POST",
	});
}
