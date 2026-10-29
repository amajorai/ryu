// apps/desktop/src/components/settings/ProviderDesktopRouteSetting.tsx
//
// Per-provider "Route through your computer" switch, shown on a provider card
// while the active node is one of the user's cloud nodes. Some providers refuse
// data-center addresses (Anthropic has blocked Claude subscription requests
// from cloud hosts), so the node can send that provider's traffic out through
// the desktop that routes it (Settings → Gateway → Network → "Route traffic
// through this computer").
//
// The choice lives on the NODE (`/api/local-egress/route/providers`); see
// `apps/core/src/local_egress/providers.rs`. A node without desktop routing
// (local Core, self-hosted node, older Core) hides the switch.

import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Label } from "@ryu/ui/components/label.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useEffect, useState } from "react";
import { sileo } from "sileo";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	configureProviderRoute,
	fetchProviderRoutes,
	type ProviderRouteId,
	type ProviderRoutesStatus,
} from "@/src/lib/api/local-egress.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";

/** Catalog provider id → the node's provider route that carries it. */
const PROVIDER_ROUTES: Readonly<Record<string, ProviderRouteId>> = {
	"claude-pro-max": "claude",
};

export function providerRouteFor(
	providerId: string
): ProviderRouteId | undefined {
	return PROVIDER_ROUTES[providerId];
}

function describeRoute(
	status: ProviderRoutesStatus,
	tl: LiteralMessage
): string {
	const { route } = status;
	if (!route.allowed) {
		return "Your team admin has turned off local traffic routing, so this provider uses the cloud network.";
	}
	if (!route.routed) {
		return "No computer routes this node yet. Turn on Route traffic through this computer in Settings → Gateway → Network on the computer that should carry it. Until then, requests use the cloud network.";
	}
	if (!route.connected) {
		return "The routing computer is offline. Requests fail until it reconnects, instead of using the cloud network.";
	}
	return route.desktop
		? tl("Requests leave through {desktop}.", { desktop: route.desktop })
		: "Requests leave through your computer.";
}

export function ProviderDesktopRouteSetting({
	label,
	providerId,
}: {
	label: string;
	providerId: string;
}) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const routeId = providerRouteFor(providerId);
	const remote = !isLocalNode(node);
	const [status, setStatus] = useState<ProviderRoutesStatus | null>(null);
	const [saving, setSaving] = useState(false);

	const refresh = useCallback(async () => {
		try {
			setStatus(await fetchProviderRoutes(node));
		} catch {
			// Unsupported node or older Core: hide the switch.
			setStatus(null);
		}
	}, [node]);

	useEffect(() => {
		if (!(routeId && remote)) {
			setStatus(null);
			return;
		}
		refresh().catch(() => undefined);
	}, [refresh, remote, routeId]);

	if (!(routeId && remote && status?.route.supported)) {
		return null;
	}

	const enabled =
		status.providers.find((provider) => provider.id === routeId)?.enabled ??
		false;
	const switchId = `provider-desktop-route-${providerId}`;

	const handleToggle = async (next: boolean) => {
		setSaving(true);
		try {
			const updated = await configureProviderRoute(node, {
				enabled: next,
				id: routeId,
			});
			setStatus(updated);
			sileo.success({
				title: next
					? tl("{label} routes through your computer", { label })
					: tl("{label} uses the cloud network", { label }),
			});
		} catch (error) {
			sileo.error({
				title: "Could not change provider routing",
				description:
					error instanceof Error ? error.message : "Try again in a moment.",
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-3">
				<Label htmlFor={switchId} size="compact" tone="muted">
					Route through your computer
				</Label>
				<Switch
					checked={enabled}
					disabled={saving || !status.route.allowed}
					id={switchId}
					onCheckedChange={handleToggle}
				/>
			</div>
			<p className="text-muted-foreground text-xs">
				Recommended for subscription logins on cloud nodes: the provider may
				block data-center IP addresses. Requests leave through the computer that
				routes this node, so it must stay on with Ryu open. While it is asleep
				or offline, requests fail instead of using the cloud.
			</p>
			{enabled ? (
				<p className="text-status-warning text-xs">
					{describeRoute(status, tl)}
				</p>
			) : null}
		</div>
	);
}
