// Shared composer state for the island: agent + model + thinking pickers (the same
// Codex-style `ComposerSettingsMenu` as desktop), persisted per-agent via ACP
// localStorage and `island-agents.voiceAgent` for routing.

import type { StreamedAcpConfig } from "@ryu/blocks/composer/composer-acp-sections";
import { createComposerDirectory } from "@ryu/blocks/composer/composer-directory";
import {
	ComposerSettingsMenu,
	type ComposerSettingsSection,
} from "@ryu/blocks/composer/composer-settings-menu";
import {
	ModeMenuContent,
	type ModeOption,
} from "@ryu/blocks/composer/mode-menu-content";
import type { ModelOption } from "@ryu/blocks/composer/types";
import type {
	ComposerMenuGroup,
	ComposerMenuItem,
} from "@ryu/blocks/desktop/agent-elements/input/composer-menu";
import type { MentionItem } from "@ryu/blocks/desktop/agent-elements/types";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { AcpConfig } from "../../shared/acp.ts";
import {
	DEFAULT_ISLAND_AGENT_PREFS,
	parseIslandAgentPrefs,
} from "../../shared/agents.ts";
import type { CoreAgentSummary } from "../../shared/ipc.ts";
import { getAgentModel, modelsForAgent, setAgentModel } from "../lib/models.ts";
import { useIslandAcpSections } from "./use-island-acp-sections.ts";

export interface IslandComposerState {
	agentId: string;
	/**
	 * Adopt an agent-requested session-config write-back seen on the live chat
	 * stream (Core's `data-ryu-acp-config`). `key` is the emission identity of the
	 * part that carried it — a repeat of the byte-identical map under a NEW key
	 * must still be adopted, which is why the value alone cannot be the identity.
	 * Called by `useIslandChat`; without it an approved plan would re-arm the Plan
	 * mode pill and the agent would refuse the edits just approved.
	 */
	applyStreamedAcpConfig: (config: Record<string, string>, key: string) => void;
	/** Adopt an agent-initiated permission-mode switch (`data-ryu-acp-mode`). */
	applyStreamedAcpMode: (modeId: string) => void;
	composerMenuGroups: ComposerMenuGroup[];
	/** Values for `CoreChatStreamRequest` ACP fields. */
	getAcpPayload: () => {
		acp_config?: Record<string, string>;
		acp_mode?: string;
		acp_model?: string;
	};
	leftActions: ReactNode;
	mentionItems: MentionItem[];
	onComposerMenuSelect: (item: ComposerMenuItem) => void;
	sections: ComposerSettingsSection[];
}

