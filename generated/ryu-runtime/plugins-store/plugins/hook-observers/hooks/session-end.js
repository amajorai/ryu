// Turn-hook body for `observers.session-end`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.sideModel / host.storage / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/hook_program.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.

// `host.t` renders a sentence in the user's language through Core's catalog; a
// host without it (an older Core, a test stub) gets the English source back.
if (typeof host.t !== "function") {
	host.t = async (source, values = {}) =>
		String(source).replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
}

const n = ctx.transcript ? ctx.transcript.length : 0;
return {
	kind: "note",
	text: await host.t("session {id} ended with {count} messages", {
		id: ctx.conversation_id || "?",
		count: n,
	}),
};
