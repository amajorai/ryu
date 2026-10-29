export function useActiveNode() {
	return {
		name: "OAuth test profile",
		url: window.location.origin,
		token: null,
		userJwt: null,
	};
}
export function useEntitlementContext() {
	return {
		verdict: { managedInference: false },
		requestUpgrade: () => undefined,
	};
}
export function OrgBillingContext() {
	return (
		<p className="text-muted-foreground text-sm">
			Isolated test profile · normal accounts remain separate
		</p>
	);
}
export function AgentModelsSettings() {
	return null;
}
export function CapabilityProvidersSettings() {
	return null;
}
