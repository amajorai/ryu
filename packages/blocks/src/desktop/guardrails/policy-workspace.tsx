"use client";

// The named-policy workspace: list, create, edit, assign, archive and preview.
// One component for the web console and the desktop Gateway dialog. It never
// fetches on its own: the host injects a `PolicyWorkspaceClient` bound to its
// transport (session cookie on the web, bearer token on the desktop) and a
// `runWrite` wrapper that adds its step-up prompt.

import { ArrowLeft01Icon, Shield01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { SkeletonRows } from "@ryu/ui/components/skeleton";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../settings-items.tsx";
import { SettingsNavRow } from "../settings-nav.tsx";
import { PolicyList } from "./policy-list.tsx";
import {
	agentUnsupportedFields,
	emptyPolicyRules,
	POLICY_LADDER_COPY,
	type PolicyAssignmentView,
	type PolicyLockableField,
	type PolicyPreviewView,
	type PolicyRules,
	type PolicyScopeKind,
	type PolicyScopeOptions,
	type PolicyScopeRef,
	type PolicyView,
	policiesWithAssignment,
	policiesWithoutAssignment,
	policyErrorHint,
	policyRulesAreEmpty,
	scopeChipLabel,
	UNASSIGNED_POLICY_COPY,
} from "./policy-model.ts";
import { PolicyPreview } from "./policy-preview.tsx";
import {
	PolicyDetailsFields,
	PolicyRulesEditor,
} from "./policy-rules-editor.tsx";
import { defaultScopeFor, PolicyScopePicker } from "./policy-scope-picker.tsx";

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
type AssignmentChange =
	| { assignment: PolicyAssignmentView; kind: "assigned" }
	| { assignmentId: string; kind: "removed" };

type Page =
	| { kind: "index" }
	| { kind: "effective" }
	| { kind: "new" }
	| {
			kind: "policy";
			policyId: string;
	  };

/** The refusal code a client error carries, if any. */
function errorCode(error: unknown): string | null {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = Reflect.get(error, "code");
		return typeof code === "string" ? code : null;
	}
	return null;
}

/** The HTTP status a client error carries, if any. */
function errorStatus(error: unknown): number | null {
	if (typeof error === "object" && error !== null && "status" in error) {
		const status = Reflect.get(error, "status");
		return typeof status === "number" ? status : null;
	}
	return null;
}

export function policyErrorMessage(error: unknown, fallback: string): string {
	const hint = policyErrorHint(errorCode(error));
	if (hint) {
		return hint;
	}
	return error instanceof Error && error.message ? error.message : fallback;
}

function StatusLine({
	error,
	success,
}: {
	error: string | null;
	success: string | null;
}) {
	if (error) {
		return (
			<p className="px-3.5 text-sm text-status-destructive" role="alert">
				{error}
			</p>
		);
	}
	if (success) {
		return (
			<p
				aria-live="polite"
				className="px-3.5 text-sm text-status-success"
				role="status"
			>
				{success}
			</p>
		);
	}
	return null;
}

function SubpageHeader({
	hint,
	onBack,
	title,
}: {
	hint?: string;
	onBack: () => void;
	title: string;
}) {
	return (
		<div className="flex flex-col gap-1">
			<Button
				appearance="settings-back"
				className="-ml-2 w-fit"
				onClick={onBack}
				size="sm"
				variant="ghost-muted"
			>
				<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
				Policies
			</Button>
			<h3
				className="w-fit rounded-md px-0.5 font-medium text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
				data-policy-subpage-heading=""
				tabIndex={-1}
			>
				{title}
			</h3>
			{hint ? (
				<p className="px-0.5 text-muted-foreground text-sm leading-snug">
					{hint}
				</p>
			) : null}
		</div>
	);
}

