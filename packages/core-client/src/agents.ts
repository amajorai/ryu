// apps/desktop/src/lib/api/agents.ts
//
// Typed client for Core's agent CRUD endpoints (`/api/agents`). An agent is a
// saved name + system prompt bound to an engine, plus an allowlist of tools.
// Consumed by the agents pages via the `useAgents` hook.
//
// IMPORTANT: Core returns two different shapes on this resource:
//   - GET /api/agents (list) → `AgentInfo`: a lightweight summary that unions
//     the in-code registry built-ins (rich install info, `transport`/`engine`
//     set) with custom store rows (`engine`/`transport` omitted). It carries no
//     `tools`, no `built_in`, no `updated_at`.
//   - GET/POST/PUT /api/agents/:id (single) → `AgentRecord`: the full persisted
//     row, including `tools`, `built_in`, and `updated_at`.
// We therefore keep two mappers. Built-in detection on the list is derived from
// the presence of `transport` (only registry built-ins serialize it).

import { type ApiTarget, request } from "./client.ts";
import type { SamplingConfig } from "./inference.ts";

/**
 * An agent as it appears in the list. Built-ins carry `transport`/`engine` from
 * the in-code registry; custom agents omit them (the list handler does not join
 * the store row's engine). For the agent's tools and a reliable engine binding,
 * fetch the single record via {@link fetchAgent}.
 */
export interface AgentSummary {
	/** Derived: only the seeded registry built-ins serialize `transport`. */
	builtIn: boolean;
	createdAt: string | null;
	description: string | null;
	/** Engine binding as reported by the list endpoint. Stripped for built-ins
	 * (e.g. "claude") and null for custom agents — use {@link fetchAgent} for the
	 * canonical, engine-picker-matching id (e.g. "acp:claude"). */
	engine: string | null;
	id: string;
	installed: boolean | null;
	/** Hint shown to users on how to install/run this agent (e.g. "via npx"). */
	installHint: string | null;
	/** When true, the agent is locked and cannot be edited via the API. */
	locked: boolean;
	model: string | null;
	name: string;
	systemPrompt: string | null;
	/** Transport backing the agent as Core reports it: `"acp"` (subprocess) or
	 * `"openai_compat"` (gateway-routed local server). Null for custom store rows
	 * that don't serialize it. Lets clients decide gateway-need without re-deriving
	 * it from the id/engine. */
	transport: string | null;
	/** Semver version string. Present for custom agents; null for registry built-ins. */
	version: string | null;
}

/** The full persisted agent record returned by GET/POST/PUT `/api/agents/:id`. */
export interface Agent {
	builtIn: boolean;
	/**
	 * Whether this agent may mint new custom agents. `null` means "use the
	 * default", which is **off** (agent creation is a privileged, opt-in capability).
	 */
	canCreateAgents: boolean | null;
	/** Composio action names this agent may call (gateway-route only). */
	composioActions: string[];
	createdAt: string | null;
	description: string | null;
	engine: string | null;
	id: string;
	/** Per-agent sampling defaults (advanced inference settings). */
	inference: SamplingConfig | null;
	/** When true, the agent is locked and cannot be edited via the API. */
	locked: boolean;
	model: string | null;
	name: string;
	/**
	 * Whether this agent may discover peers and delegate work to them. `null`
	 * means "use the default", which is **on** (delegation is default-available).
	 */
	orchestrator: boolean | null;
	/** Skill id allowlist. Empty = all enabled skills; non-empty = only these. */
	skills: string[];
	systemPrompt: string | null;
	tools: string[];
	updatedAt: string | null;
	/** Semver version string (e.g. "1.0.0"). */
	version: string;
}

/** A portable agent template for export/import via `GET/POST /api/agents/:id/export` and `POST /api/agents/import`. */
export interface AgentTemplate {
	agent_config: {
		description: string | null;
		system_prompt: string | null;
		tools: string[];
		engine: string | null;
		model: string | null;
	};
	kind: string;
	name: string;
	version: string;
}

/** Persona fields that travel with an agent save. */
export interface AgentPersona {
	/** Display name the agent uses when introducing itself (optional). */
	display_name: string | null;
	/** Tone string: "neutral" | "professional" | "friendly" | "pirate" | any custom string. Null = default. */
	tone: string | null;
}

