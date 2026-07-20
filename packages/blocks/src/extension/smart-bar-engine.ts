// Smart-bar routing engine.
//
// A single text field that, like the Dia/Arc command bar, decides what the
// user meant: open a URL, run a web search, ask the AI, invoke a skill, or
// route to a search engine via a bang. The URL-vs-not split is the classic
// deterministic omnibox heuristic (fully reliable); the search-vs-AI split is
// a lightweight approximation of an intent classifier (a guess the UI always
// shows before acting, so a wrong guess is one Tab away from correction).
//
// This module is PURE and dependency-free so both the new-tab page and the
// background omnibox handler can share exactly one source of truth.

export type SearchEngineId = "google" | "duckduckgo" | "bing";

export interface SearchEngine {
	buildUrl: (query: string) => string;
	id: SearchEngineId;
	label: string;
}

export const SEARCH_ENGINES: Record<SearchEngineId, SearchEngine> = {
	google: {
		id: "google",
		label: "Google",
		buildUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
	},
	duckduckgo: {
		id: "duckduckgo",
		label: "DuckDuckGo",
		buildUrl: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
	},
	bing: {
		id: "bing",
		label: "Bing",
		buildUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
	},
};

export const DEFAULT_ENGINE: SearchEngineId = "google";

// "Bangs": !keyword routes the rest of the query straight to a destination.
// Each entry takes the query (may be empty) and returns a URL.
export const BANGS: Record<
	string,
	{ build: (q: string) => string; label: string }
> = {
	g: { label: "Google", build: (q) => SEARCH_ENGINES.google.buildUrl(q) },
	ddg: {
		label: "DuckDuckGo",
		build: (q) => SEARCH_ENGINES.duckduckgo.buildUrl(q),
	},
	b: { label: "Bing", build: (q) => SEARCH_ENGINES.bing.buildUrl(q) },
	yt: {
		label: "YouTube",
		build: (q) =>
			`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
	},
	gh: {
		label: "GitHub",
		build: (q) =>
			`https://github.com/search?q=${encodeURIComponent(q)}&type=repositories`,
	},
	w: {
		label: "Wikipedia",
		build: (q) =>
			`https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`,
	},
	npm: {
		label: "npm",
		build: (q) => `https://www.npmjs.com/search?q=${encodeURIComponent(q)}`,
	},
	so: {
		label: "Stack Overflow",
		build: (q) => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}`,
	},
	mdn: {
		label: "MDN",
		build: (q) =>
			`https://developer.mozilla.org/en-US/search?q=${encodeURIComponent(q)}`,
	},
	a: {
		label: "Amazon",
		build: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
	},
	maps: {
		label: "Google Maps",
		build: (q) => `https://www.google.com/maps/search/${encodeURIComponent(q)}`,
	},
};

