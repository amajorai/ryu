//! Per-kind configuration structs for [`crate::runnable::RunnableKind`], the
//! [`RunnableEntry`] manifest record, the managed-sidecar/external-runtime specs,
//! and the pure validation + capability-labelling functions.
//!
//! Every Runnable in a `manifest.json` manifest carries an optional `config` field
//! whose shape depends on `kind`. This module defines those shapes and the
//! [`validate_runnable`] function that checks a [`RunnableEntry`] for required
//! fields. It is pure data + validation — no I/O, no runtime coupling.
//!
//! # Extending with a new kind
//!
//! 1. Add a `*Config` struct below (document every field).
//! 2. Add the required-field check in [`validate_runnable`].
//! 3. Update the corresponding [`crate::runnable::RunnableKind`] variant doc.
//!
//! The compiler will flag every exhaustive `match` that needs updating, so
//! "nothing hardcoded" is enforced at compile time — no `_ =>` fallback.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::runnable::{RunnableKind, RunnableMeta};

// ── Per-kind config structs ───────────────────────────────────────────────────

/// Config for a `kind: "agent"` Runnable.
///
/// An agent is a "Pokémon card": independently swappable slots for the chat
/// model, tools/MCP, memory/Spaces, persona, and Gateway policy.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct AgentConfig {
    /// Default system prompt (may be overridden at runtime).
    #[serde(default)]
    pub system_prompt: Option<String>,

    /// Model/engine identifier the agent prefers (e.g. `"gemma4"`, `"gpt-4o"`).
    /// Routes through the Gateway registry — never hardcoded.
    #[serde(default)]
    pub model: Option<String>,

    /// MCP tool slugs this agent is granted (subset of the app's
    /// `permission_grants`).
    #[serde(default)]
    pub tools: Vec<String>,
}

/// Config for a `kind: "workflow"` Runnable.
///
/// A workflow is a DAG of typed nodes executed by the Core workflow executor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkflowConfig {
    /// Path (relative to the manifest) to the workflow DAG definition file,
    /// or an inline entrypoint node id.
    pub entry: String,
}

/// Config for a `kind: "tool"` Runnable.
///
/// A tool exposes a callable function to agents and workflows. The `backend`
/// field selects HOW the tool executes — this is the "nothing hardcoded, the
/// tool backend is a swappable config kind" seam:
///
///   - `alias` (default / absent): the legacy behavior — re-expose an existing
///     registry tool named `slug` under the plugin's `app__<slug>` namespace.
///     Ships no new behavior; dispatch re-enters the target tool.
///   - `inline_deno`: the plugin ships NEW logic. `code` is a JS body run in the
///     existing `tool_exec` Deno sandbox with the same grant model as a turn hook
///     (`host.*` gated by the plugin's grants). Requires the `tool:execute` grant.
///   - `http`: Core proxies the call to `url` with Gateway egress governance,
///     gated by a `tool:http-egress:<domain>` grant.
///   - `command`: Core execs an allowlisted local CLI named by `bin` (a logical
///     allowlist KEY, never a path) with an argv array built from `command_args`
///     templates. Gated by a `tool:command:<bin>` grant and routed through the
///     same budget + exec-approval scan + audit bracket as `http`.
///
/// Extra fields the SDK emits for Ryu-App widgets (`widget`, `input_schema`, …)
/// are tolerated (serde ignores unknown keys) so a `defineApp` config still
/// parses as an `alias` tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ToolConfig {
    /// Tool slug. For an `alias` tool this is the target registry tool id it
    /// wraps (e.g. `"web_search"`); for `inline_deno`/`http` it is the tool's own
    /// name. The registered, callable id is always `app__<slug>`.
    pub slug: String,
    /// Backend kind: `"alias"` (default when absent) | `"inline_deno"` | `"http"`
    /// | `"command"`.
    #[serde(default)]
    pub backend: Option<String>,
    /// `inline_deno`: the self-contained JS body run in the sandbox. Invoked with
    /// `input` (the call arguments) and `host` (the capability bridge) in scope,
    /// exactly like a turn hook's `code`.
    #[serde(default)]
    pub code: Option<String>,
    /// `http`: the endpoint URL Core proxies the call to (Gateway-governed).
    #[serde(default)]
    pub url: Option<String>,
    /// `http`: the HTTP method (defaults to `POST`).
    #[serde(default)]
    pub method: Option<String>,
    /// Optional human description surfaced in tool discovery (`/api/tools/search`).
    #[serde(default)]
    pub description: Option<String>,
    /// Optional JSON Schema for the tool input, surfaced in discovery.
    #[serde(default)]
    pub input_schema: Option<serde_json::Value>,
    /// `http`: arg names that are sent as request HEADERS rather than as path /
    /// query / body params. This is how an OpenAPI operation routes its
    /// `in: header` parameters and how auth (an `apiKey` header, a bearer token
    /// injected by the identity vault) reaches the request. Empty/absent = none.
    #[serde(default)]
    pub header_params: Option<Vec<String>>,
    /// `http`: request headers whose VALUES are injected server-side from a secret
    /// source and are NEVER part of the model-visible input schema (closes the
    /// model-sees-the-token gap). Maps the wire header name to a value TEMPLATE:
    /// each whitespace-delimited `env:VARNAME` / `vault:<domain>` TOKEN is
    /// substituted with its resolved secret while literal text is preserved, so
    /// `"Bearer env:RYU_EXA_API_KEY"` sends `Bearer <resolved>` and the degenerate
    /// whole-value `"env:RYU_EXA_API_KEY"` still yields the bare secret. Sources:
    ///   - `env:VARNAME`    read Core's process env (the exa BYOK seam).
    ///   - `vault:<domain>` read the identity-vault credential bound for <domain>
    ///     via the gateway-governed `identity.read` gate.
    /// Keys MUST be disjoint from `header_params` (resolve_backend errors otherwise).
    #[serde(default)]
    pub secret_headers: Option<std::collections::BTreeMap<String, String>>,
    /// `http`: when true, a transport failure or a 401/403 becomes a soft
    /// `Ok({available:false, reason, hint})` result so the agent's turn continues
    /// (mirrors the exa provider); other statuses still return `{status, body}`.
    /// Absent/false = today's behavior (transport->Err, any response->{status,body}).
    #[serde(default)]
    pub fail_open: Option<bool>,
    /// `http`: when true, a 2xx response returns the parsed upstream body VERBATIM
    /// (no `{status, body}` envelope) — for a tool that wants the raw provider JSON
    /// (e.g. exa's search response). A non-2xx response, and a `fail_open` 401/403,
    /// still yield their envelopes (`{status, body}` / `{available:false, …}`).
    /// Absent/false = today's behavior (every response wraps as `{status, body}`).
    #[serde(default)]
    pub unwrap_body: Option<bool>,
    /// `http`: a static JSON object DEEP-MERGED UNDER the model-provided request
    /// body (model args win on any key collision; nested objects merge key-by-key).
    /// Lets a manifest supply defaulted + nested body fields declaratively — e.g.
    /// exa's `{num_results:10, use_autoprompt:true, contents:{text:true}}` — that the
    /// model can still override. Lives in the tool CONFIG, never in `input_schema`,
    /// so these defaults are not model-visible args. Absent = no defaulting (today's
    /// verbatim forwarding). Must be a JSON object when present.
    #[serde(default)]
    pub body_defaults: Option<serde_json::Value>,
    /// `command`: the LOGICAL allowlist key of the local binary to exec (e.g.
    /// `"exa"`). Resolved to an absolute path against Core's command allowlist at
    /// dispatch — NEVER a filesystem path from the manifest. Required for the
    /// `command` backend; `resolve_backend` rejects a value containing a path
    /// separator, `..`, or an absolute form.
    #[serde(default)]
    pub bin: Option<String>,
    /// `command`: argv templates. Each element is ONE argv slot (no shell) and may
    /// contain `{name}` placeholders substituted from the tool-call args by name
    /// (e.g. `"--query={query}"`). Absent = no arguments.
    #[serde(default)]
    pub command_args: Option<Vec<String>>,
    /// `command`: child-environment overlay — child var name → source spec. v1
    /// supports only `"env:VARNAME"` (read Core's process env). Declared VALUES are
    /// deliberately excluded from the firewall/DLP scan and the audit trail.
    #[serde(default)]
    pub command_env: Option<std::collections::BTreeMap<String, String>>,
    /// `command`: absolute working directory for the child. `None` = inherit Core's.
    #[serde(default)]
    pub cwd: Option<String>,
    /// `command`: hard wall-clock timeout in seconds (default
    /// [`DEFAULT_COMMAND_TIMEOUT_SECS`]). The child is killed on elapse.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// `command`: how stdout is shaped into the tool result — `"stdout"` (default,
    /// raw capped string) or `"json"` (parse stdout as JSON, error if unparseable).
    #[serde(default)]
    pub output: Option<String>,
    /// `command`: name of the tool-call arg whose value is an OUTBOUND URL the
    /// child will fetch (e.g. a crawler's target `"url"`). When set, the
    /// dispatcher SSRF-screens that arg's value BEFORE spawn — scheme allowlist +
    /// internal-address rejection (loopback / RFC1918 / link-local /
    /// 169.254.169.254 metadata / ULA / CGNAT), the same guard the `http` backend
    /// applies — so a network CLI cannot be turned into an SSRF probe. Absent = no
    /// egress screen (a purely-local CLI). Because the child re-resolves DNS
    /// itself, this is a pre-spawn screen (no IP-pinning), matching the inherent
    /// residual for any shell-out fetcher.
    #[serde(default)]
    pub egress_url_arg: Option<String>,
    /// `command`: structured argv builder that SUPERSEDES `command_args` when
    /// present. Each [`ArgSpec`] reads one tool-call arg and expands to 0..N argv
    /// tokens, which `command_args`' one-slot-per-template model cannot do. Two
    /// expansions the template grammar structurally cannot express:
    ///   - `map` — an enum value selects a token list, and a value mapping to `[]`
    ///     contributes ZERO tokens (how `rtk`'s `mode:"wrap"` becomes no
    ///     subcommand at all);
    ///   - `split:"shell"` — one string arg is `shell_words`-split into VARIADIC
    ///     argv (how `rtk`'s `command:"git status"` becomes `git` + `status`),
    ///     WITHOUT ever reaching a shell.
    /// Absent = use `command_args` (the default template path; spider/exa).
    #[serde(default)]
    pub args: Option<Vec<ArgSpec>>,
}

/// One entry in a [`ToolConfig::args`] structured argv builder. Exactly one
/// tool-call arg (`from`) is read and expanded to 0..N argv tokens. Unlike a
/// `command_args` template (always one argv slot), an `ArgSpec` can drop a token
/// or fan one arg out into many — the two things `rtk` needs.
///
/// Modes (v1 — `rtk` uses only `map` and `split`):
///   - `map` + optional `default`: the arg's string value is a KEY into `map`,
///     selecting the token list to emit. A key mapping to `[]` emits nothing.
///     `default` supplies the key when the arg is absent. An unknown value (no
///     matching key, no usable default) is a dispatch error.
///   - `split: "shell"`: the arg's string value is `shell_words`-split into
///     variadic argv tokens (quotes honored, escapes collapsed; never a shell).
///     The split tokens are NOT subject to the leading-`-` option-injection guard
///     that `command_args` applies to interpolated values — a wrapped command
///     legitimately carries flags (`-la`, `--all`); the exec-scan + bin grant are
///     the controls here, exactly as they were for the deleted native provider.
///   - neither `map` nor `split`: the arg's scalar value is emitted as ONE token.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ArgSpec {
    /// Name of the tool-call arg this spec reads. Required (v1 has no literal).
    pub from: String,
    /// Enum-map expansion: the arg's string value is a key selecting the token
    /// list to emit (a key mapping to `[]` emits ZERO tokens).
    #[serde(default)]
    pub map: Option<std::collections::BTreeMap<String, Vec<String>>>,
    /// Fallback map key used when the arg is absent (only meaningful with `map`).
    #[serde(default)]
    pub default: Option<String>,
    /// Splitting mode: `"shell"` shell-splits the arg's string value into variadic
    /// argv. The only supported value.
    #[serde(default)]
    pub split: Option<String>,
    /// When true, a missing/blank arg is a dispatch error rather than skipped.
    #[serde(default)]
    pub required: Option<bool>,
}

