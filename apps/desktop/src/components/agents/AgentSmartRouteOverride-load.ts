// apps/desktop/src/components/agents/AgentSmartRouteOverride-load.ts
//
// Loading and save-error copy for the per-agent smart-route override (see the
// module comment in AgentSmartRouteOverride.tsx).

import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchAgentRouteOverride,
	type SmartRoutingConfig,
	SmartRoutingUnavailableError,
} from "@/src/lib/api/gateway.ts";
import { getAgentSmartRoute } from "@/src/lib/api/preferences.ts";

export interface RuleRow {
	description: string;
	id: string;
	model: string;
	weight: string;
}

export const SAVE_FAILED_COPY =
	"The save failed. Your draft is still here; check the connection and retry.";

/**
 * The agent's override as stored on the gateway, else its legacy Core
 * preference entry (see the module comment). `legacy` says whether a Core copy
 * exists that saving must retire.
 */
export async function loadOverride(
	target: ApiTarget,
	agentId: string
): Promise<{ config: SmartRoutingConfig | null; legacy: boolean }> {
	const [stored, legacy] = await Promise.all([
		fetchAgentRouteOverride(target, agentId),
		// An unreadable legacy preference must not hide the gateway's entry.
		getAgentSmartRoute(target, agentId).catch(() => null),
	]);
	return { config: stored ?? legacy, legacy: legacy !== null };
}
export function saveErrorCopy(error: unknown): string {
	if (error instanceof SmartRoutingUnavailableError) {
		return "This node's gateway does not report smart routing, so it cannot store a per-agent override. Update the node to use this setting.";
	}
	if (error instanceof ApiError && error.status === 403) {
		return "This node denied the change. Per-agent routing needs the gateway.configure permission. Your draft is still here.";
	}
	return SAVE_FAILED_COPY;
}

/** The override as saved: trimmed rules (incomplete ones dropped) and every
 *  numeric knob clamped back to its default when the draft holds a bad value. */
export function buildSmartRoutingConfig(
	draft: SmartRoutingConfig,
	rules: RuleRow[]
): SmartRoutingConfig {
	const cleanRules = rules
		.map((r) => ({
			description: r.description.trim(),
			model: r.model.trim(),
			weight: r.weight.trim() === "" ? 1 : Number(r.weight),
		}))
		.filter(
			(r) =>
				((draft.router_type ?? "llm_classifier") === "random" ||
					r.description) &&
				r.model &&
				Number.isFinite(r.weight) &&
				r.weight >= 0
		);
	const defaultModel = draft.default_model?.trim();
	const escalationConfirmations = draft.escalation_confirmations;
	const config: SmartRoutingConfig = {
		...draft,
		enabled: true,
		router_type: draft.router_type ?? "llm_classifier",
		strategy: draft.strategy ?? "llm",
		classifier_model: draft.classifier_model.trim(),
		embedding_model: draft.embedding_model?.trim() ?? "",
		similarity_threshold: Number.isFinite(draft.similarity_threshold)
			? draft.similarity_threshold
			: 0.35,
		random_seed:
			draft.random_seed === null || draft.random_seed === undefined
				? null
				: Number.isSafeInteger(draft.random_seed) && draft.random_seed >= 0
					? draft.random_seed
					: null,
		stage_capable_model: draft.stage_capable_model?.trim() ?? "",
		stage_efficient_model: draft.stage_efficient_model?.trim() ?? "",
		stage_picker: draft.stage_picker ?? "capable_first",
		stage_confidence_threshold: Number.isFinite(
			draft.stage_confidence_threshold
		)
			? draft.stage_confidence_threshold
			: 0.5,
		stage_recent_message_window: Number.isInteger(
			draft.stage_recent_message_window
		)
			? draft.stage_recent_message_window
			: 3,
		escalation_weak_model: draft.escalation_weak_model?.trim() ?? "",
		escalation_strong_model: draft.escalation_strong_model?.trim() ?? "",
		escalation_judge_model: draft.escalation_judge_model?.trim() ?? "",
		escalation_confirmations:
			isNativeNumber(escalationConfirmations) &&
			Number.isInteger(escalationConfirmations) &&
			escalationConfirmations >= 1
				? escalationConfirmations
				: 2,
		escalation_recent_message_window: Number.isInteger(
			draft.escalation_recent_message_window
		)
			? draft.escalation_recent_message_window
			: 28,
		escalation_message_chars: Number.isInteger(draft.escalation_message_chars)
			? draft.escalation_message_chars
			: 500,
		rules: cleanRules,
		default_model: defaultModel ? defaultModel : null,
	};
	return config;
}
