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

import type { ExpressiveExpressionSelection } from "@ryu/ui/components/expressive.ts";
import type { ExpressiveAnimationSelection } from "@ryu/ui/components/expressive-animation.ts";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { track } from "@/src/lib/analytics.ts";
import { type ApiTarget, buyerTokenHeader, request } from "./client.ts";
import type { SamplingConfig } from "./inference.ts";

export type AgentLifecycleStatus = "draft" | "trial" | "active";
export type AgentSafetyProfile =
	| "read_only"
	| "approval_required"
	| "verified_plan_only"
	| "autonomous";

function lifecycleStatus(
	value: string | null | undefined
): AgentLifecycleStatus {
	return value === "draft" || value === "trial" || value === "active"
		? value
		: "active";
}

function safetyProfile(value: string | null | undefined): AgentSafetyProfile {
	return value === "read_only" ||
		value === "approval_required" ||
		value === "verified_plan_only" ||
		value === "autonomous"
		? value
		: "autonomous";
}

/**
 * An agent as it appears in the list. Built-ins carry `transport`/`engine` from
 * the in-code registry; custom agents omit them (the list handler does not join
 * the store row's engine). For the agent's tools and a reliable engine binding,
 * fetch the single record via {@link fetchAgent}.
 */
export interface AgentSummary {
	/** Complete custom glyph, including expressive, icon, emoji, DiceBear, and dither sources. */
	avatarGlyph: GlyphValue;
	/** Custom avatar image (data URL) from the agent's persona, when set. Only
	 * custom agents carry it; built-ins are null and fall back to the engine logo. */
	avatarUrl: string | null;
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
	latestVersion: string | null;
	lifecycleStatus: AgentLifecycleStatus;
	/** When true, the agent is locked and cannot be edited via the API. */
	locked: boolean;
	model: string | null;
	name: string;
	/** True only for the flagship/default agent ("ryu"). Core sets this so clients
	 * can treat the flagship specially without hard-coding its id (e.g. it runs a
	 * local model even though its transport is `"acp"`). False for every other
	 * agent. */
	recommended: boolean;
	safetyProfile: AgentSafetyProfile;
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
	versionStatus: "current" | "behind_latest" | "unknown" | null;
}

/** The model slot saved with an agent's instructions and runtime. */
export interface AgentChatModelSlot {
	engine: string | null;
	modelId: string | null;
}

/** The full persisted agent record returned by GET/POST/PUT `/api/agents/:id`. */
export interface Agent {
	builtIn: boolean;
	/** Agent-creation capability. `null` = default (off). */
	canCreateAgents: boolean | null;
	chatModel: AgentChatModelSlot | null;
	/** Composio action names this agent may call (gateway-route only). */
	composioActions: string[];
	createdAt: string | null;
	description: string | null;
	engine: string | null;
	id: string;
	/** Identity Vault profile ids bound to this agent. Empty = none. */
	identityProfileIds: string[];
	/** Per-agent sampling defaults (advanced inference settings). */
	inference: SamplingConfig | null;
	lifecycleStatus: AgentLifecycleStatus;
	/** When true, the agent is locked and cannot be edited via the API. */
	locked: boolean;
	/** Memory / Spaces slot: readable Spaces, recallable memory levels, and
	 * whether the agent may write memories. */
	memory: MemorySlot;
	model: string | null;
	name: string;
	/** Delegation/discovery capability. `null` = default (on). */
	orchestrator: boolean | null;
	/** Persona (display name + tone) as stored on the record. `null` = none saved. */
	persona: AgentPersona | null;
	safetyProfile: AgentSafetyProfile;
	/** Skill id allowlist. Empty = all enabled skills; non-empty = only these.
	 * The private `__ryu_none__` marker represents an explicit all-off choice. */
	skills: string[];
	systemPrompt: string | null;
	/** Optional role/title badge shown beside the agent name. */
	title: string;
	/** MCP tool/server allowlist. `*` means all current and future registered
	 * tools; the private `__ryu_none__` marker means explicitly none. */
	tools: string[];
	updatedAt: string | null;
	/** Semver version string (e.g. "1.0.0"). */
	version: string;
}

