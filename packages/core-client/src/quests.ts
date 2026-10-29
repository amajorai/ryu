// Shared typed client for the Core quests API (`/api/quests/*`): the
// auto-detecting todo list. Field names are snake_case to match Core's serde
// shapes exactly (the Rust structs use no rename). This mirrors the desktop
// `apps/desktop/src/lib/api/quests.ts` client, minus the SSE event stream (the
// plugin-host bridge services CRUD only), so any surface on `@ryuhq/core-client`
// — native included — can drive the `@ryu/quests` companion host-direct.

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";
import { encodePathId } from "./path-id.ts";

export type QuestStatus = "open" | "done" | "dismissed";
export type CompletionSource = "manual" | "detected";
/** What a board item IS. Only `task` is judged on the detection schedule; the
 *  rest are captures — things kept while working. */
export type QuestKind = "task" | "note" | "link" | "prompt" | "snippet";

export interface Suggestion {
	confidence: number;
	evidence?: string | null;
	reason: string;
	suggested_at: string;
}

/** Where a capture came from, so a kept snippet is never an orphan quote. */
export interface CaptureSource {
	app?: string | null;
	title?: string | null;
	url?: string | null;
}

export interface Quest {
	body?: string | null;
	completed_at?: string | null;
	completion_condition: string;
	completion_source?: CompletionSource | null;
	created_at: string;
	detail?: string | null;
	id: string;
	kind?: QuestKind;
	last_judged_at?: string | null;
	pinned?: boolean;
	snoozed_until?: string | null;
	source?: CaptureSource | null;
	status: QuestStatus;
	suggestion?: Suggestion | null;
	title: string;
	updated_at: string;
	used_at?: string | null;
}

/** The capture payload. Only `body` is required — the kind and the title are
 *  inferred server-side from the body when absent. */
