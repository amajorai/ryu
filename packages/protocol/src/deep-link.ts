// @ryuhq/protocol — the canonical, surface-agnostic parser/builder for `ryu://`
// deep links: the scheme that lets a link on any website (or another Ryu surface)
// open the app and jump straight to a destination or action. This is the SINGLE
// source of truth shared by desktop, web, and mobile — previously each surface
// kept its own copy of this grammar and they drifted.
//
// The grammar uses a dedicated authority (host) per intent kind so navigation is
// never ambiguous with an action (cf. Codex's `codex://` scheme):
//
//   NAVIGATION (no confirm — just opens a page/tab):
//     ryu://open/<page>                       e.g. ryu://open/agents, ryu://open/settings
//     ryu://chat/new?prompt=…&agent=…&project=…   new chat, composer pre-seeded
//     ryu://chat/<conversation-id>            open an existing conversation
//
//   ACTIONS (confirm-gated — they install/connect, i.e. have a side effect):
//     ryu://models/<source>/<id…>?node=…      install/switch a model
//     ryu://skills/<source>/<id…>?node=…      install a skill
//     ryu://apps/<id…>?node=…                 install an app (plugin id)
//     ryu://bundles/<id…>?node=…              install a Marketplace bundle
//     ryu://nodes/connect?url=…&token=…&name=…  connect to a Core node
//
// The node link is also the CONNECTION STRING: one line carrying everything a
// surface needs to add a node (address, optional bearer, label), so no surface
// has to make a human copy three fields into three boxes. `buildRyuDeepLink`
// emits its `url` verbatim so the string stays readable —
// `ryu://nodes/connect?url=https://node.example.com&name=prod`.

import { normalizeRnpNodeUrl } from "./continuity.ts";
//
// For models/skills, `<source>` names the catalog (huggingface, skills.sh, …) and
// everything after it is the verbatim catalog id (joined by "/", so a Hugging Face
// `author/repo` — INCLUDING a trailing `-GGUF` — survives intact).
//
// The optional `node` on an install link names WHICH Core node to install onto,
// by its base URL. The URL is the only node identity that means the same thing on
// every surface: web sees a `GatewayCredential.reachableUrl`, desktop stores
// `Node.url`, the CLI stores `nodes.json[].url` — while ids and names live in
// three unrelated namespaces. Omitting `node` means "whichever node the app is
// already on", which is what a signed-out visitor's link always says.
//
// SECURITY: a deep link is untrusted input (a malicious page can fire one). This
// module only PARSES; it never installs, connects, or sends a message. Actions go
// through each surface's confirm dialog (the security boundary) and installs are
// pinned to the user's configured catalog source — `<source>` is advisory, not an
// instruction to switch registries. `node` is advisory in exactly the same way:
// a surface MUST resolve it against nodes the user ALREADY has and fall back to
// the active node when it matches none — never auto-connect to a URL a link
// supplied. Navigation has no side effect; a `chat` prompt only PRE-SEEDS the
// composer — it is NEVER auto-sent, since the prompt is attacker-controllable.
//
// The parser is intentionally written with plain string operations (no `URL`,
// `URLSearchParams`, or `expo-linking`) so it behaves IDENTICALLY across Node,
// browsers, the Tauri webview, and React Native/Hermes — environments whose
// custom-scheme `URL` support historically differs.

export type DeepLinkIntent =
	| { kind: "model"; source: string; id: string; node: string | null }
	| { kind: "skill"; source: string; id: string; node: string | null }
	| { kind: "app"; id: string; node: string | null }
	| { kind: "bundle"; id: string; node: string | null }
	| { kind: "node"; name: string; url: string; token: string | null }
	| {
			kind: "handoff";
			version: 0;
			conversationId: string;
			sourceNodeUrl: string;
	  }
	| { kind: "page"; page: string }
	| {
			kind: "chat";
			conversationId: string | null;
			prompt: string | null;
			agent: string | null;
			project: string | null;
	  };

