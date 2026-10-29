import {
	type GhostAvatarAppearance,
	parseGhostAvatar,
} from "@ryu/ui/components/ghost-avatar.ts";
import type { AgentIdentityMode } from "@/src/lib/api/agents.ts";
// apps/desktop/src/lib/publish/packaging.ts
//
// Universal "Publish" packaging (Phase 5a): turn a Runnable's SHAREABLE config
// into a Ryu plugin manifest + marketplace publish body, so a user can publish
// their own agent to the marketplace from inside the desktop app.
//
// An agent publishes under the marketplace's own `agent` kind: the body carries
// a FLAT, snake_case `descriptor` that declares what the agent is (instructions,
// model preference) and what it expects the installer to already have (tools,
// skills, Composio actions, Spaces by name, provider connections). It is not a
// plugin bundle — an agent carries no code, so it ships no manifest surface.
//
// The descriptor is re-validated at the publish boundary
// (`validateAgentDescriptor`, packages/api marketplace router) against a key
// ALLOWLIST: an unknown key is a 400, and four publisher-state keys
// (`identity_profile_ids`, `memory`, `space_ids`, `policy_ref`) are refused by
// name. Building exactly that shape here is therefore not defensive duplication
// — it is the contract, and {@link buildAgentDescriptor} is the single place it
// is expressed so the Publish dialog's disclosure can render the very object
// that gets sent rather than a prose approximation of it.
//
// SECURITY — never package secrets. This module serializes ONLY agent-record
// fields, and the agent record carries no keys: BYOK/gateway keys live behind
// separate endpoints (the AgentEditPage ByoaPanel fetches them independently),
// never on the record. On top of that it deliberately EXCLUDES per-user and
// node-local bindings that would either leak or fail to port:
//   - Identity Vault profile bindings (per-user credentials)
//   - the account allowlist (`account_access`: the publisher's own Composio,
//     MCP, provider and vault account ids, which resolve to nothing elsewhere)
//   - Memory / Spaces space_ids (node-local Space identifiers)
//   - a custom `acp-exec:<command>` engine (a local binary path/command)
// The identity mode (`identity_mode`) DOES travel: it says whose accounts the
// agent works with (yours, its own, or both), never which ones, so it binds
// none of the publisher's accounts. The installer sees it before adding the
// agent and narrows which of their accounts it may use afterwards.
// The result is a portable "Pokémon card" definition — persona + model slot +
// identity mode + tool/skill declarations — and nothing else. This matches Core's own portable
// `AgentTemplate` (apps/core exportAgent), which likewise carries only
// description / system_prompt / tools / engine / model / identity_mode.

/** The publish `kind`. An agent publishes as `agent`; `plugin` stays for a
 *  manifest bundle (code), which an agent definition never is. */
export type PublishKind = "plugin" | "agent";

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
const CAPABILITY_LABELS = new Map([
	["web_scrape", "Web scraping"],
	["web_search", "Web search"],
	["web_browse", "Web browsing"],
	["file_read", "Read files"],
	["file_write", "Write files"],
	["code_execute", "Run code"],
	["semantic_search", "Semantic search"],
	["search", "Search"],
]);

const CAP_SEPARATORS_RE = /[._\-:/\s]+/;

/** Turn a raw tool/action name into a readable capability label. */
function humanizeCapability(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		return "";
	}
	const lower = trimmed.toLowerCase();
	const known = CAPABILITY_LABELS.get(lower);
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
	descriptor: AgentDescriptor;
	developer: string | null;
	examplePrompts: string[];
	/** Requested permission grants. Always empty in 5a: an empty set is
	 *  auto-approved by the Gateway (no 403/502), and the human `capabilities`
	 *  above carry the display. */
	grants: string[];
	iconUrl: string | null;
	id: string;
	kind: PublishKind;
	manifest: AgentPublishManifest;
	name: string;
	runnables: PublishRunnableView[];
	screenshots: string[];
	tagline: string | null;
	version: string;
}

