// apps/desktop/src/contexts/entitlement-context.tsx
//
// App-wide access to the desktop trial + paywall verdict (epic #496, Unit C1).
//
// Resolves the verdict ONCE at the app root (via useEntitlement) and exposes it
// through context so Pro-feature call sites can gate with `canUse(...)` without
// re-fetching.
//
// SOFT paywall (freemium, 2026-07-11): the app shell is ALWAYS rendered
// (open-core — Band 1 local chat stays usable forever) and trial-expiry drops the
// user into the FREE tier rather than a wall. Two upsell surfaces:
//   1. PaywallModal — the detailed checkout surface (plans + license key),
//      opened on demand by a gated call site via `requestUpgrade()`.
//   2. UpsellModal  — a soft, personalized nudge shown periodically on launch to
//      free/locked users only (never payers). The server computes WHAT to pitch;
//      this launch cadence decides WHEN (trial just expired, or >= 7 days since
//      the last show, read from GET /api/upsell/state).
// Nothing blanks the whole app anymore.

import type { DesktopGateVerdict, GatedCapability } from "@ryu/auth/lib/plans";
import type { UpsellCard } from "@ryu/auth/lib/upsell";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { PaywallModal } from "@/src/components/billing/PaywallModal.tsx";
import { UpsellModal } from "@/src/components/billing/UpsellModal.tsx";
import { useEntitlement } from "@/src/hooks/useEntitlement.ts";
import {
	fetchUpsellPitch,
	fetchUpsellState,
	UPSELL_MIN_GAP_MS,
} from "@/src/lib/api/upsell.ts";

interface EntitlementContextValue {
	/** Whether a gated capability is unlocked. */
	canUse: (capability: GatedCapability) => boolean;
	/** False until the first resolution completes. */
	ready: boolean;
	/** Re-resolve the verdict (after sign-in / purchase). */
	refresh: () => Promise<void>;
	/** Open the paywall (a gated call site invokes this on a blocked action). */
	requestUpgrade: () => void;
	/** The resolved verdict, or null until ready. */
	verdict: DesktopGateVerdict | null;
}

const EntitlementContext = createContext<EntitlementContextValue | null>(null);

export function EntitlementProvider({ children }: { children: ReactNode }) {
	const { ready, verdict, canUse, refresh, applyLicenseKey } = useEntitlement();
	// The detailed checkout modal. A gated call site opens it via
	// `requestUpgrade()`; there is no whole-app block — the shell always renders.
	const [paywallOpen, setPaywallOpen] = useState(false);
	// The soft launch nudge. Opened by the show-cadence effect below with the
	// pre-fetched, non-empty pitch cards so it never flashes an empty state.
	const [upsellOpen, setUpsellOpen] = useState(false);
	const [upsellCards, setUpsellCards] = useState<UpsellCard[]>([]);
	// Run the launch cadence check at most once per app session, even though the
	// verdict re-resolves on sign-in / license entry (refresh()).
	const cadenceCheckedRef = useRef(false);

	const requestUpgrade = useCallback(() => setPaywallOpen(true), []);

	// Launch show-cadence: for free/locked (non-paying) users only, show the soft
	// upsell when the trial just expired (never shown before) OR it has been >= 7
	// days since the last show. WHAT to show is server-computed; this only decides
	// WHEN. Fails SAFE: any fetch failure (offline / endpoint unbuilt) shows
	// nothing, so the modal never spams on repeated launches.
	useEffect(() => {
		if (!(ready && verdict) || cadenceCheckedRef.current) {
			return;
		}
		// Only free/locked users see the soft upsell. Trial, payers, beta, and the
		// offline-grace window are all `paywalled: false` → skipped here.
		if (!verdict.paywalled) {
			return;
		}
		cadenceCheckedRef.current = true;

		(async () => {
			const state = await fetchUpsellState();
			// A FAILED state fetch resolves to null → fail safe, show nothing this
			// launch. Only a successful "never shown" (lastUpsellShownAtMs === null)
			// or an elapsed gap is eligible.
			if (state === null) {
				return;
			}
			const last = state.lastUpsellShownAtMs;
			const due = last === null || Date.now() - last >= UPSELL_MIN_GAP_MS;
			if (!due) {
				return;
			}
			const cards = await fetchUpsellPitch();
			// Low-usage free users may score zero cards — show nothing rather than an
			// empty modal (and do not stamp `shown`, which the modal does on open).
			if (cards.length === 0) {
				return;
			}
			setUpsellCards(cards);
			setUpsellOpen(true);
		})().catch(() => undefined);
	}, [ready, verdict]);

	return (
		<EntitlementContext.Provider
			value={{ ready, verdict, canUse, requestUpgrade, refresh }}
		>
			{children}
			<PaywallModal
				onApplyLicenseKey={applyLicenseKey}
				onOpenChange={setPaywallOpen}
				open={paywallOpen}
			/>
			<UpsellModal
				cards={upsellCards}
				onOpenChange={setUpsellOpen}
				onUpgrade={requestUpgrade}
				open={upsellOpen}
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
