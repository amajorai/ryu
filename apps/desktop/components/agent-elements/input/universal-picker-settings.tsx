import { Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useFullAccessSelectionGuard } from "@ryu/blocks/composer/full-access-warning.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { CommandItem } from "@ryu/ui/components/command.tsx";
import {
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import { EffortSliderRow } from "@/components/agent-elements/input/effort-slider-row.tsx";
import {
	type ProviderAccount,
	ProviderAccountSection,
} from "@/components/agent-elements/input/provider-account-section.tsx";
import { useProviderCommandNavigation } from "@/components/agent-elements/input/provider-command-dialog.tsx";
import { useComposerAcpSections } from "@/components/agent-elements/input/use-composer-acp-sections.ts";
import type { ModelOption } from "@/components/agent-elements/types.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { type AgentSummary, fetchAgentAccounts } from "@/src/lib/api/agents.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	showsComposerTuning,
	showsModelPicker,
} from "@/src/lib/interface-level.ts";
import {
	LoadingRow,
	NOOP,
	SettingItemRow,
	UseTargetItem,
} from "./universal-picker-rows.tsx";

/**
 * A nested submenu for one `ComposerSettingsSection` (Model / Thinking /
 * Approval). Renders the section's custom grouped body when it has one (the
 * searchable model list), else a flat checked list with the section's optional
 * CLI-style decoration (approval tones). Hidden when it has nothing to offer.
 *
 * A `variant: "slider"` section (reasoning effort) is the exception: an ordered
 * scale reads better as one stepped track than as a submenu of rows, so it is
 * rendered inline instead of behind a sub-trigger.
 */
export function SettingSub({ section }: { section: ComposerSettingsSection }) {
	const commandNavigation = useProviderCommandNavigation();
	const selectionGuard = useFullAccessSelectionGuard();
	const loadingEmpty = Boolean(section.loading) && section.items.length === 0;
	if (section.items.length === 0 && !section.renderContent && !loadingEmpty) {
		return null;
	}
	const active =
		section.items.find((it) => it.id === section.value) ?? section.items[0];
	const activeDeco = active ? section.decorate?.(active) : undefined;
	// Keep the root menu open so model → thinking → approval can be chained.
	const onSelect = (id: string) => {
		const item = section.items.find((candidate) => candidate.id === id);
		const apply = () => section.onChange(id);
		if (selectionGuard) {
			selectionGuard.request(item ?? { id, name: id }, apply, section.label);
			return;
		}
		// ProviderCommandDialog can be rendered beside ComposerSettingsMenu, so it
		// has no FullAccessSelectionProvider ancestor. A missing optional guard is
		// not a reason to drop an otherwise safe model/thinking selection.
		apply();
	};
	if (section.variant === "slider" && !loadingEmpty) {
		if (commandNavigation) {
			return (
				<CommandItem
					data-checked={section.value === section.items[0]?.id}
					onSelect={() =>
						commandNavigation.push({
							body: section.items.map((item) => (
								<CommandItem
									data-checked={item.id === section.value}
									key={item.id}
									onSelect={() => {
										onSelect(item.id);
										commandNavigation.close();
									}}
								>
									{item.name}
								</CommandItem>
							)),
							title: section.label,
						})
					}
				>
					{section.label}
				</CommandItem>
			);
		}
		return <EffortSliderRow onSelect={onSelect} section={section} />;
	}
	if (commandNavigation) {
		return (
			<CommandItem
				data-checked={active?.id === section.value}
				onSelect={() =>
					commandNavigation.push({
						body: section.items.map((item) => (
							<CommandItem
								data-checked={
									item.id === (section.value ?? section.items[0]?.id)
								}
								key={item.id}
								onSelect={() => {
									onSelect(item.id);
									commandNavigation.close();
								}}
							>
								{item.name}
							</CommandItem>
						)),
						title: section.label,
					})
				}
			>
				<span className="flex-1">{section.label}</span>
				<span className="text-muted-foreground text-xs">{active?.name}</span>
			</CommandItem>
		);
	}
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<span className="text-(length:--text-detail) flex-1 text-muted-foreground">
					{section.label}
				</span>
				<span
					className={cn(
						"text-(length:--text-detail) flex max-w-[140px] items-center gap-1.5 text-muted-foreground",
						!loadingEmpty && activeDeco?.className
					)}
				>
					{loadingEmpty ? (
						<HugeiconsIcon
							className="shrink-0 animate-spin"
							icon={Loading03Icon}
							size={14}
							strokeWidth={2}
						/>
					) : (
						activeDeco && (
							<HugeiconsIcon
								className="shrink-0"
								icon={activeDeco.icon}
								size={14}
								strokeWidth={2}
							/>
						)
					)}
					<span className="truncate">
						{loadingEmpty ? "Detecting…" : active?.name}
					</span>
				</span>
			</DropdownMenuSubTrigger>
			{/* `renderContent` bodies (the grouped model menu) own their own scroller,
			    so the popover must NOT add a second one — nested scrollers are what
			    made the model list feel stuck. A plain item list has no scroller of
			    its own, so it scrolls HERE or not at all: with `overflow-hidden` on
				    both paths, any plain section with many two-line rows was simply clipped
				    and unreachable. */}
			<DropdownMenuSubContent
				className={cn(
					"max-h-80 min-w-[220px] max-w-[300px]",
					section.renderContent ? "overflow-hidden" : "overflow-y-auto"
				)}
			>
				{loadingEmpty ? (
					<LoadingRow text="Detecting available options…" />
				) : section.renderContent ? (
					section.renderContent(onSelect)
				) : (
					section.items.map((item) => {
						const deco = section.decorate?.(item);
						return (
							<SettingItemRow
								decoClassName={deco?.className}
								isActive={item.id === (section.value ?? section.items[0]?.id)}
								item={item}
								key={item.id}
								onSelect={onSelect}
							/>
						);
					})
				)}
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}

