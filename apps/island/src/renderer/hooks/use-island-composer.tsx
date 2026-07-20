// Shared composer state for the island: agent + model + thinking pickers (the same
// Codex-style `ComposerSettingsMenu` as desktop), persisted per-agent via ACP
// localStorage and `island-agents.voiceAgent` for routing.

import {
	ComposerSettingsMenu,
	type ComposerSettingsSection,
} from "@ryu/blocks/composer/composer-settings-menu";
import {
	ModeMenuContent,
	type ModeOption,
} from "@ryu/blocks/composer/mode-menu-content";
import type { ModelOption } from "@ryu/blocks/composer/types";
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
	/** Values for `CoreChatStreamRequest` ACP fields. */
	getAcpPayload: () => {
		acp_config?: Record<string, string>;
		acp_mode?: string;
		acp_model?: string;
	};
	leftActions: ReactNode;
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
			className="text-neutral-200 hover:bg-white/10"
			compact
			sections={sections}
			side="top"
		/>
	);

	const getAcpPayload = useCallback(() => {
		const payload: {
			acp_config?: Record<string, string>;
			acp_mode?: string;
			acp_model?: string;
		} = {};
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
		getAcpPayload,
		leftActions,
		sections,
	};
}
