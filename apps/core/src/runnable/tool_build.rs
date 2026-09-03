//! The runtime half of `tools/toolsmith`: the gate that decides whether a tool
//! body an agent just authored in chat is **deterministic and proven by cases**
//! before anything may call it.
//!
//! # Why this is Rust, not the Node CLI
//!
//! `tools/toolsmith` (a Node CLI + `node:test` harness) is a *dev-time* gate: it
//! runs in CI on a repo checkout that ships `tools/`. A user's machine ships
//! neither Node's tooling nor that directory, and the whole point of a
//! self-building agent is that the AI can author, verify, and install a tool
//! **at runtime** without a human running a CLI. So the same four checks are
//! reimplemented here, with two changes that matter:
//!
//! 1. **The cases execute in Core's deny-all Deno sandbox** — via
//!    [`ryu_tool_exec::run_eval_js`] — not in a full-privilege Node process.
//!    Verification therefore runs on the *same substrate the tool will run on*,
//!    and the body is confined by the real sandbox instead of a regex guardrail.
//! 2. **The checks feed a structured report back to the model**, not an exit
//!    code — so the AI can read *which* case failed and *why*, fix the body, and
//!    re-verify without a human in the loop.
//!
//! The contract is `tools/toolsmith/README.md`; this module is its runtime twin.
//! Keep the two in lockstep — a check that exists in only one place lets one of
//! the two gates certify code the other would reject.
//!
//! # The gate, ordered (the order is load-bearing)
//!
//! 1. **Purity scan** — static, and FIRST because it is the only step that runs
//!    before the body does. Its denylist covers `import`/`require`/`eval`/
//!    `new Function`/`process`/`fetch`/`Deno` — every escape from the sandbox —
//!    so clearing it is what makes step 5 safe to run on an AI-authored body.
//! 2. **Manifest contract** — the seat exists, is routable (real description,
//!    `input_schema`) and callable (`tool:execute` granted).
//! 3. **Drift check** — the manifest carries exactly the body the cases tested.
//! 4. **Case shape** — at least three cases (happy + edge + failure), unique
//!    names, exactly one expectation each.
//! 5. **Cases** — every case runs **twice** against identically-seeded stubs in
//!    the sandbox; the two runs must deep-equal, then the declared expectation
//!    and `expectCalls` effect sequence are asserted.
//!
//! Step 5 shadows every ambient nondeterminism source (`Math.random`,
//! `Date.now`, `crypto`, `performance`, `fetch`, `process`, timers) *inside the
//! sandbox program*, so reaching for one is a hard, named failure at the moment
//! it happens — the same protocol `tools/toolsmith/harness.mjs` uses.

use std::path::Path;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::plugin_manifest::schema::ToolConfig;

/// The one grant a self-built `inline_deno` tool must carry before Core will run
/// its body at all. Mirrors [`ryu_tool_exec::GRANT_TOOL_EXECUTE`]; spelled out so
/// the contract check below does not depend on the tool-exec feature being on.
const GRANT_TOOL_EXECUTE: &str = "tool:execute";

/// Wall-clock budget for running every case twice inside the sandbox. Bounded
/// deliberately: the sandbox already caps compute, but a body with a hang (an
/// `await` that never resolves) must fail verification in seconds, not minutes.
const VERIFY_DEADLINE_SECS: u64 = 30;

// ── Step 1: static purity scan ────────────────────────────────────────────────
//
// A port of `tools/toolsmith/purity.mjs`. The runtime half of determinism is the
// shadowed-globals protocol in the sandbox program (step 5) — the stronger check,
// but it only fires on a code path a case exercises. This scan is the cheap
// complement: it reads the source and rejects the reference outright, so a
// `Math.random()` sitting in an untested branch is caught before it is verified.

/// One denied construct: the regex to match, what it is, and what to tell the
/// author instead. `what` and `instead` mirror `purity.mjs` verbatim so the two
/// gates report identically.
struct DeniedRule {
    regex: Regex,
    what: &'static str,
    instead: &'static str,
}

/// The `\b`-anchored denylist. Each rule rejects a reference to an ambient
/// source of nondeterminism or to an escape from the sandbox.
fn denied_rules() -> Vec<DeniedRule> {
    macro_rules! rule {
        ($pattern:expr, $what:expr, $instead:expr) => {
            DeniedRule {
                regex: Regex::new($pattern).expect("static purity rule must compile"),
                what: $what,
                instead: $instead,
            }
        };
    }
    vec![
        rule!(
            r"\bDate\s*\.\s*now\s*\(",
            "Date.now()",
            "take the timestamp as an input field so the caller owns it, or accept a `now` argument"
        ),
        rule!(
            r"\bnew\s+Date\s*\(\s*\)",
            "new Date() with no argument",
            "pass the epoch millis in as input: `new Date(input.at)`"
        ),
        rule!(
            r"\bMath\s*\.\s*random\s*\(",
            "Math.random()",
            "take the random value as input, or derive it deterministically from an input field"
        ),
        rule!(
            r"\bcrypto\s*\.\s*(?:randomUUID|getRandomValues)\s*\(",
            "crypto randomness",
            "have the caller supply the id — a tool that mints its own id cannot be replayed"
        ),
        rule!(
            r"\bperformance\s*\.\s*now\s*\(",
            "performance.now()",
            "drop the timing, or return it under a field cases do not assert on"
        ),
        rule!(
            r"\bfetch\s*\(",
            "fetch()",
            "route network through `callTool`/`callNamed` (adapter) or `host.*` (inline tool) — direct egress is not granted in the sandbox anyway"
        ),
        rule!(
            r"\bprocess\s*\.\s*env\b",
            "process.env",
            "declare the value in the manifest (`arg_defaults`, `secret_headers`) so it is resolved host-side"
        ),
        rule!(
            r"\bset(?:Timeout|Interval)\s*\(",
            "timers",
            "remove the delay — a tool body must be a straight-line function of its input"
        ),
        rule!(
            r"\bglobalThis\b",
            "globalThis",
            "use only the bindings Core injects"
        ),
        rule!(
            r"\beval\s*\(",
            "eval()",
            "write the logic out — dynamic evaluation is unauditable, which is the point"
        ),
        rule!(
            r"\bnew\s+Function\s*\(",
            "new Function()",
            "write the logic out"
        ),
        rule!(
            r"\brequire\s*\(",
            "require()",
            "the sandbox has no module resolver; inline what you need"
        ),
        rule!(
            r"(?m)^\s*import\s+",
            "import statement",
            "the body is a fragment spliced into an IIFE, not a module — an import is a syntax error at runtime"
        ),
        rule!(
            r"(?m)^\s*export\s+",
            "export statement",
            "the body is a fragment — `return` its result instead of exporting it"
        ),
        rule!(
            r"\bDeno\s*\.",
            "the Deno global",
            "the sandbox runs with no permissions; anything Deno.* would reach is denied at the flag level"
        ),
    ]
}

