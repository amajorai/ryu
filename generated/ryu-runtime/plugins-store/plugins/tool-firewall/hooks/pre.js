// Turn-hook body for `tool-firewall.pre`, run in Core's plugin sandbox.
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
const name = ctx.tool_name || "";
const input = JSON.stringify(ctx.tool_input || {});
const danger = /(rm\s+-rf)|(DROP\s+TABLE)|(mkfs)/i;
if (danger.test(input)) {
	return {
		kind: "deny",
		reason: await host.t("Blocked a destructive command ({tool}) by the tool-firewall policy.", { tool: name }),
	};
}
return { kind: "none" };
