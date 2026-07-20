import { useQuery } from "@tanstack/react-query";
import { settingsApi } from "../utils/api-client.ts";

export function useSubscription() {
	const { data, isLoading, error, refetch } = useQuery({
		queryKey: ["subscription-status"],
		queryFn: settingsApi.billing.getSubscriptionStatus,
	});

	const subscription = data?.subscription;
	const lifetime = data?.lifetime;
	const subscriptionStatus = (subscription?.status || "").toLowerCase();
	const isTrialing = subscriptionStatus === "trialing";

	let daysLeftInTrial = 0;
	if (isTrialing && subscription?.currentPeriodEnd) {
		const diff = new Date(subscription.currentPeriodEnd).getTime() - Date.now();
		if (diff > 0) {
			daysLeftInTrial = Math.ceil(diff / (1000 * 60 * 60 * 24));
		}
	}

	return {
		hasProSubscription:
			!!subscription &&
			(subscriptionStatus === "active" || subscriptionStatus === "trialing"),
		isTrialing,
		daysLeftInTrial,
		planInterval: subscription?.interval,
		isLifetime: lifetime !== null && lifetime !== undefined,
		lifetime,
		isLoading,
		error,
		refetch,
	};
}
