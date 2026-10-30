import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { sileo } from "sileo";
import { FRONTEND_URL, useSession } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
import { CopyableId } from "@/src/components/settings/shared/CopyableId.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	fetchMyPermissions,
	fetchOrgMembers,
	fetchOrgs,
	hasOrgAuth,
	listRoles,
	type OrgRole,
	type Permission,
} from "@/src/lib/api/org.ts";
// A different module from `org.ts`: `orgs.ts` owns the SESSION's active
// org, which `org.ts` (the org list + RBAC routes) has no accessor for.
import {
	listMyOrganizationTeams,
	setActiveTeam,
	useActiveOrgId,
	useActiveTeamId,
} from "@/src/lib/api/orgs.ts";
import { NodeOrganizationBindingCard } from "./NodeOrganizationBindingCard.tsx";
import { MemberRolesControl } from "./WorkspaceSection-member-roles.tsx";
import { LoadErrorRow, RoleBadge } from "./WorkspaceSection-role-badge.tsx";
import { RolesMatrix } from "./WorkspaceSection-roles-matrix.tsx";

/** Where members are invited / roles changed (Better Auth owns those mutations). */
const ORGANIZATIONS_URL = `${FRONTEND_URL.replace(/\/$/, "")}/organizations`;

/** The RBAC permission that authorizes managing custom roles + assignments. */
const ROLES_MANAGE: Permission = "roles.manage";
const NO_ACTIVE_TEAM = "__no_active_team__";

