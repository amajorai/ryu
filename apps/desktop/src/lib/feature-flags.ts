// apps/desktop/src/lib/feature-flags.ts
//
// The active account's (and active org's) server-driven ROLLOUT flags, mirrored locally so a
// surface can read one synchronously and refresh it without a restart.
//
// WHAT A FLAG IS AND IS NOT. These are rollout/discovery switches
// (`@ryu/auth/lib/feature-flags`), a different axis from entitlement: what has
// been switched ON for you, not what you have paid for. Nothing here may ever
// reach `decideDesktopAccess`, the paywall verdict, or the cached entitlement —
// the same firewall `updates-window.ts` keeps, and for the same reason.
//
// Why localStorage rather than the entitlement context, exactly as
// `updates-window.ts` argues: this is a synchronous value a component reads at
// render time, without prop-threading or awaiting a resolve, and the last-known
// value has to survive an offline launch.
//
// Why every read is SCOPED to the active account AND organization: signing out
// clears the auth vault (`ryu_accounts` / `ryu_active_user_id`) but not this
// key. An unscoped cached "card visible" from account A would leak straight to
// account B on the same machine — showing them a surface that was rolled out to
// someone else. Audiences can also target the account's role in the ACTIVE
// organization (`org_role` / `org_admin`), so an admin-only flag fetched while
// org X was active must not survive a switch to org Y, where the same account is
// a plain member. Scoping on READ makes sign-out, full logout, account switching
// and org switching all correct without a single teardown call.
//
// Where the org comes from: the app-wide active-org query for the ACTIVE
// ACCOUNT (`activeOrgQueryKey(accountId)`, the same fact `useActiveOrgId` serves
// every org-scoped surface), read synchronously from the app query client. It is
// keyed by account, so an account switch can never pair the new account with the
// org the previous account had active. Its three states map onto three answers:
//   - resolved (an id, or null for "no org")  -> read/publish that exact scope
//   - not loaded yet                           -> nothing is readable yet; a
//                                                 refresh resolves it first
//   - lookup FAILED with nothing loaded        -> offline: ride the last-good
//                                                 record this account wrote,
//                                                 because switching org needs
//                                                 the same server we cannot
//                                                 reach. Publishing stays off.
// The active org lives on THIS device's session, so a switch on another device
// does not change it. The one deliberate cross-org exception: a switch made here
// whose flags refresh then failed, followed by an offline launch, rides the
// previous org's record. That is acceptable only because these flags are UI
// discovery: Core enforces `cloud_tasks.box_backend` from the signed `ryu_flags`
// JWT claim, and no flag here may gate anything security-relevant.
// A record written before org scoping (no `orgId`) counts as unscoped: readable
// only while no org is active.
//
// SEVERAL SCOPES ARE KEPT, not one slot: up to eight (account, org) records per
// account, least recently published evicted first. Switching back to an org
// visited earlier therefore restores its last-known flags on the first paint,
// and the switch still forces one revalidation even inside the TTL, because the
// org-role audiences may have changed while it was not active.
//
// RACES WITH A SWITCH. A response is published only for the scope captured when
// its request STARTED, and only if that scope is still active when it lands.
// Two further guards cover an org switch made on the server: a response is
// dropped when an org switch from this device started or was in flight since
// the request was captured, and when the control plane says it served the flags
// for an organization other than the captured one.
//
// THE FAIL DIRECTION, which is not a blanket rule. `lib/api/billing.ts` opens by
// rejecting "money fails closed" as a blanket: resolving an OUTAGE to false
// falsely locks out a real paying user. So:
//   - never known at all       -> the compiled-in `featureFlagFallback(key)`
//   - known, then a check FAILED -> ride the last-good value stored here
// A failed refresh therefore writes NOTHING. `publishFeatureFlags(null)` is
// reserved for "the check succeeded and carried no flags", not for an outage.

