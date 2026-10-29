import { useQuery } from "@tanstack/react-query";
import { hasOrgAuth, listOrgs, useActiveOrgId } from "@/src/lib/api/orgs.ts";
import { queryClient as appQueryClient } from "@/src/lib/query-client.ts";
import { isOrganizationAdminRole } from "@/src/lib/resource-visibility.ts";

const ORG_LIST_KEY = ["settings", "orgs"] as const;

export interface VisibilityAdminAccess {
	canMakePrivate: boolean;
	role: string | null;
}

/**
 * UI courtesy for the admin-only shared → private transition.
 *
 * Core remains the authority. While the role query is loading, this returns
 * `true` so a local/unbound node is not accidentally treated as organization
 * scoped; a bound Core request still rejects a non-admin at the mutation
 * boundary.
 */
export function useVisibilityAdminAccess(): VisibilityAdminAccess {
	const authed = hasOrgAuth();
	const activeOrgId = useActiveOrgId();
	const orgsQuery = useQuery(
		{
			enabled: authed,
			queryFn: listOrgs,
			queryKey: ORG_LIST_KEY,
		},
		appQueryClient
	);
	const organization =
		orgsQuery.data?.find((org) => org.id === activeOrgId) ??
		orgsQuery.data?.[0] ??
		null;
	const role = organization?.role ?? null;
	const scopedOrganization = Boolean(organization?.id || activeOrgId);

	return {
		canMakePrivate:
			authed && scopedOrganization && orgsQuery.isSuccess
				? isOrganizationAdminRole(role)
				: true,
		role,
	};
}
