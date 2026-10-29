import type { Entitlement } from "@ryu/auth/lib/plans";

export function useCreditsWallet() {
	const entitlement: Entitlement = {
		plan: "pro",
		desktopAccess: true,
		marketplaceApps: true,
		managedInference: true,
		monthlyCreditPoolMicroUsd: 10_000_000,
		seats: 1,
	};
	return {
		authed: true,
		entitlement,
		error: null,
		grantPools: [],
		ledger: [],
		loading: false,
		refresh: async () => undefined,
		wallet: {
			balanceMicroUsd: 0,
			currency: "usd",
			id: "node-selector-wallet-fixture",
			ownerId: "org-fixture",
			ownerType: "organization",
			subscriptionBalanceMicroUsd: 0,
			topupBalanceMicroUsd: 0,
			updatedAt: "2026-09-27T00:00:00.000Z",
		},
		walletEmpty: true,
	};
}

export function useOrgBillingStatus() {
	return {
		activeOrgId: "org-fixture",
		billing: null,
		loading: false,
		organization: { id: "org-fixture", name: "Fixture workspace" },
		plan: null,
	};
}
