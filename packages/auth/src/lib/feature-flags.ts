import { z } from "zod";
import { FEATURE_FLAGS } from "./feature-flag-catalog.ts";
import {
	FAMILY_HUB_FLAG,
	SERVICE_BOX_FLAG,
	SERVICE_CONNECT_FLAG,
	SERVICE_GATEWAY_FLAG,
	SERVICE_HIRE_FLAG,
	SERVICE_MAIL_FLAG,
	SERVICE_MESSAGING_FLAG,
	SERVICE_NOTIFY_FLAG,
	SERVICE_PASSPORT_FLAG,
	SERVICE_SITES_FLAG,
} from "./feature-flag-keys.ts";
import type { FeatureFlagTargetRule } from "./feature-waitlists.ts";

export { FEATURE_FLAGS } from "./feature-flag-catalog.ts";
export {
	A_MAJOR_PASS_FLAG,
	ABUSE_JOBS_FLAG,
	BILLING_PERIODS_FLAG,
	CATALOG_AGENTS_AS_A_SERVICE_FLAG,
	CATALOG_RED_TEAM_FLAG,
	CATALOG_WORKFLOWS_FLAG,
	CLOUD_TASKS_BOX_BACKEND_FLAG,
	CLOUD_TASKS_SUBSCRIPTION_BACKENDS_FLAG,
	CLOUD_TASKS_SUBSCRIPTION_BACKENDS_HOSTED_OPENAI_FLAG,
	COMPUTE_SHARE_FLAG,
	DESKTOP_TRIAL_FLAG,
	FAMILY_HUB_FLAG,
	FAMILY_SHARING_FLAG,
	INDIVIDUAL_PLANS_FLAG,
	INTERFACE_OS_FLAG,
	MANAGED_AGENTS_FLAG,
	MANAGED_AGENTS_PLATFORM_KEYS_FLAG,
	MESSAGING_FLAG,
	ONBOARDING_CONNECTION_REWARDS_FLAG,
	PLAN_MIGRATIONS_FLAG,
	PLUS_PUBLIC_FLAG,
	SERVICE_BOX_FLAG,
	SERVICE_CONNECT_FLAG,
	SERVICE_GATEWAY_FLAG,
	SERVICE_HIRE_FLAG,
	SERVICE_MAIL_FLAG,
	SERVICE_MESSAGING_FLAG,
	SERVICE_NOTIFY_FLAG,
	SERVICE_PASSPORT_FLAG,
	SERVICE_SITES_FLAG,
	STANDALONE_PAYG_FLAG,
	STARTUP_PROGRAM_FLAG,
	STUDENT_PROGRAM_FLAG,
	TEMPLATE_REWARDS_PILOT_FLAG,
	WATCH_GITHUB_PARTNER_FLAG,
	WATCH_WORKER_FLAG,
	WORKSPACE_INTERFACES_FLAG,
} from "./feature-flag-keys.ts";

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

/**
 * Standard audiences a flag can be declared for. Every value is computed
 * SERVER-SIDE ONLY for the authenticated caller (see
 * `packages/api/src/lib/feature-flag-audience.ts`) and served as the string
 * array trait `audience`, so the existing `in` / `equals` conditions match it:
 *
 *  - `signed_in` / `anonymous`: a non-anonymous vs anonymous Better Auth user;
 *  - `platform_admin`: the `ADMIN_EMAILS` allowlist with a verified email (the
 *    allowlist `requirePlatformAdmin` starts from, never `role === "admin"`);
 *  - `waitlisted` / `waitlist_admitted`: signed-in users still in, or out of,
 *    the account waitlist;
 *  - `org_member` / `org_admin` / `org_owner`: hierarchical membership of the
 *    resolved organization (an owner carries all three).
 */
export const FEATURE_FLAG_AUDIENCES = [
	"signed_in",
	"anonymous",
	"platform_admin",
	"waitlisted",
	"waitlist_admitted",
	"org_member",
	"org_admin",
	"org_owner",
] as const;
export type FeatureFlagAudience = (typeof FEATURE_FLAG_AUDIENCES)[number];

/**
 * Trait keys only the server may assign. A client-supplied attribute with one
 * of these keys is dropped before evaluation, so a client can never assert
 * platform admin, plan, org role, waitlist status or tester-group membership.
 * `organization_id` is the server-resolved org the map is evaluated for, so an
 * admin rule such as `organization_id in [...]` switches a flag per
 * organization. `group`/`groups` are filled only from server-side tester
 * enrollment for a signed-in caller; anonymous callers and platform evaluation
 * never carry them.
 */
export const RESERVED_FEATURE_FLAG_TRAITS = [
	"audience",
	"group",
	"groups",
	"org_role",
	"waitlist_status",
	"plan",
	"tier",
	"platform_admin",
	"signed_in",
	"user_id",
	"organization_id",
] as const;

/** Rule id of the synthesized catalog audience rule; admins cannot save it. */
export const CATALOG_AUDIENCE_RULE_ID = "catalog_audience" as const;

