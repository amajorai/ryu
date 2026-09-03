// Turn-hook body for `news.ground`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.sideModel / host.runAgent / host.getPreference / host.storage / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// apps-store/*/hooks is excluded from Biome — a module parser rejects it.
//
// THE ONLY CHANNEL TO THE SIDECAR IS KV, AND THIS IS ITS CONTRACT
//
// The corpus lives in the `ryu-news` sidecar, and this sandbox has no HTTP and no
// capability call — deny-by-default, by design. `host.storage` is the whole seam:
// the sidecar POSTs `{method:"storage.set", args:{key, value}}` to
// `/api/host/rpc` at the end of every poll, and this hook reads that one key. Both
// sides omit `namespace`, which Core resolves to the literal `"default"`
// (apps/core/src/plugin_host/bridge.rs) — they agree because neither one names it,
// so do not add a namespace on one side alone.
//
//   key    "headlines.snapshot"
//   value  a JSON string (storage stores strings; `get` returns a string or null):
//
//     {
//       "version": 1,
//       "generated_at": "2026-08-10T09:12:00Z",  // RFC3339, UTC
//       "ttl_secs": 5400,                        // how long this stays usable
//       "stopwords": ["the", "and", …],          // see below — owned by the sidecar
//       "items": [                               // ALREADY RANKED, best first
//         {
//           "id": "ar_3402",
//           "title": "Regulator opens inquiry into the merger",
//           "source": "Reuters",
//           "url": "https://…",                  // the RAW url — what the user clicks
//           "published_at": "2026-08-10T08:55:00Z",
//           "story_id": "st_9f2c",
//           "source_count": 8,
//           "tokens": ["regulator", "inquiry", "merger", …]
//         }
//       ]
//     }
//
// `items` arrives in the sidecar's own rank order (recency decay × source count ×
// topic match × unread) and this hook NEVER re-sorts it. Ranking that is explainable
// in the app and re-derived differently here would be two different feeds wearing
// one name; the hook's only job is to filter and take the first few.
//
// `stopwords` and `tokens` ship in the snapshot on purpose. Token matching only works
// if both sides tokenize identically, and a word list copied into this file would be
// a second source of truth that drifts silently the first time the Rust side is
// tuned. So the sidecar tokenizes the articles, ships the list it used, and this hook
// applies the same rule to the user's message with the same list. The fallback list
// below is a floor for a snapshot written by an older sidecar, not a parallel copy.
//
// CHEAP AND SILENT IS THE POINT
//
// No model call, no agent, one KV read. And it returns `{kind:"none"}` — attaching
// nothing at all — when the flag is off, when the snapshot is missing, unparseable or
// stale, when the message has too little content to match on, or when nothing
// matches. A grounding hook that always injects something turns every message into a
// news query, which is both worse answers and a user who turns the toggle off.

// The Rust pre-gate (`match.flag`) has already checked this, but re-check anyway: the
// gate is manifest-driven and a hook that ran ungated must still do nothing.
if (!(ctx.flags && ctx.flags["io.ryu.news"])) {
	return { kind: "none" };
}

// `pre_user_turn` puts the PENDING message in `ctx.input`; it is not in the
// transcript yet. Reading the transcript here would match the previous message.
const message = (ctx.input || "").trim();
if (!message) {
	return { kind: "none" };
}

let raw;
try {
	raw = await host.storage.get("headlines.snapshot");
} catch (e) {
	return { kind: "none" };
}
if (!raw) {
	return { kind: "none" };
}

let snap;
try {
	snap = JSON.parse(raw);
} catch (e) {
	// A half-written or older-format value is indistinguishable from no news.
	return { kind: "none" };
}
if (!(snap && Array.isArray(snap.items)) || snap.items.length === 0) {
	return { kind: "none" };
}

// Stale beats wrong. If the sidecar is stopped (it is `lazy` with a 15-minute idle
// reap, so it usually is) the last snapshot sits in KV indefinitely, and grounding a
// question in yesterday's headlines while presenting them as recent is the one
// failure mode worth being strict about.
const DEFAULT_TTL_SECS = 5400;
const generatedAt = Date.parse(snap.generated_at || "");
if (!Number.isFinite(generatedAt)) {
	return { kind: "none" };
}
const ttlSecs =
	Number(snap.ttl_secs) > 0 ? Number(snap.ttl_secs) : DEFAULT_TTL_SECS;
