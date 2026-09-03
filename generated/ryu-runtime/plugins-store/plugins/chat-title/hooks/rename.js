// Turn-hook body for `chat-title.rename`, run in Core's plugin sandbox.
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
// A forced run comes from the chat's own context menu ("Rename with AI"), which
// dispatches `hooks.run` with `event: { force: true }`. The user asked for this
// rename by name, so it skips every gate that exists to keep the AUTOMATIC pass
// quiet: the on/off preference, the first-turn rule, and the every-N interval.
// It also writes the title as `mode: "custom"` further down — a rename the user
// asked for must not be silently replaced by the next automatic pass.
const forced = Boolean(ctx.event && ctx.event.force);
const enabled = await host.getPreference({ key: "auto-title-enabled" });
if (!forced && enabled === "false") {
	return { kind: "none" };
}
let everyN = parseInt(
	(await host.getPreference({ key: "auto-title-every-n" })) || "5",
	10
);
if (!Number.isFinite(everyN) || everyN < 1) {
	everyN = 5;
}
if (everyN > 100) {
	everyN = 100;
}
// The first completed reply is its own trigger, independent of the interval:
// without it a chat reads as its raw first message (the placeholder Core derives
// on persist) until turn N, which is the whole "why is everything still called
// after my opening line" complaint. Default on; `auto-title-on-first-turn=false`
// restores the pure every-N cadence.
const onFirstTurn =
	(await host.getPreference({ key: "auto-title-on-first-turn" })) !== "false";
const assistantTurns = (ctx.transcript || []).filter(
	(m) => m.role === "assistant"
).length;
// The automatic pass needs a completed reply to title from. A forced run does
// not: the user can ask to rename a chat that has only their opening message,
// and the recent-turns slice below is what actually decides whether there is
// enough text to work with.
if (!forced && assistantTurns < 1) {
	return { kind: "none" };
}
const isFirstTurn = assistantTurns === 1 && onFirstTurn;
if (!forced && !isFirstTurn && assistantTurns % everyN !== 0) {
	return { kind: "none" };
}
const recent = (ctx.transcript || [])
	.slice(-12)
	.map((m) => (m.role || "?") + ": " + String(m.content || "").slice(0, 500))
	.join("\n");
if (!recent.trim()) {
	return { kind: "none" };
}
const raw = await host.sideModel({
	system:
		"You write a short, specific title for a chat conversation based on the recent turns. Reply with ONLY the title: 3 to 6 words, in the same language as the chat, no surrounding quotes, no trailing punctuation, no markdown. Do not answer the chat — only title it.",
	prompt: recent,
	model_pref_key: "auto-title-model",
});
if (!raw || !String(raw).trim()) {
	return { kind: "none" };
}
const title = String(raw).trim();
try {
	await host.setConversationTitle({
		id: convId,
		title,
		// "auto" skips a chat whose title the user already locked, which is right
		// for the scheduled pass and wrong for one they just asked for by name.
		mode: forced ? "custom" : "auto",
	});
} catch (e) {
	host.log("chat-title: setTitle failed", e);
	return { kind: "none" };
}
// A forced run reports what it did. `host.runHook` turns a `none` directive into
// an error, so the menu row's toast says "renamed" only when a rename actually
// happened — every early return above lands on the error copy instead. The
// automatic pass stays silent: a `note` is surfaced to the user out-of-band, and
// nobody wants a notification every fifth turn saying their chat was renamed.
return forced ? { kind: "note", text: 'Renamed to "' + title + '"' } : { kind: "none" };