/** A portable agent template for export/import via `GET/POST /api/agents/:id/export` and `POST /api/agents/import`. */
export interface AgentTemplate {
	agent_config: {
		title?: string;
		description: string | null;
		system_prompt: string | null;
		persona?: AgentPersona | null;
		tools: string[];
		required_plugins?: string[];
		engine: string | null;
		model: string | null;
	};
	kind: string;
	name: string;
	version: string;
}

/**
 * Memory / Spaces slot: which Space(s) and memory levels the agent may access.
 * Mirrors Core's `MemorySlot` (`apps/core/src/agents/mod.rs`).
 */
export interface MemorySlot {
	/** Memory scope levels the agent may recall from: any subset of
	 * `["agent", "user", "node", "project", "org"]`. Empty = "all personal levels" (the back-compat
	 * default for agents configured before this slot existed). */
	read_levels: string[];
	/** Space IDs the agent may inject into chat during retrieval. Empty = no
	 * Spaces are injected (the safe default). */
	space_ids: string[];
	/** Whether the agent may record new memories during a session. */
	write_enabled: boolean;
}

/** A dither-gradient avatar spec, rendered client-side by the shared dither-kit.
 * `from` is a palette colour name (or a hue as a string); `to` is an optional
 * second palette colour (absent = fade to transparent); `direction` is one of
 * `"up" | "down" | "left" | "right"`. Mirrors Core's `DitherSpec`. */
export interface DitherSpec {
	direction?: string | null;
	from?: string | null;
	to?: string | null;
}

/** A DiceBear avatar spec (style id + seed). Mirrors Core's `DicebearSpec`. */
export interface DicebearSpec {
	seed?: string | null;
	style?: string | null;
}

/** Persona fields that travel with an agent save.
 *
 * Glyph sources from the shared GlyphPicker. Dither may layer as a background
 * under emoji or icon (never under DiceBear or an uploaded image). Saving a
 * primary source clears incompatible fields. */
export interface AgentPersona {
	/** Custom avatar image for the agent, stored inline as a data URL (or a
	 * remote URL). Null = no custom image; clients fall back to the engine logo. */
	avatar_url?: string | null;
	/** DiceBear generative avatar (style + seed). Null = none. */
	dicebear?: DicebearSpec | null;
	/** Display name the agent uses when introducing itself (optional). */
	display_name: string | null;
	/** Dither-gradient avatar spec (alternative avatar source). Null = none. */
	dither?: DitherSpec | null;
	/** Native emoji used as the avatar glyph. Null = none. */
	emoji?: string | null;
	/** Ryu ghost avatar with a named mood or the cycling `random` selection. */
	expressive?: {
		expression?: ExpressiveExpressionSelection | null;
		animation?: ExpressiveAnimationSelection | null;
	} | null;
	/** Custom icon id (Iconify / icons0 / Hugeicons), an alternative avatar
	 * source to an uploaded image or a dither gradient. Null = none. */
	icon?: string | null;
	/** Optional hex tint for {@link icon}. Null = theme `currentColor`. */
	icon_color?: string | null;
	/** Installed output-style profile assigned to this agent. Null/absent means
	 * the agent uses its own instructions and tone. */
	output_style_id?: string | null;
	/** Tone string: "neutral" | "professional" | "friendly" | "pirate" | any custom string. Null = default. */
	tone: string | null;
}

