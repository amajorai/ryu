import type { DesktopGateVerdict } from "@ryu/auth/lib/plans";
import { createContext, type ReactNode, useContext } from "react";

interface ProofEntitlementContext {
	canUse: () => boolean;
	ready: boolean;
	refresh: () => Promise<void>;
	requestUpgrade: () => void;
	verdict: DesktopGateVerdict;
}

const value: ProofEntitlementContext = {
	canUse: () => true,
	ready: true,
	refresh: async () => undefined,
	requestUpgrade: () => undefined,
	verdict: {
		daysLeftInTrial: 0,
		managedInference: false,
		marketplaceApps: true,
		paywalled: false,
		plan: "pro",
		proUnlocked: true,
		reason: "subscription",
	},
};
const EntitlementContext = createContext(value);

export function EntitlementProvider({ children }: { children: ReactNode }) {
	return (
		<EntitlementContext.Provider value={value}>
			{children}
		</EntitlementContext.Provider>
	);
}

export function useEntitlementContext() {
	return useContext(EntitlementContext);
}