/** Fields the UI sends when creating or updating an agent. */
export interface AgentInput {
	/** Toggle agent-creation. Omit to leave unchanged; null clears to the default (off). */
	canCreateAgents?: boolean | null;
	/** Composio action names to bind to this agent (gateway-route only). */
	composioActions?: string[];
	description: string | null;
	engine: string | null;
	/** Optional per-agent sampling defaults. Serialised into the PUT body. */
	inference?: SamplingConfig;
	name: string;
	/** Toggle delegation/discovery. Omit to leave unchanged; null clears to the default (on). */
	orchestrator?: boolean | null;
	/** Optional persona bundle. Serialised into the PUT body; Core ignores unknown fields gracefully. */
	persona?: AgentPersona;
	/** Skill id allowlist to bind to this agent. Empty/omitted = all enabled skills. */
	skills?: string[];
	systemPrompt: string | null;
	tools: string[];
	/** Semver version string to store on save. When omitted on create, Core defaults to "1.0.0". */
	version?: string;
}

/**
 * Increment the patch component of a semver string (e.g. "1.0.0" → "1.0.1").
 * Falls back to the original string when the format is unrecognised so a
 * malformed value never causes the save to fail.
 */
export function bumpPatchVersion(version: string): string {
	const [major, minor, patchStr] = version.split(".");
	if (patchStr === undefined || minor === undefined || major === undefined) {
		return version;
	}
	const patch = Number.parseInt(patchStr, 10);
	if (Number.isNaN(patch)) {
		return version;
	}
	return `${major}.${minor}.${patch + 1}`;
}

interface AgentSummaryWire {
	created_at?: string | null;
	description?: string | null;
	engine?: string | null;
	id: string;
	install_hint?: string | null;
	installed?: boolean | null;
	locked?: boolean | null;
	model?: string | null;
	name: string;
	system_prompt?: string | null;
	transport?: string | null;
	version?: string | null;
}

interface AgentRecordWire {
	built_in?: boolean;
	can_create_agents?: boolean | null;
	composio_actions?: string[];
	created_at?: string | null;
	description?: string | null;
	engine?: string | null;
	id: string;
	inference?: SamplingConfig | null;
	locked?: boolean;
	model?: string | null;
	name: string;
	orchestrator?: boolean | null;
	skills?: string[];
	system_prompt?: string | null;
	tools?: string[];
	updated_at?: string | null;
	version?: string;
}

function toSummary(a: AgentSummaryWire): AgentSummary {
	return {
		id: a.id,
		name: a.name,
		description: a.description ?? null,
		systemPrompt: a.system_prompt ?? null,
		engine: a.engine ?? null,
		model: a.model ?? null,
		installed: a.installed ?? null,
		installHint: a.install_hint ?? null,
		// Only registry built-ins serialize `transport`; custom store rows omit it.
		builtIn: a.transport != null,
		transport: a.transport ?? null,
		createdAt: a.created_at ?? null,
		version: a.version ?? null,
		locked: a.locked ?? false,
	};
}

function toAgent(a: AgentRecordWire): Agent {
	return {
		id: a.id,
		name: a.name,
		description: a.description ?? null,
		systemPrompt: a.system_prompt ?? null,
		engine: a.engine ?? null,
		model: a.model ?? null,
		tools: a.tools ?? [],
		composioActions: a.composio_actions ?? [],
		skills: a.skills ?? [],
		inference: a.inference ?? null,
		builtIn: a.built_in ?? false,
		createdAt: a.created_at ?? null,
		updatedAt: a.updated_at ?? null,
		version: a.version ?? "1.0.0",
		locked: a.locked ?? false,
		// `null` is meaningful: it means "use the code default" (orchestrator on,
		// creation off). Preserve it rather than collapsing to a boolean here.
		orchestrator: a.orchestrator ?? null,
		canCreateAgents: a.can_create_agents ?? null,
	};
}

