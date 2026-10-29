"use client";

import { useProviderCatalog } from "@/src/hooks/provider-query-scope.ts";

// A settings field that captures the WHOLE target the chat composer can express
// — agent, provider, model, thinking level, reasoning effort, and ACP access
// (permission) mode — as one controlled `AgentSelection` value.
//
// `AgentModelPickerField` (its sibling) persists a single id: a model id OR an
// agent id, never both, and deliberately hides thinking because a bare-string
// field has nowhere to put it. That is the right shape for a field that feeds
// one model id to one call. It is the wrong shape for "the default everything
// unset inherits", which has to be able to say "agent Claude Code, in plan mode"
// just as well as "gpt-5 at high effort".
//
// So this field reuses the exact same `UniversalPickerBody` (single source — see
// the composer) but emits the full object, and it is *controlled*: it mutates
// nothing live, unlike `useUniversalPicker`, which drives the running turn.
//
// Ordinary ACP agent selections and provider/model selections are mutually
// exclusive. Ryu is the one intentional exception: it is the built-in agent
// facade for both lanes, so a lane default may carry `agent_id: "ryu"` together
// with its provider, model, and effort. The controlled field opts into that
// exception explicitly so older settings fields keep their original shape.
//
// Access mode and effort are read from what the picked agent actually advertises
// (`GET /api/agents/:id/acp-config`, the same data-driven contract the composer
// uses) rather than a hardcoded list, so an agent that advertises no modes shows
// no mode picker instead of a menu of options it would ignore.

import {
	ArrowDown01Icon,
	ArrowTurnBackwardIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	FullAccessSelectionProvider,
	useFullAccessSelectionGuard,
} from "@ryu/blocks/composer/full-access-warning.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { modelMenuItem } from "@/components/agent-elements/input/model-router.ts";
import { ProviderCommandDialog } from "@/components/agent-elements/input/provider-command-dialog.tsx";
import {
	type ProviderEntry,
	UniversalPickerBody,
	type UniversalPickerData,
} from "@/components/agent-elements/input/universal-picker-body.tsx";
import { useAgents } from "@/src/hooks/useAgents.ts";
import {
	AgentAvatar,
	AgentLogo,
	engineForAgent,
} from "@/src/lib/agent-logos.tsx";
import { fetchAcpConfig } from "@/src/lib/api/acp.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { filterEnabledModels } from "@/src/lib/api/pi-config.ts";
import {
	type AgentSelection,
	EMPTY_AGENT_SELECTION,
	isAgentSelectionEmpty,
} from "@/src/lib/api/preferences.ts";
import { ProviderBrandLogo } from "@/src/lib/provider-brand.tsx";

/** Non-empty sentinel: Base UI Select is unreliable with empty-string values. */
const INHERIT = "__inherit__";

/** Map a Pi provider id to its brand-logo key (mirrors `useUniversalPicker`). */
const PROVIDER_ENGINE_KEY = new Map<string, string>([
	["google", "gemini"],
	["claude-pro-max", "claude"],
	["openai-codex", "codex"],
	["chatgpt", "chatgpt"],
]);

const NOOP = () => {
	// Field mode never reaches the composer-only actions (upsell / install /
	// configure-credentials / live save).
};

export interface AgentSelectionFieldProps {
	/** Restrict the picker to the agents offered by the preceding onboarding step. */
	allowedAgentIds?: readonly string[];
	/** Restrict provider/model choices to the providers usable in this lane. */
	allowedProviderIds?: readonly string[];
	/** Accessible label for the trigger. */
	ariaLabel: string;
	className?: string;
	disabled?: boolean;
	/** Keep models visible in setup fields across interface levels. */
	forceModelPicker?: boolean;
	onChange: (next: AgentSelection) => void;
	/** Shown when nothing is selected. */
	placeholder?: string;
	/** Keep Ryu's provider/model/effort alongside its agent id. */
	preserveRyuRoute?: boolean;
	/** The Core node whose catalog/agents/ACP config this field reads. */
	target: ApiTarget;
	value: AgentSelection;
}

export function AgentSelectionField(props: AgentSelectionFieldProps) {
	const agentName = props.value.agent_id?.replace(/^acp:/, "") || undefined;
	return (
		<FullAccessSelectionProvider agentName={agentName}>
			<AgentSelectionFieldContent {...props} />
		</FullAccessSelectionProvider>
	);
}

