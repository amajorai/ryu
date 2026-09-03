// Turn-hook body for `plan-continue.loop`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.storage / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.
//
// WHAT DECIDES "STILL IN PLAN MODE, PLAN NOT DONE"
// -----------------------------------------------
// Nothing in here. `ryu.plan` is the composer's plan-mode pill, and an APPROVED
// `ExitPlanMode` writes it back off (`details.ryuConfig`), so the flag Core folds
// into `ctx.flags` already means exactly "plan mode is on and the plan has not
// been accepted". Re-judging that with a side model on every plan turn would cost
// a completion per turn to learn something the flag already says.
//
// WHY THE MARKER PREFIX, AND WHY IT DOUBLES AS THE LEDGER
// ------------------------------------------------------
// A `continue` directive is injected as a real USER row — `continue_turn_request`
// pushes it with `persist: true` and `route_chat_stream` is the only writer of the
// user row — so on reload it is indistinguishable from something the user typed.
// The marker line is what tells them apart; there is no client-side rendering for
// an auto-continuation yet, so it has to live in the text.
//
// It is also the budget ledger. Counting the TRAILING marker-prefixed user rows in
// `ctx.transcript` is precisely "consecutive auto-continuations", and a message the
// user actually typed breaks the streak by construction. That is why this hook
// keeps no KV counter and does not declare `match.stateful`: a stored counter would
// have to be cleared when plan mode ends, and one missed clear caps the NEXT plan
// in the same conversation at zero.
//
// THE TWO BOUNDS — both hard stops, not heuristics. A self-prompt loop with no
// exit spends the user's tokens while they are not even watching:
//
//   1. CAP: at most MAX_CONSECUTIVE (3) auto-continuations per user message. Past
//      that the loop stops and says so; the user types "continue" to go further.
//      `plugin_host::MAX_CONTINUE_TURNS` (25) is the server's backstop for the
//      whole request, not this plugin's budget.
//   2. NO PROGRESS: if the last two non-empty assistant replies are byte
//      identical, the model is restating itself and another nudge will not move
//      it. Only NON-EMPTY replies are compared — a plan-mode turn that only ran
//      tools persists empty `content` (tool rows live in the sealed `parts`
//      column), and two empty strings compare equal, which would kill the loop at
//      the exact point where continuing is most useful.

// First line of every injected message: the user-visible "Ryu wrote this, you
// didn't" marker AND the streak marker the count below scans for.
const MARKER = "[auto-continue]";
const MAX_CONSECUTIVE = 3;

const convId = ctx.conversation_id;
if (!convId) {
	return { kind: "none" };
}

// `/plan-continue off|on` — the per-conversation escape hatch, checked before the
// flag so it works from inside a plan mode already running away.
const lastUser = ctx.transcript
	.slice()
	.reverse()
	.find((m) => m.role === "user");
const typed = ((lastUser && lastUser.content) || "").trim();
if (typed.indexOf("/plan-continue") === 0) {
	const arg = typed.slice("/plan-continue".length).trim().toLowerCase();
	if (arg === "off" || arg === "stop") {
		await host.storage.set(convId, { auto: "off" });
		return {
			kind: "note",
			text: "Auto-continue is off for this chat. Turn it back on with '/plan-continue on'.",
		};
	}
	if (arg === "on" || arg === "start") {
		await host.storage.delete(convId);
		return { kind: "note", text: "Auto-continue is on for this chat." };
	}
}

// The KV record exists ONLY to say "off" for this conversation — `/plan-continue
// on` deletes it rather than writing "on". So a present record, whatever it
// holds, means stop; a garbled one stops too, because failing quiet is the right
// direction for a feature that otherwise spends tokens on its own.
if (await host.storage.get(convId)) {
	return { kind: "none" };
}

// Belt and braces with the manifest's `match.flag` pre-gate: that gate exists to
// avoid the sandbox spawn, this check is what makes the hook correct if it ever
// runs for another reason.
if (!(ctx.flags && ctx.flags["ryu.plan"] === true)) {
	return { kind: "none" };
}

let consecutive = 0;
for (let i = ctx.transcript.length - 1; i >= 0; i--) {
	const msg = ctx.transcript[i];
	if (msg.role !== "user") {
		continue;
	}
	if ((msg.content || "").trim().indexOf(MARKER) === 0) {
		consecutive += 1;
		continue;
	}
	break;
}

if (consecutive >= MAX_CONSECUTIVE) {
	return {
		kind: "note",
		text:
			"Auto-continue stopped after " +
			MAX_CONSECUTIVE +
			" nudges. Plan mode is still on — send a message to keep going.",
	};
}

const replies = [];
for (const msg of ctx.transcript) {
	if (msg.role !== "assistant") {
		continue;
	}
	const text = (msg.content || "").trim();
	if (text) {
		replies.push(text);
	}
}
const stalled =
	replies.length >= 2 &&
	replies[replies.length - 1] === replies[replies.length - 2];
if (stalled) {
	// Only worth reporting when we were the one asking; an ordinary repeated
	// answer to a repeated question is not this plugin's business.
	if (consecutive === 0) {
		return { kind: "none" };
	}
	return {
		kind: "note",
		text: "Auto-continue stopped: the last two replies were identical, so the plan is not moving.",
	};
}

return {
	kind: "continue",
	text:
		MARKER +
		" Ryu generated this message; the user did not type it.\n\n" +
		"Plan mode is still on and the plan has not been accepted yet. Keep working on the plan — investigate whatever is still unknown and fill in the missing steps. When the plan is ready for the user to review, call ExitPlanMode instead of restating it.",
};
