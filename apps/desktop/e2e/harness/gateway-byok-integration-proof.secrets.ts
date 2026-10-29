import type { ByokProvider } from "../../src/lib/api/gateway.ts";

export async function setProviderKey(
	provider: ByokProvider,
	key: string
): Promise<void> {
	const slug = provider;
	const state = window.__gatewayByokIntegrationProof;
	state.secretCalls.push({ key, operation: "set", provider: slug });
	state.writeOrder.push(`keychain:set:${slug}`);
	if (state.failSecretWrite) {
		throw new Error("OS credential store is unavailable");
	}
	state.credentials[slug] = key;
}

export async function deleteProviderKey(provider: ByokProvider): Promise<void> {
	const slug = provider;
	const state = window.__gatewayByokIntegrationProof;
	state.secretCalls.push({ operation: "delete", provider: slug });
	state.writeOrder.push(`keychain:delete:${slug}`);
	if (state.failSecretDelete) {
		throw new Error("OS credential store refused deletion");
	}
	delete state.credentials[slug];
}

// The real helper only swallows a missing desktop bridge; this fixture always
// has one, so its storage refusals propagate exactly as the bridge's would.
export async function syncGatewayProviderKey(
	provider: ByokProvider,
	key: string | null
): Promise<void> {
	if (key === null) {
		await deleteProviderKey(provider);
		return;
	}
	await setProviderKey(provider, key);
}
