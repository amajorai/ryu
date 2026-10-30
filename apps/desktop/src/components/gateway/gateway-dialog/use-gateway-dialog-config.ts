import { useEffect, useState } from "react";
import type { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { GatewayProvidersConfig } from "@/src/lib/api/gateway.ts";
import { fetchGatewayConfig } from "@/src/lib/api/gateway.ts";

/**
 * The gateway dialog's view of the node's provider config: loaded while the
 * dialog is open and the gateway reachable, and refreshed together with the
 * gateway status by `refreshWithConfig`.
 */
export function useGatewayDialogConfig({
	getActiveNode,
	open,
	reachable,
	refresh,
	target,
}: {
	getActiveNode: ReturnType<typeof useActiveNodeGetter>;
	open: boolean;
	reachable: boolean;
	refresh: () => Promise<void>;
	target: ApiTarget;
}) {
	const [configProviders, setConfigProviders] =
		useState<GatewayProvidersConfig | null>(null);
	const [configRevision, setConfigRevision] = useState<string | null>(null);
	const [webServiceSchema, setWebServiceSchema] = useState<
		number | undefined
	>();
	const [appliedProviderRevision, setAppliedProviderRevision] = useState<
		string | null | undefined
	>(undefined);
	// The loaded config belongs to one dialog session on one node: forget it only
	// when the dialog opens/closes or the target changes (reset during render, so
	// no frame shows another node's config). A status poll that briefly reports
	// the gateway unreachable (e.g. while it restarts after "Apply saved
	// connections") keeps the last-known config mounted; clearing it would unmount
	// the account sections and discard typed-but-unsaved credential drafts.
	const configOwner = open ? target : null;
	const [loadedConfigOwner, setLoadedConfigOwner] = useState(configOwner);
	if (loadedConfigOwner !== configOwner) {
		setLoadedConfigOwner(configOwner);
		setConfigProviders(null);
		setConfigRevision(null);
		setWebServiceSchema(undefined);
		setAppliedProviderRevision(undefined);
	}
	// (Re)load whenever the gateway is reachable — including when it comes back
	// after a transient outage. Account editors are keyed by account ID, so a
	// refetch keeps their drafts.
	useEffect(() => {
		if (!(open && reachable)) {
			return;
		}
		let active = true;
		fetchGatewayConfig(target)
			.then((config) => {
				if (active) {
					setConfigProviders(config.providers);
					setConfigRevision(config.configRevision ?? null);
					setWebServiceSchema(config.webServiceSchema);
					setAppliedProviderRevision(config.appliedProviderRevision);
				}
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, [open, reachable, target]);

	const refreshWithConfig = async () => {
		await refresh();
		try {
			const cfg = await fetchGatewayConfig(target);
			const currentNode = getActiveNode();
			if (
				currentNode.url !== target.url ||
				(currentNode.token ?? null) !== target.token ||
				(currentNode.userJwt ?? null) !== target.userJwt
			) {
				return;
			}
			setConfigProviders(cfg.providers);
			setConfigRevision(cfg.configRevision ?? null);
			setWebServiceSchema(cfg.webServiceSchema);
			setAppliedProviderRevision(cfg.appliedProviderRevision);
		} catch {
			// Config fetch fails silently — health view is the primary surface.
		}
	};

	return {
		appliedProviderRevision,
		configProviders,
		configRevision,
		refreshWithConfig,
		webServiceSchema,
	};
}
