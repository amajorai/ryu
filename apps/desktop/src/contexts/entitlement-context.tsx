// apps/desktop/src/contexts/entitlement-context.tsx
//
// App-wide access to the desktop access verdict.
//
// Resolves the verdict ONCE at the app root (via useEntitlement) and exposes it
// through context so call sites can gate a paid capability with `canUse(...)`
// without re-fetching.
//
// Personal use is free, so the app shell is ALWAYS rendered and nothing here
// opens by itself: there is no trial, no launch nudge and no cap prompt. The
// PaywallModal (plans and the license key field) opens only on demand, when a
// call site that needs a paid managed service calls `requestUpgrade()`.

import type { DesktopGateVerdict, GatedCapability } from "@ryu/auth/lib/plans";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useState,
} from "react";
import { PaywallModal } from "@/src/components/billing/PaywallModal.tsx";
import { useEntitlement } from "@/src/hooks/useEntitlement.ts";

interface EntitlementContextValue {
	/** Whether a gated capability is unlocked. */
	canUse: (capability: GatedCapability) => boolean;
	/** False until the first resolution completes. */
	ready: boolean;
	/** Re-resolve the verdict (after sign-in / purchase). */
	refresh: () => Promise<void>;
	/**
	 * Kept for the tab strip, which still asks for it. Tabs have no cap, so
	 * nothing calls it; it opens the same plans dialog as `requestUpgrade`.
	 */
	requestDesktopLicense: () => void;
	/** Open the plans dialog (a gated call site invokes this on a blocked action). */
	requestUpgrade: () => void;
	/** The resolved verdict, or null until ready. */
	verdict: DesktopGateVerdict | null;
}

const EntitlementContext = createContext<EntitlementContextValue | null>(null);

export function EntitlementProvider({ children }: { children: ReactNode }) {
	const { ready, verdict, canUse, refresh, applyLicenseKey } = useEntitlement();
	// The plans dialog. A gated call site opens it via `requestUpgrade()`; there
	// is no whole-app block, so the shell always renders.
	const [paywallOpen, setPaywallOpen] = useState(false);

	const requestUpgrade = useCallback(() => {
		setPaywallOpen(true);
	}, []);

	return (
		<EntitlementContext.Provider
			value={{
				ready,
				verdict,
				canUse,
				requestUpgrade,
				requestDesktopLicense: requestUpgrade,
				refresh,
			}}
		>
			{children}
			<PaywallModal
				onApplyLicenseKey={applyLicenseKey}
				onOpenChange={setPaywallOpen}
				open={paywallOpen}
			/>
		</EntitlementContext.Provider>
	);
}

/** Read the desktop entitlement verdict + gating helpers. */
export function useEntitlementContext(): EntitlementContextValue {
	const ctx = useContext(EntitlementContext);
	if (!ctx) {
		throw new Error(
			"useEntitlementContext must be used within an EntitlementProvider"
		);
	}
	return ctx;
}
