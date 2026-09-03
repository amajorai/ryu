// Turn-hook body for `no-more-mistakes.capture`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.sideModel / host.spaces / host.storage / host.getPreference / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.
//
// What this is: the learning half. A correction ("no, never edit that file", "you
// broke the build again") is the one moment where the user states, for free, a rule
// they expect to hold forever — and today that rule lives exactly as long as the
// chat window does. This hook catches the correction as it is typed and has a side
// model compress it into ONE proposed line. It never persists model-derived text:
// the user must explicitly confirm with `/mistakes add ...` before it becomes a
// standing instruction.
//
// Why `pre_user_turn` and not `post_assistant_turn`: the correction is a USER
// message. On the post phase the correcting message has not been typed yet — the
// hook would be judging an answer nobody has objected to. Here `ctx.input` is the
// pending message and `ctx.transcript` still holds the answer it is objecting to,
// which is exactly the pair the rule has to be derived from.
//
// Three things this deliberately does NOT do:
//   1. It never returns `replace`. Rewriting the user's own words to smuggle a rule
//      in would change what is persisted as their message — the one text in the
//      conversation that must stay theirs. It returns `inject`, which appends to the
//      outgoing turn only. The proposal is shown as a note and takes effect only
//      after explicit confirmation.
//   2. It never files a rule the ledger already has. The existing titles go to the
//      model with the correction, and a `duplicate` verdict ends the turn — a ledger
//      that re-lists "don't run git stash" nine times is a ledger nobody reads.
//   3. It pre-gates in JS on correction-shaped wording BEFORE any host call, so an
//      ordinary turn costs a regex sweep and nothing else. There is no manifest
//      `match` that can express "this message reads like a complaint" (the pre-gate
//      grammar is flag / commands / stateful / tools), so the cheap gate has to live
//      here — and it is why this plugin is install-on-demand rather than pre-installed.

const MAX_ANSWER_CHARS = 6000;
const MAX_CORRECTION_CHARS = 2000;
const MAX_RULE_CHARS = 160;
const MAX_EXISTING_RULES = 40;
const DEFAULT_SPACE_NAME = "Mistakes";

