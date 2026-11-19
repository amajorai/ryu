// Vault policies: who may do what on which paths. Each row shows the rules'
// count and the subjects the policy is bound to; Edit opens the JSON editor.
// Bindings are managed where the subjects are (members, teams, machines).
// Delete asks first: it also removes the policy's bindings, and removing a
// deny policy widens access.

import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	deleteVaultPolicyDocument,
	listVaultPolicyDocuments,
	type VaultPolicyDocument,
} from "@/src/lib/api/vault-policies.ts";
import { VaultListRow } from "./VaultListRow.tsx";
import { VaultPolicyDialog } from "./VaultPolicyDialog.tsx";
import { vaultErrorMessage } from "./vault-errors.ts";
import { boundSubjects } from "./vault-policy-form.ts";

export function VaultPoliciesPanel({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [editing, setEditing] = useState<VaultPolicyDocument | "new" | null>(
		null
	);
	const [deleting, setDeleting] = useState<string | null>(null);
	const policiesQuery = useQuery({
		queryKey: ["vault", "policies", target.url],
		queryFn: () => listVaultPolicyDocuments(target),
	});
	const remove = useMutation({
		mutationFn: (name: string) => deleteVaultPolicyDocument(target, name),
		onSuccess: async (deleted, name) => {
			setDeleting(null);
			await queryClient.invalidateQueries({ queryKey: ["vault", "policies"] });
			if (deleted) {
				sileo.success({ title: tl("Deleted policy {name}", { name }) });
			} else {
				sileo.info({
					title: tl("Policy {name} was already gone", { name }),
				});
			}
		},
		onError: (error) => {
			sileo.error({
				title: tl("That did not work"),
				description: vaultErrorMessage(error, "Try again.", tl),
			});
		},
	});
	const policies = policiesQuery.data?.policies ?? [];
	const bindings = policiesQuery.data?.bindings ?? [];
	const detail = (policy: VaultPolicyDocument) => {
		const rules = tl("{count, plural, one {# rule} other {# rules}}", {
			count: policy.rules.length,
		});
		const subjects = boundSubjects(policy.name, bindings);
		const bound = subjects.length
			? tl("Bound to {subjects}", { subjects: subjects.join(", ") })
			: tl("Not bound");
		return [policy.description, rules, bound].filter(Boolean).join(" · ");
	};

	return (
		<SettingsSection
			caption="Policies grant or deny capabilities on paths. A user, team, role or machine gets a policy through a binding."
			headerAction={
				<Button
					// Until the list loads, a new name cannot be checked against it.
					disabled={!policiesQuery.isSuccess}
					onClick={() => setEditing("new")}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
					New policy
				</Button>
			}
			title="Policies"
		>
			<SettingsCard className="p-0">
				{policiesQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={2} />
				) : policiesQuery.error ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(
							policiesQuery.error,
							"Could not load policies.",
							tl
						)}
					</p>
				) : policies.length === 0 ? (
					<p className="p-6 text-center text-muted-foreground text-sm">
						No policies yet.
					</p>
				) : (
					<ul className="divide-y">
						{policies.map((policy) => (
							<VaultListRow
								actions={
									<>
										<Button
											aria-label={tl("Edit {name}", { name: policy.name })}
											onClick={() => setEditing(policy)}
											size="sm"
											variant="ghost"
										>
											Edit
										</Button>
										<Button
											aria-label={tl("Delete {name}", { name: policy.name })}
											disabled={remove.isPending}
											onClick={() => setDeleting(policy.name)}
											size="sm"
											variant="ghost"
										>
											Delete
										</Button>
									</>
								}
								detail={detail(policy)}
								key={policy.name}
								title={<span className="font-medium">{policy.name}</span>}
							/>
						))}
					</ul>
				)}
			</SettingsCard>
			<VaultPolicyDialog
				onOpenChange={(open) => {
					if (!open) {
						setEditing(null);
					}
				}}
				open={editing !== null}
				policy={editing === "new" ? null : editing}
				taken={policies.map((policy) => policy.name)}
				target={target}
			/>
			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setDeleting(null);
					}
				}}
				open={deleting !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{tl("Delete {name}?", { name: deleting ?? "" })}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{deleting && boundSubjects(deleting, bindings).length > 0
								? tl(
										"Its bindings are removed too, so {subjects} lose what it grants. If it denies access, deleting it can widen access.",
										{ subjects: boundSubjects(deleting, bindings).join(", ") }
									)
								: tl(
										"If it denies access, deleting it can widen access. This cannot be undone."
									)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={remove.isPending}
							onClick={(event) => {
								event.preventDefault();
								if (deleting) {
									remove.mutate(deleting);
								}
							}}
						>
							Delete policy
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</SettingsSection>
	);
}
