import {
	Add01Icon,
	Delete01Icon,
	PencilEdit01Icon,
	Shield01Icon,
	UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Checkbox } from "@ryu/ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { useState } from "react";
import { sileo } from "sileo";
import { FRONTEND_URL, useSession } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { CopyableId } from "@/src/components/settings/shared/CopyableId.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	createRole,
	deleteRole,
	fetchMyPermissions,
	fetchOrgMembers,
	fetchOrgs,
	getMemberRoles,
	hasOrgAuth,
	listRoles,
	type OrgRole,
	type OrgRoleDef,
	PERMISSIONS,
	type Permission,
	setMemberRoles,
	updateRole,
} from "@/src/lib/api/org.ts";

/** Where members are invited / roles changed (Better Auth owns those mutations). */
const ORGANIZATIONS_URL = `${FRONTEND_URL.replace(/\/$/, "")}/organizations`;

/** The RBAC permission that authorizes managing custom roles + assignments. */
const ROLES_MANAGE: Permission = "roles.manage";

/** Rank so the roster reads owner → admin → member → viewer. */
const ROLE_RANK: Record<Exclude<OrgRole, null>, number> = {
	owner: 0,
	admin: 1,
	member: 2,
	viewer: 3,
};

function roleBadgeVariant(role: OrgRole): "default" | "secondary" | "outline" {
	if (role === "owner") {
		return "default";
	}
	if (role === "admin") {
		return "secondary";
	}
	return "outline";
}

function RoleBadge({ role }: { role: OrgRole }) {
	return (
		<Badge className="text-xs capitalize" variant={roleBadgeVariant(role)}>
			{role ?? "member"}
		</Badge>
	);
}

/** A short kebab-case key (letters, digits, single dashes) unique per org. */
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface RoleFormValues {
	key: string;
	name: string;
	permissions: string[];
}

/**
 * Create / edit dialog for a custom role. In create mode the key is editable and
 * kebab-validated; in edit mode the key is fixed (it identifies the role and its
 * assignments) so only the name and permission set change. The permission grid is
 * the literal "checkbox per PERMISSIONS key" matrix for the role being authored.
 */