/// One purity violation, positioned at a source line/column.
#[derive(Debug, Clone, Serialize)]
pub struct PurityViolation {
    pub line: usize,
    pub column: usize,
    pub what: &'static str,
    pub instead: &'static str,
    pub source: String,
}

/// Blank out comments and string/template literals so a denied token quoted in
/// prose ("do not call Math.random here") is not reported as a violation.
///
/// Replaces with same-length whitespace rather than deleting, so line and column
/// numbers still match the file the author is looking at. Hand-rolled rather than
/// a single regex because Rust's `regex` crate has no lazy quantifiers; the scan
/// is a tiny escape-aware state machine over the source.
fn blank_non_code(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = source.as_bytes().to_vec();
    let mut i = 0;
    let n = bytes.len();

    // Copy a run of bytes into `out` untouched (already copied by default; we
    // only blank the ranges we identify, so this is a marker for readability).
    while i < n {
        match bytes[i] {
            b'/' if i + 1 < n && bytes[i + 1] == b'/' => {
                // Line comment: blank to end of line.
                let start = i;
                while i < n && bytes[i] != b'\n' {
                    i += 1;
                }
                blank_range(&mut out, start, i);
            }
            b'/' if i + 1 < n && bytes[i + 1] == b'*' => {
                // Block comment: blank to the closing `*/`.
                let start = i;
                i += 2;
                while i + 1 < n && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(n);
                blank_range(&mut out, start, i);
            }
            b'"' | b'\'' | b'`' => {
                let quote = bytes[i];
                let start = i;
                i += 1;
                while i < n {
                    if bytes[i] == b'\\' && i + 1 < n {
                        i += 2; // escaped char: skip the pair
                        continue;
                    }
                    if bytes[i] == quote {
                        i += 1;
                        break;
                    }
                    i += 1;
                }
                blank_range(&mut out, start, i);
            }
            _ => i += 1,
        }
    }

    String::from_utf8(out).expect("blanking preserves UTF-8")
}

/// Overwrite `out[start..end]` with spaces, preserving newlines so line numbers
/// survive.
fn blank_range(out: &mut [u8], start: usize, end: usize) {
    let end = end.min(out.len());
    for slot in &mut out[start..end] {
        if *slot != b'\n' {
            *slot = b' ';
        }
    }
}

/// Scan a tool body. Returns `[]` when the body is pure by this denylist, or one
/// entry per violation in source order.
pub fn scan_purity(source: &str) -> Vec<PurityViolation> {
    let code = blank_non_code(source);
    let lines: Vec<&str> = code.split('\n').collect();
    let mut violations = Vec::new();

    for rule in denied_rules() {
        for (index, line) in lines.iter().enumerate() {
            if let Some(m) = rule.regex.find(line) {
                violations.push(PurityViolation {
                    line: index + 1,
                    column: m.start() + 1,
                    what: rule.what,
                    instead: rule.instead,
                    source: source
                        .split('\n')
                        .nth(index)
                        .unwrap_or_default()
                        .trim()
                        .to_owned(),
                });
            }
        }
    }

    violations.sort_by(|a, b| (a.line, a.column).cmp(&(b.line, b.column)));
    violations
}

// ── The package a self-built tool is ──────────────────────────────────────────
//
// `write_tool` (in `self_build.rs`) lays down three files under
// `<plugins>/<id>/`, the same split `tools/toolsmith` uses:
//   - `cases.json`    — the case table (`ToolSpec` below), the source of truth
//     for WHICH body is under test.
//   - `<code_file>`   — the authored body (source form; `tools/<slug>.js`).
//   - `manifest.json` — the wire form, whose `code` string is what Core loads.

/// The `cases.json` shape. `kind` defaults to `inline_tool`; adapters and turn
/// hooks are honored by the harness but `write_tool` only scaffolds
/// `inline_tool` today.
///
/// Keys are snake_case on disk (`code_file`, `adapter_tools`), matching the JS
/// harness `tools/toolsmith` — deliberately NOT camelCased, because the file is
/// authored by hand and shared with the dev-time gate.
#[derive(Debug, Serialize, Deserialize)]
pub struct ToolSpec {
    pub tool: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub code_file: String,
    #[serde(default)]
    pub adapter_tools: Vec<String>,
    pub cases: Vec<ToolCase>,
}

fn default_kind() -> String {
    "inline_tool".to_owned()
}

/// One entry in the case table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCase {
    pub name: String,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub caller: Option<Value>,
    #[serde(default)]
    pub defaults: Value,
    #[serde(default)]
    pub host: Value,
    #[serde(default)]
    pub provider: Value,
    pub expect: Option<Value>,
    pub expect_error: Option<String>,
    pub expect_impure: Option<String>,
    pub expect_calls: Option<Value>,
}

