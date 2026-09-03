// Turn-hook body for `recap.turn`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.sideModel / host.storage / host.getPreference / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.
//
// What this is: the end-of-turn recap. A long agent turn scrolls past faster than
// anyone reads it, so a side model turns everything the agent said SINCE THE LAST
// USER MESSAGE into a few lines — what it did, what it touched, what is still open.
// It is a `note`, so it is surfaced beside the answer and never enters the history
// the model sees on the next turn (a recap fed back as context is just duplicated
// tokens the model then re-summarizes).
//
// Two deliberate limits:
//   1. `ctx.transcript` is TEXT ONLY (`HookMessage` is `{role, content}`), so the
//      recap describes what the agent SAID it did. Tool rows are not visible here,
//      and the `post_tool_use` phase that does see them carries no conversation id
//      and never fires for an ACP agent running its own tools in its own process —
//      so a tool ledger would be empty for exactly the agents most people run.
//   2. Short turns are skipped on a character count, before the model call. A
//      three-line answer is already its own recap; recapping it would cost a
//      round-trip to say the same thing twice.

const MAX_TURN_CHARS = 24000;
const MAX_STORED_ENTRIES = 30;
const MAX_STORED_ENTRY_CHARS = 1200;
const DEFAULT_MIN_CHARS = 1200;
const MAX_MIN_CHARS = 20000;

const convId = ctx.conversation_id;
if (!convId) {
	return { kind: "none" };
}

// Per-conversation mute (`/recap off`) beats the global setting: it is the more
// specific, more recent instruction. Read first so a muted chat never pays for a
// preference round-trip or a model call.
const state = await readState();
if (state.muted) {
	return { kind: "none" };
}

if ((await host.getPreference({ key: "recap-auto" })) === "false") {
	return { kind: "none" };
}

const turnText = textSinceLastUserMessage(ctx.transcript || []);
if (!turnText) {
	return { kind: "none" };
}
if (turnText.length < (await minChars())) {
	return { kind: "none" };
}

const detail = await detailLevel();
const raw = await host.sideModel({
	system:
		"You write the recap that goes at the end of a coding agent's turn. You are " +
		"summarizing work that has already happened — never continue it, never give " +
		"advice, never answer the user's question yourself.\n\n" +
		"Rules:\n" +
		"- Report only what the text below actually says was done. If it says it tried " +
		"and failed, the recap says it failed. Do not upgrade an attempt into a result.\n" +
		"- Name the concrete things: files, commands, endpoints, tests, numbers.\n" +
		"- No preamble, no 'In this turn', no restating the user's request.\n" +
		"- Write in the same language as the turn.\n\n" +
		"Shape:\n" +
		shapeFor(detail),
	prompt: turnText,
	model_pref_key: "recap-model",
});

const recap = String(raw || "").trim();
if (!recap) {
	return { kind: "none" };
}

// Keep the per-turn recaps so `/recap` can summarize the conversation from its own
// notes instead of re-reading a transcript that has already scrolled out of the
// 20-message hook window.
state.entries = (state.entries || []).concat([
	{ turn: (state.entries || []).length + 1, text: recap.slice(0, MAX_STORED_ENTRY_CHARS) },
]);
if (state.entries.length > MAX_STORED_ENTRIES) {
	state.entries = state.entries.slice(-MAX_STORED_ENTRIES);
}
try {
	await host.storage.set(convId, state);
} catch (e) {
	host.log("recap: storing the turn recap failed", e);
}

return { kind: "note", text: "Recap\n\n" + recap };

// ── helpers ──────────────────────────────────────────────────────────────────

/** The plugin's per-conversation state, or a fresh one on any read/parse failure. */
async function readState() {
	let raw = null;
	try {
		raw = await host.storage.get(convId);
	} catch (e) {
		return { entries: [], muted: false };
	}
	if (!raw) {
		return { entries: [], muted: false };
	}
	try {
		const parsed = JSON.parse(raw);
		return {
			entries: Array.isArray(parsed.entries) ? parsed.entries : [],
			muted: parsed.muted === true,
		};
	} catch (e) {
		return { entries: [], muted: false };
	}
}

/** The configured minimum turn length, clamped. `0` means "recap every turn". */
async function minChars() {
	let pref = null;
	try {
		pref = await host.getPreference({ key: "recap-min-chars" });
	} catch (e) {
		pref = null;
	}
	const n = Number.parseInt(String(pref == null ? "" : pref), 10);
	if (Number.isFinite(n) && n >= 0) {
		return Math.min(n, MAX_MIN_CHARS);
	}
	return DEFAULT_MIN_CHARS;
}

/** `brief` | `standard` | `detailed` (default `standard`). */
async function detailLevel() {
	let pref = null;
	try {
		pref = await host.getPreference({ key: "recap-detail" });
	} catch (e) {
		pref = null;
	}
	const v = String(pref || "").trim().toLowerCase();
	if (v === "brief" || v === "detailed") {
		return v;
	}
	return "standard";
}

/** The output shape asked of the side model, per detail level. */
function shapeFor(level) {
	if (level === "brief") {
		return "ONE sentence, under 25 words, saying what the turn accomplished. Nothing else.";
	}
	if (level === "detailed") {
		return (
			"One sentence saying what the turn accomplished, then a blank line, then 3-6 " +
			"bullets starting with '- ' covering what was changed, run, or found. Then a " +
			'blank line and a final line starting with "Open: " naming what is unfinished, ' +
			"unverified, or blocked — or 'Open: nothing outstanding.' if there is none."
		);
	}
	return (
		"One sentence saying what the turn accomplished, then a blank line, then 2-4 " +
		"bullets starting with '- ' naming the concrete changes. Nothing after the bullets."
	);
}

/**
 * Everything the agent said since the last user message — i.e. this turn, including
 * the extra assistant turns a `continue` directive looped through.
 *
 * Bounded from the END: when a turn is enormous the last words are the ones that say
 * how it came out, and the head of it is the part a recap can most afford to lose.
 */
function textSinceLastUserMessage(transcript) {
	let start = -1;
	for (let i = transcript.length - 1; i >= 0; i--) {
		if (transcript[i].role === "user") {
			start = i;
			break;
		}
	}
	const parts = [];
	for (const m of transcript.slice(start + 1)) {
		const content = String(m.content || "").trim();
		if (content) {
			parts.push(content);
		}
	}
	const joined = parts.join("\n\n").trim();
	return joined.length > MAX_TURN_CHARS ? joined.slice(-MAX_TURN_CHARS) : joined;
}
