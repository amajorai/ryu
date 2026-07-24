// apps/desktop/src/lib/publish/packaging.ts
//
// Universal "Publish" packaging (Phase 5a): turn a Runnable's SHAREABLE config
// into a Ryu plugin manifest + marketplace publish body, so a user can publish
// their own agent to the marketplace from inside the desktop app.
//
// Ryu's object model: an Agent/Workflow is a Runnable; an App/Plugin is a
// manifest.json bundling Runnables. So "publish my agent" == package the agent's
// portable card into a plugin manifest whose `runnables` declare that agent
// (kind="agent"), then POST it to POST /api/marketplace/publish. This mirrors
// the SDK CLI's `ryu publish` body shape (packages/sdk/src/cli.ts) but is built
// from a live agent record instead of a manifest.json on disk.
//
// SECURITY — never package secrets. This module serializes ONLY agent-record
// fields, and the agent record carries no keys: BYOK/gateway keys live behind
// separate endpoints (the AgentEditPage ByoaPanel fetches them independently),
// never on the record. On top of that it deliberately EXCLUDES per-user and
// node-local bindings that would either leak or fail to port:
//   - Identity Vault profile bindings (per-user credentials)
//   - Memory / Spaces space_ids (node-local Space identifiers)
//   - a custom `acp-exec:<command>` engine (a local binary path/command)
// The result is a portable "Pokémon card" definition — persona + model slot +
// tool/skill declarations — and nothing else. This matches Core's own portable
// `AgentTemplate` (apps/core exportAgent), which likewise carries only
// description / system_prompt / tools / engine / model.

/** The publish `kind`. Phase 5a publishes agents as a `plugin` bundle. */
export type PublishKind = "plugin";

/** Engine ids that are a literal ACP spawn command (a local binary/command).
 *  Their raw value can embed a local filesystem path, so it is never shipped. */
const ACP_EXEC_PREFIX = "acp-exec:";

const NON_ALNUM_RE = /[^a-z0-9]+/g;
const EDGE_DASH_RE = /^-+|-+$/g;

/**
 * Kebab-case a display name into a slug safe for the bare-kebab plugin id
 * (Core `validate_plugin_id`: ASCII `[a-zA-Z0-9.-_]`, no leading `-`). Collapses
 * runs of non-alphanumerics to a single `-` and trims edge dashes. Returns "" for
 * an all-symbol input so the caller can fall back.
 */
export function toKebab(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(NON_ALNUM_RE, "-")
		.replace(EDGE_DASH_RE, "");
}

// ── Capability humanization (for the store detail preview) ────────────────────

// Curated tool/action → human label lookup, mirroring the server + detail-client
// humanizers so the card reads naturally. Anything unmapped is title-cased.
const CAPABILITY_LABELS: Record<string, string> = {
	web_scrape: "Web scraping",
	web_search: "Web search",
	web_browse: "Web browsing",
	file_read: "Read files",
	file_write: "Write files",
	code_execute: "Run code",
	semantic_search: "Semantic search",
	search: "Search",
};

const CAP_SEPARATORS_RE = /[._\-:/\s]+/;

/** Turn a raw tool/action name into a readable capability label. */
function humanizeCapability(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		return "";
	}
	const lower = trimmed.toLowerCase();
	const known = CAPABILITY_LABELS[lower];
	if (known) {
		return known;
	}
	// Drop a leading `namespace:` (e.g. Composio `GITHUB_CREATE_ISSUE` stays as-is
	// after title-casing; `mcp:web_browse` → "Web browse").
	const colon = trimmed.indexOf(":");
	const tail = colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
	const words = tail.split(CAP_SEPARATORS_RE).filter(Boolean);
	if (words.length === 0) {
		return trimmed;
	}
	const joined = words.join(" ").toLowerCase();
	return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** Derive de-duplicated human capability labels from the agent's tools +
 *  Composio actions, for the store detail preview. */
export function deriveCapabilities(
	tools: string[],
	composioActions: string[]
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of [...tools, ...composioActions]) {
		const label = humanizeCapability(raw);
		if (label && !seen.has(label)) {
			seen.add(label);
			out.push(label);
		}
	}
	return out;
}

// ── Publish body (wire shape for POST /api/marketplace/publish) ───────────────

/** A bundled Runnable in the DISPLAY shape the detail dialog renders. */
export interface PublishRunnableView {
	enabled: boolean;
	id: string;
	kind: string;
	name: string;
}

/**
 * The exact JSON body POST /api/marketplace/publish accepts (the fields Phase 5a
 * sends). Mirrors the server `PublishBody` (packages/api marketplace router) and
 * the SDK CLI publish body. Only the free-listing subset is modelled here —
 * paid pricing is deferred (it requires a payouts-enabled org).
 */
export interface PublishBody {
	capabilities: string[];
	category: string | null;
	description: string | null;
	descriptor: Record<string, unknown>;
	developer: string | null;
	examplePrompts: string[];
	/** Requested permission grants. Always empty in 5a: an empty set is
	 *  auto-approved by the Gateway (no 403/502), and the human `capabilities`
	 *  above carry the display. */
	grants: string[];
	iconUrl: string | null;
	id: string;
	kind: PublishKind;
	manifest: Record<string, unknown>;
	name: string;
	runnables: PublishRunnableView[];
	screenshots: string[];
	tagline: string | null;
	version: string;
}

