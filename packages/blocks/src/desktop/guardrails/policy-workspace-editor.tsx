"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { useMemo, useState } from "react";
import { SettingsCard, SettingsSection } from "../settings-items.tsx";
import {
	emptyPolicyRules,
	type PolicyLockableField,
	type PolicyRules,
	type PolicyScopeKind,
	type PolicyScopeOptions,
	type PolicyView,
	policyRulesAreEmpty,
	UNASSIGNED_POLICY_COPY,
} from "./policy-model.ts";
import {
	PolicyDetailsFields,
	PolicyRulesEditor,
} from "./policy-rules-editor.tsx";
import { StatusLine } from "./policy-workspace-chrome.tsx";
import { errorCode, policyErrorMessage } from "./policy-workspace-errors.ts";
import { PreviewPanel } from "./policy-workspace-preview-panel.tsx";
import type {
	PolicyDraftInput,
	PolicyWorkspaceClient,
	PolicyWorkspaceProps,
} from "./policy-workspace-types.ts";

export function PolicyEditor({
	canEdit,
	client,
	kinds,
	notice = null,
	onReload,
	onSaved,
	policy,
	runWrite,
	scopeOptions,
}: {
	canEdit: boolean;
	client: PolicyWorkspaceClient;
	kinds?: readonly PolicyScopeKind[];
	/** A message from the workspace that outlives a remount. */
	notice?: string | null;
	onReload: () => void;
	onSaved: (saved: PolicyView) => void;
	policy: PolicyView | null;
	runWrite: PolicyWorkspaceProps["runWrite"];
	scopeOptions: PolicyScopeOptions;
}) {
	const tl = useLiteralMessages();
	const [name, setName] = useState(policy?.name ?? "");
	const [description, setDescription] = useState(policy?.description ?? "");
	const [rules, setRules] = useState<PolicyRules>(
		() => policy?.rules ?? emptyPolicyRules()
	);
	const [locked, setLocked] = useState<PolicyLockableField[]>(
		() => policy?.locked ?? []
	);
	const [rulesValid, setRulesValid] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [conflict, setConflict] = useState(false);

	const dirty = useMemo(() => {
		if (!policy) {
			return true;
		}
		return (
			name !== policy.name ||
			description !== policy.description ||
			JSON.stringify(rules) !== JSON.stringify(policy.rules) ||
			JSON.stringify([...locked].sort()) !==
				JSON.stringify([...policy.locked].sort())
		);
	}, [description, locked, name, policy, rules]);

	const disabled = !canEdit || saving;
	const trimmedName = name.trim();

	const save = async () => {
		if (!trimmedName) {
			setError("Give the policy a name.");
			return;
		}
		if (!rulesValid) {
			setError("Enter a spend cap amount, or choose No cap.");
			return;
		}
		setSaving(true);
		setError(null);
		setConflict(false);
		const input: PolicyDraftInput = {
			description: description.trim(),
			locked,
			name: trimmedName,
			rules,
		};
		try {
			const saved = await runWrite(() =>
				policy
					? client.update(policy.id, {
							...input,
							expectedVersion: policy.version,
						})
					: client.create(input)
			);
			if (saved === null) {
				return;
			}
			onSaved(saved);
		} catch (saveError) {
			setConflict(errorCode(saveError) === "version_conflict");
			setError(policyErrorMessage(saveError, "Could not save the policy."));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex flex-col gap-6">
			{policy && policy.assignments.length === 0 ? (
				<SettingsCard className="text-muted-foreground text-sm">
					{tl("{unassigned}. Assign this policy below to enforce it.", {
						unassigned: UNASSIGNED_POLICY_COPY,
					})}
				</SettingsCard>
			) : null}
			<PolicyDetailsFields
				description={description}
				disabled={disabled}
				name={name}
				onDescriptionChange={setDescription}
				onNameChange={setName}
			/>
			<PolicyRulesEditor
				disabled={disabled}
				locked={locked}
				onChange={setRules}
				onLockedChange={setLocked}
				onValidityChange={setRulesValid}
				policyKey={policy ? `${policy.id}:${policy.version}` : "new"}
				value={rules}
			/>
			{policyRulesAreEmpty(rules) && locked.length === 0 ? (
				<p className="px-3.5 text-muted-foreground text-xs">
					This policy adds no rules yet, so it would tighten nothing.
				</p>
			) : null}
			<div className="flex flex-wrap items-center gap-3 px-3.5">
				<Button
					disabled={!(canEdit && dirty && trimmedName && rulesValid)}
					loading={saving}
					onClick={() => {
						save().catch(() => undefined);
					}}
					size="sm"
				>
					{policy ? "Save policy" : "Create policy"}
				</Button>
				{conflict ? (
					<Button onClick={onReload} size="sm" variant="outline">
						Reload
					</Button>
				) : null}
			</div>
			<StatusLine error={error} success={error ? null : notice} />
			<SettingsSection
				caption="Preview these rules, saved or not, at any scope before you assign them."
				title="Preview at a scope"
			>
				<PreviewPanel
					candidate={{ locked, policyId: policy?.id, rules }}
					client={client}
					idPrefix="candidate"
					kinds={kinds}
					scopeOptions={scopeOptions}
				/>
			</SettingsSection>
		</div>
	);
}
