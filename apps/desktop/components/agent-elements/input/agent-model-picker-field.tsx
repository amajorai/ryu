"use client";

import { useProviderCatalog } from "@/src/hooks/provider-query-scope.ts";

// A settings-FIELD wrapper around the exact same universal picker the chat
// composer uses (`UniversalPickerBody`) — so a plugin/gateway field that names a
// model or an agent gets the full "Providers · Agents · External Agents" picker
// (brand logos, per-provider model lists, thinking) instead of a bare text box.
//
// Unlike `useUniversalPicker` (which drives the RUNNING turn by calling Pi
// `save()`), this is a controlled value field: it reads a stored string and emits
// the pick via `onChange`, mutating nothing live. Two shapes:
//   - mode="model": Providers → model list. Emits the bare model id (and the
//     owning provider via `onModelPick` when the caller wants it). Thinking is
//     hidden (a plain model-id field has nowhere to persist it) and the Auto row
//     is suppressed.
//   - mode="agent": the SAME target list the composer shows — Ryu (flagship),
//     installed external ACP agents with their advertised model / reasoning /
//     approval submenus (picks persist as that agent's defaults, exactly like
//     the composer), and custom agents. Emits the agent id.
//
// The trigger mimics the surrounding settings inputs (a full-width bordered
// button) rather than the composer's ghost pill, so it blends into settings cards.

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Input } from "@ryu/ui/components/input.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
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
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { filterEnabledModels } from "@/src/lib/api/pi-config.ts";
import {
	ProviderBrandLogo,
	svglForProvider,
} from "@/src/lib/provider-brand.tsx";

const NOOP = () => {
	// Field-mode never reaches the composer-only actions (upsell / install /
	// configure-credentials / live save); every field provider is forced
	// `configured` and no external agents are offered for install.
};

/** Map a Pi provider id to its brand-logo key (mirrors `useUniversalPicker`). */
const PROVIDER_ENGINE_KEY = new Map<string, string>([
	["google", "gemini"],
	["claude-pro-max", "claude"],
	["openai-codex", "codex"],
	["chatgpt", "chatgpt"],
]);

export interface AgentModelPickerFieldProps {
	/** Accessible label for the trigger. */
	ariaLabel: string;
	className?: string;
	/** Disable the field (e.g. while a parent save is in flight). */
	disabled?: boolean;
	/** "model" → emit a model id; "agent" → emit an agent id. */
	mode: "model" | "agent";
	onChange: (next: string) => void;
	/**
	 * Model mode only: when set, provider-list picks call THIS instead of
	 * `onChange`, carrying the owning provider id (null for a free-typed custom
	 * model). Lets callers that persist `{provider, model}` pairs (side-model
	 * configs) record both from one pick.
	 */
	onModelPick?: (providerId: string | null, modelId: string) => void;
	placeholder?: string;
	/** The Core node this field's catalog/agents are read from. */
	target: ApiTarget;
	/** Currently stored value (a model id or an agent id), or "" when unset. */
	value: string;
}

/**
 * A free-text escape hatch pinned below the model list. Local models, pinned
 * versions (`gpt-4o-2024-11-20`), and custom fine-tunes aren't in any provider's
 * suggested set, so a catalog-only picker would make them unreachable — the old
 * text Input accepted them, and so must this. Commits an arbitrary id on Enter or
 * on the arrow button, then closes the menu.
 */
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
			<span className="px-1.5 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
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

