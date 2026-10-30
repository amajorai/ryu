"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { useMemo, useState } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../settings-items.tsx";
import {
	agentUnsupportedFields,
	type PolicyAssignmentView,
	type PolicyScopeKind,
	type PolicyScopeOptions,
	type PolicyScopeRef,
	type PolicyView,
	scopeChipLabel,
	UNASSIGNED_POLICY_COPY,
} from "./policy-model.ts";
import { defaultScopeFor, PolicyScopePicker } from "./policy-scope-picker.tsx";
import { StatusLine } from "./policy-workspace-chrome.tsx";
import { policyErrorMessage } from "./policy-workspace-errors.ts";
import type {
	AssignmentChange,
	PolicyWorkspaceClient,
	PolicyWorkspaceProps,
} from "./policy-workspace-types.ts";

export function AssignmentsPanel({
	canEdit,
	client,
	kinds,
	onChanged,
	policies,
	policy,
	runWrite,
	scopeOptions,
}: {
	canEdit: boolean;
	client: PolicyWorkspaceClient;
	kinds?: readonly PolicyScopeKind[];
	onChanged: (change: AssignmentChange) => void;
	policies: PolicyView[];
	policy: PolicyView;
	runWrite: PolicyWorkspaceProps["runWrite"];
	scopeOptions: PolicyScopeOptions;
}) {
	const tl = useLiteralMessages();
	const [scope, setScope] = useState<PolicyScopeRef>(() =>
		defaultScopeFor("org", scopeOptions)
	);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);

	const occupant = useMemo(() => {
		for (const candidate of policies) {
			const assignment = candidate.assignments.find(
				(entry) =>
					entry.scope.kind === scope.kind && entry.scope.id === scope.id
			);
			if (assignment) {
				return { assignment, policy: candidate };
			}
		}
		return null;
	}, [policies, scope]);

	const agentBlockers =
		scope.kind === "agent"
			? agentUnsupportedFields(policy.rules, policy.locked)
			: [];
	const alreadyHere = occupant?.policy.id === policy.id;

	const assign = async () => {
		setBusy("assign");
		setError(null);
		setSuccess(null);
		try {
			const result = await runWrite(() =>
				client.assign({
					assignmentId:
						occupant && !alreadyHere ? occupant.assignment.id : undefined,
					policyId: policy.id,
					scope,
				})
			);
			if (result === null) {
				return;
			}
			setSuccess(
				tl("Assigned to {scope}.", {
					scope: scopeChipLabel(scope, scopeOptions),
				})
			);
			onChanged({ assignment: result, kind: "assigned" });
		} catch (assignError) {
			setError(policyErrorMessage(assignError, "Could not assign the policy."));
		} finally {
			setBusy(null);
		}
	};

	const unassign = async (assignment: PolicyAssignmentView) => {
		setBusy(assignment.id);
		setError(null);
		setSuccess(null);
		try {
			const result = await runWrite(() => client.unassign(assignment.id));
			if (result === null) {
				return;
			}
			setSuccess(
				tl("Removed from {scope}.", {
					scope: scopeChipLabel(assignment.scope, scopeOptions),
				})
			);
			onChanged({ assignmentId: assignment.id, kind: "removed" });
		} catch (unassignError) {
			setError(
				policyErrorMessage(unassignError, "Could not remove the assignment.")
			);
		} finally {
			setBusy(null);
		}
	};

	const scopeChosen = scope.kind === "org" || scope.id.length > 0;

	return (
		<SettingsSection
			caption="A scope holds one policy. Assigning to a scope that already has one replaces it. Removing an assignment or assigning a weaker policy asks you to confirm it's you."
			title="Assignments"
		>
			<div className="flex flex-col gap-3">
				{policy.assignments.length === 0 ? (
					<SettingsCard className="text-muted-foreground text-sm">
						{UNASSIGNED_POLICY_COPY}.
					</SettingsCard>
				) : (
					<SettingsGroup>
						{policy.assignments.map((assignment) => (
							<SettingsItem
								actions={
									<Button
										aria-label={tl("Remove from {scope}", {
											scope: scopeChipLabel(assignment.scope, scopeOptions),
										})}
										disabled={!canEdit || busy !== null}
										loading={busy === assignment.id}
										onClick={() => {
											unassign(assignment).catch(() => undefined);
										}}
										size="sm"
										variant="ghost"
									>
										Remove
									</Button>
								}
								key={assignment.id}
								title={scopeChipLabel(assignment.scope, scopeOptions)}
							/>
						))}
					</SettingsGroup>
				)}
				{canEdit ? (
					<>
						<PolicyScopePicker
							disabled={busy !== null}
							idPrefix="assign"
							kinds={kinds}
							onChange={(next) => {
								setScope(next);
								setError(null);
								setSuccess(null);
							}}
							options={scopeOptions}
							value={scope}
						/>
						{occupant && !alreadyHere ? (
							<p className="px-3.5 text-sm text-status-warning">
								{tl('This replaces "{name}" at {scope}.', {
									name: occupant.policy.name,
									scope: scopeChipLabel(scope, scopeOptions),
								})}
							</p>
						) : null}
						{alreadyHere ? (
							<p className="px-3.5 text-muted-foreground text-sm">
								This policy is already assigned here.
							</p>
						) : null}
						{agentBlockers.length > 0 ? (
							<p className="px-3.5 text-sm text-status-warning">
								{tl(
									"An agent assignment carries firewall settings and evaluators only. Remove {fields} first.",
									{ fields: agentBlockers.join(", ") }
								)}
							</p>
						) : null}
						<div className="px-3.5">
							<Button
								disabled={
									busy !== null ||
									!scopeChosen ||
									alreadyHere ||
									agentBlockers.length > 0
								}
								loading={busy === "assign"}
								onClick={() => {
									assign().catch(() => undefined);
								}}
								size="sm"
							>
								{occupant && !alreadyHere ? "Replace assignment" : "Assign"}
							</Button>
						</div>
					</>
				) : null}
				<StatusLine error={error} success={success} />
			</div>
		</SettingsSection>
	);
}
