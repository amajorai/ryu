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
//     ryu://models/<source>/<id…>             install/switch a model
//     ryu://skills/<source>/<id…>             install a skill
//     ryu://nodes/connect?url=…&token=…&name=…  connect to a Core node
//
// For models/skills, `<source>` names the catalog (huggingface, skills.sh, …) and
// everything after it is the verbatim catalog id (joined by "/", so a Hugging Face
// `author/repo` — INCLUDING a trailing `-GGUF` — survives intact).
//
// SECURITY: a deep link is untrusted input (a malicious page can fire one). This
// module only PARSES; it never installs, connects, or sends a message. Actions go
// through each surface's confirm dialog (the security boundary) and installs are
// pinned to the user's configured catalog source — `<source>` is advisory, not an
// instruction to switch registries. Navigation has no side effect; a `chat`
// prompt only PRE-SEEDS the composer — it is NEVER auto-sent, since the prompt is
// attacker-controllable.
//
// The parser is intentionally written with plain string operations (no `URL`,
// `URLSearchParams`, or `expo-linking`) so it behaves IDENTICALLY across Node,
// browsers, the Tauri webview, and React Native/Hermes — environments whose
// custom-scheme `URL` support historically differs.

export type DeepLinkIntent =
	| { kind: "model"; source: string; id: string }
	| { kind: "skill"; source: string; id: string }
	| { kind: "node"; name: string; url: string; token: string | null }
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
	| { kind: "model"; source: string; id: string }
	| { kind: "skill"; source: string; id: string }
	| { kind: "node"; name: string; url: string; token?: string | null }
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

/** `ryu://models/<source>/<id…>` or `ryu://skills/<source>/<id…>`. */
function parseCatalog(
	category: "models" | "skills",
	pathSegments: string[]
): DeepLinkIntent | null {
	if (pathSegments.length < 2) {
		return null;
	}
	const [source, ...idParts] = pathSegments;
	const id = idParts.join("/");
	if (!(source && id)) {
		return null;
	}
	return category === "models"
		? { kind: "model", source, id }
		: { kind: "skill", source, id };
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
	if (category === "open") {
		const page = pathSegments[0]?.toLowerCase();
		return page ? { kind: "page", page } : null;
	}
	if (category === "chat") {
		return parseChat(pathSegments, params);
	}
	if (category === "models" || category === "skills") {
		return parseCatalog(category, pathSegments);
	}
	return null;
}

/** Percent-encode the reserved characters of a query value (space → `%20`). */
function encodeQueryValue(value: string): string {
	return encodeURIComponent(value);
}

/** Build a `ryu://` deep link from an intent (used to render "Open in Ryu"). */
export function buildRyuDeepLink(intent: DeepLinkBuildInput): string {
	if (intent.kind === "node") {
		const params = [
			`url=${encodeQueryValue(intent.url)}`,
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
	const category = intent.kind === "model" ? "models" : "skills";
	// Keep `/` separators in the id readable; encode each segment's reserved
	// characters so the round-trip through `parseRyuDeepLink` is lossless.
	const idPath = intent.id
		.split("/")
		.map((s) => encodeURIComponent(s))
		.join("/");
	return `ryu://${category}/${encodeURIComponent(intent.source)}/${idPath}`;
}