import { getActiveUserId } from "@/lib/auth-client.ts";
import { fetchEntitlementSnapshot } from "@/src/lib/api/billing.ts";
import {
	activeOrgQueryKey,
	activeOrgSwitchState,
	getActiveOrgId,
	getActiveOrgIdForAccount,
	hasOrgAuth,
} from "@/src/lib/api/orgs.ts";
import { queryClient as appQueryClient } from "@/src/lib/query-client.ts";
import {
	decodeStoredFeatureFlagScopes,
	encodeStoredFeatureFlagScopes,
	type FeatureFlagScope,
	findStoredFeatureFlags,
	type StoredFeatureFlags,
	sameFeatureFlagScope,
	storedFeatureFlagsMatchScope,
	storedFeatureFlagValue,
	upsertStoredFeatureFlags,
} from "./feature-flag-cache.ts";

export type { FeatureFlagScope } from "./feature-flag-cache.ts";

/**
 * localStorage key: `{ version: 2, records: [{ accountId, orgId, features,
 * fetchedAtMs }, ...] }`, most recently published scope first. A single legacy
 * record (no `version`) still reads as a one-entry list.
 */
const FEATURE_FLAGS_KEY = "ryu.feature-flags";

/**
 * How long a fetched map is served before a reader triggers a refresh.
 *
 * Deliberately the same 60s as `POSITIVE_TTL` in
 * `apps/gateway/src/policy/cache.rs`, so the two caches of control-plane policy
 * are visibly ONE choice about how stale a flip may be, not two numbers that
 * drifted apart. Change one, change the other.
 */
const FEATURE_FLAGS_TTL_MS = 60_000;

/**
 * In-memory mirror of the active scope's stored record, so the common case
 * (several components reading a flag in one render pass) costs no JSON parse.
 */
let cached: StoredFeatureFlags | null = null;

/**
 * The (account, org) scope a request was captured for, plus the org-switch
 * generation at that moment (see `activeOrgSwitchState`). Only
 * {@link captureFeatureFlagScope} produces one, which is what ties a publish to
 * the moment its request started.
 */
export interface FeatureFlagRequestScope extends FeatureFlagScope {
	orgSwitchGeneration: number;
}

/**
 * The last RESOLVED scope a reader saw, and a scope that must refresh once even
 * though its stored record is inside the TTL: the one just switched back to.
 */
let lastResolvedScopeKey: string | null = null;
let revalidateScopeKey: string | null = null;

/**
 * The refresh currently in flight, shared by every concurrent caller OF THIS
 * MODULE.
 *
 * Load-bearing, not a micro-optimization. `fetchEntitlementSnapshot()` hits
 * `/subscription-status`, whose handler paginates EVERY Polar order for the
 * customer, so two components mounting in the same frame would otherwise each
 * start their own full pagination. Bounding refreshes by user action is only
 * half the guarantee; this is the other half.
 *
 * SCOPE, precisely — do not read more into it than it does. `useEntitlement`
 * calls `fetchEntitlementSnapshot()` DIRECTLY (it needs the whole snapshot, not
 * just the flags) and publishes through `publishFeatureFlags`, bypassing this
 * latch entirely. So a cold start where the dialog is opened before the
 * app-entry resolve lands still issues TWO requests. That overlap is accepted:
 * it is bounded at one extra request, once, per launch — whereas the hook-to-
 * hook fan-out this DOES cover is unbounded in the number of mounted readers.
 * Do not "fix" it by routing `useEntitlement` through here; its snapshot feeds
 * the paywall verdict and must not be served from a flag cache.
 */
let inFlight: { promise: Promise<void>; scopeKey: string } | null = null;

/** What the active (account, org) scope is known to be right now. */
type ScopeResolution =
	| { kind: "signed-out" }
	| { kind: "resolved"; scope: FeatureFlagScope }
	| { accountId: string; kind: "pending" }
	| { accountId: string; kind: "offline" };

/** This account's entry in the app-wide active-org query, read without subscribing. */
function readActiveOrgState(accountId: string): {
	data: string | null | undefined;
	failed: boolean;
} {
	try {
		const state = appQueryClient.getQueryState<string | null>(
			activeOrgQueryKey(accountId)
		);
		return { data: state?.data, failed: state?.status === "error" };
	} catch {
		// A client without query state reads as "not loaded yet".
		return { data: undefined, failed: false };
	}
}

