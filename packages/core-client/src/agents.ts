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

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";
import { type SamplingConfig, samplingConfigSchema } from "./inference.ts";
import { mcpListedToolFields } from "./mcp.ts";
import { scheduledScheduleFields } from "./schedules.ts";

// Complete native publishers in agents/mod.rs, adapters/mod.rs and server/mod.rs.
// Predicate validation retains the original HTTP tree and all future JSON fields.
function agentNativeResponse<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const agentJsonMap = z.custom<
	Record<string, z.output<typeof appResponseValueSchema>>
>(
	(value) =>
		z.object({}).safeParse(value).success &&
		appResponseValueSchema.safeParse(value).success
);
const agentStringMap = z.custom<Record<string, string>>((value) => {
	if (!z.object({}).safeParse(value).success) {
		return false;
	}
	const cells = agentJsonMap.safeParse(value);
	return (
		cells.success &&
		Object.values(cells.data).every(
			(cell) => z.string().safeParse(cell).success
		)
	);
});
const agentDicebearFields = z.object({
	style: z.string().nullish(),
	seed: z.string().nullish(),
});
const agentDitherFields = z.object({
	from: z.string().nullish(),
	to: z.string().nullish(),
	direction: z.string().nullish(),
});
const agentExpressiveFields = z.object({
	expression: z.string().nullish(),
	animation: z.string().nullish(),
	variant: z.string().nullish(),
	bodyStyle: z.string().nullish(),
	behavior: z.string().nullish(),
	colors: agentStringMap.nullish(),
	/** Costume slots, including namespaced marketplace accessory ids. */
	costume: agentStringMap.nullish(),
	animated: z.boolean().nullish(),
	eyeScale: z.number().nullish(),
	animationDuration: z.number().nullish(),
});
/** A plugin-contributed avatar style selection (mirrors Core's `AvatarStyleSpec`). */
const agentAvatarStyleFields = z.object({
	style: z.string().nullish(),
	seed: z.string().nullish(),
	palette: z.string().nullish(),
	parts: agentStringMap.nullish(),
});
const agentPersonaFields = z.object({
	output_style_id: z.string().nullish(),
	display_name: z.string().nullish(),
	avatar_url: z.string().nullish(),
	emoji: z.string().nullish(),
	icon: z.string().nullish(),
	icon_color: z.string().nullish(),
	dicebear: agentDicebearFields.nullish(),
	expressive: agentExpressiveFields.nullish(),
	dither: agentDitherFields.nullish(),
	avatar_style: agentAvatarStyleFields.nullish(),
	tone: z.string().nullish(),
});
export type AgentPersonaView = z.output<typeof agentPersonaFields>;
const agentModelFields = z.object({
	model_id: z.string().nullish(),
	engine: z.string().nullish(),
});
const agentMediaFields = z.object({
	model_id: z.string().nullish(),
	provider: z.string().nullish(),
});
const agentTtsFields = agentMediaFields.extend({ voice: z.string().nullish() });
const agentWorkingMemoryFields = z.object({
	enabled: z.boolean().optional(),
	scope: z.enum(["thread", "resource"]).optional(),
	template: z.string().nullish(),
	schema: agentJsonMap.nullish(),
});
const agentCompactionFields = z.object({
	enabled: z.boolean().nullish(),
	threshold: z.union([z.number().int().positive(), z.string()]).nullish(),
	model: z.string().nullish(),
	effort: z.string().nullish(),
});
const agentMemoryFields = z.object({
	space_ids: z.array(z.string()).optional(),
	read_levels: z.array(z.string()).optional(),
	write_enabled: z.boolean().optional(),
	working_memory: agentWorkingMemoryFields.nullish(),
	compaction: agentCompactionFields.nullish(),
});
const agentPolicyFields = z.object({ policy_id: z.string().nullish() });
const agentSamplingFields = samplingConfigSchema.extend({
	logit_bias: agentJsonMap.optional(),
	response_format: appResponseValueSchema.optional(),
	grammar: z.string().nullish(),
	prefill: z.string().nullish(),
});
const agentSlots = {
	chat_model: agentModelFields.nullish(),
	stt: agentMediaFields.nullish(),
	tts: agentTtsFields.nullish(),
	image_model: agentMediaFields.nullish(),
	video_model: agentMediaFields.nullish(),
	memory: agentMemoryFields.nullish(),
	persona: agentPersonaFields.nullish(),
	policy_ref: agentPolicyFields.nullish(),
};
const agentRecordFields = z.object({
	id: z.string(),
	name: z.string(),
	lifecycle_status: z.enum(["draft", "trial", "active"]).optional(),
	safety_profile: z
		.enum([
			"read_only",
			"approval_required",
			"verified_plan_only",
			"autonomous",
		])
		.optional(),
	title: z.string().nullish(),
	description: z.string().nullish(),
	system_prompt: z.string().nullish(),
	tools: z.array(z.string()).optional(),
	composio_actions: z.array(z.string()).optional(),
	skills: z.array(z.string()).optional(),
	identity_profile_ids: z.array(z.string()).optional(),
	// A string, not an enum: a mode this client does not know reads as
	// `individual`, the most restrictive mode (see `agentIdentityMode`).
	identity_mode: z.string().nullish(),
	// `null`/absent = unrestricted; `[]` = no accounts. Keep the distinction.
	account_access: z.array(z.string()).nullable().optional(),
	approval_tools: z.array(z.string()).optional(),
	model: z.string().nullish(),
	engine: z.string().nullish(),
	built_in: z.boolean().optional(),
	created_at: z.string().nullish(),
	updated_at: z.string().nullish(),
	...agentSlots,
	inference: agentSamplingFields.nullish(),
	version: z.string().optional(),
	locked: z.boolean().optional(),
	orchestrator: z.boolean().nullish(),
	can_create_agents: z.boolean().nullish(),
});
const agentSummaryFields = z.object({
	id: z.string(),
	name: z.string(),
	title: z.string().nullish(),
	description: z.string().nullish(),
	install_hint: z.string().nullish(),
	installed: z.boolean().nullish(),
	model: z.string().nullish(),
	system_prompt: z.string().nullish(),
	created_at: z.string().nullish(),
	engine: z.string().nullish(),
	transport: z.string().nullish(),
	recommended: z.boolean().nullish(),
	version: z.string().nullish(),
	latest_version: z.string().nullish(),
	version_status: z.string().nullish(),
	locked: z.boolean().nullish(),
	enabled: z.boolean().nullish(),
	gateway_bypass: z.boolean().nullish(),
	avatar_url: z.string().nullish(),
	avatar_glyph: appResponseValueSchema.optional(),
	lifecycle_status: z.string().nullish(),
	safety_profile: z.string().nullish(),
});
const agentCatalogFields = z.object({
	id: z.string(),
	registry_id: z.string().nullish(),
	icon_url: z.string().nullish(),
	name: z.string(),
	description: z.string().nullish(),
	install_hint: z.string().nullish(),
	recommended: z.boolean().nullish(),
	detected: z.boolean().nullish(),
	added: z.boolean().nullish(),
	available: z.boolean().nullish(),
	policy_blocked: z.boolean().nullish(),
	gateway_bypass: z.boolean().nullish(),
	engine: z.string().nullish(),
	transport: z.string().nullish(),
	installed_version: z.string().nullish(),
	latest_version: z.string().nullish(),
	version_status: z.string().nullish(),
	installed_bridge_version: z.string().nullish(),
	latest_bridge_version: z.string().nullish(),
	bridge_version_status: z.string().nullish(),
});
const agentScheduleTemplateFields = z.object({
	name: z.string().optional(),
	schedule: scheduledScheduleFields,
	instructions: z.string(),
	enabled: z.boolean().optional(),
	require_approval: z.boolean().optional(),
	conversation_id: z.string().nullish(),
});
const agentTemplateConfigFields = z.object({
	title: z.string().optional(),
	description: z.string().nullish(),
	system_prompt: z.string().nullish(),
	tools: z.array(z.string()),
	required_plugins: z.array(z.string()).optional(),
	composio_actions: z.array(z.string()).optional(),
	skills: z.array(z.string()).optional(),
	identity_profile_ids: z.array(z.string()).optional(),
	// The mode travels with a template; `account_access` is node-local and never does.
	identity_mode: z.string().nullish(),
	engine: z.string().nullish(),
	model: z.string().nullish(),
	...agentSlots,
	schedules: z.array(agentScheduleTemplateFields).optional(),
});
const agentTemplateFields = z.object({
	kind: z.string(),
	name: z.string(),
	version: z.string(),
	agent_config: agentTemplateConfigFields,
});
const observedToolFields = z.object({
	name: z.string(),
	description: z.string().nullish(),
	schema: appResponseValueSchema.optional(),
});
const participantFields = z.object({
	agent_id: z.string(),
	name: z.string().nullish(),
});
export const agentsResponseSchema = agentNativeResponse(
	z.object({ agents: z.array(agentSummaryFields).optional() })
);
const agentCatalogResponseSchema = agentNativeResponse(
	z.object({ agents: z.array(agentCatalogFields).optional() })
);
// Where an app's agent got its identity mode (`GET /api/agents/:id` only).
const agentAppIdentityFields = z.object({
	app_mode: z.string(),
	pending_mode: z.string().nullish(),
});
const agentResponseSchema = agentNativeResponse(
	z.object({
		agent: agentRecordFields,
		source: appResponseValueSchema.optional(),
		app_identity: agentAppIdentityFields.nullish(),
	})
);
const agentTemplateResponseSchema = agentNativeResponse(
	z.object({ template: agentTemplateFields })
);
const agentMigrationResponseSchema = agentNativeResponse(
	z.object({
		ryu_agent: agentRecordFields,
		source_id: z.string(),
		carried: z.array(z.string()),
	})
);
const agentToolsResponseSchema = agentNativeResponse(
	z.object({
		tools: z.array(observedToolFields).optional(),
		mcpTools: z.array(mcpListedToolFields).optional(),
	})
);
const agentParticipantsResponseSchema = agentNativeResponse(
	z.object({ participants: z.array(participantFields).optional() })
);

