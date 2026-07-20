// packages/marketplace/src/host.tsx
//
// The host-services seam for the shared store/marketplace UI. Every surface-specific
// dependency the money-layer components need — the license/seller data hooks, the
// purchase action, and how to open an external Stripe URL — is injected here, so the
// components themselves are surface-agnostic and identical on desktop and web.
//
// Desktop provides hooks backed by its Better-Auth bearer + Tauri `openExternal`
// (apps/desktop/src/components/marketplace/host.tsx); web provides hooks backed by
// the session cookie + `window.location` (apps/web/src/components/marketplace/host.tsx).
// The host value MUST be a stable module const on each surface so the hooks it
// carries keep a consistent identity across renders (rules of hooks).

import { createContext, type ReactNode, useContext } from "react";
import type {
	MarketplaceDetailTarget,
	MarketplaceHostError,
	MarketplaceKind,
	OwnedLicense,
	PurchaseResult,
	SellerStatus,
} from "./types.ts";

/** What a surface's "my licenses" hook must return for the shared LicensesTab. */
export interface LicensesState {
	authed: boolean;
	error: MarketplaceHostError | null;
	isLicensed: (kind: MarketplaceKind, id: string) => boolean;
	licenses: OwnedLicense[];
	loading: boolean;
	refresh: () => Promise<void> | void;
}

/** What a surface's "seller status" hook must return for the shared SellTab. */
export interface SellerState {
	authed: boolean;
	error: MarketplaceHostError | null;
	loading: boolean;
	/** Begin (or resume) onboarding; resolves to a hosted Stripe URL. */
	onboard: () => Promise<string>;
	onboarding: boolean;
	refresh: () => Promise<void> | void;
	status: SellerStatus | null;
}

/** The full set of services the shared store UI needs from its host surface. */
export interface MarketplaceHost {
	/** Open an external URL (Tauri shell on desktop, navigation on web). */
	openExternal: (url: string) => Promise<void> | void;
	/** Start a paid-item purchase; resolves to a Stripe URL or already-owned. */
	startPurchase: (input: {
		id: string;
		kind: MarketplaceKind;
	}) => Promise<PurchaseResult>;
	/** The surface's owned-licenses hook (called at component top level). */
	useLicenses: () => LicensesState;
	/** The surface's seller-status hook (called at component top level). */
	useSellerStatus: () => SellerState;
}

const MarketplaceHostContext = createContext<MarketplaceHost | null>(null);

export function MarketplaceHostProvider({
	host,
	children,
}: {
	host: MarketplaceHost;
	children: ReactNode;
}) {
	return (
		<MarketplaceHostContext.Provider value={host}>
			{children}
		</MarketplaceHostContext.Provider>
	);
}

/** Read the injected host services. Throws if no provider is mounted above. */
export function useMarketplaceHost(): MarketplaceHost {
	const host = useContext(MarketplaceHostContext);
	if (!host) {
		throw new Error(
			"useMarketplaceHost must be used within a <MarketplaceHostProvider>."
		);
	}
	return host;
}

export type { MarketplaceDetailTarget };
