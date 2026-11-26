// Dynamic secrets: roles that mint short-lived credentials (PostgreSQL users,
// AWS STS sessions, webhook-issued values, random values) and the leases they
// issued. Managing roles needs `admin` on `sys/dynamic`; issuing needs `use`
// on the role. Role rows show a redacted provider summary, never credentials.

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
import { Badge } from "@ryu/ui/components/badge.tsx";
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
	deleteVaultDynamicRole,
	listVaultDynamicRoles,
	revokeAllVaultDynamicLeases,
	type VaultDynamicRole,
} from "@/src/lib/api/vault-dynamic.ts";
import { VaultDynamicIssueDialog } from "./VaultDynamicIssueDialog.tsx";
import { VaultDynamicRoleDialog } from "./VaultDynamicRoleDialog.tsx";
import { VaultLeasesSection } from "./VaultLeasesSection.tsx";
import { VaultListRow } from "./VaultListRow.tsx";
import { dynamicProviderLabel } from "./vault-dynamic-form.ts";
import { vaultErrorMessage } from "./vault-errors.ts";
import { formatTtl } from "./vault-ttl.ts";

export const DYNAMIC_KEY = ["vault", "dynamic"] as const;

interface Pending {
	kind: "delete" | "revoke-all";
	role: string;
}

export function VaultDynamicPanel({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [editing, setEditing] = useState<VaultDynamicRole | "new" | null>(null);
	const [issuing, setIssuing] = useState<VaultDynamicRole | null>(null);
	const [confirm, setConfirm] = useState<Pending | null>(null);
	const rolesQuery = useQuery({
		queryKey: [...DYNAMIC_KEY, "roles", target.url],
		queryFn: () => listVaultDynamicRoles(target),
	});
	const act = useMutation({
		mutationFn: async (action: Pending): Promise<string> => {
			if (action.kind === "delete") {
				await deleteVaultDynamicRole(target, action.role);
				return tl("Deleted role {name}", { name: action.role });
			}
			const revoked = await revokeAllVaultDynamicLeases(target, action.role);
			return tl("Revoked {count, plural, one {# lease} other {# leases}}", {
				count: revoked,
			});
		},
		onSuccess: async (title) => {
			setConfirm(null);
			await queryClient.invalidateQueries({ queryKey: [...DYNAMIC_KEY] });
			sileo.success({ title });
		},
		onError: (error) => {
			sileo.error({
				title: tl("That did not work"),
				description: vaultErrorMessage(error, tl("Try again."), tl),
			});
		},
	});
	const roles = rolesQuery.data ?? [];

	return (
		<div className="flex flex-col gap-6">
			<SettingsSection
				caption="Each role mints a fresh credential with a lease. Credentials expire with the lease or when it is revoked."
				headerAction={
					<Button onClick={() => setEditing("new")} size="sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						New role
					</Button>
				}
				title="Dynamic roles"
			>
				<SettingsCard className="p-0">
					{rolesQuery.isLoading ? (
						<SkeletonRows inset="panel" rows={2} />
					) : rolesQuery.error ? (
						<p className="p-4 text-sm text-status-destructive">
							{vaultErrorMessage(
								rolesQuery.error,
								"Could not load dynamic roles.",
								tl
							)}
						</p>
					) : roles.length === 0 ? (
						<p className="p-6 text-center text-muted-foreground text-sm">
							No dynamic roles yet.
						</p>
					) : (
						<ul className="divide-y">
							{roles.map((role) => (
								<VaultListRow
									actions={
										<>
											<Button
												aria-label={tl("Issue from {name}", {
													name: role.name,
												})}
												onClick={() => setIssuing(role)}
												size="sm"
												variant="ghost"
											>
												Issue
											</Button>
											<Button
												aria-label={tl("Replace {name}", { name: role.name })}
												onClick={() => setEditing(role)}
												size="sm"
												variant="ghost"
											>
												Replace
											</Button>
											<Button
												aria-label={tl("Revoke all leases of {name}", {
													name: role.name,
												})}
												onClick={() =>
													setConfirm({ kind: "revoke-all", role: role.name })
												}
												size="sm"
												variant="ghost"
											>
												Revoke all
											</Button>
											<Button
												aria-label={tl("Delete {name}", { name: role.name })}
												onClick={() =>
													setConfirm({ kind: "delete", role: role.name })
												}
												size="sm"
												variant="ghost"
											>
												Delete
											</Button>
										</>
									}
									detail={tl("Default {ttl} · maximum {max}", {
										ttl: formatTtl(role.defaultTtlSecs),
										max: formatTtl(role.maxTtlSecs),
									})}
									key={role.name}
									title={
										<>
											<span className="font-medium">{role.name}</span>
											<Badge variant="outline">
												{dynamicProviderLabel(role.provider)}
											</Badge>
										</>
									}
								/>
							))}
						</ul>
					)}
				</SettingsCard>
			</SettingsSection>

			<VaultLeasesSection target={target} />

			<VaultDynamicRoleDialog
				onOpenChange={(open) => {
					if (!open) {
						setEditing(null);
					}
				}}
				open={editing !== null}
				role={editing === "new" ? null : editing}
				target={target}
			/>
			<VaultDynamicIssueDialog
				onOpenChange={(open) => {
					if (!open) {
						setIssuing(null);
					}
				}}
				role={issuing}
				target={target}
			/>
			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setConfirm(null);
					}
				}}
				open={confirm !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{confirm?.kind === "delete"
								? tl("Delete {name}?", { name: confirm.role })
								: tl("Revoke every lease of {name}?", {
										name: confirm?.role ?? "",
									})}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{confirm?.kind === "delete"
								? "The role stops issuing. A role with live leases cannot be deleted until they are revoked."
								: "Every credential this role issued stops working now."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={act.isPending}
							onClick={(event) => {
								event.preventDefault();
								if (confirm) {
									act.mutate(confirm);
								}
							}}
						>
							{confirm?.kind === "delete" ? "Delete role" : "Revoke leases"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