/** Keep an opaque agent ID within one URL segment, including legacy IDs. */
export function encodeAgentPathId(id: string): string {
	// URL parsers normalize these even when encodeURIComponent is used.
	if (id === "." || id === "..") {
		throw new Error("Agent ID cannot be a URL dot segment");
	}
	return encodeURIComponent(id);
}

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
	/** True when this agent's provider calls cannot be redirected through the
	 * local gateway (the engine ignores `OPENAI_BASE_URL`), so its egress bypasses
	 * the gateway. Omitted by Core when false/absent, so `undefined` here means
	 * "via gateway" (matches the Rust CLI's `None` default). */
	gatewayBypass?: boolean;
	id: string;
	installed: boolean | null;
	/** Hint shown to users on how to install/run this agent (e.g. "via npx"). */
	installHint: string | null;
	/** When true, the agent is locked and cannot be edited via the API. */
	locked: boolean;
	model: string | null;
	name: string;
	systemPrompt: string | null;
	/** Optional role/title badge shown beside the agent name. */
	title: string;
	/** Transport backing the agent as Core reports it: `"acp"` (subprocess) or
	 * `"openai_compat"` (gateway-routed local server). Null for custom store rows
	 * that don't serialize it. Lets clients decide gateway-need without re-deriving
	 * it from the id/engine. */
	transport: string | null;
	/** Semver version string. Present for custom agents; null for registry built-ins. */
	version: string | null;
}

