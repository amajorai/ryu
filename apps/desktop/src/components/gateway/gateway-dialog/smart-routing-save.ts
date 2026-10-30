import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import type {
	GatewayRoutingConfig,
	ModelRouterType,
	SmartRoutingConfig,
} from "@/src/lib/api/gateway.ts";
import { parsePoolList } from "@/src/lib/api/gateway.ts";
import type { RuleRow } from "./classify-tier.tsx";

/**
 * Why the smart-routing rules cannot be saved as typed, or null when they can.
 * Mirrors the checks `SmartRoutingCard`'s save runs before it writes anything.
 */
export function smartRoutingRulesError(
	rules: RuleRow[],
	routerType: ModelRouterType
): string | null {
	const ruleEditorVisible =
		routerType === "random" || routerType === "llm_classifier";
	const hasInvalidRule =
		ruleEditorVisible &&
		rules.some((rule) => {
			const weight = Number(rule.weight);
			return (
				(routerType !== "random" && !rule.description.trim()) ||
				!rule.model.trim() ||
				!Number.isFinite(weight) ||
				(routerType === "random" ? weight <= 0 : weight < 0)
			);
		});
	if (hasInvalidRule) {
		return "Complete or remove each incomplete rule. Classifier rules need a description and model. Random targets need a model and positive weight.";
	}
	if (
		routerType === "random" &&
		rules.filter((rule) => {
			const weight = Number(rule.weight);
			return rule.model.trim() && Number.isFinite(weight) && weight > 0;
		}).length < 2
	) {
		return "Weighted random needs at least two targets with positive weights. Add a target before saving.";
	}
	return null;
}

/**
 * The `smart_routing` section `SmartRoutingCard` writes back: the draft with its
 * blanks resolved, the rules cleaned and the pools parsed. Agent pools and
 * routes come from the FRESH config (`fresh`), not the card's draft.
 */
export function buildSmartRoutingConfig({
	draft,
	fresh,
	poolModels,
	poolProviders,
	routerType,
	rules,
}: {
	draft: SmartRoutingConfig;
	fresh: GatewayRoutingConfig["smart_routing"];
	poolModels: string;
	poolProviders: string;
	routerType: ModelRouterType;
	rules: RuleRow[];
}): SmartRoutingConfig {
	const cleanRules = rules
		.map((r) => ({
			description: r.description.trim(),
			model: r.model.trim(),
			weight: Number(r.weight),
		}))
		.filter(
			(r) =>
				(routerType === "random" || r.description) &&
				r.model &&
				Number.isFinite(r.weight) &&
				r.weight >= 0
		);
	const defaultModel = draft.default_model?.trim();
	const escalationConfirmations = draft.escalation_confirmations;
	const smart_routing: SmartRoutingConfig = {
		...draft,
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
		allowed_models: parsePoolList(poolModels),
		allowed_providers: parsePoolList(poolProviders),
		// Agent pools and overrides are edited per agent, so take them from
		// the fresh config rather than this card's possibly stale draft.
		agent_pools: fresh?.agent_pools ?? draft.agent_pools ?? {},
		agent_routes: fresh?.agent_routes ?? draft.agent_routes ?? {},
	};
	return smart_routing;
}
