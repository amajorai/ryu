"use client";

import {
	ArrowDown01Icon,
	BotIcon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
	RyuCatalogModel,
	RyuCatalogModels,
	RyuCatalogSnapshot,
	RyuProvider,
	RyuRuntimeSelection,
} from "@ryu/app-host/app-bridge";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ryu/ui/components/command.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useMemo, useState } from "react";
import styles from "./model-agent-picker.module.css";

export type RyuPickerMode = "agent" | "all" | "model";

export type RyuPickerSelection = RyuRuntimeSelection;

interface ModelOption {
	authLabel: string;
	disabled: boolean;
	label: string;
	modelId: string;
	providerId: string;
	providerLabel: string;
	searchValue: string;
	type: "model";
}

interface AgentOption {
	agentId: string;
	disabled: boolean;
	label: string;
	searchValue: string;
	type: "agent";
}

function providerAuthLabel(provider: RyuProvider): string {
	if (provider.authKind === "subscription") {
		return "Subscription";
	}
	if (provider.authKind === "api-key") {
		return provider.managed ? "Ryu managed" : "BYOK";
	}
	return provider.managed ? "Ryu managed" : "Ryu route";
}

function providerIsUnavailable(provider: RyuProvider): boolean {
	return (
		!(provider.managed || provider.configured) && provider.authKind !== "none"
	);
}

function providerSearchValue(provider: RyuProvider): string {
	return `${provider.label} ${provider.id} ${provider.api} ${providerAuthLabel(provider)}`;
}

export function modelOptionsForCatalog(
	catalog: RyuCatalogSnapshot,
	discoveredModels: Record<string, RyuCatalogModel[]> = {}
): ModelOption[] {
	return catalog.providers.flatMap((provider) => {
		const suggestedModels = (provider.suggestedModels ?? []).map((id) => ({
			id,
			name: undefined,
		}));
		const discovered = discoveredModels[provider.id] ?? [];
		const models = [...suggestedModels, ...discovered].filter(
			(model, index, all) =>
				all.findIndex((candidate) => candidate.id === model.id) === index
		);
		return models.map((model) => ({
			authLabel: providerAuthLabel(provider),
			disabled:
				providerIsUnavailable(provider) ||
				provider.modelOverrides?.[model.id] === false,
			label: model.name || model.id,
			modelId: model.id,
			providerId: provider.id,
			providerLabel: provider.label,
			searchValue: `${model.id} ${model.name ?? ""} ${provider.label} ${provider.id} ${providerAuthLabel(provider)}`,
			type: "model" as const,
		}));
	});
}

function agentOptionsForCatalog(catalog: RyuCatalogSnapshot): AgentOption[] {
	return catalog.agents.map((agent) => ({
		agentId: agent.id,
		disabled: agent.enabled === false || agent.installed === false,
		label: agent.title || agent.name,
		searchValue: `${agent.name} ${agent.title ?? ""} ${agent.engine ?? ""} ${agent.model ?? ""}`,
		type: "agent" as const,
	}));
}

function selectionKey(selection: RyuPickerSelection | undefined): string {
	if (!selection) {
		return "";
	}
	return selection.kind === "agent"
		? `agent:${selection.agentId}`
		: `model:${selection.providerId}:${selection.modelId}`;
}

function selectionLabel(
	catalog: RyuCatalogSnapshot,
	selection: RyuPickerSelection | undefined,
	discoveredModels: Record<string, RyuCatalogModel[]>
): string | undefined {
	if (!selection) {
		return undefined;
	}
	if (selection.kind === "agent") {
		return catalog.agents.find((agent) => agent.id === selection.agentId)?.name;
	}
	return modelOptionsForCatalog(catalog, discoveredModels).find(
		(option) =>
			option.providerId === selection.providerId &&
			option.modelId === selection.modelId
	)?.label;
}

