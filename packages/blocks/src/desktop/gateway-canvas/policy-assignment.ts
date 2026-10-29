// Binds the canvas's drag-to-assign (spec 07.6) to a guardrail policy
// workspace client, so a drop on a policy layer writes through the same
// assignment API, step-up prompt and error notices as the policy forms.

import {
	POLICY_SCOPE_KINDS,
	type PolicyScopeKind,
	type PolicyScopeOptions,
	type PolicyView,
} from "../guardrails/policy-model.ts";
import {
	type PolicyWorkspaceClient,
	policyErrorMessage,
} from "../guardrails/policy-workspace.tsx";
import type {
	CanvasAssignment,
	CanvasAssignTarget,
	CanvasNode,
} from "./model.ts";

function scopeKind(kind: string | undefined): PolicyScopeKind | null {
	return POLICY_SCOPE_KINDS.find((candidate) => candidate === kind) ?? null;
}

const LAYER_PREFIX = "scope:";

/** `scope:team` is the team layer, for topologies without a scope ref. */
function layerKind(id: string): string | undefined {
	return id.startsWith(LAYER_PREFIX)
		? id.slice(LAYER_PREFIX.length)
		: undefined;
}

export interface PolicyCanvasAssignmentInput {
	client: Pick<PolicyWorkspaceClient, "assign">;
	policies: readonly PolicyView[];
	/** The host's write wrapper; `null` means the viewer cancelled. */
	runWrite: <T>(action: () => Promise<T>) => Promise<T | null>;
	scopeOptions: PolicyScopeOptions;
}

export function policyCanvasAssignment({
	client,
	policies,
	runWrite,
	scopeOptions,
}: PolicyCanvasAssignmentInput): CanvasAssignment {
	return {
		assign: async (policyId, target) => {
			const kind = scopeKind(target.kind);
			if (!kind) {
				throw new Error("That layer does not take a policy.");
			}
			try {
				// No `assignmentId`: a drop only creates, so an occupied scope
				// answers 409 and the viewer replaces it from the forms.
				const result = await runWrite(() =>
					client.assign({ policyId, scope: { id: target.id, kind } })
				);
				return result !== null;
			} catch (error) {
				throw new Error(
					policyErrorMessage(error, "Could not assign the policy.")
				);
			}
		},
		policies: policies.map((policy) => ({ id: policy.id, label: policy.name })),
		targets: (node: CanvasNode): CanvasAssignTarget[] => {
			const kind = scopeKind(node.ref?.scope?.kind ?? layerKind(node.id));
			if (node.kind !== "scope" || !kind) {
				return [];
			}
			return scopeOptions[kind].map((option) => ({
				id: option.id,
				kind,
				label: option.label,
			}));
		},
	};
}
