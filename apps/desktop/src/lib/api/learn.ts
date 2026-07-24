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
	return request<LearningConfig>(target, "/api/learn/config");
}

/** Read the experience buffer + its scored/trainable counts. */
export function listExperience(target: ApiTarget): Promise<ExperienceList> {
	return request<ExperienceList>(target, "/api/experience/list");
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
	return request<SynthOutcome>(target, "/api/learn/synthesize", {
		method: "POST",
		body: { conversation_id: conversationId, force: true },
	});
}