/** Provenance-only manifest emitted for an agent listing. */
export interface AgentPublishManifest {
	id: string;
	kind: PublishKind;
	name: string;
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
 * `identityProfileIds`, `accountAccess` or `memory.space_ids`, so they cannot be
 * packaged by construction.
 */
export interface AgentPublishSource {
	composioActions: string[];
	description: string | null;
	/** Engine/model slot as stored on the record. A custom `acp-exec:` command is
	 *  scrubbed here (a local binary path is never shipped). */
	engine: string | null;
	/** Space NAMES the agent expects to find. Names, never the record's
	 *  `memory.space_ids`: an id resolves to a row only the publisher has, which
	 *  is why the publish boundary refuses `space_ids` by name and asks for this
	 *  instead. The installer decides whether to create a matching Space. */
	expectedSpaces: string[];
	/** Whose accounts the agent works with. Portable: it names whose accounts,
	 *  never which. Omitted reads as `managed`, Core's install default. */
	identityMode?: AgentIdentityMode;
	/** How the agent presents itself. Pure presentation — a glyph, a tone. */
	persona: AgentPublishPersona | null;
	skills: string[];
	systemPrompt: string | null;
	tools: string[];
	/** Semver version to stamp on the listing. */
	version: string;
}

/**
 * The persona fields that travel, in the record's own snake_case (what
 * `glyphToPersonaFields` produces). `display_name` is deliberately absent: the
 * listing title is the display name, and carrying a second one would let a
 * listing render under a name the store never moderated.
 */
export interface AgentPublishPersona {
	avatar_style?: {
		palette?: string | null;
		parts?: Record<string, string> | null;
		seed?: string | null;
		style?: string | null;
	} | null;
	avatar_url?: string | null;
	dicebear?: { seed?: string | null; style?: string | null } | null;
	dither?: {
		direction?: string | null;
		from?: string | null;
		to?: string | null;
	} | null;
	emoji?: string | null;
	expressive?:
		| (GhostAvatarAppearance & {
				animation?: string | null;
				expression?: string | null;
		  })
		| null;
	icon?: string | null;
	icon_color?: string | null;
	tone?: string | null;
}

// ── The `agent` descriptor (the wire contract, and the disclosure's source) ───

/** A Space the agent expects the installer to have — a name, never its contents. */
export interface AgentSpaceDeclaration {
	name: string;
	purpose: string | null;
}

/** A provider connection the agent needs the installer to hold — never a token. */
export interface AgentConnectionDeclaration {
	provider: string;
	purpose: string | null;
	required: boolean;
}

/** The model/engine preference, mirroring Core's `ModelSlot`. */
export interface AgentModelDeclaration {
	engine: string | null;
	model_id: string | null;
}

/** How the agent presents itself: a glyph source plus an optional tone. */
export interface AgentAvatarDeclaration {
	/** A marketplace avatar style. Present only when the agent uses one; an
	 *  installer without the style's plugin sees the fallback avatar. */
	avatar_style?: {
		palette?: string;
		parts?: Record<string, string>;
		seed: string;
		style: string;
	};
	avatar_url: string | null;
	dicebear: { seed: string | null; style: string | null } | null;
	dither: {
		direction: string | null;
		from: string | null;
		to: string | null;
	} | null;
	emoji: string | null;
	expressive:
		| (GhostAvatarAppearance & {
				animation: string | null;
				expression: string | null;
		  })
		| null;
	icon: string | null;
	icon_color: string | null;
	tone: string | null;
}

/** The flat `agent` descriptor stored by the marketplace. Every key here is on
 *  the publish boundary's allowlist; anything else is a 400. */
export interface AgentDescriptor {
	avatar: AgentAvatarDeclaration | null;
	composio_actions: string[];
	connections: AgentConnectionDeclaration[];
	display_name: string;
	identity_mode: AgentIdentityMode;
	mcp_servers: string[];
	model: AgentModelDeclaration | null;
	skills: string[];
	spaces: AgentSpaceDeclaration[];
	system_prompt: string;
	tools: string[];
}

/** What the packaging did to the source that the publisher should be told. */
export interface AgentPublishNotes {
	/** The publish would be refused for this reason, or null when the agent is
	 *  publishable. Checked here rather than left to the server so the dialog can
	 *  say so before the user submits. */
	blockedReason: string | null;
	/** The agent's avatar is an inline `data:` image, which the publish boundary
	 *  accepts only as an http(s) URL — so the listing ships without the image. */
	droppedAvatarImage: boolean;
	/** The engine is a local `acp-exec:` command; the model preference is dropped
	 *  rather than shipping a path off this machine. */
	droppedLocalCommand: boolean;
}

/** The descriptor plus what building it changed. */
export interface AgentPublishPackage {
	descriptor: AgentDescriptor;
	notes: AgentPublishNotes;
}

const HTTP_URL_RE = /^https?:\/\//i;
// Composio ids arrive either as the raw action slug (`GITHUB_CREATE_AN_ISSUE`)
// or with the tool-allowlist prefix Core merges them under (`composio.…`).
const COMPOSIO_PREFIX_RE = /^composio./i;

function trimOrNull(value: string | null | undefined): string | null {
	const trimmed = (value ?? "").trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * The provider behind a Composio action id. Composio names actions
 * `<TOOLKIT>_<ACTION>`, so the first segment is the toolkit — which is exactly
 * the account the installer has to have connected for the action to run.
 */
function composioProvider(action: string): string | null {
	const bare = action.trim().replace(COMPOSIO_PREFIX_RE, "");
	const [toolkit] = bare.split("_");
	return trimOrNull(toolkit)?.toLowerCase() ?? null;
}

/**
 * The connections an agent needs, derived from its Composio actions. Declaring
 * the PROVIDER (not the publisher's connected account) is the whole point: the
 * installer reads "this needs your GitHub" and connects their own.
 */
function deriveConnections(
	composioActions: string[]
): AgentConnectionDeclaration[] {
	const seen = new Set<string>();
	const out: AgentConnectionDeclaration[] = [];
	for (const action of composioActions) {
		const provider = composioProvider(action);
		if (!provider || seen.has(provider)) {
			continue;
		}
		seen.add(provider);
		out.push({
			provider,
			purpose: null,
			// A connection an agent's actions call is one it will not work without.
			required: true,
		});
	}
	return out;
}

interface AgentAvatarPackage {
	avatar: AgentAvatarDeclaration | null;
	droppedImage: boolean;
}

/** Rebuild the avatar declaration, dropping an inline `data:` image. */
function buildAvatar(persona: AgentPublishPersona | null): AgentAvatarPackage {
	if (!persona) {
		return { avatar: null, droppedImage: false };
	}
	const rawUrl = trimOrNull(persona.avatar_url);
	const httpUrl = rawUrl && HTTP_URL_RE.test(rawUrl) ? rawUrl : null;
	const dicebear = persona.dicebear
		? {
				seed: trimOrNull(persona.dicebear.seed),
				style: trimOrNull(persona.dicebear.style),
			}
		: null;
	const dither = persona.dither
		? {
				direction: trimOrNull(persona.dither.direction),
				from: trimOrNull(persona.dither.from),
				to: trimOrNull(persona.dither.to),
			}
		: null;
	const expressive = persona.expressive
		? {
				...parseGhostAvatar(persona.expressive),
				animation: trimOrNull(persona.expressive.animation),
				expression: trimOrNull(persona.expressive.expression),
			}
		: null;
	const avatar: AgentAvatarDeclaration = {
		avatar_url: httpUrl,
		dicebear: dicebear?.seed || dicebear?.style ? dicebear : null,
		dither: dither?.from || dither?.to ? dither : null,
		expressive:
			expressive?.expression || expressive?.animation ? expressive : null,
		emoji: trimOrNull(persona.emoji),
		icon: trimOrNull(persona.icon),
		icon_color: trimOrNull(persona.icon_color),
		tone: trimOrNull(persona.tone),
	};
	const styleId = trimOrNull(persona.avatar_style?.style);
	const styleSeed = trimOrNull(persona.avatar_style?.seed);
	if (styleId && styleSeed) {
		const palette = trimOrNull(persona.avatar_style?.palette);
		const parts = persona.avatar_style?.parts;
		avatar.avatar_style = {
			style: styleId,
			seed: styleSeed,
			...(palette ? { palette } : undefined),
			...(parts && Object.keys(parts).length ? { parts } : undefined),
		};
	}
	// Every glyph source counts, not just the uploaded image: a DiceBear-only or
	// dither-only avatar is a complete avatar. `icon_color`/`tone` are modifiers.
	const hasGlyph = Boolean(
		avatar.avatar_url ||
			avatar.emoji ||
			avatar.icon ||
			avatar.dicebear ||
			avatar.dither ||
			avatar.expressive ||
			avatar.avatar_style
	);
	return {
		avatar: hasGlyph || avatar.tone ? avatar : null,
		droppedImage: Boolean(rawUrl && !httpUrl),
	};
}

/**
 * Build the `agent` descriptor — the exact object that leaves this machine.
 *
 * Pure and exported so the Publish dialog's disclosure renders THIS result
 * rather than a hand-written summary of it: a disclosure that can drift from the
 * payload is not a disclosure.
 */
export function buildAgentDescriptor(
	source: AgentPublishSource,
	displayName: string
): AgentPublishPackage {
	const name = displayName.trim();
	const systemPrompt = (source.systemPrompt ?? "").trim();
	const localCommand = isLocalAcpCommand(source.engine);
	const engine = localCommand ? null : trimOrNull(source.engine);
	const { avatar, droppedImage } = buildAvatar(source.persona);

	const spaces: AgentSpaceDeclaration[] = [];
	const seenSpaces = new Set<string>();
	for (const raw of source.expectedSpaces) {
		const spaceName = trimOrNull(raw);
		if (!spaceName || seenSpaces.has(spaceName)) {
			continue;
		}
		seenSpaces.add(spaceName);
		spaces.push({ name: spaceName, purpose: null });
	}

	// Only the SOURCE's own blockers live here — the display name is the dialog's
	// field and the dialog validates it, so duplicating that check would report a
	// stale name the user has already fixed in front of them.
	const blockedReason = systemPrompt
		? null
		: "This agent has no instructions to share. Instructions are what someone installs an agent for, so the marketplace refuses a publish without them.";

	return {
		descriptor: {
			display_name: name,
			system_prompt: systemPrompt,
			identity_mode: source.identityMode ?? "managed",
			avatar,
			// `model_id` stays null: the record binds ONE engine/model string, and
			// splitting it into a second field here would invent a precision the
			// source does not have.
			model: engine ? { engine, model_id: null } : null,
			tools: source.tools,
			skills: source.skills,
			// The record binds tool NAMES, not the servers behind them, so there is
			// no honest server list to declare. `tools` carries the dependency and
			// the installer sees it in `requires` either way.
			mcp_servers: [],
			composio_actions: source.composioActions,
			spaces,
			connections: deriveConnections(source.composioActions),
		},
		notes: {
			blockedReason,
			droppedAvatarImage: droppedImage,
			droppedLocalCommand: localCommand,
		},
	};
}

/** True when the engine is a custom local ACP command (never shippable). */
function isLocalAcpCommand(engine: string | null): boolean {
	return engine?.startsWith(ACP_EXEC_PREFIX) ?? false;
}

function httpOrNull(value: string): string | null {
	const trimmed = value.trim();
	return HTTP_URL_RE.test(trimmed) ? trimmed : null;
}

/**
 * Build the marketplace publish body for an agent: the `agent`-kind listing
 * metadata wrapped around the descriptor {@link buildAgentDescriptor} produced.
 *
 * `body.name` is the HUMAN display name (the listing title); `body.id` is the
 * bare-kebab id (the slug, the unique ownership key) — do not conflate them.
 *
 * The `manifest` is a stub — id/name/version and nothing else. An agent carries
 * no executable content, so there is nothing for a manifest to describe; the
 * field exists because the publish route signs one for provenance, and shipping
 * a fabricated plugin bundle there would claim a code surface that isn't real.
 */
export function buildAgentPublishBody(
	source: AgentPublishSource,
	listing: PublishListing
): PublishBody {
	const slug = toKebab(listing.slug) || toKebab(listing.displayName) || "agent";
	const id = slug;
	const displayName = listing.displayName.trim() || slug;
	const version = source.version || "1.0.0";
	const { descriptor } = buildAgentDescriptor(source, displayName);

	return {
		id,
		kind: "agent",
		name: displayName,
		version,
		manifest: { id, name: displayName, version, kind: "agent" },
		descriptor,
		// Declarations only, kept EMPTY so the publish is auto-approved (an empty
		// grant set short-circuits the Gateway validation). An agent runs under the
		// installer's own grants; the human capabilities below carry the display.
		grants: [],
		description: trimOrNull(listing.description) ?? source.description ?? null,
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
		capabilities: deriveCapabilities(source.tools, source.composioActions),
		// A listing that IS the agent bundles no separate runnables.
		runnables: [],
	};
}
