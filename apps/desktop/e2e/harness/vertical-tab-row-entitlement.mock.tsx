import { createContext, type ReactNode, useContext } from "react";

interface ProofEntitlementContext {
	canUse: () => boolean;
	ready: boolean;
	refresh: () => Promise<void>;
	requestUpgrade: () => void;
	verdict: null;
}

const value: ProofEntitlementContext = {
	canUse: () => true,
	ready: true,
	refresh: async () => undefined,
	requestUpgrade: () => undefined,
	verdict: null,
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
