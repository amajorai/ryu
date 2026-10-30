// apps/desktop/src/components/agents/AcpAgentSettingsPanel-draft.ts
//
// Draft shape and config-advertisement helpers for AcpAgentSettingsPanel.

import type {
	AcpConfig,
	AcpConfigOption,
	AcpConfigSelectOption,
} from "@/src/lib/api/acp.ts";
import {
	type AcpAgentSettings,
	formatEnvText,
	parseArgsText,
	parseEnvText,
} from "@/src/lib/api/acp-agent-settings.ts";

export interface Choice {
	id: string;
	name: string;
}

export interface Draft {
	allowedModels: string[];
	argsText: string;
	autoCompact: boolean | null;
	autoCompactTokens: string;
	cliPath: string;
	command: string;
	configDir: string;
	defaultConfigOptions: Record<string, string>;
	defaultMode: string;
	defaultModel: string;
	envText: string;
}

export function toDraft(settings: AcpAgentSettings): Draft {
	return {
		allowedModels: settings.allowedModels ?? [],
		argsText: (settings.args ?? []).join("\n"),
		autoCompact: settings.autoCompact ?? null,
		autoCompactTokens: settings.autoCompactTokens
			? String(settings.autoCompactTokens)
			: "",
		cliPath: settings.cliPath ?? "",
		command: settings.command ?? "",
		configDir: settings.configDir ?? "",
		defaultConfigOptions: settings.defaultConfigOptions ?? {},
		defaultMode: settings.defaultMode ?? "",
		defaultModel: settings.defaultModel ?? "",
		envText: formatEnvText(settings.env),
	};
}

export function fromDraft(draft: Draft): AcpAgentSettings {
	const tokens = Number(draft.autoCompactTokens);
	return {
		allowedModels: draft.allowedModels,
		args: parseArgsText(draft.argsText),
		autoCompact: draft.autoCompact,
		autoCompactTokens: Number.isInteger(tokens) && tokens > 0 ? tokens : null,
		cliPath: draft.cliPath,
		command: draft.command,
		configDir: draft.configDir,
		defaultConfigOptions: draft.defaultConfigOptions,
		defaultMode: draft.defaultMode,
		defaultModel: draft.defaultModel,
		env: parseEnvText(draft.envText),
	};
}

/** Absolute on POSIX (`/…`) or Windows (`C:\…`, `C:/…`, `\\server\…`). */
export function isAbsolutePath(path: string): boolean {
	return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
}

export function flatOptions(option: AcpConfigOption): AcpConfigSelectOption[] {
	return (option.options ?? []).flatMap((entry) =>
		"options" in entry ? entry.options : [entry]
	);
}

/** The model option an agent exposes as a session config option, if any. */
export function modelConfigOption(
	config: AcpConfig | null
): AcpConfigOption | null {
	return (
		config?.configOptions?.find(
			(option) => option.category === "model" && option.type === "select"
		) ?? null
	);
}

export function modelChoices(config: AcpConfig | null): Choice[] {
	const listed = config?.models?.availableModels ?? [];
	if (listed.length > 0) {
		return listed.map((model) => ({ id: model.modelId, name: model.name }));
	}
	const option = modelConfigOption(config);
	return option
		? flatOptions(option).map((value) => ({
				id: value.value,
				name: value.name,
			}))
		: [];
}

/** Non-model, non-mode select options the user can default (e.g. effort). */
export function defaultableOptions(
	config: AcpConfig | null
): AcpConfigOption[] {
	return (config?.configOptions ?? []).filter(
		(option) =>
			option.type === "select" &&
			option.category !== "model" &&
			option.category !== "mode"
	);
}
