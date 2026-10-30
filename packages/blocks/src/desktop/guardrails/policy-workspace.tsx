"use client";

// The named-policy workspace: list, create, edit, assign, archive and preview.
// One component for the web console and the desktop Gateway dialog. It never
// fetches on its own: the host injects a `PolicyWorkspaceClient` bound to its
// transport (session cookie on the web, bearer token on the desktop) and a
// `runWrite` wrapper that adds its step-up prompt.

import { Shield01Icon } from "@hugeicons/core-free-icons";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { SkeletonRows } from "@ryu/ui/components/skeleton";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsSection,
} from "../settings-items.tsx";
import { SettingsNavRow } from "../settings-nav.tsx";
import { PolicyList } from "./policy-list.tsx";
import {
	POLICY_LADDER_COPY,
	type PolicyView,
	policiesWithAssignment,
	policiesWithoutAssignment,
	UNASSIGNED_POLICY_COPY,
} from "./policy-model.ts";
import { ArchivePanel } from "./policy-workspace-archive.tsx";
import { AssignmentsPanel } from "./policy-workspace-assignments.tsx";
import { SubpageHeader } from "./policy-workspace-chrome.tsx";
import { PolicyEditor } from "./policy-workspace-editor.tsx";
import { errorStatus, policyErrorMessage } from "./policy-workspace-errors.ts";
import { PreviewPanel } from "./policy-workspace-preview-panel.tsx";
import type {
	AssignmentChange,
	PolicyWorkspaceProps,
} from "./policy-workspace-types.ts";

export { policyErrorMessage } from "./policy-workspace-errors.ts";
export type {
	PolicyDraftInput,
	PolicyWorkspaceClient,
	PolicyWorkspaceProps,
} from "./policy-workspace-types.ts";

type Page =
	| { kind: "index" }
	| { kind: "effective" }
	| { kind: "new" }
	| {
			kind: "policy";
			policyId: string;
	  };

export function PolicyWorkspace({
	canEdit,
	client,
	kinds,
	orgKey,
	runWrite,
	scopeOptions,
}: PolicyWorkspaceProps) {
	const tl = useLiteralMessages();
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
					hint={tl("{unassigned}. Assign it after you create it.", {
						unassigned: UNASSIGNED_POLICY_COPY,
					})}
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
						setNotice(
							tl("Saved as version {version}.", {
								version: String(saved.version),
							})
						);
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
