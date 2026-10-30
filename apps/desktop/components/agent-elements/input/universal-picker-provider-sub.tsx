import { PlugSocketIcon, SparklesIcon } from "@hugeicons/core-free-icons";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type {
	ComposerSettingItem,
	ComposerSettingsSection,
} from "@/components/agent-elements/input/composer-settings-menu.tsx";
import { tagFreeModels } from "@/components/agent-elements/input/free-model-tag.ts";
import { groupModelItems } from "@/components/agent-elements/input/model-groups.ts";
import { createModelMenuRenderer } from "@/components/agent-elements/input/model-menu-content.tsx";
import { modelMenuItem } from "@/components/agent-elements/input/model-router.ts";
import {
	type ProviderAccount,
	ProviderAccountSection,
	type ProviderAccountTarget,
} from "@/components/agent-elements/input/provider-account-section.tsx";
import { AccountUsageBadge } from "@/components/agent-elements/input/usage-bar.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { useSubscriptions } from "@/src/hooks/useSubscriptions.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { discoverModels, isPiModelEnabled } from "@/src/lib/api/pi-config.ts";
import {
	showsComposerTuning,
	showsModelPicker,
} from "@/src/lib/interface-level.ts";
import { ActionRow, UseTargetItem } from "./universal-picker-rows.tsx";
import { SettingSub } from "./universal-picker-settings.tsx";
import type { ProviderEntry } from "./universal-picker-types.ts";

/**
 * Provider submenu body. Configured → its models (live-discovered for OpenRouter
 * and friends) + thinking. Unconfigured branches by auth kind: the managed Ryu
 * provider upsells the subscription (with a BYO-key escape hatch), a subscription
 * provider offers OAuth sign-in, an api-key provider links to the credential dialog.
 */
