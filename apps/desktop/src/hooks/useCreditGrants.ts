// apps/desktop/src/hooks/useCreditGrants.ts
//
// The caller's POOL-RESTRICTED grant balances (`GET /api/campaigns/mine`), for
// every surface that has to distinguish "you have credit" from "you have credit
// THAT CAN PAY FOR THIS". Two consumers today, which is why this is a query
// rather than page state: the Credits page (balance breakdown) and the composer
// picker (a pool row must not upsell a subscription to someone already holding
// that pool's granted credit). TanStack Query dedupes the single request across
// both.
//
// Unlike the node-scoped hooks, this targets the control plane (:3000, session
// bearer), so the key carries the active organization id rather than a node url.
//
// Everything about this hook is fail-quiet by design. Grants are a minority
// feature: most accounts hold none, and a control plane that predates the route
// answers 404. `fetchMyCampaigns` already turns both into `null`, and `retry:
// false` keeps a genuine transport failure from re-hammering a route that may
// simply not exist. The hook therefore has no error channel at all — callers get
// an empty list and render exactly what they rendered before grants existed.

import {
	ALL_CREDIT_POOLS,
	type CreditPoolId,
} from "@ryu/auth/lib/credit-pools";
import { useQuery } from "@tanstack/react-query";
import {
	fetchMyCampaigns,
	type MyCampaignsResponse,
} from "@/src/lib/api/campaigns.ts";
import { hasCreditsAuth } from "@/src/lib/api/credits.ts";
import { useActiveOrgId } from "@/src/lib/api/orgs.ts";

/** One pool's remaining granted balance, flattened for rendering. */
export interface GrantPoolBalance {
	/** ISO timestamp when this pool's grant money lapses, or null if it does not. */
	expiresAt: string | null;
	/** Whether this balance can only be used with an allocated free provider. */
	isFreeProvider: boolean;
	/** The pool's user-facing tier name ("Ryu Fast"), never a vendor name. */
	label: string;
	/**
	 * The `CreditPoolId` this row is about, or `null` when this build cannot tell.
	 *
	 * The wire carries the pool's LABEL and its free-provider classification (see
	 * `CampaignPoolBalance`), but no pool id, so the id is recovered from the local
	 * catalog — a newer control plane may serve a pool this build has never heard
	 * of. Consumers that key behaviour off the id (the composer picker's "already
	 * granted, do not upsell" rule) must skip a null; consumers that only render
	 * label + amount + expiry must NOT, because the money is real either way.
	 */
	poolId: CreditPoolId | null;
	remainingMicroUsd: number;
}

/**
 * Reverse index user-facing label → pool id, built once at module load.
 *
 * WHY a label lookup at all: `/api/campaigns/mine` aggregates a wallet's grants
 * BY LABEL and emits no pool id, so this is the only bridge back to the catalog.
 * The labels are unique across the three catalog entries, but a future duplicate
 * would make attribution ambiguous — and a wrong id here silently suppresses the
 * subscription upsell for the wrong pool. So a contested label resolves to
 * `null` (unknown) rather than to a guess. No throw: this runs inside the UI
 * bundle, and a catalog nit must not blank the app.
 */
const POOL_ID_BY_LABEL: ReadonlyMap<string, CreditPoolId | null> = (() => {
	const index = new Map<string, CreditPoolId | null>();
	for (const pool of ALL_CREDIT_POOLS) {
		index.set(pool.label, index.has(pool.label) ? null : pool.id);
	}
	return index;
})();

export interface UseCreditGrantsResult {
	/** True while the optional allocation read is in flight. */
	loading: boolean;
	/**
	 * Pools with a positive remaining balance, newest server ordering preserved.
	 * Empty whenever there is nothing to show — signed out, no grants, route
	 * absent, or the request failed. Consumers must not distinguish those cases.
	 */
	pools: GrantPoolBalance[];
}

/** Grants move only when money is granted or spent; a five-minute window keeps
 *  the picker from re-fetching on every open while still reflecting a fresh
 *  grant within one session. */
const GRANTS_STALE_MS = 5 * 60 * 1000;

const NO_POOLS: GrantPoolBalance[] = [];

/**
 * Hoisted to module scope, not inlined into the query options: TanStack re-runs
 * `select` whenever its FUNCTION IDENTITY changes, so an inline closure would
 * hand back a brand-new array on every render. The composer picker memoizes off
 * this list, so that churn would rebuild the whole picker body on every
 * keystroke.
 */
const selectGrantPools = (
	data: MyCampaignsResponse | null
): GrantPoolBalance[] =>
	(data?.pools ?? [])
		// A DRAINED pool is not a pool the user holds. `/api/campaigns/mine`
		// aggregates every grant whose status is still `active`, and a grant drawn
		// to zero is only flipped to `exhausted` by a SECOND write that follows the
		// draw — so a row can legitimately arrive summing to 0, and does so
		// permanently if the process died between those two writes. Filtering here
		// rather than trusting the server keeps both consumers honest for the price
		// of one predicate: the Credits page would otherwise print "Ryu Fast —
		// $0.00" where the whole point of the section is that an account with
		// nothing granted sees the pre-grant card, and the composer picker would
		// read the row as "already granted" and suppress the subscription upsell
		// for a pool the user cannot spend a cent of.
		.filter((entry) => entry.remainingMicroUsd > 0)
		.map((entry) => ({
			// The server is the authority on the label; the id is only ever a local
			// interpretation of it, and is allowed to come back null.
			poolId: POOL_ID_BY_LABEL.get(entry.poolLabel) ?? null,
			label: entry.poolLabel,
			remainingMicroUsd: entry.remainingMicroUsd,
			isFreeProvider: entry.isFreeProvider,
			expiresAt: entry.expiresAt,
		}));

export function useCreditGrants(): UseCreditGrantsResult {
	const activeOrgId = useActiveOrgId();
	const query = useQuery({
		queryKey: ["credit-grants", activeOrgId ?? "unscoped"],
		queryFn: fetchMyCampaigns,
		enabled: hasCreditsAuth(),
		retry: false,
		staleTime: GRANTS_STALE_MS,
		select: selectGrantPools,
	});

	// A stable empty array, so a consumer that memoizes on `pools` does not
	// invalidate on every render while the query is idle or in flight.
	return { loading: query.isFetching, pools: query.data ?? NO_POOLS };
}
