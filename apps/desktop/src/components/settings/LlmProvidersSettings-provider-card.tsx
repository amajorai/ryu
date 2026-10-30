import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible.tsx";
import { CommandItem } from "@ryu/ui/components/command.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { ProviderAccountSection } from "@/components/agent-elements/input/provider-account-section.tsx";
import { useProviderCommandNavigation } from "@/components/agent-elements/input/provider-command-dialog.tsx";
import { gatewayProviderSlug } from "@/src/lib/api/pi-config.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { ProviderBrandMark } from "./LlmProvidersSettings-model-picker.tsx";
import {
	ProviderApiKeySection,
	ProviderSubscriptionSection,
} from "./LlmProvidersSettings-provider-card-auth.tsx";
import { ProviderModelsSection } from "./LlmProvidersSettings-provider-card-models.tsx";
import { useProviderCardState } from "./LlmProvidersSettings-provider-card-state.ts";
import {
	GATEWAY,
	managedBadgeLabel,
	type ProviderCardProps,
} from "./LlmProvidersSettings-shared.ts";
import { OAuthAccountPoolControls } from "./OAuthAccountPoolControls.tsx";
import { ProviderDesktopRouteSetting } from "./ProviderDesktopRouteSetting.tsx";
import { SettingsCard } from "./shared/settings-items.tsx";

export function ProviderCard(props: ProviderCardProps) {
	const navigation = useProviderCommandNavigation();
	if (!navigation) {
		return <ProviderCardContent {...props} />;
	}
	return (
		<CommandItem
			className="mx-1 my-0.5 min-h-12"
			onSelect={() =>
				navigation.push({
					body: <ProviderCardContent {...props} />,
					title: props.provider.label,
				})
			}
		>
			<span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
				<span className="font-medium">{props.provider.label}</span>
				<span className="text-detail text-muted-foreground">
					{props.provider.configured
						? "Configure models and credentials"
						: "Set up provider login"}
				</span>
			</span>
		</CommandItem>
	);
}

function ProviderCardContent(props: ProviderCardProps) {
	const state = useProviderCardState(props);
	const {
		canSetGatewayAccount,
		handleRemoveAccount,
		handleRenameAccount,
		handleSwitchAccount,
		handleToggleRouting,
		isActive,
		isPoolBacked,
		isSubscription,
		needsKey,
		needsPrepaidBalance,
		oauthActive,
		open,
		provider,
		routing,
		setOpen,
	} = state;

	return (
		// One flush row in the provider list; the active provider is marked by its
		// status glyph, not a ring around the row.
		<SettingsCard className="border-border border-b last:border-b-0">
			<Collapsible onOpenChange={setOpen} open={open}>
				{/* Header row (always visible): label + status hint + chevron. Base UI
				    manages aria-expanded + keyboard on the trigger button. */}
				<CollapsibleTrigger
					appearance="provider-group"
					className="flex min-h-12 w-full items-center justify-between px-0 py-3 text-left hover:bg-transparent"
				>
					<div className="flex min-w-0 items-center gap-3">
						{/* Resolve the brand mark on id+label ONLY — never `provider.api`.
						    The Pi `api` type is a transport ("openai-completions",
						    "openai-responses"), and every OpenAI-compatible provider's api
						    literally contains "openai", so folding it into the haystack made
						    DeepSeek/Groq/Cerebras/Mistral/… all resolve to the OpenAI mark. */}
						<ProviderBrandMark
							label={provider.label}
							providerKey={`${provider.id} ${provider.label}`}
						/>
						<div className="flex min-w-0 flex-col gap-0.5">
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-sm" data-slot="provider-label">
									{provider.label}
								</span>
								{/* The shared status glyph, same as every catalog row: the one
								    mark a row may carry. "Managed", "Connected" and
								    "Configured" are facts about the provider, so they read as
								    plain text on the meta line below. */}
								{isActive ? <StatusBadge kind="active" /> : null}
							</div>
							<span className="text-detail text-muted-foreground">
								{provider.api}
								{provider.custom ? " · custom" : ""}
								{provider.managed
									? ` · ${managedBadgeLabel(needsPrepaidBalance, isPoolBacked)}`
									: null}
								{provider.configured && !provider.managed
									? isSubscription && (!needsKey || oauthActive)
										? " · Connected"
										: " · Configured"
									: null}
							</span>
						</div>
					</div>
					<HugeiconsIcon
						className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
						icon={ArrowDown01Icon}
					/>
				</CollapsibleTrigger>

				<CollapsibleContent
					className="flex flex-col px-0 pb-4"
					spacing="provider-fields"
				>
					{needsPrepaidBalance ? (
						<div className="flex items-center justify-between gap-6 py-1">
							<div className="flex min-w-0 flex-col gap-0.5">
								<span className="text-sm">
									Use Ryu-managed models with prepaid credits
								</span>
								<span className="text-detail text-muted-foreground">
									Pay as you go. Usage pauses when the balance is empty.
								</span>
							</div>
							<div className="shrink-0">
								<Button
									onClick={() => {
										useGatewayDialog.getState().setOpen(false);
										useSettingsDialog.getState().openSettings("credits");
									}}
									size="sm"
									variant="outline"
								>
									Add prepaid credits
								</Button>
							</div>
						</div>
					) : null}
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

					{isSubscription ? (
						<ProviderSubscriptionSection state={state} />
					) : null}

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
					{provider.accountRouting &&
					(provider.accounts?.some((account) =>
						provider.accountRouting?.credentialKinds.some(
							(kind) => kind === account.kind
						)
					) ??
						false) ? (
						<OAuthAccountPoolControls
							accounts={
								provider.accounts?.filter((account) =>
									provider.accountRouting?.credentialKinds.some(
										(kind) => kind === account.kind
									)
								) ?? []
							}
							capabilities={provider.accountRouting}
							providerId={provider.id}
						/>
					) : null}

					{needsKey ? <ProviderApiKeySection state={state} /> : null}

					<ProviderModelsSection state={state} />
				</CollapsibleContent>
			</Collapsible>
		</SettingsCard>
	);
}
