// Turn-hook body for `rlm.deep-read`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.sideModel / host.runAgent / host.getPreference / host.storage / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// apps-store/*/hooks is excluded from Biome — a module parser rejects it.
//
// WHAT THIS IS FOR
//
// The assistant has just answered. That answer came out of the model — from the
// conversation, from whatever fragments were pasted in, and from what the model
// already believes. This hook asks the SAME question of the loaded corpus and
// appends what the documents actually say, with `path:line` citations. The two
// answers agreeing is worth something; the two disagreeing is worth much more, and
// it is the case nobody catches by reading the reply.
//
// WHY THIS GOES THROUGH runAgent, AND WHY IT INSISTS ON A MARKER
//
// The engine lives in the `ryu-rlm` sidecar, and the sandbox this fragment runs in
// has no HTTP and no capability call — by design, it is deny-by-default. The
// supported way out is `host.runAgent`, which is also what `@ryu/reasoning` and
// `@ryu/proof` use. The sub-agent is not asked to ANSWER the question; it is asked
// only to call `rlm.query` and report what came back.
//
// That transport is CONDITIONAL, which is the whole reason for the marker protocol
// below. `delegation::call_sub_agent` only runs the real chat path — the sub-agent's
// own engine, tools and MCP servers, so `rlm.query` exists — when an `agent_id` is
// given AND a live agent runner is present. With no runner it falls back to a single
// clean-context completion whose "tools" are a sentence in a system prompt, so the
// sub-agent has NOTHING to call and can only answer from its own opinion.
//
// For this app that degradation is worse than for most. An opinion printed under the
// heading "what your documents say" is precisely the failure the whole app exists to
// prevent, and it is unfalsifiable by eye — the citations would be plausible file
// names and plausible line numbers. So a reply without the marker is reported as
// "could not run", never as a reading. The marker is copied out of the tool's own
// JSON result and is checked for shape: a status from the engine's closed set, and a
// run id. A model with no tool cannot produce it without fabricating outright, and
// the failure it does produce instead is legible.
//
// Being honest about the limit: a determined model COULD invent a uuid. This is the
// same posture `@ryu/reasoning` takes, and it is a transport check, not a proof. The
// real guarantee is one layer down — the run id names a trace stored on the node,
// and the companion shows every operator and every sub-call behind an answer. If a
// reading looks wrong, the trace is where it is settled.

if (!(ctx.flags && ctx.flags["io.ryu.rlm"])) {
	return { kind: "none" };
}

const rev = ctx.transcript.slice().reverse();
const lastAssistant = rev.find((m) => m.role === "assistant");
if (!(lastAssistant && lastAssistant.content.trim())) {
	return { kind: "none" };
}
const lastUser = rev.find((m) => m.role === "user");
if (!(lastUser && lastUser.content.trim())) {
	return { kind: "none" };
}

// Which corpus to read. Without one there is nothing to ground anything in, and
// silently doing nothing would be the worst default: the user turned the toggle on
// and would see no reading and no reason why.
const contextId = await host.getPreference({ key: "rlm-active-context" });
if (!(contextId && String(contextId).trim())) {
	return {
		kind: "note",
		text:
			"Deep read skipped: no context is selected. Load one in the Deep Read companion, " +
			"then put its id in Settings → Recursive Language Model.",
	};
}

const task = [
	"Answer a question from a loaded corpus using the RLM tools. Do NOT answer it",
	"yourself and do not use your own knowledge of the subject — your opinion is not what",
	"is wanted here. Call the tool and report exactly what it returns.",
	"",
	`1. Call the \`rlm.query\` tool with context_id ${JSON.stringify(String(contextId).trim())}`,
	"   and the question quoted verbatim below.",
	"2. Write the tool's `answer` field. Then, for each entry in its `cites` array, write one",
	"   line: the source, the line span, and the label.",
	"3. End your reply with a final line, exactly:  RLM: <status> <run_id>",
	"   Copy both values verbatim from the tool output — `status` is one of ok,",
	"   budget_exhausted or error, and `run_id` is the tool's `run_id` field.",
	"4. If you have no `rlm.query` tool available, or the call errors, do NOT write an RLM",
	"   line and do NOT answer the question from your own knowledge. Reply with one line",
	"   saying what went wrong.",
	"",
	"<question>",
	lastUser.content,
	"</question>",
].join("\n");

let report;
try {
	// `agent_id` is load-bearing, not decoration: it is what selects the real chat
	// path, which is the only path on which the RLM tool exists at all.
	report = await host.runAgent({
		task,
		agent_id: ctx.agent_id,
		// A deep read over a large corpus is many small calls, not one big one, so it
		// takes longer than a normal sub-agent turn. Still bounded: the engine's own
		// wall-clock budget is shorter than this, so this ceiling is the backstop.
		wall_time_secs: 900,
	});
} catch (e) {
	return { kind: "note", text: `Deep read could not run: ${e}` };
}

// The bridge hands back the sub-agent's final text; coerce defensively so a
// non-string never reaches the user as "[object Object]".
const text = (
	typeof report === "string" ? report : String(report ?? "")
).trim();
const marker = text.match(/RLM:\s*(ok|budget_exhausted|error)\s+(\S+)\s*$/im);
if (!marker) {
	return {
		kind: "note",
		text:
			"Deep read did not run: the reader could not reach the RLM tool, so nothing was " +
			"read from your documents and the answer above is unchanged. (Its reply: " +
			(text || "empty") +
			")",
	};
}

const status = marker[1].toLowerCase();
const runId = marker[2];
const body = text
	.replace(/\s*RLM:\s*(ok|budget_exhausted|error)\s+\S+\s*$/im, "")
	.trim();

if (status === "error") {
	return {
		kind: "note",
		text: `Deep read failed (run ${runId}). Nothing was read from your documents.\n${body}`,
	};
}

// A run that hit its budget still read something real, so it is worth showing — but
// labelled, because "what the documents say" and "what the documents say as far as
// it got" are different claims and only one of them is safe to act on.
const header =
	status === "budget_exhausted"
		? `From your documents — PARTIAL, the read hit its budget (run ${runId})`
		: `From your documents (run ${runId})`;

return { kind: "note", text: `${header}\n${body}` };