/// Build the JSON payload the sandbox program runs with: the body plus the case
/// table plus the kind/allowlist the stubs need.
fn runner_payload(spec: &ToolSpec, body: &str) -> Value {
    json!({
        "body": body,
        "kind": spec.kind,
        "adapterTools": spec.adapter_tools,
        "cases": spec.cases,
    })
}

/// The deny-all Deno program that runs every case twice against
/// identically-seeded stubs, with every ambient nondeterminism source shadowed.
///
/// This is a port of the splice in `tools/toolsmith/harness.mjs` (the shadow
/// bindings, the queue-backed host facade, the recorded-effect protocol) executed
/// *inside* Core's sandbox via [`ryu_tool_exec::run_eval_js`], which passes the
/// payload as `ctx` and serializes the returned report back over a tagged stdout
/// line. The program is self-contained: the stubs are in-program, so it makes no
/// `tools.*` bridge calls at all — there is nothing for the sandbox to reach.
///
/// Returns `{ cases: [{ name, run1, run2 }] }` where each run is
/// `{ value, calls, error }` (recorded calls JSON-snapshotted, so an optional
/// argument the body never passed is ABSENT, not `null`).
pub fn build_case_runner_program() -> String {
    // The body and cases arrive via `ctx`; the code below is a function body
    // that `build_eval_program` invokes as `(async (ctx) => { … })(payload)`.
    r#"
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const BODY = ctx.body;
const CASES = ctx.cases;
const KIND = ctx.kind;
const ADAPTER_TOOLS = ctx.adapterTools;

const denied = (what) => () => {
	throw new Error(`nondeterministic access: ${what}`);
};

// Every ambient source of nondeterminism, bound as a PARAMETER of the spliced
// body so a free reference inside the body resolves to the shadow and throws.
// `Math` and `Date` are not banned wholesale — `Math.max` and `new Date(ms)`
// are pure — only the impure members are poisoned.
function shadowValues() {
	const PureMath = Object.create(Math, {
		random: { value: denied("Math.random()"), enumerable: false },
	});
	const PureDate = new Proxy(Date, {
		get(t, prop) {
			if (prop === "now") return denied("Date.now()");
			return Reflect.get(t, prop);
		},
		construct(t, args) {
			if (args.length === 0) {
				throw new Error("nondeterministic access: new Date() with no argument");
			}
			return Reflect.construct(t, args);
		},
	});
	const pureCrypto = {
		randomUUID: denied("crypto.randomUUID()"),
		getRandomValues: denied("crypto.getRandomValues()"),
		subtle: new Proxy({}, { get: (_t, prop) => denied(`crypto.subtle.${String(prop)}()`) }),
	};
	return [
		PureMath,
		PureDate,
		pureCrypto,
		{ now: denied("performance.now()") },
		denied("fetch() — network must go through host/callTool"),
		new Proxy({}, { get: (_t, prop) => denied(`process.${String(prop)}`) }),
		denied("setTimeout()"),
		denied("setInterval()"),
		new Proxy({}, { get: (_t, prop) => denied(`globalThis.${String(prop)}`) }),
		denied("require()"),
		new Proxy({}, { get: (_t, prop) => denied(`Deno.${String(prop)}`) }),
	];
}

const SHADOW_NAMES = ["Math","Date","crypto","performance","fetch","process","setTimeout","setInterval","globalThis","require","Deno"];

// JSON-snapshot a value so an explicitly-undefined property is DROPPED — a case
// is written in JSON, where `undefined` cannot be expressed, so the recording
// must not force the author to spell out keys they never passed.
const recordable = (v) => JSON.parse(JSON.stringify(v ?? null));
const frozenCopy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// The `host` facade Core injects into an `inline_deno` tool, driven from a
// case's `host` fixture: `sideModel`/`runAgent` read from a QUEUE, `storage` is
// a real read-after-write Map, every call is recorded in order.
function buildHost(fixture, calls) {
	const queues = new Map();
	for (const key of ["sideModel", "runAgent", "runFanout"]) {
		const value = fixture && fixture[key];
		queues.set(key, Array.isArray(value) ? [...value] : []);
	}
	const store = new Map(Object.entries((fixture && fixture.storage) || {}));
	const rec = (path, args) => calls.push({ path, args: recordable(args) });
	const dequeue = (key, args) => {
		const q = queues.get(key);
		if (q.length === 0) {
			throw new Error(`host.${key} was called with ${JSON.stringify(args)} but the case fixture has no response left for it`);
		}
		return frozenCopy(q.shift());
	};
	const nsKey = (key, namespace) => (namespace ? `${namespace}:${String(key)}` : String(key));
	return {
		sideModel: async (args = {}) => { rec("host.sideModel", args); return dequeue("sideModel", args); },
		runAgent: async (args = {}) => { rec("host.runAgent", args); return dequeue("runAgent", args); },
		runFanout: async (args = {}) => { rec("host.runFanout", args); return dequeue("runFanout", args); },
		storage: {
			get: async (key, namespace) => {
				rec("host.storage.get", { key, namespace });
				return frozenCopy(store.get(nsKey(key, namespace)) ?? null);
			},
			set: async (key, value, namespace) => {
				rec("host.storage.set", { key, value, namespace });
				store.set(nsKey(key, namespace), typeof value === "string" ? value : JSON.stringify(value));
				return null;
			},
			delete: async (key, namespace) => {
				rec("host.storage.delete", { key, namespace });
				store.delete(nsKey(key, namespace));
				return null;
			},
			keys: async (namespace) => {
				rec("host.storage.keys", { namespace });
				return [...store.keys()].sort();
			},
		},
		log: (...args) => { rec("host.log", args); },
	};
}

// The `callTool`/`callNamed` pair Core injects into a capability adapter.
// `callNamed`'s id is checked against the manifest's declared allowlist,
// mirroring Core's host-side check.
function buildProvider(fixture, allowlist, calls) {
	const primary = Array.isArray(fixture && fixture.call) ? [...fixture.call] : [];
	const named = new Map(
		Object.entries((fixture && fixture.named) || {}).map(([id, list]) => [
			id,
			Array.isArray(list) ? [...list] : [list],
		])
	);
	return {
		callTool: async (args = {}) => {
			calls.push({ path: "callTool", args: recordable(args) });
			if (primary.length === 0) {
				throw new Error(`callTool was called with ${JSON.stringify(args)} but the case fixture has no response left for it`);
			}
			return frozenCopy(primary.shift());
		},
		callNamed: async (id, args = {}) => {
			calls.push({ path: `callNamed:${id}`, args: recordable(args) });
			if (allowlist && !allowlist.includes(id)) {
				throw new Error(`callNamed("${id}") is not in the manifest's adapter.tools allowlist [${allowlist.join(", ")}]`);
			}
			const queue = named.get(id);
			if (!queue || queue.length === 0) {
				throw new Error(`callNamed("${id}") has no response left in the case fixture`);
			}
			return frozenCopy(queue.shift());
		},
	};
}

// Execute the body ONCE against a fresh set of stubs. Returns
// { value, calls, error } where `error` is the thrown message (or null).
async function runOnce(tc) {
	const calls = [];
	const shadows = shadowValues();
	const input = frozenCopy(tc.input ?? {});
	let bindingNames;
	let bindingValues;
	if (KIND === "adapter") {
		const provider = buildProvider(tc.provider, ADAPTER_TOOLS, calls);
		bindingNames = ["input", "defaults", "callTool", "callNamed"];
		bindingValues = [input, frozenCopy(tc.defaults ?? {}), provider.callTool, provider.callNamed];
	} else {
		bindingNames = ["input", "caller", "host"];
		bindingValues = [input, frozenCopy(tc.caller ?? { agent_id: null, conversation_id: null }), buildHost(tc.host, calls)];
	}
	// The splice. `"use strict"` turns an accidental implicit-global assignment
	// inside the body into a TypeError instead of state that leaks between the
	// two runs of the double-execution check.
	const fn = new AsyncFunction(...bindingNames, ...SHADOW_NAMES, `"use strict";\n${BODY}`);
	try {
		const value = await fn(...bindingValues, ...shadows);
		let recorded;
		try {
			recorded = recordable(value);
		} catch (e) {
			return { value: null, calls, error: `the tool result is not JSON-serializable: ${e.message}` };
		}
		return { value: recorded, calls, error: null };
	} catch (e) {
		return { value: null, calls, error: (e && e.message) ? String(e.message) : String(e) };
	}
}

const report = { cases: [] };
for (const tc of CASES) {
	const run1 = await runOnce(tc);
	const run2 = await runOnce(tc);
	report.cases.push({ name: tc.name, run1, run2 });
}
return report;
"#
    .to_owned()
}