/** Rank so the roster reads owner → admin → member → viewer. */
const ROLE_RANK = {
	owner: 0,
	admin: 1,
	member: 2,
	viewer: 3,
} satisfies Record<Exclude<OrgRole, null>, number>;

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
	const stepUp = useStepUp();
	const tl = useLiteralMessages();

	const orgsQuery = useQuery({
		enabled: authed,
		queryKey: ["workspace-orgs"],
		queryFn: fetchOrgs,
	});

	const orgs = orgsQuery.data ?? [];
	const activeOrgId = useActiveOrgId();
	// The org this SESSION is scoped to, not the first membership. `orgs[0]` was
	// the server's own fallback for a session with no active org (the earliest
	// membership), which is exactly why it looked right until someone switched
	// workspace: from then on this section showed the previous org's roster and
	// role matrix while every other org-scoped surface had moved on. The fallback
	// is kept, but only as the fallback it always was.
	const activeOrg =
		orgs.find((org) => org.id === activeOrgId) ?? orgs[0] ?? null;
	const orgId = activeOrg?.id ?? null;
	const activeTeamId = useActiveTeamId();
	// Everything except the one shown above. Computed here so the section's own
	// visibility test is the list it renders: `orgs.length > 1` was equivalent
	// only while the org above was always `orgs[0]`, and would otherwise be able
	// to open an empty group.
	const otherOrgs = orgs.filter((org) => org.id !== orgId);

	const membersQuery = useQuery({
		enabled: authed && Boolean(orgId),
		queryKey: ["workspace-members", orgId],
		queryFn:
			orgId === null || orgId === undefined
				? skipToken
				: () => fetchOrgMembers(orgId),
	});

	const rolesQuery = useQuery({
		enabled: authed && Boolean(orgId),
		queryKey: ["workspace-roles", orgId],
		queryFn:
			orgId === null || orgId === undefined
				? skipToken
				: () => listRoles(orgId),
	});

	const permissionsQuery = useQuery({
		enabled: authed && Boolean(orgId),
		queryKey: ["workspace-my-permissions", orgId],
		queryFn:
			orgId === null || orgId === undefined
				? skipToken
				: () => fetchMyPermissions(orgId),
	});

	const teamsQuery = useQuery({
		enabled: authed && Boolean(orgId),
		queryKey: ["workspace-org-teams", orgId],
		queryFn:
			orgId === null || orgId === undefined
				? skipToken
				: () => listMyOrganizationTeams(orgId),
	});

	const activeTeamMutation = useMutation({
		mutationFn: setActiveTeam,
		onError: (error) =>
			sileo.error({
				title: error instanceof Error ? error.message : "Couldn't switch team",
			}),
	});

	const canManageRoles = (permissionsQuery.data ?? []).includes(ROLES_MANAGE);
	const roles = rolesQuery.data ?? [];
	const customRoles = roles.filter((r) => !r.builtin);

	const members = [...(membersQuery.data ?? [])].sort(
		(a, b) => ROLE_RANK[a.role ?? "member"] - ROLE_RANK[b.role ?? "member"]
	);
	const teams = teamsQuery.data ?? [];
	const selectedTeamId = teams.some((team) => team.id === activeTeamId)
		? activeTeamId
		: NO_ACTIVE_TEAM;

	if (!authed) {
		return (
			<SettingsSection title="Workspace">
				<SettingsCard className="py-3 text-muted-foreground text-sm">
					Sign in to view this workspace and its members.
				</SettingsCard>
			</SettingsSection>
		);
	}

	if (orgsQuery.isLoading) {
		return (
			<SettingsSection title="Workspace">
				<SettingsCard>
					<SkeletonRows spacing="spacious" />
				</SettingsCard>
			</SettingsSection>
		);
	}

	if (orgsQuery.isError) {
		return (
			<SettingsSection title="Workspace">
				<LoadErrorRow
					detail={orgsQuery.error.message}
					message="Couldn’t load your organizations."
					onRetry={() => void orgsQuery.refetch()}
					retryLabel="Retry organization list"
				/>
			</SettingsSection>
		);
	}

	return (
		<div className="flex flex-col gap-8 [&>*]:mt-0">
			{stepUp.dialog}
			<SettingsSection
				caption={
					<CaptionInfo
						detail={
							"Its members and their roles govern who can manage the workspace."
						}
					>
						{"The organization that shares this node."}
					</CaptionInfo>
				}
				title="Workspace"
			>
				<SettingsGroup>
					<SettingsItem
						description={
							activeOrg
								? tl("You are {role} of this workspace.", {
										role: activeOrg.role ?? tl("a member"),
									})
								: "You are not in an organization yet. Create one to share this node with a team."
						}
						title={
							<span className="flex items-center gap-2">
								<HugeiconsIcon
									className="size-4 text-muted-foreground"
									icon={UserGroupIcon}
								/>
								{activeOrg?.name ?? "Personal"}
								{activeOrg ? <RoleBadge role={activeOrg.role} /> : null}
							</span>
						}
					/>
					{activeOrg ? (
						<SettingsItem
							actions={
								<CopyableId label="organization ID" value={activeOrg.id} />
							}
							description="Identifies this workspace across surfaces and in support requests."
							title="Organization ID"
						/>
					) : null}
					{activeOrg ? (
						<SettingsItem
							actions={
								teamsQuery.isError ? (
									<div className="flex flex-col items-end gap-2">
										<p
											className="text-right text-status-destructive text-xs"
											role="alert"
										>
											Couldn’t load teams.
										</p>
										<Button
											onClick={() => void teamsQuery.refetch()}
											size="sm"
											variant="outline"
										>
											Retry teams
										</Button>
									</div>
								) : (
									<Select
										disabled={
											teamsQuery.isLoading ||
											teams.length === 0 ||
											activeTeamMutation.isPending
										}
										items={[
											{ label: "No active team", value: NO_ACTIVE_TEAM },
											...teams.map((team) => ({
												label: team.name,
												value: team.id,
											})),
										]}
										onValueChange={(value) => {
											activeTeamMutation.mutate(
												value === NO_ACTIVE_TEAM ? null : value
											);
										}}
										value={selectedTeamId}
									>
										<SelectTrigger
											aria-label="Active team"
											className="h-8 w-48"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={NO_ACTIVE_TEAM}>
												No active team
											</SelectItem>
											{teams.map((team) => (
												<SelectItem key={team.id} value={team.id}>
													{team.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)
							}
							description="Persisted by Better Auth for team-aware organization requests."
							title="Active team"
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

			<NodeOrganizationBindingCard organizations={orgs} />

			{activeOrg && orgId ? (
				<SettingsSection
					caption={
						<CaptionInfo
							detail={
								"Owners and admins manage members and billing; assign custom roles for finer-grained permissions."
							}
						>
							{"Everyone in this workspace."}
						</CaptionInfo>
					}
					title="Members"
				>
					{membersQuery.isLoading ? (
						<SettingsCard>
							<SkeletonRows spacing="spacious" />
						</SettingsCard>
					) : membersQuery.isError ? (
						<LoadErrorRow
							detail={membersQuery.error.message}
							message="Couldn’t load workspace members."
							onRetry={() => void membersQuery.refetch()}
							retryLabel="Retry member list"
						/>
					) : (
						<SettingsGroup>
							{permissionsQuery.isError ? (
								<LoadErrorRow
									message="Couldn’t load workspace permissions. Role editing is paused."
									onRetry={() => void permissionsQuery.refetch()}
									retryLabel="Retry permissions"
								/>
							) : null}
							{members.length === 0 ? (
								<SettingsItem
									title={
										<span className="text-muted-foreground">
											No members yet.
										</span>
									}
								/>
							) : null}
							{members.map((m) => (
								<SettingsItem
									actions={
										<div className="flex items-center gap-2">
											<MemberRolesControl
												canManage={canManageRoles}
												customRoles={customRoles}
												orgId={orgId}
												stepUp={stepUp}
												userId={m.userId}
											/>
											<RoleBadge role={m.role} />
										</div>
									}
									key={m.userId}
									title={
										<span className="flex items-center gap-2">
											{m.userId}
											{m.userId === userId ? (
												<span className="text-muted-foreground text-xs">
													You
												</span>
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

			{activeOrg && orgId ? (
				rolesQuery.isLoading ? (
					<SettingsSection title="Roles">
						<SettingsCard>
							<SkeletonRows spacing="spacious" />
						</SettingsCard>
					</SettingsSection>
				) : rolesQuery.isError ? (
					<SettingsSection title="Roles">
						<LoadErrorRow
							detail={rolesQuery.error.message}
							message="Couldn’t load workspace roles."
							onRetry={() => void rolesQuery.refetch()}
							retryLabel="Retry roles"
						/>
					</SettingsSection>
				) : (
					<RolesMatrix
						canManage={canManageRoles}
						orgId={orgId}
						roles={roles}
						stepUp={stepUp}
					/>
				)
			) : null}

			{otherOrgs.length > 0 ? (
				<SettingsSection
					caption="Other organizations you belong to."
					title="Your organizations"
				>
					<SettingsGroup>
						{otherOrgs.map((org) => (
							<SettingsItem
								actions={
									<span className="flex items-center gap-2">
										<RoleBadge role={org.role} />
										<CopyableId label="organization ID" value={org.id} />
									</span>
								}
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