/**
 * Permissive input accepted by {@link buildRyuDeepLink}. The chat/node fields are
 * optional here (a caller often omits the ones it doesn't set) while the parser
 * always returns the strict {@link DeepLinkIntent} with every field present.
 */
export type DeepLinkBuildInput =
	| { kind: "model"; source: string; id: string; node?: string | null }
	| { kind: "skill"; source: string; id: string; node?: string | null }
	| { kind: "app"; id: string; node?: string | null }
	| { kind: "bundle"; id: string; node?: string | null }
	| { kind: "node"; name: string; url: string; token?: string | null }
	| {
			kind: "handoff";
			version: 0;
			conversationId: string;
			sourceNodeUrl: string;
	  }
	| { kind: "page"; page: string }
	| {
			kind: "chat";
			conversationId?: string | null;
			prompt?: string | null;
			agent?: string | null;
			project?: string | null;
	  };

/**
 * The canonical, surface-agnostic page keys a `ryu://open/<page>` link may target.
 * Each surface maps these to its own route (desktop tabs, mobile Expo routes); an
 * unknown key is ignored rather than erroring.
 */
export const DEEP_LINK_PAGES = [
	"chat",
	"agents",
	"models",
	"skills",
	"tools",
	"spaces",
	"workflows",
	"automations",
	"monitors",
	"marketplace",
	"settings",
	"channels",
	"timeline",
	"delegation",
	"credits",
	"fleet",
	"extensions",
	"apps",
	"engines",
	"store",
	"calendar",
	"services",
] as const;

export type DeepLinkPage = (typeof DEEP_LINK_PAGES)[number];

const SCHEME_PREFIX = /^ryu:\/\//i;
const HTTP_PREFIX = /^https?:\/\//;
const NON_NAME_CHARS = /[^a-zA-Z0-9-]/g;
const TRAILING_SLASHES = /\/+$/;
const EDGE_HYPHENS = /^-+|-+$/g;
const PLUS = /\+/g;

/** A safe, valid node name (alphanumeric + hyphens — Core's `add_node` rule). */
function nodeNameFromUrl(url: string): string {
	const host = url.replace(HTTP_PREFIX, "").split(":")[0] ?? "node";
	const slug = host.replace(NON_NAME_CHARS, "-").replace(EDGE_HYPHENS, "");
	return slug ? `node-${slug}` : "node";
}

