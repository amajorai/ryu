import { skipToken, useQuery } from "@tanstack/react-query";
import { fetchMyPermissions, type Permission } from "@/src/lib/api/org.ts";
import { hasOrgAuth } from "@/src/lib/api/orgs.ts";
import { queryClient as appQueryClient } from "@/src/lib/query-client.ts";

/**
 * The effective permission that admits a caller to Console on a Ryu-managed
 * node. It is the same permission Core and the control plane enforce on node
 * configuration (Gateway, MCP servers, shared vault values), so the product
 * switch can never offer a surface whose writes the server would refuse. Custom
 * roles that grant it admit their holders; built-in members and viewers lack it.
 */
export const CONSOLE_PERMISSION: Permission = "gateway.configure";

export function canAccessConsoleForNode({
	managed,
	orgId,
	permissions,
	settled,
}: {
	managed: boolean;
	orgId: string | null | undefined;
	permissions: readonly string[] | undefined;
	settled: boolean;
}): boolean {
	// Local, LAN, and self-hosted nodes have no organization authority to check;
	// their owner already has the existing Console surface.
	if (!managed) {
		return true;
	}
	if (!(settled && orgId && permissions)) {
		return false;
	}
	return permissions.includes(CONSOLE_PERMISSION);
}

export interface ConsoleAccessResult {
	canSwitchToConsole: boolean;
	consoleOnly: boolean;
	loading: boolean;
}

/** Server-backed visibility gate for the Bot → Console product switch. */
export function useConsoleAccess(node: {
	managed?: boolean;
	orgId?: string | null;
}): ConsoleAccessResult {
	const authenticated = hasOrgAuth();
	const managed = node.managed === true;
	const orgId = node.orgId ?? null;
	// The control plane answers 403 for a caller outside the node's org, which
	// leaves the query errored and Console closed.
	const permissionsQuery = useQuery(
		{
			enabled: authenticated && managed && orgId !== null,
			queryFn: orgId === null ? skipToken : () => fetchMyPermissions(orgId),
			queryKey: ["workspace-my-permissions", orgId],
		},
		appQueryClient
	);
	const loading =
		managed &&
		authenticated &&
		orgId !== null &&
		!permissionsQuery.isSuccess &&
		!permissionsQuery.isError;

	return {
		canSwitchToConsole: canAccessConsoleForNode({
			managed,
			orgId,
			permissions: permissionsQuery.data,
			settled: permissionsQuery.isSuccess,
		}),
		consoleOnly: !managed,
		loading,
	};
}
