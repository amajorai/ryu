// apps/desktop/src/lib/api/campaigns.ts
//
// Typed client for the caller's OWN campaign grants (`GET /api/campaigns/mine`)
// on the identity/control-plane server (:3000, BACKEND_URL), authenticated with
// the Better-Auth session bearer — the same transport credits.ts uses, but a
// DIFFERENT mount (`/api/campaigns`, not `/api/credits`), so it does not share
// that module's `BASE`.
//
// What a grant is: campaign / referral money that is POOL-RESTRICTED. A $50
// "Ryu Frontier" grant may only pay for turns that pool's supply actually
// serves; it can never leak into the cheap pool or into a pass-through provider
// (see `@ryu/auth/lib/credit-pools`). The wallet's single `balanceMicroUsd`
// already INCLUDES every active grant — the response below is a DECOMPOSITION of
// that total, never an addition to it, so nothing here may be summed with the
// wallet balance.
//
// ABSENCE IS A NORMAL STATE, not an error. Most accounts hold no grant at all,
// and an older control plane does not serve this route yet. Both must look
// identical to the caller — hence `fetchMyCampaigns` resolves `null` for any
// non-OK response instead of throwing, and every consumer renders exactly the
// pre-grant UI when it gets nothing. A user with no grants must never see an
// empty scaffold, a spinner or a toast for a feature they do not have.

import { BACKEND_URL, TOKEN_KEY } from "@/lib/auth-client.ts";

/**
 * One pool's remaining restricted balance, in the server's wire shape.
 *
 * FLAT, and deliberately so: `/api/campaigns/mine` emits
 * `{ poolLabel, remainingMicroUsd, expiresAt, isFreeProvider }` — there is no nested
 * `pool: { id, label }` object and no pool ID on the wire at all. This type
 * previously modelled the nested form, which made `normalizePools` reject every
 * real row; because that normalizer is fail-quiet the Credits card just rendered
 * its pre-grant layout and nothing anywhere reported a problem. Keep this
 * mirroring the wire exactly — the view model (with a resolved pool id) is built
 * one layer up, in `useCreditGrants`.
 *
 * `poolLabel` is the ONLY name shown to a user: pools are named for a
 * speed/capability tier ("Ryu Fast" / "Ryu Frontier"), never for the vendor
 * behind them, and the server is the authority on that label — it may know pools
 * this build does not. `expiresAt` is present only when the grants aggregated
 * into this row actually expire.
 */
export interface CampaignPoolBalance {
	expiresAt: string | null;
	isFreeProvider: boolean;
	poolLabel: string;
	remainingMicroUsd: number;
}

/**
 * The `/mine` response as this surface consumes it.
 *
 * The endpoint also returns `claims` (the audit trail of which campaigns this
 * user redeemed). It is deliberately NOT modelled here: nothing on the desktop
 * renders it, and typing a payload we do not read would turn any future
 * server-side field rename into a spurious client compile error.
 */
export interface MyCampaignsResponse {
	pools?: CampaignPoolBalance[];
}

function authToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		// No storage — treated as signed out.
		return null;
	}
}

const BASE = `${BACKEND_URL.replace(/\/$/, "")}/api/campaigns`;

/**
 * Keep only entries this UI can render truthfully. The payload crosses a service
 * boundary, so a malformed row is possible; rendering `NaN` or `undefined` where
 * a money figure belongs is worse than dropping the row.
 *
 * The two rejection branches are NOT the same thing, which is why only one of
 * them is silent:
 *
 *  - A zero or negative remainder is an EXPECTED state (the server aggregates a
 *    pool's still-`active` grants, and a fully-spent grant sums to 0). It is
 *    dropped quietly — a spent-out grant is not a balance, and showing it would
 *    leave a permanent "$0.00" line nobody can clear.
 *  - A row whose SHAPE is wrong is a bug on one side of the wire, and swallowing
 *    it is exactly what hid the nested-vs-flat mismatch this function used to
 *    have: every real row failed the guard, the card silently fell back to its
 *    pre-grant layout, and no surface anywhere said so. Those rows now warn.
 *    A warning, not a throw or a toast: a user who cannot see their grant must
 *    still get a working Credits page.
 */
function normalizePools(input: unknown): CampaignPoolBalance[] {
	if (!Array.isArray(input)) {
		if (input !== undefined && input !== null) {
			console.warn("[campaigns] /mine returned a non-array `pools`:", input);
		}
		return [];
	}
	const out: CampaignPoolBalance[] = [];
	for (const raw of input) {
		const row =
			typeof raw === "object" && raw !== null
				? (raw as Partial<CampaignPoolBalance>)
				: null;
		const label = row?.poolLabel;
		const remaining = row?.remainingMicroUsd;
		if (
			typeof label !== "string" ||
			label === "" ||
			typeof remaining !== "number" ||
			!Number.isFinite(remaining)
		) {
			console.warn("[campaigns] dropped an unreadable pool balance row:", raw);
			continue;
		}
		if (remaining <= 0) {
			continue;
		}
		out.push({
			poolLabel: label,
			remainingMicroUsd: remaining,
			isFreeProvider: row?.isFreeProvider === true,
			// Optional on the wire (a pool whose grants never lapse omits it), so a
			// missing or non-string value is normalized to "no expiry" rather than
			// treated as a malformed row.
			expiresAt: typeof row?.expiresAt === "string" ? row.expiresAt : null,
		});
	}
	return out;
}

/**
 * The caller's grant balances, or `null` when there is nothing to show: signed
 * out, no session token, a control plane that does not serve the route (404), or
 * any other non-OK status. Callers treat `null` and `[]` identically — see the
 * absence rule in this module's header. Only a transport failure rejects, and
 * the hooks that call this swallow that too.
 */
export async function fetchMyCampaigns(): Promise<MyCampaignsResponse | null> {
	const token = authToken();
	if (!token) {
		return null;
	}
	const resp = await fetch(`${BASE}/mine`, {
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
	});
	if (!resp.ok) {
		return null;
	}
	const body = (await resp.json()) as { pools?: unknown };
	return { pools: normalizePools(body.pools) };
}
