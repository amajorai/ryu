// apps/desktop/src/hooks/useRecentUpdates.ts
//
// Loads the public recent-updates feed from the control-plane server. Cached
// with TanStack Query — unlike announcements, this endpoint is public and does
// not require a session token.

import { useQuery } from "@tanstack/react-query";
import {
	fetchRecentUpdates,
	type RecentUpdateItem,
} from "@/src/lib/api/updates.ts";

const STALE_TIME_MS = 30 * 60_000;

interface UseRecentUpdates {
	error: Error | null;
	items: RecentUpdateItem[];
	loading: boolean;
	refresh: () => Promise<void>;
}

export function useRecentUpdates(limit = 8): UseRecentUpdates {
	const { data, isPending, error, refetch } = useQuery({
		queryKey: ["recent-updates", limit],
		queryFn: () => fetchRecentUpdates({ limit }),
		staleTime: STALE_TIME_MS,
	});

	return {
		items: data ?? [],
		loading: isPending,
		error: error instanceof Error ? error : null,
		refresh: async () => {
			await refetch();
		},
	};
}