/** How an agent relates to the user's accounts. Mirrors Core's
 * `AgentIdentityMode`: `managed` acts as the user with their connected
 * accounts, `individual` has its own identity and accounts and never touches
 * the user's, and `mixed` has both. Legacy rows read as `managed`. */
export type AgentIdentityMode = "managed" | "individual" | "mixed";

/**
 * A missing value (a node from before identity modes) reads as `managed`, Core's
 * legacy default. An unknown value (a mode this client does not know) reads as
 * `individual`, the most restrictive mode, matching Core's fail-closed rule, so
 * saving the agent can never widen it to act as the user.
 */
export function agentIdentityMode(
	value: string | null | undefined
): AgentIdentityMode {
	if (value === "individual" || value === "mixed") {
		return value;
	}
	return value === undefined ||
		value === null ||
		value === "" ||
		value === "managed"
		? "managed"
		: "individual";
}

/**
 * Where an app's agent got its identity mode: the mode its app last set, and a
 * mode a newer app version asked for that Core left for the user to accept
 * (by saving the agent with it) or dismiss (`dismissPendingIdentityMode`).
 */
export interface AgentAppIdentity {
	appMode: AgentIdentityMode;
	pendingMode: AgentIdentityMode | null;
}

/** The full persisted agent record returned by GET/POST/PUT `/api/agents/:id`. */
export interface Agent {
	/** Account keys this agent may use. `null` = no allowlist (every account its
	 * identity mode permits); `[]` = none. */
	accountAccess: string[] | null;
	/**
	 * For an app's agent, where its identity mode came from. Only
	 * `fetchAgent` reads it; absent or `null` otherwise.
	 */
	appIdentity?: AgentAppIdentity | null;
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
	/** Whether the agent acts as the user, has its own identity, or both. */
	identityMode: AgentIdentityMode;
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
	/** Persona identity and the reusable personality profile assigned to this agent. */
	persona: AgentPersonaView | null;
	/** Skill id allowlist. Empty = all enabled skills; non-empty = only these. */
	skills: string[];
	systemPrompt: string | null;
	/** Optional role/title badge shown beside the agent name. */
	title: string;
	tools: string[];
	updatedAt: string | null;
	/** Semver version string (e.g. "1.0.0"). */
	version: string;
}