/** Percent-decode a segment, tolerating malformed encoding rather than throwing. */
function decodeSafe(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/** Decode a query value: `+` is a space, then percent-decode. */
function decodeQueryValue(value: string): string {
	return decodeSafe(value.replace(PLUS, " "));
}

/**
 * Parse a `&`-joined query string into a key→value map. Plain string parsing so
 * the behaviour matches everywhere (no `URLSearchParams` dependency). Repeated
 * keys keep the first value (the parser only reads single-valued params).
 */
function parseQuery(query: string): Map<string, string> {
	const out = new Map<string, string>();
	if (!query) {
		return out;
	}
	for (const pair of query.split("&")) {
		if (!pair) {
			continue;
		}
		const eq = pair.indexOf("=");
		const rawKey = eq === -1 ? pair : pair.slice(0, eq);
		const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
		const key = decodeQueryValue(rawKey);
		if (!out.has(key)) {
			out.set(key, decodeQueryValue(rawValue));
		}
	}
	return out;
}

function hasExactQueryKeys(
	query: string,
	expected: readonly string[]
): boolean {
	const keys = query
		.split("&")
		.filter(Boolean)
		.map((pair) => decodeQueryValue(pair.split("=", 1)[0] ?? ""));
	return (
		keys.length === expected.length &&
		new Set(keys).size === keys.length &&
		expected.every((key) => keys.includes(key))
	);
}

/** `ryu://nodes/connect?url=…` — the payload lives in the query string. */
function parseNode(params: Map<string, string>): DeepLinkIntent | null {
	const nodeUrl = params.get("url")?.trim();
	if (!nodeUrl) {
		return null;
	}
	const token = params.get("token")?.trim() || null;
	const name = params.get("name")?.trim() || nodeNameFromUrl(nodeUrl);
	return { kind: "node", name, url: nodeUrl, token };
}

/** `ryu://chat/new?…` (composer-seeded) or `ryu://chat/<id>` (open existing). */
function parseChat(
	pathSegments: string[],
	params: Map<string, string>
): DeepLinkIntent {
	const first = pathSegments[0];
	const conversationId = !first || first === "new" ? null : first;
	const trimmedOrNull = (key: string) => params.get(key)?.trim() || null;
	return {
		kind: "chat",
		conversationId,
		prompt: trimmedOrNull("prompt"),
		agent: trimmedOrNull("agent"),
		project: trimmedOrNull("project"),
	};
}

/**
 * Normalize an install link's `node` hint: a node base URL, or null when absent
 * or not an http(s) URL. Rejecting every other scheme here means a surface can
 * never be handed a `file:`/`javascript:` "node" to resolve. The trailing slash
 * is dropped so the value compares equal to a stored node url.
 */
function parseNodeHint(params: Map<string, string>): string | null {
	const raw = params.get("node")?.trim();
	if (!(raw && HTTP_PREFIX.test(raw))) {
		return null;
	}
	return raw.replace(TRAILING_SLASHES, "");
}

/** `ryu://models/<source>/<id…>` or `ryu://skills/<source>/<id…>`. */
function parseCatalog(
	category: "models" | "skills",
	pathSegments: string[],
	params: Map<string, string>
): DeepLinkIntent | null {
	if (pathSegments.length < 2) {
		return null;
	}
	const [source, ...idParts] = pathSegments;
	const id = idParts.join("/");
	if (!(source && id)) {
		return null;
	}
	const node = parseNodeHint(params);
	return category === "models"
		? { kind: "model", source, id, node }
		: { kind: "skill", source, id, node };
}

/** Split a trimmed `ryu://` link into its category (host), path, and query. */
function splitDeepLink(
	raw: string
): { category: string; pathStr: string; query: string } | null {
	const trimmed = raw.trim();
	const scheme = SCHEME_PREFIX.exec(trimmed);
	if (!scheme) {
		return null;
	}
	let rest = trimmed.slice(scheme[0].length);
	const hash = rest.indexOf("#");
	if (hash !== -1) {
		rest = rest.slice(0, hash);
	}
	let query = "";
	const qmark = rest.indexOf("?");
	if (qmark !== -1) {
		query = rest.slice(qmark + 1);
		rest = rest.slice(0, qmark);
	}
	const firstSlash = rest.indexOf("/");
	const category = (firstSlash === -1 ? rest : rest.slice(0, firstSlash))
		.trim()
		.toLowerCase();
	const pathStr = firstSlash === -1 ? "" : rest.slice(firstSlash + 1);
	return { category, pathStr, query };
}

/**
 * Parse a `ryu://` URL into an intent, or `null` when it is not a deep link we
 * understand. Tolerant of trailing slashes and percent-encoding; the id keeps
 * its original case and any `-GGUF` suffix.
 */
export function parseRyuDeepLink(raw: string): DeepLinkIntent | null {
	const parts = splitDeepLink(raw);
	if (!parts) {
		return null;
	}
	const { category, pathStr, query } = parts;
	const params = parseQuery(query);
	if (category === "nodes") {
		return parseNode(params);
	}
	const pathSegments = pathStr.split("/").filter(Boolean).map(decodeSafe);
	if (category === "handoff") {
		if (!hasExactQueryKeys(query, ["source", "v"])) {
			return null;
		}
		const conversationId = pathSegments.length === 1 ? pathSegments[0] : null;
		const sourceNodeUrl = normalizeRnpNodeUrl(params.get("source") ?? "");
		return conversationId && sourceNodeUrl && params.get("v") === "0"
			? { kind: "handoff", version: 0, conversationId, sourceNodeUrl }
			: null;
	}
	if (category === "open") {
		const page = pathSegments[0]?.toLowerCase();
		return page ? { kind: "page", page } : null;
	}
	if (category === "chat") {
		return parseChat(pathSegments, params);
	}
	if (category === "models" || category === "skills") {
		return parseCatalog(category, pathSegments, params);
	}
	if (category === "apps") {
		// No `<source>` — everything after `apps/` is the plugin id itself
		// (a scoped `@ryu/clips` is two segments, a reverse-DNS `com.ryu.x` is one).
		const id = pathSegments.join("/");
		if (!id) {
			return null;
		}
		return { kind: "app", id, node: parseNodeHint(params) };
	}
	if (category === "bundles") {
		const id = pathSegments.join("/");
		return id ? { kind: "bundle", id, node: parseNodeHint(params) } : null;
	}
	return null;
}

/** Percent-encode the reserved characters of a query value (space → `%20`). */
function encodeQueryValue(value: string): string {
	return encodeURIComponent(value);
}

/** Build a `ryu://` deep link from an intent (used to render "Open in Ryu"). */
export function buildRyuDeepLink(intent: DeepLinkBuildInput): string {
	if (intent.kind === "handoff") {
		const sourceNodeUrl = normalizeRnpNodeUrl(intent.sourceNodeUrl);
		if (!sourceNodeUrl) {
			throw new Error("A handoff link requires a safe HTTP source node URL.");
		}
		return `ryu://handoff/${encodeURIComponent(intent.conversationId)}?source=${encodeQueryValue(sourceNodeUrl)}&v=0`;
	}
	if (intent.kind === "node") {
		// The node link doubles as the CONNECTION STRING a user copies, pastes into
		// another surface's "Add node" field, or reads off a QR — so the base URL is
		// emitted verbatim rather than percent-encoded. It round-trips regardless:
		// `parseQuery` splits on `&`/`=` only and `decodeQueryValue` is identity on
		// a URL that contains neither `%` nor `+`, which a node base URL never does.
		// A percent-encoded url still parses, so links built by older surfaces stay
		// valid.
		const params = [
			`url=${intent.url}`,
			`name=${encodeQueryValue(intent.name)}`,
		];
		if (intent.token) {
			params.push(`token=${encodeQueryValue(intent.token)}`);
		}
		return `ryu://nodes/connect?${params.join("&")}`;
	}
	if (intent.kind === "page") {
		return `ryu://open/${encodeURIComponent(intent.page)}`;
	}
	if (intent.kind === "chat") {
		const params: string[] = [];
		if (intent.prompt) {
			params.push(`prompt=${encodeQueryValue(intent.prompt)}`);
		}
		if (intent.agent) {
			params.push(`agent=${encodeQueryValue(intent.agent)}`);
		}
		if (intent.project) {
			params.push(`project=${encodeQueryValue(intent.project)}`);
		}
		const path = intent.conversationId
			? encodeURIComponent(intent.conversationId)
			: "new";
		const query = params.join("&");
		return `ryu://chat/${path}${query ? `?${query}` : ""}`;
	}
	// Keep `/` separators in the id readable; encode each segment's reserved
	// characters so the round-trip through `parseRyuDeepLink` is lossless.
	const idPath = intent.id
		.split("/")
		.map((s) => encodeURIComponent(s))
		.join("/");
	// An app has no catalog `<source>` — its id IS the plugin id.
	const base =
		intent.kind === "app"
			? `ryu://apps/${idPath}`
			: intent.kind === "bundle"
				? `ryu://bundles/${idPath}`
				: `ryu://${intent.kind === "model" ? "models" : "skills"}/${encodeURIComponent(intent.source)}/${idPath}`;
	// Only an http(s) node url is emitted, matching what the parser will accept —
	// a builder that emitted more than the parser reads would drift immediately.
	const node = intent.node?.trim();
	return node && HTTP_PREFIX.test(node)
		? `${base}?node=${encodeQueryValue(node.replace(TRAILING_SLASHES, ""))}`
		: base;
}
