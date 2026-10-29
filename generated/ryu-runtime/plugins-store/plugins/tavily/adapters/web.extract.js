// Capability adapter for `web.extract / web.extract`, run in Core's plugin sandbox.
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (crates/core/tool-exec `build_capability_adapter_program`) and it `return`s the
// canonical result. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/adapters is excluded from Biome — a module parser rejects it.

// Tavily takes a batch `urls` array; the canonical verb passes one `url`.
const args = { urls: [input.url] };
// Canonical `format` → Tavily `format`, which accepts only `markdown` and `text`.
// `html` has no Tavily equivalent, so it stays unmapped and Tavily's markdown
// default answers instead of a request the API rejects. This value-dependent
// mapping is why this verb is an adapter rather than a declarative rename.
if (input.format === "markdown" || input.format === "text") {
	args.format = input.format;
}
const res = await callTool(args);
// NOT a result set: this tool is fail_open, so a bad or missing API key comes back
// as {available,reason,hint} and any other non-2xx as {status,body}. Pass it
// through under `raw`, exactly as the declarative response mapper does when its
// results path is absent, so a broken key never reads as an empty page.
if (!res || res.results === undefined) {
	return { raw: res };
}
let items = [res.results];
if (Array.isArray(res.results)) {
	items = res.results;
} else if (res.results === null) {
	items = [];
}
return {
	results: items.map((item) => {
		const result = {};
		if (item && item.url !== undefined) {
			result.url = item.url;
		}
		if (item && item.raw_content !== undefined) {
			result.content = item.raw_content;
		}
		result.raw = item;
		return result;
	}),
};
