// Turn-hook body for `double-check.review`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.sideModel / host.storage / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.

if (!(ctx.flags && ctx.flags["io.ryu.double-check"])) {
	return { kind: "none" };
}
const rev = ctx.transcript.slice().reverse();
const lastAssistant = rev.find((m) => m.role === "assistant");
if (!lastAssistant) {
	return { kind: "none" };
}
const lastUser = rev.find((m) => m.role === "user");
const review = await host.sideModel({
	system:
		"You are a meticulous reviewer. Check the assistant's last answer for factual errors, unsupported claims, or missing steps. If it is correct and complete, reply with exactly: Looks correct. Otherwise give a brief, specific correction.",
	prompt:
		"User asked:\n" +
		(lastUser ? lastUser.content : "(unknown)") +
		"\n\nAssistant answered:\n" +
		lastAssistant.content,
	model_pref_key: "double-check-model",
});
if (!review || !review.trim()) {
	return { kind: "none" };
}
return { kind: "note", text: review.trim() };
