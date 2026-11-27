// One provider's page. Every provider shows the same sections in the same
// order (accounts, API key, routing, models, danger zone), each only when it
// applies, so the eye learns the page once. The sections are the pieces the
// old provider card unfolded, moved without a change to what they do.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { type ReactNode, useEffect } from "react";
import { ProviderAccountSection } from "@/components/agent-elements/input/provider-account-section.tsx";
import { ProviderAccountLimit } from "@/src/components/billing/AccountLimitNotice.tsx";
import { gatewayProviderSlug } from "@/src/lib/api/pi-config.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { ProviderBrandMark } from "../LlmProvidersSettings-model-picker.tsx";
import {
	ProviderApiKeySection,
	ProviderSubscriptionSection,
} from "../LlmProvidersSettings-provider-card-auth.tsx";
import { ProviderModelsSection } from "../LlmProvidersSettings-provider-card-models.tsx";
import { useProviderCardState } from "../LlmProvidersSettings-provider-card-state.ts";
import {
	GATEWAY,
	type ProviderCardProps,
} from "../LlmProvidersSettings-shared.ts";
import { ProviderCredentialRouting } from "../ProviderCredentialRouting.tsx";
import { ProviderDesktopRouteSetting } from "../ProviderDesktopRouteSetting.tsx";
import { ProviderKeySafetyNotice } from "../shared/provider-key-safety.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../shared/settings-items.tsx";
import { ProviderAccountPools } from "./ProviderAccountPools.tsx";
import { ProviderRowEnd, providerRowLine } from "./ProviderList.tsx";
import { ProviderPageFrame } from "./ProviderPageFrame.tsx";
import {
	type ManagedFunding,
	type ProviderPageSection,
	providerPageSections,
} from "./provider-pages-model.ts";

interface ProviderPageProps extends ProviderCardProps {
	funding: ManagedFunding;
	onBack: () => void;
	/** Open the page that manages the account pools. */
	onManagePools: () => void;
	/** The name of the list, for the back control. */
	parentTitle: string;
}

export function ProviderPage({
	funding,
	onBack,
	onManagePools,
	parentTitle,
	...cardProps
}: ProviderPageProps) {
	const tl = useLiteralMessages();
	const state = useProviderCardState(cardProps);
	const {
		canSetGatewayAccount,
		handleRemove,
		handleRemoveAccount,
		handleRenameAccount,
		handleSwitchAccount,
		handleToggleRouting,
		isSubscription,
		needsPrepaidBalance,
		provider,
		removing,
		routing,
		setOpen,
	} = state;
	// The card looked up the live model list when it was unfolded. A page is
	// open from its first render.
	useEffect(() => {
		setOpen(true);
	}, [setOpen]);

	const sections = providerPageSections(provider);
	const hasDanger = sections.includes("danger");
	const hasAccounts = (provider.accounts?.length ?? 0) > 0;

	const body: Record<ProviderPageSection, () => ReactNode> = {
		accounts: () => (
			<SettingsSection title={hasAccounts ? "Connected accounts" : "Sign in"}>
				<SettingsCard className="flex flex-col gap-3">
					{isSubscription ? (
						<ProviderSubscriptionSection state={state} />
					) : null}
					<ProviderAccountLimit count={provider.accounts?.length ?? 0} />
					<ProviderAccountSection
						accounts={provider.accounts ?? []}
						canSetGateway={canSetGatewayAccount}
						gatewaySupported={
							provider.authKind === "api-key" &&
							gatewayProviderSlug(provider.id) !== null
						}
						onRemove={handleRemoveAccount}
						onRename={handleRenameAccount}
						onSwitch={(account, target) =>
							handleSwitchAccount(account.accountId, target)
						}
					/>
					{/* The order the accounts are tried in sits right under them. */}
					<ProviderCredentialRouting provider={provider} />
					<ProviderAccountPools onManage={onManagePools} provider={provider} />
				</SettingsCard>
			</SettingsSection>
		),
		"api-key": () => (
			<SettingsSection title="API key">
				<SettingsCard className="flex flex-col gap-3">
					<ProviderKeySafetyNotice storage="vault" />
					<ProviderApiKeySection hideRemove={hasDanger} state={state} />
				</SettingsCard>
			</SettingsSection>
		),
		routing: () => (
			<SettingsSection title="Routing">
				<SettingsCard className="flex flex-col gap-3">
					<div className="flex items-center justify-between gap-6">
						<Label
							htmlFor={`routing-${provider.id}`}
							size="compact"
							tone="muted"
						>
							Route through Gateway
						</Label>
						<Switch
							checked={routing === GATEWAY}
							disabled={provider.routingLocked}
							id={`routing-${provider.id}`}
							onCheckedChange={handleToggleRouting}
						/>
					</div>
					<ProviderDesktopRouteSetting
						label={provider.label}
						providerId={provider.id}
					/>
				</SettingsCard>
			</SettingsSection>
		),
		models: () => (
			<SettingsSection title="Models">
				<SettingsCard className="flex flex-col gap-3">
					<ProviderModelsSection state={state} />
				</SettingsCard>
			</SettingsSection>
		),
		danger: () => (
			<SettingsSection title="Danger zone">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Button
								loading={removing}
								onClick={handleRemove}
								size="sm"
								type="button"
								variant="destructive"
							>
								{removing ? "Removing…" : "Remove"}
							</Button>
						}
						title="Credential"
					/>
				</SettingsGroup>
			</SettingsSection>
		),
	};

	return (
		<ProviderPageFrame
			badge={<ProviderRowEnd provider={provider} />}
			hint={
				<span data-provider-page-meta="">
					{provider.api} · {providerRowLine(provider, funding, tl)}
				</span>
			}
			mark={
				<ProviderBrandMark
					label={provider.label}
					providerKey={`${provider.id} ${provider.label}`}
				/>
			}
			onBack={onBack}
			parentTitle={parentTitle}
			title={provider.label}
		>
			{needsPrepaidBalance ? (
				<SettingsSection>
					<SettingsGroup>
						<SettingsItem
							actions={
								<Button
									onClick={() => {
										useGatewayDialog.getState().setOpen(false);
										useSettingsDialog.getState().openSettings("credits");
									}}
									size="sm"
									type="button"
									variant="outline"
								>
									Add prepaid credits
								</Button>
							}
							description="Pay as you go. Usage pauses when the balance is empty."
							title="Use Ryu-managed models with prepaid credits"
						/>
					</SettingsGroup>
				</SettingsSection>
			) : null}
			{sections.map((section) => (
				<div
					className="contents"
					data-provider-page-section={section}
					key={section}
				>
					{body[section]()}
				</div>
			))}
		</ProviderPageFrame>
	);
}
