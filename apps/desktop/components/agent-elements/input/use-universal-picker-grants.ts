"use client";

import type { CreditPoolId } from "@ryu/auth/lib/credit-pools";
import { useMemo } from "react";
import { totalFreeCredit } from "@/components/agent-elements/input/free-model-tag.ts";
import { useCreditGrants } from "@/src/hooks/useCreditGrants.ts";

/**
 * The user's credit grants, derived for the universal picker: the pool ids that
 * hold granted credit (upsell gating), the per-pool balance (row badges), and
 * the summed free credit (Ryu Router row).
 */
export function useUniversalPickerGrants() {
	// Pools the user holds granted credit in. A campaign grant is the OTHER way a
	// pool row becomes usable without a paid plan, and it is the whole point of the
	// frontier ladder: someone handed $50 of "Ryu Frontier" must be shown that
	// pool's models, not an ad for the subscription that money already substitutes
	// for. Empty whenever grants are unavailable, which degrades to the plan-only
	// rule this picker used before pools existed.
	const { pools: grantPools } = useCreditGrants();
	// Rows whose label this build cannot map back to a catalog id are skipped: the
	// upsell rule is a per-pool decision, and a null id names no pool. Skipping
	// keeps the pre-grant behaviour (the row still upsells) instead of suppressing
	// the upsell on some other pool's money.
	const grantedPoolIds = useMemo(
		() =>
			new Set(
				grantPools
					.map((pool) => pool.poolId)
					.filter((poolId): poolId is CreditPoolId => poolId !== null)
			),
		[grantPools]
	);
	// The same grants keyed for DISPLAY: pool id → the dollars left in it and when
	// they lapse. `useCreditGrants` already drops non-positive pools, so a present
	// entry always has money in it and the badge never renders "$0.00".
	const grantByPoolId = useMemo(() => {
		const index = new Map<
			CreditPoolId,
			{ expiresAt: string | null; remainingMicroUsd: number }
		>();
		for (const pool of grantPools) {
			if (pool.poolId !== null) {
				index.set(pool.poolId, {
					remainingMicroUsd: pool.remainingMicroUsd,
					expiresAt: pool.expiresAt,
				});
			}
		}
		return index;
	}, [grantPools]);

	// The user's FREE CREDIT — every grant summed, nearest expiry. Free credit is
	// spent automatically (first) on Ryu Router models Ryu serves from its own
	// supply, so it is one figure on the Ryu Router row, not a per-pool split.
	const freeCredit = useMemo(() => totalFreeCredit(grantPools), [grantPools]);

	return { freeCredit, grantByPoolId, grantedPoolIds };
}
