// Capability adapter for `web.crawl / web.crawl`, run in Core's plugin sandbox.
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (crates/core/tool-exec `build_capability_adapter_program`) and it `return`s the
// canonical result. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/adapters is excluded from Biome — a module parser rejects it.

// Firecrawl's crawl is a JOB API: one call starts it and returns an id, a
// second reads the accumulated pages. A declarative binding is one request
// with no loop, so binding it that way would hand the model a UUID where the
// verb promises page content — which is why this verb was previously left
// unbound for Firecrawl entirely.
const start = await callTool({
	url: input.url,
	limit: input.limit,
	maxDiscoveryDepth: input.depth,
});
// No job id means this is not a started crawl at all: fail_open turns a bad or
// missing API key into {available,reason,hint}, and any other non-2xx into
// {status,body}. Calling that a FAILED CRAWL would misreport a config problem as
// a site problem, so pass the envelope through the way the declarative mapper
// does and let the caller see what actually happened.
const id = start && start.id;
if (!id) {
	return { raw: start };
}
const one = (v) => (Array.isArray(v) && v.length === 1 ? v[0] : v);
const shape = (st, complete) => ({
	status: (st && st.status) || "unknown",
	complete,
	total: st && st.total,
	results: ((st && st.data) || []).map((item) => ({
		url: one(item && item.metadata && item.metadata.sourceURL),
		title: one(item && item.metadata && item.metadata.title),
		content: item && item.markdown,
		raw: item,
	})),
});
// The sandbox bounds ACTIVE COMPUTE, and awaiting a tool call spends that
// budget, so a crawl larger than the budget cannot be waited out. Poll with
// backoff inside a deliberately smaller window and then RETURN what completed,
// flagged `complete:false` — a partial page set the model can use beats being
// killed at the wall clock with nothing.
const BUDGET_MS = 20000;
const started = Date.now();
let delay = 750;
for (;;) {
	const st = await callNamed("firecrawl.crawl_status", { id });
	const status = st && st.status;
	if (status === "completed") return shape(st, true);
	if (status === "failed" || status === "cancelled") return shape(st, false);
	if (Date.now() - started > BUDGET_MS) return shape(st, false);
	await new Promise((r) => setTimeout(r, delay));
	delay = Math.min(delay * 2, 4000);
}
