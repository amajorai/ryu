// Turn-hook body for `goal.loop`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.sideModel / host.storage / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.

const convId = ctx.conversation_id;
if (!convId) {
	return { kind: "none" };
}
const rev = ctx.transcript.slice().reverse();
const lastUser = rev.find((m) => m.role === "user");
if (lastUser) {
	const t = (lastUser.content || "").trim();
	if (t === "/goal clear" || t === "/goal stop") {
		await host.storage.delete(convId);
		return { kind: "note", text: "Goal cleared." };
	}
	if (t.indexOf("/goal ") === 0) {
		const condition = t.slice(6).trim();
		if (condition) {
			await host.storage.set(convId, {
				condition: condition,
				status: "active",
				started_at: Date.now(),
				turns: 0,
			});
			return {
				kind: "continue",
				text: "Begin working toward this goal: " + condition,
			};
		}
	}
}
const raw = await host.storage.get(convId);
if (!raw) {
	return { kind: "none" };
}
let goal;
try {
	goal = JSON.parse(raw);
} catch (e) {
	return { kind: "none" };
}
if (!goal || !goal.condition || goal.status !== "active") {
	return { kind: "none" };
}
const turns = goal.turns || 0;
if (turns >= 25) {
	await host.storage.delete(convId);
	return { kind: "note", text: "Goal stopped after 25 turns." };
}
const transcript = ctx.transcript
	.map((m) => m.role + ": " + m.content)
	.join("\n");
const verdict = await host.sideModel({
	system:
		"You judge whether a goal has been met from the conversation. Answer with a single line exactly: MET: yes - <reason>  or  MET: no - <reason>.",
	prompt:
		"Goal: " +
		goal.condition +
		"\n\nConversation so far:\n" +
		transcript +
		"\n\nIs the goal met?",
	model_pref_key: "goal-judge-model",
});
const met = /met:\s*yes/i.test(verdict || "");
goal.turns = turns + 1;
goal.last_reason = verdict;
if (met) {
	goal.status = "achieved";
	goal.achieved_at = Date.now();
	await host.storage.set(convId, goal);
	return { kind: "note", text: "Goal met. " + (verdict || "") };
}
await host.storage.set(convId, goal);
return {
	kind: "continue",
	text:
		"Keep working toward the goal: " +
		goal.condition +
		". Judge feedback: " +
		(verdict || ""),
};
