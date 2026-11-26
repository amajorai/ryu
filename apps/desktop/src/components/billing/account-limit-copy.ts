// apps/desktop/src/components/billing/account-limit-copy.ts
//
// The sentences for the limit on connected accounts per provider, shared by
// the notice on an account list and the toast after Core refuses an add.

import type { LiteralMessage } from "@ryu/i18n/react";
import {
	type AccountLimitRefusal,
	type AccountLimitStanding,
	accountLimitStanding,
	LICENSED_ACCOUNT_LIMIT,
} from "@/src/lib/gating/accountLimit.ts";

/** "10 of 10 accounts". */
export function accountCountText(
	standing: Pick<AccountLimitStanding, "count" | "limit">,
	tl: LiteralMessage
): string {
	return tl("{count} of {limit} accounts", {
		count: String(standing.count),
		limit: String(standing.limit),
	});
}

/** Why a new account will not fit, or null while there is room. */
export function accountLimitMessage(
	standing: AccountLimitStanding,
	tl: LiteralMessage
): string | null {
	if (standing.state === "below") {
		return null;
	}
	const extra = String(standing.extra);
	const licensed = String(LICENSED_ACCOUNT_LIMIT);
	if (standing.state === "full") {
		return standing.liftable
			? tl(
					"This provider has the most accounts the free plan allows. Remove one, or get a license to connect up to {licensed}.",
					{ licensed }
				)
			: tl(
					"This provider already has the most accounts your plan allows. Remove one to add another."
				);
	}
	return standing.liftable
		? tl(
				"This provider has more accounts than the free plan allows. They all keep working. Remove {extra} to add a new one, or get a license to connect up to {licensed}.",
				{ extra, licensed }
			)
		: tl(
				"This provider has more accounts than your plan allows. They all keep working. Remove {extra} to add a new one.",
				{ extra }
			);
}

export interface AccountLimitToast {
	button?: { onClick: () => void; title: string };
	description: string;
	title: string;
}

/**
 * The toast for an add Core refused. It carries the way to a license only when
 * a license would raise the limit and the caller can open the paywall.
 */
export function accountLimitToast(
	refusal: AccountLimitRefusal,
	tl: LiteralMessage,
	onUpgrade?: () => void
): AccountLimitToast {
	const standing = accountLimitStanding(refusal.count, refusal.limit);
	const toast: AccountLimitToast = {
		title: tl("Account limit reached"),
		description:
			accountLimitMessage(standing, tl) ??
			tl(
				"This provider already has the most accounts your plan allows. Remove one to add another."
			),
	};
	if (standing.liftable && onUpgrade) {
		toast.button = { onClick: onUpgrade, title: tl("Get a license") };
	}
	return toast;
}
