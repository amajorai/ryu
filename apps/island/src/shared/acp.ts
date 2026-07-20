export interface AcpSessionMode {
	description?: string | null;
	id: string;
	name: string;
}

export interface AcpSessionModeState {
	availableModes: AcpSessionMode[];
	currentModeId: string;
}

export interface AcpModelInfo {
	description?: string | null;
	modelId: string;
	name: string;
}

export interface AcpSessionModelState {
	availableModels: AcpModelInfo[];
	currentModelId: string;
}

export interface AcpConfigSelectOption {
	description?: string | null;
	name: string;
	value: string;
}

export interface AcpConfigOption {
	category?: string | null;
	currentValue?: string;
	description?: string | null;
	id: string;
	name: string;
	options?: AcpConfigSelectOption[] | { options: AcpConfigSelectOption[] }[];
	type?: string;
}

export interface AcpConfig {
	configOptions: AcpConfigOption[] | null;
	models: AcpSessionModelState | null;
	modes: AcpSessionModeState | null;
}

export function flattenConfigOptions(
	option: AcpConfigOption
): AcpConfigSelectOption[] {
	const raw = option.options ?? [];
	if (raw.length === 0) {
		return [];
	}
	if ("options" in raw[0]) {
		return (raw as { options: AcpConfigSelectOption[] }[]).flatMap(
			(g) => g.options
		);
	}
	return raw as AcpConfigSelectOption[];
}
