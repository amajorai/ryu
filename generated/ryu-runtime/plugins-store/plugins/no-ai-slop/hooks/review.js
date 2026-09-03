// Turn-hook body for `no-ai-slop.review`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.runAgent / host.getPreference / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.
//
// The editing rules below are the bundled `no-ai-slop` skill, adapted from
// petergyang/no-ai-slop. They are inlined rather than read from a SKILL.md file
// on purpose: a built-in plugin's package directory does not exist on the user's
// machine (the same reason `plugin_manifest/builtin_code.rs` embeds this file),
// and the sandbox has no filesystem. One copy, no drift.

// The first line of every follow-up turn this hook injects. It is BOTH the
// human-readable header the user sees in the transcript AND the loop guard: on
// the next `post_assistant_turn` the hook counts how many consecutive user turns
// since the last real one start with this, and stops once the pass budget is
// spent. Without it, a `continue` directive would re-trigger the hook that issued
// it — forever, up to Core's MAX_CONTINUE_TURNS.
const MARKER = "No-AI-slop review (pass";

/** The bundled skill: what counts as slop, and how to fix it. */
const RULES = [
	"You are a sharp human editor checking one draft for AI slop. Preserve the writer's point and personal voice. Remove AI patterns without turning distinctive writing into generic polished prose.",
	"",
	"Words that are banned outright: delve, foster, leverage, utilize, facilitate, empower, streamline, robust, cutting-edge, paradigm shift, game changer, this is huge, this changes everything, tapestry, realm, beacon, multifaceted, meticulous, intricate, paramount, transformative, elevate, embark, supercharge, harness, ever-evolving.",
	"",
	"Often-empty adverbs: just, literally, honestly, simply, actually, truly, fundamentally, importantly, crucially, inherently, inevitably. Flag them only when they add nothing; keep them when they carry emphasis, uncertainty, contrast, or the writer's spoken rhythm.",
	"",
	"Often-empty phrases: it's worth noting, it's important to note, at the end of the day, when it comes to, at its core, in today's world, in the age of, the reality is, the truth is, in terms of, with regard to, in order to, going forward, let's dive in.",
	"",
	"Patterns to cut:",
	"- Binary contrasts. \"This is not X. It's Y.\" / \"It's not just X but Y.\" State Y directly.",
	"- Throat-clearing openers. \"Here's the thing,\" \"Let me be clear,\" \"I'll be honest.\"",
	"- Faux-insight setups. \"What most people get wrong,\" \"Here's what nobody tells you.\"",
	"- Colon reveals. A noun phrase, a colon, then a dramatic lowercase reveal. Rewrite as a plain sentence.",
	"- Superficial analysis. Trailing -ing clauses that pretend to explain meaning: highlighting, underscoring, reflecting, showcasing.",
	"- Importance puffery. \"Stands as a testament,\" \"marks a pivotal moment,\" \"plays a vital role.\" State the fact; let the reader judge.",
	"- Interpretive metadiscourse. \"That matters more than it sounds,\" \"The key point is,\" \"As you can see,\" redundant \"In other words.\"",
	"- Weasel attribution. \"Experts agree,\" \"studies show,\" \"widely regarded as.\" Name the source or cut the claim.",
	"- Fake-strong verbs. \"Serves as a centralized hub for\" instead of the plain \"is\" or \"has\".",
	"- Synonym cycling. If the clear word is right, repeat it; don't rotate terms for style.",
	"- Negative listing (\"Not a X. Not a Y. A Z.\") and dramatic fragmentation (\"That's it. That's the whole thing.\").",
	"- Robotic rhythm: repeated sentence shapes, identical paragraph structures, stacked punchy fragments.",
	"- Rhetorical setups. \"What if I told you,\" \"Think about it:\", \"Plot twist:\", self-answered question-answer pairs.",
	"- Fake-profound kickers: a final cute metaphor or mic-drop line. Delete it and end on the clearest concrete sentence.",
	"- Summary-recap endings. \"In conclusion,\" \"Ultimately,\" \"Overall,\" or a closing paragraph that restates the piece.",
	"- Formatting slop: emoji in headings, bold sprinkled mid-sentence, bullet lists where two sentences of prose read better, headers over two-sentence sections.",
	"- Em dashes used as a rhythm crutch. None in short copy; 1-2 in a longer draft only when they clearly beat commas, periods, or parentheses.",
	"",
	"Also flag: passive voice where an actor exists, abstraction where a number or mechanism belongs, weak verb phrases (\"made a decision\" for \"decided\"), and any sentence that could move unchanged to another person, company, or product (the portability test).",
	"",
	"Do NOT flag: strong opinions, blunt language, humor, profanity, self-interruptions, honest admissions, deliberate fragments, or a long spoken sentence that reads clearly. Those are voice, not slop. Never invent claims, examples, or statistics.",
].join("\n");

