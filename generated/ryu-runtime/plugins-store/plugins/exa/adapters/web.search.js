// Capability adapter for `web.search / web.search`, run in Core's plugin sandbox.
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (crates/core/tool-exec `build_capability_adapter_program`) and it `return`s the
// canonical result. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/adapters is excluded from Biome — a module parser rejects it.

// exa is the ONE search provider shipped pre-installed and enabled, so it has to work
// with no credential at all. Exa's REST search needs a key; Exa's PUBLIC MCP
// endpoint does not. Try the keyed path first (higher limits, richer fields) and
// fall back to the free endpoint only when the key is genuinely absent.
//
// `fail_open` turns a 401/403 into {available:false,...}, which IS the
// no-key signal and the only condition worth retrying. Anything else - a 5xx, a
// rate limit, a transport failure - is passed straight through, so a broken key
// costs ONE request rather than two.
// `limit` is optional on the canonical verb. Passing it through as
// `undefined` is SAFE and deliberate: the sandbox serializes args with
// JSON.stringify, which omits undefined values entirely, so the key is
// absent rather than null and exa.search's `body_defaults.num_results`
// still applies. Do not "fix" this into a conditional - sending an
// explicit null WOULD override the default.
const keyed = await callTool({
	query: input.query,
	num_results: input.limit,
});
const shape = (items, provider) => ({
	results: (items || []).map((it) => ({
		title: it.title,
		url: it.url,
		snippet: it.snippet,
		published: it.published,
		author: it.author,
		score: it.score,
		raw: it.raw,
	})),
	via: provider,
});
if (keyed && Array.isArray(keyed.results)) {
	return shape(
		keyed.results.map((r) => ({
			title: r.title,
			url: r.url,
			snippet: r.text,
			published: r.publishedDate,
			author: r.author,
			score: r.score,
			raw: r,
		})),
		"api.exa.ai"
	);
}
if (!(keyed && keyed.available === false)) {
	// Not a missing key: a real failure envelope. Pass it through untouched rather
	// than masking a broken key or an outage behind free-tier results.
	return { raw: keyed };
}
const free = await callNamed("exa.free_search", {
	Accept: "application/json, text/event-stream",
	jsonrpc: "2.0",
	id: 1,
	method: "tools/call",
	params: {
		name: "web_search_exa",
		arguments: { query: input.query, numResults: input.limit },
	},
});
// The endpoint answers text/event-stream, so the http tool hands back the raw
// frame as a string: `event: message\ndata: {json}`. Pull the JSON out.
if (typeof free !== "string") {
	return { raw: free };
}
let payload = null;
for (const line of free.split("\n")) {
	if (line.startsWith("data: ")) {
		try {
			payload = JSON.parse(line.slice(6));
		} catch (e) {
			payload = null;
		}
	}
}
const text =
	payload &&
	payload.result &&
	payload.result.content &&
	payload.result.content[0]
		? payload.result.content[0].text
		: null;
if (typeof text !== "string") {
	return { raw: free };
}
// Records are separated by a `---` line, each a block of `Key: value` headers
// followed by a Highlights body. Verified against live output, not guessed.
const items = text
	.split(/\n-{3,}\n/)
	.map((block) => block.trim())
	.filter(Boolean)
	.map((block) => {
		const field = (name) => {
			const m = block.match(new RegExp("^" + name + ": (.*)$", "m"));
			const v = m ? m[1].trim() : "";
			return v && v !== "N/A" ? v : undefined;
		};
		const cut = block.indexOf("Highlights:");
		const body =
			cut >= 0 ? block.slice(cut + "Highlights:".length).trim() : "";
		return {
			title: field("Title"),
			url: field("URL"),
			snippet: body || undefined,
			published: field("Published"),
			author: field("Author"),
			score: undefined,
			raw: block,
		};
	});
return shape(items, "mcp.exa.ai (free tier, no key)");
