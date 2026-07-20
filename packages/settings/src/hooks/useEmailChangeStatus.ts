import { useQuery } from "@tanstack/react-query";
import { settingsApi } from "../utils/api-client.ts";

export function useEmailChangeStatus() {
	const { data, isLoading, error, refetch } = useQuery({
		queryKey: ["email-change-status"],
		queryFn: settingsApi.user.getEmailChangeStatus,
		refetchInterval: 30_000, // Refetch every 30 seconds
	});

	return {
		hasActiveEmailChange: data?.hasActive ?? false,
		emailChange: data?.emailChange,
		isLoading,
		error,
		refetch,
	};
}
