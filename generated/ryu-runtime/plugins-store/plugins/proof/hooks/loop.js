// Turn-hook body for `proof.loop`, run in Core's plugin sandbox.
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
	if (t === "/proof clear" || t === "/proof stop") {
		await host.storage.delete(convId);
		return { kind: "note", text: "Proof goal cleared." };
	}
	if (t.indexOf("/proof ") === 0) {
		const condition = t.slice(7).trim();
		if (condition) {
			await host.storage.set(convId, {
				condition: condition,
				status: "active",
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
if (turns >= 12) {
	await host.storage.delete(convId);
	return {
		kind: "note",
		text: "Proof goal stopped after 12 verification rounds.",
	};
}
const transcript = ctx.transcript
	.map((m) => m.role + ": " + m.content)
	.join("\n");
const task =
	"You are an INDEPENDENT proof-of-work verifier agent. Another agent CLAIMS it accomplished a goal. Do NOT trust those claims. Your job is to PROVE, with concrete evidence you gather yourself using your tools, whether the goal was ACTUALLY achieved in the real workspace.\n\nGOAL TO VERIFY:\n" +
	goal.condition +
	"\n\nWhat the other agent said it did (claims only \u2014 verify, do not trust):\n" +
	transcript +
	"\n\nInvestigate the real state: read the actual files, run the tests or commands, and check the outputs that would exist ONLY IF the goal were truly done. Gather specific evidence (file contents, command output, test results). Then decide.\n\nEnd your reply with a single final line, exactly one of:\nVERIFIED: yes - <the concrete evidence that proves it>\nVERIFIED: no - <what is missing or wrong, with the evidence you found>";
const verdict = await host.runAgent({
	task: task,
	agent_id: ctx.agent_id,
	preset: "code_read",
});
const proven = /verified:\s*yes/i.test(verdict || "");
goal.turns = turns + 1;
goal.last_verdict = verdict;
if (proven) {
	await host.storage.delete(convId);
	return {
		kind: "note",
		text:
			"Proof of work confirmed by an independent verifier agent. " +
			(verdict || ""),
	};
}
await host.storage.set(convId, goal);
return {
	kind: "continue",
	text:
		"An independent verifier agent inspected the actual workspace and could NOT yet prove the goal is done. Address its findings below, then it will re-verify.\n\nVerifier report:\n" +
		(verdict || ""),
};