function resolveScope(): ScopeResolution {
	const accountId = getActiveUserId();
	if (accountId === null) {
		return { kind: "signed-out" };
	}
	// No session token means no org can be active for this request either.
	if (!hasOrgAuth()) {
		return { kind: "resolved", scope: { accountId, orgId: null } };
	}
	const org = readActiveOrgState(accountId);
	if (org.data !== undefined) {
		return { kind: "resolved", scope: { accountId, orgId: org.data } };
	}
	return org.failed
		? { accountId, kind: "offline" }
		: { accountId, kind: "pending" };
}

/**
 * A stable string for the current scope resolution. Changes on sign-in/out, an
 * account switch, an org switch, and when the org lookup settles — the moments
 * a flag reader must re-read and, if stale, refresh.
 */
export function featureFlagScopeKey(): string {
	return scopeResolutionKey(resolveScope());
}

function scopeResolutionKey(resolution: ScopeResolution): string {
	switch (resolution.kind) {
		case "signed-out":
			return JSON.stringify([resolution.kind]);
		case "resolved":
			return JSON.stringify([
				resolution.kind,
				resolution.scope.accountId,
				resolution.scope.orgId,
			]);
		default:
			return JSON.stringify([resolution.kind, resolution.accountId]);
	}
}

/**
 * Record that `scopeKey` is the resolved scope now. Moving from one resolved
 * scope to ANOTHER (an account or org switch, not the first resolve of a
 * launch) marks the new one for a single revalidation: its stored record is
 * served immediately, but may predate a change to its audiences.
 */
function noteResolvedScope(scopeKey: string): void {
	if (scopeKey === lastResolvedScopeKey) {
		return;
	}
	if (lastResolvedScopeKey !== null) {
		revalidateScopeKey = scopeKey;
	}
	lastResolvedScopeKey = scopeKey;
}

/**
 * Subscribe to the inputs of {@link featureFlagScopeKey} that the query cache
 * can observe (the active org). Account switches are not query events; reads
 * still scope to the account at READ time, so a stale subscription only delays
 * a refresh, never serves another account's flags.
 */
export function subscribeFeatureFlagScope(onChange: () => void): () => void {
	try {
		return appQueryClient.getQueryCache().subscribe(onChange);
	} catch {
		return () => undefined;
	}
}

/**
 * The (account, org) scope a request starting NOW is for, or null when it
 * cannot be known (signed out, or the org lookup failed). The account is read
 * synchronously first; the org is resolved from the app-wide query, loading it
 * (deduped with any in-flight lookup) when nothing has loaded it yet.
 *
 * Capture this BEFORE a flags request and hand it to
 * {@link publishFeatureFlags}, so a response that lands after an account or org
 * switch is discarded instead of being stored under the new scope.
 */
export async function captureFeatureFlagScope(): Promise<FeatureFlagRequestScope | null> {
	const resolution = resolveScope();
	if (resolution.kind === "resolved") {
		return requestScopeFor(resolution.scope);
	}
	if (resolution.kind === "signed-out") {
		return null;
	}
	const { accountId } = resolution;
	// Captured before the lookup: a switch that starts while the org is being
	// resolved must invalidate the request this scope is captured for.
	const { generation } = activeOrgSwitchState();
	try {
		const orgId = await appQueryClient.ensureQueryData<string | null>({
			queryFn: () => getActiveOrgIdForAccount(accountId, getActiveOrgId),
			queryKey: activeOrgQueryKey(accountId),
		});
		return { accountId, orgId: orgId ?? null, orgSwitchGeneration: generation };
	} catch {
		return null;
	}
}

function requestScopeFor(scope: FeatureFlagScope): FeatureFlagRequestScope {
	return {
		accountId: scope.accountId,
		orgId: scope.orgId,
		orgSwitchGeneration: activeOrgSwitchState().generation,
	};
}

/** Every persisted scope, most recently published first. */
function readStoredScopes(): StoredFeatureFlags[] {
	try {
		const raw = localStorage.getItem(FEATURE_FLAGS_KEY);
		return raw ? decodeStoredFeatureFlagScopes(JSON.parse(raw)) : [];
	} catch {
		return [];
	}
}

