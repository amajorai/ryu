// apps/desktop/src/hooks/useOrgFeatures.ts
//
// Feature-detect organization toggles (`apps.install`, `plugins.marketplace`,
// `engines.update`, ...) on the active node. Core is the enforcement boundary;
// this hook only lets the UI hide or disable controls the organization turned
// off. Until the first answer arrives (or on an older Core without the route)
// everything reads as enabled, matching an unmanaged node.

import { useQuery } from "@tanstack/react-query";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchOrgFeatures,
	isOrgFeatureEnabled,
	type OrgFeatureKey,
	UNMANAGED_ORG_FEATURES,
} from "@/src/lib/api/org-features.ts";
import { useActiveNode } from "./useActiveNode.ts";

const REFRESH_MS = 60_000;

export function useOrgFeatures() {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		token: activeNode.token ?? null,
		url: activeNode.url,
		userJwt: activeNode.userJwt ?? null,
	};
	const query = useQuery({
		queryFn: ({ signal }) => fetchOrgFeatures(target, signal),
		queryKey: [
			"org-features",
			target.url,
			target.token ?? null,
			target.userJwt ?? null,
		],
		refetchInterval: REFRESH_MS,
		retry: false,
		staleTime: REFRESH_MS / 2,
	});
	const features = query.data ?? UNMANAGED_ORG_FEATURES;
	return {
		features,
		isEnabled: (key: OrgFeatureKey) => isOrgFeatureEnabled(features, key),
	};
}
