// Turn-hook body for `auto-continue.loop`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.runAgent / host.storage / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.
//
// WHAT THIS PLUGIN DOES
// ---------------------
// After each completed assistant turn while armed, a LOCAL sub-agent (`host.runAgent`,
// the same "proof of work" primitive the `proof` plugin builds on) reads the reply
// AND the real workspace (its tools are granted, preset `code_read` = read-only file
// tools) and judges whether the work is genuinely finished, whether there is concrete
// unfinished work another turn could complete NOW, or whether the task is blocked on
// the user / an external dependency. Only a `CONTINUE` verdict injects a follow-up
// turn; `DONE` and `BLOCKED` both stop quietly. A judge that could not form an opinion
// (scanner errored, no verdict line) also stops quietly.
//
// WHY A SUB-AGENT, NOT `host.sideModel`
// -------------------------------------
// `sideModel` is a single toolless completion that can only opine about the words it
// is handed. "Unfinished work another turn could complete" is usually a claim about
// the WORKSPACE — a failing test, a half-written file, a TODO that was promised. The
// sub-agent actually reads the files / runs the checks (read-only), so "I fixed it"
// is verified against the real state instead of taken on faith.
//
// WHO ARMS IT, AND WHERE THE SWITCH LIVES
// ---------------------------------------
// `/auto-continue on` writes a KV record keyed by conversation id; `/auto-continue
// off` deletes it. The manifest's `match.stateful` gate reads that same record in
// Rust BEFORE spawning the sandbox, so an unarmed conversation costs one KV read, not
// a sandbox spawn — and, because presence IS the switch, a fresh conversation is
// off by default. This plugin spends the user's tokens unattended, so it must be a
// thing they asked for.
//
// THE TWO BOUNDS — both hard stops, not heuristics. A self-prompt loop with no exit
// spends the user's tokens while they are not even watching:
//
//   1. CAP: at most MAX_CONSECUTIVE (5) auto-continuations per user message. Past
//      that the loop stops and says so; the user types a real message to go further.
//      `plugin_host::MAX_CONTINUE_TURNS` (25) is the server's backstop for the whole
//      request, not this plugin's budget.
//   2. NO PROGRESS: if the last two non-empty assistant replies are byte identical,
//      the model is restating itself and another nudge will not move it. Only
//      NON-EMPTY replies are compared — a tool-only turn persists empty `content`,
//      and two empty strings compare equal, which would kill the loop at the exact
//      point where continuing is most useful.
//   3. THE VERDICT ITSELF: only a scanner that explicitly says "there IS unfinished
//      work another turn can do" continues. Anything else — done, blocked, or
//      unparseable — stops, so the loop cannot talk itself into going on.

// First line of every injected message: the user-visible "Ryu wrote this, you
// didn't" marker AND the streak marker the count below scans for.
const MARKER = "[auto-continue]";
const MAX_CONSECUTIVE = 5;
// How much of the recent transcript to hand the scanner (chars). Enough for the
// user's request plus the last exchange; a full novel is not a better judge.
const MAX_SCAN_CHARS = 8000;

const convId = ctx.conversation_id;
if (!convId) {
	return { kind: "none" };
}

// `/auto-continue off|stop|on|start` — the per-conversation switch, checked before
// the stateful gate is believed so it works even from inside a loop already running
// away (the gate runs before the sandbox, but the KV it reads may be stale in the
// same request if the user typed the command in the turn that just finished).
const lastUser = ctx.transcript
	.slice()
	.reverse()
	.find((m) => m.role === "user");
const typed = ((lastUser && lastUser.content) || "").trim();
if (typed.indexOf("/auto-continue") === 0) {
	const arg = typed.slice("/auto-continue".length).trim().toLowerCase();
	if (arg === "off" || arg === "stop") {
		await host.storage.delete(convId);
		return {
			kind: "note",
			text: "Auto-continue is off for this chat. Turn it back on with '/auto-continue on'.",
		};
	}
	if (arg === "on" || arg === "start") {
		await host.storage.set(convId, JSON.stringify({ status: "active" }));
		return {
			kind: "note",
			text: "Auto-continue is on for this chat. After each turn a local agent will scan for genuinely unfinished work and keep going until it is done. Stop it anytime with '/auto-continue off'.",
		};
	}
}

// Belt and braces with the manifest's `match.stateful` pre-gate: that gate exists to
// avoid the sandbox spawn, this check is what makes the hook correct if it ever runs
// for another reason. Presence IS the switch — the record only ever says "armed".
let armed = false;
const raw = await host.storage.get(convId);
if (raw !== null && raw !== undefined && String(raw).trim() !== "") {
	try {
		const parsed = JSON.parse(String(raw));
		armed = parsed !== null && parsed.status === "active";
	} catch (_e) {
		// A half-written / garbled record fails quiet in the STOP direction: it must
		// never spend a single scanner call on a value the plugin cannot trust.
		armed = false;
	}
}
if (!armed) {
	return { kind: "none" };
}

