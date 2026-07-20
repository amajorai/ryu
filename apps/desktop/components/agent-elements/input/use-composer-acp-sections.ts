"use client";

// The ONE derivation of the composer's ACP-driven picker sections — the Model
// selector and the "thinking"/approval + agent-advertised config selectors — from
// an agent's advertised session config (`useAcpConfig`, keyed by agentId, NOT a
// live chat session). ChatPage, the launchpad, and the Ask Ryu dock all call this
// and feed its `modelSection` / `extraSections` straight into
// `useComposerAgentControls`, so every surface shows the SAME Agent · Model ·
// Thinking dropdown — even before a chat exists.
//
// Selections persist per-agent to localStorage (the same store the spawned chat
// reads on `session/new`), so a model/mode picked on the launchpad is honoured by
// the new chat. ChatPage additionally reads the returned effective values
// (`acpMode` / `acpModel` / `acpOptionValues`) onto its per-turn request body.
//
// This is a faithful lift of the logic that used to live inline in ChatPage; the
// dedup rules (a category:"mode"/"model" config option supersedes the generic
// picker; a modes set duplicated by a config option is hidden; reasoning-off
// suppresses the thinking picker) are preserved exactly.

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComposerModelSection } from "@/components/agent-elements/input/composer-agent-controls.tsx";
import { approvalModeStyle } from "@/components/agent-elements/input/composer-approval-style.ts";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import {
	groupModelItems,
	mergeInstalledModels,
} from "@/components/agent-elements/input/model-groups.ts";
import { createModelMenuRenderer } from "@/components/agent-elements/input/model-menu-content.tsx";
import type { ModelOption } from "@/components/agent-elements/types.ts";
import { useAcpConfig } from "@/src/hooks/useAcpConfig.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgentCapabilities } from "@/src/hooks/useAgentCapabilities.ts";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import {
	getAcpConfig,
	getAcpMode,
	getAcpModel,
	setAcpConfigValue as persistAcpConfigValue,
	setAcpMode as persistAcpMode,
	setAcpModel as persistAcpModel,
} from "@/src/lib/acp-selections.ts";
import type { AcpConfig } from "@/src/lib/api/acp.ts";
import { flattenConfigOptions } from "@/src/lib/api/acp.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import { getActiveModel, listInstalledModels } from "@/src/lib/api/models.ts";
import { friendlyModelDisplay } from "@/src/lib/catalog/friendly.ts";

type AcpConfigOption = NonNullable<AcpConfig["configOptions"]>[number];

// Strip a redundant "Option:" prefix a value name may repeat (Pi reports
// "Thinking: off", …) and capitalize, so a row reads "Off" not "Thinking: off".
function formatAcpOptionLabel(optionName: string, valueName: string): string {
	let label = valueName.trim();
	const prefix = `${optionName.trim()}:`;
	if (label.toLowerCase().startsWith(prefix.toLowerCase())) {
		label = label.slice(prefix.length).trim();
	}
	return label.length > 0
		? label.charAt(0).toUpperCase() + label.slice(1)
		: label;
}

// A config option that carries the agent's approval/permission presets (Codex
// exposes them as `category: "mode"` rather than the dedicated ACP `modes` set).
// These get the same CLI-style icon+colour treatment as the Approval section via
// `approvalModeStyle`; every other option (reasoning effort, verbosity, …) stays
// plain. Classified by the semantic hint, NOT by agent, so nothing is hardcoded.
function isApprovalConfigOption(opt: AcpConfigOption): boolean {
	if (opt.category === "mode") {
		return true;
	}
	const hay = `${opt.id} ${opt.name}`.toLowerCase();
	return ["approval", "permission", "sandbox", "access"].some((k) =>
		hay.includes(k)
	);
}

// Build the picker section for one agent-advertised `select` config option.
// Approval/permission options (Codex's Read Only / Auto / Full Access, …) get the
// same CLI-style icon+colour the Approval section gets; all others stay plain.
function buildConfigOptionSection(
	opt: AcpConfigOption,
	acpOptionValues: Record<string, string>,
	onChange: (configId: string, valueId: string) => void
): ComposerSettingsSection {
	return {
		key: `cfg-${opt.id}`,
		label: opt.name,
		ariaLabel: opt.name,
		decorate: isApprovalConfigOption(opt) ? approvalModeStyle : undefined,
		items: flattenConfigOptions(opt).map((o) => ({
			id: o.value,
			name: formatAcpOptionLabel(opt.name, o.name),
			description: o.description,
		})),
		value: acpOptionValues[opt.id] ?? opt.currentValue,
		onChange: (valueId: string) => onChange(opt.id, valueId),
	};
}