/** A portable agent template for export/import via `GET/POST /api/agents/:id/export` and `POST /api/agents/import`. */
export type AgentTemplate = z.output<typeof agentTemplateFields>;

/**
 * Ryu ghost avatar settings, mirroring Core's `ExpressiveSpec`. Core stores
 * every field opaquely; clients normalize them when rendering.
 */
export interface AgentExpressiveAvatar {
	animated?: boolean;
	/** Named animation or the cycling `random` selection. */
	animation?: string | null;
	animationDuration?: number;
	behavior?: string;
	bodyStyle?: string;
	colors?: Record<string, string>;
	/**
	 * Halloween outfit for the `costume` variant: slot name (`palette`,
	 * `finish`, `eyes`, `headwear`, ...) to option id. Unknown slots or ids
	 * render as the plain ghost.
	 */
	costume?: Record<string, string>;
	/** Named mood or the cycling `random` selection. */
	expression?: string | null;
	eyeScale?: number;
	/** `3d` | `outline` | `outline-muted` | `default` | `expressive` | `costume`. */
	variant?: string;
}

/** Persona fields that travel with an agent save. */
export interface AgentPersona {
	/** Display name the agent uses when introducing itself (optional). */
	display_name: string | null;
	/**
	 * Ryu ghost avatar, including a costume outfit. Null/absent = none. A
	 * persona read back from Core (`AgentPersonaView`, whose fields are nullish)
	 * may be re-saved unchanged, so its expressive shape is accepted as well.
	 */
	expressive?: AgentExpressiveAvatar | AgentPersonaView["expressive"];
	/** Installed output-style profile id; null/absent means the agent's own voice. */
	output_style_id?: string | null;
	/** Tone string: "neutral" | "professional" | "friendly" | "pirate" | any custom string. Null = default. */
	tone: string | null;
}