// Count the streak of TRAILING marker-prefixed user rows. A message the user
// actually typed breaks the streak by construction.
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
			" nudges. The work still has unfinished parts — send a real message to keep going.",
	};
}

// No-progress stop: two byte-identical non-empty replies mean the model is
// restating itself; another nudge will not move it.
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
		text: "Auto-continue stopped: the last two replies were identical, so the work is not moving.",
	};
}

// Build a bounded transcript excerpt for the scanner: oldest → newest, marker rows
// kept so the scanner can tell them from real user requests.
const excerpt = [];
let used = 0;
for (let i = ctx.transcript.length - 1; i >= 0; i--) {
	const msg = ctx.transcript[i];
	const text = (msg.content || "").trim();
	if (!text) {
		continue;
	}
	const line = msg.role + ": " + text;
	if (excerpt.length > 0 && used + line.length > MAX_SCAN_CHARS) {
		break;
	}
	excerpt.unshift(line);
	used += line.length;
}

const task =
	"You are an INDEPENDENT reviewer agent. Another agent has just finished a turn in a " +
	"conversation and claimed work. Your job is to decide, with evidence you gather " +
	"yourself, whether that turn genuinely finished the work, whether there is concrete " +
	"unfinished work another turn could complete RIGHT NOW, or whether the task is " +
	"blocked on the user or on something outside the agent's reach.\n\n" +
	"CONVERSATION (oldest to newest):\n" +
	excerpt.join("\n") +
	"\n\n" +
	"Rules:\n" +
	"- User rows that begin with '" +
	MARKER +
	"' were injected by the auto-continue loop itself, NOT typed by the user. Ignore them " +
	"when deciding what the USER originally asked for — judge against the first real user " +
	"message and the assistant's LATEST reply.\n" +
	"- 'CONTINUE' ONLY when another turn can add real value now: an unimplemented step, a " +
	"failing test, a half-written file, a TODO the assistant promised to do but did not, an " +
	"unverified fix. Use your read-only tools to check the actual workspace when it matters " +
	"(does the file exist, does the test pass, is the TODO still there).\n" +
	"- 'DONE' when the work is genuinely complete, even if the reply is short. Do not invent " +
	"busywork: a polish pass you would do 'just because' is not unfinished work.\n" +
	"- 'BLOCKED' when work remains but proceeding requires the user (a decision, more input, " +
	"credentials) or an external dependency. A blocked task must NEVER continue.\n" +
	"- Never continue just because the reply is brief, or to restate, or to redo work that is " +
	"already done.\n\n" +
	"End your reply with a single final line, exactly one of:\n" +
	"VERDICT: DONE - <the evidence that the work is complete>\n" +
	"VERDICT: CONTINUE - <the specific, actionable unfinished work another turn can complete now>\n" +
	"VERDICT: BLOCKED - <what it is blocked on>";

let verdictText = "";
try {
	verdictText = await host.runAgent({
		task: task,
		agent_id: ctx.agent_id,
		preset: "code_read",
		wall_time_secs: 120,
	});
} catch (e) {
	host.log("auto-continue: scanner agent failed", String(e));
	return { kind: "none" };
}

// The scanner must state a verdict explicitly; anything less stops. Parse the LAST
// line that looks like a verdict so trailing prose after the required final line
// cannot defeat the parse.
let verdict = null;
const lines = String(verdictText || "").split(/\r?\n/);
for (let i = lines.length - 1; i >= 0; i--) {
	const line = lines[i].trim();
	const m = line.match(/^VERDICT:\s*(DONE|CONTINUE|BLOCKED)\b/i);
	if (m) {
		const dash = line.indexOf("-");
		verdict = {
			state: m[1].toUpperCase(),
			reason: dash >= 0 ? line.slice(dash + 1).trim() : "",
		};
		break;
	}
}
if (!verdict) {
	return { kind: "none" };
}

if (verdict.state === "DONE" || verdict.state === "BLOCKED") {
	return { kind: "none" };
}

return {
	kind: "continue",
	text:
		MARKER +
		" Ryu generated this message; the user did not type it.\n\n" +
		"A local agent scanned the previous reply and the workspace, and found work that is " +
		"genuinely unfinished and that another turn can complete now:\n\n" +
		(verdict.reason || "Unspecified unfinished work remains.") +
		"\n\n" +
		"Continue working on it — do the unfinished part instead of restating what is done.",
};