export interface CaptureInput {
	body: string;
	kind?: QuestKind;
	source?: CaptureSource;
	title?: string;
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

// All seventeen native Quest fields, including capture and detection state.
function questResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const questCaptureSource = questResponse(
	z.object({
		app: z.string().nullish(),
		title: z.string().nullish(),
		url: z.string().nullish(),
	})
);
const questSuggestion = questResponse(
	z.object({
		confidence: z.number(),
		evidence: z.string().nullish(),
		reason: z.string(),
		suggested_at: z.string(),
	})
);
export const questResponseSchema = questResponse(
	z.object({
		id: z.string(),
		title: z.string(),
		kind: z.enum(["task", "note", "link", "prompt", "snippet"]).optional(),
		body: z.string().nullish(),
		source: questCaptureSource.nullish(),
		used_at: z.string().nullish(),
		pinned: z.boolean().optional(),
		detail: z.string().nullish(),
		completion_condition: z.string(),
		status: z.enum(["open", "done", "dismissed"]),
		created_at: z.string(),
		updated_at: z.string(),
		completed_at: z.string().nullish(),
		completion_source: z.enum(["manual", "detected"]).nullish(),
		last_judged_at: z.string().nullish(),
		snoozed_until: z.string().nullish(),
		suggestion: questSuggestion.nullish(),
	})
);
const questListResponse = questResponse(
	z.object({
		quests: z.array(questResponseSchema).nullish(),
		error: z.string().optional(),
	})
);
const questEnvelopeResponse = questResponse(
	z.object({
		quest: questResponseSchema.nullish(),
		error: z.string().optional(),
	})
);
const questScratchpadResponse = questResponse(
	z.object({ text: z.string().nullish(), error: z.string().optional() })
);
const questOkResponse = questResponse(z.object({ ok: z.boolean() }));
export const questJudgeResponseSchema = questResponse(
	z.union([
		z.object({ met: z.boolean(), confidence: z.number(), reason: z.string() }),
		z.object({ skipped: z.literal(true), reason: z.string() }),
	])
);

export async function listQuests(
	target: ApiTarget,
	kind?: QuestKind
): Promise<Quest[]> {
	const path = kind
		? `/api/quests?kind=${encodeURIComponent(kind)}`
		: "/api/quests";
	const json = await request(target, path, {}, questListResponse);
	return json.quests ?? [];
}

/** Keep something grabbed while working (`POST /api/quests/capture`). */
export async function captureQuest(
	target: ApiTarget,
	data: CaptureInput
): Promise<Quest> {
	const json = await request(
		target,
		"/api/quests/capture",
		{ method: "POST", body: data },
		questEnvelopeResponse
	);
	if (!json.quest) {
		throw new Error(json.error ?? "failed to capture");
	}
	return json.quest;
}

/** Record that an item was copied back out, optionally checking it off. */
export async function useQuest(
	target: ApiTarget,
	id: string,
	complete = false
): Promise<Quest> {
	return await mutateQuest(target, `/api/quests/${id}/use`, { complete });
}

/** Pin or unpin an item to the top of the board. */
export async function pinQuest(
	target: ApiTarget,
	id: string,
	pinned: boolean
): Promise<Quest> {
	return await mutateQuest(target, `/api/quests/${id}/pin`, { pinned });
}

/** The freeform brain-dump buffer. */
export async function getScratchpad(target: ApiTarget): Promise<string> {
	const json = await request(
		target,
		"/api/quests/scratchpad",
		{},
		questScratchpadResponse
	);
	return json.text ?? "";
}

/** Overwrite the brain-dump buffer. */
export async function setScratchpad(
	target: ApiTarget,
	text: string
): Promise<void> {
	await request(
		target,
		"/api/quests/scratchpad",
		{
			method: "PUT",
			body: { text },
		},
		questOkResponse
	);
}

export async function createQuest(
	target: ApiTarget,
	data: QuestInput
): Promise<Quest> {
	const json = await request(
		target,
		"/api/quests",
		{ method: "POST", body: data },
		questEnvelopeResponse
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
	const json = await request(
		target,
		`/api/quests/${id}`,
		{ method: "PUT", body: data },
		questEnvelopeResponse
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
	await request(
		target,
		`/api/quests/${id}`,
		{ method: "DELETE" },
		questOkResponse
	);
}

type QuestMutationBody =
	| { complete: Parameters<typeof useQuest>[2] }
	| { pinned: Parameters<typeof pinQuest>[2] };

async function mutateQuest(
	target: ApiTarget,
	path: string,
	body?: QuestMutationBody
): Promise<Quest> {
	const options: NonNullable<Parameters<typeof request>[2]> = {
		method: "POST",
	};
	if (body) {
		options.body = body;
	}
	const json = await request(target, path, options, questEnvelopeResponse);
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

const shadowEvidenceSchema = z.object({
	available: z.boolean().optional(),
	error: z.string().optional(),
	entries: z.array(appResponseValueSchema).optional(),
	results: z.array(appResponseValueSchema).optional(),
});

/** Read capture evidence through the active node's authenticated proxy. This runs
 * with the user's existing credentials, never a sidecar's service secret. */
async function questJudgeContext(
	target: ApiTarget,
	id: string
): Promise<string | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		const { quest } = await request(
			target,
			`/api/quests/${encodePathId(id)}`,
			{ signal: controller.signal },
			questEnvelopeResponse
		);
		if (quest?.status !== "open" || (quest.kind && quest.kind !== "task")) {
			return undefined;
		}
		const condition = quest.completion_condition.trim() || quest.title;
		const reads = await Promise.allSettled([
			request(
				target,
				"/api/shadow/context/recent?q=10",
				{ signal: controller.signal },
				shadowEvidenceSchema
			),
			request(
				target,
				`/api/shadow/search/semantic?q=${encodeURIComponent(condition)}&limit=5`,
				{ signal: controller.signal },
				shadowEvidenceSchema
			),
		]);
		const parts: string[] = [];
		for (const [index, read] of reads.entries()) {
			if (
				read.status !== "fulfilled" ||
				read.value.error ||
				read.value.available === false
			) {
				continue;
			}
			const entries = index === 0 ? read.value.entries : read.value.results;
			if (!entries?.length) {
				continue;
			}
			parts.push(
				`${index === 0 ? "Recent activity" : "Related history"}:\n${JSON.stringify(entries)}`
			);
		}
		return parts.length ? parts.join("\n\n").slice(0, 16_000) : undefined;
	} finally {
		clearTimeout(timer);
	}
}

export async function judgeQuest(
	target: ApiTarget,
	id: string
): Promise<JudgeResult> {
	const context = await questJudgeContext(target, id);
	return await request(
		target,
		`/api/quests/${encodePathId(id)}/judge`,
		{
			method: "POST",
			body: context ? { context } : {},
		},
		questJudgeResponseSchema
	);
}
