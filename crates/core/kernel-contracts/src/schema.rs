//! Per-kind configuration structs for [`crate::runnable::RunnableKind`], the
//! [`RunnableEntry`] manifest record, the managed-sidecar/external-runtime specs,
//! and the pure validation + capability-labelling functions.
//!
//! Every Runnable in a `plugin.json` manifest carries an optional `config` field
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
    /// Backend kind: `"alias"` (default when absent) | `"inline_deno"` | `"http"`.
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
    },
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
                Ok(ToolBackend::Http {
                    url: url.to_owned(),
                    method,
                    header_params: self.header_params.clone().unwrap_or_default(),
                })
            }
            other => Err(format!(
                "unknown tool backend '{other}' (expected alias | inline_deno | http)"
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
            if let Some(rt) = node.runtime.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
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

/// A single Runnable entry inside a `plugin.json` manifest.
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
    fn validate_runnable_enforces_per_kind_required_fields() {
        assert!(validate_runnable(&entry("a", RunnableKind::Agent, None)).is_ok());
        assert!(validate_runnable(&entry("w", RunnableKind::Workflow, None)).is_err());
        assert!(validate_runnable(&entry(
            "t",
            RunnableKind::Tool,
            Some(json!({ "slug": "web_search" }))
        ))
        .is_ok());
        let err =
            validate_runnable(&entry("c", RunnableKind::Companion, Some(json!({ "label": "Ryu" }))))
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
            }
        );
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
        assert_eq!(spec2.host_api.as_ref().unwrap().grants, vec!["hook:side-model"]);
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
        assert!(!out.contains("idle_stop_secs"), "default idle omitted: {out}");

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
        assert!(!out.contains("backend_code"), "absent backend_code omitted: {out}");
        assert!(!out.contains("backend_sha256"), "absent backend_sha256 omitted: {out}");

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
        assert_eq!(parsed.backend_code.as_deref(), Some("export function activate(){}"));
        assert_eq!(parsed.backend_sha256.as_deref(), Some("abc123"));
    }
}
