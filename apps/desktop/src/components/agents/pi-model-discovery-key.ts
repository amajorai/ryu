export function piModelDiscoveryKey(input: {
	nodeUrl: string;
	provider: string;
	routing: string;
	accountId: string | null;
	baseUrl: string | null;
	api: string | null;
}) {
	return [
		"pi-config-discover",
		input.nodeUrl,
		input.provider,
		input.routing,
		input.accountId,
		input.baseUrl,
		input.api,
	];
}
