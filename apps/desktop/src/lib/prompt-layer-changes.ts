/**
 * Which of a bot's saved settings that Core injects into its system prompt an
 * edit changes. Core assembles the prompt from the bot's instructions, persona
 * name and tone, output style and skills block (see `route_chat_stream` in
 * `apps/core/src/sidecar/adapters/mod.rs`); any change to them is a one-time
 * prompt-cache miss for each of the bot's threads. Settings that do not reach
 * the prompt (avatar, title, tools, model, memory) are deliberately absent:
 * tools and model already have their own cache story (the tool list sits
 * outside the system block; a model switch warns in the composer).
 */

import type { Agent } from "@/src/lib/api/agents.ts";

export interface PromptLayerDraft {
	displayName: string;
	outputStyleId: string | null;
	skills: readonly string[];
	systemPrompt: string | null;
	tone: string | null;
}

function same(left: string | null | undefined, right: string | null): boolean {
	return (left ?? "").trim() === (right ?? "").trim();
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	const seen = new Set(left);
	return right.every((item) => seen.has(item));
}

/** Human labels for the prompt layers this draft changes, in prompt order. */
export function promptLayerChanges(
	saved: Pick<Agent, "persona" | "skills" | "systemPrompt">,
	draft: PromptLayerDraft
): string[] {
	const changed: string[] = [];
	if (!same(saved.persona?.output_style_id, draft.outputStyleId)) {
		changed.push("The personality profile");
	}
	if (!sameSet(saved.skills ?? [], draft.skills)) {
		changed.push("Skills");
	}
	if (
		!(
			same(saved.persona?.display_name, draft.displayName) &&
			same(saved.persona?.tone, draft.tone)
		)
	) {
		changed.push("The name and tone");
	}
	if (!same(saved.systemPrompt, draft.systemPrompt)) {
		changed.push("The instructions");
	}
	return changed;
}