/** Fields the UI sends when creating or updating an agent. */
export interface AgentInput {
	/** Toggle agent-creation. Omit to leave unchanged. */
	canCreateAgents?: boolean | null;
	/** Authoritative per-agent model/runtime slot on current Core nodes. */
	chatModel?: AgentChatModelSlot | null;
	/** Composio action names to bind to this agent (gateway-route only). */
	composioActions?: string[];
	description: string | null;
	engine: string | null;
	/** Identity Vault profile ids to bind. Empty/omitted = none. */
	identityProfileIds?: string[];
	/** Optional per-agent sampling defaults. Serialised into the PUT body. */
	inference?: SamplingConfig;
	/** Memory / Spaces slot. Omit to leave unchanged. */
	memory?: MemorySlot;
	/** Legacy model id, sent alongside `chatModel` for older Core nodes. */
	model?: string | null;
	name: string;
	/** Toggle delegation/discovery. Omit to leave unchanged. */
	orchestrator?: boolean | null;
	/** Optional persona bundle. Serialised into the PUT body; Core ignores unknown fields gracefully. */
	persona?: AgentPersona;
	/** Saved safety posture. Trial still forces read-only at Core. */
	safetyProfile?: AgentSafetyProfile;
	/** Skill id allowlist to bind to this agent. Empty/omitted = all enabled
	 * skills; the private `__ryu_none__` marker means none. */
	skills?: string[];
	systemPrompt: string | null;
	/** Optional role/title badge shown beside the agent name. */
	title?: string;
	/** MCP tool/server allowlist. New agents default to `*` (all current and
	 * future registered tools). */
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
	const parts = version.split(".");
	if (parts.length !== 3) {
		return version;
	}
	const patch = Number.parseInt(parts[2], 10);
	if (Number.isNaN(patch)) {
		return version;
	}
	return `${parts[0]}.${parts[1]}.${patch + 1}`;
}

interface AgentSummaryWire {
	avatar_glyph?: GlyphValue | null;
	avatar_url?: string | null;
	chat_model?: AgentChatModelSlotWire | null;
	created_at?: string | null;
	description?: string | null;
	engine?: string | null;
	id: string;
	install_hint?: string | null;
	installed?: boolean | null;
	latest_version?: string | null;
	lifecycle_status?: string | null;
	locked?: boolean | null;
	model?: string | null;
	name: string;
	recommended?: boolean | null;
	safety_profile?: string | null;
	system_prompt?: string | null;
	title?: string | null;
	transport?: string | null;
	version?: string | null;
	version_status?: "current" | "behind_latest" | "unknown" | null;
}

// Core skips serializing the space/level vecs when empty (`skip_serializing_if`),
// so both arrays are optional on the wire; `write_enabled` is always present.
interface MemorySlotWire {
	read_levels?: string[] | null;
	space_ids?: string[] | null;
	write_enabled?: boolean | null;
}

interface AgentRecordWire {
	built_in?: boolean;
	can_create_agents?: boolean | null;
	chat_model?: AgentChatModelSlotWire | null;
	composio_actions?: string[];
	created_at?: string | null;
	description?: string | null;
	engine?: string | null;
	id: string;
	identity_profile_ids?: string[];
	inference?: SamplingConfig | null;
	lifecycle_status?: string | null;
	locked?: boolean;
	memory?: MemorySlotWire | null;
	model?: string | null;
	name: string;
	orchestrator?: boolean | null;
	persona?: AgentPersona | null;
	safety_profile?: string | null;
	skills?: string[];
	system_prompt?: string | null;
	title?: string | null;
	tools?: string[];
	updated_at?: string | null;
	version?: string;
}

interface AgentChatModelSlotWire {
	engine?: string | null;
	model_id?: string | null;
}

