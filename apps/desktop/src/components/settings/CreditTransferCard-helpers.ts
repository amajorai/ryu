import { CREDIT_POOLS, isCreditPoolId } from "@ryu/auth/lib/credit-pools";
import { formatMicroUsd } from "@ryu/ui/lib/number-format.ts";
import { onActiveTokenChange, TOKEN_KEY } from "@/lib/auth-client.ts";
import type { OrgSummary } from "@/src/lib/api/orgs.ts";
import { formatDate } from "@/src/lib/timezone.ts";

export const TRANSFERABLE_KEY = ["credits", "transferable"] as const;
export function formatUsd(microUsd: number): string {
	return formatMicroUsd(microUsd);
}

/**
 * The one place a workspace is named, so the closed trigger and the open list
 * cannot disagree. Base UI resolves the trigger's text from the root's `items`
 * prop alone — it never reads the `<SelectItem>` children — so without feeding
 * it these labels the trigger would print the raw org id (a cuid).
 */
export function orgLabel(org: OrgSummary): string {
	return `${org.name}${org.isPersonal ? " (personal)" : ""}`;
}

export function formatExpiry(iso: string | null): string | null {
	if (!iso) {
		return null;
	}
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) {
		return null;
	}
	return `expires ${formatDate(at, {
		month: "short",
		day: "numeric",
		year: "numeric",
	})}`;
}

/**
 * Word boundaries inside a pool id — see `poolDisplayName`. Module scope
 * because a literal rebuilt per call is both wasteful and a lint error.
 */
const POOL_ID_WORD_SEPARATOR = /[-_]+/;

/**
 * A grant's user-facing pool name.
 *
 * `GET /api/credits/transferable` sends the DURABLE pool id — "cloudflare",
 * "bedrock" — because that is what the grant document stores and what a debit
 * is matched against. It is not a name to show anyone. `@ryu/auth/lib/credit-pools`
 * exists to enforce exactly that ("USERS NEVER SEE A PROVIDER"): a pool's
 * `label` names a TIER ("Ryu Fast"), never the vendor supplying it. This card
 * printed the id straight through, which made it the one surface in the app
 * that leaked a vendor name — the sibling grants list on the Credits page has
 * always shown the label.
 *
 * The fallback is NOT for a pool that lacks a name — every pool in
 * `CREDIT_POOLS` has a `label`. It is for an id this BUILD has never heard of,
 * since the control plane can serve a pool that postdates the bundle. In that
 * case a title-cased id is the least-bad option available: inventing a tier
 * name would lie about money the user owns, and a raw slug reads as a bug on
 * top of leaking the vendor.
 */
export function poolDisplayName(pool: string): string {
	if (isCreditPoolId(pool)) {
		return CREDIT_POOLS[pool].label;
	}
	return pool
		.split(POOL_ID_WORD_SEPARATOR)
		.filter((word) => word.length > 0)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

export function subscribeTransferAuthority(onChange: () => void) {
	const onStorage = (event: StorageEvent) => {
		if (event.key === TOKEN_KEY || event.key === null) {
			onChange();
		}
	};
	window.addEventListener("storage", onStorage);
	window.addEventListener("focus", onChange);
	const unsubscribeVault = onActiveTokenChange(onChange);
	return () => {
		unsubscribeVault();
		window.removeEventListener("storage", onStorage);
		window.removeEventListener("focus", onChange);
	};
}