const ageSecs = (Date.now() - generatedAt) / 1000;
if (ageSecs > ttlSecs) {
	return { kind: "none" };
}

// Floor for a snapshot written before `stopwords` shipped. Deliberately short — the
// real list belongs to the sidecar.
const FALLBACK_STOPWORDS = [
	"the",
	"a",
	"an",
	"and",
	"or",
	"but",
	"of",
	"to",
	"in",
	"on",
	"for",
	"with",
	"about",
	"from",
	"by",
	"at",
	"as",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"it",
	"its",
	"this",
	"that",
	"these",
	"those",
	"what",
	"whats",
	"which",
	"who",
	"how",
	"why",
	"when",
	"any",
	"some",
	"new",
	"you",
	"your",
	"me",
	"my",
	"i",
	"can",
	"could",
	"would",
	"should",
	"do",
	"does",
	"did",
	"not",
	"there",
	"here",
	"latest",
	"news",
	"tell",
	"give",
	"please",
	"thanks",
];
const stopwords = new Set(
	(Array.isArray(snap.stopwords) && snap.stopwords.length
		? snap.stopwords
		: FALLBACK_STOPWORDS
	).map((w) => String(w).toLowerCase())
);

const MIN_TOKEN_LEN = 3;
function tokenize(text) {
	const out = [];
	const seen = new Set();
	// Split on anything that is not a letter or a digit. `\p{L}`/`\p{N}` rather than
	// `\w` so a non-Latin script is tokenized rather than erased.
	for (const t of String(text)
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)) {
		if (t.length < MIN_TOKEN_LEN || stopwords.has(t) || seen.has(t)) {
			continue;
		}
		seen.add(t);
		out.push(t);
	}
	return out;
}

const messageTokens = tokenize(message);
// One content word is not a question about the news — "thanks", "ok, go on" and a
// bare filename all reduce to nothing worth matching, and matching them is exactly
// how this feature becomes noise.
if (messageTokens.length < 2) {
	return { kind: "none" };
}
const messageSet = new Set(messageTokens);

// A short message has fewer chances to overlap, so one shared content word is enough
// there; a longer one must share two, or a single incidental word ("report",
// "market") would drag in an unrelated story.
const requiredOverlap = messageTokens.length >= 4 ? 2 : 1;
const MAX_ITEMS = 3;

const matched = [];
for (const item of snap.items) {
	if (!(item && item.title && item.url)) {
		continue;
	}
	// Prefer the tokens the sidecar computed; fall back to the title so an item
	// missing them is degraded rather than invisible.
	const itemTokens =
		Array.isArray(item.tokens) && item.tokens.length
			? item.tokens
			: tokenize(item.title);
	let overlap = 0;
	for (const t of itemTokens) {
		if (messageSet.has(String(t).toLowerCase())) {
			overlap += 1;
			if (overlap >= requiredOverlap) {
				break;
			}
		}
	}
	if (overlap < requiredOverlap) {
		continue;
	}
	// Snapshot order is rank order — first match wins, no scoring here.
	matched.push(item);
	if (matched.length >= MAX_ITEMS) {
		break;
	}
}

if (matched.length === 0) {
	return { kind: "none" };
}

const MAX_TITLE_CHARS = 180;
const lines = matched.map((item, idx) => {
	const title = String(item.title).trim().slice(0, MAX_TITLE_CHARS);
	const attribution = [item.source, item.published_at]
		.filter(Boolean)
		.join(", ");
	const spread =
		Number(item.source_count) > 1
			? ` (${item.source_count} outlets covering this story)`
			: "";
	return `${idx + 1}. ${title}${attribution ? ` — ${attribution}` : ""}${spread}\n   ${item.url}`;
});

return {
	kind: "inject",
	text: [
		"Recent items from the user's own news feed (Wire), matched against this message.",
		"These come from sources the user subscribed to and were collected at " +
			snap.generated_at +
			" — they are not a live web search and may not be complete.",
		"Cite the links if you use them, and ignore the list entirely if it does not bear on the question.",
		"",
		lines.join("\n"),
	].join("\n"),
};
