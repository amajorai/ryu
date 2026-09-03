// Capability adapter for `web.extract / web.extract`, run in Core's plugin sandbox.
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (crates/core/tool-exec `build_capability_adapter_program`) and it `return`s the
// canonical result. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/adapters is excluded from Biome — a module parser rejects it.

const res = await callTool({
	url: input.url,
	// The canonical `format` enum (markdown | text | html) is EXACTLY Scrapling's
	// `extraction_type` enum, so this is the one shipped extract provider that can
	// honour the argument instead of dropping it. Scrapling's own default is
	// markdown, which is also what the canonical `content` field promises.
	extraction_type: input.format || "markdown",
});
// An MCP `tools/call` answer is the TRANSPORT envelope, not the tool's value:
// `{content: [{type, text}], structuredContent, isError}`. Only
// `structuredContent` carries the typed ResponseModel. Shaping a missing one into
// an empty page would report a broken install as "this URL has no content" — an
// invisible, plausible-looking lie — so pass it through under `raw` instead. This
// path is genuinely reachable: `scrapling mcp` fails on import against `mcp` 2.x
// (see README), and a server that never starts answers nothing typed at all.
const page = res && res.structuredContent;
if (!page || res.isError) {
	return { raw: res };
}
// `content` is an ARRAY of extracted chunks, and Scrapling emits empty strings for
// regions it found nothing in. The canonical `content` field is a STRING, and the
// declarative response mapper copies a located value verbatim — it has no join. So
// the flattening lives here, in the ONE provider whose shape this is, rather than
// in shared kernel code every provider flows through.
const chunks = Array.isArray(page.content) ? page.content : [page.content];
const content = chunks
	.filter((chunk) => typeof chunk === "string" && chunk.length > 0)
	.join("\n\n");
// `url` is the RESOLVED url (redirects already followed), which is what a canonical
// record should report. No `title` is mapped: ResponseModel has no such field, and
// emitting an empty one would read as a page whose title is blank rather than as a
// field this provider cannot supply. `status` is kept under `raw` for the same
// reason the declarative mapper keeps the provider's original item there.
return { results: [{ url: page.url || input.url, content, raw: page }] };
