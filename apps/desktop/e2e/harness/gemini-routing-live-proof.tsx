import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProviderRow } from "../../src/components/gateway/GatewayProviderKeyRow.tsx";
import {
	SettingsGroup,
	SettingsSection,
} from "../../src/components/settings/shared/settings-items.tsx";
import {
	fetchGatewayConfig,
	type GatewayConfig,
	updateGatewayConfig,
} from "../../src/lib/api/gateway.ts";
import "../../src/index.css";

const target = { url: window.location.origin, token: null, userJwt: null };
const fixedAccounts = async () => {
	throw new Error(
		"This verification profile has two fixed disposable accounts."
	);
};
function GeminiRoutingProof() {
	const [config, setConfig] = useState<GatewayConfig | null>(null);
	const [error, setError] = useState<string | null>(null);
	const refresh = useCallback(async () => {
		try {
			setConfig(await fetchGatewayConfig(target));
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Gateway read failed");
		}
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	const accounts = config?.providers.accounts?.gemini ?? [];
	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
			<header className="flex flex-col gap-2">
				<h1 className="font-semibold text-2xl">Gateway provider keys</h1>
				<p className="text-muted-foreground text-sm">
					Local verification uses two disposable Gemini accounts and the real
					Gateway configuration API. No vendor inference is performed.
				</p>
			</header>
			{error ? <p role="alert">{error}</p> : null}
			{config ? (
				<SettingsSection
					caption="Upstream provider credentials are separate from Gateway client API keys."
					title="Provider keys (BYOK)"
				>
					<SettingsGroup>
						<ProviderRow
							accountCount={accounts.length}
							accountStrategy={config.providers.accountStrategies?.gemini}
							accounts={accounts}
							isSet={accounts.length > 0}
							label="Gemini"
							onAdd={fixedAccounts}
							onClear={fixedAccounts}
							onConfigure={async (provider, account) => {
								await updateGatewayConfig(target, {
									providerAccountPolicies: {
										[provider]: {
											[account.id]: {
												name: account.name,
												enabled: account.enabled,
												priority: account.priority,
											},
										},
									},
									expectedRevision: config.configRevision,
								});
								await refresh();
							}}
							onRemove={fixedAccounts}
							onSave={fixedAccounts}
							onStrategyChange={async (provider, strategy) => {
								await updateGatewayConfig(target, {
									providerAccountStrategies: { [provider]: strategy },
									expectedRevision: config.configRevision,
								});
								await refresh();
							}}
							placeholder="API key"
							quotaRouting={false}
							slug="gemini"
						/>
					</SettingsGroup>
				</SettingsSection>
			) : (
				<p>Connecting to the isolated Gateway…</p>
			)}
		</main>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<GeminiRoutingProof />);
}