function RoleFormDialog({
	trigger,
	mode,
	initial,
	onSubmit,
}: {
	trigger: ReactElement;
	mode: "create" | "edit";
	initial?: RoleFormValues;
	onSubmit: (values: RoleFormValues) => Promise<void>;
}) {
	const empty: RoleFormValues = { key: "", name: "", permissions: [] };
	const [open, setOpen] = useState(false);
	const [values, setValues] = useState<RoleFormValues>(initial ?? empty);
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const handleOpenChange = (next: boolean) => {
		if (next) {
			setValues(initial ?? empty);
			setErr(null);
		}
		setOpen(next);
	};

	const togglePermission = (perm: string, checked: boolean) => {
		setValues((v) => ({
			...v,
			permissions: checked
				? [...v.permissions, perm]
				: v.permissions.filter((p) => p !== perm),
		}));
	};

	const handleSubmit = async () => {
		const name = values.name.trim();
		const key = values.key.trim();
		if (!name) {
			setErr("Name is required.");
			return;
		}
		if (mode === "create" && !KEBAB_RE.test(key)) {
			setErr("Key must be kebab-case (letters, digits, single dashes).");
			return;
		}
		setSaving(true);
		setErr(null);
		try {
			await onSubmit({ key, name, permissions: values.permissions });
			setOpen(false);
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Failed to save role.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogTrigger render={trigger} />
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{mode === "create" ? "New custom role" : `Edit ${values.name}`}
					</DialogTitle>
					<DialogDescription>
						Grant a precise set of permissions. Members holding this role gain
						these permissions on top of their built-in tier.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="role-name">Name</Label>
						<Input
							id="role-name"
							onChange={(e) =>
								setValues((v) => ({ ...v, name: e.target.value }))
							}
							placeholder="e.g. Workflow editor"
							value={values.name}
						/>
					</div>
					{mode === "create" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="role-key">Key</Label>
							<Input
								id="role-key"
								onChange={(e) =>
									setValues((v) => ({ ...v, key: e.target.value }))
								}
								placeholder="e.g. workflow-editor"
								value={values.key}
							/>
							<p className="text-muted-foreground text-xs">
								Kebab-case, unique within this workspace. Cannot be changed later.
							</p>
						</div>
					) : null}
					<div className="flex flex-col gap-2">
						<Label>Permissions</Label>
						<div className="grid max-h-64 grid-cols-1 gap-1.5 overflow-y-auto rounded-lg border border-border/60 p-2 sm:grid-cols-2">
							{PERMISSIONS.map((perm) => (
								<label
									className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted/50"
									key={perm}
								>
									<Checkbox
										checked={values.permissions.includes(perm)}
										onCheckedChange={(checked) =>
											togglePermission(perm, checked === true)
										}
									/>
									<span className="font-mono text-xs">{perm}</span>
								</label>
							))}
						</div>
					</div>
					{err ? <p className="text-destructive text-sm">{err}</p> : null}
				</div>
				<DialogFooter>
					<Button disabled={saving} onClick={() => setOpen(false)} variant="ghost">
						Cancel
					</Button>
					<Button disabled={saving} onClick={() => handleSubmit()}>
						{saving ? <Spinner className="size-4" /> : null}
						{mode === "create" ? "Create role" : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * The read-only permission matrix: permissions down the rows, roles across the
 * columns (so it grows downward, and the table's own container scrolls
 * horizontally if the custom columns overflow). Built-in roles are always
 * read-only; custom roles get edit + delete affordances in their header when the
 * caller holds `roles.manage`.
 */
function RolesMatrix({
	orgId,
	roles,
	canManage,
}: {
	orgId: string;
	roles: OrgRoleDef[];
	canManage: boolean;
}) {
	const queryClient = useQueryClient();
	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: ["workspace-roles", orgId] });

	const createMutation = useMutation({
		mutationFn: (values: RoleFormValues) => createRole(orgId, values),
		onSuccess: async () => {
			await invalidate();
			sileo.success({ title: "Role created" });
		},
		onError: (e: unknown) => {
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
		onError: (e: unknown) => {
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
		onError: (e: unknown) => {
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to delete role",
			});
		},
	});

	return (
		<SettingsSection
			caption="Every role and the permissions it grants. Built-in roles are fixed; create custom roles to grant a precise subset, then assign them to members below."
			headerAction={
				canManage ? (
					<RoleFormDialog
						mode="create"
						onSubmit={(values) => createMutation.mutateAsync(values)}
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
			<div className="px-3">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="sticky left-0 bg-background">
								Permission
							</TableHead>
							{roles.map((role) => (
								<TableHead className="text-center" key={role.key}>
									<div className="flex flex-col items-center gap-1">
										<span className="flex items-center gap-1">
											{role.name}
											{role.builtin ? (
												<Badge className="text-[10px]" variant="outline">
													built-in
												</Badge>
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
													onSubmit={(values) =>
														updateMutation.mutateAsync(values)
													}
													trigger={
														<Button
															aria-label={`Edit ${role.name}`}
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
													aria-label={`Delete ${role.name}`}
													disabled={deleteMutation.isPending}
													onClick={() => deleteMutation.mutate(role.key)}
													size="icon"
													variant="ghost"
												>
													<HugeiconsIcon
														className="size-3.5 text-destructive"
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
								<TableCell className="sticky left-0 bg-background font-mono text-muted-foreground text-xs">
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
			</div>
		</SettingsSection>
	);
}

/**
 * Per-member custom-role assignment. Shows the member's assigned custom roles as
 * badges; when the caller holds `roles.manage`, a popover toggles the assignment
 * set. Built-in tier is unaffected (that lives on the Better Auth membership row);
 * this only layers custom roles on top.
 */
function MemberRolesControl({
	orgId,
	userId,
	customRoles,
	canManage,
}: {
	orgId: string;
	userId: string;
	customRoles: OrgRoleDef[];
	canManage: boolean;
}) {
	const queryClient = useQueryClient();
	const assignedQuery = useQuery({
		enabled: customRoles.length > 0,
		queryKey: ["workspace-member-roles", orgId, userId],
		queryFn: () => getMemberRoles(orgId, userId),
	});
	const assigned = assignedQuery.data ?? [];

	const setMutation = useMutation({
		mutationFn: (roleKeys: string[]) =>
			setMemberRoles(orgId, userId, roleKeys),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["workspace-member-roles", orgId, userId],
			});
		},
		onError: (e: unknown) => {
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to update assignment",
			});
		},
	});

	const toggle = (roleKey: string, checked: boolean) => {
		const next = checked
			? [...assigned, roleKey]
			: assigned.filter((k) => k !== roleKey);
		setMutation.mutate(next);
	};

	if (customRoles.length === 0) {
		return null;
	}

	const assignedRoles = customRoles.filter((r) => assigned.includes(r.key));

	return (
		<div className="flex items-center gap-1.5">
			{assignedRoles.map((r) => (
				<Badge className="text-xs" key={r.key} variant="secondary">
					{r.name}
				</Badge>
			))}
			{canManage ? (
				<Popover>
					<PopoverTrigger
						render={
							<Button size="sm" variant="ghost">
								<HugeiconsIcon className="size-3.5" icon={Shield01Icon} />
								Roles
							</Button>
						}
					/>
					<PopoverContent align="end" className="w-64">
						<div className="flex flex-col gap-1">
							<p className="px-1 pb-1 font-medium text-sm">Custom roles</p>
							{customRoles.map((r) => (
								<label
									className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
									key={r.key}
								>
									<Checkbox
										checked={assigned.includes(r.key)}
										disabled={setMutation.isPending}
										onCheckedChange={(checked) =>
											toggle(r.key, checked === true)
										}
									/>
									<span>{r.name}</span>
								</label>
							))}
						</div>
					</PopoverContent>
				</Popover>
			) : null}
		</div>
	);
}

/**
 * The Workspace section of the Gateway dialog: settings for the current
 * organization (workspace) that shares this Core node.
 *
 * Shows the workspace identity (copyable org id), the caller's own user id, the
 * member roster with each member's role + custom-role assignments, a role/
 * permission matrix, and a link out to the web org page for inviting / changing
 * built-in roles (owned by Better Auth's organization plugin).
 *
 * "Workspace" here is the org in the Notion/Discord sense — NOT the local
 * project-folder `useWorkspaceStore`. A company running one shared "company
 * brain" node is one workspace; its members' roles (owner/admin/member/viewer)
 * plus any custom roles govern who can manage the org and change policy on this
 * node.
 */
export function WorkspaceSection() {
	const { data: session } = useSession();
	const userId = session?.user?.id ?? null;
	const authed = hasOrgAuth();

	const orgsQuery = useQuery({
		enabled: authed,
		queryKey: ["workspace-orgs"],
		queryFn: fetchOrgs,
	});

	const orgs = orgsQuery.data ?? [];
	const primaryOrg = orgs[0] ?? null;
	const orgId = primaryOrg?.id ?? null;

	const membersQuery = useQuery({
		enabled: authed && Boolean(orgId),
		queryKey: ["workspace-members", orgId],
		queryFn: () => fetchOrgMembers(orgId as string),
	});

	const rolesQuery = useQuery({
		enabled: authed && Boolean(orgId),
		queryKey: ["workspace-roles", orgId],
		queryFn: () => listRoles(orgId as string),
	});

	const permissionsQuery = useQuery({
		enabled: authed && Boolean(orgId),
		queryKey: ["workspace-my-permissions", orgId],
		queryFn: () => fetchMyPermissions(orgId as string),
	});

	const canManageRoles = (permissionsQuery.data ?? []).includes(ROLES_MANAGE);
	const roles = rolesQuery.data ?? [];
	const customRoles = roles.filter((r) => !r.builtin);

	const members = [...(membersQuery.data ?? [])].sort(
		(a, b) => ROLE_RANK[a.role ?? "member"] - ROLE_RANK[b.role ?? "member"]
	);

	if (!authed) {
		return (
			<SettingsSection title="Workspace">
				<p className="px-3 text-muted-foreground text-sm">
					Sign in to view this workspace and its members.
				</p>
			</SettingsSection>
		);
	}

	if (orgsQuery.isLoading) {
		return (
			<SettingsSection title="Workspace">
				<div className="flex h-24 items-center justify-center">
					<Spinner className="size-4" />
				</div>
			</SettingsSection>
		);
	}

	return (
		<div className="space-y-6">
			<SettingsSection
				caption="The organization that shares this node. Its members and their roles govern who can manage the workspace."
				title="Workspace"
			>
				<SettingsGroup>
					<SettingsItem
						description={
							primaryOrg
								? `You are ${primaryOrg.role ?? "a member"} of this workspace.`
								: "You are not in an organization yet. Create one to share this node with a team."
						}
						title={
							<span className="flex items-center gap-2">
								<HugeiconsIcon
									className="size-4 text-muted-foreground"
									icon={UserGroupIcon}
								/>
								{primaryOrg?.name ?? "Personal"}
								{primaryOrg ? <RoleBadge role={primaryOrg.role} /> : null}
							</span>
						}
					/>
					{primaryOrg ? (
						<SettingsItem
							actions={
								<CopyableId label="organization ID" value={primaryOrg.id} />
							}
							description="Identifies this workspace across surfaces and in support requests."
							title="Organization ID"
						/>
					) : null}
					{userId ? (
						<SettingsItem
							actions={<CopyableId label="user ID" value={userId} />}
							description="Your account's stable identifier."
							title="Your user ID"
						/>
					) : null}
				</SettingsGroup>
			</SettingsSection>

			{primaryOrg && orgId ? (
				<SettingsSection
					caption="Everyone in this workspace. Owners and admins manage members and billing; assign custom roles for finer-grained permissions."
					title="Members"
				>
					{membersQuery.isLoading ? (
						<div className="flex h-16 items-center justify-center">
							<Spinner className="size-4" />
						</div>
					) : (
						<SettingsGroup>
							{members.map((m) => (
								<SettingsItem
									actions={
										<div className="flex items-center gap-2">
											<MemberRolesControl
												canManage={canManageRoles}
												customRoles={customRoles}
												orgId={orgId}
												userId={m.userId}
											/>
											<RoleBadge role={m.role} />
										</div>
									}
									description={m.userId}
									key={m.userId}
									title={
										<span className="flex items-center gap-2">
											{m.userId}
											{m.userId === userId ? (
												<Badge className="text-xs" variant="outline">
													You
												</Badge>
											) : null}
										</span>
									}
								/>
							))}
							<SettingsItem
								actions={
									<Button
										onClick={() => {
											openExternal(ORGANIZATIONS_URL).catch(() => undefined);
										}}
										size="sm"
										variant="ghost"
									>
										Manage members
									</Button>
								}
								description="Invite people, change built-in roles, or remove members on the web."
								title="Invite & roles"
							/>
						</SettingsGroup>
					)}
				</SettingsSection>
			) : null}

			{primaryOrg && orgId ? (
				rolesQuery.isLoading ? (
					<SettingsSection title="Roles">
						<div className="flex h-16 items-center justify-center">
							<Spinner className="size-4" />
						</div>
					</SettingsSection>
				) : (
					<RolesMatrix
						canManage={canManageRoles}
						orgId={orgId}
						roles={roles}
					/>
				)
			) : null}

			{orgs.length > 1 ? (
				<SettingsSection
					caption="Other organizations you belong to."
					title="Your organizations"
				>
					<SettingsGroup>
						{orgs.slice(1).map((org) => (
							<SettingsItem
								actions={<CopyableId label="organization ID" value={org.id} />}
								description={`You are ${org.role ?? "a member"}.`}
								key={org.id}
								title={org.name}
							/>
						))}
					</SettingsGroup>
				</SettingsSection>
			) : null}
		</div>
	);
}