/**
 * One external ACP agent's sign-in accounts (sealed vault, labels only). Fetched
 * lazily: it mounts only inside an open agent submenu, for the active agent as
 * well as any other. For the managed Pi agent these are its provider accounts;
 * for any other agent its native or opaque sign-ins.
 */
export function ExternalAgentAccounts({
	agentId,
	onRemoveAccount,
	onSwitchAccount,
}: {
	agentId: string;
	onRemoveAccount: (accountId: string) => void;
	onSwitchAccount: (account: ProviderAccount) => void;
}) {
	const node = useActiveNode();
	const accountsQuery = useQuery({
		queryKey: ["agent-accounts", node.url, agentId],
		queryFn: () => fetchAgentAccounts(toTarget(node), agentId),
		staleTime: 30_000,
	});
	const accounts: ProviderAccount[] = accountsQuery.data ?? [];
	return (
		<ProviderAccountSection
			accounts={accounts}
			canSetGateway={false}
			gatewaySupported={false}
			onRemove={onRemoveAccount}
			onSwitch={(account) => onSwitchAccount(account)}
		/>
	);
}

/**
 * The lazily-mounted settings body for one external ACP agent — its advertised
 * model, thinking, and approval pickers. Because it only mounts when its parent
 * submenu opens (Base UI unmounts closed `SubContent`), the `useComposerAcpSections`
 * probe (which spawns the agent subprocess on first fetch) fires for exactly the
 * one agent the user drilled into. For the active agent this is a cache hit (the
 * host already probed it), so no extra subprocess is spawned.
 */
export function ExternalAgentSettings({
	agent,
	agents,
	forceModelPicker = false,
	isActive,
	onSelect,
	onRemoveAccount,
	onSwitchAccount,
}: {
	agent: AgentSummary;
	agents: AgentSummary[];
	forceModelPicker?: boolean;
	isActive: boolean;
	onRemoveAccount: (accountId: string) => void;
	onSelect: () => void;
	onSwitchAccount: (account: ProviderAccount) => void;
}) {
	const tl = useLiteralMessages();
	const noModelOptions = useMemo<ModelOption[]>(() => [], []);
	// Interface level decides whether this agent's row offers anything BUT "Use
	// it" — the same gate the host applies to the active agent's sections, applied
	// again here because this body builds its own (see the hook's header). Without
	// it, Ryu Work would strip the model from the trigger summary and still list one
	// under every agent in the popover.
	//
	// It also feeds `agentId: null` when nothing would render, which skips the
	// probe entirely: `useComposerAcpSections` spawns the agent subprocess on
	// first fetch, and a level that shows none of the answers should not be asking
	// the question.
	const interfaceLevel = useInterfaceLevel();
	const showModelSection = forceModelPicker || showsModelPicker(interfaceLevel);
	const showTuningSections = showsComposerTuning(interfaceLevel);
	const { modelSection, extraSections } = useComposerAcpSections({
		agentId: showModelSection || showTuningSections ? agent.id : null,
		agents,
		modelOptions: noModelOptions,
		engineModel: null,
		onEngineModelChange: NOOP,
	});
	const modelAsSection: ComposerSettingsSection = {
		key: "model",
		label: "Model",
		ariaLabel: "Model",
		items: modelSection.items,
		value: modelSection.value,
		onChange: (id) => {
			modelSection.onChange(id);
			// Picking a model on a non-active agent also switches to it.
			if (!isActive) {
				onSelect();
			}
		},
		renderContent: modelSection.renderContent,
		loading: modelSection.loading,
	};
	return (
		<>
			<UseTargetItem
				isActive={isActive}
				label={tl("Use {name}", { name: agent.name })}
				onSelect={() => {
					onSelect();
				}}
			/>
			<ExternalAgentAccounts
				agentId={agent.id}
				onRemoveAccount={onRemoveAccount}
				onSwitchAccount={onSwitchAccount}
			/>
			{showModelSection && <SettingSub section={modelAsSection} />}
			{showTuningSections &&
				extraSections.map((section) => (
					<SettingSub
						key={section.key}
						section={{
							...section,
							onChange: (id) => {
								section.onChange(id);
								if (!isActive) {
									onSelect();
								}
							},
						}}
					/>
				))}
		</>
	);
}
