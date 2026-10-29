import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useIsActiveTab } from "@/src/contexts/TabsContext.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchSubscriptionCostUsage,
	type SubscriptionCostUsageSummary,
	setSubscriptionCostTracking,
} from "@/src/lib/api/subscription-costs.ts";

const FIVE_MINUTES_MS = 1000 * 60 * 5;

function queryKey(target: ApiTarget) {
	return [
		"subscription-cost-usage",
		target.url,
		target.token ?? null,
		target.userJwt ?? null,
	] as const;
}

function errorMessage(error: Error): string {
	return error instanceof Error
		? error.message
		: "Unable to load cost estimates.";
}

export function useSubscriptionCostUsage(target: ApiTarget) {
	const active = useIsActiveTab();
	const queryClient = useQueryClient();
	const key = useMemo(() => queryKey(target), [target]);
	const query = useQuery({
		enabled: active,
		queryFn: ({ signal }) => fetchSubscriptionCostUsage(target, signal),
		queryKey: key,
		refetchInterval: FIVE_MINUTES_MS,
		refetchOnWindowFocus: true,
		staleTime: FIVE_MINUTES_MS,
	});
	const mutation = useMutation({
		mutationFn: (enabled: boolean) =>
			setSubscriptionCostTracking(target, enabled),
		onSuccess: async ({ enabled }) => {
			queryClient.setQueryData<SubscriptionCostUsageSummary>(key, (current) =>
				current ? { ...current, enabled } : current
			);
			await queryClient.invalidateQueries({ queryKey: key });
		},
	});
	const setTrackingEnabled = useCallback(
		(enabled: boolean) => mutation.mutateAsync(enabled),
		[mutation.mutateAsync]
	);
	const refresh = useCallback(() => {
		void queryClient.invalidateQueries({ queryKey: key });
	}, [key, queryClient]);

	return {
		error: query.error ? errorMessage(query.error) : null,
		loading: query.isLoading,
		refresh,
		refreshing: query.isFetching,
		setTrackingEnabled,
		trackingEnabled: query.data?.enabled ?? false,
		trackingError: mutation.error ? errorMessage(mutation.error) : null,
		trackingUpdating: mutation.isPending,
		usage: query.data ?? null,
	};
}
