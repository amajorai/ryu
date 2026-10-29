// apps/desktop/src/hooks/useNodeOnline.ts
//
// Reachability of one configured computer, shared by every surface that shows
// a status dot for it (the "All computers" sidebar groups, the composer's
// computer chip). The probe is the same one the computer selector's rows run —
// native `test_node` every 15 seconds — lifted into react-query so two surfaces
// showing the same computer share one probe instead of each running a timer.
//
// Outside Tauri (web shell, stories) there is no native probe; the hook falls
// back to Core's unauthenticated `/api/health`. A managed (cloud) computer is
// memory-only and never in the native nodes file, so it always uses the health
// probe.

import { useQuery } from "@tanstack/react-query";
import { toTarget } from "@/src/lib/api/client.ts";
import { fetchHealth } from "@/src/lib/api/system.ts";
import {
	invokeWhenReady,
	TauriUnavailableError,
} from "@/src/lib/tauri-ready.ts";
import type { Node } from "@/src/store/useNodeStore.ts";

export const NODE_ONLINE_INTERVAL_MS = 15_000;

async function healthProbe(node: Node, signal?: AbortSignal): Promise<boolean> {
	try {
		await fetchHealth(toTarget(node), signal);
		return true;
	} catch {
		return false;
	}
}

/** One reachability check. Never throws: unreachable is `false`. */
export async function probeNodeOnline(
	node: Node,
	signal?: AbortSignal
): Promise<boolean> {
	if (node.managed) {
		return healthProbe(node, signal);
	}
	try {
		const result = await invokeWhenReady<{ online: boolean }>("test_node", {
			name: node.name,
		});
		return result.online === true;
	} catch (error) {
		if (error instanceof TauriUnavailableError) {
			return healthProbe(node, signal);
		}
		return false;
	}
}

/** `true` online, `false` offline, `null` before the first answer. */
export function useNodeOnline(node: Node | undefined): boolean | null {
	const { data } = useQuery({
		queryKey: ["node-online", node?.name ?? ""],
		queryFn: ({ signal }) =>
			node ? probeNodeOnline(node, signal) : Promise.resolve(false),
		enabled: node !== undefined,
		refetchInterval: NODE_ONLINE_INTERVAL_MS,
		// The probe IS the reachability answer; a LAN computer is reachable even
		// when the browser reports no internet.
		networkMode: "always",
		retry: false,
	});
	return data ?? null;
}
