// Capability adapter for `verify.claim / verify.scopes`, run in Core's plugin sandbox.
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (crates/core/tool-exec `build_capability_adapter_program`) and it `return`s the
// canonical result. That is why a top-level `return` is correct here, and why
// apps-store/*/adapters is excluded from Biome — a module parser rejects it.

// A verification scope is a saved reasoning policy. Only the identifying fields are
// returned: the rules themselves are the policy author's, readable in the app.
const envelope = await callTool({});
if (!envelope || envelope.isError || envelope.available === false) {
	return { raw: envelope };
}
let listed = envelope.structuredContent;
if (listed === undefined) {
	try {
		listed = JSON.parse(envelope.content?.[0]?.text);
	} catch {
		return { raw: envelope };
	}
}
if (!Array.isArray(listed?.policies)) {
	return { raw: envelope };
}
return {
	scopes: listed.policies.map((p) => ({
		id: p.id,
		name: p.name,
		description: p.description || "",
		version: p.version,
	})),
};
