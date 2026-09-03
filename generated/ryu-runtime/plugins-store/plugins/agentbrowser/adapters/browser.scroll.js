// Capability adapter for `browser.control / browser.scroll`, run in Core's plugin sandbox.
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (crates/core/tool-exec `build_capability_adapter_program`) and it `return`s the
// canonical result. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/adapters is excluded from Biome — a module parser rejects it.

// agent-browser scrolls the active tab. Switch first when the canonical call
// names a target so the operation cannot land in whichever tab was last active.
if (
	input.tab_id !== undefined &&
	input.tab_id !== null &&
	input.tab_id !== ""
) {
	await callNamed("agentbrowser.agent_browser_tab_switch", {
		tab: input.tab_id,
	});
}
const args = { direction: input.direction };
if (input.amount !== undefined && input.amount !== null) {
	args.amount = input.amount;
}
return await callTool(args);
