// apps/desktop/src/lib/api/marketplace-membership.ts
//
// A Major Pass membership usage/report calls and the sign-in probe.
// Split out of marketplace.ts (which re-exports it); see that file's header
// for the control-plane contract.

import type { MarketplaceKind } from "@ryu/marketplace/types";
import { getActiveToken } from "@/lib/auth-client.ts";
import { authHeaders, BASE, toError } from "./marketplace-http.ts";
import {
	marketplaceMembershipPublisherReportSchema,
	marketplaceMembershipUsageResultSchema,
	parseMarketplaceResponse,
} from "./marketplace-response-contracts.ts";
import {
	marketplaceNumberField,
	marketplaceStringField,
} from "./marketplace-wire-values.ts";

export interface MarketplaceMembershipUsageResult {
	created: boolean;
	ok: boolean;
	periodId: string;
}

export interface MarketplaceMembershipRevenueCurrency {
	currency: string;
	failedMinor: number;
	paidMinor: number;
	pendingMinor: number;
	usageCount: number;
}

export interface MarketplaceMembershipPublisherReport {
	currencies: MarketplaceMembershipRevenueCurrency[];
	eligibleListingCount: number;
	organizationId: string;
}

/** Record one first-use signal for a listing eligible for the legacy publisher pool. */
export async function recordMarketplaceMembershipUsage(input: {
	id: string;
	idempotencyKey: string;
	kind: MarketplaceKind;
}): Promise<MarketplaceMembershipUsageResult> {
	const resp = await fetch(`${BASE}/membership/usage`, {
		body: JSON.stringify(input),
		headers: authHeaders(),
		method: "POST",
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(
		marketplaceMembershipUsageResultSchema.partial(),
		await resp.json()
	);
	return {
		created: Boolean(json.created),
		ok: Boolean(json.ok),
		periodId: marketplaceStringField(json.periodId) ?? "",
	};
}

/** Fetch the active publisher organization's A Major Pass distribution totals. */
export async function fetchMarketplaceMembershipPublisherReport(): Promise<MarketplaceMembershipPublisherReport> {
	const resp = await fetch(`${BASE}/membership/publisher-report`, {
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(
		marketplaceMembershipPublisherReportSchema.partial(),
		await resp.json()
	);
	return {
		currencies: Array.isArray(json.currencies)
			? json.currencies.map((currency) => ({
					currency: marketplaceStringField(currency.currency) ?? "usd",
					failedMinor: marketplaceNumberField(currency.failedMinor) ?? 0,
					paidMinor: marketplaceNumberField(currency.paidMinor) ?? 0,
					pendingMinor: marketplaceNumberField(currency.pendingMinor) ?? 0,
					usageCount: marketplaceNumberField(currency.usageCount) ?? 0,
				}))
			: [],
		eligibleListingCount:
			marketplaceNumberField(json.eligibleListingCount) ?? 0,
		organizationId: marketplaceStringField(json.organizationId) ?? "",
	};
}

/** True when the user has a session token; the money layer requires sign-in. */
export function hasMarketplaceAuth(): boolean {
	try {
		return Boolean(getActiveToken());
	} catch {
		return false;
	}
}
