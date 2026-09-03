// Turn-hook body for `session-context.start`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.sideModel / host.storage / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.

const now = new Date().toISOString();
return {
	kind: "inject",
	text:
		"Session context (auto-added): the current date and time is " +
		now +
		'. Use it whenever the user refers to "today", recency, or deadlines.',
};
