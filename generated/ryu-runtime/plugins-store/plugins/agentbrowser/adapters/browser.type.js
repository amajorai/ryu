// Capability adapter for `browser.control / browser.type`, run in Core's plugin sandbox.
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (crates/core/tool-exec `build_capability_adapter_program`) and it `return`s the
// canonical result. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/adapters is excluded from Biome — a module parser rejects it.

// Two things the canonical verb promises that one agent-browser call cannot
// give: REPLACE semantics, and an optional Enter afterwards. agent-browser's
// type tool takes `clear`, which covers the first; `submit` needs a second
// call, which is why this verb is adapted rather than bound declaratively.
if (
	input.tab_id !== undefined &&
	input.tab_id !== null &&
	input.tab_id !== ""
) {
	await callNamed("agentbrowser.agent_browser_tab_switch", {
		tab: input.tab_id,
	});
}
const typed = await callTool({
	selector: input.ref,
	text: input.text,
	clear: input.replace === true,
});
if (!input.submit) {
	return { ok: true, ref: input.ref, submitted: false, raw: typed };
}
const pressed = await callNamed("agentbrowser.agent_browser_press", {
	key: "Enter",
});
return { ok: true, ref: input.ref, submitted: true, raw: { typed, pressed } };
