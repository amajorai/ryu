// apps/desktop/src/hooks/useEntitlement.ts
//
// The desktop trial + paywall gate (epic #496, Unit C1).
//
// Rollout: the whole trial + free-tier cap model sits behind the
// `billing.desktop_trial` flag (default OFF for the waitlist phase). Off, the
// verdict resolves as "beta" — free, uncapped, no trial clock, no paywall.
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
// A FOURTH thing resolves here and feeds NONE of the above: the lifetime
// "1 year of updates" window, mirrored into `src/lib/updates-window.ts` for the
// UPDATER. It governs only which builds are OFFERED. A desktop licence is
// perpetual, so the window never enters `decideDesktopAccess`, never reaches
// `DesktopGateVerdict` or the cached entitlement, and never touches the Core
// entitlement flag — see the perpetual-licence note above `licenseView` in
// `packages/api/src/routers/billing.ts`.
//
// Local persistence (offline fallback) is the Tauri store (entitlement.bin):
//   - firstLaunchAt   mirror of the server anchor (survives a /trial outage)
//   - lastGoodEnt     the most recent successful entitlement + when it was cached
//   - licenseKey      the validated key, re-checked online on next launch

import {
	DESKTOP_TRIAL_FLAG,
	featureFlagFallback,
} from "@ryu/auth/lib/feature-flags";
import {
	type CachedEntitlement,
	capabilityTier,
	type DesktopGateVerdict,
	decideDesktopAccess,
	desktopGateConfig,
	type Entitlement,
	type GatedCapability,
	updatesWindowApplies,
} from "@ryu/auth/lib/plans";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ensureTrialAnchorMs,
	fetchEntitlementSnapshot,
	hasBillingAuth,
	type LicenseValidateResult,
	validateLicenseKey,
} from "@/src/lib/api/billing.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	setEntitlementActive,
	setManagedInferenceEntitled,
} from "@/src/lib/api/preferences.ts";
import {
	captureFeatureFlagScope,
	publishFeatureFlags,
	readFeatureFlag,
} from "@/src/lib/feature-flags.ts";
import { invokeWhenReady, isNoDesktopBackend } from "@/src/lib/tauri-ready.ts";
import { setUpdatesWindow } from "@/src/lib/updates-window.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

const STORE_FILE = "entitlement.bin";
const KEY_FIRST_LAUNCH = "firstLaunchAtMs";
const KEY_LAST_GOOD = "lastGoodEntitlement";
/** Legacy plaintext location of the license key, read once to migrate it. */
const KEY_LICENSE = "licenseKey";
/** The sealed native slot that holds the license key (see `desktop_seal.rs`). */
const LICENSE_SLOT = "license-key";

/** First and longest wait before re-reading a license key the keychain held back. */
const LOCKED_RETRY_BASE_MS = 5000;
const LOCKED_RETRY_MAX_MS = 5 * 60_000;

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

async function writeStore<TValue>(key: string, value: TValue): Promise<void> {
	try {
		const store = await getStore();
		await store.set(key, value);
		await store.save();
	} catch {
		// Non-fatal: persistence is best-effort; the gate degrades to the trial.
	}
}

async function deleteStoreKey(key: string): Promise<void> {
	try {
		const store = await getStore();
		if (await store.delete(key)) {
			await store.save();
		}
	} catch {
		// No plugin store here: nothing on disk to purge.
	}
}

/**
 * Hosts without the sealed slot (unit tests, the plain-browser harness) keep an
 * applied key for this session only; nothing is written in plaintext.
 */
let sessionLicenseKey: string | null = null;

/**
 * What a read of the sealed slot found. `locked` is "the slot exists but could
 * not be opened right now" (a locked or not-yet-unlocked OS keychain): the key
 * may well be there, so it must not be read as "no key".
 */
export type LicenseKeyRead =
	| { key: string | null; status: "ready" }
	| { status: "locked" };

/**
 * The stored license key. It lives sealed in the desktop's `license-key` slot
 * (`enc:v1:`, a key held in the OS keychain). A key an older build left in
 * plaintext `entitlement.bin` is sealed on first read, then deleted there.
 */
export async function readLicenseKey(): Promise<LicenseKeyRead> {
	try {
		const sealed = await invokeWhenReady<string | null | undefined>(
			"desktop_secret_get",
			{ name: LICENSE_SLOT }
		);
		if (sealed === undefined) {
			// A host without the slot (it answers `null` when empty).
			return {
				key: sessionLicenseKey ?? (await readStore<string>(KEY_LICENSE)),
				status: "ready",
			};
		}
		if (sealed) {
			return { key: sealed, status: "ready" };
		}
		const legacy = await readStore<string>(KEY_LICENSE);
		if (legacy) {
			await invokeWhenReady("desktop_secret_set", {
				name: LICENSE_SLOT,
				value: legacy,
			});
			await deleteStoreKey(KEY_LICENSE);
		}
		return { key: legacy, status: "ready" };
	} catch (error) {
		if (isNoDesktopBackend(error)) {
			return {
				key: sessionLicenseKey ?? (await readStore<string>(KEY_LICENSE)),
				status: "ready",
			};
		}
		// The slot exists but could not be opened or written (most often a locked
		// keychain): never fall back to a plaintext copy, and do not report the key
		// as missing either. The caller keeps its last verdict and retries.
		return { status: "locked" };
	}
}

