// apps/desktop/src/hooks/useEntitlement.ts
//
// The desktop trial + paywall gate (epic #496, Unit C1).
//
// Computes the access verdict at app entry from three inputs, in one PURE
// decision (`decideDesktopAccess` in @ryu/auth/lib/plans):
//   1. live entitlement   — GET /api/billing/subscription-status (bearer)
//   2. trial anchor        — server-authoritative first-launch + local mirror
//   3. license-key state   — a validated desktop license key (persisted)
// plus a cached last-good entitlement for the OFFLINE GRACE window so a paying
// user is never falsely locked out by a flaky network.
//
// SOFT paywall (three bands): a `paywalled` verdict (trial over, no active
// subscription, no valid license key) means FREE band only — it never blocks the
// app shell. Band 1 local chat stays usable; `canUse(capability)` gates Band 2
// (pro / one-time Lifetime) and Band 3 (subscription-only) features, and the
// dismissible PaywallModal upsells. Freemium (2026-07-11): plain post-trial Free
// keeps its LOCAL autonomy running — Core autonomy is paused only on a genuine
// hard lock (reason "locked"), not on trial-expiry; see `apps/core/src/entitlement.rs`.
//
// Local persistence (offline fallback) is the Tauri store (entitlement.bin):
//   - firstLaunchAt   mirror of the server anchor (survives a /trial outage)
//   - lastGoodEnt     the most recent successful entitlement + when it was cached
//   - licenseKey      the validated key, re-checked online on next launch

import {
	type CachedEntitlement,
	capabilityTier,
	type DesktopGateVerdict,
	decideDesktopAccess,
	type Entitlement,
	type GatedCapability,
} from "@ryu/auth/lib/plans";
import { useCallback, useEffect, useState } from "react";
import {
	ensureTrialAnchorMs,
	fetchEntitlement,
	hasBillingAuth,
	type LicenseValidateResult,
	validateLicenseKey,
} from "@/src/lib/api/billing.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { setEntitlementActive } from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

const STORE_FILE = "entitlement.bin";
const KEY_FIRST_LAUNCH = "firstLaunchAtMs";
const KEY_LAST_GOOD = "lastGoodEntitlement";
const KEY_LICENSE = "licenseKey";

type StoreModule = typeof import("@tauri-apps/plugin-store");
let storePromise: Promise<import("@tauri-apps/plugin-store").Store> | null =
	null;

function getStore(): Promise<import("@tauri-apps/plugin-store").Store> {
	if (!storePromise) {
		storePromise = import("@tauri-apps/plugin-store").then(
			({ load }: StoreModule) => load(STORE_FILE)
		);
	}
	return storePromise;
}

async function readStore<T>(key: string): Promise<T | null> {
	try {
		const store = await getStore();
		return (await store.get<T>(key)) ?? null;
	} catch {
		return null;
	}
}

async function writeStore(key: string, value: unknown): Promise<void> {
	try {
		const store = await getStore();
		await store.set(key, value);
		await store.save();
	} catch {
		// Non-fatal: persistence is best-effort; the gate degrades to the trial.
	}
}

/** True when a validated license key is currently active (not expired). */
function isLicenseActive(license: LicenseValidateResult | null): boolean {
	if (!license?.active) {
		return false;
	}
	if (!license.expiresAt) {
		return true;
	}
	const ms = Date.parse(license.expiresAt);
	return Number.isFinite(ms) ? ms > Date.now() : true;
}

/** Project a live entitlement onto the cacheable last-good shape. */
function toCached(ent: Entitlement): CachedEntitlement {
	return {
		cachedAtMs: Date.now(),
		proUnlocked: ent.desktopAccess,
		managedInference: ent.managedInference,
		plan: ent.plan,
	};
}

export interface UseEntitlement {
	/**
	 * Validate + persist a license key, then re-resolve. Returns the validate
	 * result so the caller can show a tailored message. Throws on a check that
	 * could not run (see {@link validateLicenseKey}).
	 */
	applyLicenseKey: (key: string) => Promise<LicenseValidateResult>;
	/** Convenience: whether a given gated capability is unlocked. */
	canUse: (capability: GatedCapability) => boolean;
	/** False until the first resolution completes (avoid a paywall flash). */
	ready: boolean;
	/** Re-run the full resolution (after sign-in / purchase / key entry). */
	refresh: () => Promise<void>;
	/** The resolved access verdict; null until ready. */
	verdict: DesktopGateVerdict | null;
}

