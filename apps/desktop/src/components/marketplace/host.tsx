// apps/desktop/src/components/marketplace/host.tsx
//
// Desktop binding for the shared @ryu/marketplace money-layer UI. Supplies the
// surface-specific services the shared components need: the owned-licenses and
// seller-status data hooks (Better-Auth bearer -> :3000), the purchase call, and
// Tauri's `openExternal` for the hosted Stripe URLs. The host is a stable module
// const so the hooks it carries keep a consistent identity across renders.

import {
	type MarketplaceHost,
	MarketplaceHostProvider,
} from "@ryu/marketplace/host";
import type { ReactNode } from "react";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useMyLicenses } from "@/src/hooks/useMyLicenses.ts";
import { useSellerStatus } from "@/src/hooks/useSellerStatus.ts";
import { startPurchase } from "@/src/lib/api/marketplace.ts";

const desktopMarketplaceHost: MarketplaceHost = {
	openExternal,
	startPurchase,
	useLicenses: useMyLicenses,
	useSellerStatus,
};

/** Mount once above every store surface that renders the shared money layer. */
export function DesktopMarketplaceHost({ children }: { children: ReactNode }) {
	return (
		<MarketplaceHostProvider host={desktopMarketplaceHost}>
			{children}
		</MarketplaceHostProvider>
	);
}
