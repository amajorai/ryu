// Capability adapter for `browser.control / browser.click`, run in Core's plugin sandbox.
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (crates/core/tool-exec `build_capability_adapter_program`) and it `return`s the
// canonical result. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/adapters is excluded from Biome — a module parser rejects it.

// agent-browser clicks the active tab. Honour the canonical optional tab_id by
// switching before the click instead of silently acting on another tab.
if (
	input.tab_id !== undefined &&
	input.tab_id !== null &&
	input.tab_id !== ""
) {
	await callNamed("agentbrowser.agent_browser_tab_switch", {
		tab: input.tab_id,
	});
}
return await callTool({ selector: input.ref });
