// apps/desktop/src/components/settings/LlmProvidersSettings.tsx
//
// The standalone "LLM Providers" surface — a Zed-style page that lists every
// provider Core's managed Pi can reach, lets the user store BYOK credentials for
// many at once, pick ONE active provider, toggle per-provider routing
// (Gateway ⇄ direct), and discover models dynamically. It is backed by
// `useLlmProviders`, which reuses the same query cache as the agent-scoped
// editor (`RyuPiConfig`), so the two stay in sync. Every decision lives in Core
// (`/api/pi-config/*`); nothing here is hardcoded — the provider list, api
// types, and thinking levels all come from the catalog endpoint.
//
// Hosted by the Gateway dialog (Gateway → LLM Providers), NOT the account
// SettingsDialog: provider *selection* is strictly Core ("what runs" — which
// model/keys/routing the local agent uses), a node/infra concern that belongs on
// the model-routing surface, not account/org data.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { OrgBillingContext } from "@/src/components/billing/OrgBillingContext.tsx";
import { useCreditsWallet } from "@/src/hooks/useCreditsWallet.ts";
import { useLlmProviders } from "@/src/hooks/useLlmProviders.ts";
import { unrestrictedCreditBalanceMicroUsd } from "@/src/lib/api/credits.ts";
import type { PiCatalog, PiProvider } from "@/src/lib/api/pi-config.ts";
import { AgentModelsSettings } from "./AgentModelsSettings.tsx";
import { CustomProviderForm } from "./LlmProvidersSettings-custom-provider-form.tsx";
import { ProviderCard } from "./LlmProvidersSettings-provider-card.tsx";
import {
	DEFAULT_API,
	orderProviders,
	supportsOAuth,
} from "./LlmProvidersSettings-shared.ts";
import { ModelParametersSettings } from "./ModelParametersSettings.tsx";
import { ProviderKeySafetyNotice } from "./shared/provider-key-safety.tsx";
import { SettingsSection } from "./shared/settings-items.tsx";

export function LlmProvidersSettings({
	canSetGatewayAccount = true,
}: {
	canSetGatewayAccount?: boolean;
} = {}) {
	const {
		catalog,
		config,
		loading,
		error,
		activate,
		check,
		configure,
		remove,
		discover,
		toggleModelEnabled,
		switchAccount,
		removeAccount,
		renameAccount,
		reload,
	} = useLlmProviders();
	const { wallet: creditWallet } = useCreditsWallet();
	const hasPrepaidManagedBalance =
		unrestrictedCreditBalanceMicroUsd(creditWallet) > 0;
	const tl = useLiteralMessages();

	if (loading) {
		return <SkeletonRows label="Loading providers…" spacing="comfortable" />;
	}

	if (error) {
		return (
			<div className="flex min-h-12 items-center justify-between gap-6 py-3 text-sm">
				<p className="min-w-0 break-words">
					{tl("Failed to load providers: {error}", { error })}
				</p>
				<Button
					className="shrink-0"
					onClick={reload}
					size="sm"
					type="button"
					variant="outline"
				>
					Retry
				</Button>
			</div>
		);
	}

	const cat: PiCatalog = catalog ?? {
		apiTypes: [DEFAULT_API],
		providers: [],
		thinkingLevels: [],
	};
	const ordered = orderProviders(cat.providers);
	const managedProviders = ordered.filter(
		(provider) => provider.managed || provider.authKind === "none"
	);
	const oauthProviders = ordered.filter(
		(provider) => !provider.managed && supportsOAuth(provider)
	);
	const apiKeyProviders = ordered.filter(
		(provider) => provider.authKind === "api-key" && !supportsOAuth(provider)
	);

	const handleActivate = async (input: {
		api?: string | null;
		model: string;
		provider: string;
		thinkingLevel: string | null;
	}) => {
		await activate({
			provider: input.provider,
			model: input.model || null,
			thinkingLevel: input.thinkingLevel,
			api: input.api,
		});
	};

	const handleConfigure = async (input: {
		apiKey?: string | null;
		provider: string;
		routing?: string | null;
	}) => {
		await configure(input);
	};

	const handleToggleModel = async (
		provider: string,
		model: string,
		enabled: boolean
	): Promise<void> => {
		await toggleModelEnabled(provider, model, enabled);
	};

	const handleRemove = async (provider: string): Promise<void> => {
		await remove(provider);
	};

	const handleCreateCustom = async (input: {
		api: string;
		apiKey: string | null;
		baseUrl: string;
		provider: string;
	}) => {
		await configure(input);
	};

	const renderProviderCards = (providers: PiProvider[]) =>
		providers.map((provider) => (
			<ProviderCard
				activeConfig={config}
				canSetGatewayAccount={canSetGatewayAccount}
				check={check}
				discover={discover}
				hasPrepaidManagedBalance={hasPrepaidManagedBalance}
				key={provider.id}
				onActivate={handleActivate}
				onConfigure={handleConfigure}
				onReload={reload}
				onRemove={handleRemove}
				onRemoveAccount={async (providerId, accountId) => {
					return await removeAccount(providerId, accountId);
				}}
				onRenameAccount={async (providerId, accountId, label) => {
					await renameAccount(providerId, accountId, label);
				}}
				onSwitchAccount={async (providerId, accountId, target) => {
					await switchAccount(providerId, accountId, target);
				}}
				onToggleModel={handleToggleModel}
				provider={provider}
				thinkingLevels={cat.thinkingLevels}
			/>
		));

	return (
		<div className="flex flex-col gap-8">
			<OrgBillingContext
				compact
				description="Ryu managed inference uses this organization's shared credits; BYOK providers use keys stored on this node."
				label="Managed provider billing"
			/>
			<SettingsSection
				caption="Providers that answer chat. Configure any number, then pick one to power the Ryu agent."
				title="Chat"
			>
				<div className="flex flex-col gap-6">
					<section
						aria-labelledby="managed-provider-heading"
						className="flex flex-col"
					>
						<h4
							className="text-detail text-muted-foreground"
							id="managed-provider-heading"
						>
							Ryu managed
						</h4>
						{renderProviderCards(managedProviders)}
					</section>
					<section
						aria-labelledby="oauth-provider-heading"
						className="flex flex-col"
					>
						<h4
							className="text-detail text-muted-foreground"
							id="oauth-provider-heading"
						>
							OAuth accounts
						</h4>
						{renderProviderCards(oauthProviders)}
					</section>
					<section
						aria-labelledby="api-key-provider-heading"
						className="flex flex-col"
					>
						<h4
							className="text-detail text-muted-foreground"
							id="api-key-provider-heading"
						>
							API keys
						</h4>
						<ProviderKeySafetyNotice storage="vault" />
						{renderProviderCards(apiKeyProviders)}
					</section>
				</div>
			</SettingsSection>

			<AgentModelsSettings
				agentModelOverrides={cat.agentModelOverrides}
				onToggleModel={handleToggleModel}
			/>

			<ModelParametersSettings />

			<SettingsSection
				caption="Any OpenAI-compatible endpoint, local or hosted. It joins the list above."
				title="Custom OpenAI-compatible provider"
			>
				<CustomProviderForm
					apiTypes={cat.apiTypes}
					onCreate={handleCreateCustom}
				/>
			</SettingsSection>
		</div>
	);
}
