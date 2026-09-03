// Turn-hook body for `observers.meeting-ended`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.sideModel / host.storage / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.
//
// This one subscribes to an **app event** rather than a Core phase: the Meetings
// app declares `com.ryu.meetings#meeting.ended` in its manifest `hook_events` and
// raises it from its own backend. Nothing in Core knows this plugin exists, and
// nothing in Meetings knows it is being observed — which is the whole point of the
// event seam.
//
// Subscribing to an event whose app is not installed is deliberately legal: this
// hook simply never fires until Meetings is installed and enabled.
//
// An app-event hook fires with NO turn in flight, so only `none` and `note` mean
// anything here; a `continue`/`replace`/`inject` would be dropped by Core. The note
// lands on the unified activity feed rather than in a chat.

const event = ctx.event || {};
const title = event.title || event.meeting_id || "a meeting";

return {
	kind: "note",
	text: "meeting ended: " + title,
};
