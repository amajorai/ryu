// The node's configured default model: what a model-consuming feature (evals,
// security sweeps, online scoring, editor AI) runs against when the user has not
// named a model of its own.
//
// Mirrors Core's `agent_selection::resolve_side_model` fallback chain, so the
// desktop pre-fills the same model Core would pick:
//   1. the local-lane default selection's model (`default-local-agent-selection`,
//      edited in the Gateway dialog → Defaults);
//   2. else the model of the agent that selection names;
//   3. else, when the lane is unset, Core's built-in default: the local chat
//      model the node serves (`GET /api/models/active`).
// A blank result means the node genuinely has nothing usable; callers must then
// disable their action and say so rather than silently targeting a hosted
// provider.

import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { getActiveModel } from "@/src/lib/api/models.ts";
import {
	getLaneAgentSelection,
	isAgentSelectionEmpty,
} from "@/src/lib/api/preferences.ts";

/** The node default as an optional agent id plus a concrete model id. */
export interface NodeDefaultModel {
	agentId?: string;
	model: string;
}

/** Shown beside a disabled Run action when no model can be resolved. */
export const NO_DEFAULT_MODEL_HINT =
	"No default model is configured for this node. Set one in Gateway → Default agent & model.";

/** The same hint for a panel that also offers a model-id field. */
export const NO_DEFAULT_MODEL_INPUT_HINT =
	"No default model is configured for this node. Enter a model id, or set one in Gateway → Default agent & model.";

async function builtinLocalModel(target: ApiTarget): Promise<string> {
	const active = await getActiveModel(target).catch(() => null);
	return (active?.active || active?.default || "").trim();
}

/** Resolve the node's default model (see the module comment for the chain). */
export async function resolveNodeDefaultModel(
	target: ApiTarget
): Promise<NodeDefaultModel> {
	const selection = await getLaneAgentSelection(target, "local");
	if (isAgentSelectionEmpty(selection)) {
		return { model: await builtinLocalModel(target) };
	}
	// A selection may name an agent, a bare model, or both. A named model wins —
	// it is the more specific of the two and needs no lookup.
	const agentId = selection.agent_id.trim() || undefined;
	if (selection.model.trim()) {
		return { agentId, model: selection.model.trim() };
	}
	if (!agentId) {
		return { model: "" };
	}
	const agents = await fetchAgents(target).catch(() => []);
	const agent = agents.find((a) => a.id === agentId);
	return { agentId, model: agent?.model?.trim() ?? "" };
}

export interface NodeDefaultModelResult {
	loading: boolean;
	model: string;
}

/** Keep cached defaults within the same node admission credentials. */
export function nodeDefaultModelQueryKey(target: ApiTarget) {
	return [
		"node-default-model",
		target.url,
		target.token ?? null,
		target.userJwt ?? null,
	] as const;
}

/**
 * The node's default model id for `target` ("" until it is confirmed or when none
 * is resolvable). `loading` lets callers avoid flashing the "no model" hint.
 *
 * Two rules, both needed:
 * - An ordinary background refetch (focus, invalidation) or a failed refetch of a
 *   key this hook instance has already seen settle keeps the model, so the field
 *   does not blank and re-enable on every refetch.
 * - A cache entry this instance has not seen settle (first mount, or the target's
 *   credentials/node changed, including returning to previously cached
 *   credentials) is never used while its read is in flight or after it failed:
 *   a node-wide default saved under other credentials leaves it stale, and a
 *   fresh eval run must not target it.
 */
export function useNodeDefaultModel(target: ApiTarget): NodeDefaultModelResult {
	const queryKey = nodeDefaultModelQueryKey(target);
	const { data, isError, isFetching, isPending } = useQuery({
		queryKey,
		queryFn: () => resolveNodeDefaultModel(target),
		// A node-wide default changes about as often as a setting is edited.
		staleTime: 60 * 1000,
	});
	const keyId = JSON.stringify(queryKey);
	const confirmation = useRef<{ keyId: string; confirmed: boolean }>({
		keyId,
		confirmed: false,
	});
	if (confirmation.current.keyId !== keyId) {
		confirmation.current = { keyId, confirmed: false };
	}
	if (data !== undefined && !isFetching && !isError) {
		confirmation.current.confirmed = true;
	}
	const { confirmed } = confirmation.current;
	return {
		loading: isPending || (!confirmed && isFetching),
		model: confirmed ? (data?.model ?? "") : "",
	};
}
