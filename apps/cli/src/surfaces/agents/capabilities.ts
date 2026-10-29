import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { fetchMcpTools, type McpTool } from "@ryuhq/core-client/mcp";
import { skillInstalledResponse } from "@ryuhq/core-client/skills";
import { tf } from "../../i18n/translate.ts";

export const NO_AGENT_CAPABILITIES = "__ryu_none__";
export const ALL_MCP_TOOLS = "*";

export interface AgentSkillOption {
	description: string | null;
	enabled: boolean;
	id: string;
	name: string;
}

export async function fetchAgentSkills(
	target: ApiTarget
): Promise<AgentSkillOption[]> {
	const response = await request(
		target,
		"/api/skills",
		{},
		skillInstalledResponse
	);
	return (response.skills ?? []).map((skill) => ({
		description: skill.description ?? null,
		enabled: skill.enabled ?? false,
		id: skill.id,
		name: skill.name ?? skill.id,
	}));
}

export interface ToolPickerRow {
	description: string | null;
	id: string;
	label: string;
	tool: McpTool | null;
}

export interface SkillPickerRow {
	description: string | null;
	enabled: boolean;
	id: string;
	label: string;
	missing: boolean;
}

function isNoCapabilities(values: readonly string[]): boolean {
	return values.includes(NO_AGENT_CAPABILITIES);
}

function isAllTools(values: readonly string[]): boolean {
	// Core keeps an empty tool list as the legacy unrestricted value. `*` is the
	// explicit live-all marker; the private sentinel is the explicit no-tools
	// value. Keep all three states distinct when hydrating and saving a draft.
	return values.length === 0 || values.includes(ALL_MCP_TOOLS);
}

function toolMatchesAllowlistEntry(tool: McpTool, entry: string): boolean {
	return entry === tool.id || entry === tool.name || entry === tool.server;
}

export function selectedToolIds(
	allowlist: readonly string[],
	tools: readonly McpTool[]
): Set<string> {
	if (isNoCapabilities(allowlist)) {
		return new Set();
	}
	if (isAllTools(allowlist)) {
		return new Set(tools.map((tool) => tool.id));
	}
	const selected = new Set<string>();
	for (const tool of tools) {
		if (allowlist.some((entry) => toolMatchesAllowlistEntry(tool, entry))) {
			selected.add(tool.id);
		}
	}
	for (const entry of allowlist) {
		if (!tools.some((tool) => toolMatchesAllowlistEntry(tool, entry))) {
			selected.add(entry);
		}
	}
	return selected;
}

export function toolPickerRows(
	allowlist: readonly string[],
	tools: readonly McpTool[]
): ToolPickerRow[] {
	const rows: ToolPickerRow[] = tools.map((tool) => ({
		description: tool.description,
		id: tool.id,
		label: `${tool.name} · ${tool.server}`,
		tool,
	}));
	if (isNoCapabilities(allowlist) || isAllTools(allowlist)) {
		return rows;
	}
	for (const entry of allowlist) {
		if (!tools.some((tool) => toolMatchesAllowlistEntry(tool, entry))) {
			rows.push({
				description: "Saved grant is not in the current MCP tool catalog.",
				id: entry,
				label: tf("{entry} · saved, unavailable", { entry }),
				tool: null,
			});
		}
	}
	return rows;
}

export function encodeToolSelection(
	selected: ReadonlySet<string>,
	tools: readonly McpTool[]
): string[] {
	if (selected.size === 0) {
		return [NO_AGENT_CAPABILITIES];
	}
	const values: string[] = [];
	for (const tool of tools) {
		if (selected.has(tool.id)) {
			values.push(tool.id);
		}
	}
	for (const id of selected) {
		if (!tools.some((tool) => tool.id === id)) {
			values.push(id);
		}
	}
	// Saving a picker selection writes the concrete MCP ids that were visible.
	// It never encodes a subset of the MCP catalog as `*`, which Core interprets
	// as access to every current and future tool across all providers.
	return values;
}

export function selectedSkillIds(
	allowlist: readonly string[],
	skills: readonly AgentSkillOption[]
): Set<string> {
	if (isNoCapabilities(allowlist)) {
		return new Set();
	}
	if (allowlist.length === 0) {
		return new Set(
			skills.filter((skill) => skill.enabled).map((skill) => skill.id)
		);
	}
	return new Set(allowlist);
}

export function skillPickerRows(
	allowlist: readonly string[],
	skills: readonly AgentSkillOption[]
): SkillPickerRow[] {
	const rows: SkillPickerRow[] = skills.map((skill) => ({
		description: skill.description,
		enabled: skill.enabled,
		id: skill.id,
		label: `${skill.name} · ${skill.enabled ? "enabled" : "disabled"}`,
		missing: false,
	}));
	if (isNoCapabilities(allowlist)) {
		return rows;
	}
	for (const entry of allowlist) {
		if (!skills.some((skill) => skill.id === entry)) {
			rows.push({
				description: "Saved grant is not in the current installed-skill list.",
				enabled: false,
				id: entry,
				label: tf("{entry} · saved, unavailable", { entry }),
				missing: true,
			});
		}
	}
	return rows;
}

export function encodeSkillSelection(
	selected: ReadonlySet<string>,
	skills: readonly AgentSkillOption[]
): string[] {
	if (selected.size === 0) {
		return [NO_AGENT_CAPABILITIES];
	}
	const enabledIds = skills
		.filter((skill) => skill.enabled)
		.map((skill) => skill.id);
	if (
		selected.size === enabledIds.length &&
		enabledIds.every((id) => selected.has(id))
	) {
		// Core defines an empty skill list as all currently and subsequently
		// enabled skills. Preserve that explicit scope when every enabled row is on.
		return [];
	}
	const values: string[] = [];
	for (const skill of skills) {
		if (selected.has(skill.id)) {
			values.push(skill.id);
		}
	}
	for (const id of selected) {
		if (!skills.some((skill) => skill.id === id)) {
			values.push(id);
		}
	}
	return values;
}

export async function fetchAgentTools(target: ApiTarget): Promise<McpTool[]> {
	return fetchMcpTools(target);
}
