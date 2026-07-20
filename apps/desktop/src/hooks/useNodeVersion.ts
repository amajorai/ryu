// apps/desktop/src/hooks/useNodeVersion.ts
//
// Per-node installed version + update verdict for the node selector. Core/Gateway
// ship as one release train (a single `vX.Y.Z` tag bundles every binary), so a
// single query against the node drives both the version badge on the Core and
// Gateway rows and the shared app-wide "Update available" action. Core owns the
// verdict (`/api/update/check`); the install itself is the native tauri updater.
// Gated on `enabled` so it never fires at an unreachable node.

import { useQuery } from "@tanstack/react-query";

import { installUpdate } from "@/src/components/updater/AutoUpdater.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { checkForUpdate, getVersionInfo } from "@/src/lib/api/update.ts";

const REFRESH_MS = 60_000;

export interface NodeVersion {
	/** Trigger the native app-wide install. No-op when no update is available. */
	update: () => Promise<void>;
	/** Whether Core reports a newer release than what's installed. */
	updateAvailable: boolean;
	/** Installed Ryu version (single release train), or null when unavailable. */
	version: string | null;
}

export function useNodeVersion(
	target: ApiTarget,
	enabled: boolean
): NodeVersion {
	const { data } = useQuery({
		queryKey: ["node-version", target.url],
		queryFn: async () => {
			// Version is best-effort (an older Core may lack `/api/version`); the
			// update check already fails soft to a "no update" verdict.
			const [info, check] = await Promise.all([
				getVersionInfo(target).catch(() => null),
				checkForUpdate(target),
			]);
			return { info, check };
		},
		enabled,
		refetchInterval: REFRESH_MS,
		retry: false,
	});

	const check = data?.check ?? null;
	return {
		version: data?.info?.ryu_version ?? null,
		updateAvailable: check?.update_available ?? false,
		update: async () => {
			if (check?.update_available) {
				await installUpdate(check);
			}
		},
	};
}
