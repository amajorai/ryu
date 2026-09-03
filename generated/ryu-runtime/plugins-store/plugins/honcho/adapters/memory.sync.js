// Capability adapter for `memory / memory.sync`, run in Core's plugin sandbox.
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (crates/core/tool-exec `build_capability_adapter_program`) and it `return`s the
// canonical result. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/adapters is excluded from Biome — a module parser rejects it.

// Honcho's write is a MESSAGE on a session, and every message carries the
// peer that produced it. That peer id is per-install configuration and it has
// to sit INSIDE messages[] — a nested position `arg_template` cannot reach,
// because a template substitutes only from the CALLER's arguments and never
// sees a resolved `pref:`. That gap is exactly why this provider was read-only;
// `defaults` arrives with the tokens already resolved, which closes it.
const ws = defaults.workspace_id;
const user = defaults.peer_id;
if (!ws || !user) {
	return {
		stored: false,
		error:
			"honcho: set the workspace id and peer id in the Honcho settings tab",
	};
}
// A settings field's `default` is UI-only and is never written to the
// preferences store, so an unset value DROPS its argument and hard-fails the
// call. Fall back here, in code — the one place a default actually applies.
const session = defaults.session_id || "ryu";
// An assistant turn is not the user's utterance. Attributing it to the user's
// peer would poison the representation Honcho derives about them, so Ryu speaks
// as its own peer.
const assistant = defaults.assistant_peer_id || "ryu";
const content = String((input && input.content) || "").trim();
if (!content) {
	return { stored: false, error: "honcho: nothing to store" };
}
const peer = input.role === "assistant" ? assistant : user;
const body = {
	workspace_id: ws,
	session_id: session,
	messages: [{ content, peer_id: peer }],
};
let res = await callTool(body);
// Documented success is a 201 ARRAY of created messages. Repair ONLY the failure an
// upsert can actually fix: a missing session or peer on a fresh install. These
// tools are fail_open, so a bad key arrives as {available,reason,hint} and every
// other non-2xx as {status,body} — retrying on "anything that is not an array"
// would turn one bad key into FOUR requests on a path that runs every turn.
// Honcho answers 404 for an absent path resource and 422 for a validation error;
// both are included because a nonexistent peer could plausibly be reported either
// way, and neither is reachable once the resources exist.
if (res && (res.status === 404 || res.status === 422)) {
	await callNamed("honcho.peer_upsert", { workspace_id: ws, id: peer });
	await callNamed("honcho.session_upsert", {
		workspace_id: ws,
		id: session,
	});
	res = await callTool(body);
}
if (!Array.isArray(res)) {
	// Not a result set — a fail_open envelope or a non-2xx. Pass it through rather
	// than reporting a write that did not happen as a success.
	return { raw: res };
}
return { stored: true, count: res.length, peer: peer, session: session };
