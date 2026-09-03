// Turn-hook body for `agent-comms.directory`, run in Core's plugin sandbox.
// Injected globals: `ctx` (here: the finished tool call) and `host`.
//
// A FRAGMENT, not an ES module — see hooks/deliver.js for why a top-level
// `return` is correct.
//
// WHY A REDACTION HOOK EXISTS AT ALL.
// `agents.directory` is a declarative HTTP tool onto Core's own `GET /api/agents`,
// and that response carries each custom agent's `system_prompt`. Handing it to the
// model would push every other agent's instructions into this agent's context on a
// call whose entire purpose is "who is on this node" — noise at best, and at worst
// one agent reading another's private prompt. `tool_result` + `transform` is Core's
// seam for exactly this: the projection happens BEFORE the model sees the value,
// so the raw response never enters the transcript.
//
// Gated by `match.tools` in the manifest, so an unrelated tool call does not spawn
// this sandbox.

const TOOL_ID = "agents.directory";
const MAX_DESCRIPTION = 400;

if (String(ctx.tool_name ?? "") !== TOOL_ID) {
	return { kind: "none" };
}

const output = ctx.tool_output;
if (output === null || output === undefined) {
	return { kind: "none" };
}

// `unwrap_body` may already have lifted the body, so accept either shape rather
// than assuming one: `{agents:[…]}` or a bare array.
let agents = null;
if (Array.isArray(output)) {
	agents = output;
} else if (typeof output === "object" && Array.isArray(output.agents)) {
	agents = output.agents;
}
if (agents === null) {
	// An error envelope (fail_open returns one) passes through untouched — it
	// carries no roster and the model needs to see why the call failed.
	return { kind: "none" };
}

const rows = agents.map((a) => {
	const row = {
		id: String((a && a.id) || ""),
		name: String((a && a.name) || ""),
	};
	const description = a && a.description ? String(a.description) : "";
	if (description !== "") {
		row.description = description.slice(0, MAX_DESCRIPTION);
	}
	if (a && a.model) {
		row.model = String(a.model);
	}
	if (a && a.engine) {
		row.engine = String(a.engine);
	}
	if (a && a.transport) {
		row.transport = String(a.transport);
	}
	if (a && a.recommended === true) {
		row.default = true;
	}
	return row;
});

return {
	kind: "transform",
	output: {
		ok: true,
		agents: rows.filter((r) => r.id !== ""),
		count: rows.filter((r) => r.id !== "").length,
		hint: "Message one with agents.send; delivery happens at the recipient's next turn.",
	},
};
