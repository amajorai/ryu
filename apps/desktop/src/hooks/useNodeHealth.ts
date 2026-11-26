import { useQuery } from "@tanstack/react-query";
import { fetchHealth, type HealthResult } from "@/src/lib/api/system.ts";
import {
	CLIENT_ACCEPTED_RANGE,
	negotiateProtocol,
	type ProtocolVerdict,
} from "@/src/lib/node-compat.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

export type NodeHealth = HealthResult & {
	/** Whether this app and the active node share a protocol. */
	compatible: boolean;
	/** The highest shared protocol, or the side that has to update. */
	protocolVerdict: ProtocolVerdict;
};

/**
 * Polls the active node's `/api/health` for its version, protocol range and
 * advertised capabilities, and negotiates the protocol against the range this
 * app accepts. Drives the "needs updating" card and capability-based feature
 * gating.
 */
export function useNodeHealth() {
	const node = useNodeStore((state) => state.getActiveNode());

	return useQuery<NodeHealth>({
		// Health uses the node bearer but deliberately skips caller-JWT auth.
		queryKey: ["node-health", node?.url, node?.token ?? null],
		enabled: Boolean(node?.url),
		refetchInterval: 30_000,
		queryFn: async ({ signal }) => {
			const health = await fetchHealth(
				{
					url: node.url,
					token: node.token ?? null,
					userJwt: node.userJwt ?? null,
				},
				signal
			);
			const protocolVerdict = negotiateProtocol(
				CLIENT_ACCEPTED_RANGE,
				health.protocol
			);
			return {
				...health,
				compatible: protocolVerdict.compatible,
				protocolVerdict,
			};
		},
	});
}
