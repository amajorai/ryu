import { z } from "zod";
import {
	type GatewayJsonValue,
	gatewayJsonValueSchema,
} from "./gateway-json-contracts.ts";
// apps/desktop/src/lib/api/quests.ts
//
// Typed client for the Core quests API (`/api/quests/*`): the auto-detecting
// todo list. Field names are snake_case to match Core's serde shapes exactly.
// The event SSE stream uses fetch + ReadableStream (not EventSource) so the
// bearer token can be attached, mirroring the monitors alert stream.

import {
	type CaptureInput,
	type JudgeResult,
	judgeQuest as judgeQuestWithEvidence,
	type Quest,
	type QuestInput,
	type QuestKind,
	questResponseSchema,
} from "@ryuhq/core-client/quests";
import { type ApiTarget, authenticatedFetch, request } from "./client.ts";
import { streamChannel } from "./eventStream.ts";
import { encodePathId } from "./path-id.ts";

export type {
	CaptureInput,
	CaptureSource,
	CompletionSource,
	JudgeResult,
	Quest,
	QuestInput,
	QuestKind,
	QuestStatus,
	Suggestion,
} from "@ryuhq/core-client/quests";

export type DetectionMode = "off" | "suggest" | "auto_high" | "auto_all";

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

const questEventFields = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("suggested"),
		quest: questResponseSchema,
		confidence: z.number().int().min(0).max(255),
		reason: z.string(),
	}),
	z.object({
		type: z.literal("completed"),
		quest: questResponseSchema,
		auto: z.boolean(),
	}),
	z.object({ type: z.literal("updated"), quest: questResponseSchema }),
	z.object({ type: z.literal("deleted"), id: z.string() }),
]);
const questEventSchema = z.custom<z.output<typeof questEventFields>>(
	(value) => questEventFields.safeParse(value).success
);

const questListSchema = z
	.object({ quests: z.array(questResponseSchema).optional() })
	.passthrough();
const questEnvelopeSchema = z
	.object({
		quest: questResponseSchema.optional(),
		error: z.string().optional(),
	})
	.passthrough();
const scratchpadSchema = z
	.object({ text: z.string().optional() })
	.passthrough();
const detectionConfigSchema = z
	.object({
		effort: z.string(),
		interval: z.string(),
		mode: z.enum(["off", "suggest", "auto_high", "auto_all"]),
		model: z.string(),
	})
	.passthrough();

export async function listQuests(
	target: ApiTarget,
	kind?: QuestKind
): Promise<Quest[]> {
	const path = kind
		? `/api/quests?kind=${encodeURIComponent(kind)}`
		: "/api/quests";
	const json = await request(target, path, undefined, questListSchema);
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
		questEnvelopeSchema
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
	return await mutateQuest(target, `/api/quests/${encodePathId(id)}/use`, {
		complete,
	});
}

/** Pin or unpin an item to the top of the board. */
export async function pinQuest(
	target: ApiTarget,
	id: string,
	pinned: boolean
): Promise<Quest> {
	return await mutateQuest(target, `/api/quests/${encodePathId(id)}/pin`, {
		pinned,
	});
}

/** The freeform brain-dump buffer. */
export async function getScratchpad(target: ApiTarget): Promise<string> {
	const json = await request(
		target,
		"/api/quests/scratchpad",
		undefined,
		scratchpadSchema
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
		gatewayJsonValueSchema
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
		questEnvelopeSchema
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
		`/api/quests/${encodePathId(id)}`,
		{ method: "PUT", body: data },
		questEnvelopeSchema
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
		`/api/quests/${encodePathId(id)}`,
		{ method: "DELETE" },
		gatewayJsonValueSchema
	);
}

export async function completeQuest(
	target: ApiTarget,
	id: string
): Promise<Quest> {
	return await mutateQuest(target, `/api/quests/${encodePathId(id)}/complete`);
}

export async function dismissQuest(
	target: ApiTarget,
	id: string
): Promise<Quest> {
	return await mutateQuest(target, `/api/quests/${encodePathId(id)}/dismiss`);
}

export async function acceptSuggestion(
	target: ApiTarget,
	id: string
): Promise<Quest> {
	return await mutateQuest(
		target,
		`/api/quests/${encodePathId(id)}/suggestion/accept`
	);
}

export async function dismissSuggestion(
	target: ApiTarget,
	id: string
): Promise<Quest> {
	return await mutateQuest(
		target,
		`/api/quests/${encodePathId(id)}/suggestion/dismiss`
	);
}

async function mutateQuest(
	target: ApiTarget,
	path: string,
	body?: Record<string, GatewayJsonValue>
): Promise<Quest> {
	const json = await request(
		target,
		path,
		{
			method: "POST",
			...(body ? { body } : undefined),
		},
		questEnvelopeSchema
	);
	if (!json.quest) {
		throw new Error(json.error ?? "quest update failed");
	}
	return json.quest;
}

export async function judgeQuest(
	target: ApiTarget,
	id: string
): Promise<JudgeResult> {
	return await judgeQuestWithEvidence(
		{
			...target,
			fetch: (input, init) => {
				const url = new URL(String(input));
				return authenticatedFetch(target, `${url.pathname}${url.search}`, {
					...init,
					headers: Object.fromEntries(new Headers(init?.headers)),
				});
			},
		},
		id
	);
}

export async function getDetectionConfig(
	target: ApiTarget
): Promise<DetectionConfig> {
	return await request(
		target,
		"/api/quests/detection-config",
		undefined,
		detectionConfigSchema
	);
}

export async function setDetectionConfig(
	target: ApiTarget,
	data: Partial<DetectionConfig>
): Promise<void> {
	await request(
		target,
		"/api/quests/detection-config",
		{
			method: "PUT",
			body: data,
		},
		gatewayJsonValueSchema
	);
}

/**
 * Subscribe to quest events and invoke `onEvent` for every event. Resolves when
 * `signal` aborts. Shares the single multiplexed node connection
 * (`/api/events/all`, see eventStream.ts) instead of its own HTTP socket.
 * `onResync` runs after that connection re-opens, since events emitted while it
 * was down are not replayed.
 */
export function streamQuestEvents(
	target: ApiTarget,
	onEvent: (event: QuestEvent) => void,
	signal?: AbortSignal,
	onResync?: () => void
): Promise<void> {
	return streamChannel(target, "quests", onEvent, signal, questEventSchema, {
		onResync,
	});
}