impl ArgSpec {
    /// Structural validation independent of any tool-call args (checked at
    /// `resolve_backend` time). Runtime concerns (unknown map value, unbalanced
    /// quotes, blank required arg) surface later, at dispatch.
    pub fn validate(&self) -> Result<(), String> {
        if self.from.trim().is_empty() {
            return Err("tool backend 'command': an 'args' entry needs a non-empty 'from'".to_owned());
        }
        if self.map.is_some() && self.split.is_some() {
            return Err(format!(
                "tool backend 'command': 'args' entry for '{}' cannot set both 'map' and 'split'",
                self.from
            ));
        }
        if let Some(split) = self.split.as_deref() {
            if split != "shell" {
                return Err(format!(
                    "tool backend 'command': 'args' entry for '{}' has unknown split '{split}' (only 'shell')",
                    self.from
                ));
            }
        }
        if self.default.is_some() && self.map.is_none() {
            return Err(format!(
                "tool backend 'command': 'args' entry for '{}' sets 'default' without 'map'",
                self.from
            ));
        }
        Ok(())
    }
}

/// Default wall-clock timeout for a [`ToolBackend::Command`] child, in seconds.
pub const DEFAULT_COMMAND_TIMEOUT_SECS: u64 = 30;

/// How a [`ToolBackend::Command`] shapes its child's stdout into the tool result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CommandOutput {
    /// Return the raw stdout as a (bounded) string. The default.
    #[default]
    Stdout,
    /// Parse stdout as JSON; a non-JSON stdout is an error.
    Json,
}

/// The resolved, dispatch-ready backend of a [`ToolConfig`]. Produced by
/// [`ToolConfig::resolve_backend`]; the dispatcher (`sidecar/mcp`) matches on it.
#[derive(Debug, Clone, PartialEq)]
pub enum ToolBackend {
    /// Re-expose an existing registry tool named `target` (the legacy alias).
    Alias { target: String },
    /// Run `code` in the `tool_exec` Deno sandbox (grant: `tool:execute`).
    InlineDeno { code: String },
    /// Proxy the call to `url` with `method` (grant: `tool:http-egress:<domain>`).
    /// `header_params` are the arg names lowered onto request headers (auth +
    /// OpenAPI `in: header` params); the rest lower onto path/query/body.
    Http {
        url: String,
        method: String,
        header_params: Vec<String>,
        /// Wire header name → secret value TEMPLATE (`env:VARNAME` / `vault:<domain>`
        /// tokens substituted in place, e.g. `"Bearer env:RYU_EXA_API_KEY"`).
        /// Resolved server-side in `run_http_tool` and NEVER present in the
        /// model-visible input schema or `header_params` (disjointness enforced at
        /// `resolve_backend`). Empty = no secret headers.
        secret_headers: std::collections::BTreeMap<String, String>,
        /// Soft-unavailable posture: on `true`, a transport failure or a 401/403
        /// becomes `Ok({available:false,…})` so the agent's turn continues.
        fail_open: bool,
        /// On `true`, a 2xx response returns the parsed upstream body VERBATIM
        /// (no `{status, body}` envelope). Non-2xx (and a fail_open 401/403) still
        /// return their envelope. `false` = every response wraps as `{status, body}`.
        unwrap_body: bool,
        /// Static JSON object deep-merged UNDER the model-provided body (model args
        /// win). `Value::Null` = no defaulting. Resolved to a body-shaping default in
        /// `run_http_tool`; never model-visible.
        body_defaults: serde_json::Value,
    },
    /// Exec an allowlisted local CLI. `bin` is an allowlist KEY (never a path —
    /// `resolve_backend` structurally rejects path-shaped values); the KEY→abs-path
    /// resolution is Core-controlled at dispatch. `args` are argv templates
    /// (`{name}` placeholders, one slot each, no shell); `env` is the declared
    /// child-env overlay; the child runs under a hard `timeout_secs` with a bounded
    /// stdout read. Grant: `tool:command:<bin>` (or the `*` wildcard).
    Command {
        bin: String,
        args: Vec<String>,
        env: std::collections::BTreeMap<String, String>,
        cwd: Option<String>,
        timeout_secs: u64,
        output: CommandOutput,
        /// Name of the arg to SSRF-screen as an outbound URL before spawn (see
        /// [`ToolConfig::egress_url_arg`]). `None` = no egress screen.
        egress_url_arg: Option<String>,
        /// Structured argv builder (see [`ToolConfig::args`]). When `Some`, the
        /// dispatcher expands these against the call args instead of templating
        /// `args` — the map/split expansions the template grammar cannot do. `None`
        /// = use the `args` templates (spider/exa).
        arg_specs: Option<Vec<ArgSpec>>,
        /// Per-arg numeric default + min/max clamp, pre-extracted from the tool's
        /// own `input_schema.properties` at `resolve_backend` time. Applied to the
        /// call args at render time (BOTH the `command_args` and `arg_specs`
        /// paths) so a raw-JSON caller that bypasses the advertised schema still
        /// gets the schema's `default`/`minimum`/`maximum`. Empty = no bounds.
        arg_bounds: std::collections::BTreeMap<String, ArgBounds>,
    },
}

/// Numeric default + clamp bounds for one command-tool arg, sourced from the
/// tool's `input_schema` (`default`/`minimum`/`maximum`). Applied at render time by
/// [`clamp_and_default_args`] so the argv a command sees is always within the
/// bounds the schema advertises — even for a caller that hand-rolls raw JSON and
/// skips the MCP schema's own `minimum`/`maximum` validation.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ArgBounds {
    /// Value substituted when the arg is absent/null (the JSON-schema `default`).
    pub default: Option<serde_json::Value>,
    /// Inclusive lower clamp (JSON-schema `minimum`).
    pub minimum: Option<f64>,
    /// Inclusive upper clamp (JSON-schema `maximum`).
    pub maximum: Option<f64>,
    /// True when the arg is integral (`type: "integer"`, or every bound is a whole
    /// number): a clamped value is then emitted as an integer so it renders as
    /// `"10"`, not `"10.0"`.
    pub integer: bool,
}

/// Extract per-arg [`ArgBounds`] from a tool `input_schema`'s numeric properties.
/// Pure — only reads `default`/`minimum`/`maximum`/`type` under `properties`. A
/// property with none of those contributes no entry.
pub fn extract_arg_bounds(
    input_schema: Option<&serde_json::Value>,
) -> std::collections::BTreeMap<String, ArgBounds> {
    let mut out = std::collections::BTreeMap::new();
    let Some(props) = input_schema
        .and_then(|s| s.get("properties"))
        .and_then(serde_json::Value::as_object)
    else {
        return out;
    };
    for (name, spec) in props {
        let default = spec.get("default").cloned();
        let minimum = spec.get("minimum").and_then(serde_json::Value::as_f64);
        let maximum = spec.get("maximum").and_then(serde_json::Value::as_f64);
        if default.is_none() && minimum.is_none() && maximum.is_none() {
            continue;
        }
        let ty = spec.get("type").and_then(serde_json::Value::as_str);
        let is_int_type = ty == Some("integer");
        let bounds_are_whole = minimum.is_none_or(|m| m.fract() == 0.0)
            && maximum.is_none_or(|m| m.fract() == 0.0)
            && default
                .as_ref()
                .and_then(serde_json::Value::as_f64)
                .is_none_or(|d| d.fract() == 0.0);
        out.insert(
            name.clone(),
            ArgBounds {
                default,
                minimum,
                maximum,
                integer: is_int_type || bounds_are_whole,
            },
        );
    }
    out
}

/// Apply [`ArgBounds`] to a mutable tool-call args object: inject the `default` for
/// an absent/null arg, and clamp a present numeric arg into `[minimum, maximum]`.
/// A clamped integral arg stays an integer so it renders without a `.0`. Pure and
/// network-free (unit-testable). Non-object args are left unchanged.
pub fn clamp_and_default_args(
    args: &mut serde_json::Value,
    bounds: &std::collections::BTreeMap<String, ArgBounds>,
) {
    let Some(obj) = args.as_object_mut() else {
        return;
    };
    for (name, b) in bounds {
        match obj.get(name) {
            None | Some(serde_json::Value::Null) => {
                if let Some(def) = &b.default {
                    obj.insert(name.clone(), def.clone());
                }
            }
            Some(v) => {
                let Some(n) = v.as_f64() else { continue };
                let mut c = n;
                if let Some(min) = b.minimum {
                    if c < min {
                        c = min;
                    }
                }
                if let Some(max) = b.maximum {
                    if c > max {
                        c = max;
                    }
                }
                if c != n {
                    obj.insert(name.clone(), number_from(c, b.integer));
                }
            }
        }
    }
}

/// Build a JSON number from a clamped f64, preserving integrality so an integral
/// bound renders as `10` rather than `10.0`.
fn number_from(v: f64, integer: bool) -> serde_json::Value {
    if integer {
        serde_json::Value::Number(serde_json::Number::from(v as i64))
    } else {
        serde_json::Number::from_f64(v)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null)
    }
}

