import type { InterfaceAccount } from "@ryuhq/protocol/interfaces";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	fetchUsage,
	fetchWallet,
	hasCreditsAuth,
	isTerminalCreditsError,
	type LedgerEntry,
	type WalletResponse,
} from "@/src/lib/api/credits.ts";
import { useActiveOrgId } from "@/src/lib/api/orgs.ts";
import { MAX_INTERFACE_TRANSACTIONS, toInterfaceAccount } from "./snapshot.ts";

/** Balances move with every run; refresh on this cadence while shown. */
const REFRESH_MS = 60_000;
/** A transient failure is retried sooner than the regular refresh. */
const RETRY_MS = 15_000;

/**
 * The wallet's balance with as much of the ledger as one read allows. The
 * wallet only previews its newest entries, so the ledger comes from the
 * `/usage` statement's largest page (Bank sums it into month-to-date spend,
 * insights, and statements, and labels whatever history it does not reach).
 * When the statement cannot be read the wallet's preview still stands.
 */
export async function fetchInterfaceWallet(): Promise<WalletResponse> {
	const [wallet, usage] = await Promise.all([
		fetchWallet(),
		fetchUsage({ limit: MAX_INTERFACE_TRANSACTIONS }).catch(
			(error: unknown) => {
				if (isTerminalCreditsError(error)) {
					throw error;
				}
				return null;
			}
		),
	]);
	if (!usage) {
		return wallet;
	}
	const ledger = new Map<string, LedgerEntry>();
	for (const entry of [...usage.entries, ...wallet.ledger]) {
		if (!ledger.has(entry.id)) {
			ledger.set(entry.id, entry);
		}
	}
	return { ...wallet, ledger: [...ledger.values()] };
}

/** A wallet read, tagged with the org that was active when it was asked for. */
interface OrgWallet {
	orgId: string | null;
	response: WalletResponse;
}

/**
 * The credits wallet for the interfaces that show it. Fetches only while
 * `enabled` and signed in, so other interfaces never ask the control plane
 * for billing data. Undefined until loaded, when disabled, or when the
 * wallet cannot be read (the interface then shows its account-unavailable
 * state, which does not assume the user is signed out).
 * Wallets are org-level: after an org switch the previous org's wallet is
 * never shown, and a terminal failure (signed out, no org, refused by the
 * org's access policy) clears it instead of leaving stale numbers on screen.
 */
export function useInterfaceAccount(
	enabled: boolean,
	threadIds: ReadonlySet<string>
): InterfaceAccount | undefined {
	const [wallet, setWallet] = useState<OrgWallet | null>(null);
	const [tick, setTick] = useState(0);
	const refresh = useCallback(() => setTick((value) => value + 1), []);
	const activeOrgId = useActiveOrgId();

	useEffect(() => {
		if (!(enabled && hasCreditsAuth())) {
			setWallet(null);
			return;
		}
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		const orgId = activeOrgId;
		fetchInterfaceWallet()
			.then((response) => {
				if (!cancelled) {
					setWallet({ orgId, response });
				}
			})
			.catch((error: unknown) => {
				if (cancelled) {
					return;
				}
				// Billing is optional context: a transient failure keeps the last
				// good wallet and is retried soon; one that keeps failing until the
				// account changes does not.
				if (isTerminalCreditsError(error)) {
					setWallet(null);
				} else {
					retryTimer = setTimeout(refresh, RETRY_MS);
				}
			});
		return () => {
			cancelled = true;
			clearTimeout(retryTimer);
		};
	}, [activeOrgId, enabled, refresh, tick]);

	useEffect(() => {
		if (!enabled) {
			return;
		}
		const timer = setInterval(refresh, REFRESH_MS);
		return () => clearInterval(timer);
	}, [enabled, refresh]);

	// Memoised so the snapshot keeps its identity across unrelated renders and
	// the renderer's snapshot-derived memos do not recompute.
	return useMemo(
		() =>
			enabled && wallet && wallet.orgId === activeOrgId
				? toInterfaceAccount(wallet.response, threadIds)
				: undefined,
		[activeOrgId, enabled, threadIds, wallet]
	);
}