/** The listing metadata a user fills in the Publish dialog. */
export interface PublishListing {
	category: string;
	description: string;
	/** Human display name shown as the card/listing title. */
	displayName: string;
	examplePrompts: string[];
	/** http(s) icon URL. Data URLs (e.g. the agent avatar) are rejected by the
	 *  server's URL validator, so they are never sent. */
	iconUrl: string;
	screenshots: string[];
	/** Kebab slug that becomes the bare-kebab plugin id (the stored id). */
	slug: string;
	tagline: string;
}

/**
 * The SHAREABLE subset of an agent record used to build the portable card. The
 * caller (AgentEditPage) constructs this from the live form/record, having
 * already dropped the non-portable bindings — this type does not even name
 * `identityProfileIds` or `memory.space_ids`, so they cannot be packaged by
 * construction.
 */
export interface AgentPublishSource {
	canCreateAgents: boolean;
	composioActions: string[];
	description: string | null;
	/** Engine/model slot as stored on the record. A custom `acp-exec:` command is
	 *  scrubbed here (a local binary path is never shipped). */
	engine: string | null;
	/** Recallable memory LEVELS only (user/node/project) — never the node-local
	 *  space_ids, which are dropped upstream. */
	memoryReadLevels: string[];
	orchestrator: boolean;
	skills: string[];
	systemPrompt: string | null;
	tools: string[];
	/** Semver version to stamp on the manifest. */
	version: string;
}

/** True when the engine is a custom local ACP command (never shippable). */
function isLocalAcpCommand(engine: string | null): boolean {
	return typeof engine === "string" && engine.startsWith(ACP_EXEC_PREFIX);
}

/**
 * Build the marketplace publish body for an agent. Produces a plugin manifest
 * whose single runnable declares the agent (kind="agent") with its portable
 * config, plus the flat rich-listing metadata the control plane stores for the
 * App-Store-style detail preview.
 *
 * `body.name` is the HUMAN display name (the listing title); `body.id` is the
 * bare-kebab plugin id (the slug, the unique ownership key) — do not conflate
 * them. The global reference form is `name@marketplace` (e.g. `ghost@ryu`), but
 * the stored id is the bare slug.
 */
export function buildAgentPublishBody(
	source: AgentPublishSource,
	listing: PublishListing
): PublishBody {
	const slug = toKebab(listing.slug) || toKebab(listing.displayName) || "agent";
	const id = slug;
	const displayName = listing.displayName.trim() || slug;
	const version = source.version || "1.0.0";

	// The engine slot: keep a built-in/model id (portable), but drop a custom
	// `acp-exec:` command (it can embed a local filesystem path).
	const model = isLocalAcpCommand(source.engine) ? null : source.engine;

	// The agent runnable config. Canonical Core `AgentConfig` fields
	// (system_prompt / model / tools) sit at the top; the richer Ryu slots ride
	// alongside (Core ignores unknown config fields on install, and the detail
	// dialog can surface them). No identities, no space_ids, no secrets.
	const agentConfig: Record<string, unknown> = {
		system_prompt: source.systemPrompt,
		model,
		tools: source.tools,
		skills: source.skills,
		composio_actions: source.composioActions,
		memory_read_levels: source.memoryReadLevels,
		orchestrator: source.orchestrator,
		can_create_agents: source.canCreateAgents,
	};

	const runnableId = `agent-${slug}`;
	const manifest: Record<string, unknown> = {
		id,
		name: displayName,
		version,
		// Declarations only; kept EMPTY so the publish is auto-approved (an empty
		// grant set short-circuits the Gateway validation). The human capabilities
		// below carry the store display.
		permission_grants: [],
		runnables: [
			{
				id: runnableId,
				name: displayName,
				kind: "agent",
				config: agentConfig,
			},
		],
	};

	const capabilities = deriveCapabilities(
		source.tools,
		source.composioActions
	);
	const runnablesView: PublishRunnableView[] = [
		{ id: runnableId, name: displayName, kind: "agent", enabled: true },
	];

	const trimOrNull = (value: string): string | null => {
		const t = value.trim();
		return t.length > 0 ? t : null;
	};
	const httpOrNull = (value: string): string | null => {
		const t = value.trim();
		return /^https?:\/\//i.test(t) ? t : null;
	};

	return {
		id,
		kind: "plugin",
		name: displayName,
		version,
		manifest,
		// The descriptor is the manifest itself for a plugin bundle; Core maps it
		// on install (mirrors the SDK CLI publish body).
		descriptor: manifest,
		grants: [],
		description:
			trimOrNull(listing.description) ?? source.description ?? null,
		tagline: trimOrNull(listing.tagline),
		category: trimOrNull(listing.category),
		developer: null,
		iconUrl: httpOrNull(listing.iconUrl),
		// http(s)-only; a non-URL entry is dropped rather than rejected so the
		// server never stores junk (it re-validates anyway).
		screenshots: listing.screenshots
			.map((s) => httpOrNull(s))
			.filter((s): s is string => s !== null),
		examplePrompts: listing.examplePrompts
			.map((p) => p.trim())
			.filter((p) => p.length > 0),
		capabilities,
		runnables: runnablesView,
	};
}