/** Free-text escape hatch: local, pinned and fine-tuned ids are in no catalog. */
function CustomModelRow({
	current,
	onCommit,
}: {
	current: string;
	onCommit: (id: string) => void;
}) {
	const [draft, setDraft] = useState(current);
	const commit = () => {
		const next = draft.trim();
		if (next) {
			onCommit(next);
		}
	};
	return (
		<div>
			<span className="type-caption px-1.5 pb-1 font-medium text-muted-foreground uppercase tracking-wide">
				Custom model
			</span>
			<div className="flex items-center gap-1">
				<Input
					aria-label="Custom model id"
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						e.stopPropagation();
						if (e.key === "Enter") {
							e.preventDefault();
							commit();
						}
					}}
					placeholder="Any model id (e.g. a local or pinned model)"
					purpose="model-identifier"
					value={draft}
				/>
				<button
					aria-label="Use this model"
					className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-40"
					disabled={!draft.trim()}
					onClick={commit}
					type="button"
				>
					<HugeiconsIcon icon={ArrowDown01Icon} size={14} />
				</button>
			</div>
		</div>
	);
}

/** "Use the default" row — the only way back to an unset field once picked. */
function InheritRow({ onClear }: { onClear: () => void }) {
	return (
		<div>
			<button
				className="text-(length:--text-detail) flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
				onClick={onClear}
				type="button"
			>
				<HugeiconsIcon icon={ArrowTurnBackwardIcon} size={14} />
				<span>Use the default</span>
			</button>
		</div>
	);
}

/** The trigger's leading brand/agent mark for the current selection, or null. */
function SelectionMark({
	agent,
	selection,
}: {
	agent: AgentSummary | null;
	selection: AgentSelection;
}) {
	if (selection.agent_id) {
		if (agent?.avatarGlyph) {
			return (
				<AgentAvatar
					className="size-4 shrink-0 object-contain"
					engine={agent ? engineForAgent(agent) : null}
					glyph={agent.avatarGlyph}
					size="16px"
				/>
			);
		}
		return (
			<AgentLogo
				className="size-4 shrink-0"
				engine={agent ? engineForAgent(agent) : null}
				size="16px"
			/>
		);
	}
	if (selection.provider) {
		return (
			<ProviderBrandLogo
				className="size-4 shrink-0"
				providerKey={selection.provider}
				size={16}
			/>
		);
	}
	return null;
}

/** One-line summary of a selection, e.g. `Claude Code · plan` or `gpt-5 · high`. */
function summarize(
	selection: AgentSelection,
	agent: AgentSummary | null
): string {
	const parts: string[] = [];
	if (selection.agent_id) {
		parts.push(agent?.name ?? selection.agent_id);
		if (selection.model) {
			parts.push(selection.model);
		}
		if (selection.access_mode) {
			parts.push(selection.access_mode);
		}
	} else if (selection.model) {
		parts.push(selection.model);
	}
	if (selection.thinking_level) {
		parts.push(selection.thinking_level);
	}
	if (selection.effort && selection.effort !== selection.thinking_level) {
		parts.push(selection.effort);
	}
	return parts.join(" · ");
}

