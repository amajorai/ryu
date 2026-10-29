// apps/desktop/src/hooks/useFeatureFlag.ts
//
// Read one server-driven ROLLOUT flag, and keep it fresh without a restart.
//
// This is the PRIMARY propagation path. `useEntitlement` also publishes the map
// at app entry (a free ride on a fetch that already happens), but that effect
// runs on MOUNT and is not on a timer — so if it were the only publisher, a flip
// made centrally would need an app restart to be seen. This hook closes that gap
// by refreshing on a stale read, which makes "reopen the dialog" enough.
//
// Resolution order, and each step exists for a different failure:
//   1. a fresh cached value          — the normal case
//   2. a stale-but-known value       — served IMMEDIATELY while the refresh runs,
//                                      so a flag never flickers off mid-session
//                                      and an offline client keeps last-good
//   3. `featureFlagFallback(key)`    — the compiled-in default, used only when
//                                      the map has NEVER been read for this
//                                      (account, active org) scope
//
// An ORG SWITCH is a scope change: the hook re-keys on the active org, the old
// org's values stop being readable at once, and a refresh for the new org
// starts immediately instead of waiting out the TTL.
//
// Refresh is bounded by USER ACTION (this hook mounting), never a background
// timer: `/subscription-status` paginates every Polar order for the customer, so
// a fleet-wide 60s poll would hammer Polar and a Polar hiccup would read as
// "flag unknown" everywhere at once. See `src/lib/feature-flags.ts`.
//
// Nothing here may feed the paywall verdict — a rollout flag is not entitlement.

import {
	APP_ROLLOUT_FLAGS,
	appRolloutFlag,
	featureFlagFallback,
} from "@ryu/auth/lib/feature-flags";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
	featureFlagScopeKey,
	isFeatureFlagStale,
	readFeatureFlag,
	refreshFeatureFlags,
	subscribeFeatureFlagPublications,
	subscribeFeatureFlagScope,
} from "@/src/lib/feature-flags.ts";

/** Current best answer for `key`, with the compiled-in default as the floor. */
function resolveNow(key: string): boolean {
	return readFeatureFlag(key) ?? featureFlagFallback(key);
}

/** A flag's current answer and whether that answer is authoritative yet. */
export interface FeatureFlagState {
	enabled: boolean;
	/**
	 * False while `enabled` is only the compiled-in default for a scope whose map
	 * has never been read and whose first refresh has not finished. A caller that
	 * would PERSIST a decision from the flag (rather than just render it) waits
	 * for this, so a cold start cannot overwrite a remembered choice with the
	 * default before the server answers.
	 */
	settled: boolean;
}

function stateNow(key: string, refreshed: boolean): FeatureFlagState {
	return {
		enabled: resolveNow(key),
		settled:
			refreshed || readFeatureFlag(key) !== null || !isFeatureFlagStale(),
	};
}

function sameState(a: FeatureFlagState, b: FeatureFlagState): boolean {
	return a.enabled === b.enabled && a.settled === b.settled;
}

/**
 * {@link useFeatureFlag} plus whether the answer is authoritative yet. Also
 * re-reads whenever a fresher map is published, so a reader mounted for the
 * app's lifetime follows flips another surface fetched.
 */
export function useFeatureFlagState(key: string): FeatureFlagState {
	// Seeded synchronously so the first paint uses the cached value rather than
	// flashing the default and then correcting itself.
	const [state, setState] = useState(() => stateNow(key, false));
	// Re-run the effect below whenever the (account, org) scope changes, so an
	// org switch re-reads and refetches rather than serving the old org's map.
	const scopeKey = useSyncExternalStore(
		subscribeFeatureFlagScope,
		featureFlagScopeKey,
		featureFlagScopeKey
	);

	useEffect(
		() =>
			subscribeFeatureFlagPublications(() => {
				const next = stateNow(key, true);
				setState((current) => (sameState(current, next) ? current : next));
			}),
		[key]
	);

	useEffect(() => {
		let cancelled = false;
		// Re-read on mount even when nothing is stale: another surface (or the
		// app-entry entitlement resolve) may have published since this component
		// last rendered, or the scope (account / org) may have just changed.
		const current = stateNow(key, false);
		setState((previous) => (sameState(previous, current) ? previous : current));
		if (!isFeatureFlagStale()) {
			return;
		}
		refreshFeatureFlags().then(() => {
			if (!cancelled) {
				// Settled even when the refresh failed: the default is then the
				// best answer this scope will get until a later refresh.
				const next = stateNow(key, true);
				setState((previous) => (sameState(previous, next) ? previous : next));
			}
		});
		return () => {
			cancelled = true;
		};
	}, [key, scopeKey]);

	return state;
}

/**
 * Whether a capability is switched on for the signed-in account. Always returns
 * a boolean — a caller should never have to reason about "unknown", because the
 * catalog already declared what unknown means for this key.
 */
export function useFeatureFlag(key: string): boolean {
	return useFeatureFlagState(key).enabled;
}

/** Every distinct flag that gates an app listing, in a stable order. */
const APP_ROLLOUT_FLAG_KEYS = [...new Set(Object.values(APP_ROLLOUT_FLAGS))];

/** Current best answer for every app-listing rollout flag. */
function resolveAppRolloutFlags(): Readonly<Record<string, boolean>> {
	const flags: Record<string, boolean> = {};
	for (const key of APP_ROLLOUT_FLAG_KEYS) {
		flags[key] = resolveNow(key);
	}
	return flags;
}

/**
 * Predicate for Store listings held behind an app rollout flag
 * (`APP_ROLLOUT_FLAGS`): `true` for an app with no rollout flag, otherwise the
 * flag's current value. Same freshness rules as {@link useFeatureFlag}. A
 * discovery gate only: callers keep showing installed apps.
 */
export function useAppListingAllowed(): (appId: string) => boolean {
	const [flags, setFlags] = useState(resolveAppRolloutFlags);
	// Same (account, org) scope tracking as `useFeatureFlag`.
	const scopeKey = useSyncExternalStore(
		subscribeFeatureFlagScope,
		featureFlagScopeKey,
		featureFlagScopeKey
	);

	useEffect(
		() =>
			subscribeFeatureFlagPublications(() =>
				setFlags(resolveAppRolloutFlags())
			),
		[]
	);

	useEffect(() => {
		let cancelled = false;
		setFlags(resolveAppRolloutFlags());
		if (!isFeatureFlagStale()) {
			return;
		}
		refreshFeatureFlags().then(() => {
			if (!cancelled) {
				setFlags(resolveAppRolloutFlags());
			}
		});
		return () => {
			cancelled = true;
		};
	}, [scopeKey]);

	return useCallback(
		(appId: string) => {
			const flag = appRolloutFlag(appId);
			return flag === undefined || flags[flag] === true;
		},
		[flags]
	);
}

/** A Store row the rollout gate can judge: its id, and whether it is installed. */
export interface StoreListing {
	id: string;
	installed?: boolean;
}

/**
 * {@link useAppListingAllowed} for a Store row that knows whether it is
 * installed. Installed rows always show (installing was the opt-in); every
 * other row needs its app rollout flag. Use it on EVERY Store path that lists
 * `/api/plugins/catalog` entries (search, Home rows, For you), not only the
 * Apps tab, so a gated app is never discoverable through a side door.
 */
export function useStoreListingAllowed(): (listing: StoreListing) => boolean {
	const allowed = useAppListingAllowed();
	return useCallback(
		(listing: StoreListing) =>
			listing.installed === true || allowed(listing.id),
		[allowed]
	);
}
