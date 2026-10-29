import { z } from "zod";
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
	return raw.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

const acpDescriptionSchema = z.string().nullable().optional();
const acpModeSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: acpDescriptionSchema,
});
const acpModelSchema = z.object({
	modelId: z.string(),
	name: z.string(),
	description: acpDescriptionSchema,
});
const acpSelectOptionSchema = z.object({
	value: z.string(),
	name: z.string(),
	description: acpDescriptionSchema,
});
const acpConfigOptionSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: acpDescriptionSchema,
	category: acpDescriptionSchema,
	currentValue: z.string().optional(),
	type: z.string().optional(),
	options: z
		.union([
			z.array(acpSelectOptionSchema),
			z.array(z.object({ options: z.array(acpSelectOptionSchema) })),
		])
		.optional(),
});
/** Normalize missing ACP collections before exposing the session configuration. */
export const acpConfigSchema = z.object({
	configOptions: z.array(acpConfigOptionSchema).nullable().catch(null),
	models: z
		.object({
			availableModels: z.array(acpModelSchema),
			currentModelId: z.string(),
		})
		.nullable()
		.catch(null),
	modes: z
		.object({
			availableModes: z.array(acpModeSchema),
			currentModeId: z.string(),
		})
		.nullable()
		.catch(null),
});
