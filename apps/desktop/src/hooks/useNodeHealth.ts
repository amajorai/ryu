import { useQuery } from "@tanstack/react-query";
import { fetchHealth, type HealthResult } from "@/src/lib/api/system.ts";
import { isNodeCompatible } from "@/src/lib/node-compat.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

export type NodeHealth = HealthResult & {
	/** Whether the active node meets the desktop's minimum-version floor. */
	compatible: boolean;
};

/**
 * Polls the active node's `/api/health` for its version + advertised capabilities,
 * and derives compatibility against the desktop's minimum-version floor. Drives the
 * compatibility banner and capability-based feature gating.
 */
export function useNodeHealth() {
	const getActiveNode = useNodeStore((s) => s.getActiveNode);
	const node = getActiveNode();

	return useQuery<NodeHealth>({
		queryKey: ["node-health", node?.url],
		enabled: Boolean(node?.url),
		refetchInterval: 30_000,
		queryFn: async () => {
			const health = await fetchHealth({
				url: node.url,
				token: node.token ?? null,
			});
			return { ...health, compatible: isNodeCompatible(health.version) };
		},
	});
}
