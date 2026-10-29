import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { settingsApi } from "../utils/api-client.ts";

export interface SubscriptionAuthority {
	accountId: string | null;
	enabled: boolean;
	organizationId: string | null;
}

/** Hosts supply their authenticated account/organization without shared host imports. */
export function useSubscription(authority: SubscriptionAuthority) {
	const enabled = authority.enabled && Boolean(authority.accountId);
	const identity = JSON.stringify([
		authority.accountId,
		authority.organizationId,
	]);
	const currentAuthority = useRef({ identity, enabled });
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	currentAuthority.current = { identity, enabled };
	const query = useQuery({
		queryKey: [
			"subscription-status",
			authority.accountId,
			authority.organizationId,
		],
		enabled,
		queryFn: settingsApi.billing.getSubscriptionStatus,
	});

	const { data, isLoading, error, refetch } = query;
	const subscription = enabled ? data?.subscription : undefined;
	const lifetime = enabled ? data?.lifetime : undefined;
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
		error: enabled ? error : null,
		refetch: (...args: Parameters<typeof refetch>) =>
			mounted.current &&
			enabled &&
			currentAuthority.current.enabled &&
			currentAuthority.current.identity === identity
				? refetch(...args)
				: Promise.resolve(query),
	};
}
