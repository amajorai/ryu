// Capability adapter for `web.extract / web.extract`, run in Core's plugin sandbox.
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (crates/core/tool-exec `build_capability_adapter_program`) and it `return`s the
// canonical result. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/adapters is excluded from Biome — a module parser rejects it.

const res = await callTool({ url: input.url });
// NOT a result set: these tools are fail_open, so a bad or missing API key comes
// back as {available,reason,hint} and any other non-2xx as {status,body}. Shaping
// either into `results` would report a broken key as an empty page — an invisible,
// plausible-looking lie. Pass it through under `raw`, exactly as the declarative
// response mapper does when its results path is absent.
if (!res || res.data === undefined) {
	return { raw: res };
}
const items = Array.isArray(res.data) ? res.data : [res.data];
// Firecrawl types `metadata.title` as string | string[] (a page carrying both a
// <title> and an og:title yields an array). The canonical shape promises a
// scalar, so collapse a single-element array here — in the ONE provider whose
// quirk it is, rather than in shared kernel code every provider flows through.
const one = (v) => (Array.isArray(v) && v.length === 1 ? v[0] : v);
return {
	results: items.map((item) => ({
		url: one(item && item.metadata && item.metadata.sourceURL),
		title: one(item && item.metadata && item.metadata.title),
		content: item && item.markdown,
		raw: item,
	})),
};
