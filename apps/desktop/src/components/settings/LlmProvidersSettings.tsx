// apps/desktop/src/components/settings/LlmProvidersSettings.tsx
//
// The "AI providers" surface: every provider Core's managed Pi can reach, as
// one list that opens one page per provider (`provider-pages/`). The user
// stores BYOK credentials for many at once, picks ONE active provider, toggles
// per-provider routing (Gateway or direct), and discovers models dynamically.
// It is backed by `useLlmProviders`, which reuses the same query cache as the
// agent-scoped editor (`RyuPiConfig`), so the two stay in sync. Every decision
// lives in Core (`/api/pi-config/*`); nothing here is hardcoded: the provider
// list, api types, and thinking levels all come from the catalog endpoint.
//
// Hosted by the Gateway dialog (Gateway → AI providers), NOT the account
// SettingsDialog: provider *selection* is strictly Core ("what runs": which
// model/keys/routing the local agent uses), a node/infra concern that belongs on
// the model-routing surface, not account/org data.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import type { ReactNode } from "react";
import { OrgBillingContext } from "@/src/components/billing/OrgBillingContext.tsx";
import { useCreditsWallet } from "@/src/hooks/useCreditsWallet.ts";
import { useLlmProviders } from "@/src/hooks/useLlmProviders.ts";
import { unrestrictedCreditBalanceMicroUsd } from "@/src/lib/api/credits.ts";
import type { PiCatalog } from "@/src/lib/api/pi-config.ts";
import { DEFAULT_API, orderProviders } from "./LlmProvidersSettings-shared.ts";
import { ProviderPages } from "./provider-pages/ProviderPages.tsx";
import type { LinkedSection } from "./provider-pages/provider-pages-model.ts";

export function LlmProvidersSettings({
	canSetGatewayAccount = true,
	gatewayKeys,
	onOpenSection,
}: {
	canSetGatewayAccount?: boolean;
	/** The gateway's own keys, read only, as a page of the list. */
	gatewayKeys?: ReactNode;
	/** Jump to another pane of the settings window, when hosted in one. */
	onOpenSection?: (section: LinkedSection) => void;
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

	return (
		<ProviderPages
			activeConfig={config}
			agentModelOverrides={cat.agentModelOverrides}
			apiTypes={cat.apiTypes}
			cardProps={{
				canSetGatewayAccount,
				check,
				discover,
				hasPrepaidManagedBalance,
				onActivate: handleActivate,
				onConfigure: handleConfigure,
				onReload: reload,
				onRemove: handleRemove,
				onRemoveAccount: async (providerId, accountId) =>
					await removeAccount(providerId, accountId),
				onRenameAccount: async (providerId, accountId, label) => {
					await renameAccount(providerId, accountId, label);
				},
				onSwitchAccount: async (providerId, accountId, target) => {
					await switchAccount(providerId, accountId, target);
				},
				onToggleModel: handleToggleModel,
				thinkingLevels: cat.thinkingLevels,
			}}
			gatewayKeys={gatewayKeys}
			intro={
				<OrgBillingContext
					compact
					description="Ryu managed inference uses this organization's shared credits; BYOK providers use keys stored on this node."
					label="Managed provider billing"
				/>
			}
			onCreateCustom={handleCreateCustom}
			onOpenSection={onOpenSection}
			providers={ordered}
		/>
	);
}
