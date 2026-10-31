// apps/desktop/src/hooks/useNodeVersion.ts
//
// Per-node installed version + update verdict for the node selector. Core/Gateway
// ship as one release train (a single `vX.Y.Z` tag bundles every binary), so a
// single query against the node drives both the version badge on the Core and
// Gateway rows and the shared app-wide "Update available" action. Core owns the
// verdict (`/api/update/check`); the install is the native tauri updater for a
// local node, and the node's own `POST /api/update/apply` for a remote one.
// Gated on `enabled` so it never fires at an unreachable node.

import { useLiteralMessages } from "@ryu/i18n/react";
import { useQuery } from "@tanstack/react-query";

import { sileo } from "sileo";
import { applyReleaseUpdate } from "@/src/components/updater/AutoUpdater.tsx";
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
	const tl = useLiteralMessages();
	const { data } = useQuery({
		queryKey: [
			"node-version",
			target.url,
			target.token ?? null,
			target.userJwt ?? null,
		],
		queryFn: async ({ signal }) => {
			// Version is best-effort (an older Core may lack `/api/version`); the
			// update check already fails soft to a "no update" verdict.
			const [info, check] = await Promise.all([
				getVersionInfo(target, signal).catch(() => null),
				checkForUpdate(target, { signal }),
			]);
			return { info, check };
		},
		enabled,
		subscribed: enabled,
		refetchInterval: REFRESH_MS,
		retry: false,
	});

	const check = data?.check ?? null;
	return {
		version: data?.info?.ryu_version ?? null,
		updateAvailable: check?.update_available ?? false,
		update: async () => {
			if (!check?.update_available) {
				return;
			}
			// A remote node updates ITSELF; only a local one is the app this
			// updater ships inside. `applyReleaseUpdate` owns that choice.
			try {
				const message = await applyReleaseUpdate(
					target,
					{ url: target.url },
					check,
					tl
				);
				if (message) {
					sileo.success({ title: "Update started", description: message });
				}
			} catch (err) {
				sileo.error({
					title: "Update failed",
					description: err instanceof Error ? err.message : String(err),
					duration: null,
				});
			}
		},
	};
}
