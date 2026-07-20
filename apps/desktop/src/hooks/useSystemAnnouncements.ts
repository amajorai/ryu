// apps/desktop/src/hooks/useSystemAnnouncements.ts
//
// Derives locally-generated "system" announcements from live connectivity signals
// (Core / gateway reachability, node version floor) so they surface inside the
// sidebar Announcements section using the same card design as admin-authored
// announcements — instead of as floating page banners / persistent toasts. These
// are read-only status items: they appear while the condition holds and clear
// themselves when it recovers, so they carry no read/dismiss state.

import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useSystemStatusContext } from "@/src/contexts/SystemStatusContext.tsx";
import { useNodeHealth } from "@/src/hooks/useNodeHealth.ts";
import { MIN_CORE_VERSION } from "@/src/lib/node-compat.ts";

/** A locally-generated status card rendered alongside admin announcements. */
export interface SystemAnnouncement {
	/** Accent color (CSS value): tints the left border + icon chip. */
	accent: string;
	/** Optional in-app action (opens a tab by path). */
	action?: { label: string; path: string };
	body: string;
	icon: IconSvgElement;
	/** Stable id so React keys never collide with server announcement ids. */
	id: string;
	title: string;
}

/**
 * The live connectivity issues worth surfacing, highest-severity first. Empty
 * when everything is healthy (or still on the first probe). Mirrors the copy of
 * the banners/toasts these replace: Core unreachable (was CoreStatusToast + the
 * chat composer overlay) and node-below-floor (was NodeCompatBanner), plus the
 * gateway signal the chat composer previously showed inline.
 */
export function useSystemAnnouncements(): SystemAnnouncement[] {
	const { coreReachable, gatewayReachable, loading } = useSystemStatusContext();
	const { data: nodeHealth } = useNodeHealth();

	const items: SystemAnnouncement[] = [];

	// Still probing on first load — stay silent until there is a real answer.
	if (loading) {
		return items;
	}

	if (!coreReachable) {
		items.push({
			id: "system:core-unreachable",
			title: "Core is unreachable",
			body: "Chat and all agent features are unavailable. Start Core from Services.",
			icon: AlertCircleIcon,
			accent: "var(--destructive)",
			action: { label: "Open services", path: "/fleet" },
		});
		// Gateway/node checks are meaningless while Core is down — the item above
		// already tells the whole story.
		return items;
	}

	if (!gatewayReachable) {
		items.push({
			id: "system:gateway-unreachable",
			title: "Gateway is unreachable",
			body: "Agents that route through the gateway are unavailable until it's back. Start it from Services.",
			icon: AlertCircleIcon,
			accent: "var(--warning)",
			action: { label: "Open services", path: "/fleet" },
		});
	}

	if (nodeHealth && !nodeHealth.compatible) {
		items.push({
			id: "system:node-outdated",
			title: "Node needs updating",
			body: `This node runs Core v${nodeHealth.version ?? "?"} · the app expects v${MIN_CORE_VERSION}+. Some features may be unavailable until it's updated.`,
			icon: AlertCircleIcon,
			accent: "var(--warning)",
		});
	}

	return items;
}
