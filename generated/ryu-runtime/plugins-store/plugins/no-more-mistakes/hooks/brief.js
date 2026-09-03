// Turn-hook body for `no-more-mistakes.brief`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.spaces / host.getPreference / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.
//
// What this is: the enforcing half. `no-more-mistakes.capture` writes rules; this
// reads them back on the FIRST turn of every conversation and appends them to the
// outgoing message, so the agent has them before it generates its first word.
//
// Why a `session_start` injection rather than leaving it to retrieval: the rules
// ARE in the Space and the Space IS embedded, so a RAG query could surface them —
// but only if the user's phrasing happens to be similar to a rule they wrote weeks
// ago about something else. "Never touch vendor/" has to arrive on the turn where
// the agent is about to touch vendor/, and nothing about that turn's wording
// retrieves it. A rule you have to get lucky to recall is not a rule.
//
// It fires once per conversation, not once per turn: after the first turn the rules
// are in the window the model already sees, and re-injecting them every turn would
// spend the same tokens again to say the same thing.

const DEFAULT_SPACE_NAME = "Mistakes";
const DEFAULT_MAX_RULES = 12;
const MAX_MAX_RULES = 50;
const MAX_RULE_CHARS = 200;

if ((await pref("mistakes-brief")) === "false") {
	return { kind: "none" };
}

const spaceName = (await pref("mistakes-space")) || DEFAULT_SPACE_NAME;

let docs = [];
try {
	const spaceId = await host.spaces.ensureSpace({
		name: spaceName,
		description:
			"Rules learned from corrections, by the No More Mistakes plugin. Editing or deleting a document here changes what agents are told.",
	});
	docs = (await host.spaces.listDocs({ space_id: spaceId })) || [];
} catch (e) {
	// Fail open: no briefing is a worse session, a blocked one is a worse product.
	host.log("no-more-mistakes: reading the ledger failed", e);
	return { kind: "none" };
}

// `listDocs` returns most-recently-updated first, so the cap keeps the rules the
// user has touched most recently rather than the ones they happened to write first.
const rules = docs
	.map((d) => String(d.title || "").trim().slice(0, MAX_RULE_CHARS))
	.filter(Boolean)
	.slice(0, await maxRules());

if (rules.length === 0) {
	return { kind: "none" };
}

return {
	kind: "inject",
	text:
		"\n\n[No More Mistakes] Standing rules from past corrections in this workspace. " +
		"They were written down because breaking them has already cost the user time once. " +
		"Follow them for the whole conversation; if one conflicts with what is being asked, " +
		"say so instead of silently ignoring it. Do not mention this list otherwise.\n" +
		rules.map((r, i) => String(i + 1) + ". " + r).join("\n"),
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

/** The configured briefing size, clamped. */
async function maxRules() {
	const n = Number.parseInt(await pref("mistakes-brief-max"), 10);
	if (Number.isFinite(n) && n > 0) {
		return Math.min(n, MAX_MAX_RULES);
	}
	return DEFAULT_MAX_RULES;
}