/**
 * Read the stored record, but only when it belongs to the (account, org) scope
 * active NOW. An in-memory record for any other scope is dropped on the spot.
 */
function readRecord(): StoredFeatureFlags | null {
	const resolution = resolveScope();
	switch (resolution.kind) {
		case "signed-out":
		case "pending":
			// Nothing can legitimately own the record until the scope is known.
			return null;
		case "offline": {
			// The org cannot be confirmed, and cannot have been switched through
			// the unreachable server either: ride this account's last-good record.
			if (cached?.accountId === resolution.accountId) {
				return cached;
			}
			// The most recently published of this account's scopes.
			cached =
				readStoredScopes().find(
					(record) => record.accountId === resolution.accountId
				) ?? null;
			return cached;
		}
		default:
			break;
	}
	const { scope } = resolution;
	noteResolvedScope(scopeResolutionKey(resolution));
	if (cached && storedFeatureFlagsMatchScope(cached, scope)) {
		return cached;
	}
	// A scope change (account or org) drops the old scope's values before the
	// stored records are consulted; only this scope's own record is accepted.
	cached = findStoredFeatureFlags(readStoredScopes(), scope);
	return cached;
}

/** Readers to re-resolve after a map is published for the active scope. */
const publicationListeners = new Set<() => void>();

/**
 * Subscribe to {@link publishFeatureFlags} for the active scope. A reader that
 * stays mounted for the app's lifetime (the product-mode gate) otherwise keeps
 * the value it read at mount even after another surface or the app-entry
 * entitlement resolve publishes a fresher map.
 */
export function subscribeFeatureFlagPublications(
	listener: () => void
): () => void {
	publicationListeners.add(listener);
	return () => {
		publicationListeners.delete(listener);
	};
}

function notifyFeatureFlagPublication(): void {
	for (const listener of publicationListeners) {
		try {
			listener();
		} catch {
			// One reader's failure must not keep the others stale.
		}
	}
}

/**
 * Publish a map the control plane just served. Call this ONLY after a check that
 * SUCCEEDED — `null` means "checked, and this caller carries no flags", never
 * "could not check". A failed check must leave the stored record alone so the
 * last-good value keeps riding (see the fail-direction note at the top).
 *
 * `requestedFor` is the (account, org) scope that was active when the request
 * STARTED (see {@link captureFeatureFlagScope}). Flags are audience-targeted
 * per user and per org role, so a map fetched for one scope must never be
 * stored under another after a mid-flight account or org switch; a mismatch
 * drops the map and the next read refreshes for the new scope.
 *
 * `servedOrgId` is the organization the control plane says it resolved the
 * flags for (`organizationId` on the status payload), when it says. The map is
 * also dropped when an org switch from this device started or is still in
 * flight since `requestedFor` was captured, or when a captured org differs from
 * the served one: in both cases the server may have answered for another org
 * than the one the map would be stored under.
 *
 * Best-effort: storage failures are swallowed so a blocked or full store can
 * never break the entitlement resolve that called us.
 */
export function publishFeatureFlags(
	map: Record<string, boolean> | null,
	requestedFor: FeatureFlagRequestScope | null,
	servedOrgId?: string | null
): void {
	const resolution = resolveScope();
	if (
		requestedFor === null ||
		resolution.kind !== "resolved" ||
		!sameFeatureFlagScope(resolution.scope, requestedFor)
	) {
		return;
	}
	const switches = activeOrgSwitchState();
	if (
		switches.switching ||
		switches.generation !== requestedFor.orgSwitchGeneration
	) {
		return;
	}
	// With no active org the server falls back to the account's first
	// membership, so only a CAPTURED org can be contradicted by the served one.
	if (
		requestedFor.orgId !== null &&
		servedOrgId !== undefined &&
		servedOrgId !== requestedFor.orgId
	) {
		return;
	}
	const record: StoredFeatureFlags = {
		accountId: resolution.scope.accountId,
		features: map ?? {},
		fetchedAtMs: Date.now(),
		orgId: resolution.scope.orgId,
	};
	cached = record;
	const scopeKey = scopeResolutionKey(resolution);
	noteResolvedScope(scopeKey);
	if (revalidateScopeKey === scopeKey) {
		revalidateScopeKey = null;
	}
	try {
		const records = upsertStoredFeatureFlags(readStoredScopes(), record);
		localStorage.setItem(
			FEATURE_FLAGS_KEY,
			JSON.stringify(encodeStoredFeatureFlagScopes(records))
		);
	} catch {
		// Persistence is best-effort; the in-memory mirror still serves this run.
	}
	notifyFeatureFlagPublication();
}