/** The trigger's leading brand/agent mark for the current value, or null. */
function ValueMark({
	mode,
	value,
	providerIdForModel,
	agent,
}: {
	agent: AgentSummary | null;
	mode: "model" | "agent";
	providerIdForModel: string | null;
	value: string;
}) {
	if (!value) {
		return null;
	}
	if (mode === "agent") {
		if (agent?.avatarGlyph) {
			return (
				<AgentAvatar
					className="size-4 shrink-0 object-contain"
					engine={engineForAgent(agent)}
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
	return providerIdForModel ? (
		<ProviderBrandLogo
			className="size-4 shrink-0"
			providerKey={providerIdForModel}
			size={16}
		/>
	) : null;
}

export function AgentModelPickerField({
	mode,
	target,
	value,
	onChange,
	onModelPick,
	placeholder = mode === "agent" ? "Select an agent" : "Select a model",
	ariaLabel,
	className,
	disabled,
}: AgentModelPickerFieldProps) {
	// The Pi catalog for THIS target (read-only — never activated). Only fetched
	// for model mode; agent mode reads the live agent registry instead.
	const catalogQuery = useProviderCatalog(target, {
		enabled: mode === "model",
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
	});

	const { agents } = useAgents();

	// The provider that "owns" the current model value (its suggested set lists it)
	// — drives the trigger logo and the active-row highlight.
	const providerIdForModel = useMemo(() => {
		if (mode !== "model" || !value) {
			return null;
		}
		const providers = catalogQuery.data?.providers ?? [];
		const owner = providers.find((p) => p.suggestedModels?.includes(value));
		return owner?.id ?? null;
	}, [mode, value, catalogQuery.data]);

	const activeAgent = useMemo(
		() =>
			mode === "agent" && value
				? (agents.find((a) => a.id === value) ?? null)
				: null,
		[mode, value, agents]
	);

	const data: UniversalPickerData = useMemo(() => {
		// Provider-aware emit: callers persisting `{provider, model}` get both.
		const emit = (providerId: string | null, modelId: string) => {
			if (onModelPick) {
				onModelPick(providerId, modelId);
			} else {
				onChange(modelId);
			}
		};
		if (mode === "model") {
			const providers: ProviderEntry[] = (catalogQuery.data?.providers ?? [])
				// The synthetic gateway pseudo-provider carries no models of its own.
				.filter((p) => p.id !== "gateway")
				.map((p) => {
					const owns = p.suggestedModels.includes(value);
					return {
						id: p.id,
						label: p.label,
						engineKey: PROVIDER_ENGINE_KEY.get(p.id) ?? p.id,
						authKind: p.authKind,
						managed: false,
						// The managed OpenRouter provider exposes its catalog through the
						// Gateway under a logical id. Keep pricing on the authoritative
						// OpenRouter registry in field-mode pickers too, just like the
						// composer's managed row.
						discoveryProviderId:
							p.id === "managed-openrouter" || p.id === "ryu-openrouter"
								? "openrouter"
								: undefined,
						// Field mode never activates a Pi route, but we keep the provider's
						// real discovery capability so a discovery-capable provider
						// (OpenRouter's hundreds of models) shows its FULL list — the same
						// list the composer shows — not just the 2-4 static suggestions.
						supportsDiscovery: p.supportsDiscovery !== false,
						upsell: false,
						// Forced true so every provider's models are browsable as pick
						// targets even before its credential is stored (the field only
						// records an id; the Gateway resolves routing at call time).
						configured: true,
						isActive: owns,
						currentModel: owns ? value : null,
						currentThinking: null,
						modelOverrides: p.modelOverrides,
						// Hidden models drop out; the field's current value survives so a
						// setting made before the model was hidden is still readable.
						models: filterEnabledModels(
							p.suggestedModels.map((m) => modelMenuItem(m)),
							p.modelOverrides,
							owns ? value : null
						),
					};
				});
			return {
				activeAgentId: null,
				agents: [],
				activeModelSection: null,
				activeExtraSections: [],
				availableExternal: [],
				installedExternal: [],
				installPendingId: null,
				// This is a Settings field, not the compact chat bar. The selected
				// interface density must never hide the model control the field exists
				// to expose.
				forceModelPicker: true,
				hideAuto: true,
				ryuAgent: null,
				ryuActive: false,
				providers,
				teams: [],
				// A model-id field has nowhere to persist a thinking level, so the
				// thinking submenu is hidden.
				thinkingLevels: [],
				onSelectAgent: NOOP,
				onSelectProviderModel: (providerId, modelId) =>
					emit(providerId, modelId),
				onSelectProviderThinking: NOOP,
				onUseProvider: (providerId) => {
					const p = providers.find((x) => x.id === providerId);
					const first = p?.currentModel ?? p?.models[0]?.id;
					if (first) {
						emit(providerId, first);
					}
				},
				onConfigureCredentials: NOOP,
				onCreateAgent: undefined,
				onInstallExternal: NOOP,
				onSelectTeam: undefined,
				onUpgrade: NOOP,
				onSwitchProviderAccount: NOOP,
				onRemoveProviderAccount: NOOP,
				onSwitchAgentAccount: NOOP,
				onRemoveAgentAccount: NOOP,
			};
		}

		// Agent mode: the SAME target buckets the composer's picker shows. The
		// flagship heads the list; installed external ACP agents keep their
		// advertised model / reasoning / approval submenus (`ExternalAgentSettings`
		// probes lazily and persists picks as that agent's defaults — identical to
		// the composer); everything else is a flat custom-agent row. No Pi
		// providers: this field persists one agent id, never a live Pi route.
		const flagship =
			agents.find((a) => a.id === "ryu") ??
			agents.find((a) => a.recommended) ??
			null;
		const installedExternal = agents.filter(
			(a) => a.transport === "acp" && a.id !== flagship?.id
		);
		const customAgents = agents.filter(
			(a) => a.transport !== "acp" && a.id !== flagship?.id
		);
		return {
			activeAgentId: value || null,
			agents,
			activeModelSection: null,
			activeExtraSections: [],
			availableExternal: [],
			customAgents,
			installedExternal,
			installPendingId: null,
			hideAuto: true,
			ryuAgent: flagship,
			ryuActive: value !== "" && value === flagship?.id,
			providers: [],
			teams: [],
			thinkingLevels: [],
			onSelectAgent: (id) => onChange(id),
			onSelectProviderModel: NOOP,
			onSelectProviderThinking: NOOP,
			onUseProvider: NOOP,
			onConfigureCredentials: NOOP,
			onCreateAgent: undefined,
			onInstallExternal: NOOP,
			onSelectTeam: undefined,
			onUpgrade: NOOP,
			onSwitchProviderAccount: NOOP,
			onRemoveProviderAccount: NOOP,
			onSwitchAgentAccount: NOOP,
			onRemoveAgentAccount: NOOP,
		};
	}, [mode, catalogQuery.data, agents, value, onChange, onModelPick]);

	// Agent mode shows the picked agent's display name; model mode the raw id.
	const label =
		((mode === "agent" ? activeAgent?.name : null) ?? value) || placeholder;

	return (
		<ProviderCommandDialog
			renderBody={(close) => (
				<>
					<UniversalPickerBody close={close} data={data} />
					{mode === "model" && (
						<CustomModelRow
							current={value}
							onCommit={(id) => {
								// Free-typed id — no owning provider to report.
								if (onModelPick) {
									onModelPick(null, id);
								} else {
									onChange(id);
								}
								close();
							}}
						/>
					)}
				</>
			)}
			trigger={
				<button
					aria-label={ariaLabel}
					className={cn(
						"flex h-8 w-full items-center gap-2 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
						className
					)}
					disabled={disabled}
					type="button"
				>
					<ValueMark
						agent={activeAgent}
						mode={mode}
						providerIdForModel={providerIdForModel}
						value={value}
					/>
					<span
						className={cn(
							"min-w-0 flex-1 truncate text-left",
							value ? "text-foreground" : "text-muted-foreground"
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
	);
}

/** Whether a raw string resolves to a known provider brand (for callers that
 * want to show a logo beside a stored model id outside the field). */
export function modelHasBrand(providerId: string | null): boolean {
	return providerId ? svglForProvider(providerId) !== null : false;
}