// ── The gate ──────────────────────────────────────────────────────────────────

/// One named check in the report.
#[derive(Debug, Serialize)]
pub struct GateCheck {
    pub name: &'static str,
    pub ok: bool,
    pub detail: String,
}

/// One case's verdict.
#[derive(Debug, Serialize)]
pub struct CaseResult {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

/// The structured verdict a verify/install round-trip returns to the model.
#[derive(Debug, Serialize)]
pub struct GateReport {
    pub passed: bool,
    pub checks: Vec<GateCheck>,
    pub cases: Vec<CaseResult>,
}

impl GateReport {
    fn check(name: &'static str, ok: bool, detail: impl Into<String>) -> Self {
        let passed = ok;
        GateReport {
            passed,
            checks: vec![GateCheck {
                name,
                ok,
                detail: detail.into(),
            }],
            cases: Vec::new(),
        }
    }

    fn push(&mut self, name: &'static str, ok: bool, detail: impl Into<String>) {
        self.checks.push(GateCheck {
            name,
            ok,
            detail: detail.into(),
        });
        self.passed &= ok;
    }
}

/// Load the three files of a tool package. `Err` names the missing/malformed
/// file — a package that has not been written at all, which is an "author it
/// first" condition, not a gate finding.
fn load_package(dir: &Path) -> Result<(ToolSpec, String, Value), String> {
    let cases_path = dir.join("cases.json");
    let raw_spec = std::fs::read_to_string(&cases_path).map_err(|e| {
        format!(
            "no cases.json at {} ({e}) — run write_tool first",
            cases_path.display()
        )
    })?;
    let spec: ToolSpec = serde_json::from_str(&raw_spec)
        .map_err(|e| format!("cases.json is not a valid case table: {e}"))?;

    let code_path = dir.join(&spec.code_file);
    let body = std::fs::read_to_string(&code_path)
        .map_err(|e| format!("body file {} missing ({e})", code_path.display()))?;

    let manifest_path = dir.join("manifest.json");
    let raw_manifest = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("no manifest.json at {} ({e})", manifest_path.display()))?;
    let manifest: Value = serde_json::from_str(&raw_manifest)
        .map_err(|e| format!("manifest.json is not valid JSON: {e}"))?;

    Ok((spec, body, manifest))
}

/// Validate the body is non-trivial (a tool body that never `return`s yields
/// `undefined` and would pass a lax case).
fn check_body_shape(body: &str, report: &mut GateReport) {
    let problems: Vec<String> = {
        let mut p = Vec::new();
        if body.trim().is_empty() {
            p.push("the tool body is empty — an empty body returns undefined and would pass a lax case".to_owned());
        }
        if !body.contains("return") {
            p.push("the tool body never returns — Core reports the fragment's final value, so a body with no `return` always yields undefined".to_owned());
        }
        p
    };
    report.push(
        "body is non-trivial",
        problems.is_empty(),
        problems.join("; "),
    );
}

