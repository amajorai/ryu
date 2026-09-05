import { useQuery } from "@tanstack/react-query";
import { hasOrgAuth, listOrgs, type OrgListEntry } from "@/src/lib/api/orgs.ts";
import { queryClient as appQueryClient } from "@/src/lib/query-client.ts";
import { isOrganizationAdminRole } from "@/src/lib/resource-visibility.ts";

const ORG_LIST_KEY = ["settings", "orgs"] as const;

export function canAccessConsoleForNode({
	managed,
	orgId,
	organizations,
	settled,
}: {
	managed: boolean;
	orgId: string | null | undefined;
	organizations: OrgListEntry[] | undefined;
	settled: boolean;
}): boolean {
	// Local, LAN, and self-hosted nodes have no organization authority to check;
	// their owner already has the existing Console surface.
	if (!managed) {
		return true;
	}
	if (!(settled && orgId && organizations)) {
		return false;
	}
	const organization = organizations.find(
		(candidate) => candidate.id === orgId
	);
	return organization ? isOrganizationAdminRole(organization.role) : false;
}

/** Server-backed visibility gate for the Bot → Console product switch. */
export function useConsoleAccess(node: {
	managed?: boolean;
	orgId?: string | null;
}): {
	canSwitchToConsole: boolean;
	consoleOnly: boolean;
	loading: boolean;
} {
	const authenticated = hasOrgAuth();
	const organizationsQuery = useQuery(
		{
			enabled: authenticated,
			queryFn: listOrgs,
			queryKey: ORG_LIST_KEY,
		},
		appQueryClient
	);
	const managed = node.managed === true;
	const loading =
		managed &&
		authenticated &&
		!organizationsQuery.isSuccess &&
		!organizationsQuery.isError;

	return {
		canSwitchToConsole: canAccessConsoleForNode({
			managed,
			orgId: node.orgId,
			organizations: organizationsQuery.data,
			settled: organizationsQuery.isSuccess,
		}),
		consoleOnly: !managed,
		loading,
	};
}
