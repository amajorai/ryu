// Capability adapter for `memory / memory.store`, run in Core's plugin sandbox.
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (crates/core/tool-exec `build_capability_adapter_program`) and it `return`s the
// canonical result. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/adapters is excluded from Biome — a module parser rejects it.

// `memory.mirror-builtin` is ON by default and drives THIS verb, so leaving it
// unbound is what made the whole mirror setting inert while Honcho was selected.
// Honcho has no "store a fact" endpoint — it derives everything from messages —
// so a fact is written as a message from the user's peer, with the canonical
// scope kept in Honcho's documented per-message `metadata` rather than being
// silently dropped.
const ws = defaults.workspace_id;
const user = defaults.peer_id;
if (!ws || !user) {
	return {
		stored: false,
		error:
			"honcho: set the workspace id and peer id in the Honcho settings tab",
	};
}
const session = defaults.session_id || "ryu";
const content = String((input && input.content) || "").trim();
if (!content) {
	return { stored: false, error: "honcho: nothing to store" };
}
const metadata = { ryu_kind: "fact" };
if (input.scope) metadata.ryu_scope = input.scope;
if (input.category) metadata.ryu_category = input.category;
if (input.importance) metadata.ryu_importance = input.importance;
if (input.when_to_use) metadata.ryu_when_to_use = input.when_to_use;
const body = {
	workspace_id: ws,
	session_id: session,
	messages: [{ content, peer_id: user, metadata }],
};
let res = await callTool(body);
// Same narrow repair gate as memory.sync: only a missing session or peer is
// fixable by upserting, and this path runs on every builtin memory write.
if (res && (res.status === 404 || res.status === 422)) {
	await callNamed("honcho.peer_upsert", { workspace_id: ws, id: user });
	await callNamed("honcho.session_upsert", {
		workspace_id: ws,
		id: session,
	});
	res = await callTool(body);
}
if (!Array.isArray(res)) {
	return { raw: res };
}
return { stored: true, count: res.length, peer: user, session: session };