export function ModelAgentPicker({
	ariaLabel = "Choose a Ryu model or agent",
	catalog,
	disabled = false,
	id,
	mode = "all",
	onDiscoverModels,
	onSelectionChange,
	placeholder = "Choose model or agent",
	value,
}: {
	ariaLabel?: string;
	catalog: RyuCatalogSnapshot | null;
	disabled?: boolean;
	id?: string;
	mode?: RyuPickerMode;
	onDiscoverModels?: (providerId: string) => Promise<RyuCatalogModels>;
	onSelectionChange(selection: RyuPickerSelection): void;
	placeholder?: string;
	value?: RyuPickerSelection;
}) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const [providerFilter, setProviderFilter] = useState<string | null>(null);
	const [discoveredModels, setDiscoveredModels] = useState<
		Record<string, RyuCatalogModel[]>
	>({});
	const [discoveringProvider, setDiscoveringProvider] = useState<string | null>(
		null
	);
	const [discoveryErrors, setDiscoveryErrors] = useState<
		Record<string, string>
	>({});
	const models = useMemo(
		() => (catalog ? modelOptionsForCatalog(catalog, discoveredModels) : []),
		[catalog, discoveredModels]
	);
	const visibleModels = useMemo(
		() =>
			providerFilter
				? models.filter((model) => model.providerId === providerFilter)
				: models,
		[models, providerFilter]
	);
	const providers = useMemo(() => catalog?.providers ?? [], [catalog]);
	const agents = useMemo(
		() => (catalog ? agentOptionsForCatalog(catalog) : []),
		[catalog]
	);
	const selectedLabel = catalog
		? selectionLabel(catalog, value, discoveredModels)
		: undefined;
	const showModels = mode === "all" || mode === "model";
	const showAgents = mode === "all" || mode === "agent";

	const discoverProviderModels = async (providerId: string) => {
		if (!onDiscoverModels || discoveringProvider === providerId) {
			return;
		}
		setDiscoveringProvider(providerId);
		setDiscoveryErrors((current) => {
			const next = { ...current };
			delete next[providerId];
			return next;
		});
		try {
			const result = await onDiscoverModels(providerId);
			setDiscoveredModels((current) => ({
				...current,
				[providerId]: result.models,
			}));
		} catch {
			setDiscoveryErrors((current) => ({
				...current,
				[providerId]: "Model discovery failed. Try again.",
			}));
		} finally {
			setDiscoveringProvider(null);
		}
	};

	if (!catalog) {
		return (
			<div
				className={styles["ryu-model-agent-picker"]}
				data-testid="ryu-model-agent-picker"
			>
				<Button
					aria-label={ariaLabel}
					className="w-full justify-between"
					disabled
					size="sm"
					variant="outline"
				>
					<span className="truncate text-muted-foreground">
						Ryu host unavailable
					</span>
					<HugeiconsIcon icon={ArrowDown01Icon} />
				</Button>
				<p className="text-muted-foreground text-xs">
					Open this app inside Ryu to use the shared runtime catalog.
				</p>
			</div>
		);
	}

	return (
		<div
			className={styles["ryu-model-agent-picker"]}
			data-testid="ryu-model-agent-picker"
		>
			<Popover
				onOpenChange={(nextOpen) => {
					setOpen(nextOpen);
					if (!nextOpen) {
						setProviderFilter(null);
					}
				}}
				open={open}
			>
				<PopoverTrigger
					render={
						<Button
							aria-expanded={open}
							aria-label={ariaLabel}
							className="w-full justify-between"
							disabled={disabled}
							id={id}
							role="combobox"
							size="sm"
							variant="outline"
						/>
					}
				>
					<span className="flex min-w-0 items-center gap-2 truncate">
						<HugeiconsIcon
							className="size-4 shrink-0 text-muted-foreground"
							icon={value?.kind === "agent" ? BotIcon : SparklesIcon}
						/>
						<span className={cn(!selectedLabel && "text-muted-foreground")}>
							{selectedLabel ?? placeholder}
						</span>
					</span>
					<HugeiconsIcon
						className="size-4 shrink-0 text-muted-foreground"
						icon={ArrowDown01Icon}
					/>
				</PopoverTrigger>
				<PopoverContent
					align="start"
					className={cn(
						styles["ryu-model-agent-popover"],
						"w-[min(24rem,calc(100vw-2rem))] p-0"
					)}
				>
					<Command>
						<CommandInput
							placeholder={
								providerFilter
									? tl("Search {providerName} models…", {
											providerName:
												catalog.providers.find(
													(provider) => provider.id === providerFilter
												)?.label ?? "provider",
										})
									: "Search Ryu models, agents, providers…"
							}
						/>
						<CommandEmpty>No Ryu runtime option found.</CommandEmpty>
						<CommandList>
							{showModels && visibleModels.length > 0 ? (
								<CommandGroup heading="Models">
									{visibleModels.map((option) => {
										const key = `model:${option.providerId}:${option.modelId}`;
										return (
											<CommandItem
												aria-disabled={option.disabled}
												data-checked={selectionKey(value) === key}
												disabled={option.disabled}
												key={key}
												onSelect={() => {
													onSelectionChange({
														kind: "model",
														modelId: option.modelId,
														providerId: option.providerId,
													});
													setOpen(false);
												}}
												value={option.searchValue}
											>
												<span className="flex min-w-0 flex-1 flex-col gap-0.5">
													<span className="truncate">{option.label}</span>
													<span className="truncate text-muted-foreground text-xs">
														{option.providerLabel}
													</span>
												</span>
												<Badge variant="outline">{option.authLabel}</Badge>
												{option.disabled ? (
													<span className="text-muted-foreground text-xs">
														Connect
													</span>
												) : null}
											</CommandItem>
										);
									})}
								</CommandGroup>
							) : null}
							{showModels && providerFilter && visibleModels.length === 0 ? (
								<div className={styles["ryu-model-agent-empty"]}>
									{discoveringProvider === providerFilter
										? "Discovering models through Ryu…"
										: (discoveryErrors[providerFilter] ??
											"No model suggestions are published for this provider yet.")}
									{onDiscoverModels &&
									catalog.providers.find(
										(provider) => provider.id === providerFilter
									)?.supportsDiscovery ? (
										<div className="mt-2">
											<Button
												disabled={discoveringProvider === providerFilter}
												onClick={() => {
													void discoverProviderModels(providerFilter);
												}}
												size="sm"
												variant="outline"
											>
												{discoveryErrors[providerFilter]
													? "Retry discovery"
													: "Discover models"}
											</Button>
										</div>
									) : null}
								</div>
							) : null}
							{showAgents && agents.length > 0 ? (
								<CommandGroup heading="Agents">
									{agents.map((option) => {
										const key = `agent:${option.agentId}`;
										const agent = catalog.agents.find(
											(item) => item.id === option.agentId
										);
										return (
											<CommandItem
												aria-disabled={option.disabled}
												data-checked={selectionKey(value) === key}
												disabled={option.disabled}
												key={key}
												onSelect={() => {
													onSelectionChange({
														agentId: option.agentId,
														kind: "agent",
													});
													setOpen(false);
												}}
												value={option.searchValue}
											>
												<span className="flex min-w-0 flex-1 flex-col gap-0.5">
													<span className="truncate">{option.label}</span>
													<span className="truncate text-muted-foreground text-xs">
														{agent?.engine ?? agent?.transport ?? "Ryu agent"}
														{agent?.model ? ` · ${agent.model}` : ""}
													</span>
												</span>
												<Badge
													variant={agent?.recommended ? "default" : "outline"}
												>
													{option.disabled
														? "Install"
														: agent?.recommended
															? "Recommended"
															: "Agent"}
												</Badge>
											</CommandItem>
										);
									})}
								</CommandGroup>
							) : null}
							{showModels && providers.length > 0 ? (
								<CommandGroup heading="Provider lanes">
									{providerFilter ? (
										<CommandItem
											className={styles["ryu-model-agent-provider-reset"]}
											onSelect={() => setProviderFilter(null)}
											value="all provider lanes"
										>
											← All provider lanes
										</CommandItem>
									) : null}
									{providers.map((provider) => {
										const unavailable = providerIsUnavailable(provider);
										return (
											<CommandItem
												aria-disabled={unavailable}
												data-provider-id={provider.id}
												disabled={unavailable}
												key={provider.id}
												onSelect={() => {
													setProviderFilter(provider.id);
													if (
														models.every(
															(model) => model.providerId !== provider.id
														)
													) {
														void discoverProviderModels(provider.id);
													}
												}}
												value={providerSearchValue(provider)}
											>
												<span className="flex min-w-0 flex-1 flex-col gap-0.5">
													<span className="truncate">{provider.label}</span>
													<span className="truncate text-muted-foreground text-xs">
														{provider.id}
													</span>
												</span>
												<Badge variant="outline">
													{providerAuthLabel(provider)}
												</Badge>
												<span className="text-muted-foreground text-xs">
													{unavailable ? "Connect" : "Browse"}
												</span>
											</CommandItem>
										);
									})}
								</CommandGroup>
							) : null}
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
			<p className="text-muted-foreground text-xs">
				Ryu resolves the route. Provider credentials stay in Ryu and never enter
				this app.
			</p>
		</div>
	);
}

export type {
	RyuAgent,
	RyuCatalogModel,
	RyuCatalogModels,
	RyuCatalogSnapshot,
	RyuProvider,
} from "@ryu/app-host/app-bridge";