// Correction markers, matched case-insensitively against the pending message.
// English-only on purpose: this is a cost gate, not the decision. A correction in
// another language simply is not auto-captured, and `/mistakes add` still records
// it by hand — which is the right failure, because the alternative (no gate) is a
// sandbox spawn plus a model call on every message anyone ever sends.
const CORRECTION_PATTERNS = [
	/\b(no|nope|wrong|incorrect)\b/i,
	/\bthat'?s (not|wrong|incorrect)\b/i,
	/\bnot what i (asked|wanted|said|meant)\b/i,
	/\byou (broke|deleted|removed|forgot|ignored|missed|misunderstood|misread)\b/i,
	/\byou (did|got) (it|that|this) (again|wrong)\b/i,
	/\bi (already )?(told|said|asked)\b.{0,20}\b(you|u|again|before)\b/i,
	/\b(don'?t|do not|never|stop|quit) (do|doing|use|using|run|running|touch|touching|add|adding|change|changing|edit|editing|delete|deleting|assume|assuming)\b/i,
	/\b(same|this) (mistake|problem|bug|issue) again\b/i,
	/\bthat (didn'?t|does ?n'?t|did not) work\b/i,
	/\bstill (broken|failing|wrong|not working)\b/i,
	/\b(revert|undo|roll ?back) (that|it|this)\b/i,
	/\bfor the (second|third|last|nth) time\b/i,
];

const convId = ctx.conversation_id;
const input = String(ctx.input || "").trim();

// A slash command is addressed to a plugin, not a complaint about an answer —
// `/mistakes forget 2` must never be mined as a correction of the last turn.
if (!input || input.charAt(0) === "/") {
	return { kind: "none" };
}

if ((await pref("mistakes-capture")) === "false") {
	return { kind: "none" };
}

// Per-conversation mute (`/mistakes off`) beats the global setting: it is the more
// specific, more recent instruction. Read before the regex sweep so a muted chat
// pays nothing at all.
if (convId && (await isMuted())) {
	return { kind: "none" };
}

if (!looksLikeCorrection(input)) {
	return { kind: "none" };
}

// The answer being corrected. Without one there is nothing to learn from: a
// complaint on the first turn of a chat is about something that happened elsewhere,
// and this hook can only see what is in front of it.
const answer = lastAssistantText(ctx.transcript || []);
if (!answer) {
	return { kind: "none" };
}

const spaceName = (await pref("mistakes-space")) || DEFAULT_SPACE_NAME;
let spaceId = null;
let existing = [];
try {
	spaceId = await host.spaces.ensureSpace({
		name: spaceName,
		description:
			"Rules learned from corrections, by the No More Mistakes plugin. Editing or deleting a document here changes what agents are told.",
	});
	existing = (await host.spaces.listDocs({ space_id: spaceId })) || [];
} catch (e) {
	// Fail open: a Space that cannot be reached costs the lesson, never the turn.
	host.log("no-more-mistakes: reading the ledger failed", e);
	return { kind: "none" };
}

const existingRules = existing
	.slice(0, MAX_EXISTING_RULES)
	.map((d) => String(d.title || "").trim())
	.filter(Boolean);

const raw = await host.sideModel({
	system:
		"You extract a durable rule from a moment where a user corrected an AI agent. " +
		"You are not answering the user and not continuing the work.\n\n" +
		"Decide first whether this is really a correction of the agent's behaviour — " +
		"a new request, a follow-up question, a vague complaint with no lesson in it, " +
		"or frustration with something outside the agent's control is NOT.\n\n" +
		"If it is, write ONE rule that would have prevented it. The rule must be:\n" +
		"- imperative and specific ('Never edit files under vendor/ — they are generated'), " +
		"not a platitude ('be more careful');\n" +
		"- true beyond this conversation. A one-off instruction about this task only is not a rule;\n" +
		"- under " +
		MAX_RULE_CHARS +
		" characters, one line, no markdown, no trailing period;\n" +
		"- written in the language the user used.\n\n" +
		"If an existing rule below already covers it, say duplicate instead of rewording it.\n\n" +
		"Answer with JSON only, no prose, no code fence:\n" +
		'{"verdict":"rule"|"duplicate"|"none","rule":"…","why":"…"}\n' +
		'"why" is one sentence naming what actually went wrong, for the record. ' +
		'Use "none" whenever you are unsure.',
	prompt:
		"Existing rules:\n" +
		(existingRules.length
			? existingRules.map((r) => "- " + r).join("\n")
			: "(none yet)") +
		"\n\nWhat the agent said:\n" +
		clampEnd(answer, MAX_ANSWER_CHARS) +
		"\n\nWhat the user replied:\n" +
		clampEnd(input, MAX_CORRECTION_CHARS),
	model_pref_key: "mistakes-model",
});

const verdict = parseVerdict(raw);
if (!verdict || verdict.verdict !== "rule") {
	return { kind: "none" };
}

const rule = oneLine(verdict.rule).slice(0, MAX_RULE_CHARS);
if (!rule) {
	return { kind: "none" };
}
// Second dedup pass in code: the model is asked to say `duplicate`, but an exact
// re-file is cheap to catch here and expensive to notice later.
if (existingRules.some((r) => sameRule(r, rule))) {
	return { kind: "none" };
}

// Model-derived rules are proposals only. Persistence and enforcement require
// an explicit user command, so untrusted assistant/tool text can never become a
// durable instruction through this hook.
return {
	kind: "note",
	text:
		"[No More Mistakes] Proposed standing rule: " +
		rule +
		". Nothing was saved. Confirm it explicitly with `/mistakes add " +
		rule +
		"` if you want it applied in future chats.",
};

// ── helpers ──────────────────────────────────────────────────────────────────

/** One preference as a trimmed string, or `""` on any failure. */
async function pref(key) {
	try {
		const v = await host.getPreference({ key: key });
		return v == null ? "" : String(v).trim();
	} catch (e) {
		return "";
	}
}

/** Whether `/mistakes off` muted learning in this conversation. */
async function isMuted() {
	try {
		const raw = await host.storage.get(convId);
		if (!raw) {
			return false;
		}
		return JSON.parse(raw).muted === true;
	} catch (e) {
		return false;
	}
}

/** Does the pending message read like a complaint about the last answer? */
function looksLikeCorrection(text) {
	for (const re of CORRECTION_PATTERNS) {
		if (re.test(text)) {
			return true;
		}
	}
	return false;
}

/** The most recent assistant message in the window, or `""`. */
function lastAssistantText(transcript) {
	for (let i = transcript.length - 1; i >= 0; i--) {
		if (transcript[i].role === "assistant") {
			return String(transcript[i].content || "").trim();
		}
	}
	return "";
}

/**
 * The side model's JSON verdict, or `null` if it did not produce one.
 *
 * Tolerates a fenced or prose-wrapped object by taking the first `{…}` span: a
 * local model that cannot be talked out of ```json fences would otherwise make the
 * whole plugin silently inert.
 */
function parseVerdict(value) {
	const text = String(value || "").trim();
	if (!text) {
		return null;
	}
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) {
		return null;
	}
	try {
		const parsed = JSON.parse(text.slice(start, end + 1));
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch (e) {
		return null;
	}
}

/** Collapse whitespace and drop a trailing period, so a rule is one clean line. */
function oneLine(value) {
	return String(value == null ? "" : value)
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\.$/, "");
}

/** Case- and punctuation-insensitive equality, for the code-side dedup pass. */
function sameRule(a, b) {
	const norm = (s) =>
		String(s)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " ")
			.trim();
	return norm(a) === norm(b);
}

/** Keep the END of an over-long text: the tail is where the correction lands. */
function clampEnd(text, max) {
	const s = String(text || "");
	return s.length > max ? s.slice(-max) : s;
}
