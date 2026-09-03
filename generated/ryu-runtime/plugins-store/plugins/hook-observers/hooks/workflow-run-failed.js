// Turn-hook body for `observers.workflow-run-failed`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.sideModel / host.storage / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.
//
// `workflow_run_failed` is a KERNEL lifecycle phase: it fires from Core's workflow
// executor, not from an app, so it needs no app to be installed. It fires once per
// run as a user understands it — not per resume, not per nested sub-workflow.

const event = ctx.event || {};
const name = event.workflow_name || event.workflow_id || "a workflow";

return {
	kind: "note",
	text: "workflow failed: " + name + (event.error ? " — " + event.error : ""),
};