/** Read one preference as a plain string; `fallback` when unset or unreadable. */
async function pref(key, fallback) {
	let raw = null;
	try {
		raw = await host.getPreference({ key: key });
	} catch (e) {
		return fallback;
	}
	if (raw === null || raw === undefined) {
		return fallback;
	}
	// Preference values arrive as strings; a number/enum written by the settings
	// tab may still carry JSON quoting, so strip it before parsing.
	const s = String(raw).trim().replace(/^"|"$/g, "");
	return s === "" ? fallback : s;
}

const rev = ctx.transcript.slice().reverse();
const lastAssistant = rev.find((m) => m.role === "assistant");
if (!lastAssistant) {
	return { kind: "none" };
}

// ── Loop guard ───────────────────────────────────────────────────────────────
// Count the review passes already spent on THIS answer: consecutive newest-first
// user turns that this hook injected. The scan stops at the first real user turn,
// so the budget resets naturally on the user's next message. Derived entirely
// from the transcript, so it survives a restart and needs no stored state.
let spent = 0;
for (const m of rev) {
	if (m.role !== "user") {
		continue;
	}
	if ((m.content || "").trim().indexOf(MARKER) === 0) {
		spent += 1;
		continue;
	}
	break;
}

const manual = !!(ctx.flags && ctx.flags["io.ryu.no-ai-slop"]);
const configured = Number.parseInt(await pref("no-ai-slop-passes", "1"), 10);
let passes = Number.isFinite(configured) ? configured : 1;
if (manual && passes < 1) {
	// Auto mode is off (0 passes) but the user asked for this turn from the
	// composer "+" menu. Honour the request with a single pass.
	passes = 1;
}
if (passes < 1) {
	return { kind: "none" };
}
// Core caps a hook `continue` loop at MAX_CONTINUE_TURNS (25) for the WHOLE
// conversation, shared with every other looping plugin. Clamp well under it so a
// large setting degrades to "fewer passes", never to a turn that silently stops
// mid-loop.
if (passes > 12) {
	passes = 12;
}
if (spent >= passes) {
	return { kind: "none" };
}

// ── Cheap early-outs, before any sub-agent spend ──────────────────────────────
// The hook has no `match` gate (it must see every completed turn), so these run
// on every answer. Prose length is measured with code fences removed: a reply
// that is mostly a patch has nothing for an editor to do.
const draft = (lastAssistant.content || "").trim();
const prose = draft
	.replace(/```[\s\S]*?```/g, " ")
	.replace(/`[^`]*`/g, " ")
	.trim();
const floor = manual ? 40 : 240;
if (prose.length < floor) {
	return { kind: "none" };
}

const mode = await pref("no-ai-slop-mode", "revise");
const report = await host.runAgent({
	task:
		RULES +
		"\n\n## The draft to check\n\n" +
		draft +
		"\n\n## What to return\n\n" +
		"Report only the slop you can point at. For each one: quote the exact phrase, name the pattern, and give the replacement in a few words. No preamble, no score, no praise, no guess about whether AI wrote it.\n" +
		"If the draft is clean, reply with exactly: SLOP: none\n" +
		"Otherwise start your reply with the line: SLOP: found",
	agent_id: ctx.agent_id,
	// No tools: this is pure text judgement, and a fresh context every pass is the
	// point — the reviewer never sees the conversation that produced the draft, so
	// it cannot inherit its habits or its self-justification.
	preset: "summarise",
});

const findings = (report || "").trim();
if (!findings || /slop:\s*none/i.test(findings)) {
	// Clean answer: say nothing. A note on every clean turn would be its own slop.
	return { kind: "none" };
}

if (mode === "report") {
	// Report-only mode never issues a `continue`, so it cannot loop at all.
	return { kind: "note", text: findings };
}

return {
	kind: "continue",
	text:
		MARKER +
		" " +
		(spent + 1) +
		" of " +
		passes +
		") — a separate reviewer read your last answer with a fresh context and flagged the AI-slop patterns below.\n\n" +
		findings +
		"\n\nRewrite that answer to fix them. Keep the substance, the facts, and your own voice; change only what the report names. Reply with the rewritten answer alone — do not describe the edit, do not mention this review, and do not thank the reviewer.",
};
