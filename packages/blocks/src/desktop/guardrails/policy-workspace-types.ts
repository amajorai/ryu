import type {
	PolicyAssignmentView,
	PolicyLockableField,
	PolicyPreviewView,
	PolicyRules,
	PolicyScopeKind,
	PolicyScopeOptions,
	PolicyScopeRef,
	PolicyView,
} from "./policy-model.ts";

export interface PolicyDraftInput {
	description: string;
	locked: PolicyLockableField[];
	name: string;
	rules: PolicyRules;
}

/** The host's transport. Each call rejects with an error carrying `code`. */
export interface PolicyWorkspaceClient {
	archive(policyId: string): Promise<unknown>;
	/** Resolves with the assignment the server stored. */
	assign(input: {
		assignmentId?: string;
		policyId: string;
		scope: PolicyScopeRef;
	}): Promise<PolicyAssignmentView>;
	create(input: PolicyDraftInput): Promise<PolicyView>;
	list(): Promise<PolicyView[]>;
	preview(input: {
		candidate?: {
			locked: PolicyLockableField[];
			policyId?: string;
			rules: PolicyRules;
		};
		scope: PolicyScopeRef;
	}): Promise<PolicyPreviewView>;
	unassign(assignmentId: string): Promise<unknown>;
	update(
		policyId: string,
		input: PolicyDraftInput & { expectedVersion: number }
	): Promise<PolicyView>;
}

export interface PolicyWorkspaceProps {
	/** Read-only: the viewer lacks `gateway.configure`. */
	canEdit: boolean;
	client: PolicyWorkspaceClient;
	/** Kinds this host offers in pickers. Defaults to every kind. */
	kinds?: readonly PolicyScopeKind[];
	/** Changes when the org changes, so the workspace reloads. */
	orgKey: string;
	/**
	 * Runs a write behind the host's step-up prompt. Resolves `null` when the
	 * user dismissed the prompt, so nothing was written.
	 */
	runWrite: <T>(action: () => Promise<T>) => Promise<T | null>;
	scopeOptions: PolicyScopeOptions;
}

/** An assignment write the server accepted. */
export type AssignmentChange =
	| { assignment: PolicyAssignmentView; kind: "assigned" }
	| { assignmentId: string; kind: "removed" };
