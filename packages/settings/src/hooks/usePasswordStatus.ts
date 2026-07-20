import { useQuery } from "@tanstack/react-query";
import { settingsApi } from "../utils/api-client.ts";

export function usePasswordStatus() {
	const { data, isLoading, error, refetch } = useQuery({
		queryKey: ["password-status"],
		queryFn: settingsApi.user.getPasswordStatus,
	});

	return {
		hasPassword: data?.hasPassword ?? false,
		authMethod: data?.authMethod ?? "magic-link",
		provider: data?.provider ?? null,
		isLoading,
		error,
		refetch,
	};
}