// A reasonably complete set of common TLDs. The bar feels "dumb" the moment a
// real domain (foo.dev, bar.xyz) gets sent to search instead of navigated, so
// this is data, not a toy list. Kept as one named constant for that reason.
// Source: the most-registered gTLDs/ccTLDs; extend freely.
const COMMON_TLDS = new Set<string>([
	// generic
	"com",
	"org",
	"net",
	"io",
	"co",
	"dev",
	"app",
	"ai",
	"xyz",
	"info",
	"biz",
	"online",
	"site",
	"tech",
	"store",
	"blog",
	"page",
	"cloud",
	"design",
	"fm",
	"gg",
	"sh",
	"to",
	"tv",
	"me",
	"cc",
	"ws",
	"name",
	"pro",
	"mobi",
	"live",
	"news",
	"media",
	"studio",
	"agency",
	"digital",
	"world",
	"life",
	"today",
	"email",
	"chat",
	"games",
	"game",
	"social",
	"network",
	"systems",
	"software",
	"tools",
	"wiki",
	"ninja",
	"rocks",
	"space",
	"fun",
	"run",
	"build",
	"new",
	"gov",
	"edu",
	"mil",
	"int",
	// country / regional
	"us",
	"uk",
	"ca",
	"au",
	"de",
	"fr",
	"es",
	"it",
	"nl",
	"se",
	"no",
	"fi",
	"dk",
	"pl",
	"ru",
	"ua",
	"jp",
	"cn",
	"kr",
	"in",
	"br",
	"mx",
	"ar",
	"cl",
	"za",
	"sg",
	"hk",
	"tw",
	"my",
	"id",
	"ph",
	"th",
	"vn",
	"nz",
	"ie",
	"ch",
	"at",
	"be",
	"pt",
	"gr",
	"cz",
	"ro",
	"hu",
	"il",
	"tr",
	"sa",
	"ae",
	"eu",
	// common second-level patterns are handled by the TLD check on the last label
]);

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const SAFE_SCHEME_RE = /^(https?|ftp|file):/i;
const DANGEROUS_SCHEME_RE = /^(javascript|data|vbscript|blob|about|chrome):/i;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/;
const IPV6_RE = /^\[[0-9a-f:]+\](:\d+)?(\/.*)?$/i;
const LOCALHOST_RE = /^localhost(:\d+)?(\/.*)?$/i;
const HOSTLIKE_RE =
	/^([a-z0-9-]+\.)+[a-z0-9-]+(:\d+)?(\/[^\s]*)?(\?[^\s]*)?(#[^\s]*)?$/i;
const QUESTION_WORDS_RE =
	/^(who|what|when|where|why|how|which|whose|whom|is|are|can|could|should|would|do|does|did|will|explain|summari[sz]e|write|draft|translate|compare|generate|create|make|build|give me|tell me|help me|find me)\b/i;
const WHITESPACE_RE = /\s/;
const WHITESPACE_SPLIT_RE = /\s+/;
const FIRST_DELIM_RE = /[.:?]/;
const HOST_SPLIT_RE = /[/:?#]/;
const MENTION_RE = /@(\w+)/g;

export type SmartIntent =
	| { kind: "navigate"; label: string; url: string }
	| {
			engine: SearchEngineId;
			kind: "search";
			label: string;
			query: string;
			url: string;
	  }
	| { kind: "ai"; label: string; prompt: string }
	| { kind: "skill"; label: string; name: string; rest: string }
	| { kind: "mention"; label: string; rest: string; targets: string[] }
	| { bang: string; kind: "bang"; label: string; query: string; url: string };

export interface RouteResult {
	/** Ordered fallbacks the user can cycle to with Tab; never includes primary. */
	alternatives: SmartIntent[];
	/** Best guess for what Enter should do. */
	primary: SmartIntent;
}

/** Add an https:// scheme when the input omits one. */
export function normalizeUrl(raw: string): string {
	return SCHEME_RE.test(raw) ? raw : `https://${raw}`;
}

function lastLabelTld(host: string): string {
	const labels = host.split(".");
	return (labels.at(-1) ?? "").toLowerCase();
}

/** Deterministic "is this a URL?" check, mirroring browser omnibox behaviour. */
export function looksLikeUrl(input: string): boolean {
	const s = input.trim();
	if (s.length === 0) {
		return false;
	}

	// A space before the first . : ? means it's prose, not a host.
	if (WHITESPACE_RE.test(s)) {
		const firstDelim = s.search(FIRST_DELIM_RE);
		const firstSpace = s.search(WHITESPACE_RE);
		if (firstDelim === -1 || firstSpace < firstDelim) {
			return false;
		}
	}

	// Dangerous schemes are never navigations (file: is allowed).
	if (DANGEROUS_SCHEME_RE.test(s)) {
		return false;
	}
	// Explicit safe web scheme, or localhost / IP / host:port literals.
	if (SAFE_SCHEME_RE.test(s)) {
		return true;
	}
	if (LOCALHOST_RE.test(s) || IPV4_RE.test(s) || IPV6_RE.test(s)) {
		return true;
	}
	// Any other custom scheme:// form is left to search.
	if (SCHEME_RE.test(s) || !HOSTLIKE_RE.test(s)) {
		return false;
	}

	const host = s.split(HOST_SPLIT_RE)[0];
	return COMMON_TLDS.has(lastLabelTld(host));
}

/** Heuristic stand-in for Dia's ML search-vs-AI classifier. */
export function looksLikeQuestion(input: string): boolean {
	const s = input.trim();
	if (s.endsWith("?")) {
		return true;
	}
	if (QUESTION_WORDS_RE.test(s)) {
		return true;
	}
	return s.split(WHITESPACE_SPLIT_RE).length >= 6;
}

function navigateIntent(input: string): SmartIntent {
	const url = normalizeUrl(input.trim());
	let host = input.trim();
	try {
		host = new URL(url).host;
	} catch {
		// keep raw input as the label host
	}
	return { kind: "navigate", url, label: `Go to ${host}` };
}

function searchIntent(query: string, engineId: SearchEngineId): SmartIntent {
	const engine = SEARCH_ENGINES[engineId];
	return {
		kind: "search",
		engine: engineId,
		query,
		url: engine.buildUrl(query),
		label: `Search ${engine.label}`,
	};
}

function aiIntent(prompt: string): SmartIntent {
	return { kind: "ai", prompt, label: "Ask Ryu" };
}

/**
 * Classify raw input into a primary route plus ordered Tab-cycle alternatives.
 * Explicit prefixes (/ @ ! ?) are unambiguous and have no alternatives.
 */
export function route(
	raw: string,
	engineId: SearchEngineId = DEFAULT_ENGINE
): RouteResult {
	const input = raw.trim();

	if (input.length === 0) {
		return { primary: aiIntent(""), alternatives: [] };
	}

	// Explicit overrides win and do not offer a cycle.
	if (input.startsWith("/")) {
		const [name, ...rest] = input.slice(1).split(WHITESPACE_SPLIT_RE);
		return {
			primary: {
				kind: "skill",
				name,
				rest: rest.join(" "),
				label: name ? `Run /${name}` : "Pick a skill",
			},
			alternatives: [],
		};
	}
	if (input.startsWith("@")) {
		const targets = [...input.matchAll(MENTION_RE)].map((m) => m[1]);
		return {
			primary: {
				kind: "mention",
				targets,
				rest: input,
				label: `Ask Ryu with ${targets.map((t) => `@${t}`).join(" ")}`,
			},
			alternatives: [],
		};
	}
	if (input.startsWith("!")) {
		const [bang, ...rest] = input.slice(1).split(WHITESPACE_SPLIT_RE);
		const query = rest.join(" ");
		const entry = BANGS[bang?.toLowerCase()];
		if (entry) {
			return {
				primary: {
					kind: "bang",
					bang,
					query,
					url: entry.build(query),
					label: `${entry.label} ${query}`.trim(),
				},
				alternatives: [],
			};
		}
		// Unknown bang: treat the whole thing as a search.
		return {
			primary: searchIntent(input.slice(1), engineId),
			alternatives: [],
		};
	}
	if (input.startsWith("?")) {
		return {
			primary: searchIntent(input.slice(1).trim(), engineId),
			alternatives: [aiIntent(input.slice(1).trim())],
		};
	}

	// Implicit routing with a visible, cyclable fallback chain.
	if (looksLikeUrl(input)) {
		return {
			primary: navigateIntent(input),
			alternatives: [searchIntent(input, engineId), aiIntent(input)],
		};
	}
	if (looksLikeQuestion(input)) {
		return {
			primary: aiIntent(input),
			alternatives: [searchIntent(input, engineId)],
		};
	}
	return {
		primary: searchIntent(input, engineId),
		alternatives: [aiIntent(input)],
	};
}