function toAgentBody(input: AgentInput): Record<string, unknown> {
	const body: Record<string, unknown> = {
		name: input.name,
		description: input.description,
		system_prompt: input.systemPrompt,
		engine: input.engine,
		tools: input.tools,
	};
	if (input.version !== undefined) {
		body.version = input.version;
	}
	if (input.composioActions !== undefined) {
		body.composio_actions = input.composioActions;
	}
	if (input.skills !== undefined) {
		body.skills = input.skills;
	}
	if (input.persona !== undefined) {
		body.persona = input.persona;
	}
	if (input.inference !== undefined) {
		body.inference = input.inference;
	}
	if (input.orchestrator !== undefined) {
		body.orchestrator = input.orchestrator;
	}
	if (input.canCreateAgents !== undefined) {
		body.can_create_agents = input.canCreateAgents;
	}
	return body;
}

export async function fetchAgents(target: ApiTarget): Promise<AgentSummary[]> {
	const json = await request<{ agents?: AgentSummaryWire[] }>(
		target,
		"/api/agents"
	);
	return (json.agents ?? []).map(toSummary);
}

/**
 * An installable agent in the catalog (`GET /api/agents/catalog`). Carries two
 * independent flags: `detected` (the agent's CLI binary is on PATH, or null when
 * the agent has no detectable binary) and `added` (the agent is in the installed
 * set and shows in the picker).
 */
export interface AgentCatalogEntry {
	/** True if the agent is in the installed set (shows in the picker). */
	added: boolean;
	description: string | null;
	/** True if the agent's CLI binary is on PATH; null when not detectable. */
	detected: boolean | null;
	engine: string | null;
	gatewayBypass: boolean;
	id: string;
	installHint: string | null;
	name: string;
	recommended: boolean;
	transport: string | null;
}

interface AgentCatalogEntryWire {
	added?: boolean | null;
	description?: string | null;
	detected?: boolean | null;
	engine?: string | null;
	gateway_bypass?: boolean | null;
	id: string;
	install_hint?: string | null;
	name: string;
	recommended?: boolean | null;
	transport?: string | null;
}

function toCatalogEntry(a: AgentCatalogEntryWire): AgentCatalogEntry {
	return {
		id: a.id,
		name: a.name,
		description: a.description ?? null,
		installHint: a.install_hint ?? null,
		recommended: a.recommended ?? false,
		detected: a.detected ?? null,
		added: a.added ?? false,
		gatewayBypass: a.gateway_bypass ?? false,
		engine: a.engine ?? null,
		transport: a.transport ?? null,
	};
}

/** Browse the installable agent catalog (every built-in, with detect/added flags). */
export async function fetchAgentCatalog(
	target: ApiTarget
): Promise<AgentCatalogEntry[]> {
	const json = await request<{ agents?: AgentCatalogEntryWire[] }>(
		target,
		"/api/agents/catalog"
	);
	return (json.agents ?? []).map(toCatalogEntry);
}

/** Add a built-in agent to the installed set so it appears in the picker. */
export async function installAgent(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request<unknown>(target, "/api/agents/catalog/install", {
		method: "POST",
		body: { id },
	});
}

/** Remove a built-in agent from the installed set (the flagship `ryu` cannot be removed). */
export async function uninstallAgent(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request<unknown>(target, "/api/agents/catalog/uninstall", {
		method: "POST",
		body: { id },
	});
}

export async function fetchAgent(
	target: ApiTarget,
	id: string
): Promise<Agent> {
	const json = await request<{ agent: AgentRecordWire }>(
		target,
		`/api/agents/${id}`
	);
	return toAgent(json.agent);
}

export async function createAgent(
	target: ApiTarget,
	input: AgentInput
): Promise<Agent> {
	const json = await request<{ agent: AgentRecordWire }>(
		target,
		"/api/agents",
		{
			method: "POST",
			body: toAgentBody(input),
		}
	);
	return toAgent(json.agent);
}

export async function updateAgent(
	target: ApiTarget,
	id: string,
	input: AgentInput
): Promise<Agent> {
	const json = await request<{ agent: AgentRecordWire }>(
		target,
		`/api/agents/${id}`,
		{
			method: "PUT",
			body: toAgentBody(input),
		}
	);
	return toAgent(json.agent);
}

