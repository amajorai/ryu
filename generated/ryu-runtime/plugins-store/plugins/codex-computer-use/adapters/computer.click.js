// Capability adapter for `computer.control / computer.click`, run in Core's plugin sandbox.
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (crates/core/tool-exec `build_capability_adapter_program`) and it `return`s the
// canonical result. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/adapters is excluded from Biome — a module parser rejects it.

// Every Codex Computer Use method acts on one named app, and the canonical
// computer.* verbs carry no app. The target comes from the
// `codex-computer-use.app` preference; an unset preference is refused here with
// a message the user can act on, rather than forwarded for the bridge to reject
// as a schema error.
const app = typeof defaults.app === "string" ? defaults.app.trim() : "";
if (app === "") {
	throw new Error(
		"Codex Computer Use has no target app. Set one in Settings → Codex Computer Use, or call the codex_cu.* tools directly with an `app`."
	);
}

// Coordinates are in the pixel space of the screenshot that computer.capture
// returned, which is what the Codex engine expects.
return await callTool({
	app,
	x: input.x,
	y: input.y,
	mouse_button: input.button ?? "left",
	click_count: input.count ?? 1,
});
