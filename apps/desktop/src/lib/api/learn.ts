import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
// apps/desktop/src/lib/api/learn.ts
//
// Typed client for Core's continual-learning surface (`/api/learn/*` +
// `/api/experience/*`). Field names are snake_case to match Core's serde shapes.
// The heavy training path (sweep/score/cycle) stays server-driven and opt-in;
// the desktop only needs to (a) trigger an explicit skill synthesis from a chat
// and (b) read the loop's state for the read-only Learning page.

import { type ApiTarget, request } from "./client.ts";

/** Resolved, client-safe learning config (mirrors Core's `LearningConfig`). */
export interface LearningConfig {
	base_model: string | null;
	enabled: boolean;
	min_reward: number;
	prm_model: string;
	prm_via_byo: boolean;
	skill_generation: number;
	skills_enabled: boolean;
	synth_model: string;
}

/** One captured turn in the experience buffer (mirrors Core's `Experience`). */
export interface Experience {
	agent_id: string | null;
	assistant_text: string;
	base_model: string | null;
	conversation_id: string;
	excluded: boolean;
	id: string;
	outcome: string;
	reward: number | null;
	skill_generation: number;
	user_text: string;
}

export interface ExperienceList {
	experiences: Experience[];
	min_reward: number;
	scored: number;
	total: number;
	trainable: number;
}

/** The outcome of a synthesis request (mirrors Core's `SynthOutcome`). */
export interface SynthOutcome {
	created: boolean;
	reason: string;
	slug: string | null;
}

/** Read the current learning config (both opt-ins, models, skill generation). */
export function getLearningConfig(target: ApiTarget): Promise<LearningConfig> {
	return request<LearningConfig>(
		target,
		"/api/learn/config",
		undefined,
		learningConfigResponseCodec
	);
}

/** Read the experience buffer + its scored/trainable counts. */
export function listExperience(target: ApiTarget): Promise<ExperienceList> {
	return request<ExperienceList>(
		target,
		"/api/experience/list",
		undefined,
		experienceListResponseCodec
	);
}

/** Read whether one conversation is excluded from capture and synthesis. */
export function getConversationLearningExclusion(
	target: ApiTarget,
	conversationId: string
): Promise<{ conversation_id: string; excluded: boolean }> {
	return request(
		target,
		`/api/learn/exclude/${encodeURIComponent(conversationId)}`,
		undefined,
		responseCodec1
	);
}

/** Persist the per-conversation learning exclusion and update buffered rows. */
export function setConversationLearningExclusion(
	target: ApiTarget,
	conversationId: string,
	excluded: boolean
): Promise<{
	conversation_id: string;
	excluded: boolean;
	rows_updated: number;
}> {
	return request(
		target,
		"/api/learn/exclude",
		{
			method: "POST",
			body: { conversation_id: conversationId, excluded },
		},
		responseCodec2
	);
}

/**
 * Distill a skill from a specific conversation right now. `force: true` is a
 * deliberate user action ("make a skill from this chat"), so it bypasses the
 * skills opt-in — but never the inbox-approval gate: an activated skill is
 * node-global context, so the proposal lands in the approval inbox (the outcome's
 * `reason` says so) unless the user disabled `learning.require-approval`.
 */
export function synthesizeSkill(
	target: ApiTarget,
	conversationId: string
): Promise<SynthOutcome> {
	return request<SynthOutcome>(
		target,
		"/api/learn/synthesize",
		{
			method: "POST",
			body: { conversation_id: conversationId, force: true },
		},
		synthOutcomeResponseCodec
	);
}

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
const learningConfigResponseCodec = z
	.object({
		base_model: z.union([z.string(), z.null()]),
		enabled: z.boolean(),
		min_reward: z.number(),
		prm_model: z.string(),
		prm_via_byo: z.boolean(),
		skill_generation: z.number(),
		skills_enabled: z.boolean(),
		synth_model: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const experienceResponseCodec = z
	.object({
		agent_id: z.union([z.string(), z.null()]),
		assistant_text: z.string(),
		base_model: z.union([z.string(), z.null()]),
		conversation_id: z.string(),
		excluded: z.boolean(),
		id: z.string(),
		outcome: z.string(),
		reward: z.union([z.number(), z.null()]),
		skill_generation: z.number(),
		user_text: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const experienceListResponseCodec = z
	.object({
		experiences: z.array(experienceResponseCodec),
		min_reward: z.number(),
		scored: z.number(),
		total: z.number(),
		trainable: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec1 = z
	.object({ conversation_id: z.string(), excluded: z.boolean() })
	.catchall(gatewayJsonValueSchema);
const responseCodec2 = z
	.object({
		conversation_id: z.string(),
		excluded: z.boolean(),
		rows_updated: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
const synthOutcomeResponseCodec = z
	.object({
		created: z.boolean(),
		reason: z.string(),
		slug: z.union([z.string(), z.null()]),
	})
	.catchall(gatewayJsonValueSchema);