impl ToolConfig {
    /// Resolve the declared backend, validating that the required fields for the
    /// chosen kind are present. `None`/`"alias"` → [`ToolBackend::Alias`] wrapping
    /// `slug`, so an existing manifest with only `slug` is unchanged.
    pub fn resolve_backend(&self) -> Result<ToolBackend, String> {
        match self.backend.as_deref().map(str::trim).unwrap_or("alias") {
            "" | "alias" => Ok(ToolBackend::Alias {
                target: self.slug.clone(),
            }),
            "inline_deno" => {
                let code = self
                    .code
                    .as_deref()
                    .filter(|c| !c.trim().is_empty())
                    .ok_or_else(|| {
                        "tool backend 'inline_deno' requires a non-empty 'code'".to_owned()
                    })?;
                Ok(ToolBackend::InlineDeno {
                    code: code.to_owned(),
                })
            }
            "http" => {
                let url = self
                    .url
                    .as_deref()
                    .filter(|u| !u.trim().is_empty())
                    .ok_or_else(|| "tool backend 'http' requires a non-empty 'url'".to_owned())?;
                let method = self
                    .method
                    .as_deref()
                    .map(str::trim)
                    .filter(|m| !m.is_empty())
                    .unwrap_or("POST")
                    .to_ascii_uppercase();
                let header_params = self.header_params.clone().unwrap_or_default();
                let secret_headers = self.secret_headers.clone().unwrap_or_default();
                // Model-invisibility is ENFORCED: a header may not be BOTH a model
                // arg (header_params) and a server-side secret. Otherwise reqwest
                // would emit it twice AND a manifest could re-surface the secret
                // name as a model-produced argument, defeating gap #1.
                for secret_name in secret_headers.keys() {
                    if header_params
                        .iter()
                        .any(|h| h.eq_ignore_ascii_case(secret_name))
                    {
                        return Err(format!(
                            "tool backend 'http': header '{secret_name}' cannot be both a model arg (header_params) and a secret_header"
                        ));
                    }
                }
                // `body_defaults`, when present, MUST be a JSON object — it is
                // deep-merged into the request body object, so a scalar/array has no
                // meaningful merge and is a manifest authoring error.
                let body_defaults = match self.body_defaults.clone() {
                    None => serde_json::Value::Null,
                    Some(v) if v.is_object() => v,
                    Some(_) => {
                        return Err(
                            "tool backend 'http': 'body_defaults' must be a JSON object".to_owned()
                        )
                    }
                };
                Ok(ToolBackend::Http {
                    url: url.to_owned(),
                    method,
                    header_params,
                    secret_headers,
                    fail_open: self.fail_open.unwrap_or(false),
                    unwrap_body: self.unwrap_body.unwrap_or(false),
                    body_defaults,
                })
            }
            "command" => {
                let bin = self
                    .bin
                    .as_deref()
                    .map(str::trim)
                    .filter(|b| !b.is_empty())
                    .ok_or_else(|| {
                        "tool backend 'command' requires a non-empty 'bin'".to_owned()
                    })?;
                // `bin` is an allowlist KEY, never a path: reject any separator, a
                // parent-dir ref, or an absolute form so a manifest can never name a
                // filesystem path. The KEY→absolute-path resolution is
                // Core-controlled at dispatch (mirrors how `http`'s egress-grant
                // check lives at dispatch, not here).
                if bin.contains('/')
                    || bin.contains('\\')
                    || bin.contains("..")
                    || std::path::Path::new(bin).is_absolute()
                {
                    return Err(format!(
                        "tool backend 'command': 'bin' must be an allowlist key, not a path (got '{bin}')"
                    ));
                }
                let output = match self.output.as_deref().map(str::trim) {
                    None | Some("") | Some("stdout") => CommandOutput::Stdout,
                    Some("json") => CommandOutput::Json,
                    Some(other) => {
                        return Err(format!(
                            "tool backend 'command': unknown output '{other}' (expected stdout | json)"
                        ))
                    }
                };
                // Structured `args` (map/split), when present, supersedes the
                // `command_args` template path. Validate each entry structurally
                // here; runtime concerns (unknown map value, blank required arg)
                // surface at dispatch.
                let arg_specs = match &self.args {
                    Some(specs) if !specs.is_empty() => {
                        for spec in specs {
                            spec.validate()?;
                        }
                        Some(specs.clone())
                    }
                    _ => None,
                };
                Ok(ToolBackend::Command {
                    bin: bin.to_owned(),
                    args: self.command_args.clone().unwrap_or_default(),
                    env: self.command_env.clone().unwrap_or_default(),
                    cwd: self.cwd.clone().filter(|c| !c.trim().is_empty()),
                    timeout_secs: self.timeout_secs.unwrap_or(DEFAULT_COMMAND_TIMEOUT_SECS),
                    output,
                    egress_url_arg: self
                        .egress_url_arg
                        .clone()
                        .filter(|s| !s.trim().is_empty()),
                    arg_specs,
                    arg_bounds: extract_arg_bounds(self.input_schema.as_ref()),
                })
            }
            other => Err(format!(
                "unknown tool backend '{other}' (expected alias | inline_deno | http | command)"
            )),
        }
    }
}

/// Config for a `kind: "skill"` Runnable.
///
/// A skill is an Agent Skill per the Skills standard: a versioned, shareable
/// capability bundle (prompt + tools + optional sub-workflow).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SkillConfig {
    /// Skill identifier in the Skills registry (e.g. `"ryu:research/v1"`).
    pub skill_id: String,
}

/// Config for a `kind: "companion"` Runnable.
///
/// A Companion surface is an in-desktop overlay or sidebar panel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CompanionConfig {
    /// Display label for the companion panel tab or tooltip.
    pub label: String,

    /// Icon identifier (resolved by the desktop shell).
    #[serde(default)]
    pub icon: Option<String>,

    /// Keyboard shortcut string (e.g. `"ctrl+shift+r"`).
    #[serde(default)]
    pub shortcut: Option<String>,

    /// Optional path (relative to the manifest) to the companion's sandboxed-UI
    /// entry module. When present, the plugin bundle carries a `ui_code` blob
    /// (built by `ryu pack` from this entry) that the desktop loads into the
    /// null-origin extension-host iframe. Absent for a companion that only
    /// declares a data-driven summary (no third-party code). Lockstep with the
    /// SDK's `RunnableMeta.config.ui_entry`.
    #[serde(default)]
    pub ui_entry: Option<String>,

    /// UI bundle format discriminator. Absent / `"js"` = the default `new
    /// Function`-eval companion model: `ui_code` is one self-contained ESM module
    /// (the SDK `ryu pack` output) the host wraps in the trusted bootstrap. `"html"`
    /// = a full self-contained HTML document (Path B, e.g. a vite-plugin-singlefile
    /// build for a heavy app like the whiteboard): `ui_code` is that HTML, mounted
    /// directly as the iframe `srcdoc` with the `window.ryu` bridge injected inline
    /// (no `new Function` bootstrap). Lets a React/Excalidraw/Remotion app reuse the
    /// battle-tested singlefile bundler instead of fighting the ESM-eval + CSP path.
    #[serde(default)]
    pub ui_format: Option<String>,

    /// Optional per-app CSP allowlist (the OpenAI-Apps-SDK `_meta.ui.csp` model,
    /// scoped for Ryu). When present, the Path-B host WIDENS the otherwise-locked
    /// companion CSP for exactly these hosts: `connect_domains` extend `connect-src`
    /// (fetch/XHR targets) and `resource_domains` extend `img-src`/`media-src`
    /// (remote asset loads). The default remains `connect-src 'none'` — this is the
    /// deliberate, declared exception (e.g. the canvas asset picker fetching
    /// `api.iconify.design`/`api.svgl.app` directly instead of via a host round-trip).
    /// SECURITY: this is a manifest CLAIM; only a trusted/approved manifest's `csp`
    /// should be applied (built-in apps are trusted; third-party needs moderation,
    /// like grants). Egress to these hosts is NOT Gateway-governed — keep the list to
    /// keyless, read-only public asset CDNs, never anything carrying user data.
    #[serde(default)]
    pub csp: Option<CompanionCsp>,
}

/// A per-app CSP allowlist (see [`CompanionConfig::csp`]). Each entry is a host or
/// full origin (e.g. `"https://api.iconify.design"`); the host sanitizes them to
/// `https` origins before injecting.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CompanionCsp {
    /// Hosts added to `connect-src` (the frame may `fetch()`/XHR these directly).
    #[serde(default)]
    pub connect_domains: Vec<String>,

    /// Hosts added to `img-src`/`media-src` (remote asset/image loads).
    #[serde(default)]
    pub resource_domains: Vec<String>,
}

/// Config for a `kind: "channel"` Runnable.
///
/// A channel bot adapter connects a messaging platform (Telegram, Slack,
/// WhatsApp, Discord, …) to Core sessions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ChannelConfig {
    /// Platform identifier (e.g. `"telegram"`, `"slack"`, `"whatsapp"`).
    pub platform: String,
}

/// Config for a `kind: "engine"` Runnable.
///
/// An engine binding wires a model/inference backend into the Gateway registry.
/// Every model call routes through the Gateway — the engine is never addressed
/// directly by Core.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EngineConfig {
    /// Engine type identifier (e.g. `"llamacpp"`, `"ollama"`, `"openai_compat"`).
    pub engine_type: String,

    /// Base URL for OpenAI-compatible engines.
    #[serde(default)]
    pub base_url: Option<String>,
}

/// Config for a `kind: "policy"` Runnable.
///
/// A policy fragment is a Gateway-enforced rule (firewall, PII/DLP filter,
/// budget cap, …). The *enforcement* lives in the Gateway; this config lets an
/// App declare and bundle a policy that the Gateway activates on install.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PolicyConfig {
    /// Policy type identifier (e.g. `"firewall"`, `"pii_dlp"`, `"budget"`).
    pub policy_type: String,

    /// Inline policy definition as a JSON value (schema is policy-type-specific).
    pub definition: serde_json::Value,
}

// ── External runtime (manifest-level, #449) ───────────────────────────────────

/// A declarative **external-runtime** spec a plugin may declare at the manifest
/// level (e.g. a Python venv + pip deps + fetched assets, like the
/// `apps/tts-sidecar`). The *provisioner* lives in Core
/// (`crate::sidecar::external_runtime`); this is the on-the-wire declaration.
///
/// Everything is swappable (nothing hardcoded): the runtime kind, entry module,
/// dependency set, and assets. Provisioning is gated on the plugin tier (#444)
/// plus a Gateway grant — running `pip install` from a manifest is a network +
/// The default runtime kind (`"python"`, the only provisionable kind today) — used
/// when [`ExternalRuntimeConfig`] is nested in [`SidecarProcess::Python`] and the
/// `"kind"` key was consumed by the outer enum's serde tag.
fn default_runtime_kind() -> String {
    "python".to_owned()
}

/// code surface the Gateway must permit before it runs.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct ExternalRuntimeConfig {
    /// Runtime kind. `"python"` is the only provisionable kind today; others are
    /// accepted (round-trip) but provisioning returns an "unsupported" error.
    ///
    /// Defaults to `"python"` so this config can be nested inside the internally
    /// `#[serde(tag = "kind")]`-tagged [`SidecarProcess::Python`] variant: there the
    /// outer enum consumes the `"kind"` key as its discriminant, so the inner field
    /// would otherwise be reported missing — the classic internally-tagged collision.
    /// Standalone use still round-trips an explicit `kind`.
    #[serde(default = "default_runtime_kind")]
    pub kind: String,

    /// The module/entrypoint to run (e.g. `"ryu_tts"` → `python -m ryu_tts`).
    pub entry: String,

    /// Optional env var the Python child reads for its **bind port**. When set, Core
    /// injects `<port_env> = profile-shifted([`SidecarSpec::port`])` at spawn, so the
    /// child binds the same profile-aware port Core health-checks + proxies to — the
    /// Python-sidecar analogue of [`LocalProcessSpec::port_env`] (without it a static
    /// port env collides across concurrent Core profiles).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_env: Option<String>,

    /// Optional Python version hint (e.g. `"3.11"`). Advisory.
    #[serde(default)]
    pub python_version: Option<String>,

    /// pip requirement specs to install into the venv.
    #[serde(default)]
    pub requirements: Vec<String>,

    /// Optional pyproject *extra* to install (`pip install -e ".[<extra>]"`).
    #[serde(default)]
    pub pyproject_extra: Option<String>,

    /// Assets to fetch into `~/.ryu` before first run.
    #[serde(default)]
    pub assets: Vec<AssetSpec>,

    /// Port the runtime's HTTP server binds to (adopt-or-spawn check).
    #[serde(default)]
    pub port: Option<u16>,

    /// Health-check path on the runtime's server (e.g. `"/health"`).
    #[serde(default)]
    pub health_path: Option<String>,

    /// Optional **source archive** to extract into the runtime dir before the venv
    /// is built. Needed when the entry module is a *first-party package the plugin
    /// ships* (not on PyPI): a `pip install -e ".[extra]"` needs the package's
    /// `pyproject.toml` + sources on disk first. Single-file `assets` cannot deliver
    /// a source tree; this does. Omit for a pure-PyPI runtime.
    #[serde(default)]
    pub source: Option<SourceArchiveSpec>,

    /// Environment variables layered onto the runtime process at spawn. Values may
    /// use `${RYU_DIR}` — expanded to the Core data dir (`~/.ryu`) at spawn — so a
    /// runtime can point caches/outputs at Core-owned paths without hardcoding an
    /// absolute path in the (portable) manifest. Nothing else is interpolated.
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

