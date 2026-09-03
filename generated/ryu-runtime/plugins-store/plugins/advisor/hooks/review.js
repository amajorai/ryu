// Turn-hook body for `advisor.review`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.sideModel / host.storage / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.

const rev = ctx.transcript.slice().reverse();
const lastUser = rev.find((m) => m.role === "user");
const cmd = lastUser ? (lastUser.content || "").trim() : "";
const onDemand = cmd === "/advisor" || cmd.indexOf("/advisor ") === 0;
const toggled = !!(ctx.flags && ctx.flags["@ryu/advisor"]);
if (!onDemand && !toggled) {
	return { kind: "none" };
}
if (!ctx.transcript || ctx.transcript.length === 0) {
	return { kind: "none" };
}
const transcript = ctx.transcript
	.map((m) => m.role + ": " + m.content)
	.join("\n\n");
const focus = onDemand && cmd.length > 8 ? cmd.slice(9).trim() : "";
const system =
	"You are a stronger reviewer advising a capable assistant. You can see the entire conversation. Before the assistant commits to an approach or declares the task done, give concrete, actionable advice: flag wrong assumptions, missing steps, better approaches, and risks. Be specific and brief. If the direction is already sound, say so in one line and add the single highest-value improvement. Advise; do not rewrite the answer for it.";
let prompt = "Full conversation so far:\n\n" + transcript;
if (focus) {
	prompt += "\n\nThe assistant specifically wants advice on: " + focus;
}
prompt += "\n\nGive your advice now.";
const advice = await host.sideModel({
	system: system,
	prompt: prompt,
	model_pref_key: "advisor-model",
	effort: "high",
});
if (!advice || !advice.trim()) {
	return { kind: "none" };
}
if (onDemand) {
	return {
		kind: "continue",
		text:
			"An expert advisor reviewed the whole conversation and gave this advice. Give it serious weight and act on it in your next response:\n\n" +
			advice.trim(),
	};
}
return { kind: "note", text: "Advisor: " + advice.trim() };