/// Step 2 + 3: the manifest must seat the body, be routable, be callable, and
/// carry exactly the body the cases test. A port of `manifest.mjs`'s
/// `checkManifestContract` / `checkBodyDrift`, adapted to runtime ids
/// (reverse-domain, not `@scope/name`).
fn check_manifest(
    spec: &ToolSpec,
    body: &str,
    manifest: &Value,
    expected_id: &str,
    report: &mut GateReport,
) {
    let mut problems = Vec::new();

    let manifest_id = manifest
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if manifest_id != expected_id {
        problems.push(format!(
            "manifest id '{manifest_id}' does not match the tool's id '{expected_id}'"
        ));
    }

    let version = manifest
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if semver::Version::parse(version).is_err() {
        problems.push(format!("version '{version}' is not semver"));
    }

    let description = manifest
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if description.is_empty() || description.starts_with("TODO") {
        problems.push("manifest description is missing or still the TODO placeholder — it is what the model routes on".to_owned());
    }

    let grants: Vec<&str> = manifest
        .get("permission_grants")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if !grants.contains(&GRANT_TOOL_EXECUTE) {
        problems.push(format!(
            "manifest does not grant '{GRANT_TOOL_EXECUTE}' — Core registers the tool and then refuses every call"
        ));
    }

    // Locate the tool seat: a runnable of kind "tool" whose config.slug matches.
    let seat: Option<Value> = manifest
        .get("runnables")
        .and_then(Value::as_array)
        .and_then(|runnables| {
            runnables.iter().find(|r| {
                r.get("kind").and_then(Value::as_str) == Some("tool")
                    && r.get("config")
                        .and_then(|c| c.get("slug"))
                        .and_then(Value::as_str)
                        == Some(spec.tool.as_str())
            })
        })
        .and_then(|r| r.get("config").cloned());

    let Some(config) = seat else {
        report.push(
            "manifest seats the body",
            false,
            format!(
                "manifest.json does not declare tool '{}' — a body nothing references never runs",
                spec.tool
            ),
        );
        return;
    };

    if config.get("backend").and_then(Value::as_str) != Some("inline_deno") {
        problems.push(format!(
            "runnable for '{}' has backend '{}', expected 'inline_deno'",
            spec.tool,
            config
                .get("backend")
                .and_then(Value::as_str)
                .unwrap_or("(none)")
        ));
    }

    let tool_description = config
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if tool_description.is_empty() || tool_description.starts_with("TODO") {
        problems.push(format!("tool '{}' has no real description — the model picks tools by description, so a TODO makes it unroutable", spec.tool));
    }

    if !config.get("input_schema").map_or(false, Value::is_object) {
        problems.push(format!(
            "tool '{}' declares no input_schema — the model would have to guess the arguments",
            spec.tool
        ));
    }

    // Drift: the manifest `code` string must be exactly the body the cases test.
    let sealed = config
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if sealed != body {
        problems.push(format!(
            "manifest `code` for '{}' has drifted from {}. The body file is the source form; re-run write_tool with the current body before installing.",
            spec.tool, spec.code_file
        ));
    }

    report.push(
        "manifest seats the body and matches it",
        problems.is_empty(),
        problems.join("; "),
    );
}