/// A source-tree archive an external runtime extracts into its runtime dir before
/// provisioning (venv + `pip install -e .`). Distinct from [`AssetSpec`], which
/// fetches a *single file* into `~/.ryu`; this delivers a whole package tree the
/// plugin owns.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct SourceArchiveSpec {
    /// Direct **https** URL to the archive. Non-https is rejected by the SSRF egress
    /// screen at download time.
    pub url: String,

    /// Optional lower-case-hex SHA-256 of the archive; when present the download is
    /// verified and re-fetched on mismatch (fail-closed).
    #[serde(default)]
    pub sha256: Option<String>,

    /// Archive format: `"tar.gz"` or `"zip"`. Extracted whole-tree into the runtime
    /// dir so the package's `pyproject.toml` lands at its root.
    pub format: String,
}

/// A single asset an external runtime needs, fetched before first run. Either a
/// direct https URL or an `hf:<owner>/<repo>/<path>` reference; `dest_under_ryu`
/// is the relative directory beneath `~/.ryu` where it lands (Core-owned) — the
/// filename is derived from the source's last path segment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AssetSpec {
    /// A direct **https** URL, or an `hf:<owner>/<repo>/<path>` reference to a
    /// single file on the Hub. A repo-only `hf:<owner>/<repo>` ref (no file path)
    /// is **not** provisionable yet — full-repo snapshot needs Hub tree-listing
    /// that is not wired into the provisioner. The provisioner
    /// (`crate::sidecar::external_runtime`) rejects `http://` and other schemes.
    pub source: String,

    /// Destination directory relative to `~/.ryu` (e.g. `"models/hf"`); the
    /// fetched file lands at `~/.ryu/<dest_under_ryu>/<filename>`. Must be a
    /// traversal-safe relative path (no `..`, not absolute).
    pub dest_under_ryu: String,

    /// Optional SHA-256 for checksum verification (direct-URL assets).
    #[serde(default)]
    pub sha256: Option<String>,
}

// ── Managed sidecar (manifest-declared process, M3) ───────────────────────────

/// A declarative **managed sidecar** a plugin may declare: a long-running child
/// process Core owns end-to-end (download/provision → spawn → health-check →
/// stop), registered into the Core `SidecarManager` on enable so it rides the
/// *same* managed lifecycle (health monitor + resource sampler +
/// `/api/sidecar/status`) as a built-in sidecar.
///
/// This is the **app ⇄ sidecar bridge**: it lets a capability sidecar (ghost,
/// shadow, a TTS engine, …) be a fully manifest-defined app instead of hardcoded
/// Rust, and lets a third-party app ship its own process under a Gateway grant.
/// Infra sidecars (llama.cpp, the gateway, embeddings) stay Core substrate and are
/// deliberately NOT expressible here.
///
/// The process is obtained one of two ways ([`SidecarProcess`]): a downloaded
/// **binary**, or a **Python** runtime (reusing [`ExternalRuntimeConfig`] — venv +
/// pip + assets). Both are gated at enable by the `sidecar:process` grant; nothing
/// is hardcoded — the binary URL, args, env, port, and health path are all data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SidecarSpec {
    /// Local name, unique within the plugin. Namespaced to `<plugin_id>/<name>` at
    /// registration so it never collides with a built-in sidecar or another
    /// plugin's. Must be a safe single path segment (no `/`, `\`, `..`, or NUL).
    pub name: String,

    /// How Core obtains and runs the process.
    pub process: SidecarProcess,

    /// TCP port the process's HTTP server binds to, used to build the health-check
    /// URL. The plugin is responsible for choosing a free port — there is **no port
    /// registry in v1**, so a collision with a built-in (e.g. llama.cpp on 8080) is
    /// the plugin author's responsibility to avoid.
    pub port: u16,

    /// Health-check path on the process's server (default `"/health"`). A GET to
    /// `http://127.0.0.1:<port><health_path>` returning 2xx marks it healthy.
    #[serde(default = "default_health_path")]
    pub health_path: String,

    /// Optional **HTTP proxy** declaration: when present, Core exposes a public
    /// reverse-proxy front (`/api/ext/<plugin_id>/*`) onto this sidecar, so a
    /// manifest-declared sidecar becomes a full first-class *app* reachable by any
    /// client — the generic form of the hand-coded `ryu-mail` proxy. Absent = the
    /// sidecar is an internal capability with no external HTTP surface (only Core's
    /// own health probe reaches it). Additive: existing sidecars get `None`.
    #[serde(default)]
    pub http: Option<HttpProxySpec>,

    /// Optional **host-API** declaration: the subset of the owning plugin's approved
    /// grants the sidecar *process* may exercise via an authenticated callback into
    /// Core (`/api/host/*`, bearer = the plugin's minted `RYU_EXT_TOKEN`). Absent =
    /// the sidecar may not call back into Core at all (deny-all). Additive.
    #[serde(default)]
    pub host_api: Option<HostApiSpec>,

    /// **Lazy activation** — spawn-on-first-use instead of at plugin-enable. When
    /// `true` the sidecar is *registered* (claims its port, appears in
    /// `/api/sidecar/status` as not-running) at enable but its process is NOT started
    /// until the first proxy/broker hit wakes it on demand; a bounded health-wait
    /// warms it before the request is forwarded. `false` (the default) keeps the
    /// eager behaviour every existing manifest has: started at enable. Additive.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub lazy: bool,

    /// **Idle-stop timeout**, in seconds — scale-to-zero for this sidecar. When set,
    /// Core stops the process after it has served no request for this long (and has
    /// none in flight); the next proxy/broker hit wakes it again (see [`lazy`]). Must
    /// be `>= 30` (a shorter window churns the process). Absent = never idle-stopped
    /// by manifest declaration (the operator-level [`RYU_SIDECAR_IDLE_SECS`] env can
    /// still opt a sidecar in). Additive; independent of [`lazy`] — an eager sidecar
    /// may declare an idle timeout and will then wake-on-demand after a reap.
    ///
    /// [`lazy`]: SidecarSpec::lazy
    /// [`RYU_SIDECAR_IDLE_SECS`]: the manager's env-seeded idle config.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_stop_secs: Option<u64>,

    /// Optional **model-provider** declaration: when present, this sidecar serves an
    /// OpenAI-compatible endpoint and Core registers it as a selectable provider once
    /// the process reports healthy, then deregisters it when the plugin is disabled or
    /// uninstalled. This is what makes a third-party *auth bridge* possible without a
    /// Core change: the plugin performs its own login/refresh, serves `/v1`, and
    /// declares that fact here. Absent = the sidecar is not a model provider.
    ///
    /// A sidecar cannot self-register: it holds only `RYU_EXT_TOKEN` (scoped to the
    /// ext-proxy hop and `/api/host/*`), and the host-RPC vocabulary has no
    /// provider-registration method. Registration is therefore Core-side, driven by
    /// this declaration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provides_provider: Option<ProviderRegistrationSpec>,
}

/// Declares that a [`SidecarSpec`] serves an OpenAI-compatible model endpoint Core
/// should register as a provider while the sidecar is healthy.
///
/// Security posture: the declared [`id`] is validated against the built-in provider
/// table at registration and a collision is REFUSED, never merged. Without that guard
/// a plugin could claim a built-in id (`openai-codex`, `anthropic`) and silently
/// redirect the user's subscription traffic — and their live bearer token — to an
/// attacker-controlled `baseUrl`. Core also stamps [`OWNER_FIELD`] into the written
/// entry so deregistration can only ever remove an entry this plugin created.
///
/// [`id`]: ProviderRegistrationSpec::id
/// [`OWNER_FIELD`]: crate::schema::PROVIDER_OWNER_FIELD
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderRegistrationSpec {
    /// Provider id as it appears in the model picker. Must not collide with a built-in
    /// provider id, and must be a safe single token (lowercase alphanumerics, `-`, `_`).
    pub id: String,

    /// Human-readable label for the picker. Defaults to [`id`] when absent.
    ///
    /// [`id`]: ProviderRegistrationSpec::id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,

    /// Pi `api` type the endpoint speaks. Defaults to `"openai-completions"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,

    /// Path prefix appended to `http://127.0.0.1:<port>` to form the provider's
    /// `baseUrl`. Defaults to `"/v1"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_path: Option<String>,

    /// Optional model ids to seed the entry with, for an endpoint whose `GET /models`
    /// discovery is unavailable or slow. Absent = rely on discovery.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
}

/// Field Core stamps into a sidecar-registered `models.json` provider entry naming the
/// owning plugin. Deregistration removes an entry ONLY when this matches, so a plugin
/// can never delete a provider the user configured by hand or that another plugin owns.
pub const PROVIDER_OWNER_FIELD: &str = "_ryuOwnerPlugin";

/// Default [`ProviderRegistrationSpec::base_path`].
pub const DEFAULT_PROVIDER_BASE_PATH: &str = "/v1";

/// Default [`ProviderRegistrationSpec::api`].
pub const DEFAULT_PROVIDER_API: &str = "openai-completions";

impl ProviderRegistrationSpec {
    /// Whether `id` is a safe provider token: non-empty, lowercase alphanumerics plus
    /// `-`/`_`, and bounded. Rejects path separators, whitespace, and case tricks that
    /// could shadow a built-in id under a different normalization.
    pub fn id_is_safe(id: &str) -> bool {
        !id.is_empty()
            && id.len() <= 64
            && id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    }

    /// The `api` to write, applying the default.
    pub fn effective_api(&self) -> &str {
        self.api.as_deref().unwrap_or(DEFAULT_PROVIDER_API)
    }

    /// The loopback `baseUrl` for `port`, applying the [`base_path`] default.
    ///
    /// [`base_path`]: ProviderRegistrationSpec::base_path
    pub fn base_url(&self, port: u16) -> String {
        let path = self
            .base_path
            .as_deref()
            .unwrap_or(DEFAULT_PROVIDER_BASE_PATH);
        let path = path.strip_suffix('/').unwrap_or(path);
        format!("http://127.0.0.1:{port}{path}")
    }
}

/// Minimum legal [`SidecarSpec::idle_stop_secs`]: a shorter idle window would churn
/// the process (start → serve → reap → start) faster than a typical warm-up costs.
pub const MIN_IDLE_STOP_SECS: u64 = 30;

/// Declares the reverse-proxy front Core mounts onto a [`SidecarSpec`]. This is the
/// **data** form of what `apps/core/src/sidecar/mail.rs` hand-codes: the exact set of
/// external routes and their per-route auth posture. Core rejects any request whose
/// sub-path is not one of [`routes`] (404), preserving mail's exact-route safety as a
/// declaration instead of a hardcoded router.
///
/// [`routes`]: HttpProxySpec::routes
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct HttpProxySpec {
    /// Optional path prefix prepended to the forwarded sub-path when Core builds the
    /// upstream URL on the sidecar (e.g. `mount = "/api/mail"` turns an external
    /// `/api/ext/<id>/status` into an upstream `/api/mail/status`). Absent/empty ⇒
    /// the sub-path after `/api/ext/<plugin_id>` is forwarded verbatim. Must start
    /// with `/` when present.
    #[serde(default)]
    pub mount: Option<String>,

    /// Optional **public mount** — a stable, externally-committed URL prefix under
    /// which Core ALSO exposes this sidecar's routes, instead of only the generic
    /// `/api/ext/<plugin_id>/*` catch-all (e.g. `"/api/mail"` for a mail app whose
    /// inbound-webhook URL is baked into an external forwarder). Registered at
    /// `create_router` build time and only honoured for **built-in** manifests
    /// (axum routers are immutable after serve, so a runtime-installed third-party
    /// app cannot claim a custom prefix — it keeps `/api/ext/<id>/*`). Absent = no
    /// public mount (the common case). The routes + per-route auth are the SAME
    /// [`routes`] list; this only changes the public prefix they answer on.
    ///
    /// [`routes`]: HttpProxySpec::routes
    #[serde(default)]
    pub public_mount: Option<String>,

    /// The exact set of proxied routes. Each entry's [`RouteSpec::path`] is matched
    /// against the incoming sub-path (the segment after `/api/ext/<plugin_id>`),
    /// supporting `:param` and trailing `*rest` wildcards. A request whose sub-path
    /// matches **none** of these is refused with 404 — undeclared paths are never
    /// forwarded (the security property that makes this a safe generalization of the
    /// mail proxy's fixed route list).
    #[serde(default)]
    pub routes: Vec<RouteSpec>,

    /// Maximum request body Core will buffer and forward, in bytes. Absent ⇒ Core's
    /// conservative default. Caps the proxy's memory exposure per request.
    #[serde(default)]
    pub max_body_bytes: Option<usize>,
}

