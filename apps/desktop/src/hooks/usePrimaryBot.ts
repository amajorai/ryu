import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	capturePrimaryBotIdentity,
	getPrimaryBot,
	setPrimaryBot,
} from "@/src/lib/api/primary-bot.ts";
import { useAppStore } from "@/src/store/useAppStore.ts";

export function usePrimaryBot(target: ApiTarget) {
	const client = useQueryClient();
	const accountEmail = useAppStore((state) => state.oidcUser?.email ?? null);
	const identity = capturePrimaryBotIdentity();
	const queryKey = ["primary-bot", target, identity.accountId, accountEmail];
	const selection = useQuery({
		queryKey,
		queryFn: () => getPrimaryBot(target, identity),
		staleTime: 0,
		refetchInterval: 15_000,
		refetchOnWindowFocus: true,
		refetchOnReconnect: true,
	});
	const mutation = useMutation({
		mutationFn: async (agentId: string | null) => {
			const current = selection.data;
			if (!current) {
				throw new Error("Load the current primary bot before changing it.");
			}
			return setPrimaryBot(
				target,
				{
					agentId,
					expectedRevision: current.revision,
				},
				identity
			);
		},
		onSuccess: (value) => client.setQueryData(queryKey, value),
		onSettled: () => client.invalidateQueries({ queryKey }),
	});
	return { ...selection, mutation };
}