/**
 * Resolve and watch the desktop access verdict. Reads the live entitlement +
 * trial anchor + license state, falls back to the local Tauri-store mirror when
 * the control plane is unreachable, and recomputes the verdict via the pure
 * `decideDesktopAccess`.
 */
export function useEntitlement(): UseEntitlement {
	const [verdict, setVerdict] = useState<DesktopGateVerdict | null>(null);
	const [ready, setReady] = useState(false);

	const resolve = useCallback(async () => {
		// 1) The trial anchor: server-authoritative, mirrored locally so a /trial
		//    outage (or no sign-in) still has a clock. Once we know the server
		//    value we persist it; the local mirror is the offline fallback.
		const localFirstLaunch = await readStore<number>(KEY_FIRST_LAUNCH);
		const serverFirstLaunch = await ensureTrialAnchorMs();
		const firstLaunchMs = serverFirstLaunch ?? localFirstLaunch;
		if (serverFirstLaunch && serverFirstLaunch !== localFirstLaunch) {
			await writeStore(KEY_FIRST_LAUNCH, serverFirstLaunch);
		} else if (!(serverFirstLaunch || localFirstLaunch) && hasBillingAuth()) {
			// First ever launch with no server answer: seed a local anchor so the
			// trial clock starts now and is not perpetually "fresh".
			const now = Date.now();
			await writeStore(KEY_FIRST_LAUNCH, now);
		}

		// 2) The live entitlement (null when the check failed → offline grace).
		const liveEntitlement = await fetchEntitlement();
		if (liveEntitlement) {
			await writeStore(KEY_LAST_GOOD, toCached(liveEntitlement));
		}
		const cached = await readStore<CachedEntitlement>(KEY_LAST_GOOD);

		// 3) The license-key state: re-validate a stored key online; if the check
		//    cannot run, keep trusting the last-known-active flag (offline grace
		//    rides the lastGood cache instead).
		const storedKey = await readStore<string>(KEY_LICENSE);
		let licenseActive = false;
		if (storedKey) {
			try {
				licenseActive = isLicenseActive(await validateLicenseKey(storedKey));
			} catch {
				// Offline / unavailable: do not assert the license; the lastGood cache
				// carries the entitlement through the grace window instead.
				licenseActive = false;
			}
		}

		const next = decideDesktopAccess({
			firstLaunchMs: firstLaunchMs ?? null,
			liveEntitlement,
			licenseActive,
			cached,
			nowMs: Date.now(),
		});
		setVerdict(next);
		setReady(true);

		// Push the node entitlement flag to Core so its scheduler pauses (or
		// resumes) autonomous automation. Freemium (2026-07-11): trial-expiry now
		// drops the user into the FREE tier, whose LOCAL automations must keep
		// running — managed inference spend is separately gated at the gateway /
		// balance layer, not the scheduler. So we only pause Core autonomy for a
		// genuine hard lock (reason "locked"), never for plain post-trial Free
		// (reason "trial-expired"). The verdict cannot distinguish a lapsed sub
		// from plain Free, and the balance gate covers both, so this is the safe
		// default; do NOT restore a `!paywalled` push here. Best-effort: an
		// unreachable local Core keeps its last-seeded value (default-ON). See
		// `apps/core/src/entitlement.rs`.
		try {
			const target = toTarget(useNodeStore.getState().getActiveNode());
			await setEntitlementActive(target, next.reason !== "locked");
		} catch {
			// Non-fatal: Core sync is best-effort; the paywall UI already gated the
			// shell, and Core re-reads the flag on its next startup regardless.
		}
	}, []);

	useEffect(() => {
		resolve().catch(() => undefined);
	}, [resolve]);

	const applyLicenseKey = useCallback(
		async (key: string): Promise<LicenseValidateResult> => {
			const result = await validateLicenseKey(key);
			if (isLicenseActive(result)) {
				await writeStore(KEY_LICENSE, key.trim());
			}
			await resolve();
			return result;
		},
		[resolve]
	);

	const canUse = useCallback(
		(capability: GatedCapability): boolean => {
			if (!verdict) {
				return false;
			}
			// Band 3 (subscription-only, real recurring cost) needs an active plan;
			// Band 2 (pro) unlocks with a one-time Lifetime license, any subscription,
			// or the trial. See CAPABILITY_TIERS in @ryu/auth/lib/plans.
			return capabilityTier(capability) === "subscription"
				? verdict.managedInference
				: verdict.proUnlocked;
		},
		[verdict]
	);

	return { ready, verdict, canUse, refresh: resolve, applyLicenseKey };
}
