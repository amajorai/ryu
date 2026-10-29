import { skipToken, useQuery } from "@tanstack/react-query";
import {
	fetchMyPermissions,
	fetchOrgs,
	hasOrgAuth,
	type Permission,
} from "@/src/lib/api/org.ts";
import { useActiveOrgId } from "@/src/lib/api/orgs.ts";

/**
 * Whether the signed-in caller may change gateway policy in their workspace.
 * Local and unidentified nodes fail open; the Gateway remains the enforcement
 * point and rejects a write if the caller is not allowed to make it.
 */
export function useCanManagePermission(permission: Permission): boolean {
	const authed = hasOrgAuth();
	const activeOrgId = useActiveOrgId();
	const orgsQuery = useQuery({
		enabled: authed,
		queryKey: ["workspace-orgs"],
		queryFn: fetchOrgs,
	});
	const orgs = orgsQuery.data ?? [];
	const orgId =
		orgs.find((org) => org.id === activeOrgId)?.id ?? orgs[0]?.id ?? null;
	const permissionsQuery = useQuery({
		enabled: authed && Boolean(orgId),
		queryKey: ["workspace-my-permissions", orgId],
		queryFn:
			orgId === null || orgId === undefined
				? skipToken
				: () => fetchMyPermissions(orgId),
	});
	if (!(permissionsQuery.isSuccess && permissionsQuery.data)) {
		return true;
	}
	return permissionsQuery.data.includes(permission);
}

export function useGatewayConfigurable(): boolean {
	return useCanManagePermission("gateway.configure");
}
