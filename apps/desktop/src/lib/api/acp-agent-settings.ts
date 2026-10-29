import {
	isNativeBoolean,
	isNativeNumber,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
// apps/desktop/src/lib/api/acp-agent-settings.ts
//
// Per-agent ACP launch and session settings. Core owns the semantics and the
// storage (`apps/core/src/acp_agent_settings.rs`): it applies these to the
// agent's spawn declaration and to each turn's session defaults, never letting a
// user value replace environment it declares itself (Gateway routing, managed
// homes). The stored map is sealed and refused by the generic preference
// routes; read and write one agent at a time through
// `/api/agents/:id/acp-settings`, which requires `agent.edit` and updates only
// that agent's entry atomically.
//
// The field names below are the camelCase wire contract Core deserializes;
// renaming one silently drops that setting.

import { z } from "zod";

import type { AcpAgentSettingsSupport, AcpConfig } from "./acp.ts";
import { type ApiTarget, request } from "./client.ts";

const mcpCapabilitiesResponseSchema = z.looseObject({
	http: z.boolean().optional(),
	sse: z.boolean().optional(),
});
const promptCapabilitiesResponseSchema = z.looseObject({
	audio: z.boolean().optional(),
	embeddedContext: z.boolean().optional(),
	image: z.boolean().optional(),
});
const sessionCapabilitiesResponseSchema = z.looseObject({
	close: z.boolean().optional(),
	list: z.boolean().optional(),
	resume: z.boolean().optional(),
});
const agentCapabilitiesResponseSchema = z.looseObject({
	loadSession: z.boolean().optional(),
	mcpCapabilities: mcpCapabilitiesResponseSchema.optional(),
	promptCapabilities: promptCapabilitiesResponseSchema.optional(),
	sessionCapabilities: sessionCapabilitiesResponseSchema.optional(),
});
const authMethodsResponseSchema = z.looseObject({
	description: z.union([z.null(), z.string()]).optional(),
	id: z.string(),
	name: z.string(),
	type: z.string().optional(),
});
const optionsResponseSchema = z.looseObject({
	description: z.union([z.null(), z.string()]).optional(),
	name: z.string(),
	value: z.string(),
});
const optionsResponseSchema2 = z.looseObject({
	options: z.array(optionsResponseSchema),
});
const configOptionsResponseSchema = z.looseObject({
	category: z.union([z.null(), z.string()]).optional(),
	currentValue: z
		.union([z.string(), z.literal(false), z.literal(true)])
		.optional(),
	description: z.union([z.null(), z.string()]).optional(),
	id: z.string(),
	name: z.string(),
	options: z
		.union([z.array(optionsResponseSchema), z.array(optionsResponseSchema2)])
		.optional(),
	type: z.string().optional(),
});
const availableModelsResponseSchema = z.looseObject({
	description: z.union([z.null(), z.string()]).optional(),
	modelId: z.string(),
	name: z.string(),
});
const modelsResponseSchema = z.looseObject({
	availableModels: z.array(availableModelsResponseSchema),
	currentModelId: z.string(),
});
const availableModesResponseSchema = z.looseObject({
	description: z.union([z.null(), z.string()]).optional(),
	id: z.string(),
	name: z.string(),
});
const modesResponseSchema = z.looseObject({
	availableModes: z.array(availableModesResponseSchema),
	currentModeId: z.string(),
});
const fetchUnfilteredAcpConfigResponseSchema = z.looseObject({
	agentCapabilities: z
		.union([z.null(), agentCapabilitiesResponseSchema])
		.optional(),
	authenticationRequired: z.boolean().optional(),
	authMethods: z
		.union([z.null(), z.array(authMethodsResponseSchema)])
		.optional(),
	configOptions: z.union([z.null(), z.array(configOptionsResponseSchema)]),
	models: z.union([z.null(), modelsResponseSchema]),
	modes: z.union([z.null(), modesResponseSchema]),
});

export interface AcpAgentSettings {
	allowedModels?: string[];
	args?: string[];
	autoCompact?: boolean | null;
	autoCompactTokens?: number | null;
	cliPath?: string | null;
	command?: string | null;
	configDir?: string | null;
	defaultConfigOptions?: Record<string, string>;
	defaultMode?: string | null;
	defaultModel?: string | null;
	env?: Record<string, string>;
}

/** Core's view of one agent's settings, for the editor. */
export interface AcpAgentSettingsView {
	agentId: string;
	/**
	 * Set when `settings` are inherited from the agent's engine or registry
	 * entry rather than stored for this agent; saving stores them for it.
	 */
	inheritedFrom: string | null;
	settings: AcpAgentSettings;
	support: AcpAgentSettingsSupport;
}

const optionalTextSchema = z.string().optional().catch(undefined);
const stringListSchema = z
	.array(z.unknown())
	.transform((entries) =>
		entries.flatMap((entry) => {
			const parsed = z.string().safeParse(entry);
			return parsed.success ? [parsed.data] : [];
		})
	)
	.optional()
	.catch(undefined);
const stringMapSchema = z
	.record(z.string(), z.unknown())
	.transform((entries) =>
		Object.fromEntries(
			Object.entries(entries).flatMap(([key, value]) => {
				const parsed = z.string().safeParse(value);
				return parsed.success ? [[key, parsed.data]] : [];
			})
		)
	)
	.optional()
	.catch(undefined);
const acpAgentSettingsSchema = z
	.object({
		allowedModels: stringListSchema,
		args: stringListSchema,
		autoCompact: z.boolean().optional().catch(undefined),
		autoCompactTokens: z.number().int().positive().optional().catch(undefined),
		cliPath: optionalTextSchema,
		command: optionalTextSchema,
		configDir: optionalTextSchema,
		defaultConfigOptions: stringMapSchema,
		defaultMode: optionalTextSchema,
		defaultModel: optionalTextSchema,
		env: stringMapSchema,
	})
	.catch({});

/** Drop malformed persisted fields while retaining valid settings for editing. */
export const parseAcpAgentSettings = acpAgentSettingsSchema.parse;

const supportFlagSchema = z
	.unknown()
	.optional()
	.transform((value) => value === true);
const supportSchema = z
	.object({
		autoCompactToggle: supportFlagSchema,
		autoCompactTokens: supportFlagSchema,
		cliPath: supportFlagSchema,
		configDir: supportFlagSchema,
		configDirManaged: supportFlagSchema,
	})
	.catch({
		autoCompactToggle: false,
		autoCompactTokens: false,
		cliPath: false,
		configDir: false,
		configDirManaged: false,
	});
const acpAgentSettingsViewSchema = z
	.object({
		agentId: optionalTextSchema,
		inheritedFrom: optionalTextSchema,
		settings: acpAgentSettingsSchema,
		support: supportSchema,
	})
	.catch({ settings: {}, support: supportSchema.parse(null) });

export const parseAcpAgentSettingsView: (
	value: Parameters<typeof acpAgentSettingsViewSchema.parse>[0],
	agentId: string
) => AcpAgentSettingsView = (value, agentId) => {
	const parsed = acpAgentSettingsViewSchema.parse(value);
	return {
		agentId: parsed.agentId ?? agentId,
		inheritedFrom: parsed.inheritedFrom ?? null,
		settings: parsed.settings,
		support: parsed.support,
	};
};

/** Drop blank fields so an untouched form stores nothing for the agent. */
export function compactAcpAgentSettings(
	settings: AcpAgentSettings
): AcpAgentSettings {
	const out: AcpAgentSettings = {};
	const text = (value: string | null | undefined) => value?.trim() || undefined;
	const command = text(settings.command);
	if (command) {
		out.command = command;
	}
	const configDir = text(settings.configDir);
	if (configDir) {
		out.configDir = configDir;
	}
	const cliPath = text(settings.cliPath);
	if (cliPath) {
		out.cliPath = cliPath;
	}
	const defaultModel = text(settings.defaultModel);
	if (defaultModel) {
		out.defaultModel = defaultModel;
	}
	const defaultMode = text(settings.defaultMode);
	if (defaultMode) {
		out.defaultMode = defaultMode;
	}
	if (isNativeBoolean(settings.autoCompact)) {
		out.autoCompact = settings.autoCompact;
	}
	if (
		isNativeNumber(settings.autoCompactTokens) &&
		Number.isInteger(settings.autoCompactTokens) &&
		settings.autoCompactTokens > 0
	) {
		out.autoCompactTokens = settings.autoCompactTokens;
	}
	const args = (settings.args ?? []).filter((arg) => arg.length > 0);
	if (args.length > 0) {
		out.args = args;
	}
	const models = (settings.allowedModels ?? [])
		.map((model) => model.trim())
		.filter(Boolean);
	if (models.length > 0) {
		out.allowedModels = models;
	}
	const env = Object.fromEntries(
		Object.entries(settings.env ?? {}).filter(([name]) => name.trim())
	);
	if (Object.keys(env).length > 0) {
		out.env = env;
	}
	const options = Object.fromEntries(
		Object.entries(settings.defaultConfigOptions ?? {}).filter(
			([id, value]) => id && value
		)
	);
	if (Object.keys(options).length > 0) {
		out.defaultConfigOptions = options;
	}
	return out;
}

function settingsPath(agentId: string): string {
	return `/api/agents/${encodeURIComponent(agentId)}/acp-settings`;
}

export async function getAcpAgentSettings(
	target: ApiTarget,
	agentId: string
): Promise<AcpAgentSettingsView> {
	const raw = await request(
		target,
		settingsPath(agentId),
		undefined,
		gatewayJsonValueSchema
	);
	return parseAcpAgentSettingsView(raw, agentId);
}

/** Replace this agent's own entry; an empty entry removes it. */
export async function setAcpAgentSettings(
	target: ApiTarget,
	agentId: string,
	settings: AcpAgentSettings
): Promise<AcpAgentSettingsView> {
	const raw = await request(
		target,
		settingsPath(agentId),
		{
			method: "PUT",
			body: compactAcpAgentSettings(settings),
		},
		gatewayJsonValueSchema
	);
	return parseAcpAgentSettingsView(raw, agentId);
}

/**
 * The agent's full advertisement, ignoring its saved model allowlist and
 * defaults, so the editor can re-enable a model it excluded.
 */
export async function fetchUnfilteredAcpConfig(
	target: ApiTarget,
	agentId: string
): Promise<AcpConfig> {
	return await request(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/acp-config?allModels=true`,
		undefined,
		fetchUnfilteredAcpConfigResponseSchema
	);
}

/** Split a launch-arguments field: one argument per line, verbatim. */
export function parseArgsText(text: string): string[] {
	return text.split("\n").filter((line) => line.length > 0);
}

/** Parse `NAME=value` lines; lines without `=` or with an invalid name are dropped. */
export function parseEnvText(text: string) {
	const env: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const index = line.indexOf("=");
		if (index <= 0) {
			continue;
		}
		const name = line.slice(0, index).trim();
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			env[name] = line.slice(index + 1);
		}
	}
	return env;
}

export function formatEnvText(env: Record<string, string> | undefined): string {
	return Object.entries(env ?? {})
		.map(([name, value]) => `${name}=${value}`)
		.join("\n");
}