interface ModelSectionParams {
	acpModelConfigOption: AcpConfigOption | undefined;
	acpOptionValues: Record<string, string>;
	acpSessionConfig: AcpConfig | null | undefined;
	activeAgentIsAcp: boolean;
	effectiveAcpModel: string | null;
	engineModel: string | null;
	hasDedicatedAcpModels: boolean;
	modelDisplayName: (raw: string) => string;
	modelOptions: ModelOption[];
	onAcpModelChange: (id: string) => void;
	onAcpOptionChange: (configId: string, valueId: string) => void;
	onEngineModelChange: (id: string) => void;
}

// Resolve the Model picker via the same priority chain as the old single picker:
// dedicated ACP `models` → a `category:"model"` config option → Ryu's built-in
// engine catalog (only when the active agent is not an ACP agent). Returns an
// empty section (no picker) when an ACP agent advertises no model surface.
function buildModelSection(params: ModelSectionParams): ComposerModelSection {
	const {
		acpModelConfigOption,
		acpOptionValues,
		acpSessionConfig,
		activeAgentIsAcp,
		effectiveAcpModel,
		engineModel,
		hasDedicatedAcpModels,
		modelDisplayName,
		modelOptions,
		onAcpModelChange,
		onAcpOptionChange,
		onEngineModelChange,
	} = params;

	if (hasDedicatedAcpModels && acpSessionConfig?.models) {
		return {
			items: acpSessionConfig.models.availableModels.map((m) => ({
				id: m.modelId,
				name: modelDisplayName(m.name),
			})),
			value: effectiveAcpModel ?? undefined,
			onChange: onAcpModelChange,
		};
	}
	if (acpModelConfigOption) {
		const opt = acpModelConfigOption;
		return {
			items: flattenConfigOptions(opt).map((o) => ({
				id: o.value,
				name: modelDisplayName(o.name),
				description: o.description,
			})),
			value: acpOptionValues[opt.id] ?? opt.currentValue,
			onChange: (valueId: string) => onAcpOptionChange(opt.id, valueId),
		};
	}
	if (!activeAgentIsAcp) {
		return {
			items: modelOptions.map((m) => ({
				id: m.id,
				name: modelDisplayName(m.name),
			})),
			value: engineModel ?? undefined,
			onChange: onEngineModelChange,
		};
	}
	return { items: [], value: undefined, onChange: () => undefined };
}

/** Flat model rows → grouped, searchable submenu (Pi lists are long). */
function withGroupedModelMenu(
	section: ComposerModelSection,
	installedStems: string[],
	activeStem?: string | null
): ComposerModelSection {
	if (section.items.length === 0) {
		return section;
	}
	const merged = mergeInstalledModels(
		section.items,
		installedStems,
		activeStem
	);
	const grouped = groupModelItems(merged);
	return {
		...section,
		items: merged,
		renderContent: createModelMenuRenderer(grouped, section.value),
	};
}

export interface ComposerAcpSectionsParams {
	/** The active agent (drives the advertised config + ACP detection). */
	agentId: string | null;
	/** Live agent registry — used only to detect the active agent's transport. */
	agents: AgentSummary[];
	/** Effective engine model id (for the non-ACP fallback picker). */
	engineModel: string | null;
	/** Engine-catalog model options — the fallback picker for non-ACP agents. */
	modelOptions: ModelOption[];
	/** Persist an engine-catalog model pick (non-ACP fallback). */
	onEngineModelChange: (modelId: string) => void;
	/**
	 * An agent-INITIATED permission-mode change observed on the live chat stream
	 * (Core's `data-ryu-acp-mode` part). When this value changes to a new
	 * non-null mode id, it is adopted as the Approval picker's selection and
	 * persisted for the agent — so the composer reflects a mode the agent
	 * switched to on its own, not just the user's own clicks. Session-scoped
	 * surfaces (launchpad/dock) leave this undefined.
	 */
	streamedMode?: string | null;
}

export interface ComposerAcpSectionsResult {
	/**
	 * Effective permission mode for the request body — null when the dedicated
	 * modes picker is hidden (a config option owns that setting instead).
	 */
	acpMode: string | null;
	/** Effective model id for the request body. */
	acpModel: string | null;
	/** Effective agent-config selections for the request body. */
	acpOptionValues: Record<string, string>;
	/** The Agent-advertised (or engine-fallback) Model section. Empty items → hidden. */
	extraSections: ComposerSettingsSection[];
	/** Approval (permission mode) + agent-advertised config sections. */
	modelSection: ComposerModelSection;
	/** Whether the active agent's reasoning is overridden off (hides thinking picker). */
	reasoningOff: boolean;
}