export function ProviderSubBody({
	provider,
	thinkingLevels,
	onUse,
	onModel,
	onThinking,
	onConfigure,
	onUpgrade,
	onSwitchAccount,
	onRemoveAccount,
	canSetGateway,
	close,
	forceModelPicker = false,
}: {
	canSetGateway: boolean;
	close: () => void;
	forceModelPicker?: boolean;
	onConfigure: () => void;
	onModel: (modelId: string) => void;
	onRemoveAccount: (accountId: string) => void;
	onSwitchAccount: (
		account: ProviderAccount,
		target: ProviderAccountTarget
	) => void;
	onThinking: (level: string) => void;
	onUpgrade: () => void;
	onUse: () => void;
	provider: ProviderEntry;
	thinkingLevels: string[];
}) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const interfaceLevel = useInterfaceLevel();
	// Per-account usage for a provider with several saved logins, from the same
	// snapshot the row badge reads (this body only mounts while open).
	const accountUsage = useSubscriptions({
		enabled:
			provider.configured &&
			provider.authKind === "subscription" &&
			!provider.managed &&
			(provider.accounts?.length ?? 0) > 1,
		providerId: provider.id,
		usage: "refresh",
	});
	const usageProvider = accountUsage.data?.providers.find(
		(entry) => entry.providerId === provider.id
	);
	const usageAccounts = usageProvider?.capabilities.accountUsage
		? usageProvider.accounts
		: [];
	const showModelSection = forceModelPicker || showsModelPicker(interfaceLevel);
	const showTuningSections = showsComposerTuning(interfaceLevel);
	const [customBrowserModelId, setCustomBrowserModelId] = useState("");
	// Live-enumerate the provider's full model list once the submenu opens (this
	// component only mounts on open). OpenRouter exposes hundreds of models Core's
	// static `suggestedModels` can't carry, so a discovery-capable provider gets the
	// real list; others fall back to the suggestions. A row that borrows another
	// registry id's catalog says so explicitly via `discoveryProviderId` — see the
	// note on that field for why "managed" alone must never imply OpenRouter.
	const discoveryId = provider.discoveryProviderId ?? provider.id;
	const discoverable =
		!provider.upsell &&
		provider.configured &&
		(provider.supportsDiscovery ||
			provider.discoveryProviderId !== undefined ||
			// A login (subscription) provider — ChatGPT Plus/Pro, Claude Pro/Max,
			// GitHub Copilot — advertises no OpenAI-style `/models` endpoint, so Core
			// reports `supportsDiscovery: false` and ships an EMPTY `suggestedModels`.
			// Gating on that alone left every signed-in subscription row with a model
			// submenu containing nothing at all, even though Core's discovery falls
			// through to models.dev for exactly these ids (Settings → Providers has
			// always shown the real list because it asks unconditionally).
			provider.authKind === "subscription");
	const discovery = useQuery({
		queryKey: ["pi-discover", node.url, discoveryId],
		queryFn: () => discoverModels(toTarget(node), { provider: discoveryId }),
		enabled: discoverable,
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
	});

	const modelItems = useMemo<ComposerSettingItem[]>(() => {
		const seen = new Set<string>();
		const out: ComposerSettingItem[] = [];
		const push = (id: string, name?: string) => {
			if (!id || seen.has(id)) {
				return;
			}
			// A model the user turned off is hidden — EXCEPT the one this row is
			// currently set to, which stays visible so the picker never renders a
			// selection it can't show. Turning it back on is a Settings action.
			if (
				id !== provider.currentModel &&
				!isPiModelEnabled(provider.modelOverrides, id)
			) {
				return;
			}
			seen.add(id);
			out.push(modelMenuItem(id, name));
		};
		for (const m of discovery.data?.models ?? []) {
			push(m.id, m.name);
		}
		for (const it of provider.models) {
			push(it.id, it.name);
		}
		return tagFreeModels(out, provider.freeModelIds);
	}, [
		discovery.data,
		provider.currentModel,
		provider.freeModelIds,
		provider.modelOverrides,
		provider.models,
	]);

	if (provider.upsell) {
		const upgradeCopy =
			provider.upsellCopy?.upgrade ??
			"Every model through Ryu's managed OpenRouter — no API keys, one subscription.";
		const byoKeyCopy =
			provider.upsellCopy === undefined
				? "Already have an OpenRouter key? Add it instead."
				: provider.upsellCopy.byoKey;
		return (
			<>
				<ActionRow
					description={upgradeCopy}
					icon={SparklesIcon}
					label="Upgrade to Ryu"
					onClick={() => {
						onUpgrade();
						close();
					}}
				/>
				{byoKeyCopy === null ? null : (
					<ActionRow
						description={byoKeyCopy}
						icon={PlugSocketIcon}
						label="Use your own key"
						onClick={() => {
							onConfigure();
							close();
						}}
					/>
				)}
			</>
		);
	}

	if (!provider.configured) {
		const isSubscription = provider.authKind === "subscription";
		return (
			<ActionRow
				description={
					isSubscription
						? "Use your existing subscription — no API key needed."
						: undefined
				}
				icon={PlugSocketIcon}
				label={
					isSubscription
						? tl("Sign in with {label}", { label: provider.label })
						: "Configure credentials"
				}
				onClick={() => {
					onConfigure();
					close();
				}}
			/>
		);
	}

	// A long, discovered list (OpenRouter) gets the grouped + searchable model menu;
	// a short suggested list renders as a plain checked list.
	const useGroupedMenu = modelItems.length > 8;
	const modelSection: ComposerSettingsSection = {
		key: `provider-model-${provider.id}`,
		label: "Model",
		ariaLabel: "Model",
		items: modelItems,
		value: provider.currentModel ?? undefined,
		onChange: onModel,
		loading: discovery.isLoading,
		renderContent: useGroupedMenu
			? createModelMenuRenderer(
					groupModelItems(modelItems),
					provider.currentModel ?? undefined,
					undefined,
					discoveryId === "openrouter" ? "openrouter" : undefined
				)
			: undefined,
	};
	const thinkingSection: ComposerSettingsSection = {
		key: `provider-thinking-${provider.id}`,
		label: "Thinking",
		ariaLabel: "Thinking",
		items: thinkingLevels.map((level) => ({
			id: level,
			name: level.charAt(0).toUpperCase() + level.slice(1),
		})),
		value: provider.currentThinking ?? undefined,
		onChange: onThinking,
		// Pi's levels are an ordered effort scale, so the same stepped slider the
		// ACP reasoning option gets. The detents follow `thinkingLevels`, whatever
		// length the catalog reports.
		variant: "slider",
	};
	return (
		<>
			<UseTargetItem
				isActive={provider.isActive}
				label={tl("Use {label}", { label: provider.label })}
				onSelect={onUse}
			/>
			{/* Every sign-in this provider holds, switchable/removable. Multi-account
			    is the point of the sealed vault; the section renders only when there
			    are accounts to show. */}
			<ProviderAccountSection
				accounts={provider.accounts ?? []}
				canSetGateway={canSetGateway}
				gatewaySupported={provider.gatewayAccountSupported === true}
				onRemove={onRemoveAccount}
				onSwitch={onSwitchAccount}
			/>
			{usageAccounts.length > 1 ? (
				<section aria-label="Usage by account" className="space-y-1 px-3 py-2">
					<p className="text-muted-foreground text-xs">Usage by account</p>
					<ul className="space-y-0.5">
						{usageAccounts.map((account) => (
							<li
								className="flex items-center justify-between gap-2 text-xs"
								key={account.accountId}
							>
								<span className="truncate">
									{account.label ?? "Saved account"}
								</span>
								<AccountUsageBadge account={account} />
							</li>
						))}
					</ul>
				</section>
			) : null}
			{/* Same interface-mode gate as the external-agent body above: Ryu Work
			    offers the provider itself and nothing to tune inside it. */}
			{showModelSection && <SettingSub section={modelSection} />}
			{provider.id === "browser" && (
				<div className="space-y-2 px-3 py-2">
					<p className="text-muted-foreground text-xs">
						Use any compatible Hugging Face model id. Unverified custom models
						are chat-only.
					</p>
					<div className="flex items-center gap-2">
						<Input
							aria-label="Custom Hugging Face model id"
							onChange={(event) => setCustomBrowserModelId(event.target.value)}
							placeholder="org/model"
							value={customBrowserModelId}
						/>
						<Button
							onClick={() => {
								const modelId = customBrowserModelId.trim();
								if (
									/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(
										modelId
									)
								) {
									onModel(modelId);
									setCustomBrowserModelId("");
								}
							}}
							size="sm"
						>
							Add
						</Button>
					</div>
				</div>
			)}
			{showTuningSections && thinkingLevels.length > 0 && (
				<SettingSub section={thinkingSection} />
			)}
		</>
	);
}
