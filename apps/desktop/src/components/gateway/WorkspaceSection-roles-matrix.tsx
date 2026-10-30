import {
	Add01Icon,
	Delete01Icon,
	PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sileo } from "sileo";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import type { useStepUp } from "@/src/components/StepUpDialog.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	createRole,
	deleteRole,
	type OrgRoleDef,
	PERMISSIONS,
	updateRole,
} from "@/src/lib/api/org.ts";
import {
	RoleFormDialog,
	type RoleFormValues,
} from "./WorkspaceSection-role-form-dialog.tsx";

/**
 * The read-only permission matrix: permissions down the rows, roles across the
 * columns (so it grows downward, and the table's own container scrolls
 * horizontally if the custom columns overflow). Built-in roles are always
 * read-only; custom roles get edit + delete affordances in their header when the
 * caller holds `roles.manage`.
 */
export function RolesMatrix({
	orgId,
	roles,
	canManage,
	stepUp,
}: {
	orgId: string;
	roles: OrgRoleDef[];
	canManage: boolean;
	stepUp: ReturnType<typeof useStepUp>;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: ["workspace-roles", orgId] });

	const createMutation = useMutation({
		mutationFn: (values: RoleFormValues) => createRole(orgId, values),
		onSuccess: async () => {
			await invalidate();
			sileo.success({ title: "Role created" });
		},
		onError: (e) => {
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to create role",
			});
		},
	});

	const updateMutation = useMutation({
		mutationFn: (values: RoleFormValues) =>
			updateRole(orgId, values.key, {
				name: values.name,
				permissions: values.permissions,
			}),
		onSuccess: async () => {
			await invalidate();
			sileo.success({ title: "Role updated" });
		},
		onError: (e) => {
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to update role",
			});
		},
	});

	const deleteMutation = useMutation({
		mutationFn: (roleKey: string) => deleteRole(orgId, roleKey),
		onSuccess: async () => {
			await invalidate();
			await queryClient.invalidateQueries({
				queryKey: ["workspace-member-roles", orgId],
			});
			sileo.success({ title: "Role deleted" });
		},
		onError: (e) => {
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to delete role",
			});
		},
	});

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"Built-in roles are fixed; create custom roles to grant a precise subset, then assign them to members below."
					}
				>
					{"Every role and the permissions it grants."}
				</CaptionInfo>
			}
			headerAction={
				canManage ? (
					<RoleFormDialog
						mode="create"
						onSubmit={async (values) =>
							(await stepUp.guard("org.members", () =>
								createMutation.mutateAsync(values)
							)) !== null
						}
						trigger={
							<Button size="sm" variant="ghost">
								<HugeiconsIcon className="size-4" icon={Add01Icon} />
								New role
							</Button>
						}
					/>
				) : undefined
			}
			title="Roles"
		>
			<SettingsCard className="px-2 py-1">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="sticky left-0" presentation="permission">
								Permission
							</TableHead>
							{roles.map((role) => (
								<TableHead className="text-center" key={role.key}>
									<div className="flex flex-col items-center gap-1">
										<span className="flex items-center gap-1">
											{role.name}
											{role.builtin ? (
												<span className="text-muted-foreground text-xs">
													Built-in
												</span>
											) : null}
										</span>
										{canManage && !role.builtin ? (
											<span className="flex items-center gap-0.5">
												<RoleFormDialog
													initial={{
														key: role.key,
														name: role.name,
														permissions: role.permissions,
													}}
													mode="edit"
													onSubmit={async (values) =>
														(await stepUp.guard("org.members", () =>
															updateMutation.mutateAsync(values)
														)) !== null
													}
													trigger={
														<Button
															aria-label={tl("Edit {name}", {
																name: role.name,
															})}
															size="icon"
															variant="ghost"
														>
															<HugeiconsIcon
																className="size-3.5"
																icon={PencilEdit01Icon}
															/>
														</Button>
													}
												/>
												<Button
													aria-label={tl("Delete {name}", { name: role.name })}
													disabled={deleteMutation.isPending}
													onClick={() =>
														void stepUp
															.guard("org.members", () =>
																deleteMutation.mutateAsync(role.key)
															)
															.catch(() => undefined)
													}
													size="icon"
													variant="ghost"
												>
													<HugeiconsIcon
														className="size-3.5 text-status-destructive"
														icon={Delete01Icon}
													/>
												</Button>
											</span>
										) : null}
									</div>
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{PERMISSIONS.map((perm) => (
							<TableRow key={perm}>
								<TableCell className="sticky left-0" presentation="permission">
									{perm}
								</TableCell>
								{roles.map((role) => (
									<TableCell className="text-center" key={role.key}>
										<div className="flex justify-center">
											<Checkbox
												checked={role.permissions.includes(perm)}
												disabled
											/>
										</div>
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</SettingsCard>
		</SettingsSection>
	);
}