/** Seal and store a validated license key. Fails closed when sealing fails. */
async function writeLicenseKey(key: string): Promise<void> {
	try {
		await invokeWhenReady("desktop_secret_set", {
			name: LICENSE_SLOT,
			value: key,
		});
		await deleteStoreKey(KEY_LICENSE);
	} catch (error) {
		if (!isNoDesktopBackend(error)) {
			throw error;
		}
		sessionLicenseKey = key;
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
		marketplaceApps: ent.marketplaceApps,
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
	// Whether this hook's owner is still mounted. `resolve` awaits several
	// network and store round-trips (the flag-scope capture can itself look up
	// the active org) before it pushes to Core, and it reads the active node only
	// at push time; once the owner has unmounted, that node may be one this
	// resolution never belonged to.
	const mounted = useRef(true);
	// The last verdict this hook resolved, readable from `resolve` without
	// making it depend on state.
	const verdictRef = useRef<DesktopGateVerdict | null>(null);
	// Set while the license key could not be read (locked keychain): the verdict
	// is then provisional and a re-read is pending (see the retry effect below).
	const licenseLocked = useRef(false);
	const lockedAttempts = useRef(0);
	const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const resolveRef = useRef<(() => Promise<void>) | null>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			if (retryTimer.current) {
				clearTimeout(retryTimer.current);
				retryTimer.current = null;
			}
		};
	}, []);

	const resolve = useCallback(async () => {
		// 1) The live entitlement (null when the check failed → offline grace).
		//    One request carries the lifetime updates window too (step 2b).
		// Captured BEFORE the request: rollout flags are per-user AND per active
		// org (org-role audiences), so the map is published only if this same
		// (account, org) scope is still active when it lands.
		const flagsScope = await captureFeatureFlagScope();
		const snapshot = await fetchEntitlementSnapshot();
		const liveEntitlement = snapshot?.entitlement ?? null;

		// 1b) Publish the lifetime updates window for the UPDATER (never for the
		//     gate). Written whenever the check SUCCEEDED — including while the
		//     window is still OPEN — because deciding at write time would race the
		//     launch-time updater on the first post-lapse launch. `getUpdatesCutoff`
		//     applies the lapse test at READ time instead. Published BEFORE the
		//     store round-trips below for the same reason: every await here widens
		//     the window in which the updater finds no key. On a failed check the
		//     stored value is left alone, so an offline launch keeps the last known
		//     window; an owner never checked stays unrestricted, which is the
		//     fail-open default.
		//
		//     `updatesWindowApplies` is what keeps an actively-paying subscriber out
		//     of this: the server's `lifetime` block is built from lifetime ORDERS
		//     alone and is independent of any subscription, so a 2025 lifetime buyer
		//     who now pays for Pro still has an "expired" block. Pinning them to old
		//     builds and upselling a licence they already own would be wrong.
		if (snapshot) {
			const { lifetime } = snapshot;
			const applies = updatesWindowApplies(liveEntitlement?.plan ?? null);
			setUpdatesWindow(applies && lifetime ? lifetime.updatesExpiresAt : null);
			// 1c) Same free ride, same firewall: publish the server-driven ROLLOUT
			//     flags for surfaces that gate on them. A different axis from
			//     entitlement — what has been switched ON for this account, not what
			//     they paid for — so like the updates window it must never reach
			//     `decideDesktopAccess`, the verdict, or the cached entitlement.
			//
			//     Inside `if (snapshot)` on purpose: a FAILED check must leave the
			//     stored map alone so last-good keeps riding, exactly as the window
			//     above does. This is an OPTIMIZATION, not the mechanism — this
			//     effect runs on mount and is not on a timer, so `useFeatureFlag`'s
			//     own TTL refresh is what makes a central flip land without a
			//     restart.
			publishFeatureFlags(
				snapshot.features,
				flagsScope,
				snapshot.organizationId
			);
		}

		// 2) Whether the trial + free-tier caps are rolled out at all. Off (the
		//    waitlist-phase default) resolves as "free during beta": no trial
		//    clock, no paywall, no caps; paid plans and licences still win. Read
		//    from this reply first, then the last-good published map, then the
		//    compiled-in default, so a failed check never flips the decision.
		const trialEnabled =
			snapshot?.features?.[DESKTOP_TRIAL_FLAG] ??
			readFeatureFlag(DESKTOP_TRIAL_FLAG) ??
			featureFlagFallback(DESKTOP_TRIAL_FLAG);

		// 2b) The trial anchor: server-authoritative, mirrored locally so a /trial
		//     outage (or no sign-in) still has a clock. Once we know the server
		//     value we persist it; the local mirror is the offline fallback.
		//     Skipped while the trial is off so the clock does not run out during
		//     the beta and greet the user with an expired trial once it turns on.
		let firstLaunchMs: number | null = null;
		if (trialEnabled) {
			const localFirstLaunch = await readStore<number>(KEY_FIRST_LAUNCH);
			const serverFirstLaunch = await ensureTrialAnchorMs();
			firstLaunchMs = serverFirstLaunch ?? localFirstLaunch;
			if (serverFirstLaunch && serverFirstLaunch !== localFirstLaunch) {
				await writeStore(KEY_FIRST_LAUNCH, serverFirstLaunch);
			} else if (!(serverFirstLaunch || localFirstLaunch) && hasBillingAuth()) {
				// First ever launch with no server answer: seed a local anchor so the
				// trial clock starts now and is not perpetually "fresh".
				const now = Date.now();
				await writeStore(KEY_FIRST_LAUNCH, now);
			}
		}

		if (liveEntitlement) {
			await writeStore(KEY_LAST_GOOD, toCached(liveEntitlement));
		}
		const cached = await readStore<CachedEntitlement>(KEY_LAST_GOOD);

		// 3) The license-key state: re-validate a stored key online; if the check
		//    cannot run, keep trusting the last-known-active flag (offline grace
		//    rides the lastGood cache instead).
		const licenseRead = await readLicenseKey();
		const locked = licenseRead.status === "locked";
		const storedKey = licenseRead.status === "ready" ? licenseRead.key : null;
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

		// Exactly the inputs this decision has always taken. The updates window
		// above is deliberately NOT one of them: a desktop licence is a perpetual
		// one-time purchase, and a lapsed window means only that newer builds stop
		// being offered — it must never revoke access. See the perpetual-licence
		// note above `licenseView` in `packages/api/src/routers/billing.ts`.
		//
		// A locked keychain is "unknown", not "no license": with a verdict already
		// resolved, keep it rather than downgrade a licensed user to the trial or
		// paywall. With none yet (first launch), decide from the other inputs (the
		// cached last-good entitlement rides the grace window) and let the retry
		// below correct it once the key can be read.
		const next =
			locked && verdictRef.current
				? verdictRef.current
				: decideDesktopAccess(
						{
							firstLaunchMs,
							liveEntitlement,
							licenseActive,
							cached,
							nowMs: Date.now(),
						},
						desktopGateConfig(trialEnabled)
					);
		verdictRef.current = next;
		setVerdict(next);
		setReady(true);

		// Re-read a held-back key on window focus / visibility (see the effect
		// below) and on a capped exponential backoff, until it reads as present or
		// missing.
		licenseLocked.current = locked;
		if (retryTimer.current) {
			clearTimeout(retryTimer.current);
			retryTimer.current = null;
		}
		if (locked && mounted.current) {
			const delay = Math.min(
				LOCKED_RETRY_BASE_MS * 2 ** lockedAttempts.current,
				LOCKED_RETRY_MAX_MS
			);
			lockedAttempts.current += 1;
			retryTimer.current = setTimeout(() => {
				retryTimer.current = null;
				resolveRef.current?.().catch(() => undefined);
			}, delay);
		} else {
			lockedAttempts.current = 0;
		}

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
		// `apps/core/src/entitlement.rs`. Skipped once unmounted (see `mounted`):
		// a mounted owner, or Core's next startup, re-seeds it.
		if (!mounted.current) {
			return;
		}
		try {
			const target = toTarget(useNodeStore.getState().getActiveNode());
			await setEntitlementActive(target, next.reason !== "locked");
			await setManagedInferenceEntitled(target, Boolean(next.managedInference));
		} catch {
			// Non-fatal: Core sync is best-effort; the paywall UI already gated the
			// shell, and Core re-reads the flag on its next startup regardless.
		}
	}, []);

	resolveRef.current = resolve;

	useEffect(() => {
		resolve().catch(() => undefined);
	}, [resolve]);

	// A license key the keychain held back is re-read when the user comes back to
	// the window: that is when an unlock has most likely just happened, and the
	// `desktop-secret-changed` event only fires on set/delete, not on unlock.
	useEffect(() => {
		const retryIfLocked = () => {
			if (licenseLocked.current && mounted.current) {
				resolve().catch(() => undefined);
			}
		};
		const onVisibility = () => {
			if (document.visibilityState === "visible") {
				retryIfLocked();
			}
		};
		window.addEventListener("focus", retryIfLocked);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("focus", retryIfLocked);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [resolve]);

	const applyLicenseKey = useCallback(
		async (key: string): Promise<LicenseValidateResult> => {
			const result = await validateLicenseKey(key);
			if (isLicenseActive(result)) {
				await writeLicenseKey(key.trim());
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