function toSummary(a: AgentSummaryWire): AgentSummary {
	const engine = a.engine ?? null;
	const model = a.model ?? a.chat_model?.model_id ?? null;
	return {
		id: a.id,
		name: a.name,
		avatarUrl: a.avatar_url ?? null,
		avatarGlyph:
			a.avatar_glyph ??
			(a.avatar_url ? { kind: "avatar", dataUrl: a.avatar_url } : null),
		description: a.description ?? null,
		systemPrompt: a.system_prompt ?? null,
		engine,
		model,
		title: a.title ?? "",
		installed: a.installed ?? null,
		lifecycleStatus: lifecycleStatus(a.lifecycle_status),
		installHint: a.install_hint ?? null,
		// Only registry built-ins serialize `transport`; custom store rows omit it.
		builtIn: a.transport != null,
		transport: a.transport ?? null,
		recommended: a.recommended ?? false,
		safetyProfile: safetyProfile(a.safety_profile),
		createdAt: a.created_at ?? null,
		version: a.version ?? null,
		latestVersion: a.latest_version ?? null,
		versionStatus: a.version_status ?? null,
		locked: a.locked ?? false,
	};
}

function toAgent(a: AgentRecordWire): Agent {
	const engine = a.engine ?? null;
	const model = a.model ?? a.chat_model?.model_id ?? null;
	return {
		id: a.id,
		name: a.name,
		title: a.title ?? "",
		description: a.description ?? null,
		systemPrompt: a.system_prompt ?? null,
		engine,
		model,
		chatModel: a.chat_model
			? {
					engine: a.chat_model.engine ?? null,
					modelId: a.chat_model.model_id ?? null,
				}
			: engine || model
				? {
						engine,
						modelId: model,
					}
				: null,
		tools: a.tools ?? [],
		composioActions: a.composio_actions ?? [],
		skills: a.skills ?? [],
		identityProfileIds: a.identity_profile_ids ?? [],
		lifecycleStatus: lifecycleStatus(a.lifecycle_status),
		inference: a.inference ?? null,
		memory: {
			space_ids: a.memory?.space_ids ?? [],
			read_levels: a.memory?.read_levels ?? [],
			write_enabled: a.memory?.write_enabled ?? false,
		},
		builtIn: a.built_in ?? false,
		createdAt: a.created_at ?? null,
		updatedAt: a.updated_at ?? null,
		version: a.version ?? "1.0.0",
		locked: a.locked ?? false,
		orchestrator: a.orchestrator ?? null,
		canCreateAgents: a.can_create_agents ?? null,
		persona: a.persona ?? null,
		safetyProfile: safetyProfile(a.safety_profile),
	};
}