export async function deleteAgent(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request<void>(target, `/api/agents/${id}`, { method: "DELETE" });
}

/** Export a portable agent template from `GET /api/agents/:id/export`. */
export async function exportAgent(
	target: ApiTarget,
	id: string
): Promise<AgentTemplate> {
	const json = await request<{ template: AgentTemplate }>(
		target,
		`/api/agents/${id}/export`
	);
	return json.template;
}

/** Import a portable agent template via `POST /api/agents/import`. Returns the newly created agent. */
export async function importAgent(
	target: ApiTarget,
	template: AgentTemplate
): Promise<Agent> {
	const json = await request<{ agent: AgentRecordWire }>(
		target,
		"/api/agents/import",
		{
			method: "POST",
			body: { template },
		}
	);
	return toAgent(json.agent);
}

/** A tool an agent may reach: either observed (invoked this run) or an MCP tool. */
export interface AgentTool {
	description: string | null;
	name: string;
}

interface AgentToolWire {
	description?: string | null;
	name: string;
}

/** Result of a migrate-to-ryu operation. */
export interface MigrateToRyuResult {
	/** Field names that were copied (e.g. ["system_prompt", "tools", "model"]). */
	carried: string[];
	/** The updated Ryu agent record after migration. */
	ryuAgent: Agent;
	/** Id of the source agent that was copied from. */
	sourceId: string;
}

/** Migrate a source agent's persona/tools/model into the Ryu agent (Pi + Gateway). */
export async function migrateToRyu(
	target: ApiTarget,
	sourceId: string
): Promise<MigrateToRyuResult> {
	const json = await request<{
		ryu_agent: AgentRecordWire;
		source_id: string;
		carried: string[];
	}>(target, `/api/agents/${sourceId}/migrate-to-ryu`, { method: "POST" });
	return {
		ryuAgent: toAgent(json.ryu_agent),
		sourceId: json.source_id,
		carried: json.carried,
	};
}

/** Observed + MCP tools reachable by an agent, from `/api/agents/:id/tools`. */
export interface AgentTools {
	/** Registered MCP tools this agent is allowed to use. */
	mcp: AgentTool[];
	/** Tools the ACP agent has actually invoked this process run. */
	observed: AgentTool[];
}

function toTool(t: AgentToolWire): AgentTool {
	return { name: t.name, description: t.description ?? null };
}

export async function fetchAgentTools(
	target: ApiTarget,
	id: string
): Promise<AgentTools> {
	const json = await request<{
		tools?: AgentToolWire[];
		mcpTools?: AgentToolWire[];
	}>(target, `/api/agents/${id}/tools`);
	return {
		observed: (json.tools ?? []).map(toTool),
		mcp: (json.mcpTools ?? []).map(toTool),
	};
}

// ---------------------------------------------------------------------------
// Conversation participants (council / multi-agent)
// ---------------------------------------------------------------------------

export interface ConversationParticipant {
	agentId: string;
	name: string;
}

interface ParticipantWire {
	agent_id: string;
	name?: string | null;
}

export async function fetchParticipants(
	target: ApiTarget,
	conversationId: string
): Promise<ConversationParticipant[]> {
	try {
		const json = await request<{ participants?: ParticipantWire[] }>(
			target,
			`/api/conversations/${encodeURIComponent(conversationId)}/participants`
		);
		return (json.participants ?? []).map((p) => ({
			agentId: p.agent_id,
			name: p.name ?? p.agent_id,
		}));
	} catch {
		return [];
	}
}

export async function addParticipant(
	target: ApiTarget,
	conversationId: string,
	agentId: string
): Promise<void> {
	await request<unknown>(
		target,
		`/api/conversations/${encodeURIComponent(conversationId)}/participants`,
		{ method: "POST", body: { agent_id: agentId } }
	);
}

export async function removeParticipant(
	target: ApiTarget,
	conversationId: string,
	agentId: string
): Promise<void> {
	await request<unknown>(
		target,
		`/api/conversations/${encodeURIComponent(conversationId)}/participants/${encodeURIComponent(agentId)}`,
		{ method: "DELETE" }
	);
}