function AgentSelectionFieldContent({
	value,
	onChange,
	target,
	ariaLabel,
	placeholder = "Use the default",
	className,
	disabled,
	allowedAgentIds,
	allowedProviderIds,
	forceModelPicker = false,
	preserveRyuRoute = false,
}: AgentSelectionFieldProps) {
	const selectionGuard = useFullAccessSelectionGuard();
	const catalogQuery = useProviderCatalog(target, {
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
	});
	const { agents } = useAgents();
	const allowedAgentIdSet = useMemo(
		() => (allowedAgentIds ? new Set(allowedAgentIds) : null),
		[allowedAgentIds]
	);
	const availableAgents = useMemo(
		() =>
			allowedAgentIdSet
				? agents.filter((agent) => allowedAgentIdSet.has(agent.id))
				: agents,
		[agents, allowedAgentIdSet]
	);
	const flagship = useMemo(
		() =>
			agents.find((agent) => agent.id === "ryu") ??
			agents.find((agent) => agent.recommended) ??
			null,
		[agents]
	);

	// What the SELECTED agent advertises: its permission modes and any
	// reasoning-effort-style config option. Only fetched once an agent is picked
	// (the probe spawns the agent subprocess, so it must not run speculatively).
	const acpQuery = useQuery({
		queryKey: ["acp-config", target.url, value.agent_id],
		queryFn: () => fetchAcpConfig(target, value.agent_id),
		enabled: Boolean(value.agent_id) && value.agent_id !== "ryu",
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
		retry: 1,
	});

	const activeAgent = useMemo(
		() =>
			value.agent_id
				? (agents.find((a) => a.id === value.agent_id) ?? null)
				: null,
		[value.agent_id, agents]
	);
	const keepsRyuRoute =
		preserveRyuRoute && value.agent_id === (flagship?.id ?? "ryu");

	const pickAgent = (agentId: string) => {
		const ryuId = flagship?.id ?? "ryu";
		if (preserveRyuRoute && agentId === ryuId) {
			const keepsRyuRoute = value.agent_id === "" || value.agent_id === ryuId;
			onChange(
				keepsRyuRoute
					? { ...value, agent_id: agentId, access_mode: "" }
					: { ...EMPTY_AGENT_SELECTION, agent_id: agentId }
			);
			return;
		}
		onChange({
			...value,
			agent_id: agentId,
			provider: "",
			model: "",
			thinking_level: "",
			effort: "",
			access_mode: "",
		});
	};

	const pickModel = (providerId: string | null, modelId: string) =>
		onChange({
			...value,
			agent_id: keepsRyuRoute ? value.agent_id : "",
			access_mode: keepsRyuRoute ? value.access_mode : "",
			provider: providerId ?? "",
			model: modelId,
		});

	const data: UniversalPickerData = useMemo(() => {
		const providers: ProviderEntry[] = (catalogQuery.data?.providers ?? [])
			// The synthetic gateway pseudo-provider carries no models of its own.
			.filter((p) => p.id !== "gateway")
			.filter(
				(p) =>
					!allowedProviderIds ||
					allowedProviderIds.includes(p.id) ||
					p.id === value.provider
			)
			.map((p) => {
				const isActive =
					(value.agent_id === "" || keepsRyuRoute) && value.provider === p.id;
				return {
					id: p.id,
					label: p.label,
					engineKey: PROVIDER_ENGINE_KEY.get(p.id) ?? p.id,
					authKind: p.authKind,
					managed: false,
					// Keep real discovery so a discovery-capable provider shows its
					// full list, exactly as the composer does.
					supportsDiscovery: p.supportsDiscovery !== false,
					upsell: false,
					// Forced true: the field records ids; the Gateway resolves routing
					// at call time, so an unconfigured provider is still a valid pick.
					configured: true,
					isActive,
					currentModel: isActive ? value.model : null,
					currentThinking: isActive ? value.thinking_level : null,
					modelOverrides: p.modelOverrides,
					// Hidden models are not offerable here either; the field's own
					// recorded model stays visible so an existing setting is readable.
					models: filterEnabledModels(
						p.suggestedModels.map((m) => modelMenuItem(m)),
						p.modelOverrides,
						isActive ? value.model : null
					),
				};
			});

		return {
			activeAgentId: value.agent_id || null,
			agents: availableAgents,
			activeModelSection: null,
			activeExtraSections: [],
			availableExternal: [],
			forceModelPicker,
			customAgents: availableAgents.filter(
				(a) => a.transport !== "acp" && a.id !== flagship?.id
			),
			installedExternal: availableAgents.filter(
				(a) => a.transport === "acp" && a.id !== flagship?.id
			),
			installPendingId: null,
			// A stored default must be a concrete target: the "Auto" sentinel is
			// resolved per-turn and would make the default recursive.
			hideAuto: true,
			ryuAgent: flagship,
			ryuActive: value.agent_id !== "" && value.agent_id === flagship?.id,
			providers,
			teams: [],
			thinkingLevels: catalogQuery.data?.thinkingLevels ?? [],
			onSelectAgent: pickAgent,
			onSelectProviderModel: (providerId, modelId) =>
				pickModel(providerId, modelId),
			onSelectProviderThinking: (providerId, level) =>
				onChange({
					...value,
					agent_id: keepsRyuRoute ? value.agent_id : "",
					access_mode: keepsRyuRoute ? value.access_mode : "",
					provider: providerId,
					thinking_level: level,
				}),
			onUseProvider: (providerId) => {
				const p = providers.find((x) => x.id === providerId);
				const first = p?.currentModel ?? p?.models[0]?.id;
				if (first) {
					pickModel(providerId, first);
				}
			},
			onConfigureCredentials: NOOP,
			onCreateAgent: undefined,
			onInstallExternal: NOOP,
			onSelectTeam: undefined,
			onUpgrade: NOOP,
			// A settings field only records ids — account switching/removal is a
			// live-composer concern, so these are inert here.
			onSwitchProviderAccount: NOOP,
			onRemoveProviderAccount: NOOP,
			onSwitchAgentAccount: NOOP,
			onRemoveAgentAccount: NOOP,
		};
		// `onChange`/`value` drive every handler above; agents + catalog drive the rows.
	}, [
		allowedProviderIds,
		availableAgents,
		catalogQuery.data,
		forceModelPicker,
		flagship,
		keepsRyuRoute,
		onChange,
		preserveRyuRoute,
		value,
	]);

	// Effort options: what the picked agent advertises (its `thoughtLevel`-style
	// select), else Pi's thinking levels for a provider/model pick.
	const agentEffortOption = useMemo(() => {
		const options = acpQuery.data?.configOptions ?? [];
		return (
			options.find((o) => o.category === "thoughtLevel") ??
			options.find((o) => /effort|reasoning|thinking/i.test(o.name ?? "")) ??
			null
		);
	}, [acpQuery.data]);

	const effortItems = useMemo(() => {
		if (agentEffortOption) {
			const raw = agentEffortOption.options ?? [];
			const flat = raw.flatMap((o) => ("options" in o ? o.options : [o]));
			return flat.map((o) => ({ value: o.value, label: o.name || o.value }));
		}
		return (catalogQuery.data?.thinkingLevels ?? []).map((l) => ({
			value: l,
			label: l,
		}));
	}, [agentEffortOption, catalogQuery.data]);

	const accessModes = acpQuery.data?.modes?.availableModes ?? [];
	const label = summarize(value, activeAgent) || placeholder;

	return (
		<div className={cn("space-y-3", className)}>
			<ProviderCommandDialog
				renderBody={(close) => (
					<>
						<UniversalPickerBody close={close} data={data} />
						<CustomModelRow
							current={value.model}
							onCommit={(id) => {
								// Free-typed id — no owning provider to record.
								pickModel(null, id);
								close();
							}}
						/>
						{!isAgentSelectionEmpty(value) && (
							<InheritRow
								onClear={() => {
									onChange(EMPTY_AGENT_SELECTION);
									close();
								}}
							/>
						)}
					</>
				)}
				trigger={
					<button
						aria-label={ariaLabel}
						className="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
						disabled={disabled}
						type="button"
					>
						<SelectionMark agent={activeAgent} selection={value} />
						<span
							className={cn(
								"min-w-0 flex-1 truncate text-left",
								isAgentSelectionEmpty(value)
									? "text-muted-foreground"
									: "text-foreground"
							)}
						>
							{label}
						</span>
						<HugeiconsIcon
							className="shrink-0 text-muted-foreground"
							icon={ArrowDown01Icon}
							size={14}
						/>
					</button>
				}
			/>

			{effortItems.length > 0 && (
				<div className="flex flex-col gap-1.5">
					<Label size="compact" tone="muted">
						Thinking / effort level
					</Label>
					<Select
						items={[
							{ value: INHERIT, label: "Provider default" },
							...effortItems,
						]}
						onValueChange={(v) =>
							onChange({ ...value, effort: v && v !== INHERIT ? v : "" })
						}
						value={value.effort || INHERIT}
					>
						<SelectTrigger appearance="editor-row">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={INHERIT}>Provider default</SelectItem>
							{effortItems.map((it) => (
								<SelectItem key={it.value} value={it.value}>
									{it.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}

			{/* Access mode is agent-only: a raw model call has no permission surface,
			    and the agent's own advertised set is the only honest option list. */}
			{value.agent_id && accessModes.length > 0 && (
				<div className="flex flex-col gap-1.5">
					<Label size="compact" tone="muted">
						Access mode
					</Label>
					<Select
						items={[
							{ value: INHERIT, label: "Agent default" },
							...accessModes.map((m) => ({ value: m.id, label: m.name })),
						]}
						onValueChange={(v) => {
							if (!v) {
								return;
							}
							const mode = accessModes.find((candidate) => candidate.id === v);
							selectionGuard?.request(
								mode ?? { id: v, name: v },
								() =>
									onChange({
										...value,
										access_mode: v === INHERIT ? "" : v,
									}),
								"Access mode"
							);
						}}
						value={value.access_mode || INHERIT}
					>
						<SelectTrigger appearance="editor-row">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={INHERIT}>Agent default</SelectItem>
							{accessModes.map((m) => (
								<SelectItem key={m.id} value={m.id}>
									{m.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}
		</div>
	);
}
