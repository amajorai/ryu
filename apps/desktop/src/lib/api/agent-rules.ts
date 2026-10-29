import { z } from "zod";

import type { ApiTarget } from "./client.ts";
import { request } from "./client.ts";
import { getPreference, setPreference } from "./preferences.ts";

export type RuleApplyMode = "auto" | "always" | "manual";

export interface AgentRule {
	enabled: boolean;
	id: string;
	mode: RuleApplyMode;
	text: string;
}

export interface AgentRulesConfig {
	applyMode: RuleApplyMode;
	autoInject: boolean;
	enabled: boolean;
	rules: AgentRule[];
	turnsPerPlan: number;
}

export interface DiscoveredProjectRule {
	applyMode?: string;
	content?: string;
	description?: string;
	enabled?: boolean;
	globs?: string[];
	id?: string;
	name?: string;
	path: string;
	provider: string;
	scope?: string;
}

const optionalRuleStringSchema = z.string().optional().catch(undefined);
const discoveredProjectRuleSchema = z.object({
	apply_mode: optionalRuleStringSchema,
	content: optionalRuleStringSchema,
	description: optionalRuleStringSchema,
	enabled: z.boolean().optional().catch(undefined),
	globs: z
		.array(z.string().optional().catch(undefined))
		.optional()
		.catch(undefined),
	id: optionalRuleStringSchema,
	mode: optionalRuleStringSchema,
	name: optionalRuleStringSchema,
	path: z.string(),
	provider: z.string().min(1).catch("project"),
	scope: optionalRuleStringSchema,
});
const discoverySchema = z.object({
	cwd: z.string().nullable().catch(null),
	rules: z
		.array(discoveredProjectRuleSchema.optional().catch(undefined))
		.catch([]),
});
type DiscoveryWire = z.input<typeof discoverySchema>;
interface DiscoveredProjectRules {
	cwd: string | null;
	rules: DiscoveredProjectRule[];
}
interface LoadedAgentRules {
	config: AgentRulesConfig;
	migrated: boolean;
}

export const DEFAULT_AGENT_RULES_CONFIG: AgentRulesConfig = {
	applyMode: "auto",
	autoInject: true,
	enabled: true,
	rules: [],
	turnsPerPlan: 0,
};

const ruleModeSchema = z.enum(["auto", "always", "manual"]).catch("auto");
const ruleRecordSchema = z.object({
	text: optionalRuleStringSchema,
	content: optionalRuleStringSchema,
	rule: optionalRuleStringSchema,
	enabled: z.boolean().catch(true),
	id: z.string().min(1).optional().catch(undefined),
	mode: ruleModeSchema,
});
const storedRuleSchema = z.union([z.string(), ruleRecordSchema]).catch("");
const agentRulesConfigSchema = z.object({
	applyMode: ruleModeSchema,
	autoInject: z.boolean().catch(true),
	enabled: z.boolean().catch(true),
	rules: z.array(storedRuleSchema).catch([]),
	turnsPerPlan: z.number().catch(0),
});

/** Convert the old positional string list to the durable rule records. */
export function legacyRulesToConfig(legacyRules: string[]): AgentRulesConfig {
	return {
		...DEFAULT_AGENT_RULES_CONFIG,
		rules: legacyRules
			.map((text, index) => ({
				enabled: true,
				id: `legacy-${index}`,
				mode: "auto" as const,
				text: text.trim(),
			}))
			.filter((rule) => rule.text.length > 0),
	};
}

/** Parse and sanitize a preference without allowing corrupt data to break the editor. */
export function parseAgentRulesConfig(
	raw: string | null,
	legacyRules: string[] = []
): AgentRulesConfig {
	if (!raw?.trim()) {
		return legacyRulesToConfig(legacyRules);
	}
	try {
		const parsed = agentRulesConfigSchema.parse(JSON.parse(raw));
		const rules = parsed.rules
			.map((value, index) => {
				const stringValue = z.string().safeParse(value);
				if (stringValue.success) {
					return {
						enabled: true,
						id: `rule-${index}`,
						mode: "auto" as const,
						text: stringValue.data.trim(),
					};
				}
				const record = ruleRecordSchema.parse(value);
				return {
					enabled: record.enabled,
					id: record.id ?? `rule-${index}`,
					mode: record.mode,
					text: (record.text ?? record.content ?? record.rule ?? "").trim(),
				};
			})
			.filter((rule) => rule.text.length > 0);
		return {
			...parsed,
			rules,
			turnsPerPlan: Math.max(0, Math.floor(parsed.turnsPerPlan)),
		};
	} catch {
		return legacyRulesToConfig(legacyRules);
	}
}

export async function fetchDiscoveredProjectRules(
	target: ApiTarget,
	cwd?: string | null
): Promise<DiscoveredProjectRules> {
	try {
		const query = cwd?.trim() ? `?cwd=${encodeURIComponent(cwd)}` : "";
		const data = await request<DiscoveryWire>(
			target,
			`/api/rules/discover${query}`,
			undefined,
			discoverySchema
		);
		const parsed = discoverySchema.parse(data);
		return {
			cwd: parsed.cwd,
			rules: parsed.rules
				.filter((rule) => rule !== undefined)
				.map((rule) => ({
					content: rule.content,
					applyMode: rule.apply_mode ?? rule.mode,
					description: rule.description,
					enabled: rule.enabled,
					globs: rule.globs?.filter((glob) => glob !== undefined),
					id: rule.id,
					name: rule.name,
					path: rule.path,
					provider: rule.provider,
					scope: rule.scope,
				})),
		};
	} catch {
		return { cwd: null, rules: [] };
	}
}

export async function loadAgentRulesConfig(
	target: ApiTarget,
	prefKey: string,
	legacyRules: string[]
): Promise<LoadedAgentRules> {
	const raw = await getPreference(target, prefKey);
	return {
		config: parseAgentRulesConfig(raw, legacyRules),
		migrated:
			!raw?.trim() && legacyRules.some((rule) => rule.trim().length > 0),
	};
}

export function saveAgentRulesConfig(
	target: ApiTarget,
	prefKey: string,
	config: AgentRulesConfig
): Promise<boolean> {
	return setPreference(target, prefKey, JSON.stringify(config));
}
