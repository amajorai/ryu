import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AgentTitleBadge } from "@ryu/ui/components/agent-title-badge.tsx";
import { CommandItem } from "@ryu/ui/components/command.tsx";
import { DropdownMenuItem } from "@ryu/ui/components/dropdown-menu.tsx";
import {
	ProviderCreditsBadge,
	UsageBar,
} from "@/components/agent-elements/input/usage-bar.tsx";
import { AgentAvatar, AgentLogo } from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { PickerRef } from "@/src/lib/picker-favorites.ts";
import type { UniversalPickerBodyBaseScope } from "./universal-picker-body-scope.ts";
import type { useUniversalPickerFilters } from "./universal-picker-filters.ts";
import { ProviderSubBody } from "./universal-picker-provider-sub.tsx";
import { matches } from "./universal-picker-recents.tsx";
import {
	PoolGrantBadge,
	SectionHeader,
	UseTargetItem,
} from "./universal-picker-rows.tsx";
import {
	ExternalAgentAccounts,
	ExternalAgentSettings,
	SettingSub,
} from "./universal-picker-settings.tsx";
import {
	SubscriptionProviderUsage,
	TargetSub,
} from "./universal-picker-target-sub.tsx";
import type { ProviderEntry } from "./universal-picker-types.ts";

export type GetUniversalPickerRowsInput = UniversalPickerBodyBaseScope &
	ReturnType<typeof useUniversalPickerFilters>;