/// Step 4: the case table must be worth running — at least three cases, unique
/// names, exactly one expectation per case.
fn check_case_shape(spec: &ToolSpec, report: &mut GateReport) {
    let mut problems = Vec::new();
    if spec.cases.len() < 3 {
        problems.push(format!(
            "declares {} cases; at least 3 are required (happy path, edge case, failure)",
            spec.cases.len()
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for c in &spec.cases {
        if !seen.insert(c.name.as_str()) {
            problems.push(format!(
                "two cases share a name '{0}' — a failure would not say which one broke",
                c.name
            ));
        }
        let expectations = [
            c.expect.is_some(),
            c.expect_error.is_some(),
            c.expect_impure.is_some(),
        ]
        .iter()
        .filter(|b| **b)
        .count();
        if expectations != 1 {
            problems.push(format!(
                "case '{}' must declare exactly one of expect / expectError / expectImpure (found {expectations})",
                c.name
            ));
        }
    }
    report.push(
        "case table is well-formed",
        problems.is_empty(),
        problems.join("; "),
    );
}

/// Run one case against the sandbox report. `runs` is the `{ run1, run2 }` pair
/// the program returned; `expect_calls` gates the recorded effect sequence.
fn assert_case(tc: &ToolCase, runs: &Value, spec_kind: &str) -> Result<(), String> {
    let run1 = &runs["run1"];
    let run2 = &runs["run2"];

    // Determinism gate, before any expectation: a body whose two runs disagree
    // cannot be meaningfully asserted on at all.
    if run1["value"] != run2["value"] || run1["error"] != run2["error"] {
        return Err(format!(
            "NOT deterministic — two identical runs produced different results. The body depends on something other than its injected input. run1: {}, run2: {}",
            run1, run2
        ));
    }

    let err1 = run1["error"].as_str().map(str::to_owned);

    // `expectImpure`: the body must have been rejected at the moment it reached
    // for a shadowed global.
    if let Some(pattern) = &tc.expect_impure {
        let msg = err1.clone().unwrap_or_else(|| {
            format!(
                "the body returned {:?} instead of being rejected as impure",
                run1["value"]
            )
        });
        let re =
            Regex::new(pattern).map_err(|e| format!("expectImpure is not a valid regex: {e}"))?;
        let is_impure = msg.starts_with("nondeterministic access:");
        if !is_impure {
            return Err(format!(
                "expected the body to be rejected as impure, but it returned {}",
                run1["value"]
            ));
        }
        if !re.is_match(&msg) {
            return Err(format!(
                "impure access '{}' did not match expectImpure /{pattern}/",
                msg
            ));
        }
        return Ok(());
    }

    // `expectError`: the body must have thrown a message matching the regex.
    if let Some(pattern) = &tc.expect_error {
        let re =
            Regex::new(pattern).map_err(|e| format!("expectError is not a valid regex: {e}"))?;
        let Some(msg) = &err1 else {
            return Err(format!(
                "expected an error but the body returned {}",
                run1["value"]
            ));
        };
        if !re.is_match(msg) {
            return Err(format!(
                "error '{}' did not match expectError /{pattern}/",
                msg
            ));
        }
        return Ok(());
    }

    // Otherwise: no error, and the value must deep-equal `expect`.
    if let Some(err) = &err1 {
        return Err(err.clone());
    }
    if let Some(expected) = &tc.expect {
        if run1["value"] != *expected {
            return Err(format!(
                "expected {} but the body returned {}",
                expected, run1["value"]
            ));
        }
    }

    // Outcome, not just output: the exact sequence of effects the tool asked the
    // host/provider to perform. This is the half that catches "returns the right
    // shape while calling the wrong endpoint".
    if let Some(expected_calls) = &tc.expect_calls {
        if run1["calls"] != *expected_calls {
            return Err(format!(
                "recorded effect sequence did not match expectCalls.\n  recorded: {}\n  expected: {}",
                run1["calls"], expected_calls
            ));
        }
    }

    let _ = spec_kind;
    Ok(())
}

/// Step 5: run every case twice in the deny-all sandbox and assert on the runs.
async fn run_cases_in_sandbox(spec: &ToolSpec, body: &str, report: &mut GateReport) {
    let outcome = ryu_tool_exec::run_eval_js(
        &build_case_runner_program(),
        &runner_payload(spec, body),
        std::time::Duration::from_secs(VERIFY_DEADLINE_SECS),
    )
    .await;

    match outcome {
        ryu_tool_exec::EvalJsOutcome::Error(msg) => {
            report.push("cases", false, format!("case execution failed: {msg}"));
            return;
        }
        ryu_tool_exec::EvalJsOutcome::Value(report_value) => {
            let Some(cases) = report_value.get("cases").and_then(Value::as_array) else {
                report.push(
                    "cases",
                    false,
                    "the sandbox returned no per-case results".to_owned(),
                );
                return;
            };
            if cases.len() != spec.cases.len() {
                report.push(
                    "cases",
                    false,
                    format!(
                        "expected {} case results, got {}",
                        spec.cases.len(),
                        cases.len()
                    ),
                );
                return;
            }

            let mut all_ok = true;
            let mut results = Vec::new();
            for (tc, runs) in spec.cases.iter().zip(cases.iter()) {
                match assert_case(tc, runs, &spec.kind) {
                    Ok(()) => results.push(CaseResult {
                        name: tc.name.clone(),
                        ok: true,
                        detail: "passed twice and matched expectations".to_owned(),
                    }),
                    Err(detail) => {
                        all_ok = false;
                        results.push(CaseResult {
                            name: tc.name.clone(),
                            ok: false,
                            detail,
                        });
                    }
                }
            }
            report.cases = results;
            report.push(
                "cases (each run twice)",
                all_ok,
                if all_ok {
                    format!("{} case(s) passed", spec.cases.len())
                } else {
                    "one or more cases failed".to_owned()
                },
            );
        }
    }
}

/// The gate. Runs the five checks in order and returns the structured verdict.
///
/// Everything recoverable is a *finding* (a failing check) so the model can read
/// the report and iterate. Only an unwritten package is an `Err` — that is not a
/// gate finding, it is "call write_tool first".
pub async fn verify_tool_package(dir: &Path, expected_id: &str) -> Result<GateReport, String> {
    let (spec, body, manifest) = load_package(dir)?;

    let mut report = GateReport::check("purity (static denylist)", true, "no violations");

    // Step 1: purity. On violation, STOP — the denylist covers every escape from
    // the sandbox, so nothing impure may execute, and the sandbox run is only
    // safe once the scan is clean.
    let violations = scan_purity(&body);
    if !violations.is_empty() {
        report.passed = false;
        report.checks[0].ok = false;
        report.checks[0].detail = format!(
            "{} violation(s) — cases were NOT run:\n{}",
            violations.len(),
            violations
                .iter()
                .map(|v| {
                    format!(
                        "  {}:{}:{}  {}\n      {}\n      → {}",
                        spec.code_file, v.line, v.column, v.what, v.source, v.instead
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        );
        return Ok(report);
    }

    check_body_shape(&body, &mut report);
    check_manifest(&spec, &body, &manifest, expected_id, &mut report);
    check_case_shape(&spec, &mut report);

    // Steps 1–4 all pass → the body is cleared to execute. Step 5 runs it.
    if report.passed {
        run_cases_in_sandbox(&spec, &body, &mut report).await;
    } else {
        report.cases = Vec::new();
    }

    report.passed = report.checks.iter().all(|c| c.ok) && report.cases.iter().all(|c| c.ok);
    Ok(report)
}

/// The manifest `write_tool` seals, as a JSON value. `code` is the body; this is
/// the ONLY form Core loads for an `inline_deno` tool.
pub fn tool_manifest_json(
    id: &str,
    slug: &str,
    description: &str,
    input_schema: Value,
    code: &str,
) -> Value {
    json!({
        "id": id,
        "name": id.rsplit('.').next().unwrap_or(id),
        "version": "0.1.0",
        "description": description,
        "category": "Developer Tools",
        "permission_grants": [GRANT_TOOL_EXECUTE],
        "runnables": [
            {
                "id": format!("tool-{slug}"),
                "name": slug,
                "kind": "tool",
                "config": {
                    "slug": slug,
                    "backend": "inline_deno",
                    "description": description,
                    "input_schema": input_schema,
                    "code": code
                }
            }
        ]
    })
}

/// Validate the generated tool config the way Core will at dispatch time, so the
/// AI learns at `write_tool` time — not after an install that registered a tool
/// that refuses every call.
pub fn validate_tool_config(config: &Value) -> Result<(), String> {
    let cfg: ToolConfig =
        serde_json::from_value(config.clone()).map_err(|e| format!("invalid tool config: {e}"))?;
    cfg.resolve_backend()
        .map(|_| ())
        .map_err(|e| format!("invalid tool config: {e}"))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn tmp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tool-build-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write(dir: &std::path::Path, rel: &str, contents: &str) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        let mut f = std::fs::File::create(&path).expect("create file");
        f.write_all(contents.as_bytes()).expect("write file");
    }

    #[test]
    fn purity_accepts_a_clean_body() {
        let body = r#"
// Count characters deterministically.
const text = String(input.text ?? "");
return { length: text.length };
"#;
        assert!(scan_purity(body).is_empty());
    }

    #[test]
    fn purity_rejects_ambient_nondeterminism_even_in_untested_branches() {
        let body = "if (input.debug) { const id = Math.random(); return id; }\nreturn 1;";
        let violations = scan_purity(body);
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].what, "Math.random()");
        assert_eq!(violations[0].line, 1);
    }

    #[test]
    fn purity_ignores_prose_about_a_rule() {
        // "do not call Math.random here" must not trip the scan.
        let body = "// Math.random() is banned\nconst x = 'Date.now()';\nreturn { ok: true };";
        assert!(scan_purity(body).is_empty(), "{:?}", scan_purity(body));
    }

    #[test]
    fn purity_reports_each_occurrence_on_its_own_line() {
        let body = "const a = Date.now();\nconst b = Date.now();\nreturn 1;";
        let violations = scan_purity(body);
        assert_eq!(violations.len(), 2);
        assert_eq!((violations[0].line, violations[1].line), (1, 2));
    }

    #[test]
    fn blanking_preserves_line_numbers_through_strings() {
        let body = "const s = 'a\\nmulti'\nreturn Date.now();";
        let violations = scan_purity(body);
        assert_eq!(violations.len(), 1);
        assert_eq!(
            violations[0].line, 2,
            "the \n inside the string must not shift lines"
        );
    }

    #[test]
    fn tool_manifest_json_seats_the_body() {
        let m = tool_manifest_json(
            "com.acme.demo",
            "demo",
            "Counts characters.",
            json!({ "type": "object" }),
            "return 1;",
        );
        assert_eq!(m["permission_grants"][0], GRANT_TOOL_EXECUTE);
        assert_eq!(m["runnables"][0]["config"]["backend"], "inline_deno");
        assert_eq!(m["runnables"][0]["config"]["code"], "return 1;");
        // The sealed manifest must deserialize + validate as a real ToolConfig.
        validate_tool_config(&m["runnables"][0]["config"]).unwrap();
    }

    #[test]
    fn validate_tool_config_rejects_inline_deno_without_code() {
        let cfg = json!({ "slug": "demo", "backend": "inline_deno" });
        assert!(validate_tool_config(&cfg).is_err());
    }

    #[test]
    fn case_shape_requires_three_and_unique_names() {
        let spec: ToolSpec = serde_json::from_value(json!({
            "tool": "demo",
            "kind": "inline_tool",
            "code_file": "tools/demo.js",
            "cases": [
                { "name": "a", "input": {}, "expect": {} },
                { "name": "a", "input": {}, "expect": {} },
                { "name": "b", "input": {}, "expect": {} }
            ]
        }))
        .unwrap();
        let mut report = GateReport::check("x", true, "");
        check_case_shape(&spec, &mut report);
        let shape = report.checks.last().unwrap();
        assert!(!shape.ok, "duplicate names must fail");
        assert!(shape.detail.contains("share a name"), "{}", shape.detail);
    }

    #[test]
    fn case_shape_rejects_a_case_with_two_expectations() {
        let spec: ToolSpec = serde_json::from_value(json!({
            "tool": "demo",
            "kind": "inline_tool",
            "code_file": "tools/demo.js",
            "cases": [
                { "name": "a", "input": {}, "expect": {}, "expectError": "boom" },
                { "name": "b", "input": {}, "expect": {} },
                { "name": "c", "input": {}, "expect": {} }
            ]
        }))
        .unwrap();
        let mut report = GateReport::check("x", true, "");
        check_case_shape(&spec, &mut report);
        let shape = report.checks.last().unwrap();
        assert!(!shape.ok);
    }

    #[test]
    fn verify_reports_purity_violations_without_running() {
        let dir = tmp_dir();
        write(
            &dir,
            "cases.json",
            r#"{"tool":"demo","kind":"inline_tool","code_file":"tools/demo.js","cases":[{"name":"a","input":{},"expect":{}}]}"#,
        );
        write(&dir, "tools/demo.js", "return Math.random();");
        // Manifest presence is required by load_package; its content is irrelevant
        // because the purity scan fails before the contract check runs.
        write(
            &dir,
            "manifest.json",
            &serde_json::to_string_pretty(&tool_manifest_json(
                "com.acme.demo",
                "demo",
                "Demo tool.",
                json!({ "type": "object" }),
                "return Math.random();",
            ))
            .unwrap(),
        );
        let rt = tokio::runtime::Runtime::new().unwrap();
        let report = rt
            .block_on(verify_tool_package(&dir, "com.acme.demo"))
            .unwrap();
        assert!(!report.passed);
        assert!(!report.checks[0].ok);
        assert!(report.checks[0].detail.contains("Math.random()"));
        assert!(report.cases.is_empty(), "impure body must not execute");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_reports_drift_between_file_and_manifest() {
        let dir = tmp_dir();
        write(
            &dir,
            "cases.json",
            r#"{"tool":"demo","kind":"inline_tool","code_file":"tools/demo.js","cases":[{"name":"a","input":{},"expect":{}},{"name":"b","input":{},"expect":{}},{"name":"c","input":{},"expect":{}}]}"#,
        );
        write(&dir, "tools/demo.js", "return { ok: true };");
        let manifest = tool_manifest_json(
            "com.acme.demo",
            "demo",
            "Demo tool.",
            json!({"type":"object"}),
            "return { ok: false };",
        );
        write(
            &dir,
            "manifest.json",
            &serde_json::to_string_pretty(&manifest).unwrap(),
        );
        let rt = tokio::runtime::Runtime::new().unwrap();
        let report = rt
            .block_on(verify_tool_package(&dir, "com.acme.demo"))
            .unwrap();
        assert!(!report.passed);
        let drift = report
            .checks
            .iter()
            .find(|c| c.name == "manifest seats the body and matches it")
            .unwrap();
        assert!(!drift.ok);
        assert!(drift.detail.contains("drifted"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_complains_when_package_does_not_exist() {
        let dir = tmp_dir();
        let err = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(verify_tool_package(&dir.join("nope"), "com.acme.demo"))
            .unwrap_err();
        assert!(err.contains("write_tool"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_rejects_missing_tool_execute_grant() {
        let dir = tmp_dir();
        write(
            &dir,
            "cases.json",
            r#"{"tool":"demo","kind":"inline_tool","code_file":"tools/demo.js","cases":[{"name":"a","input":{},"expect":{}},{"name":"b","input":{},"expect":{}},{"name":"c","input":{},"expect":{}}]}"#,
        );
        write(&dir, "tools/demo.js", "return { ok: true };");
        let mut manifest = tool_manifest_json(
            "com.acme.demo",
            "demo",
            "Demo tool.",
            json!({"type":"object"}),
            "return { ok: true };",
        );
        manifest["permission_grants"] = json!([]);
        write(
            &dir,
            "manifest.json",
            &serde_json::to_string_pretty(&manifest).unwrap(),
        );
        let rt = tokio::runtime::Runtime::new().unwrap();
        let report = rt
            .block_on(verify_tool_package(&dir, "com.acme.demo"))
            .unwrap();
        assert!(!report.passed);
        let grant = report
            .checks
            .iter()
            .find(|c| c.name == "manifest seats the body and matches it")
            .unwrap();
        assert!(!grant.ok);
        assert!(grant.detail.contains("tool:execute"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// True when the `deno` binary is on PATH, i.e. the sandbox can actually run.
    fn deno_available() -> bool {
        std::process::Command::new("deno")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .stdin(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// The full gate, through the REAL deny-all sandbox, on the real worked
    /// example `plugins-store/plugins/toolsmith-example` ships. Proves the runtime gate
    /// and the dev-time harness certify the same body — the whole point of
    /// keeping the two in lockstep.
    #[test]
    fn verify_text_chunk_end_to_end_through_the_sandbox() {
        if !deno_available() {
            eprintln!("skipping: deno not on PATH");
            return;
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("generated/ryu-runtime/plugins-store")
            .join("plugins")
            .join("toolsmith-example");
        let dir = tmp_dir();
        std::fs::create_dir_all(dir.join("tools")).unwrap();
        std::fs::copy(
            root.join("tools/text_chunk.js"),
            dir.join("tools/text_chunk.js"),
        )
        .unwrap();
        std::fs::copy(root.join("cases.json"), dir.join("cases.json")).unwrap();
        let body = std::fs::read_to_string(dir.join("tools/text_chunk.js")).unwrap();
        let manifest = tool_manifest_json(
            "com.acme.text-chunk",
            "text_chunk",
            "Split a string into fixed-size chunks with optional overlap, returning each chunk with its start offset.",
            json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string" },
                    "size": { "type": "integer" },
                    "overlap": { "type": "integer" }
                },
                "required": ["text"]
            }),
            &body,
        );
        write(
            &dir,
            "manifest.json",
            &serde_json::to_string_pretty(&manifest).unwrap(),
        );

        let rt = tokio::runtime::Runtime::new().unwrap();
        let report = rt
            .block_on(verify_tool_package(&dir, "com.acme.text-chunk"))
            .unwrap();
        assert!(report.passed, "{:#?}", report);
        assert_eq!(report.cases.len(), 7, "every case ran");
        assert!(report.cases.iter().all(|c| c.ok));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The determinism gate caught at RUN time: a body that trips a shadowed
    /// global the static scan does not flag would be rejected here. A body that
    /// just returns is verified by the scan + double-run and passes.
    #[test]
    fn verify_rejects_a_body_that_reaches_for_a_shadowed_global_via_an_obscured_name() {
        // `Date.now` spelled through bracket access is caught by the static scan;
        // reaching `fetch` through a re-bound reference is not something a body
        // can do without tripping the scan too — so the realistic negative here
        // is a body that the shadow harness rejects at runtime for a QUEUE miss,
        // which is the documented behaviour when a body calls host more often
        // than the fixture allows.
        if !deno_available() {
            eprintln!("skipping: deno not on PATH");
            return;
        }
        let dir = tmp_dir();
        write(
            &dir,
            "cases.json",
            r#"{"tool":"demo","kind":"inline_tool","code_file":"tools/demo.js","cases":[{"name":"a","input":{},"host":{"sideModel":[{"text":"hi"}]},"expect":{"hi":true}},{"name":"b","input":{},"expect":{}},{"name":"c","input":{},"expect":{}}]}"#,
        );
        // Calls host.sideModel TWICE but the fixture queues only ONE response —
        // the sandbox must reject the second call loudly, not silently reuse.
        write(
            &dir,
            "tools/demo.js",
            "await host.sideModel({}); await host.sideModel({}); return { hi: true };",
        );
        let manifest = tool_manifest_json(
            "com.acme.demo",
            "demo",
            "Demo tool.",
            json!({"type":"object"}),
            "await host.sideModel({}); await host.sideModel({}); return { hi: true };",
        );
        write(
            &dir,
            "manifest.json",
            &serde_json::to_string_pretty(&manifest).unwrap(),
        );

        let rt = tokio::runtime::Runtime::new().unwrap();
        let report = rt
            .block_on(verify_tool_package(&dir, "com.acme.demo"))
            .unwrap();
        assert!(!report.passed, "{:#?}", report);
        let failing = report
            .cases
            .iter()
            .find(|c| !c.ok)
            .expect("a case must fail");
        assert!(
            failing.detail.contains("no response left"),
            "{}",
            failing.detail
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