/**
 * Builds the composer's Model + Approval + config picker sections from the active
 * agent's advertised ACP session config. Session-independent (works on the
 * launchpad and dock before any chat exists); picks persist per-agent.
 */
export function useComposerAcpSections({
	agentId,
	agents,
	modelOptions,
	engineModel,
	onEngineModelChange,
	streamedMode,
}: ComposerAcpSectionsParams): ComposerAcpSectionsResult {
	const activeNode = useActiveNode();
	const isRyuAgent = agentId === "ryu";

	const installedQuery = useQuery({
		queryKey: ["models", "installed", activeNode.url],
		queryFn: () =>
			listInstalledModels({
				url: activeNode.url,
				token: activeNode.token ?? null,
			}),
		enabled: isRyuAgent,
		staleTime: 60_000,
	});
	const activeModelQuery = useQuery({
		queryKey: ["models", "active", activeNode.url],
		queryFn: () =>
			getActiveModel({
				url: activeNode.url,
				token: activeNode.token ?? null,
			}),
		enabled: isRyuAgent,
		staleTime: 30_000,
	});
	const installedStems = useMemo(
		() => (installedQuery.data ?? []).map((m) => m.stem).filter(Boolean),
		[installedQuery.data]
	);
	const activeStem = activeModelQuery.data?.active ?? null;

	// The active agent's advertised permission modes / reasoning-effort config
	// options / models. A picker renders only for what the agent reports.
	const { config: acpSessionConfig, loading: acpConfigLoading } =
		useAcpConfig(agentId);
	// The active agent's effective capabilities — a reasoning-off override
	// suppresses the thinking picker (Jan-style). Pass the engine model so
	// vision/tools detection follows the composer's model selection.
	const { capabilities } = useAgentCapabilities(agentId, engineModel);

	const [acpMode, setAcpMode] = useState<string | null>(() =>
		getAcpMode(agentId)
	);
	const [acpModel, setAcpModel] = useState<string | null>(() =>
		getAcpModel(agentId)
	);
	const [acpOptionValues, setAcpOptionValues] = useState<
		Record<string, string>
	>(() => getAcpConfig(agentId));

	// Tracks the last streamed mode we adopted, so a repeated identical event
	// (same value re-emitted) doesn't clobber a user's subsequent manual pick.
	const lastStreamedModeRef = useRef<string | null>(null);

	// Reset selections to the new agent's persisted choices when it changes.
	useEffect(() => {
		setAcpMode(getAcpMode(agentId));
		setAcpModel(getAcpModel(agentId));
		setAcpOptionValues(getAcpConfig(agentId));
		// A streamed mode belongs to the previous agent's session; forget it.
		lastStreamedModeRef.current = null;
	}, [agentId]);

	// Adopt an agent-initiated mode switch (Core's `data-ryu-acp-mode`): sync the
	// Approval picker's selection and persist it, mirroring a user click.
	useEffect(() => {
		if (!streamedMode || streamedMode === lastStreamedModeRef.current) {
			return;
		}
		lastStreamedModeRef.current = streamedMode;
		setAcpMode(streamedMode);
		if (agentId) {
			persistAcpMode(agentId, streamedMode);
		}
	}, [streamedMode, agentId]);

	const handleAcpModeChange = useCallback(
		(modeId: string) => {
			setAcpMode(modeId);
			if (agentId) {
				persistAcpMode(agentId, modeId);
			}
		},
		[agentId]
	);
	const handleAcpModelChange = useCallback(
		(modelId: string) => {
			setAcpModel(modelId);
			if (agentId) {
				persistAcpModel(agentId, modelId);
			}
		},
		[agentId]
	);
	const handleAcpOptionChange = useCallback(
		(configId: string, valueId: string) => {
			setAcpOptionValues((prev) => ({ ...prev, [configId]: valueId }));
			if (agentId) {
				persistAcpConfigValue(agentId, configId, valueId);
			}
		},
		[agentId]
	);

	const [friendly] = useFriendlyMode();

	return useMemo<ComposerAcpSectionsResult>(() => {
		const modelDisplayName = (raw: string) =>
			friendly ? friendlyModelDisplay(raw).label : raw;

		const effectiveAcpMode =
			acpMode ?? acpSessionConfig?.modes?.currentModeId ?? null;
		const effectiveAcpModel =
			acpModel ?? acpSessionConfig?.models?.currentModelId ?? null;

		const acpConfigOptions = acpSessionConfig?.configOptions ?? [];
		const hasDedicatedAcpModels = Boolean(
			acpSessionConfig?.models &&
				acpSessionConfig.models.availableModels.length > 0
		);
		const activeAgentIsAcp =
			agents.find((a) => a.id === agentId)?.transport === "acp";

		// Some agents advertise reasoning effort as BOTH a `modes` set AND a
		// config option with an identical value set — hide the redundant modes
		// picker in favour of the config option (which carries a stable category/id).
		const acpModeIds = (acpSessionConfig?.modes?.availableModes ?? [])
			.map((m) => m.id)
			.sort()
			.join(",");
		const modesDuplicatedByConfigOption =
			acpModeIds.length > 0 &&
			acpConfigOptions.some(
				(opt) =>
					opt.category !== "model" &&
					flattenConfigOptions(opt)
						.map((o) => o.value)
						.sort()
						.join(",") === acpModeIds
			);
		const hideAcpModesPicker =
			acpConfigOptions.some((opt) => opt.category === "mode") ||
			modesDuplicatedByConfigOption;
		const acpModelConfigOption = acpConfigOptions.find(
			(opt) => opt.category === "model"
		);

		const reasoningOff = capabilities?.reasoning === false;
		const isReasoningOption = (opt: AcpConfigOption): boolean => {
			const hay = `${opt.category ?? ""} ${opt.id} ${opt.name}`.toLowerCase();
			return ["thought", "reason", "think", "effort"].some((m) =>
				hay.includes(m)
			);
		};
		const visibleAcpConfigOptions = acpConfigOptions.filter(
			(opt) =>
				opt.category !== "model" && !(reasoningOff && isReasoningOption(opt))
		);

		// Model section — same priority chain as the old single picker: dedicated
		// ACP `models` → category:"model" config option → Ryu's built-in catalog.
		// While an ACP agent's advertised config is still being probed (`useAcpConfig`
		// spawns the agent subprocess on first fetch, up to ~30s + retries), mark the
		// section loading so the composer shows a "Detecting…" spinner instead of
		// silently hiding an empty picker — the "selectors just missing on agent
		// switch, no loading state" gap.
		const modelSection: ComposerModelSection = {
			...withGroupedModelMenu(
				buildModelSection({
					acpModelConfigOption,
					acpOptionValues,
					acpSessionConfig,
					activeAgentIsAcp,
					effectiveAcpModel,
					engineModel,
					hasDedicatedAcpModels,
					modelDisplayName,
					modelOptions,
					onAcpModelChange: handleAcpModelChange,
					onAcpOptionChange: handleAcpOptionChange,
					onEngineModelChange,
				}),
				isRyuAgent ? installedStems : [],
				isRyuAgent ? activeStem : null
			),
			loading: activeAgentIsAcp && acpConfigLoading,
		};

		const extraSections: ComposerSettingsSection[] = [
			{
				key: "approval",
				label: "Approval",
				ariaLabel: "Permission mode",
				decorate: approvalModeStyle,
				items:
					!hideAcpModesPicker && acpSessionConfig?.modes
						? acpSessionConfig.modes.availableModes.map((m) => ({
								id: m.id,
								name: m.name,
								description: m.description,
							}))
						: [],
				value: effectiveAcpMode ?? acpSessionConfig?.modes?.currentModeId,
				onChange: handleAcpModeChange,
			},
			...visibleAcpConfigOptions.map((opt) =>
				buildConfigOptionSection(opt, acpOptionValues, handleAcpOptionChange)
			),
		];

		return {
			modelSection,
			extraSections,
			// The request body drops acp_mode when the dedicated picker is hidden —
			// a config option owns that setting and a stale set_mode would race it.
			acpMode: hideAcpModesPicker ? null : effectiveAcpMode,
			acpModel: effectiveAcpModel,
			acpOptionValues,
			reasoningOff,
		};
	}, [
		agentId,
		agents,
		acpSessionConfig,
		acpConfigLoading,
		capabilities,
		acpMode,
		acpModel,
		acpOptionValues,
		friendly,
		modelOptions,
		engineModel,
		onEngineModelChange,
		handleAcpModeChange,
		handleAcpModelChange,
		handleAcpOptionChange,
		installedStems,
		activeStem,
		isRyuAgent,
	]);
}