/** Row and submenu renderers for providers, external and custom agents, Ryu and recents. */
export function getUniversalPickerRows({
	onConfigureCredentials,
	onSelectProviderModel,
	onRemoveProviderAccount,
	onSwitchProviderAccount,
	onSelectProviderThinking,
	onUpgrade,
	onUseProvider,
	thinkingLevels,
	data,
	close,
	activeSections,
	onSelectAgent,
	onRemoveAgentAccount,
	onSwitchAgentAccount,
	agents,
	commandNavigation,
	ryuAgent,
	ryuRowActive,
	ryuActive,
	showProviders,
	providers,
	onSelectRecentModel,
	recentModelRows,
	q,
	recentAgentRows,
	tl,
}: GetUniversalPickerRowsInput) {
	const providerSub = (provider: ProviderEntry) => (
		<TargetSub
			engineKey={provider.engineKey}
			isActive={provider.isActive}
			key={provider.id}
			label={provider.label}
			providerId={provider.id}
			trailing={
				provider.id === "browser" ? (
					<span className="shrink-0 text-muted-foreground text-xs">
						{provider.status === "ready"
							? "Ready"
							: provider.status === "preparing"
								? "Preparing…"
								: provider.status === "failed"
									? "Retry"
									: "Browser"}
					</span>
				) : provider.authKind === "subscription" &&
					provider.configured &&
					!provider.managed ? (
					<SubscriptionProviderUsage provider={provider} />
				) : provider.poolGrant ? (
					// A pool row shows the pool's granted credit; a BYOK row shows what's
					// left on the key the user pasted. Never both — a pool has no key and
					// a BYOK provider has no pool, so this is a fork, not a stack.
					<PoolGrantBadge grant={provider.poolGrant} label={provider.label} />
				) : (
					<ProviderCreditsBadge
						label={provider.label}
						providerId={provider.id}
					/>
				)
			}
		>
			<ProviderSubBody
				canSetGateway={data.canSetGatewayAccount ?? true}
				close={close}
				forceModelPicker={data.forceModelPicker}
				onConfigure={onConfigureCredentials}
				onModel={(modelId) => onSelectProviderModel(provider.id, modelId)}
				onRemoveAccount={(accountId) =>
					onRemoveProviderAccount(provider.id, accountId)
				}
				onSwitchAccount={(account, target) =>
					onSwitchProviderAccount(provider.id, account.accountId, target)
				}
				onThinking={(level) => onSelectProviderThinking(provider.id, level)}
				onUpgrade={onUpgrade}
				onUse={() => onUseProvider(provider.id)}
				provider={provider}
				thinkingLevels={thinkingLevels}
			/>
		</TargetSub>
	);

	const externalSub = (agent: AgentSummary) => {
		const isActive = agent.id === data.activeAgentId;
		return (
			<TargetSub
				avatarUrl={agent.avatarUrl}
				engineKey={agent.engine ?? agent.id}
				glyph={agent.avatarGlyph}
				isActive={isActive}
				key={agent.id}
				label={agent.name}
				title={agent.title}
				// Installed subscription harnesses only. The not-installed catalog rows
				// (`AvailableAgentRow`) deliberately get none: their ids match the same
				// engine substrings, so a meter there would read a credential for a CLI
				// that isn't on this machine and answer "not logged in" every time.
				trailing={<UsageBar agentId={agent.id} className="shrink-0" />}
			>
				{isActive && activeSections.length > 0 ? (
					<>
						<UseTargetItem
							isActive
							label={tl("Use {name}", { name: agent.name })}
							onSelect={() => onSelectAgent(agent.id)}
						/>
						<ExternalAgentAccounts
							agentId={agent.id}
							onRemoveAccount={(accountId) =>
								onRemoveAgentAccount(agent.id, accountId)
							}
							onSwitchAccount={(account) =>
								onSwitchAgentAccount(
									agent.id,
									account.accountId,
									account.provider
								)
							}
						/>
						{activeSections.map((section) => (
							<SettingSub key={section.key} section={section} />
						))}
					</>
				) : (
					// No live sections from the host (settings-field mode, or a
					// non-active agent) — probe the agent's own advertised
					// model/thinking/approval lazily instead.
					<ExternalAgentSettings
						agent={agent}
						agents={agents}
						forceModelPicker={data.forceModelPicker}
						isActive={isActive}
						onRemoveAccount={(accountId) =>
							onRemoveAgentAccount(agent.id, accountId)
						}
						onSelect={() => onSelectAgent(agent.id)}
						onSwitchAccount={(account) =>
							onSwitchAgentAccount(
								agent.id,
								account.accountId,
								account.provider
							)
						}
					/>
				)}
			</TargetSub>
		);
	};

	const customAgentRow = (agent: AgentSummary) => {
		const isActive = agent.id === data.activeAgentId;
		const content = (
			<>
				{agent.avatarGlyph ? (
					<AgentAvatar
						className="size-4 shrink-0 object-contain"
						engine={agent.engine ?? null}
						glyph={agent.avatarGlyph}
						size="16px"
					/>
				) : agent.avatarUrl ? (
					// Tauri/Vite, data URL avatar
					// sized via class
					<img
						alt=""
						className="size-4 shrink-0 rounded-full object-cover"
						src={agent.avatarUrl}
					/>
				) : (
					<AgentLogo
						className="size-4 shrink-0"
						engine={agent.engine ?? null}
						size="16px"
					/>
				)}
				<span className="flex min-w-0 flex-1 items-center gap-2">
					<span className="truncate">{agent.name}</span>
					<AgentTitleBadge title={agent.title ?? ""} />
				</span>
				{isActive && (
					<HugeiconsIcon
						className="shrink-0 text-muted-foreground"
						icon={Tick02Icon}
						size={16}
						strokeWidth={2}
					/>
				)}
			</>
		);
		if (commandNavigation) {
			return (
				<CommandItem
					data-picker-active={isActive}
					key={agent.id}
					onSelect={() => {
						onSelectAgent(agent.id);
						commandNavigation.close();
					}}
					value={`agent ${agent.name} ${agent.id}`}
				>
					{content}
				</CommandItem>
			);
		}
		return (
			<DropdownMenuItem
				active={isActive}
				closeOnClick={false}
				key={agent.id}
				onClick={() => {
					onSelectAgent(agent.id);
				}}
				spacing="comfortable"
			>
				{content}
			</DropdownMenuItem>
		);
	};

	const ryuSub = ryuAgent && (
		<TargetSub
			avatarUrl={ryuAgent.avatarUrl}
			engineKey="ryu"
			glyph={ryuAgent.avatarGlyph}
			isActive={ryuRowActive}
			label={ryuAgent.name}
			title={ryuAgent.title}
		>
			<UseTargetItem
				isActive={ryuActive}
				label={tl("Use {name}", { name: ryuAgent.name })}
				onSelect={() => {
					onSelectAgent(ryuAgent.id);
				}}
			/>
			{ryuActive &&
				activeSections.map((section) => (
					<SettingSub key={section.key} section={section} />
				))}
			{showProviders && providers.length > 0 && (
				<>
					<SectionHeader
						label="Providers"
						tooltip="Routes Ryu can send your turns through. Pick a provider to use its models with your own credentials or subscription."
					/>
					{providers.map(providerSub)}
				</>
			)}
		</TargetSub>
	);

	const selectRecent = (ref: PickerRef) => {
		if (ref.kind === "agent") {
			onSelectAgent(ref.agentId);
			return;
		}
		if (onSelectRecentModel) {
			onSelectRecentModel(ref.providerId, ref.modelId, ref.effort);
			return;
		}
		onSelectProviderModel(ref.providerId, ref.modelId);
		if (ref.effort) {
			onSelectProviderThinking(ref.providerId, ref.effort);
		}
	};

	const recentModelRowsForDisplay = recentModelRows.filter(({ model }) =>
		matches(q, model.name)
	);
	const recentAgentRowsForDisplay = recentAgentRows.filter(({ agent }) =>
		matches(q, agent.name, agent.id)
	);
	return {
		providerSub,
		externalSub,
		customAgentRow,
		ryuSub,
		selectRecent,
		recentModelRowsForDisplay,
		recentAgentRowsForDisplay,
	} as const;
}
