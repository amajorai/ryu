// Ryu PTC harness for the secure-exec backend.
//
// Core spawns this as:  bun <thisfile> <userCodeFile>
//
// Two layers of isolation/communication:
//   1. HARNESS <-> CORE: this Node/Bun process speaks Ryu's tagged stdio protocol
//      to Core over its own stdout/stdin — identical to the Deno backend's
//      protocol (TAG_CALL/TAG_LOG/TAG_DONE/TAG_ERROR) so Core's pump is the same
//      shape. The harness is the privileged host here.
//   2. GUEST <-> HARNESS: the user program runs inside a secure-exec VM
//      (`NodeRuntime`). It reaches Core's tools only through a single registered
//      host tool (`__ryu_tool`); the guest itself has no network/FS/stdio. When
//      the guest calls a tool, secure-exec round-trips to this harness's async
//      `handler`, which relays to Core (layer 1) and returns the result.
//
// The guest invokes tools synchronously (execFileSync on the registered command),
// so within one guest only one tool call is in flight at a time; Promise.all in
// guest code still works but serializes. Composio elicitation (pause/resume) is
// NOT supported on this backend yet — a suspend reply surfaces as a tool error.

import { readFileSync } from "node:fs";
import { NodeRuntime } from "secure-exec";

const TAG_CALL = "@@RYU_TOOL_CALL@@";
const TAG_LOG = "@@RYU_LOG@@";
const TAG_DONE = "@@RYU_DONE@@";
const TAG_ERROR = "@@RYU_ERROR@@";

function emit(s) {
	process.stdout.write(`${s}\n`);
}

function fatal(message) {
	emit(TAG_ERROR + message);
	process.exit(0);
}

const userCodePath = process.argv[2];
if (!userCodePath) {
	fatal("securexec harness: missing user-code file argument");
}

let userCode = "";
try {
	userCode = readFileSync(userCodePath, "utf8");
} catch (e) {
	fatal(`securexec harness: cannot read user code: ${e?.message ?? e}`);
}

// ── Layer 1: Core round-trip over stdin/stdout ────────────────────────────────
// Core writes reply lines to our stdin: { id, ok, value, error }. Match by id.
const pending = new Map();
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buf += chunk;
	let nl = buf.indexOf("\n");
	while (nl >= 0) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		let resp;
		try {
			resp = JSON.parse(line);
		} catch {
			resp = null;
		}
		if (resp && pending.has(resp.id)) {
			const resolve = pending.get(resp.id);
			pending.delete(resp.id);
			resolve(resp);
		}
		nl = buf.indexOf("\n");
	}
});

let callId = 0;
function coreRoundTrip(path, args) {
	const id = ++callId;
	return new Promise((resolve) => {
		pending.set(id, resolve);
		emit(TAG_CALL + JSON.stringify({ id, path, args: args ?? {} }));
	});
}

// ── Layer 2: the guest bootstrap (runs inside the secure-exec VM) ──────────────
// A `tools` proxy whose calls invoke the single registered host tool as a named
// command (the secure-exec host-callback mechanism). Returns the host's value.
const GUEST_BOOTSTRAP = `
import { execFileSync } from "node:child_process";
function __ryuCall(path, args) {
  const out = execFileSync("__ryu_tool", ["__ryu_tool", "--json", JSON.stringify({ path, args: args ?? {} })]);
  const resp = JSON.parse(out.toString() || "{}");
  if (!resp.ok) throw new Error(resp.error || "tool call failed");
  return resp.value;
}
function __ryuServer(server) {
  return new Proxy({}, { get: (_t, tool) => (args) => Promise.resolve(__ryuCall(server + "." + String(tool), args)) });
}
const tools = new Proxy({}, { get: (_t, server) => __ryuServer(String(server)) });
`;

// User code runs as an async IIFE; its return value (or a thrown error, captured
// as a sentinel) is delivered to the harness via globalThis.__return().
const guestProgram = `${GUEST_BOOTSTRAP}
(async () => {
${userCode}
})().then(
  (v) => { globalThis.__return(v ?? null); },
  (e) => { globalThis.__return({ __ryu_error__: (e && e.message) ? e.message : String(e) }); }
);
`;

// ── Run ───────────────────────────────────────────────────────────────────────
let rt;
try {
	rt = await NodeRuntime.create({
		tools: {
			__ryu_tool: {
				description: "Ryu tool bridge — routes a tools.* call back to Core.",
				inputSchema: { type: "object" },
				handler: async (input) => {
					const path = input?.path ?? "";
					const args = input?.args ?? {};
					// Returns Core's reply verbatim: { ok, value, error }.
					return await coreRoundTrip(path, args);
				},
			},
		},
	});
} catch (e) {
	fatal(`securexec harness: failed to create runtime: ${e?.message ?? e}`);
}

let result;
try {
	result = await rt.run(guestProgram);
} catch (e) {
	if (rt?.dispose) {
		await rt.dispose();
	}
	fatal(`securexec harness: guest run failed: ${e?.message ?? e}`);
}

if (rt?.dispose) {
	await rt.dispose();
}

// Relay guest stdout (console.log output) as Ryu log lines.
const stdout = typeof result?.stdout === "string" ? result.stdout : "";
for (const line of stdout.split("\n")) {
	if (line.length > 0) {
		emit(TAG_LOG + line);
	}
}

const value = result?.value ?? null;
if (value && typeof value === "object" && typeof value.__ryu_error__ === "string") {
	emit(TAG_ERROR + value.__ryu_error__);
} else {
	emit(TAG_DONE + JSON.stringify(value));
}
process.exit(0);