/// One declared proxied route: a path pattern plus its auth posture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RouteSpec {
    /// Path pattern for the sub-path after `/api/ext/<plugin_id>` (must start with
    /// `/`). Supports `:param` (matches one non-empty segment) and a trailing
    /// `*rest` (matches the remainder), mirroring axum/matchit patterns so a
    /// sidecar's REST routes (`/inboxes/:id`) can be declared faithfully.
    pub path: String,

    /// Auth posture for this route. Defaults to [`RouteAuth::Protected`] (secure by
    /// default): the request must carry the node bearer exactly as any other
    /// protected Core route. `public` opts a route out (e.g. an HMAC-authed inbound
    /// webhook whose external caller cannot hold the node token).
    #[serde(default)]
    pub auth: RouteAuth,
}

/// The auth posture of a proxied [`RouteSpec`] (serde kebab-case).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RouteAuth {
    /// The request must carry the node bearer (the default; same gate as any other
    /// protected Core route).
    #[default]
    Protected,
    /// No node-bearer requirement — the route authenticates itself end-to-end (e.g.
    /// a per-resource HMAC on an inbound webhook), like the mail inbound path.
    Public,
}

/// Declares the host-API grant subset a sidecar *process* may exercise via the
/// authenticated `/api/host/*` callback into Core. The listed grants are the ceiling;
/// Core still intersects them with the plugin's *approved* grants (post-Gateway
/// validation) at call time, so a manifest can never widen its own authority here.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct HostApiSpec {
    /// The grant strings (same vocabulary as `permission_grants`, e.g.
    /// `"hook:side-model"`) the sidecar backend may exercise via `/api/host/*`.
    #[serde(default)]
    pub grants: Vec<String>,
}

/// Default health-check path when a [`SidecarSpec`] omits it.
fn default_health_path() -> String {
    "/health".to_string()
}

/// How a [`SidecarSpec`] obtains its runnable process. Tagged by `kind`
/// (`"binary"` | `"python"` | `"local"` | `"node"`) so a future runtime (`"deno"`) is
/// a data change, not a code change ("nothing hardcoded").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SidecarProcess {
    /// A single downloaded executable: fetched (checksum-verified) into the
    /// plugin's `bin/` dir, made executable, then spawned with `args` + `env`.
    Binary(BinarySpec),

    /// A Python runtime: the existing external-runtime provisioner (venv + pip +
    /// assets) builds the environment, then `python -m <entry>` is spawned.
    /// Reuses [`ExternalRuntimeConfig`] verbatim (its `port`/`health_path` are
    /// ignored here — the [`SidecarSpec`]'s own fields drive the health check).
    Python(ExternalRuntimeConfig),

    /// A binary **already present on the host** — a sibling Ryu ships alongside Core
    /// (e.g. `ryu-mail`), or something on `PATH`. Spawned directly with **no download**.
    /// This is the escape hatch for first-party sidecars built in the same repo, which
    /// have no release-artifact URL. Not for third-party apps (they should declare a
    /// downloadable [`Binary`]).
    ///
    /// [`Binary`]: SidecarProcess::Binary
    Local(LocalProcessSpec),

    /// A **managed JavaScript backend** — the extension-host runtime (RFC Option B).
    /// Core spawns a small first-party bootstrap (embedded in the binary) under `bun`
    /// (preferred) or `node`, which loads the plugin's declared `entry` module and
    /// calls its exported `activate(context)`; the module may register an HTTP request
    /// handler that the `/api/ext/<id>/*` proxy forwards to. The `entry` bundle rides
    /// as the owning manifest's `backend_code` payload (mirroring `ui_code`) and is
    /// written to the plugin dir + integrity-checked against `backend_sha256` at spawn.
    /// Because it is still a [`SidecarSpec`] it inherits the whole managed lifecycle
    /// (lazy/wake, idle-stop, health monitor, PATH cap-shims, per-plugin `RYU_EXT_*`
    /// token, `RouteAuth` proxying). Gated by the experimental-plugin-runtime flag and,
    /// for Community-tier plugins, by the `sidecar:process` grant exactly like a binary.
    Node(NodeProcessSpec),
}

/// A [`SidecarProcess::Node`] spec: run a plugin's JavaScript backend under a managed
/// Node/Bun runtime via Core's embedded host bootstrap. Nothing is hardcoded — the
/// entry module, runtime preference, port, and health path are all data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NodeProcessSpec {
    /// Relative path (traversal-safe: no absolute, no `..`) inside the plugin dir to
    /// the backend entry module — a `.js`/`.mjs`/`.cjs` bundle exporting `activate`.
    /// Core writes the owning manifest's `backend_code` here at spawn (when present)
    /// and passes it to the bootstrap as the module to load. This is the single
    /// operational source of the entry path (the manifest carries only the payload +
    /// its hash, not a second copy of the path).
    pub entry: String,

    /// Which runtime to use: `"bun"` or `"node"`. Absent = auto-detect, preferring
    /// `bun` on `PATH` then `node`. The bootstrap is dependency-free (`node:http`
    /// only) so it runs identically on either.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
}

/// The runtimes a [`NodeProcessSpec::runtime`] may name. A future runtime is a data
/// change here, not a code change at the spawn site.
pub const SUPPORTED_NODE_RUNTIMES: &[&str] = &["bun", "node"];

/// A [`SidecarProcess::Local`] spec: spawn a binary already on the host, no fetch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LocalProcessSpec {
    /// The program to spawn — a bare name resolved on `PATH` (e.g. `"ryu-mail"`), or
    /// an absolute path.
    pub command: String,

    /// Optional env var whose value, when set and non-empty, **overrides** `command`
    /// (e.g. `"RYU_MAIL_BIN"` to point at a local dev build). Absent = always use
    /// `command`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_env: Option<String>,

    /// Optional env var the child reads for its **bind port**. When set, Core injects
    /// `<port_env> = profile-shifted(port)` at spawn, so the child binds the SAME
    /// profile-aware port Core health-checks + proxies to. Without this, a static
    /// manifest port collides across concurrent Core profiles (dev shifts ports by
    /// +offset; the child would bind the release port while Core proxies the dev
    /// one). Absent = the child chooses its own port (must match the manifest `port`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_env: Option<String>,

    /// CLI args passed to the process.
    #[serde(default)]
    pub args: Vec<String>,

    /// Extra environment for the child (the reserved `RYU_EXT_*` vars are injected
    /// last, so a manifest can never override them).
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

/// A downloadable binary sidecar process. The artifact is fetched via the shared
/// Core `DownloadCenter` (streaming `.part` + resume + checksum), never a
/// hand-rolled fetcher. The URL may point at a **raw executable** (the default) or
/// an **archive** (`tar.gz` / `tar.bz2` / `zip`) that is extracted with the
/// co-located libraries preserved.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BinarySpec {
    /// Direct **https** URL to the executable, or to an archive when [`archive`] is
    /// set. Non-https is rejected by the SSRF egress screen at download time.
    ///
    /// [`archive`]: BinarySpec::archive
    pub url: String,

    /// Optional lower-case-hex SHA-256 of the **downloaded artifact** (the raw
    /// binary, or the archive file). When present the download is verified and
    /// re-fetched on mismatch (fail-closed); when absent an already-present
    /// artifact is trusted (idempotent skip).
    #[serde(default)]
    pub sha256: Option<String>,

    /// Version string recorded on-disk and used to namespace the install
    /// (`bin/<version>/…`), so bumping it re-downloads a fresh copy.
    pub version: String,

    /// Archive format the URL points at: `"tar.gz"` | `"tar.bz2"` | `"zip"`. When
    /// set, the artifact is extracted (whole tree, so sibling libraries stay next
    /// to the executable) and [`binary_name`] names the executable to run. Absent =
    /// the URL is a raw executable.
    ///
    /// [`binary_name`]: BinarySpec::binary_name
    #[serde(default)]
    pub archive: Option<String>,

    /// The executable to run, as a path relative to the extraction root (e.g.
    /// `"bin/my-engine"` or just `"my-engine"`). **Required** when [`archive`] is
    /// set; ignored for a raw binary (the filename is derived from the URL). Must be
    /// a traversal-safe relative path.
    ///
    /// [`archive`]: BinarySpec::archive
    #[serde(default)]
    pub binary_name: Option<String>,

    /// CLI arguments passed to the spawned binary.
    #[serde(default)]
    pub args: Vec<String>,

    /// Extra environment variables layered on top of the inherited environment.
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

/// The archive formats a [`BinarySpec`] may declare. A future format is a data
/// change here, not a code change elsewhere.
pub const SUPPORTED_ARCHIVE_FORMATS: &[&str] = &["tar.gz", "tar.bz2", "zip"];