export function PolicyWorkspace({
	canEdit,
	client,
	kinds,
	orgKey,
	runWrite,
	scopeOptions,
}: PolicyWorkspaceProps) {
	const [policies, setPolicies] = useState<PolicyView[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [page, setPage] = useState<Page>({ kind: "index" });
	const [reloadKey, setReloadKey] = useState(0);
	// Survives the editor remount a new version causes, so "Saved" stays put.
	const [notice, setNotice] = useState<string | null>(null);
	// Keyboard focus follows the viewer between the index and a subpage: the
	// control that opened a page unmounts with the index, so without this focus
	// falls back to the dialog and the next Tab starts from its top.
	const rootRef = useRef<HTMLDivElement>(null);
	const navigatedRef = useRef(false);
	const returnFocusRef = useRef<string | null>(null);

	// `reloadKey` and `orgKey` are reload triggers, not values read here.
	useEffect(() => {
		let cancelled = false;
		setLoadError(null);
		client
			.list()
			.then((list) => {
				if (!cancelled) {
					setPolicies(list);
				}
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setLoadError(
						errorStatus(error) === 403
							? "Managing guardrail policies needs permission to configure the gateway in this organization. Ask an organization admin."
							: policyErrorMessage(error, "Could not load policies.")
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [client, orgKey, reloadKey]);

	useEffect(() => {
		setPage({ kind: "index" });
	}, [orgKey]);

	useEffect(() => {
		if (!navigatedRef.current) {
			return;
		}
		navigatedRef.current = false;
		const root = rootRef.current;
		if (!root) {
			return;
		}
		if (page.kind !== "index") {
			root.querySelector<HTMLElement>("[data-policy-subpage-heading]")?.focus();
			return;
		}
		const key = returnFocusRef.current;
		const returns = [
			...root.querySelectorAll<HTMLElement>("[data-policy-return]"),
		];
		// An archived policy has no row to return to; start at the list instead.
		const target =
			returns.find((element) => element.dataset.policyReturn === key) ??
			returns[0];
		const control = target?.matches("button")
			? target
			: target?.querySelector<HTMLElement>("button");
		control?.focus();
	}, [page]);

	/** Change page from a viewer action, remembering where to come back to. */
	const navigate = useCallback((next: Page, returnTo?: string) => {
		if (returnTo !== undefined) {
			returnFocusRef.current = returnTo;
		}
		navigatedRef.current = true;
		setPage(next);
	}, []);

	const reload = useCallback(() => setReloadKey((key) => key + 1), []);
	const back = useCallback(() => {
		setNotice(null);
		navigate({ kind: "index" });
	}, [navigate]);

	/**
	 * Put the server's copy of a saved policy into the list right away. The
	 * editor is keyed on the version, so it remounts from exactly what was
	 * stored (the server normalizes rules) instead of a stale or echoed draft.
	 */
	const upsert = useCallback((saved: PolicyView) => {
		setPolicies((current) => {
			const list = current ?? [];
			return list.some((entry) => entry.id === saved.id)
				? list.map((entry) => (entry.id === saved.id ? saved : entry))
				: [...list, saved];
		});
	}, []);

	/**
	 * Put an assignment write into the list from the server's own answer (the
	 * panel, the "enforces nothing" notice and the index chips all read it).
	 * An assignment changes no policy version, so the answer is the whole
	 * change. Not refetching keeps a list fetched before the write from
	 * landing on top of it and showing the policy unassigned again.
	 */
	const assignmentChanged = useCallback((change: AssignmentChange) => {
		setPolicies((current) => {
			if (current === null) {
				return current;
			}
			return change.kind === "assigned"
				? policiesWithAssignment(current, change.assignment)
				: policiesWithoutAssignment(current, change.assignmentId);
		});
	}, []);

	if (loadError) {
		return (
			<div role="alert">
				<SettingsCard className="flex flex-wrap items-center justify-between gap-3">
					<p className="min-w-0 flex-1 break-words text-muted-foreground text-sm">
						{loadError}
					</p>
					<Button onClick={reload} size="sm" variant="secondary">
						Retry
					</Button>
				</SettingsCard>
			</div>
		);
	}

	if (policies === null) {
		return <SkeletonRows rows={3} />;
	}

	if (page.kind === "effective") {
		return (
			<div className="flex flex-col gap-4" ref={rootRef}>
				<SubpageHeader
					hint="The result a request would get at one scope, with the layer that set each value."
					onBack={back}
					title="Effective policy"
				/>
				<PreviewPanel
					client={client}
					idPrefix="effective"
					kinds={kinds}
					scopeOptions={scopeOptions}
				/>
			</div>
		);
	}

	if (page.kind === "new") {
		return (
			<div className="flex flex-col gap-4" ref={rootRef}>
				<SubpageHeader
					hint={`${UNASSIGNED_POLICY_COPY}. Assign it after you create it.`}
					onBack={back}
					title="New policy"
				/>
				<PolicyEditor
					canEdit={canEdit}
					client={client}
					key="new"
					kinds={kinds}
					onReload={reload}
					onSaved={(saved) => {
						upsert(saved);
						setNotice("Created. Assign it to a scope to enforce it.");
						navigate(
							{ kind: "policy", policyId: saved.id },
							`policy:${saved.id}`
						);
					}}
					policy={null}
					runWrite={runWrite}
					scopeOptions={scopeOptions}
				/>
			</div>
		);
	}

	if (page.kind === "policy") {
		const policy = policies.find((entry) => entry.id === page.policyId);
		if (!policy) {
			return (
				<div className="flex flex-col gap-4" ref={rootRef}>
					<SubpageHeader onBack={back} title="Policy not found" />
					<SettingsCard className="text-muted-foreground text-sm">
						This policy was archived or removed.
					</SettingsCard>
				</div>
			);
		}
		return (
			<div className="flex flex-col gap-4" ref={rootRef}>
				<SubpageHeader
					hint={policy.description || undefined}
					onBack={back}
					title={policy.name}
				/>
				<PolicyEditor
					canEdit={canEdit}
					client={client}
					// A new version remounts the editor from the stored policy, which
					// is also how a reload after a conflict discards the stale draft.
					key={`${policy.id}:${policy.version}`}
					kinds={kinds}
					notice={notice}
					onReload={() => {
						setNotice(
							"Loaded the latest version. Reapply your changes, then save."
						);
						reload();
					}}
					onSaved={(saved) => {
						upsert(saved);
						setNotice(`Saved as version ${saved.version}.`);
					}}
					policy={policy}
					runWrite={runWrite}
					scopeOptions={scopeOptions}
				/>
				<AssignmentsPanel
					canEdit={canEdit}
					client={client}
					kinds={kinds}
					onChanged={assignmentChanged}
					policies={policies}
					policy={policy}
					runWrite={runWrite}
					scopeOptions={scopeOptions}
				/>
				<ArchivePanel
					canEdit={canEdit}
					client={client}
					onArchived={() => {
						reload();
						back();
					}}
					policy={policy}
					runWrite={runWrite}
				/>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6" ref={rootRef}>
			<SettingsSection
				caption={`${POLICY_LADDER_COPY} ${UNASSIGNED_POLICY_COPY}.`}
				headerAction={
					canEdit ? (
						<Button
							data-policy-return="new"
							onClick={() => navigate({ kind: "new" }, "new")}
							size="sm"
							variant="ghost"
						>
							New policy
						</Button>
					) : null
				}
				title="Named policies"
			>
				<PolicyList
					onOpen={(policyId) =>
						navigate({ kind: "policy", policyId }, `policy:${policyId}`)
					}
					policies={policies}
					scopeOptions={scopeOptions}
				/>
			</SettingsSection>
			<SettingsSection title="Check a scope">
				<div className="contents" data-policy-return="effective">
					<SettingsGroup>
						<SettingsNavRow
							icon={Shield01Icon}
							onClick={() => navigate({ kind: "effective" }, "effective")}
							tint="red"
							title="Effective policy"
							value="By scope"
						/>
					</SettingsGroup>
				</div>
			</SettingsSection>
		</div>
	);
}

function PolicyEditor({
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
					{UNASSIGNED_POLICY_COPY}. Assign this policy below to enforce it.
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

function AssignmentsPanel({
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
			setSuccess(`Assigned to ${scopeChipLabel(scope, scopeOptions)}.`);
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
				`Removed from ${scopeChipLabel(assignment.scope, scopeOptions)}.`
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
										aria-label={`Remove from ${scopeChipLabel(assignment.scope, scopeOptions)}`}
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
								This replaces "{occupant.policy.name}" at{" "}
								{scopeChipLabel(scope, scopeOptions)}.
							</p>
						) : null}
						{alreadyHere ? (
							<p className="px-3.5 text-muted-foreground text-sm">
								This policy is already assigned here.
							</p>
						) : null}
						{agentBlockers.length > 0 ? (
							<p className="px-3.5 text-sm text-status-warning">
								An agent assignment carries firewall settings and evaluators
								only. Remove {agentBlockers.join(", ")} first.
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

function PreviewPanel({
	candidate,
	client,
	idPrefix,
	kinds,
	scopeOptions,
}: {
	candidate?: {
		locked: PolicyLockableField[];
		policyId?: string;
		rules: PolicyRules;
	};
	client: PolicyWorkspaceClient;
	idPrefix: string;
	kinds?: readonly PolicyScopeKind[];
	scopeOptions: PolicyScopeOptions;
}) {
	const [scope, setScope] = useState<PolicyScopeRef>(() =>
		defaultScopeFor("org", scopeOptions)
	);
	const [preview, setPreview] = useState<PolicyPreviewView | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const scopeChosen = scope.kind === "org" || scope.id.length > 0;

	const run = async () => {
		setLoading(true);
		setError(null);
		try {
			setPreview(await client.preview({ candidate, scope }));
		} catch (previewError) {
			setPreview(null);
			setError(policyErrorMessage(previewError, "Could not load the preview."));
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="flex flex-col gap-4">
			<PolicyScopePicker
				disabled={loading}
				idPrefix={idPrefix}
				kinds={kinds}
				onChange={(next) => {
					setScope(next);
					setPreview(null);
				}}
				options={scopeOptions}
				value={scope}
			/>
			<div className="px-3.5">
				{/* Outline, not secondary: the secondary fill matches the settings
				    surface this sits on, so it would read as plain text. */}
				<Button
					disabled={!scopeChosen}
					loading={loading}
					onClick={() => {
						run().catch(() => undefined);
					}}
					size="sm"
					variant="outline"
				>
					Preview
				</Button>
			</div>
			<StatusLine error={error} success={null} />
			{preview ? <PolicyPreview preview={preview} /> : null}
		</div>
	);
}

function ArchivePanel({
	canEdit,
	client,
	onArchived,
	policy,
	runWrite,
}: {
	canEdit: boolean;
	client: PolicyWorkspaceClient;
	onArchived: () => void;
	policy: PolicyView;
	runWrite: PolicyWorkspaceProps["runWrite"];
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const assigned = policy.assignments.length > 0;

	if (!canEdit) {
		return null;
	}

	const archive = async () => {
		setBusy(true);
		setError(null);
		try {
			const result = await runWrite(() => client.archive(policy.id));
			if (result !== null) {
				onArchived();
			}
		} catch (archiveError) {
			setError(
				policyErrorMessage(archiveError, "Could not archive the policy.")
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<SettingsSection
			caption={
				assigned
					? "Remove every assignment before archiving. Archived policies keep their version history."
					: "Archived policies leave this list and keep their version history."
			}
			title="Archive"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Button
							disabled={assigned || busy}
							loading={busy}
							onClick={() => {
								archive().catch(() => undefined);
							}}
							size="sm"
							variant="destructive"
						>
							Archive policy
						</Button>
					}
					title="Archive this policy"
				/>
			</SettingsGroup>
			<StatusLine error={error} success={null} />
		</SettingsSection>
	);
}