export function useIslandComposer(): IslandComposerState {
	const [agents, setAgents] = useState<CoreAgentSummary[]>([]);
	const [engineCatalog, setEngineCatalog] = useState<
		Record<string, ModelOption[]>
	>({});
	const [agentId, setAgentId] = useState<string>(
		DEFAULT_ISLAND_AGENT_PREFS.voiceAgent
	);
	const [engineModel, setEngineModel] = useState<string | null>(() =>
		getAgentModel(DEFAULT_ISLAND_AGENT_PREFS.voiceAgent)
	);
	const [acpSessionConfig, setAcpSessionConfig] = useState<AcpConfig | null>(
		null
	);
	// The newest agent-driven write-backs off the live chat stream. Never cleared:
	// the shared hook dedupes the config channel on the emission key it carries, so
	// a stale value can only ever be re-adopted by a NEW emission.
	const [streamedAcpMode, setStreamedAcpMode] = useState<string | null>(null);
	const [streamedAcpConfig, setStreamedAcpConfig] =
		useState<StreamedAcpConfig | null>(null);
	const applyStreamedAcpMode = useCallback((modeId: string) => {
		setStreamedAcpMode(modeId);
	}, []);
	const applyStreamedAcpConfig = useCallback(
		(config: Record<string, string>, key: string) => {
			setStreamedAcpConfig({ config, key });
		},
		[]
	);

	useEffect(() => {
		let cancelled = false;
		window.island.core.agents().then((result) => {
			if (!cancelled && result.available) {
				setAgents(result.agents);
			}
		});
		window.island.core.engineModels().then((result) => {
			if (!cancelled && result.available) {
				const catalog: Record<string, ModelOption[]> = {};
				for (const [engine, models] of Object.entries(result.models)) {
					catalog[engine] = models.map((m) => ({
						id: m.id,
						name: m.name,
					}));
				}
				setEngineCatalog(catalog);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		window.island.agents.get().then((raw) => {
			const prefs = parseIslandAgentPrefs(raw);
			setAgentId(prefs.voiceAgent);
			setEngineModel(getAgentModel(prefs.voiceAgent));
		});
		const off = window.island.agents.onChanged((raw) => {
			const prefs = parseIslandAgentPrefs(raw);
			setAgentId(prefs.voiceAgent);
			setEngineModel(getAgentModel(prefs.voiceAgent));
		});
		return () => {
			off();
		};
	}, []);

	useEffect(() => {
		if (!agentId) {
			setAcpSessionConfig(null);
			return;
		}
		let cancelled = false;
		window.island.core.acpConfig(agentId).then((result) => {
			if (!cancelled) {
				setAcpSessionConfig(result.available ? result.config : null);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [agentId]);

	const modelOptions = useMemo(
		() => modelsForAgent(agentId, agents, engineCatalog),
		[agentId, agents, engineCatalog]
	);

	const handleEngineModelChange = useCallback(
		(modelId: string) => {
			setEngineModel(modelId);
			if (agentId) {
				setAgentModel(agentId, modelId);
			}
		},
		[agentId]
	);

	const { acpMode, acpModel, acpOptionValues, extraSections, modelSection } =
		useIslandAcpSections({
			agentId,
			agents,
			acpSessionConfig,
			engineModel,
			modelOptions,
			onEngineModelChange: handleEngineModelChange,
			streamedConfig: streamedAcpConfig,
			streamedMode: streamedAcpMode,
		});

	const modes = useMemo<ModeOption[]>(
		() =>
			agents.map((a) => ({
				id: a.id,
				label: a.name,
				description: a.description ?? undefined,
				group: "Agents",
			})),
		[agents]
	);

	const handleSelectAgent = useCallback((nextId: string) => {
		setAgentId(nextId);
		setEngineModel(getAgentModel(nextId));
		window.island.agents
			.get()
			.then((raw) => {
				const prefs = parseIslandAgentPrefs(raw);
				if (nextId === prefs.voiceAgent) {
					return;
				}
				return window.island.agents.set(
					JSON.stringify({ ...prefs, voiceAgent: nextId })
				);
			})
			.catch(() => undefined);
	}, []);

	const sections = useMemo(() => {
		const activeMode = modes.find((m) => m.id === agentId) ?? modes[0];
		const agentSection: ComposerSettingsSection = {
			key: "agent",
			label: "Agent",
			ariaLabel: "Select agent",
			activeName: activeMode?.label,
			items: modes.map((m) => ({
				id: m.id,
				name: m.label,
				description: m.description,
			})),
			value: agentId,
			onChange: handleSelectAgent,
			renderContent: (onSelect: (id: string) => void) => (
				<ModeMenuContent
					activeId={activeMode?.id}
					modes={modes}
					onSelect={onSelect}
				/>
			),
		};
		const modelSectionResolved: ComposerSettingsSection = {
			key: "model",
			label: "Model",
			ariaLabel: "Select model",
			items: modelSection.items,
			value: modelSection.value,
			onChange: modelSection.onChange,
		};
		return [agentSection, modelSectionResolved, ...extraSections];
	}, [agentId, modes, handleSelectAgent, modelSection, extraSections]);

	const leftActions = (
		<ComposerSettingsMenu
			compact
			sections={sections}
			side="top"
			tone="foreground"
		/>
	);
	const composerDirectory = useMemo(
		() => createComposerDirectory(sections),
		[sections]
	);

	const getAcpPayload = useCallback(() => {
		const payload: Pick<
			import("../../shared/ipc.ts").CoreChatStreamRequest,
			"acp_config" | "acp_mode" | "acp_model"
		> = {};
		if (acpMode) {
			payload.acp_mode = acpMode;
		}
		if (acpModel) {
			payload.acp_model = acpModel;
		}
		if (Object.keys(acpOptionValues).length > 0) {
			payload.acp_config = acpOptionValues;
		}
		return payload;
	}, [acpMode, acpModel, acpOptionValues]);

	return {
		agentId,
		applyStreamedAcpConfig,
		applyStreamedAcpMode,
		getAcpPayload,
		leftActions,
		composerMenuGroups: composerDirectory.groups,
		mentionItems: composerDirectory.mentionItems,
		onComposerMenuSelect: composerDirectory.onSelect,
		sections,
	};
}
