// Island port of the desktop composer's ACP picker derivation
// (`use-composer-acp-sections.ts`). Builds Model + Approval + config sections from
// the active agent's advertised session config, with per-agent localStorage persistence.

import { approvalModeStyle } from "@ryu/blocks/composer/composer-approval-style";
import type { ComposerSettingsSection } from "@ryu/blocks/composer/composer-settings-menu";
import type { ModelOption } from "@ryu/blocks/composer/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AcpConfig, AcpConfigOption } from "../../shared/acp.ts";
import type { CoreAgentSummary } from "../../shared/ipc.ts";
import { flattenConfigOptions } from "../lib/acp.ts";
import {
	getAcpConfig,
	getAcpMode,
	getAcpModel,
	setAcpConfigValue as persistAcpConfigValue,
	setAcpMode as persistAcpMode,
	setAcpModel as persistAcpModel,
} from "../lib/acp-selections.ts";

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

function isApprovalConfigOption(opt: AcpConfigOption): boolean {
	if (opt.category === "mode") {
		return true;
	}
	const hay = `${opt.id} ${opt.name}`.toLowerCase();
	return ["approval", "permission", "sandbox", "access"].some((k) =>
		hay.includes(k)
	);
}

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

export interface ComposerModelSection {
	items: ComposerSettingsSection["items"];
	onChange: (id: string) => void;
	value: string | undefined;
}

interface ModelSectionParams {
	acpModelConfigOption: AcpConfigOption | undefined;
	acpOptionValues: Record<string, string>;
	acpSessionConfig: AcpConfig | null;
	activeAgentIsAcp: boolean;
	effectiveAcpModel: string | null;
	engineModel: string | null;
	hasDedicatedAcpModels: boolean;
	modelOptions: ModelOption[];
	onAcpModelChange: (id: string) => void;
	onAcpOptionChange: (configId: string, valueId: string) => void;
	onEngineModelChange: (id: string) => void;
}

function buildModelSection(params: ModelSectionParams): ComposerModelSection {
	const {
		acpModelConfigOption,
		acpOptionValues,
		acpSessionConfig,
		activeAgentIsAcp,
		effectiveAcpModel,
		engineModel,
		hasDedicatedAcpModels,
		modelOptions,
		onAcpModelChange,
		onAcpOptionChange,
		onEngineModelChange,
	} = params;

	if (hasDedicatedAcpModels && acpSessionConfig?.models) {
		return {
			items: acpSessionConfig.models.availableModels.map((m) => ({
				id: m.modelId,
				name: m.name,
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
				name: o.name,
				description: o.description,
			})),
			value: acpOptionValues[opt.id] ?? opt.currentValue,
			onChange: (valueId: string) => onAcpOptionChange(opt.id, valueId),
		};
	}
	if (!activeAgentIsAcp) {
		return {
			items: modelOptions.map((m) => ({ id: m.id, name: m.name })),
			value: engineModel ?? undefined,
			onChange: onEngineModelChange,
		};
	}
	return { items: [], value: undefined, onChange: () => undefined };
}

export interface IslandAcpSectionsParams {
	acpSessionConfig: AcpConfig | null;
	agentId: string | null;
	agents: CoreAgentSummary[];
	engineModel: string | null;
	modelOptions: ModelOption[];
	onEngineModelChange: (modelId: string) => void;
}

export interface IslandAcpSectionsResult {
	acpMode: string | null;
	acpModel: string | null;
	acpOptionValues: Record<string, string>;
	extraSections: ComposerSettingsSection[];
	modelSection: ComposerModelSection;
}

export function useIslandAcpSections({
	agentId,
	agents,
	acpSessionConfig,
	engineModel,
	modelOptions,
	onEngineModelChange,
}: IslandAcpSectionsParams): IslandAcpSectionsResult {
	const [acpMode, setAcpMode] = useState<string | null>(() =>
		getAcpMode(agentId)
	);
	const [acpModel, setAcpModel] = useState<string | null>(() =>
		getAcpModel(agentId)
	);
	const [acpOptionValues, setAcpOptionValues] = useState<
		Record<string, string>
	>(() => getAcpConfig(agentId));

	useEffect(() => {
		setAcpMode(getAcpMode(agentId));
		setAcpModel(getAcpModel(agentId));
		setAcpOptionValues(getAcpConfig(agentId));
	}, [agentId]);

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

	return useMemo<IslandAcpSectionsResult>(() => {
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

		const isReasoningOption = (opt: AcpConfigOption): boolean => {
			const hay = `${opt.category ?? ""} ${opt.id} ${opt.name}`.toLowerCase();
			return ["thought", "reason", "think", "effort"].some((m) =>
				hay.includes(m)
			);
		};
		const visibleAcpConfigOptions = acpConfigOptions.filter(
			(opt) => opt.category !== "model" && !isReasoningOption(opt)
		);

		const modelSection = buildModelSection({
			acpModelConfigOption,
			acpOptionValues,
			acpSessionConfig,
			activeAgentIsAcp,
			effectiveAcpModel,
			engineModel,
			hasDedicatedAcpModels,
			modelOptions,
			onAcpModelChange: handleAcpModelChange,
			onAcpOptionChange: handleAcpOptionChange,
			onEngineModelChange,
		});

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
			acpMode: hideAcpModesPicker ? null : effectiveAcpMode,
			acpModel: effectiveAcpModel,
			acpOptionValues,
		};
	}, [
		agentId,
		agents,
		acpSessionConfig,
		acpMode,
		acpModel,
		acpOptionValues,
		modelOptions,
		engineModel,
		onEngineModelChange,
		handleAcpModeChange,
		handleAcpModelChange,
		handleAcpOptionChange,
	]);
}
