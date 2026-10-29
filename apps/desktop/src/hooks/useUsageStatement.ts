// apps/desktop/src/hooks/useUsageStatement.ts
//
// The org's credit usage statement, from the control plane (lib/api/credits.ts).
//
// Plain state + manual refresh, NOT TanStack Query — the same reasoning as
// `useCreditsWallet`: this targets :3000 (session-authed) rather than the active
// Core node, so it sits outside the node-scoped query cache every other hook in
// this app shares. Using `useQuery` here would key a control-plane read against a
// node URL that has nothing to do with it.

import { useCallback, useEffect, useRef, useState } from "react";
import {
	CreditsError,
	fetchUsage,
	type LedgerEntry,
	type UsageFilters,
	type UsageStats,
} from "@/src/lib/api/credits.ts";
import { useActiveOrgId } from "@/src/lib/api/orgs.ts";

export interface UseUsageStatement {
	/** Apply a new filter set, resetting to the first page. */
	applyFilters: (filters: UsageFilters) => void;
	entries: LedgerEntry[];
	error: CreditsError | null;
	filters: UsageFilters;
	/** Whether another page exists. */
	hasMore: boolean;
	/** True while the first page (or a re-filtered first page) is loading. */
	loading: boolean;
	/** True while an additional page is being appended. */
	loadingMore: boolean;
	/** Fetch the next page and append it. No-op when exhausted. */
	loadMore: () => void;
	refresh: () => void;
	stats: UsageStats | null;
}

const PAGE_SIZE = 50;

export function useUsageStatement(): UseUsageStatement {
	const [filters, setFilters] = useState<UsageFilters>({});
	const [entries, setEntries] = useState<LedgerEntry[]>([]);
	const [stats, setStats] = useState<UsageStats | null>(null);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<CreditsError | null>(null);
	const activeOrgId = useActiveOrgId();
	const initialRequest = useRef<AbortController | null>(null);
	const pageRequest = useRef<AbortController | null>(null);
	const latestOrgId = useRef(activeOrgId);
	latestOrgId.current = activeOrgId;

	const load = useCallback(
		async (next: UsageFilters) => {
			initialRequest.current?.abort();
			pageRequest.current?.abort();
			pageRequest.current = null;
			const controller = new AbortController();
			initialRequest.current = controller;
			const requestOrgId = activeOrgId;
			setLoading(true);
			setLoadingMore(false);
			setError(null);
			try {
				const res = await fetchUsage(
					{ ...next, limit: PAGE_SIZE },
					controller.signal
				);
				if (controller.signal.aborted || latestOrgId.current !== requestOrgId) {
					return;
				}
				setEntries(res.entries);
				setStats(res.stats);
				setCursor(res.nextCursor);
			} catch (err) {
				if (
					!controller.signal.aborted &&
					latestOrgId.current === requestOrgId
				) {
					setError(
						err instanceof CreditsError
							? err
							: new CreditsError(
									"unknown",
									err instanceof Error ? err.message : "Could not load usage."
								)
					);
				}
			} finally {
				if (
					!controller.signal.aborted &&
					latestOrgId.current === requestOrgId
				) {
					setLoading(false);
				}
				if (initialRequest.current === controller) {
					initialRequest.current = null;
				}
			}
		},
		[activeOrgId]
	);

	const loadMore = useCallback(() => {
		if (!cursor || initialRequest.current || pageRequest.current) {
			return;
		}
		const controller = new AbortController();
		pageRequest.current = controller;
		const requestOrgId = activeOrgId;
		setLoadingMore(true);
		fetchUsage(
			{ ...filters, before: cursor, limit: PAGE_SIZE },
			controller.signal
		)
			.then((res) => {
				if (controller.signal.aborted || latestOrgId.current !== requestOrgId) {
					return;
				}
				setEntries((prev) => [...prev, ...res.entries]);
				setCursor(res.nextCursor);
			})
			.catch((err) => {
				if (
					!controller.signal.aborted &&
					latestOrgId.current === requestOrgId
				) {
					setError(
						err instanceof CreditsError
							? err
							: new CreditsError(
									"unknown",
									err instanceof Error ? err.message : "Could not load usage."
								)
					);
				}
			})
			.finally(() => {
				if (
					!controller.signal.aborted &&
					latestOrgId.current === requestOrgId
				) {
					setLoadingMore(false);
				}
				if (pageRequest.current === controller) {
					pageRequest.current = null;
				}
			});
	}, [activeOrgId, cursor, filters]);

	const applyFilters = useCallback(
		(next: UsageFilters) => {
			setFilters(next);
			setCursor(null);
			setEntries([]);
			void load(next);
		},
		[load]
	);

	const refresh = useCallback(() => {
		setCursor(null);
		void load(filters);
	}, [filters, load]);

	useEffect(() => {
		setFilters({});
		setEntries([]);
		setStats(null);
		setCursor(null);
		setLoadingMore(false);
		setError(null);
		void load({});
		return () => {
			initialRequest.current?.abort();
			pageRequest.current?.abort();
		};
	}, [activeOrgId, load]);

	return {
		entries,
		stats,
		filters,
		loading,
		loadingMore,
		hasMore: cursor !== null,
		error,
		applyFilters,
		loadMore,
		refresh,
	};
}