/**
 * The active (account, org) scope's value for a flag, or `null` when it has
 * NEVER been successfully read for that scope. Null is what makes the compiled-in default reachable —
 * callers must not collapse it to `false` themselves.
 */
export function readFeatureFlag(key: string): boolean | null {
	const value = readRecord()?.features[key];
	return storedFeatureFlagValue(value);
}

/**
 * Whether the stored map is absent or older than the TTL. A record that was
 * never written is stale by definition — that is what makes the first read of a
 * surface fetch one. A scope just switched back to is stale once even inside
 * the TTL, so its restored record is revalidated rather than trusted.
 */
export function isFeatureFlagStale(): boolean {
	const record = readRecord();
	if (record === null) {
		return true;
	}
	if (
		revalidateScopeKey !== null &&
		revalidateScopeKey === featureFlagScopeKey()
	) {
		return true;
	}
	// A clock that moved backwards must not pin the cache as "fresh forever".
	const ageMs = Date.now() - record.fetchedAtMs;
	return !(ageMs >= 0 && ageMs < FEATURE_FLAGS_TTL_MS);
}

async function fetchAndPublish(
	requestedFor: FeatureFlagRequestScope
): Promise<void> {
	const snapshot = await fetchEntitlementSnapshot();
	// `snapshot === null` is a FAILED check (offline / 5xx / signed out).
	// Leave the stored record untouched so last-good keeps riding.
	if (snapshot) {
		publishFeatureFlags(
			snapshot.features,
			requestedFor,
			snapshot.organizationId
		);
	}
}

/**
 * Refresh the map from the control plane, sharing one request across concurrent
 * callers. Resolves when the attempt finishes — successfully or not; a FAILED
 * check publishes nothing, by design.
 *
 * Bounded by user action (a surface mounting), never by a background timer. A
 * timer would put every installed client on the Polar-paginating
 * `/subscription-status` handler every 60s, and a Polar hiccup would then read
 * as "flag unknown" fleet-wide. The tradeoff is honest and deliberate: a flip
 * propagates within one TTL of a surface being OPENED, with no upper bound on
 * staleness for a client that never opens it.
 */
export function refreshFeatureFlags(): Promise<void> {
	// Keyed by scope: a refresh still in flight for the PREVIOUS account or org
	// must not satisfy a reader in the new one — its answer will be discarded.
	const scopeKey = featureFlagScopeKey();
	if (inFlight?.scopeKey === scopeKey) {
		return inFlight.promise;
	}
	const resolution = resolveScope();
	// The common case starts the request synchronously with the scope already
	// captured. Otherwise the org is resolved first, still before the request,
	// and the refresh re-enters under the RESOLVED scope's latch so a reader
	// re-keyed by that same resolution shares it rather than starting another.
	const started =
		resolution.kind === "resolved"
			? fetchAndPublish(requestScopeFor(resolution.scope))
			: captureFeatureFlagScope().then((scope) => {
					if (scope === null) {
						return;
					}
					return resolveScope().kind === "resolved"
						? refreshFeatureFlags()
						: fetchAndPublish(scope);
				});
	const promise: Promise<void> = started
		.catch(() => {
			// Same as a null snapshot: an outage never rewrites the cache.
		})
		.finally(() => {
			if (inFlight?.promise === promise) {
				inFlight = null;
			}
		});
	inFlight = { promise, scopeKey };
	return promise;
}
