// Turn-hook body for `recap.command`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.sideModel / host.storage / host.getPreference / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.
//
// `/recap` on demand. This is a `pre_user_turn` hook returning `handled`, so the
// command NEVER reaches the main model: the recap is written by the side model and
// becomes the assistant reply itself. That is the whole reason it lives on this
// phase — asking the working agent to summarize itself costs a full turn at the
// expensive model, in the same context it is trying to keep clear.
//
// The recap is assembled from two sources, and it needs both. The stored per-turn
// recaps (`recap.turn`) reach back past the 20-message hook window, but only exist
// for turns that were long enough to recap; the visible transcript tail covers the
// short turns and anything typed since. Neither alone is the conversation.

const MAX_TRANSCRIPT_CHARS = 16000;
const MAX_MESSAGE_CHARS = 1500;
const MAX_NOTES_CHARS = 8000;
const MAX_FOCUS_CHARS = 300;

// The Rust pre-gate (`match.commands`) is a prefix test, so it also lets
// `/recapture the tab` through. Require the whole word here: claiming a turn the
// user did not address to this plugin would answer a different command with a
// summary and never run it.
const convId = ctx.conversation_id;
const input = String(ctx.input || "").trim();
if (!convId || (input !== "/recap" && input.indexOf("/recap ") !== 0)) {
	return { kind: "none" };
}

const rest = input.slice("/recap".length).trim();
const word = rest.split(/\s+/)[0].toLowerCase();

// ── the mute switches ────────────────────────────────────────────────────────
if (word === "off" || word === "mute" || word === "stop") {
	const state = await readState();
	state.muted = true;
	await writeState(state);
	return {
		kind: "handled",
		text: "Automatic per-turn recaps are off for this chat. `/recap on` turns them back on, and `/recap` still works on demand.",
	};
}
if (word === "on" || word === "unmute" || word === "start") {
	const state = await readState();
	state.muted = false;
	await writeState(state);
	return {
		kind: "handled",
		text: "Automatic per-turn recaps are back on for this chat.",
	};
}
if (word === "clear" || word === "reset") {
	try {
		await host.storage.delete(convId);
	} catch (e) {
		host.log("recap: clearing stored recaps failed", e);
	}
	return {
		kind: "handled",
		text: "Cleared the stored per-turn recaps for this chat. Automatic recaps are on.",
	};
}

// ── the recap itself ─────────────────────────────────────────────────────────
// Anything after `/recap` that is not a switch is a focus ("/recap what changed in
// auth"). It is user text going into a side-model prompt, so it is bounded.
const focus = rest.slice(0, MAX_FOCUS_CHARS).trim();

const state = await readState();
const notes = (state.entries || [])
	.map((e, i) => "Turn " + (e.turn || i + 1) + ": " + String(e.text || "").trim())
	.filter((line) => line.length > 10)
	.join("\n\n")
	.slice(-MAX_NOTES_CHARS);

const conversation = transcriptDigest(ctx.transcript || []);
if (!notes && !conversation) {
	return {
		kind: "handled",
		text: "Nothing to recap yet — this conversation has no completed turns.",
	};
}

const raw = await host.sideModel({
	system:
		"You recap a coding-agent conversation for the person who was driving it. You " +
		"are summarizing work that has already happened — never continue it, never give " +
		"advice, never answer any question inside it yourself.\n\n" +
		"Rules:\n" +
		"- Report only what the material below says. If something was attempted and " +
		"failed, say it failed. Do not upgrade an attempt into a result.\n" +
		"- Name concrete things: files, commands, endpoints, tests, numbers.\n" +
		"- Merge duplicates: the same change described in two places is one bullet.\n" +
		"- Write in the same language as the conversation.\n" +
		(focus
			? "- The reader asked you to focus on: " + focus + "\n"
			: "") +
		"\nShape:\n" +
		"A line starting with 'Recap: ' saying where the conversation got to, then a " +
		"blank line, then up to 8 bullets starting with '- ' for what was done or " +
		"changed, then a blank line, then a final line starting with 'Open: ' naming " +
		"what is unfinished, unverified, or blocked — or 'Open: nothing outstanding.'",
	prompt:
		(notes ? "PER-TURN RECAPS SO FAR (oldest first):\n" + notes + "\n\n" : "") +
		(conversation ? "RECENT CONVERSATION (oldest first):\n" + conversation : ""),
	model_pref_key: "recap-model",
});

const recap = String(raw || "").trim();
if (!recap) {
	return {
		kind: "handled",
		text: "The recap model returned nothing. Check the recap model in Settings → Recap, or try again.",
	};
}
return { kind: "handled", text: recap };

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

/** Persist state; a storage failure must not cost the user their reply. */
async function writeState(state) {
	try {
		await host.storage.set(convId, state);
	} catch (e) {
		host.log("recap: storing state failed", e);
	}
}

/**
 * The visible conversation as `role: text` lines, oldest first, with the `/recap`
 * command itself dropped — it is the request for the summary, not part of what is
 * being summarized. Per-message and total lengths are both bounded; the total is cut
 * from the END, keeping the most recent turns.
 */
function transcriptDigest(transcript) {
	const lines = [];
	for (const m of transcript) {
		const role = m.role || "?";
		const content = String(m.content || "").trim();
		if (!content || content.indexOf("/recap") === 0) {
			continue;
		}
		lines.push(role + ": " + content.slice(0, MAX_MESSAGE_CHARS));
	}
	const joined = lines.join("\n\n").trim();
	return joined.length > MAX_TRANSCRIPT_CHARS
		? joined.slice(-MAX_TRANSCRIPT_CHARS)
		: joined;
}