/** Fields the UI sends when creating or updating an agent. */
export interface AgentInput {
	/** Account allowlist. `null` clears it to unrestricted; `[]` allows none;
	 * omit to leave unchanged. */
	accountAccess?: string[] | null;
	/** Toggle agent-creation. Omit to leave unchanged; null clears to the default (off). */
	canCreateAgents?: boolean | null;
	/** Composio action names to bind to this agent (gateway-route only). */
	composioActions?: string[];
	description: string | null;
	/**
	 * Dismiss the identity mode a newer app version asked for
	 * (`Agent.appIdentity.pendingMode`), keeping the current mode. To accept
	 * it instead, save `identityMode` set to that mode.
	 */
	dismissPendingIdentityMode?: boolean;
	engine: string | null;
	/** Identity mode. Omit to leave unchanged (Core defaults new agents to `managed`). */
	identityMode?: AgentIdentityMode;
	/** Optional per-agent sampling defaults. Serialised into the PUT body. */
	inference?: SamplingConfig;
	/** Optional model override; null clears the saved value. */
	model?: string | null;
	name: string;
	/** Toggle delegation/discovery. Omit to leave unchanged; null clears to the default (on). */
	orchestrator?: boolean | null;
	/** Optional persona bundle. Serialised into the PUT body; Core ignores unknown fields gracefully. */
	persona?: AgentPersona;
	/** Skill id allowlist to bind to this agent. Empty/omitted = all enabled skills. */
	skills?: string[];
	systemPrompt: string | null;
	/** Optional role/title badge shown beside the agent name. */
	title?: string | null;
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

type AgentSummaryWire = z.output<typeof agentSummaryFields>;

type AgentRecordWire = z.output<typeof agentRecordFields>;

function toSummary(a: AgentSummaryWire): AgentSummary {
	return {
		id: a.id,
		name: a.name,
		description: a.description ?? null,
		systemPrompt: a.system_prompt ?? null,
		engine: a.engine ?? null,
		model: a.model ?? null,
		title: a.title ?? "",
		installed: a.installed ?? null,
		installHint: a.install_hint ?? null,
		// Only registry built-ins serialize `transport`; custom store rows omit it.
		builtIn: a.transport != null,
		transport: a.transport ?? null,
		createdAt: a.created_at ?? null,
		version: a.version ?? null,
		locked: a.locked ?? false,
		// Preserve Core's tri-state: absent/null → undefined ("via gateway"),
		// matching the Rust CLI's `None` default rather than collapsing to false.
		gatewayBypass: a.gateway_bypass ?? undefined,
	};
}

/**
 * Read an app agent's identity provenance. A mode this client does not know
 * reads as `individual` (see `agentIdentityMode`), so nothing here widens.
 */
export function toAgentAppIdentity(
	wire: z.output<typeof agentAppIdentityFields> | null | undefined
): AgentAppIdentity | null {
	if (!wire) {
		return null;
	}
	return {
		appMode: agentIdentityMode(wire.app_mode),
		pendingMode: wire.pending_mode
			? agentIdentityMode(wire.pending_mode)
			: null,
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
		title: a.title ?? "",
		tools: a.tools ?? [],
		composioActions: a.composio_actions ?? [],
		skills: a.skills ?? [],
		identityMode: agentIdentityMode(a.identity_mode),
		accountAccess: a.account_access ?? null,
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
		persona: a.persona ?? null,
	};
}

/** Complete controlled HTTP publisher built from the native AgentInput owner. */
interface AgentWriteBody {
	account_access?: AgentInput["accountAccess"];
	can_create_agents?: AgentInput["canCreateAgents"];
	composio_actions?: AgentInput["composioActions"];
	description: AgentInput["description"];
	dismiss_pending_identity_mode?: boolean;
	engine: AgentInput["engine"];
	identity_mode?: AgentInput["identityMode"];
	inference?: AgentInput["inference"];
	model: AgentInput["model"];
	name: AgentInput["name"];
	orchestrator?: AgentInput["orchestrator"];
	persona?: AgentInput["persona"];
	skills?: AgentInput["skills"];
	system_prompt: AgentInput["systemPrompt"];
	title: AgentInput["title"];
	tools: AgentInput["tools"];
	version?: AgentInput["version"];
}

function toAgentBody(input: AgentInput) {
	const body: AgentWriteBody = {
		name: input.name,
		title: input.title,
		description: input.description,
		system_prompt: input.systemPrompt,
		engine: input.engine,
		model: input.model,
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
	if (input.identityMode !== undefined) {
		body.identity_mode = input.identityMode;
	}
	if (input.dismissPendingIdentityMode === true) {
		body.dismiss_pending_identity_mode = true;
	}
	// `null` is meaningful here: it clears the allowlist back to unrestricted.
	if (input.accountAccess !== undefined) {
		body.account_access = input.accountAccess;
	}
	return body;
}

export async function fetchAgents(target: ApiTarget) {
	const json = await request(
		target,
		"/api/agents",
		undefined,
		agentsResponseSchema
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

type AgentCatalogEntryWire = z.output<typeof agentCatalogFields>;

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
	const json = await request(
		target,
		"/api/agents/catalog",
		undefined,
		agentCatalogResponseSchema
	);
	return (json.agents ?? []).map(toCatalogEntry);
}

/** Add a built-in agent to the installed set so it appears in the picker. */
export async function installAgent(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(
		target,
		"/api/agents/catalog/install",
		{
			method: "POST",
			body: { id },
		},
		appResponseValueSchema
	);
}

/** Remove a built-in agent from the installed set (the flagship `ryu` cannot be removed). */
export async function uninstallAgent(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(
		target,
		"/api/agents/catalog/uninstall",
		{
			method: "POST",
			body: { id },
		},
		appResponseValueSchema
	);
}

export async function fetchAgent(
	target: ApiTarget,
	id: string
): Promise<Agent> {
	const json = await request(
		target,
		`/api/agents/${encodeAgentPathId(id)}`,
		undefined,
		agentResponseSchema
	);
	return {
		...toAgent(json.agent),
		appIdentity: toAgentAppIdentity(json.app_identity),
	};
}

export async function createAgent(
	target: ApiTarget,
	input: AgentInput
): Promise<Agent> {
	const json = await request(
		target,
		"/api/agents",
		{
			method: "POST",
			body: toAgentBody(input),
		},
		agentResponseSchema
	);
	return toAgent(json.agent);
}

export async function updateAgent(
	target: ApiTarget,
	id: string,
	input: AgentInput
): Promise<Agent> {
	const json = await request(
		target,
		`/api/agents/${encodeAgentPathId(id)}`,
		{
			method: "PUT",
			body: toAgentBody(input),
		},
		agentResponseSchema
	);
	return toAgent(json.agent);
}

export async function deleteAgent(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(
		target,
		`/api/agents/${encodeAgentPathId(id)}`,
		{
			method: "DELETE",
		},
		appResponseValueSchema
	);
}

/** What `POST /api/agents/launch-check` is asked about. */
export interface AgentLaunchCheckInput {
	/** The account allowlist; `null` or omitted is no limit. */
	accountAccess?: string[] | null;
	/** The saved agent's id, when it has one; its routing switches apply. */
	agentId?: string | null;
	/** The engine the agent would run on, as saved on its record. */
	engine: string;
	identityMode: AgentIdentityMode;
}

/**
 * Whether Core would start an agent's engine under an identity mode and
 * account access, from the same checks its first turn runs. `reason` is the
 * text that turn would fail with.
 */
export interface AgentLaunchCheck {
	/** `provider_access_refused`, `managed_pi_direct_routing`,
	 * `account_access_sandbox_unavailable` or `unmanaged_gateway`; `null` when
	 * launchable. */
	code: string | null;
	launchable: boolean;
	/** Where a limited agent on Ryu's built-in engine gets its default model:
	 * `allowed_provider`, `ryu_credits`, `first_allowed_model` or `local`;
	 * `null` for any other agent. */
	limitedModelSource: string | null;
	/** A warning that does not stop the agent starting: it would start on the
	 * local model, which is not downloaded, so its turns would fail. */
	modelWarning: string | null;
	reason: string | null;
	/** True when a custom agent on the "Ryu" engine runs on Ryu's built-in
	 * engine because its model providers are limited. */
	runsOnManagedPi: boolean;
	/** Whether this computer can run an engine in the account-access sandbox. */
	sandboxSupported: boolean;
	/** The model provider the engine calls itself with your own sign-in or
	 * key under the current routing (`anthropic`, `openai`, `genai`, `kiro`). */
	vendorProvider: string | null;
}

/** `POST /api/agents/launch-check` response. Shared with the desktop client. */
export const agentLaunchCheckResponseSchema = z
	.object({
		launchable: z.boolean(),
		reason: z.string().nullish(),
		code: z.string().nullish(),
		sandbox_supported: z.boolean(),
		runs_on_managed_pi: z.boolean(),
		vendor_provider: z.string().nullish(),
		limited_model_source: z.string().nullish(),
		model_warning: z.string().nullish(),
	})
	.passthrough();

/** The request body for {@link launchCheck}. */
export function toAgentLaunchCheckBody(
	input: AgentLaunchCheckInput
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		engine: input.engine,
		identity_mode: input.identityMode,
		account_access: input.accountAccess ?? null,
	};
	if (input.agentId) {
		body.agent_id = input.agentId;
	}
	return body;
}

export function toAgentLaunchCheck(
	json: z.output<typeof agentLaunchCheckResponseSchema>
): AgentLaunchCheck {
	return {
		launchable: json.launchable,
		reason: json.reason ?? null,
		code: json.code ?? null,
		sandboxSupported: json.sandbox_supported,
		runsOnManagedPi: json.runs_on_managed_pi,
		vendorProvider: json.vendor_provider ?? null,
		limitedModelSource: json.limited_model_source ?? null,
		modelWarning: json.model_warning ?? null,
	};
}

/** Ask Core whether an agent's engine would start under its account access. */
export async function launchCheck(
	target: ApiTarget,
	input: AgentLaunchCheckInput
): Promise<AgentLaunchCheck> {
	const json = await request(
		target,
		"/api/agents/launch-check",
		{
			method: "POST",
			body: toAgentLaunchCheckBody(input),
		},
		agentLaunchCheckResponseSchema
	);
	return toAgentLaunchCheck(json);
}

/** Export a portable agent template from `GET /api/agents/:id/export`. */
export async function exportAgent(
	target: ApiTarget,
	id: string
): Promise<AgentTemplate> {
	const json = await request(
		target,
		`/api/agents/${encodeAgentPathId(id)}/export`,
		undefined,
		agentTemplateResponseSchema
	);
	return json.template;
}

/** Import a portable agent template via `POST /api/agents/import`. Returns the newly created agent. */
export async function importAgent(
	target: ApiTarget,
	template: AgentTemplate
): Promise<Agent> {
	const json = await request(
		target,
		"/api/agents/import",
		{
			method: "POST",
			body: { template },
		},
		agentResponseSchema
	);
	return toAgent(json.agent);
}

/** A tool an agent may reach: either observed (invoked this run) or an MCP tool. */
export interface AgentTool {
	description: string | null;
	name: string;
}

type AgentToolWire = z.output<typeof observedToolFields>;

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
	const json = await request(
		target,
		`/api/agents/${encodeAgentPathId(sourceId)}/migrate-to-ryu`,
		{
			method: "POST",
		},
		agentMigrationResponseSchema
	);
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
	const json = await request(
		target,
		`/api/agents/${encodeAgentPathId(id)}/tools`,
		undefined,
		agentToolsResponseSchema
	);
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

export async function fetchParticipants(
	target: ApiTarget,
	conversationId: string
): Promise<ConversationParticipant[]> {
	try {
		const json = await request(
			target,
			`/api/conversations/${encodeURIComponent(conversationId)}/participants`,
			undefined,
			agentParticipantsResponseSchema
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
	await request(
		target,
		`/api/conversations/${encodeURIComponent(conversationId)}/participants`,
		{ method: "POST", body: { agent_id: agentId } },
		appResponseValueSchema
	);
}

export async function removeParticipant(
	target: ApiTarget,
	conversationId: string,
	agentId: string
): Promise<void> {
	await request(
		target,
		`/api/conversations/${encodeURIComponent(conversationId)}/participants/${encodeAgentPathId(agentId)}`,
		{ method: "DELETE" },
		appResponseValueSchema
	);
}
