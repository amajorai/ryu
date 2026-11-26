// apps/desktop/src/components/billing/AccountLimitNotice.tsx
//
// One row on a provider's account list: how many accounts it holds against the
// limit ("10 of 10 accounts"), and at the limit why a new one will not fit and
// how to raise the limit. Core enforces the limit; this row never blocks an
// add, so a number the desktop got wrong cannot lock anyone out.
//
// `AccountLimitNotice` takes plain values, so it renders anywhere.
// `ProviderAccountLimit` reads the limit and the paywall from the entitlement
// when one is mounted, and falls back to the free limit with no button.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import {
	accountLimitForVerdict,
	accountLimitStanding,
} from "@/src/lib/gating/accountLimit.ts";
import { accountCountText, accountLimitMessage } from "./account-limit-copy.ts";

interface AccountLimitNoticeProps {
	/** Accounts the provider holds now. */
	count: number;
	/** The most accounts the provider may hold. */
	limit: number;
	/** Opens the paywall. Without it the row shows no button. */
	onUpgrade?: () => void;
}

/** The count against the limit, with the reason and the way out at the limit. */
export function AccountLimitNotice({
	count,
	limit,
	onUpgrade,
}: AccountLimitNoticeProps) {
	const tl = useLiteralMessages();
	if (count < 1 || !Number.isFinite(limit)) {
		return null;
	}
	const standing = accountLimitStanding(count, limit);
	const message = accountLimitMessage(standing, tl);
	return (
		<div
			className="flex items-center justify-between gap-6 py-1"
			data-state={standing.state}
			data-testid="account-limit-notice"
		>
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="text-sm" data-slot="account-count">
					{accountCountText(standing, tl)}
				</span>
				{message ? (
					<span className="text-detail text-muted-foreground" role="status">
						{message}
					</span>
				) : null}
			</div>
			{message && standing.liftable && onUpgrade ? (
				<div className="shrink-0">
					<Button onClick={onUpgrade} size="sm" type="button" variant="outline">
						{tl("Get a license")}
					</Button>
				</div>
			) : null}
		</div>
	);
}

/**
 * The entitlement when a provider is mounted, else null. Account lists also
 * render outside the main app tree (the Gateway window, test fixtures), and
 * the row can do without the verdict, so a missing provider is not an error
 * here. The context is read on every render either way.
 */
function useEntitlementIfMounted() {
	try {
		return useEntitlementContext();
	} catch {
		return null;
	}
}

/** {@link AccountLimitNotice} for the plan this desktop resolved. */
export function ProviderAccountLimit({ count }: { count: number }) {
	const entitlement = useEntitlementIfMounted();
	return (
		<AccountLimitNotice
			count={count}
			limit={accountLimitForVerdict(entitlement?.verdict)}
			onUpgrade={entitlement?.requestUpgrade}
		/>
	);
}