/// A relative path is traversal-safe: not absolute, and every component is a normal
/// name (no `..`). `.` segments are tolerated. Shared by [`validate_sidecar_spec`].
fn is_safe_rel_path(rel: &std::path::Path) -> bool {
    !rel.as_os_str().is_empty()
        && !rel.is_absolute()
        && rel.components().all(|c| {
            matches!(
                c,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
}

/// A path component is a plain filename: non-empty, not `.`/`..`, free of any
/// path separator or NUL. (Same rule the external-runtime provisioner enforces.)
fn is_safe_name_segment(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

/// Validate a [`SidecarSpec`] structurally (called by the manifest loader).
///
/// Checks the namespaceable name, the health path, and the per-process-kind
/// required fields. Returns `Ok(())` or a descriptive `Err(String)`; never panics.
pub fn validate_sidecar_spec(spec: &SidecarSpec) -> Result<(), String> {
    if !is_safe_name_segment(spec.name.trim()) || spec.name != spec.name.trim() {
        return Err(format!(
            "sidecar '{}': 'name' must be a non-empty single path segment (no '/', '\\', '..', or surrounding whitespace)",
            spec.name
        ));
    }
    if spec.port == 0 {
        return Err(format!("sidecar '{}': 'port' must be non-zero", spec.name));
    }
    if !spec.health_path.starts_with('/') {
        return Err(format!(
            "sidecar '{}': 'health_path' must start with '/'",
            spec.name
        ));
    }
    match &spec.process {
        SidecarProcess::Binary(b) => {
            if !b.url.starts_with("https://") {
                return Err(format!(
                    "sidecar '{}': binary 'url' must be an https:// URL",
                    spec.name
                ));
            }
            if b.version.trim().is_empty() {
                return Err(format!(
                    "sidecar '{}': binary 'version' must not be empty",
                    spec.name
                ));
            }
            if let Some(fmt) = &b.archive {
                if !SUPPORTED_ARCHIVE_FORMATS.contains(&fmt.as_str()) {
                    return Err(format!(
                        "sidecar '{}': unsupported archive format '{fmt}' (expected one of {SUPPORTED_ARCHIVE_FORMATS:?})",
                        spec.name
                    ));
                }
                // An archive needs a traversal-safe executable path to run.
                match &b.binary_name {
                    None => {
                        return Err(format!(
                            "sidecar '{}': archive binary requires 'binary_name' (the executable to run inside the archive)",
                            spec.name
                        ));
                    }
                    Some(bn) if !is_safe_rel_path(std::path::Path::new(bn.trim())) => {
                        return Err(format!(
                            "sidecar '{}': 'binary_name' must be a traversal-safe relative path",
                            spec.name
                        ));
                    }
                    Some(_) => {}
                }
            }
        }
        SidecarProcess::Python(rt) => {
            if rt.entry.trim().is_empty() {
                return Err(format!(
                    "sidecar '{}': python 'entry' must not be empty",
                    spec.name
                ));
            }
        }
        SidecarProcess::Local(local) => {
            if local.command.trim().is_empty() {
                return Err(format!(
                    "sidecar '{}': local 'command' must not be empty",
                    spec.name
                ));
            }
        }
        SidecarProcess::Node(node) => {
            let entry = node.entry.trim();
            if entry.is_empty() {
                return Err(format!(
                    "sidecar '{}': node 'entry' must not be empty",
                    spec.name
                ));
            }
            if !is_safe_rel_path(std::path::Path::new(entry)) {
                return Err(format!(
                    "sidecar '{}': node 'entry' must be a traversal-safe relative path",
                    spec.name
                ));
            }
            if let Some(rt) = node
                .runtime
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                if !SUPPORTED_NODE_RUNTIMES.contains(&rt) {
                    return Err(format!(
                        "sidecar '{}': unsupported node runtime '{rt}' (expected one of {SUPPORTED_NODE_RUNTIMES:?})",
                        spec.name
                    ));
                }
            }
        }
    }
    if let Some(http) = &spec.http {
        if let Some(mount) = http.mount.as_deref().filter(|m| !m.is_empty()) {
            if !mount.starts_with('/') {
                return Err(format!(
                    "sidecar '{}': http 'mount' must start with '/'",
                    spec.name
                ));
            }
        }
        if let Some(pubm) = http.public_mount.as_deref().filter(|m| !m.is_empty()) {
            if !pubm.starts_with('/') {
                return Err(format!(
                    "sidecar '{}': http 'public_mount' must start with '/'",
                    spec.name
                ));
            }
        }
        for route in &http.routes {
            if !route.path.starts_with('/') {
                return Err(format!(
                    "sidecar '{}': http route path '{}' must start with '/'",
                    spec.name, route.path
                ));
            }
        }
    }
    if let Some(secs) = spec.idle_stop_secs {
        if secs < MIN_IDLE_STOP_SECS {
            return Err(format!(
                "sidecar '{}': 'idle_stop_secs' must be >= {MIN_IDLE_STOP_SECS} (got {secs})",
                spec.name
            ));
        }
    }
    Ok(())
}

// ── RunnableEntry (manifest-level Runnable record) ────────────────────────────

/// A single Runnable entry inside a `manifest.json` manifest.
///
/// Each entry carries the identity fields from [`crate::runnable::RunnableMeta`]
/// plus an optional typed config blob. The `kind` field drives which config shape
/// is expected; validation via [`validate_runnable`] checks that
/// required-per-kind fields are present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunnableEntry {
    /// Stable unique identifier within this app (e.g. `"tool-web-search"`).
    pub id: String,

    /// Human-readable display name.
    pub name: String,

    /// Discriminant that determines which per-kind config struct is required.
    pub kind: RunnableKind,

    /// Per-kind configuration. Some kinds (e.g. `agent`) treat this as
    /// optional (sensible defaults apply); others (e.g. `tool`, `workflow`)
    /// require it. [`validate_runnable`] enforces the rules.
    #[serde(default)]
    pub config: Option<serde_json::Value>,
}

impl RunnableEntry {
    /// A [`RunnableMeta`] view of this entry (identity only, no config).
    pub fn metadata(&self) -> RunnableMeta {
        RunnableMeta {
            id: self.id.clone(),
            name: self.name.clone(),
            kind: self.kind,
        }
    }
}

// ── Capability labels (rich marketplace metadata, Phase 1.5) ──────────────────

/// Map a single `permission_grant` string to a short, human-readable capability
/// label for a plugin **detail** payload.
///
/// The marketplace detail contract carries a `capabilities` array of human
/// strings (e.g. `["Interactive", "Web scraping"]`). When a manifest does not
/// declare `capabilities` explicitly, the detail builders DERIVE the list from
/// the manifest's `permission_grants` via this function: known grants get a
/// curated label, and any unknown grant falls back to a humanized form of its
/// action segment (never invented data — the grant is the source).
///
/// This is a pure lookup + fallback so it is unit-testable in isolation and can
/// be shared by every detail builder (built-in manifest and git marketplace).
pub fn capability_label(grant: &str) -> String {
    // Declarative `command` tool exec grant (`tool:command:<bin>`). Prefix-matched
    // because the bin key is open-ended, unlike the curated exact arms below.
    if let Some(bin) = grant.strip_prefix("tool:command:") {
        return if bin == "*" {
            "Runs local commands".to_string()
        } else {
            format!("Runs the '{bin}' command")
        };
    }
    match grant {
        // Chat / turn-hook capabilities.
        "chat.sendFollowUp" => "Interactive".to_string(),
        "hook:side-model" => "Second-model review".to_string(),
        "hook:run-agent" => "Runs sub-agents".to_string(),
        "hook:storage" => "Local storage".to_string(),
        // Spaces + media capabilities (full-page companion apps).
        "spaces:docs" => "Spaces documents".to_string(),
        "storage:kv" => "Local storage".to_string(),
        // Declarative-view action intents relayed to the app (`view.action` on the
        // plugin host bridge). The declarative `http` tier needs NO grant — it runs
        // shell-side; this grant is only for app-consumed intents.
        "views:actions" => "View actions".to_string(),
        "core:list_agents" => "Lists agents & models".to_string(),
        "media:generate" => "Generates images, video & speech".to_string(),
        "media:transcribe" => "Transcribes audio".to_string(),
        // Common MCP tool grants.
        "mcp:web_search" => "Web search".to_string(),
        "mcp:web_scrape" => "Web scraping".to_string(),
        "mcp:file_read" => "Read files".to_string(),
        "mcp:file_write" => "Write files".to_string(),
        "mcp:screen_capture" => "Screen capture".to_string(),
        "mcp:desktop_control" => "Desktop control".to_string(),
        // Browser automation capability (`com.ryu.browser` / `browser.control`).
        "browser:control" => "Browser control".to_string(),
        _ => humanize_grant(grant),
    }
}

/// Best-effort readable label for an unrecognized grant: take the action segment
/// (after the last `:` if present, else after the last `.`), replace `_`/`-`
/// separators with spaces, and capitalize the first character. Camel-case is left
/// as-is (curated entries handle the cases where that reads poorly).
fn humanize_grant(grant: &str) -> String {
    let action = grant
        .rsplit(':')
        .next()
        .unwrap_or(grant)
        .rsplit('.')
        .next()
        .unwrap_or(grant);
    let spaced: String = action
        .chars()
        .map(|c| if c == '_' || c == '-' { ' ' } else { c })
        .collect();
    let trimmed = spaced.trim();
    if trimmed.is_empty() {
        return grant.to_string();
    }
    let mut chars = trimmed.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => grant.to_string(),
    }
}

/// Derive the deduplicated `capabilities` label list for a set of
/// `permission_grants`. Order-preserving (first occurrence wins) so the emitted
/// list is stable across calls. Used by the detail builders when a manifest does
/// not declare its own `capabilities`.
pub fn capabilities_from_grants(grants: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for grant in grants {
        let label = capability_label(grant);
        if !out.contains(&label) {
            out.push(label);
        }
    }
    out
}

// ── Anti-impersonation ────────────────────────────────────────────────────────

/// True when a companion **label** impersonates first-party Ryu/system chrome.
///
/// Mirrors the desktop `validatePluginRoute` title check (`rpc.ts`): a plugin's
/// visible label may not contain `"ryu"` or `"system"` (case-insensitive), so a
/// third-party companion can never pose as built-in UI in the panel tab. The
/// desktop host also prepends a mandatory, non-removable `"Plugin ·"` attribution
/// prefix (`PluginHostPanel.tsx`) — that prefix is the primary guarantee; this
/// check is defense in depth enforced at the manifest seam, so a hostile label is
/// rejected at load rather than relying on the renderer alone.
pub fn label_impersonates_system_chrome(label: &str) -> bool {
    let lower = label.to_lowercase();
    lower.contains("ryu") || lower.contains("system")
}

// ── Validation ────────────────────────────────────────────────────────────────

/// Validate a [`RunnableEntry`] against its per-kind contract.
///
/// Returns `Ok(())` when the entry is well-formed, or a descriptive
/// [`String`] error when a required field is absent or the config cannot be
/// parsed as the expected shape.
///
/// This function never panics: every error path returns `Err(String)`.
///
/// # Extending
///
/// Add a new `RunnableKind` variant arm here when a new kind is added. The
/// compiler enforces exhaustiveness — there is no `_ =>` fallback.
pub fn validate_runnable(entry: &RunnableEntry) -> Result<(), String> {
    match entry.kind {
        RunnableKind::Agent => {
            // Agent config is fully optional — all fields have defaults.
            if let Some(raw) = &entry.config {
                serde_json::from_value::<AgentConfig>(raw.clone()).map_err(|e| {
                    format!("runnable '{}' (kind=agent): invalid config: {e}", entry.id)
                })?;
            }
            Ok(())
        }

        RunnableKind::Workflow => {
            // `entry` field is required.
            let raw = entry.config.as_ref().ok_or_else(|| {
                format!(
                    "runnable '{}' (kind=workflow): missing required 'config' (needs 'entry')",
                    entry.id
                )
            })?;
            let cfg = serde_json::from_value::<WorkflowConfig>(raw.clone()).map_err(|e| {
                format!(
                    "runnable '{}' (kind=workflow): invalid config: {e}",
                    entry.id
                )
            })?;
            if cfg.entry.trim().is_empty() {
                return Err(format!(
                    "runnable '{}' (kind=workflow): 'entry' must not be empty",
                    entry.id
                ));
            }
            Ok(())
        }

        RunnableKind::Tool => {
            // `slug` field is required.
            let raw = entry.config.as_ref().ok_or_else(|| {
                format!(
                    "runnable '{}' (kind=tool): missing required 'config' (needs 'slug')",
                    entry.id
                )
            })?;
            let cfg = serde_json::from_value::<ToolConfig>(raw.clone())
                .map_err(|e| format!("runnable '{}' (kind=tool): invalid config: {e}", entry.id))?;
            if cfg.slug.trim().is_empty() {
                return Err(format!(
                    "runnable '{}' (kind=tool): 'slug' must not be empty",
                    entry.id
                ));
            }
            // Validate the backend so a manifest that declares `inline_deno`/`http`
            // without the required `code`/`url` is rejected at load, not at dispatch.
            cfg.resolve_backend()
                .map_err(|e| format!("runnable '{}' (kind=tool): {e}", entry.id))?;
            Ok(())
        }

        RunnableKind::Skill => {
            // `skill_id` field is required.
            let raw = entry.config.as_ref().ok_or_else(|| {
                format!(
                    "runnable '{}' (kind=skill): missing required 'config' (needs 'skill_id')",
                    entry.id
                )
            })?;
            let cfg = serde_json::from_value::<SkillConfig>(raw.clone()).map_err(|e| {
                format!("runnable '{}' (kind=skill): invalid config: {e}", entry.id)
            })?;
            if cfg.skill_id.trim().is_empty() {
                return Err(format!(
                    "runnable '{}' (kind=skill): 'skill_id' must not be empty",
                    entry.id
                ));
            }
            Ok(())
        }

        RunnableKind::Companion => {
            // `label` field is required.
            let raw = entry.config.as_ref().ok_or_else(|| {
                format!(
                    "runnable '{}' (kind=companion): missing required 'config' (needs 'label')",
                    entry.id
                )
            })?;
            let cfg = serde_json::from_value::<CompanionConfig>(raw.clone()).map_err(|e| {
                format!(
                    "runnable '{}' (kind=companion): invalid config: {e}",
                    entry.id
                )
            })?;
            if cfg.label.trim().is_empty() {
                return Err(format!(
                    "runnable '{}' (kind=companion): 'label' must not be empty",
                    entry.id
                ));
            }
            // Anti-impersonation: the visible label may not pose as first-party
            // Ryu/system chrome (mirrors the desktop `validatePluginRoute` title
            // gate). The mandatory "Plugin ·" attribution prefix is the primary
            // guarantee; this rejects a hostile label at the manifest seam.
            if label_impersonates_system_chrome(&cfg.label) {
                return Err(format!(
                    "runnable '{}' (kind=companion): 'label' must not impersonate system chrome (must not contain 'ryu' or 'system')",
                    entry.id
                ));
            }
            Ok(())
        }

        RunnableKind::Channel => {
            // `platform` field is required.
            let raw = entry.config.as_ref().ok_or_else(|| {
                format!(
                    "runnable '{}' (kind=channel): missing required 'config' (needs 'platform')",
                    entry.id
                )
            })?;
            let cfg = serde_json::from_value::<ChannelConfig>(raw.clone()).map_err(|e| {
                format!(
                    "runnable '{}' (kind=channel): invalid config: {e}",
                    entry.id
                )
            })?;
            if cfg.platform.trim().is_empty() {
                return Err(format!(
                    "runnable '{}' (kind=channel): 'platform' must not be empty",
                    entry.id
                ));
            }
            Ok(())
        }

        RunnableKind::Engine => {
            // `engine_type` field is required.
            let raw = entry.config.as_ref().ok_or_else(|| {
                format!(
                    "runnable '{}' (kind=engine): missing required 'config' (needs 'engine_type')",
                    entry.id
                )
            })?;
            let cfg = serde_json::from_value::<EngineConfig>(raw.clone()).map_err(|e| {
                format!("runnable '{}' (kind=engine): invalid config: {e}", entry.id)
            })?;
            if cfg.engine_type.trim().is_empty() {
                return Err(format!(
                    "runnable '{}' (kind=engine): 'engine_type' must not be empty",
                    entry.id
                ));
            }
            Ok(())
        }

        RunnableKind::Policy => {
            // `policy_type` and `definition` fields are required.
            let raw = entry.config.as_ref().ok_or_else(|| {
                format!(
                    "runnable '{}' (kind=policy): missing required 'config' (needs 'policy_type' and 'definition')",
                    entry.id
                )
            })?;
            let cfg = serde_json::from_value::<PolicyConfig>(raw.clone()).map_err(|e| {
                format!("runnable '{}' (kind=policy): invalid config: {e}", entry.id)
            })?;
            if cfg.policy_type.trim().is_empty() {
                return Err(format!(
                    "runnable '{}' (kind=policy): 'policy_type' must not be empty",
                    entry.id
                ));
            }
            Ok(())
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, kind: RunnableKind, config: Option<serde_json::Value>) -> RunnableEntry {
        RunnableEntry {
            id: id.to_string(),
            name: id.to_string(),
            kind,
            config,
        }
    }

    #[test]
    fn capability_label_maps_known_and_humanizes_unknown() {
        assert_eq!(capability_label("chat.sendFollowUp"), "Interactive");
        assert_eq!(capability_label("mcp:web_scrape"), "Web scraping");
        assert_eq!(capability_label("custom:do-thing"), "Do thing");
    }

    #[test]
    fn capability_label_labels_command_grant() {
        assert_eq!(capability_label("tool:command:exa"), "Runs the 'exa' command");
        assert_eq!(capability_label("tool:command:*"), "Runs local commands");
    }

    #[test]
    fn command_backend_resolves_with_defaults() {
        let cfg: ToolConfig = serde_json::from_value(json!({
            "slug": "exa_search",
            "backend": "command",
            "bin": "exa",
            "command_args": ["search", "--query={query}"],
            "command_env": { "RYU_EXA_API_KEY": "env:RYU_EXA_API_KEY" },
        }))
        .unwrap();
        match cfg.resolve_backend().unwrap() {
            ToolBackend::Command {
                bin,
                args,
                env,
                cwd,
                timeout_secs,
                output,
                egress_url_arg,
                arg_specs,
                arg_bounds,
            } => {
                assert_eq!(bin, "exa");
                // No numeric bounds without an input_schema.
                assert!(arg_bounds.is_empty());
                assert_eq!(args, vec!["search", "--query={query}"]);
                assert_eq!(env.get("RYU_EXA_API_KEY").map(String::as_str), Some("env:RYU_EXA_API_KEY"));
                assert_eq!(cwd, None);
                // Default timeout applied when absent.
                assert_eq!(timeout_secs, DEFAULT_COMMAND_TIMEOUT_SECS);
                // Default output is Stdout.
                assert_eq!(output, CommandOutput::Stdout);
                // No egress screen unless declared.
                assert_eq!(egress_url_arg, None);
                // No structured args unless declared (template path).
                assert_eq!(arg_specs, None);
            }
            other => panic!("expected Command backend, got {other:?}"),
        }
    }

    #[test]
    fn command_backend_rejects_missing_or_empty_bin() {
        let missing: ToolConfig =
            serde_json::from_value(json!({ "slug": "x", "backend": "command" })).unwrap();
        assert!(missing.resolve_backend().is_err());
        let empty: ToolConfig =
            serde_json::from_value(json!({ "slug": "x", "backend": "command", "bin": "  " }))
                .unwrap();
        assert!(empty.resolve_backend().is_err());
    }

    #[test]
    fn command_backend_rejects_path_shaped_bin() {
        for bad in ["/usr/bin/exa", "../exa", "sub/exa", "a\\b"] {
            let cfg: ToolConfig =
                serde_json::from_value(json!({ "slug": "x", "backend": "command", "bin": bad }))
                    .unwrap();
            assert!(
                cfg.resolve_backend().is_err(),
                "path-shaped bin '{bad}' must be rejected"
            );
        }
    }

    #[test]
    fn command_backend_output_parsing() {
        let json_out: ToolConfig = serde_json::from_value(
            json!({ "slug": "x", "backend": "command", "bin": "exa", "output": "json" }),
        )
        .unwrap();
        assert!(matches!(
            json_out.resolve_backend().unwrap(),
            ToolBackend::Command { output: CommandOutput::Json, .. }
        ));
        let unknown: ToolConfig = serde_json::from_value(
            json!({ "slug": "x", "backend": "command", "bin": "exa", "output": "yaml" }),
        )
        .unwrap();
        assert!(unknown.resolve_backend().is_err());
    }

    #[test]
    fn command_backend_carries_structured_args_for_rtk() {
        // The exact `rtk` shape: a mode-map (wrap → zero tokens) + a shell-split
        // command. It must resolve to a Command backend carrying `arg_specs`.
        let cfg: ToolConfig = serde_json::from_value(json!({
            "slug": "rtk__run",
            "backend": "command",
            "bin": "rtk",
            "timeout_secs": 120,
            "args": [
                { "from": "mode", "map": { "wrap": [], "proxy": ["proxy"], "test": ["test"], "err": ["err"] }, "default": "wrap" },
                { "from": "command", "split": "shell", "required": true }
            ]
        }))
        .unwrap();
        match cfg.resolve_backend().unwrap() {
            ToolBackend::Command { bin, arg_specs, timeout_secs, .. } => {
                assert_eq!(bin, "rtk");
                assert_eq!(timeout_secs, 120);
                let specs = arg_specs.expect("structured args present");
                assert_eq!(specs.len(), 2);
                assert_eq!(specs[0].from, "mode");
                assert_eq!(specs[0].default.as_deref(), Some("wrap"));
                assert_eq!(
                    specs[0].map.as_ref().and_then(|m| m.get("wrap")).map(Vec::as_slice),
                    Some(&[][..])
                );
                assert_eq!(specs[1].from, "command");
                assert_eq!(specs[1].split.as_deref(), Some("shell"));
                assert_eq!(specs[1].required, Some(true));
            }
            other => panic!("expected Command backend, got {other:?}"),
        }
    }

    #[test]
    fn command_backend_rejects_bad_arg_specs() {
        // Empty `from`.
        let no_from: ToolConfig = serde_json::from_value(json!({
            "slug": "x", "backend": "command", "bin": "rtk", "args": [{ "from": " " }]
        }))
        .unwrap();
        assert!(no_from.resolve_backend().is_err());
        // Both map and split.
        let both: ToolConfig = serde_json::from_value(json!({
            "slug": "x", "backend": "command", "bin": "rtk",
            "args": [{ "from": "m", "map": { "a": [] }, "split": "shell" }]
        }))
        .unwrap();
        assert!(both.resolve_backend().is_err());
        // Unknown split mode.
        let bad_split: ToolConfig = serde_json::from_value(json!({
            "slug": "x", "backend": "command", "bin": "rtk",
            "args": [{ "from": "c", "split": "regex" }]
        }))
        .unwrap();
        assert!(bad_split.resolve_backend().is_err());
    }

    #[test]
    fn validate_runnable_rejects_command_tool_missing_bin() {
        let err = validate_runnable(&entry(
            "t",
            RunnableKind::Tool,
            Some(json!({ "slug": "x", "backend": "command" })),
        ))
        .unwrap_err();
        assert!(err.contains("bin"), "{err}");
    }

    #[test]
    fn validate_runnable_enforces_per_kind_required_fields() {
        assert!(validate_runnable(&entry("a", RunnableKind::Agent, None)).is_ok());
        assert!(validate_runnable(&entry("w", RunnableKind::Workflow, None)).is_err());
        assert!(validate_runnable(&entry(
            "t",
            RunnableKind::Tool,
            Some(json!({ "slug": "web_search" }))
        ))
        .is_ok());
        let err = validate_runnable(&entry(
            "c",
            RunnableKind::Companion,
            Some(json!({ "label": "Ryu" })),
        ))
        .unwrap_err();
        assert!(err.contains("impersonate system chrome"), "{err}");
    }

    #[test]
    fn tool_backend_defaults_to_alias_and_resolves_variants() {
        let alias: ToolConfig = serde_json::from_value(json!({ "slug": "web_search" })).unwrap();
        assert_eq!(
            alias.resolve_backend().unwrap(),
            ToolBackend::Alias {
                target: "web_search".to_owned()
            }
        );
        let http: ToolConfig = serde_json::from_value(
            json!({ "slug": "quote", "backend": "http", "url": "https://api.example.com/quote" }),
        )
        .unwrap();
        assert_eq!(
            http.resolve_backend().unwrap(),
            ToolBackend::Http {
                url: "https://api.example.com/quote".to_owned(),
                method: "POST".to_owned(),
                header_params: vec![],
                secret_headers: Default::default(),
                fail_open: false,
                unwrap_body: false,
                body_defaults: serde_json::Value::Null,
            }
        );
    }

    #[test]
    fn resolve_backend_http_carries_secret_headers_and_fail_open() {
        // Present secret_headers + fail_open:true resolve onto the backend.
        let cfg: ToolConfig = serde_json::from_value(json!({
            "slug": "exa__search",
            "backend": "http",
            "url": "https://api.exa.ai/search",
            "secret_headers": { "Authorization": "env:RYU_EXA_API_KEY" },
            "fail_open": true,
        }))
        .unwrap();
        match cfg.resolve_backend().unwrap() {
            ToolBackend::Http {
                secret_headers,
                fail_open,
                header_params,
                ..
            } => {
                assert_eq!(
                    secret_headers.get("Authorization").map(String::as_str),
                    Some("env:RYU_EXA_API_KEY")
                );
                assert!(fail_open);
                assert!(header_params.is_empty());
            }
            other => panic!("expected Http backend, got {other:?}"),
        }

        // Absent → empty map + fail_open:false (back-compat).
        let bare: ToolConfig = serde_json::from_value(json!({
            "slug": "q", "backend": "http", "url": "https://api.example.com/q",
        }))
        .unwrap();
        match bare.resolve_backend().unwrap() {
            ToolBackend::Http {
                secret_headers,
                fail_open,
                ..
            } => {
                assert!(secret_headers.is_empty());
                assert!(!fail_open);
            }
            other => panic!("expected Http backend, got {other:?}"),
        }
    }

    #[test]
    fn resolve_backend_http_rejects_secret_header_colliding_with_header_params() {
        // A header listed as BOTH a model arg and a secret is rejected (gap #1 crux),
        // case-insensitively.
        let cfg: ToolConfig = serde_json::from_value(json!({
            "slug": "x",
            "backend": "http",
            "url": "https://api.example.com/x",
            "header_params": ["Authorization"],
            "secret_headers": { "authorization": "env:X" },
        }))
        .unwrap();
        let err = cfg.resolve_backend().unwrap_err();
        assert!(
            err.contains("secret_header") && err.contains("cannot be both"),
            "{err}"
        );
    }

    #[test]
    fn extract_arg_bounds_reads_default_min_max_and_integrality() {
        let schema = json!({
            "type": "object",
            "properties": {
                "depth": { "type": "integer", "default": 1, "maximum": 10 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500 },
                "ratio": { "type": "number", "minimum": 0.0, "maximum": 1.5 },
                "name":  { "type": "string" }
            }
        });
        let bounds = extract_arg_bounds(Some(&schema));
        // A property with no numeric keywords contributes nothing.
        assert!(!bounds.contains_key("name"));
        let depth = &bounds["depth"];
        assert_eq!(depth.maximum, Some(10.0));
        assert_eq!(depth.default, Some(json!(1)));
        assert!(depth.integer);
        let limit = &bounds["limit"];
        assert_eq!(limit.minimum, Some(1.0));
        assert_eq!(limit.maximum, Some(500.0));
        // A number with a fractional bound is not integral.
        assert!(!bounds["ratio"].integer);
    }

    #[test]
    fn clamp_and_default_args_injects_default_and_clamps_integrally() {
        let bounds = extract_arg_bounds(Some(&json!({
            "properties": {
                "depth": { "type": "integer", "default": 1, "maximum": 10 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500 }
            }
        })));
        // Over-max clamps; renders as an integer (no ".0").
        let mut a = json!({ "depth": 9999, "limit": 0 });
        clamp_and_default_args(&mut a, &bounds);
        assert_eq!(a["depth"], json!(10));
        assert_eq!(a["limit"], json!(1));
        assert_eq!(a["depth"].to_string(), "10");
        // Absent arg gets the default.
        let mut b = json!({ "limit": 5 });
        clamp_and_default_args(&mut b, &bounds);
        assert_eq!(b["depth"], json!(1));
        assert_eq!(b["limit"], json!(5)); // in-range unchanged
    }

    #[test]
    fn sidecar_http_and_host_api_are_additive_and_default_off() {
        // A pre-existing sidecar with no http/host_api still parses; the new fields
        // default to None (additive — existing manifests are unchanged).
        let raw = r#"{
            "name": "engine",
            "process": { "kind": "binary", "url": "https://example.com/e", "version": "1.0.0" },
            "port": 9099
        }"#;
        let spec: SidecarSpec = serde_json::from_str(raw).unwrap();
        assert!(spec.http.is_none());
        assert!(spec.host_api.is_none());
        assert!(validate_sidecar_spec(&spec).is_ok());

        // A declared http proxy round-trips, defaults route auth to Protected, and
        // validates the mount + route-path prefixes.
        let raw2 = r#"{
            "name": "leaf",
            "process": { "kind": "binary", "url": "https://example.com/e", "version": "1.0.0" },
            "port": 9100,
            "http": {
                "mount": "/api/leaf",
                "routes": [
                    { "path": "/status" },
                    { "path": "/inbound/:id", "auth": "public" }
                ],
                "max_body_bytes": 1048576
            },
            "host_api": { "grants": ["hook:side-model"] }
        }"#;
        let spec2: SidecarSpec = serde_json::from_str(raw2).unwrap();
        let http = spec2.http.as_ref().unwrap();
        assert_eq!(http.routes[0].auth, RouteAuth::Protected); // secure default
        assert_eq!(http.routes[1].auth, RouteAuth::Public);
        assert_eq!(
            spec2.host_api.as_ref().unwrap().grants,
            vec!["hook:side-model"]
        );
        assert!(validate_sidecar_spec(&spec2).is_ok());
        let back: SidecarSpec =
            serde_json::from_str(&serde_json::to_string(&spec2).unwrap()).unwrap();
        assert_eq!(spec2, back);

        // A route path without a leading '/' is rejected at validation.
        let mut bad = spec2.clone();
        bad.http.as_mut().unwrap().routes[0].path = "status".to_owned();
        assert!(validate_sidecar_spec(&bad).is_err());
    }

    #[test]
    fn sidecar_spec_validation_and_default_health_path() {
        let raw = r#"{
            "name": "engine",
            "process": { "kind": "binary", "url": "https://example.com/e", "version": "1.0.0" },
            "port": 9099
        }"#;
        let spec: SidecarSpec = serde_json::from_str(raw).expect("deserialise");
        assert_eq!(spec.health_path, "/health");
        assert!(validate_sidecar_spec(&spec).is_ok());
        let back: SidecarSpec =
            serde_json::from_str(&serde_json::to_string(&spec).unwrap()).unwrap();
        assert_eq!(spec, back);
    }

    #[test]
    fn sidecar_lazy_and_idle_stop_are_additive_and_validated() {
        // Additive default: an existing manifest with neither field parses with
        // lazy=false (eager, unchanged) and idle_stop_secs=None.
        let raw = r#"{
            "name": "engine",
            "process": { "kind": "binary", "url": "https://example.com/e", "version": "1.0.0" },
            "port": 9099
        }"#;
        let spec: SidecarSpec = serde_json::from_str(raw).unwrap();
        assert!(!spec.lazy, "lazy defaults to false (eager, back-compat)");
        assert_eq!(spec.idle_stop_secs, None);
        // lazy=false + idle_stop_secs=None serialize as absent (skip_serializing_if),
        // so an existing manifest round-trips byte-identically.
        let out = serde_json::to_string(&spec).unwrap();
        assert!(!out.contains("lazy"), "default lazy omitted: {out}");
        assert!(
            !out.contains("idle_stop_secs"),
            "default idle omitted: {out}"
        );

        // A lazy sidecar with a sane idle window round-trips and validates.
        let raw2 = r#"{
            "name": "engine",
            "process": { "kind": "binary", "url": "https://example.com/e", "version": "1.0.0" },
            "port": 9099,
            "lazy": true,
            "idle_stop_secs": 900
        }"#;
        let spec2: SidecarSpec = serde_json::from_str(raw2).unwrap();
        assert!(spec2.lazy);
        assert_eq!(spec2.idle_stop_secs, Some(900));
        assert!(validate_sidecar_spec(&spec2).is_ok());
        let back: SidecarSpec =
            serde_json::from_str(&serde_json::to_string(&spec2).unwrap()).unwrap();
        assert_eq!(spec2, back);

        // An idle window below the floor is rejected at validation.
        let mut bad = spec2.clone();
        bad.idle_stop_secs = Some(5);
        let err = validate_sidecar_spec(&bad).unwrap_err();
        assert!(err.contains("idle_stop_secs"), "{err}");
        // The floor itself is accepted.
        bad.idle_stop_secs = Some(MIN_IDLE_STOP_SECS);
        assert!(validate_sidecar_spec(&bad).is_ok());
    }

    #[test]
    fn node_sidecar_spec_parses_and_validates() {
        // A node sidecar with an explicit runtime round-trips and validates.
        let raw = r#"{
            "name": "backend",
            "process": { "kind": "node", "entry": "dist/index.mjs", "runtime": "bun" },
            "port": 9210,
            "health_path": "/health",
            "http": { "routes": [{ "path": "/echo" }] },
            "host_api": { "grants": ["storage:kv"] }
        }"#;
        let spec: SidecarSpec = serde_json::from_str(raw).expect("deserialise node spec");
        match &spec.process {
            SidecarProcess::Node(node) => {
                assert_eq!(node.entry, "dist/index.mjs");
                assert_eq!(node.runtime.as_deref(), Some("bun"));
            }
            other => panic!("expected node process, got {other:?}"),
        }
        assert!(validate_sidecar_spec(&spec).is_ok());
        let back: SidecarSpec =
            serde_json::from_str(&serde_json::to_string(&spec).unwrap()).unwrap();
        assert_eq!(spec, back);

        // Absent runtime is valid (auto-detect at spawn) and omitted on serialize.
        let raw_auto = r#"{
            "name": "backend",
            "process": { "kind": "node", "entry": "index.js" },
            "port": 9211
        }"#;
        let auto: SidecarSpec = serde_json::from_str(raw_auto).unwrap();
        assert!(validate_sidecar_spec(&auto).is_ok());
        let out = serde_json::to_string(&auto).unwrap();
        assert!(!out.contains("runtime"), "absent runtime omitted: {out}");
    }

    #[test]
    fn node_sidecar_spec_rejects_bad_entry_and_runtime() {
        let mk = |entry: &str, rt: Option<&str>| SidecarSpec {
            name: "backend".to_owned(),
            process: SidecarProcess::Node(NodeProcessSpec {
                entry: entry.to_owned(),
                runtime: rt.map(str::to_owned),
            }),
            port: 9212,
            health_path: "/health".to_owned(),
            http: None,
            host_api: None,
            lazy: false,
            idle_stop_secs: None,
            provides_provider: None,
        };
        // Empty entry.
        assert!(validate_sidecar_spec(&mk("", None)).is_err());
        // Traversal / absolute entry.
        assert!(validate_sidecar_spec(&mk("../evil.mjs", None)).is_err());
        assert!(validate_sidecar_spec(&mk("/abs/evil.mjs", None)).is_err());
        // Unknown runtime.
        let err = validate_sidecar_spec(&mk("index.mjs", Some("deno"))).unwrap_err();
        assert!(err.contains("runtime"), "{err}");
        // Known runtimes accepted.
        assert!(validate_sidecar_spec(&mk("index.mjs", Some("node"))).is_ok());
        assert!(validate_sidecar_spec(&mk("index.mjs", Some("bun"))).is_ok());
    }

    #[test]
    fn manifest_backend_fields_are_additive() {
        use crate::manifest::PluginManifest;
        // A manifest with neither field parses (back-compat) and omits both on serialize.
        let m = PluginManifest {
            id: "com.test.node".to_owned(),
            name: "Node".to_owned(),
            version: "1.0.0".to_owned(),
            ..Default::default()
        };
        let out = serde_json::to_string(&m).unwrap();
        assert!(
            !out.contains("backend_code"),
            "absent backend_code omitted: {out}"
        );
        assert!(
            !out.contains("backend_sha256"),
            "absent backend_sha256 omitted: {out}"
        );

        // Present fields round-trip.
        let raw = r#"{
            "id": "com.test.node",
            "name": "Node",
            "version": "1.0.0",
            "runnables": [],
            "backend_code": "export function activate(){}",
            "backend_sha256": "abc123"
        }"#;
        let parsed: PluginManifest = serde_json::from_str(raw).unwrap();
        assert_eq!(
            parsed.backend_code.as_deref(),
            Some("export function activate(){}")
        );
        assert_eq!(parsed.backend_sha256.as_deref(), Some("abc123"));
    }
}