/** One rollout switch. `key` is a wire identifier — never rename one in flight. */
export interface FeatureFlagDef {
	/**
	 * Audiences the flag is ON for by code declaration. Evaluated as one rule
	 * (`catalogAudienceRule`) appended AFTER the admin-authored rules, so the
	 * precedence is: kill switch (off) > schedule window > approved waitlist
	 * grant (on) > first matching admin rule > this catalog audience rule >
	 * base value (catalog default, then `RYU_FEATURE_FLAGS`, then the admin
	 * override) with the global allocation. Setting the base override false does
	 * NOT close a declared audience; the kill switch does.
	 */
	audiences?: readonly FeatureFlagAudience[];
	/**
	 * Carry this flag in the signed Better Auth JWT (`CORE_FLAG_CLAIM`) so a
	 * node's Core can enforce it offline for a verified cloud caller. Only set
	 * it for rollout flags Core must enforce: every key widens every token.
	 * The claim lists ENABLED keys only, evaluated at mint time for the user in
	 * the session's active organization (with that org's member role and
	 * billing plan, as `/subscription-status` does), and names that org in
	 * `CORE_FLAG_ORG_CLAIM`. A token is stale for at most its lifetime
	 * (15 minutes by default) after a flip or an org switch.
	 */
	coreClaim?: boolean;
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

/**
 * Rollout flag per standalone product slug (`STANDALONE_PRODUCT_PRICING` and
 * the `standalone: true` products in `@ryu/blocks/web/data/products.tsx`).
 * Surfaces consult this generic map instead of hard-coding a slug.
 */
export const STANDALONE_SERVICE_FLAGS = {
	box: SERVICE_BOX_FLAG,
	connect: SERVICE_CONNECT_FLAG,
	gateway: SERVICE_GATEWAY_FLAG,
	hire: SERVICE_HIRE_FLAG,
	mail: SERVICE_MAIL_FLAG,
	messaging: SERVICE_MESSAGING_FLAG,
	notify: SERVICE_NOTIFY_FLAG,
	passport: SERVICE_PASSPORT_FLAG,
	sites: SERVICE_SITES_FLAG,
} as const satisfies Readonly<Record<string, string>>;
export type StandaloneServiceSlug = keyof typeof STANDALONE_SERVICE_FLAGS;

const isStandaloneServiceSlug = (slug: string): slug is StandaloneServiceSlug =>
	Object.hasOwn(STANDALONE_SERVICE_FLAGS, slug);

export const STANDALONE_SERVICE_SLUGS: readonly StandaloneServiceSlug[] =
	Object.keys(STANDALONE_SERVICE_FLAGS).filter(isStandaloneServiceSlug);

/**
 * Standalone services whose product PAGE is also a plan-included platform
 * surface. Gateway is the governed model and tool plane every plan uses, so
 * its flag hides only the standalone listing (the no-plan pricing card); the
 * product page and the Platform header link stay. Its no-plan PAYG checkout
 * stays governed by `billing.standalone_payg`.
 */
const PLAN_INCLUDED_PRODUCT_PAGES: ReadonlySet<string> = new Set(["gateway"]);

/** Rollout flag that gates a standalone service, or undefined when none does. */
export const standaloneServiceFlag = (slug: string): string | undefined =>
	isStandaloneServiceSlug(slug) ? STANDALONE_SERVICE_FLAGS[slug] : undefined;

/**
 * Whether a standalone service's listing (pricing card, Store, console card) is
 * rolled out in an evaluated flag map. A slug with no flag is always listed; a
 * flagged slug missing from the map (never read, malformed) takes the catalog
 * default: listed for Box (`services.box` ships on), hidden for the rest.
 */
export function standaloneServiceListed(
	slug: string,
	values: Readonly<Record<string, unknown>> | null | undefined
): boolean {
	const flag = standaloneServiceFlag(slug);
	if (flag === undefined) {
		return true;
	}
	const value = values?.[flag];
	return typeof value === "boolean" ? value : featureFlagFallback(flag);
}

/**
 * Whether `/products/<slug>` and its nav, index and sitemap entries are shown.
 * Same as {@link standaloneServiceListed}, except a plan-included platform page
 * (Gateway) is never hidden by its standalone flag.
 */
export function standaloneProductPageOpen(
	slug: string,
	values: Readonly<Record<string, unknown>> | null | undefined
): boolean {
	return (
		PLAN_INCLUDED_PRODUCT_PAGES.has(slug) ||
		standaloneServiceListed(slug, values)
	);
}

/** Standalone product slugs whose product page is closed in a flag map. */
export function closedStandaloneProductPages(
	values: Readonly<Record<string, unknown>> | null | undefined
): StandaloneServiceSlug[] {
	return STANDALONE_SERVICE_SLUGS.filter(
		(slug) => !standaloneProductPageOpen(slug, values)
	);
}

/** Standalone service slugs whose listing is hidden in a flag map. */
export function unlistedStandaloneServices(
	values: Readonly<Record<string, unknown>> | null | undefined
): StandaloneServiceSlug[] {
	return STANDALONE_SERVICE_SLUGS.filter(
		(slug) => !standaloneServiceListed(slug, values)
	);
}

/**
 * Apps whose catalog listing is held behind a rollout flag, keyed by app id.
 * Catalog surfaces consult this generic map instead of hard-coding an app id,
 * and hide the listing until the flag resolves true. Installed apps are never
 * filtered through it: installing is the opt-in.
 */
export const APP_ROLLOUT_FLAGS: Readonly<Record<string, string>> = {
	"@ryu/family": FAMILY_HUB_FLAG,
	// The Sites app is the standalone Sites surface on a node. Core pre-installs
	// it on every node (`CORE_PREINSTALLED`) and installed rows are never
	// filtered, so this gates only the cloud marketplace listing and the web
	// showcase, not a node's own Store or sidebar. `@ryu/mail` is deliberately
	// absent: it is the plan-included Agent Inboxes companion.
	"@ryu/sites": SERVICE_SITES_FLAG,
};

/** Rollout flag that gates an app's catalog listing, or undefined when none does. */
export const appRolloutFlag = (appId: string): string | undefined =>
	Object.hasOwn(APP_ROLLOUT_FLAGS, appId)
		? APP_ROLLOUT_FLAGS[appId]
		: undefined;

/**
 * Whether an app (by manifest id) is listed in an evaluated flag map: always
 * for an app with no rollout flag, otherwise its flag's value. A gated app
 * missing from the map (never read, malformed) takes the catalog default,
 * which keeps it hidden. Marketing surfaces that showcase an app (the
 * `/products/apps` pages and the sitemap) use this so they follow the same
 * rollout as the app's Store listing.
 */
export function appRolloutListed(
	appId: string,
	values: Readonly<Record<string, unknown>> | null | undefined
): boolean {
	const flag = appRolloutFlag(appId);
	if (flag === undefined) {
		return true;
	}
	const value = values?.[flag];
	return typeof value === "boolean" ? value : featureFlagFallback(flag);
}

/**
 * JWT claim carrying the enabled `coreClaim` flags as a string array. Core
 * (`apps/core/src/identity_verify`) parses it; absence means "none enabled".
 */
export const CORE_FLAG_CLAIM = "ryu_flags" as const;

/**
 * Sibling JWT claim naming the organization `CORE_FLAG_CLAIM` was evaluated
 * for (a string id, or null when the evaluation had no org context). Core
 * refuses a claim evaluated for a different org than the node it reaches.
 */
export const CORE_FLAG_ORG_CLAIM = "ryu_flags_org" as const;

/** Definition for a key, or undefined when the key is not in the catalog. */
export const featureFlagByKey = (key: string): FeatureFlagDef | undefined =>
	FEATURE_FLAGS.find((flag) => flag.key === key);

/** Keys of the catalog flags carried in the Core JWT claim. */
export function coreClaimFlagKeys(): string[] {
	return FEATURE_FLAGS.filter((flag) => flag.coreClaim === true).map(
		(flag) => flag.key
	);
}

/**
 * The claim value for an evaluated flag map: the `coreClaim` keys whose value
 * is exactly `true`, sorted. Anything missing or non-true is omitted, so an
 * evaluation that could not decide a key fails closed.
 */
export function coreFlagClaimFromValues(
	values: Readonly<Record<string, unknown>>
): string[] {
	return coreClaimFlagKeys()
		.filter((key) => values[key] === true)
		.sort();
}

/**
 * The synthesized rule for a flag's code-declared audiences, or null when it
 * declares none. Callers append it after the admin-authored rules.
 */
export function catalogAudienceRule(
	definition: Pick<FeatureFlagDef, "audiences">
): FeatureFlagTargetRule | null {
	const audiences = definition.audiences ?? [];
	if (audiences.length === 0) {
		return null;
	}
	return {
		id: CATALOG_AUDIENCE_RULE_ID,
		name: "Catalog audience",
		enabled: true,
		allocationPercent: 100,
		conditions: [
			{ attribute: "audience", operator: "in", value: [...audiences] },
		],
	};
}

/**
 * The value a client uses for a flag it has NEVER successfully read. Unknown
 * keys resolve `false`: a client asking about a key this build's catalog does
 * not carry is asking about a capability it cannot render anyway.
 */
export function featureFlagFallback(key: string): boolean {
	return featureFlagByKey(key)?.defaultValue ?? false;
}

/** Evaluated rollout values keyed by their stable wire identifiers. */
export interface FeatureFlagValues {
	[key: string]: boolean;
}

/** The code defaults, as a plain map. */
export function defaultFeatureFlags(): FeatureFlagValues {
	const map: FeatureFlagValues = {};
	for (const flag of FEATURE_FLAGS) {
		map[flag.key] = flag.defaultValue;
	}
	return map;
}

/** Environment override maps arrive as JSON; only boolean entries are applied. */
const rawOverridesSchema = z.record(z.string(), z.json());
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
	overrides?: z.input<typeof rawOverridesSchema> | null;
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
		const parsed = z.boolean().safeParse(override);
		if (parsed.success) {
			resolved[flag.key] = parsed.data;
		}
	}
	return resolved;
}
