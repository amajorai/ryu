import {
	type AgentSelection,
	defaultCloudAgentSelection,
	isAgentSelectionEmpty,
} from "@/src/lib/api/preferences.ts";
import type { Node } from "@/src/store/useNodeStore.ts";

/** Keep an active managed workspace only while it remains in the hydrated list. */
export function resolveBotManagedNode(state: {
	cloudNodes: Node[];
	getActiveNode: () => Node;
}): Node | undefined {
	const active = state.getActiveNode();
	// Hydration decorates an existing saved node by URL; its local display name
	// can differ from the control plane's cloud-prefixed name.
	const reachable = state.cloudNodes.find(
		(node) =>
			node.managed &&
			node.url.replace(/\/+$/, "") === active.url.replace(/\/+$/, "")
	);
	return reachable
		? active.managed
			? active
			: reachable
		: state.cloudNodes.find((node) => node.managed);
}

export type BotManagedEntryState =
	| "checking-subscription"
	| "subscribe"
	| "provisioning"
	| "ready";

/**
 * Resolve the cloud selection for the managed Bot surface.
 *
 * Console owners/admins configure the managed node's cloud lane through the
 * existing Gateway defaults control. Bot must preserve that node-scoped value
 * and only seed the product default for a genuinely unset (or unreadable)
 * preference.
 */
export function resolveBotCloudSelection(current: AgentSelection) {
	if (!isAgentSelectionEmpty(current)) {
		return { selection: current, shouldPersist: false } satisfies {
			selection: AgentSelection;
			shouldPersist: boolean;
		};
	}
	return {
		selection: defaultCloudAgentSelection(true),
		shouldPersist: true,
	} satisfies {
		selection: AgentSelection;
		shouldPersist: boolean;
	};
}

export function resolveBotManagedEntryState(input: {
	hasManagedNode: boolean;
	managedInference: boolean;
	resolvingSubscription: boolean;
}): BotManagedEntryState {
	if (input.resolvingSubscription) {
		return "checking-subscription";
	}
	if (!input.managedInference) {
		return "subscribe";
	}
	return input.hasManagedNode ? "ready" : "provisioning";
}
