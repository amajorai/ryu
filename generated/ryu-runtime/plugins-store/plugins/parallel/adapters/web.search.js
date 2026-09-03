// Capability adapter for `web.search / web.search`, run in Core's plugin sandbox.
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (crates/core/tool-exec `build_capability_adapter_program`) and it `return`s the
// canonical result. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/adapters is excluded from Biome — a module parser rejects it.
//
// WHY THIS NEEDS AN ADAPTER AT ALL — three reasons, none of them cosmetic:
//   1. Parallel search takes TWO required inputs (`objective` + `search_queries`),
//      and the canonical verb supplies ONE (`query`). A declarative `args` map is
//      1:1, so it cannot fan one input out to both.
//   2. There is NO result-count parameter anywhere in Parallel's search — not in
//      the REST body (`V1SearchRequest` is `additionalProperties: false`, so
//      inventing one is a 4xx) and not in the MCP tool. `limit` therefore has to
//      be applied client-side, here.
//   3. Parallel's per-result `excerpts` is an ARRAY of markdown blocks; the
//      canonical `snippet` is a string.
// The keyless fallback below is a fourth reason, and the one exa documents.

// The MCP tool requires `objective`; the REST body only requires `search_queries`.
// Sending both on both paths keeps the two paths returning comparable results,
// which is the whole point of a fallback nobody notices.
const objective = input.query;
const search_queries = [input.query];

// `fail_open` turns a 401/403 into {available:false,...}, which IS the no-key
// signal and the only condition worth retrying. Anything else — a 5xx, a rate
// limit, a transport failure — is passed straight through, so a broken key costs
// ONE request rather than two.
const keyed = await callTool({ objective, search_queries });

// Applied to BOTH paths so a `limit` means the same thing whichever one ran.
// Guarded for undefined: the canonical arg is optional and slicing at `undefined`
// would return nothing.
const cap = (list) =>
	typeof input.limit === "number" && input.limit > 0
		? list.slice(0, input.limit)
		: list;
const shape = (items, provider) => ({
	results: cap(items || []).map((r) => ({
		title: r.title || undefined,
		url: r.url,
		// `excerpts` is an array of markdown blocks. Joining beats picking [0]:
		// Parallel deliberately returns several disjoint passages per URL and the
		// later ones routinely carry the answer.
		snippet: Array.isArray(r.excerpts) ? r.excerpts.join("\n\n") : undefined,
		published: r.publish_date || undefined,
		raw: r,
	})),
	via: provider,
});
if (keyed && Array.isArray(keyed.results)) {
	return shape(keyed.results, "api.parallel.ai");
}
if (!(keyed && keyed.available === false)) {
	// Not a missing key: a real failure envelope. Pass it through untouched rather
	// than masking a broken key or an outage behind free-tier results.
	return { raw: keyed };
}
// No key. Parallel's public Search MCP endpoint is free and accepts a STATELESS
// `tools/call` — no `initialize`, no session id, and (verified) no Accept header,
// unlike exa's MCP endpoint which 406s without one.
//
// `session_id` and `model_name` are deliberately NOT sent. `session_id` is what
// Parallel rate-limits the free tier on, so a constant baked into a shipped
// manifest would be shared by every Ryu install on earth and collide globally;
// the server generates a fresh one when it is absent. `model_name` is analytics
// only and the sandbox has no trustworthy view of the calling model anyway.
const free = await callNamed("parallel.free_search", {
	jsonrpc: "2.0",
	id: 1,
	method: "tools/call",
	params: {
		name: "web_search",
		arguments: { objective, search_queries },
	},
});
// The endpoint answers `application/json`, so this is a parsed JSON-RPC response.
// JSON-RPC errors arrive as HTTP 200, so `fail_open` never sees them: an envelope
// without a `result` must be passed through, not flattened into zero results.
// Every parse is guarded: a throw here would surface as an adapter crash, which
// reads as a Ryu bug rather than as "the upstream answered something odd".
const parse = (text) => {
	try {
		return JSON.parse(text);
	} catch (e) {
		return null;
	}
};
const rpc = typeof free === "string" ? parse(free) : free;
const result = rpc ? rpc.result : null;
// `structuredContent` is the same object the text block stringifies, so prefer it
// and only parse the text when an older server omits it.
let payload = result ? result.structuredContent : null;
if (!payload && result && result.content && result.content[0]) {
	payload =
		typeof result.content[0].text === "string"
			? parse(result.content[0].text)
			: null;
}
if (!(payload && Array.isArray(payload.results))) {
	return { raw: free };
}
return shape(payload.results, "search.parallel.ai (free tier, no key)");
