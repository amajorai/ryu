// Turn-hook body for `reasoning.check`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.sideModel / host.runAgent / host.getPreference / host.storage / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// apps-store/*/hooks is excluded from Biome — a module parser rejects it.
//
// WHY THIS GOES THROUGH runAgent, AND WHY IT INSISTS ON A MARKER
//
// The verdict lives in the `ryu-reasoning` sidecar, and the sandbox this fragment
// runs in has no HTTP and no capability call — by design, it is deny-by-default. The
// supported way out is `host.runAgent`, which is also what `@ryu/proof` uses. The
// sub-agent is not asked to JUDGE the answer (a second opinion is a different
// product, and `@ryu/double-check` already is it); it is asked only to CALL
// `reasoning.check` and report what the solver returned. The proof comes from the
// decision procedure; the agent is transport.
//
// That transport is CONDITIONAL, which is the whole reason for the marker protocol
// below. `delegation::call_sub_agent` only runs the real chat path — the sub-agent's
// own engine, tools and MCP servers, so `reasoning.check` exists — when an
// `agent_id` is given AND a live agent runner is present. With no runner it falls
// back to a single clean-context completion whose "tools" are a sentence in a system
// prompt, so the sub-agent has NOTHING to call and can only answer from its own
// opinion. A hook that printed that opinion as a policy verdict would be worse than
// no hook: it would look like a proof.
//
// So the sub-agent must end with a `SOLVER: <verdict>` line copied out of the tool's
// own `result` field, and a reply without one is reported as "could not run", never
// as a finding. A model with no tool cannot fabricate the marker without lying
// outright, and the failure it does produce is legible.

if (!(ctx.flags && ctx.flags["io.ryu.reasoning"])) {
	return { kind: "none" };
}

const rev = ctx.transcript.slice().reverse();
const lastAssistant = rev.find((m) => m.role === "assistant");
if (!(lastAssistant && lastAssistant.content.trim())) {
	return { kind: "none" };
}
const lastUser = rev.find((m) => m.role === "user");

// Which policy to check against. Without one there is nothing to prove anything
// from, and silently passing would be the worst possible default: the user turned
// the toggle on and would see no warning at all.
const policyId = await host.getPreference({ key: "reasoning-active-policy" });
if (!(policyId && String(policyId).trim())) {
	return {
		kind: "note",
		text:
			"Policy check skipped: no policy is selected. Pick one in Settings → Automated " +
			"Reasoning (the id of a policy from the Reasoning companion).",
	};
}

const task = [
	"Check an answer against a formal policy using the reasoning tools. Do NOT judge the",
	"answer yourself and do not use your own knowledge of the subject — your opinion is not",
	"what is wanted here. Call the tool and report exactly what it returns.",
	"",
	`1. Call the \`reasoning.check\` tool with policy_id ${JSON.stringify(String(policyId).trim())},`,
	"   the question, and the answer, both quoted verbatim below.",
	"2. For every finding whose verdict is `invalid`, write one line naming the claim, the",
	"   rules listed in its `responsible` array, and its `suggestions` text.",
	"3. End your reply with a final line, exactly:  SOLVER: <the tool's top-level `result`>",
	"   Copy that value verbatim from the tool output — valid, invalid, satisfiable,",
	"   impossible, no_translations, translation_ambiguous or too_complex.",
	"4. If you have no `reasoning.check` tool available, or the call errors, do NOT write a",
	"   SOLVER line and do NOT guess a verdict. Reply with one line saying what went wrong.",
	"",
	"<question>",
	lastUser ? lastUser.content : "(no question was recorded)",
	"</question>",
	"",
	"<answer>",
	lastAssistant.content,
	"</answer>",
].join("\n");

let report;
try {
	// `agent_id` is load-bearing, not decoration: it is what selects the real chat
	// path, which is the only path on which the reasoning tool exists at all.
	report = await host.runAgent({
		task,
		agent_id: ctx.agent_id,
		wall_time_secs: 120,
	});
} catch (e) {
	return { kind: "note", text: `Policy check could not run: ${e}` };
}

// The bridge hands back the sub-agent's final text; coerce defensively so a
// non-string never reaches the user as "[object Object]".
const text = (
	typeof report === "string" ? report : String(report ?? "")
).trim();
const marker = text.match(/SOLVER:\s*([a-z_]+)\s*$/im);
if (!marker) {
	return {
		kind: "note",
		text:
			"Policy check did not run: the verifier could not reach the reasoning tool, so " +
			"nothing was checked against the policy. (Its reply: " +
			(text || "empty") +
			")",
	};
}

const verdict = marker[1].toLowerCase();
// A proven answer, or one the policy has nothing to say about, is not worth
// interrupting for — the point of the check is the cases where it disagrees.
if (verdict === "valid" || verdict === "no_translations") {
	return { kind: "none" };
}

const body = text.replace(/\s*SOLVER:\s*[a-z_]+\s*$/im, "").trim();
return {
	kind: "note",
	text: `Policy check (${policyId}) — ${verdict}\n${body}`,
};
