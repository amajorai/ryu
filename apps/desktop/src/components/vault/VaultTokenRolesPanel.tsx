// Token roles: templates for machine tokens (`admin` on `sys/machines`). A
// role names the policies its tokens may and may not carry and caps their
// lifetime and use count. Roles never hold a token.

import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
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
	deleteVaultTokenRole,
	listVaultTokenRoles,
	type VaultTokenRole,
} from "@/src/lib/api/vault-token-roles.ts";
import { VaultListRow } from "./VaultListRow.tsx";
import { VaultTokenRoleDialog } from "./VaultTokenRoleDialog.tsx";
import { vaultErrorMessage } from "./vault-errors.ts";
import { formatTtl } from "./vault-ttl.ts";

export function VaultTokenRolesPanel({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [editing, setEditing] = useState<VaultTokenRole | "new" | null>(null);
	const rolesQuery = useQuery({
		queryKey: ["vault", "token-roles", target.url],
		queryFn: () => listVaultTokenRoles(target),
	});
	const remove = useMutation({
		mutationFn: (name: string) => deleteVaultTokenRole(target, name),
		onSuccess: async (_deleted, name) => {
			await queryClient.invalidateQueries({
				queryKey: ["vault", "token-roles"],
			});
			sileo.success({ title: tl("Deleted role {name}", { name }) });
		},
		onError: (error) => {
			sileo.error({
				title: tl("That did not work"),
				description: vaultErrorMessage(error, tl("Try again."), tl),
			});
		},
	});
	const roles = rolesQuery.data ?? [];
	const detail = (role: VaultTokenRole) => {
		const policies = role.allowedPolicies.length
			? role.allowedPolicies.join(", ")
			: tl("Any policy the creator holds");
		const ttl = role.ttlSecs
			? tl("TTL {ttl}", { ttl: formatTtl(role.ttlSecs) })
			: null;
		return [policies, ttl].filter(Boolean).join(" · ");
	};

	return (
		<SettingsSection
			caption="Templates for machine tokens. A token minted with a role gets its policy and lifetime limits."
			headerAction={
				<Button onClick={() => setEditing("new")} size="sm" variant="ghost">
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
					New role
				</Button>
			}
			title="Token roles"
		>
			<SettingsCard className="p-0">
				{rolesQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={2} />
				) : rolesQuery.error ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(
							rolesQuery.error,
							"Could not load token roles.",
							tl
						)}
					</p>
				) : roles.length === 0 ? (
					<p className="p-6 text-center text-muted-foreground text-sm">
						No token roles yet.
					</p>
				) : (
					<ul className="divide-y">
						{roles.map((role) => (
							<VaultListRow
								actions={
									<>
										<Button
											aria-label={tl("Edit {name}", { name: role.name })}
											onClick={() => setEditing(role)}
											size="sm"
											variant="ghost"
										>
											Edit
										</Button>
										<Button
											aria-label={tl("Delete {name}", { name: role.name })}
											disabled={remove.isPending}
											onClick={() => remove.mutate(role.name)}
											size="sm"
											variant="ghost"
										>
											Delete
										</Button>
									</>
								}
								detail={detail(role)}
								key={role.name}
								title={
									<>
										<span className="font-medium">{role.name}</span>
										{role.orphan ? (
											<Badge variant="outline">Orphan</Badge>
										) : null}
										{role.renewable === false ? (
											<Badge variant="outline">Not renewable</Badge>
										) : null}
									</>
								}
							/>
						))}
					</ul>
				)}
			</SettingsCard>
			<VaultTokenRoleDialog
				onOpenChange={(open) => {
					if (!open) {
						setEditing(null);
					}
				}}
				open={editing !== null}
				role={editing === "new" ? null : editing}
				target={target}
			/>
		</SettingsSection>
	);
}
