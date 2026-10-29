import { useEffect, useRef, useState } from "react";

/** Bumps when the shell, rendered optimistically from the node-setup cache,
 *  learns setup is required, so the router remounts on /onboarding. */
export function useRouterEpoch({
	nodeOnboardingStateStatus,
	renderedFromNodeSetupCache,
	shouldMountOnboarding,
}: {
	nodeOnboardingStateStatus: "loading" | "ready";
	renderedFromNodeSetupCache: boolean;
	shouldMountOnboarding: boolean;
}): number {
	const [routerEpoch, setRouterEpoch] = useState(0);
	const optimisticRouterMounted = useRef(false);
	useEffect(() => {
		if (renderedFromNodeSetupCache) {
			optimisticRouterMounted.current = true;
		}
	}, [renderedFromNodeSetupCache]);
	useEffect(() => {
		if (
			!optimisticRouterMounted.current ||
			nodeOnboardingStateStatus !== "ready"
		) {
			return;
		}
		optimisticRouterMounted.current = false;
		if (shouldMountOnboarding) {
			setRouterEpoch((epoch) => epoch + 1);
		}
	}, [nodeOnboardingStateStatus, shouldMountOnboarding]);
	return routerEpoch;
}
