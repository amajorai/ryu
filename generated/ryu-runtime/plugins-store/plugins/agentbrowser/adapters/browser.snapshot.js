// Capability adapter for `browser.control / browser.snapshot`, run in Core's plugin sandbox.
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (crates/core/tool-exec `build_capability_adapter_program`) and it `return`s the
// canonical result. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/adapters is excluded from Biome — a module parser rejects it.

// The canonical verb REQUIRES a tab_id, but agent-browser has no per-call tab
// argument — its snapshot acts on the session's active tab. Silently ignoring
// tab_id would make the verb lie about which tab it read. Switch first, then
// snapshot. The ids round-trip: browser.tabs returns agent-browser's own tab
// list, so whatever the model hands back is what tab_switch expects.
if (
	input.tab_id !== undefined &&
	input.tab_id !== null &&
	input.tab_id !== ""
) {
	await callNamed("agentbrowser.agent_browser_tab_switch", {
		tab: input.tab_id,
	});
}
return await callTool({});
