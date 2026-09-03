/**
 * Server-driven feature flags: the catalog of ROLLOUT switches the control
 * plane serves to already-installed clients, plus the pure resolver both the
 * billing read and the gateway handshake run.
 *
 * THE HONEST CONSTRAINT, first, because it bounds everything this file can do:
 * a flag cannot deliver code that is not in the installed binary. The shipped
 * `v0.1.4` tag carries neither `managed_fleet` in `apps/core/src/sidecar/gateway.rs`
 * nor `ManagedInferenceSettings` in the desktop, so nothing here retro-enables
 * anything on that build. What this mechanism buys is that the NEXT release is
 * the LAST one required for the capabilities it covers — after that a switch is
 * a control-plane change, not a client ship.
 *
 * WHY THIS IS NOT A `FEATURES` ENTRY (`features.ts`), and why the two must
 * never be merged: `hasFeature()` answers "has this USER earned or bought it"
 * — a per-user db read against `UserUnlocks`, with `requiresPlan` as the money
 * fast-path. This file answers a different question: "is this capability
 * switched ON for this org right now", which is a rollout/discovery decision
 * with no per-user dimension at all. Conflating them makes dark-launching to a
 * PAYING user impossible (they would be entitled and therefore unable to be
 * held back) and makes holding back a rollout look like revoking something a
 * customer bought. `FEATURES` already owns the key `managed_inference`; the
 * flag below is deliberately namespaced `ui.managed_inference_card` so no
 * reader can mistake one axis for the other.
 *
 * WHY IT MIRRORS `plans.ts` AND NOT `features.ts` STRUCTURALLY: `features.ts`
 * imports `@ryu/db/models/user-unlocks.model`. The DESKTOP imports this module
 * (via `useFeatureFlag` → `featureFlagFallback`), so a db import here would
 * pull Mongoose into the renderer bundle. This file must stay pure: no db, no
 * env, no I/O — just the catalog and a total function over it. The env override
 * reader lives server-side in `packages/api/src/lib/feature-flags.ts`.
 */

/**
 * How a client should behave for a flag it has NEVER successfully read (no
 * cached value, check failed or never ran).
 *
 * Deliberately per-flag rather than a blanket "money fails closed": the desktop
 * billing client (`apps/desktop/src/lib/api/billing.ts`) opens by rejecting
 * exactly that blanket rule — resolving an OUTAGE to `false` would falsely lock
 * out a real paying user. The rule that survives contact with that file:
 *
 *  - never known at all  → the compiled-in `defaultValue` below;
 *  - known, then a check FAILED → ride the last-good value, never this.
 *
 * `"closed"` is for money-adjacent surfaces (default them off; a rollout that
 * has not reached you should not show you a spend surface). `"open"` is for
 * cosmetic capability, where hiding a control on a network blip is the worse
 * failure. The field exists so the direction is declared once, at authoring
 * time, instead of being argued at each call site.
 */
export type FeatureFlagFailMode = "closed" | "open";
export type FeatureFlagExposure = "client" | "private" | "public";

/** One rollout switch. `key` is a wire identifier — never rename one in flight. */
export interface FeatureFlagDef {
	/** The compiled-in value used when the map was NEVER seen. */
	defaultValue: boolean;
	/** What the flag gates, in one line, for whoever flips it. */
	description: string;
	/** Which client boundary may receive the evaluated value. */
	exposure: FeatureFlagExposure;
	/** Direction to fail when a client has no value at all. See the type doc. */
	failMode: FeatureFlagFailMode;
	/** Stable dotted key. Namespaced by surface so it cannot collide with `FEATURES`. */
	key: string;
}

/** Stable key for the temporary organization-first pricing rollout. */
export const INDIVIDUAL_PLANS_FLAG = "billing.individual_plans" as const;

/**
 * The catalog. Adding a row here is enough for the SERVER to serve the key; a
 * client only sees it if a build carrying the reader is installed (see the
 * honest constraint above).
 */
export const FEATURE_FLAGS: FeatureFlagDef[] = [
	{
		key: "ui.managed_inference_card",
		description:
			"Show the Managed inference (fleet URL + org token) card in the desktop's Gateway → Network settings.",
		defaultValue: false,
		exposure: "client",
		// Money-adjacent, so default OFF — but note precisely what that does and
		// does not do. Hiding the card does NOT stop spend: the prefs persist and
		// Core keeps resolving the fleet from them. Showing it does NOT enable
		// spend: minting an `rgw_` key is 402-gated by `managedInferenceAvailableForOrg`,
		// and `/gateway/resolve` recomputes `managedInference` on every 60s window.
		// This flag is a ROLLOUT / DISCOVERY gate. Both real gates are server-side
		// and must stay there — do not treat this as a money control.
		failMode: "closed",
	},
	{
		key: INDIVIDUAL_PLANS_FLAG,
		description:
			"Show the individual pricing shelf and allow new individual-plan checkout; existing individual entitlements remain valid when this is off.",
		defaultValue: false,
		exposure: "public",
		// Money-adjacent availability must stay closed until the rollout is
		// explicitly opened. The billing router applies the same decision, so
		// hiding the shelf is not the security boundary.
		failMode: "closed",
	},
];

/** Definition for a key, or undefined when the key is not in the catalog. */
export const featureFlagByKey = (key: string): FeatureFlagDef | undefined =>
	FEATURE_FLAGS.find((flag) => flag.key === key);

/**
 * The value a client uses for a flag it has NEVER successfully read. Unknown
 * keys resolve `false`: a client asking about a key this build's catalog does
 * not carry is asking about a capability it cannot render anyway.
 */
export function featureFlagFallback(key: string): boolean {
	return featureFlagByKey(key)?.defaultValue ?? false;
}

/** The code defaults, as a plain map. */
export function defaultFeatureFlags(): Record<string, boolean> {
	const map: Record<string, boolean> = {};
	for (const flag of FEATURE_FLAGS) {
		map[flag.key] = flag.defaultValue;
	}
	return map;
}

export interface ResolveFeatureFlagsInput {
	/**
	 * The org the flags are resolved FOR, or null for a lone individual.
	 *
	 * Load-bearing that null is a first-class case, not an error: `resolvePrincipal`
	 * yields `scope: "user" | "org"`, and the self-hosted individual — precisely the
	 * population these flags target — has no organization. Global overrides MUST
	 * still apply to them. Unused by the pure resolver today (v1 overrides are
	 * global); it is on the signature so the per-org seam lands here rather than
	 * changing every call site.
	 */
	organizationId?: string | null;
	/** Overrides applied over the code defaults. Unknown keys are ignored. */
	overrides?: Record<string, boolean> | null;
}

/**
 * Resolve the flag map served to a client. Pure and total.
 *
 * UNKNOWN OVERRIDE KEYS ARE DROPPED, on purpose: the control plane is flipped
 * ahead of the fleet, so it will routinely carry keys older clients have never
 * heard of. Passing them through would be harmless on the wire but would make
 * the served map disagree with the catalog, and the catalog is what documents
 * the fail direction. Dropping them means a new key can never break an old
 * client, which is the property that makes "the next release is the last one
 * required" true.
 */
export function resolveFeatureFlags(
	input: ResolveFeatureFlagsInput = {}
): Record<string, boolean> {
	const resolved = defaultFeatureFlags();
	const overrides = input.overrides;
	if (!overrides) {
		return resolved;
	}
	for (const flag of FEATURE_FLAGS) {
		const override = overrides[flag.key];
		if (typeof override === "boolean") {
			resolved[flag.key] = override;
		}
	}
	return resolved;
}
