/**
 * Prompt-cache confirmations for the node-wide model defaults: the `global`
 * scope (Gateway › Defaults › Models) and the local/cloud lane defaults below
 * it. Every chat without a closer default inherits these, and prompt caches are
 * per model, so a model or provider change re-sends each of those threads'
 * context uncached once. Effort, thinking level and access mode do not change
 * the cache key, so changing only those asks nothing.
 *
 * The copy comes from `modelDefaultCacheWarning`, the same one the thread
 * Defaults menu uses for project and bot scopes.
 */

import { modelDefaultCacheWarning } from "@ryu/blocks/desktop/agent-elements/prompt-cache.ts";
import type { ScopeDefault } from "@/src/lib/api/hierarchy.ts";
import {
	type AgentLane,
	type AgentSelection,
	defaultCloudAgentSelection,
	isAgentSelectionEmpty,
} from "@/src/lib/api/preferences.ts";

export const NODE_DEFAULT_SCOPE_LABEL = "the node-wide default";

type Confirmation = { description: string; title: string } | null;

/** A scope default changing its thread or coordinator model/provider. */
export function scopeDefaultCacheWarning(
	scopeLabel: string,
	before: ScopeDefault,
	after: ScopeDefault
): Confirmation {
	return (
		modelDefaultCacheWarning(scopeLabel, before, after) ??
		modelDefaultCacheWarning(
			scopeLabel,
			{
				model: before.coordinatorModel ?? "",
				provider: before.coordinatorProvider ?? "",
			},
			{
				model: after.coordinatorModel ?? "",
				provider: after.coordinatorProvider ?? "",
			}
		)
	);
}

/** The model key a lane selection resolves to. The agent is part of it: a
 * different agent answers with a different model and prompt. */
function laneModelKey(selection: AgentSelection) {
	return {
		model: selection.model,
		provider: [selection.agent_id.trim(), selection.provider.trim()]
			.filter(Boolean)
			.join(" "),
	};
}

/**
 * A lane default changing what chats run on. Normal chats use the cloud lane
 * when it is set (a managed node's empty cloud lane means Auto cloud) and fall
 * back to the local lane only when it is not, so the warning compares the
 * selection chats resolve to before and after the change: a local-lane edit
 * behind a set cloud lane, or a cloud-lane edit that lands on the model chats
 * already use, asks nothing.
 */
export function laneDefaultCacheWarning(input: {
	after: AgentSelection;
	cloudSelection: AgentSelection;
	lane: AgentLane;
	localSelection: AgentSelection;
	managed: boolean;
}): Confirmation {
	const { after, cloudSelection, lane, localSelection, managed } = input;
	const chatSelection = (local: AgentSelection, cloud: AgentSelection) => {
		if (!isAgentSelectionEmpty(cloud)) {
			return cloud;
		}
		return managed ? defaultCloudAgentSelection(true) : local;
	};
	const before = chatSelection(localSelection, cloudSelection);
	const next =
		lane === "local"
			? chatSelection(after, cloudSelection)
			: chatSelection(localSelection, after);
	return modelDefaultCacheWarning(
		lane === "local"
			? "the node-wide local default"
			: "the node-wide cloud default",
		laneModelKey(before),
		laneModelKey(next)
	);
}