export function toAgentBody(input: AgentInput): Record<string, unknown> {
	const body: Record<string, unknown> = {
		name: input.name,
		description: input.description,
		system_prompt: input.systemPrompt,
		engine: input.engine,
		tools: input.tools,
	};
	if (input.title !== undefined) {
		body.title = input.title;
	}
	if (input.model !== undefined) {
		body.model = input.model;
	}
	if (input.chatModel !== undefined) {
		body.chat_model = input.chatModel
			? {
					engine: input.chatModel.engine,
					model_id: input.chatModel.modelId,
				}
			: null;
	}
	if (input.version !== undefined) {
		body.version = input.version;
	}
	if (input.composioActions !== undefined) {
		body.composio_actions = input.composioActions;
	}
	if (input.skills !== undefined) {
		body.skills = input.skills;
	}
	if (input.identityProfileIds !== undefined) {
		body.identity_profile_ids = input.identityProfileIds;
	}
	if (input.persona !== undefined) {
		body.persona = input.persona;
	}
	if (input.inference !== undefined) {
		body.inference = input.inference;
	}
	if (input.memory !== undefined) {
		body.memory = input.memory;
	}
	if (input.safetyProfile !== undefined) {
		body.safety_profile = input.safetyProfile;
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
	/** False when the agent is in the upstream ACP registry but has no prebuilt
	 * package for this platform (binary-only, no host build). Listed for
	 * discovery, but one-click install is disabled — users add a custom
	 * `acp-exec:` command instead. Defaults to true. */
	available: boolean;
	bridgeVersionStatus: "current" | "behind_latest" | "unknown" | null;
	description: string | null;
	/** True if the agent's CLI binary is on PATH; null when not detectable. */
	detected: boolean | null;
	engine: string | null;
	gatewayBypass: boolean;
	/** Brand icon URL from the ACP registry CDN. */
	iconUrl: string | null;
	id: string;
	/** Installed ACP bridge/wrapper version (npx-cached `@latest`). */
	installedBridgeVersion: string | null;
	installedVersion: string | null;
	installHint: string | null;
	/** Latest ACP bridge version on npm (or from the registry CDN). */
	latestBridgeVersion: string | null;
	latestVersion: string | null;
	name: string;
	recommended: boolean;
	/** Official ACP registry id (e.g. `claude-acp`), when applicable. */
	registryId: string | null;
	transport: string | null;
	versionStatus: "current" | "behind_latest" | "unknown" | null;
}

interface AgentCatalogEntryWire {
	added?: boolean | null;
	available?: boolean | null;
	bridge_version_status?: "current" | "behind_latest" | "unknown" | null;
	description?: string | null;
	detected?: boolean | null;
	engine?: string | null;
	gateway_bypass?: boolean | null;
	icon_url?: string | null;
	id: string;
	install_hint?: string | null;
	installed_bridge_version?: string | null;
	installed_version?: string | null;
	latest_bridge_version?: string | null;
	latest_version?: string | null;
	name: string;
	recommended?: boolean | null;
	registry_id?: string | null;
	transport?: string | null;
	version_status?: "current" | "behind_latest" | "unknown" | null;
}

function toCatalogEntry(a: AgentCatalogEntryWire): AgentCatalogEntry {
	return {
		id: a.id,
		registryId: a.registry_id ?? null,
		name: a.name,
		description: a.description ?? null,
		installHint: a.install_hint ?? null,
		installedVersion: a.installed_version ?? null,
		latestVersion: a.latest_version ?? null,
		installedBridgeVersion: a.installed_bridge_version ?? null,
		latestBridgeVersion: a.latest_bridge_version ?? null,
		recommended: a.recommended ?? false,
		detected: a.detected ?? null,
		added: a.added ?? false,
		available: a.available ?? true,
		gatewayBypass: a.gateway_bypass ?? false,
		iconUrl: a.icon_url ?? null,
		engine: a.engine ?? null,
		transport: a.transport ?? null,
		versionStatus: a.version_status ?? null,
		bridgeVersionStatus: a.bridge_version_status ?? null,
	};
}

/**
 * Browse the installable agent catalog (every built-in, with detect/added flags).
 *
 * `versions: false` asks Core to skip the installed/latest version columns. That
 * is not a cosmetic trim: filling them costs an npm-registry lookup per agent
 * plus a `--version` subprocess per installed one — measured at ~30s on a warm
 * cache — while `detected`/`added` are local reads that return immediately. Any
 * caller that only asks "what does this machine have" should pass it; only the
 * surfaces that render update state need the default.
 */
export async function fetchAgentCatalog(
	target: ApiTarget,
	signal?: AbortSignal,
	options?: { versions?: boolean }
): Promise<AgentCatalogEntry[]> {
	const path =
		options?.versions === false
			? "/api/agents/catalog?versions=0"
			: "/api/agents/catalog";
	const json = await request<{ agents?: AgentCatalogEntryWire[] }>(
		target,
		path,
		signal ? { signal } : undefined
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
	track({ event: "agent_installed", agent_id: id });
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
	track({ event: "agent_uninstalled", agent_id: id });
}

/**
 * What a PUBLISHED agent asked for and did not get on install. Mirrors Core's
 * `AgentInstallDisclosure` (`apps/core/src/agents/mod.rs`): every field is a
 * declaration the installer must grant themselves in the agent editor, never
 * something the install turned on. Absent fields are omitted on the wire, so
 * every one is optional here.
 */
export interface AgentInstallDisclosure {
	/** Composio actions the template requested. Removed: their `composio.*` ids
	 *  widen the effective tool allowlist against the installer's own accounts. */
	composioActions: string[];
	/** Identity Vault profiles the template named. Removed: a bound profile reads
	 *  as a credential under the gateway grant. */
	identityProfileIds: string[];
	/** Memory scope levels the template asked to recall from. Removed. */
	memoryReadLevels: string[];
	/** True when the template asked to write memories. Removed. */
	memoryWriteEnabled: boolean;
	/** Gateway policy the template pointed at (firewall/DLP/budget). Removed. */
	policyId: string | null;
	/** A remote avatar URL the template shipped. Removed (install-time beacon). */
	remoteAvatarUrl: string | null;
	/** Ryu plugin ids requested by the publisher; never auto-installed or enabled. */
	requiredPlugins: string[];
	/** True when the published instructions were truncated to Core's cap. */
	systemPromptTruncated: boolean;
	/** Tool / MCP-server ids the agent expects to reach. KEPT on the record (an
	 *  empty list reads as "no filter"), listed because the servers behind them
	 *  may not be installed on this node. */
	tools: string[];
}

interface AgentInstallDisclosureWire {
	composio_actions?: string[];
	identity_profile_ids?: string[];
	memory_read_levels?: string[];
	memory_write_enabled?: boolean;
	policy_id?: string | null;
	remote_avatar_url?: string | null;
	required_plugins?: string[];
	space_ids?: string[];
	system_prompt_truncated?: boolean;
	tools?: string[];
}

/** The Spaces a published agent wanted injected are disclosed as ids by Core;
 *  they are the PUBLISHER's Space ids, so they are reported as a count only. */
export interface PublishedAgentInstallResult {
	agent: Agent;
	/** How many of the publisher's Space bindings were dropped. Ids, not names —
	 *  they resolve to nothing here, so only the fact is worth showing. */
	requestedSpaceCount: number;
	requires: AgentInstallDisclosure;
}

/**
 * Install a PUBLISHED agent definition from the marketplace `agent` catalog via
 * `POST /api/agents/published/install`.
 *
 * Distinct from {@link installAgent}, which adds an ACP *runtime* (Claude Code,
 * Codex) to the picker. This one materialises an agent DEFINITION as a new local
 * agent record. Core resolves the listing through its catalog seam, strips the
 * privilege-bearing bindings, and returns what it removed in `requires` — which
 * is what the caller shows the user to accept.
 */
export async function installPublishedAgent(
	target: ApiTarget,
	id: string,
	idempotencyKey: string
): Promise<PublishedAgentInstallResult> {
	const json = await request<{
		agent: AgentRecordWire;
		requires?: AgentInstallDisclosureWire;
	}>(target, "/api/agents/published/install", {
		method: "POST",
		body: { id, idempotency_key: idempotencyKey },
		// A published agent may be PAID. Forward the control-plane bearer for
		// optional account-aware Marketplace operations; it is not required to install.
		headers: buyerTokenHeader(target),
	});
	const wire = json.requires ?? {};
	track({ event: "agent_installed", agent_id: id });
	return {
		agent: toAgent(json.agent),
		requires: {
			composioActions: wire.composio_actions ?? [],
			identityProfileIds: wire.identity_profile_ids ?? [],
			memoryReadLevels: wire.memory_read_levels ?? [],
			memoryWriteEnabled: wire.memory_write_enabled ?? false,
			policyId: wire.policy_id ?? null,
			remoteAvatarUrl: wire.remote_avatar_url ?? null,
			systemPromptTruncated: wire.system_prompt_truncated ?? false,
			tools: wire.tools ?? [],
			requiredPlugins: wire.required_plugins ?? [],
		},
		requestedSpaceCount: (wire.space_ids ?? []).length,
	};
}

// ---------------------------------------------------------------------------
// Per-agent runtime update (npm package behind an ACP agent) — mirrors the
// Engines page's install/update. For the flagship `ryu` agent (managed Pi) both
// installed + latest versions are known and an in-place re-install is offered;
// for other npx agents only the latest version is known (npx caches globally),
// so we show it as info without an update prompt.
// ---------------------------------------------------------------------------

/** Version state for the npm package backing an agent (`/api/agents/:id/update-check`). */
export interface AgentUpdateCheck {
	id: string;
	/** Currently installed version, or null when not tracked (npx agents). */
	installedVersion: string | null;
	/** Newest version on npm, or null when unknown. */
	latestVersion: string | null;
	/** The npm package that backs this agent, or null when it isn't npm-backed. */
	npmPackage: string | null;
	/** True only when both versions are known and differ. */
	updateAvailable: boolean;
}

/** Result of POST `/api/agents/:id/update`. */
export interface AgentUpdateResult {
	error?: string;
	/**
	 * Why nothing moved, when `updated` is false without an error — e.g. the CLI
	 * was installed by its own vendor installer, so Ryu cannot upgrade it and the
	 * user has to run that tool. Without this a no-op read as a success.
	 */
	hint?: string;
	/** The version after the update, when the runtime reports one. */
	installedVersion?: string;
	updated: boolean;
}

// Core may serialize these in camelCase (as documented) or snake_case (as most
// other agent endpoints do); accept either so a serialization change never
// silently yields `undefined`.
interface AgentUpdateCheckWire {
	id: string;
	installed_version?: string | null;
	installedVersion?: string | null;
	latest_version?: string | null;
	latestVersion?: string | null;
	npm_package?: string | null;
	npmPackage?: string | null;
	update_available?: boolean | null;
	updateAvailable?: boolean | null;
}

interface AgentUpdateResultWire {
	error?: string | null;
	hint?: string | null;
	installed_version?: string | null;
	installedVersion?: string | null;
	updated?: boolean | null;
}

/** Check whether the agent's backing npm package has a newer version available. */
export async function fetchAgentUpdateCheck(
	target: ApiTarget,
	agentId: string
): Promise<AgentUpdateCheck> {
	const w = await request<AgentUpdateCheckWire>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/update-check`
	);
	return {
		id: w.id,
		npmPackage: w.npmPackage ?? w.npm_package ?? null,
		installedVersion: w.installedVersion ?? w.installed_version ?? null,
		latestVersion: w.latestVersion ?? w.latest_version ?? null,
		updateAvailable: w.updateAvailable ?? w.update_available ?? false,
	};
}

/**
 * Update the agent's backing runtime (re-install `@latest` for `ryu`; re-warm
 * the npx cache for others). Can take 10-60s. Named `runAgentUpdate` to avoid
 * colliding with {@link updateAgent} (the PUT that saves an agent record).
 */
export async function runAgentUpdate(
	target: ApiTarget,
	agentId: string
): Promise<AgentUpdateResult> {
	const w = await request<AgentUpdateResultWire>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/update`,
		{ method: "POST" }
	);
	return {
		updated: w.updated ?? false,
		installedVersion: w.installedVersion ?? w.installed_version ?? undefined,
		error: w.error ?? undefined,
		hint: w.hint ?? undefined,
	};
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

// ── Prompt Studio version history ───────────────────────────────────────────

/** Metadata for one durable Prompt Studio snapshot. */
export interface AgentPromptVersionMeta {
	agentId: string;
	createdAt: number;
	id: string;
	label: string | null;
}

interface AgentPromptVersionMetaWire {
	agent_id: string;
	created_at: number;
	id: string;
	label?: string | null;
}

/** List an agent's saved prompt snapshots, newest first. */
export async function listAgentPromptVersions(
	target: ApiTarget,
	agentId: string
): Promise<AgentPromptVersionMeta[]> {
	const json = await request<{ versions?: AgentPromptVersionMetaWire[] }>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/prompt-versions`
	);
	return (json.versions ?? []).map((version) => ({
		agentId: version.agent_id,
		createdAt: version.created_at,
		id: version.id,
		label: version.label ?? null,
	}));
}

/** Fetch one saved prompt body for the diff view. */
export async function getAgentPromptVersion(
	target: ApiTarget,
	agentId: string,
	versionId: string
): Promise<string> {
	const json = await request<{
		version?: { prompt?: string; source?: string };
	}>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/prompt-versions/${encodeURIComponent(versionId)}`
	);
	return json.version?.prompt ?? json.version?.source ?? "";
}

/** Save the current Prompt Studio draft as a durable snapshot. */
export async function createAgentPromptVersion(
	target: ApiTarget,
	agentId: string,
	prompt: string,
	label?: string
): Promise<void> {
	await request(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/prompt-versions`,
		{
			method: "POST",
			body: {
				prompt,
				...(label?.trim() ? { label: label.trim() } : {}),
			},
		}
	);
}

/** Restore a saved prompt snapshot and return the restored prompt text. */
export async function restoreAgentPromptVersion(
	target: ApiTarget,
	agentId: string,
	versionId: string
): Promise<string> {
	const json = await request<{ prompt?: string; source?: string }>(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/prompt-versions/${encodeURIComponent(versionId)}/restore`,
		{ method: "POST" }
	);
	return json.prompt ?? json.source ?? "";
}

/** Update only the lifecycle/safety controls without overwriting the editor's
 * other slots. Core validates lifecycle transitions and disables owned jobs on
 * demotion. */
export async function updateAgentPosture(
	target: ApiTarget,
	id: string,
	posture: {
		lifecycleStatus?: AgentLifecycleStatus;
		safetyProfile?: AgentSafetyProfile;
	}
): Promise<Agent> {
	const json = await request<{ agent: AgentRecordWire }>(
		target,
		`/api/agents/${id}`,
		{
			method: "PUT",
			body: {
				...(posture.lifecycleStatus === undefined
					? {}
					: { lifecycle_status: posture.lifecycleStatus }),
				...(posture.safetyProfile === undefined
					? {}
					: { safety_profile: posture.safetyProfile }),
			},
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
// ACP agent accounts (multi-account sign-ins, from the sealed vault)
// ---------------------------------------------------------------------------

/** One account an ACP agent holds (labels only — never a credential). */
export interface AgentAccount {
	accountId: string;
	/** Whether this is the account the agent uses. */
	active: boolean;
	/** Whether this is the account installed in the shared Gateway. */
	gatewayActive?: boolean;
	/** "api_key" | "oauth" | "opaque". */
	kind: string;
	/** Display name (email, provider label, or "Signed-in account"). */
	label: string;
	/** For the managed Pi agent, the provider id this account belongs to. */
	provider?: string;
}

export async function fetchAgentAccounts(
	target: ApiTarget,
	id: string
): Promise<AgentAccount[]> {
	const json = await request<{ accounts?: AgentAccount[] }>(
		target,
		`/api/agents/${id}/accounts`
	);
	return json.accounts ?? [];
}

export interface SwitchAgentAccountInput {
	accountId: string;
	/** The provider an account belongs to (managed-Pi agent accounts). */
	provider?: string;
}

export async function switchAgentAccount(
	target: ApiTarget,
	id: string,
	input: SwitchAgentAccountInput
): Promise<{ reauthenticate?: boolean }> {
	const json = await request<{
		switched: boolean;
		reauthenticate?: boolean;
		error?: string;
	}>(target, `/api/agents/${id}/accounts/switch`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!json.switched) {
		throw new Error(json.error ?? "Could not switch account");
	}
	return { reauthenticate: json.reauthenticate };
}

export async function removeAgentAccount(
	target: ApiTarget,
	id: string,
	accountId: string
): Promise<void> {
	const json = await request<{ removed: boolean; error?: string }>(
		target,
		`/api/agents/${id}/accounts/remove`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ accountId }),
		}
	);
	if (!json.removed) {
		throw new Error(json.error ?? "Could not remove account");
	}
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
