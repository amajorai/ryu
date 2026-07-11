//! Per-kind configuration structs for [`crate::runnable::RunnableKind`].
//!
//! Every Runnable in a `ryu.json` manifest carries an optional `config` field
//! whose shape depends on `kind`. This module defines those shapes and the
//! [`RunnableConfig`] enum that wraps them, plus the [`validate_runnable`]
//! function that checks a [`RunnableEntry`] for required fields.
//!
//! # Extending with a new kind
//!
//! 1. Add a `*Config` struct below (document every field).
//! 2. Add a variant to [`RunnableConfig`] — no wildcard arms anywhere.
//! 3. Add the required-field check in [`validate_runnable`].
//! 4. Update the corresponding [`RunnableKind`] variant doc in
//!    `crate::runnable`.
//!
//! The compiler will flag every exhaustive `match` that needs updating, so
//! "nothing hardcoded" is enforced at compile time — no `_ =>` fallback.

use serde::{Deserialize, Serialize};

use crate::runnable::RunnableKind;

// ── Per-kind config structs ───────────────────────────────────────────────────

/// Config for a `kind: "agent"` Runnable.
///
/// An agent is a "Pokémon card": independently swappable slots for the chat
/// model, tools/MCP, memory/Spaces, persona, and Gateway policy.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowConfig {
    /// Path (relative to the manifest) to the workflow DAG definition file,
    /// or an inline entrypoint node id.
    pub entry: String,
}

/// Config for a `kind: "tool"` Runnable.
///
/// A tool exposes a callable function to agents and workflows. Today tools live
/// inside workflow graphs as `NodeKind::Tool`; standalone tool-as-Runnable
/// wiring lands with the MCP/tool-registry units.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolConfig {
    /// MCP tool slug this Runnable wraps (e.g. `"web_search"`).
    pub slug: String,
}

/// Config for a `kind: "skill"` Runnable.
///
/// A skill is an Agent Skill per the Skills standard: a versioned, shareable
/// capability bundle (prompt + tools + optional sub-workflow).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillConfig {
    /// Skill identifier in the Skills registry (e.g. `"ryu:research/v1"`).
    pub skill_id: String,
}

/// Config for a `kind: "companion"` Runnable.
///
/// A Companion surface is an in-desktop overlay or sidebar panel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
}

/// Config for a `kind: "channel"` Runnable.
///
/// A channel bot adapter connects a messaging platform (Telegram, Slack,
/// WhatsApp, Discord, …) to Core sessions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChannelConfig {
    /// Platform identifier (e.g. `"telegram"`, `"slack"`, `"whatsapp"`).
    pub platform: String,
}

/// Config for a `kind: "engine"` Runnable.
///
/// An engine binding wires a model/inference backend into the Gateway registry.
/// Every model call routes through the Gateway — the engine is never addressed
/// directly by Core.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PolicyConfig {
    /// Policy type identifier (e.g. `"firewall"`, `"pii_dlp"`, `"budget"`).
    pub policy_type: String,

    /// Inline policy definition as a JSON value (schema is policy-type-specific).
    pub definition: serde_json::Value,
}

// ── External runtime (manifest-level, #449) ───────────────────────────────────

/// A declarative **external-runtime** spec a plugin may declare at the manifest
/// level (e.g. a Python venv + pip deps + fetched assets, like the
/// `apps/tts-sidecar`). The *provisioner* lives in
/// [`crate::sidecar::external_runtime`]; this is the on-the-wire declaration.
///
/// Everything is swappable (nothing hardcoded): the runtime kind, entry module,
/// dependency set, and assets. Provisioning is gated on the plugin tier (#444)
/// plus a Gateway grant — running `pip install` from a manifest is a network +
/// code surface the Gateway must permit before it runs.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ExternalRuntimeConfig {
    /// Runtime kind. `"python"` is the only provisionable kind today; others are
    /// accepted (round-trip) but provisioning returns an "unsupported" error.
    pub kind: String,

    /// The module/entrypoint to run (e.g. `"ryu_tts"` → `python -m ryu_tts`).
    pub entry: String,

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
}

/// A single asset an external runtime needs, fetched before first run. Either a
/// direct https URL or an `hf:<owner>/<repo>/<path>` reference; `dest_under_ryu`
/// is the relative directory beneath `~/.ryu` where it lands (Core-owned) — the
/// filename is derived from the source's last path segment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssetSpec {
    /// A direct **https** URL, or an `hf:<owner>/<repo>/<path>` reference to a
    /// single file on the Hub. A repo-only `hf:<owner>/<repo>` ref (no file path)
    /// is **not** provisionable yet — full-repo snapshot needs Hub tree-listing
    /// that is not wired into the provisioner. The provisioner
    /// ([`crate::sidecar::external_runtime`]) rejects `http://` and other schemes.
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
/// stop), registered into the [`crate::sidecar::SidecarManager`] on enable so it
/// rides the *same* managed lifecycle (health monitor + resource sampler +
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
/// pip + assets). Both are gated at enable by the `sidecar:process` grant (see
/// [`crate::sidecar::manifest_sidecar::may_run_sidecar`]); nothing is hardcoded —
/// the binary URL, args, env, port, and health path are all data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
}

/// Default health-check path when a [`SidecarSpec`] omits it.
fn default_health_path() -> String {
    "/health".to_string()
}

/// How a [`SidecarSpec`] obtains its runnable process. Tagged by `kind`
/// (`"binary"` | `"python"`) so a future runtime (`"node"`, `"deno"`) is a data
/// change, not a code change ("nothing hardcoded").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
}

/// A downloadable binary sidecar process. The artifact is fetched via the shared
/// [`crate::downloads::DownloadCenter`] (streaming `.part` + resume + checksum),
/// never a hand-rolled fetcher. The URL may point at a **raw executable** (the
/// default) or an **archive** (`tar.gz` / `tar.bz2` / `zip`) that is extracted with
/// the co-located libraries preserved.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    }
    Ok(())
}

// ── RunnableEntry (manifest-level Runnable record) ────────────────────────────

/// A single Runnable entry inside a `ryu.json` manifest.
///
/// Each entry carries the identity fields from [`crate::runnable::RunnableMeta`]
/// plus an optional typed [`RunnableConfig`] blob. The `kind` field drives
/// which config shape is expected; validation via [`validate_runnable`] checks
/// that required-per-kind fields are present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
        // Common MCP tool grants.
        "mcp:web_search" => "Web search".to_string(),
        "mcp:web_scrape" => "Web scraping".to_string(),
        "mcp:file_read" => "Read files".to_string(),
        "mcp:file_write" => "Write files".to_string(),
        "mcp:screen_capture" => "Screen capture".to_string(),
        "mcp:desktop_control" => "Desktop control".to_string(),
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

    // ── capability labels ─────────────────────────────────────────────────────

    #[test]
    fn capability_label_maps_known_grants() {
        assert_eq!(capability_label("chat.sendFollowUp"), "Interactive");
        assert_eq!(capability_label("mcp:web_scrape"), "Web scraping");
        assert_eq!(capability_label("mcp:web_search"), "Web search");
        assert_eq!(capability_label("hook:side-model"), "Second-model review");
    }

    #[test]
    fn capability_label_humanizes_unknown_grants() {
        // Unknown grant: take the action segment, de-separate, capitalize.
        assert_eq!(capability_label("mcp:image_gen"), "Image gen");
        assert_eq!(capability_label("custom:do-thing"), "Do thing");
        assert_eq!(capability_label("plainlabel"), "Plainlabel");
    }

    #[test]
    fn capabilities_from_grants_dedupes_and_preserves_order() {
        let grants = vec![
            "chat.sendFollowUp".to_string(),
            "mcp:web_scrape".to_string(),
            "chat.sendFollowUp".to_string(), // duplicate label
        ];
        assert_eq!(
            capabilities_from_grants(&grants),
            vec!["Interactive".to_string(), "Web scraping".to_string()]
        );
    }

    // ── agent ─────────────────────────────────────────────────────────────────

    #[test]
    fn agent_without_config_is_valid() {
        assert!(validate_runnable(&entry("a", RunnableKind::Agent, None)).is_ok());
    }

    #[test]
    fn agent_with_full_config_is_valid() {
        let cfg = json!({ "system_prompt": "You are helpful.", "model": "gemma4", "tools": ["web_search"] });
        assert!(validate_runnable(&entry("a", RunnableKind::Agent, Some(cfg))).is_ok());
    }

    #[test]
    fn agent_with_invalid_config_shape_errors() {
        // `tools` must be an array, not a string.
        let cfg = json!({ "tools": "not-an-array" });
        let err = validate_runnable(&entry("a", RunnableKind::Agent, Some(cfg))).unwrap_err();
        assert!(err.contains("kind=agent"), "error: {err}");
    }

    // ── workflow ──────────────────────────────────────────────────────────────

    #[test]
    fn workflow_requires_config() {
        let err = validate_runnable(&entry("w", RunnableKind::Workflow, None)).unwrap_err();
        assert!(err.contains("kind=workflow"), "error: {err}");
        assert!(err.contains("entry"), "error: {err}");
    }

    #[test]
    fn workflow_with_entry_is_valid() {
        let cfg = json!({ "entry": "step-start" });
        assert!(validate_runnable(&entry("w", RunnableKind::Workflow, Some(cfg))).is_ok());
    }

    #[test]
    fn workflow_with_empty_entry_errors() {
        let cfg = json!({ "entry": "  " });
        let err = validate_runnable(&entry("w", RunnableKind::Workflow, Some(cfg))).unwrap_err();
        assert!(err.contains("'entry' must not be empty"), "error: {err}");
    }

    // ── tool ──────────────────────────────────────────────────────────────────

    #[test]
    fn tool_requires_config() {
        let err = validate_runnable(&entry("t", RunnableKind::Tool, None)).unwrap_err();
        assert!(err.contains("kind=tool"), "error: {err}");
    }

    #[test]
    fn tool_with_slug_is_valid() {
        let cfg = json!({ "slug": "web_search" });
        assert!(validate_runnable(&entry("t", RunnableKind::Tool, Some(cfg))).is_ok());
    }

    // ── skill ─────────────────────────────────────────────────────────────────

    #[test]
    fn skill_requires_skill_id() {
        let err = validate_runnable(&entry("s", RunnableKind::Skill, None)).unwrap_err();
        assert!(err.contains("kind=skill"), "error: {err}");
    }

    #[test]
    fn skill_with_skill_id_is_valid() {
        let cfg = json!({ "skill_id": "ryu:research/v1" });
        assert!(validate_runnable(&entry("s", RunnableKind::Skill, Some(cfg))).is_ok());
    }

    // ── companion ─────────────────────────────────────────────────────────────

    #[test]
    fn companion_requires_label() {
        let err = validate_runnable(&entry("c", RunnableKind::Companion, None)).unwrap_err();
        assert!(err.contains("kind=companion"), "error: {err}");
    }

    #[test]
    fn companion_with_label_is_valid() {
        let cfg = json!({ "label": "Research Panel", "icon": "magnifying-glass" });
        assert!(validate_runnable(&entry("c", RunnableKind::Companion, Some(cfg))).is_ok());
    }

    #[test]
    fn companion_label_impersonating_system_chrome_errors() {
        for bad in ["Ryu Settings", "system tools", "RYU", "My System Panel"] {
            let cfg = json!({ "label": bad });
            let err =
                validate_runnable(&entry("c", RunnableKind::Companion, Some(cfg))).unwrap_err();
            assert!(
                err.contains("impersonate system chrome"),
                "label '{bad}' should be rejected, got: {err}"
            );
        }
    }

    #[test]
    fn label_impersonates_system_chrome_matches_route_title_rule() {
        assert!(label_impersonates_system_chrome("Ryu"));
        assert!(label_impersonates_system_chrome("system"));
        assert!(label_impersonates_system_chrome("A RYU Panel"));
        assert!(!label_impersonates_system_chrome("Research Assistant"));
        assert!(!label_impersonates_system_chrome("Advisor"));
    }

    // ── channel ───────────────────────────────────────────────────────────────

    #[test]
    fn channel_requires_platform() {
        let err = validate_runnable(&entry("ch", RunnableKind::Channel, None)).unwrap_err();
        assert!(err.contains("kind=channel"), "error: {err}");
    }

    #[test]
    fn channel_with_platform_is_valid() {
        let cfg = json!({ "platform": "telegram" });
        assert!(validate_runnable(&entry("ch", RunnableKind::Channel, Some(cfg))).is_ok());
    }

    // ── engine ────────────────────────────────────────────────────────────────

    #[test]
    fn engine_requires_engine_type() {
        let err = validate_runnable(&entry("e", RunnableKind::Engine, None)).unwrap_err();
        assert!(err.contains("kind=engine"), "error: {err}");
    }

    #[test]
    fn engine_with_type_is_valid() {
        let cfg = json!({ "engine_type": "llamacpp", "base_url": "http://localhost:8080" });
        assert!(validate_runnable(&entry("e", RunnableKind::Engine, Some(cfg))).is_ok());
    }

    // ── policy ────────────────────────────────────────────────────────────────

    #[test]
    fn policy_requires_config() {
        let err = validate_runnable(&entry("p", RunnableKind::Policy, None)).unwrap_err();
        assert!(err.contains("kind=policy"), "error: {err}");
    }

    #[test]
    fn policy_with_type_and_definition_is_valid() {
        let cfg = json!({
            "policy_type": "pii_dlp",
            "definition": { "block_patterns": ["\\b\\d{16}\\b"] }
        });
        assert!(validate_runnable(&entry("p", RunnableKind::Policy, Some(cfg))).is_ok());
    }

    #[test]
    fn policy_with_empty_type_errors() {
        let cfg = json!({ "policy_type": "", "definition": {} });
        let err = validate_runnable(&entry("p", RunnableKind::Policy, Some(cfg))).unwrap_err();
        assert!(
            err.contains("'policy_type' must not be empty"),
            "error: {err}"
        );
    }

    // ── managed sidecar spec ──────────────────────────────────────────────────

    fn binary_sidecar(name: &str, url: &str, version: &str) -> SidecarSpec {
        SidecarSpec {
            name: name.to_owned(),
            process: SidecarProcess::Binary(BinarySpec {
                url: url.to_owned(),
                sha256: None,
                version: version.to_owned(),
                archive: None,
                binary_name: None,
                args: vec![],
                env: std::collections::BTreeMap::new(),
            }),
            port: 9099,
            health_path: "/health".to_owned(),
        }
    }

    fn set_archive(spec: &mut SidecarSpec, fmt: Option<&str>, binary_name: Option<&str>) {
        if let SidecarProcess::Binary(b) = &mut spec.process {
            b.archive = fmt.map(str::to_owned);
            b.binary_name = binary_name.map(str::to_owned);
        }
    }

    #[test]
    fn sidecar_spec_roundtrips_and_defaults_health_path() {
        // `health_path` defaults to /health when omitted.
        let json = r#"{
            "name": "engine",
            "process": { "kind": "binary", "url": "https://example.com/e", "version": "1.0.0" },
            "port": 9099
        }"#;
        let spec: SidecarSpec = serde_json::from_str(json).expect("deserialise");
        assert_eq!(spec.health_path, "/health");
        assert_eq!(spec.port, 9099);
        // Round-trips.
        let back: SidecarSpec =
            serde_json::from_str(&serde_json::to_string(&spec).unwrap()).unwrap();
        assert_eq!(spec, back);
    }

    #[test]
    fn valid_binary_sidecar_passes() {
        let spec = binary_sidecar("engine", "https://example.com/dl/engine", "1.0.0");
        assert!(validate_sidecar_spec(&spec).is_ok());
    }

    #[test]
    fn sidecar_rejects_unsafe_name() {
        for bad in ["a/b", "..", "", "  x", "x\\y"] {
            let spec = binary_sidecar(bad, "https://example.com/e", "1.0.0");
            assert!(
                validate_sidecar_spec(&spec).is_err(),
                "name '{bad}' should be rejected"
            );
        }
    }

    #[test]
    fn sidecar_rejects_non_https_binary_and_zero_port() {
        let mut spec = binary_sidecar("engine", "http://example.com/e", "1.0.0");
        assert!(validate_sidecar_spec(&spec).unwrap_err().contains("https"));
        spec = binary_sidecar("engine", "https://example.com/e", "1.0.0");
        spec.port = 0;
        assert!(validate_sidecar_spec(&spec).unwrap_err().contains("port"));
    }

    #[test]
    fn sidecar_rejects_bad_health_path_and_empty_version() {
        let mut spec = binary_sidecar("engine", "https://example.com/e", "1.0.0");
        spec.health_path = "health".to_owned(); // missing leading slash
        assert!(validate_sidecar_spec(&spec)
            .unwrap_err()
            .contains("health_path"));
        spec = binary_sidecar("engine", "https://example.com/e", "  ");
        assert!(validate_sidecar_spec(&spec).unwrap_err().contains("version"));
    }

    #[test]
    fn archive_sidecar_valid_with_binary_name() {
        let mut spec = binary_sidecar("engine", "https://example.com/e.tar.gz", "1.0.0");
        set_archive(&mut spec, Some("tar.gz"), Some("bin/my-engine"));
        assert!(validate_sidecar_spec(&spec).is_ok());
    }

    #[test]
    fn archive_sidecar_rejects_unknown_format() {
        let mut spec = binary_sidecar("engine", "https://example.com/e.rar", "1.0.0");
        set_archive(&mut spec, Some("rar"), Some("my-engine"));
        assert!(validate_sidecar_spec(&spec)
            .unwrap_err()
            .contains("unsupported archive format"));
    }

    #[test]
    fn archive_sidecar_requires_binary_name() {
        let mut spec = binary_sidecar("engine", "https://example.com/e.zip", "1.0.0");
        set_archive(&mut spec, Some("zip"), None);
        assert!(validate_sidecar_spec(&spec)
            .unwrap_err()
            .contains("binary_name"));
    }

    #[test]
    fn archive_sidecar_rejects_traversing_binary_name() {
        let mut spec = binary_sidecar("engine", "https://example.com/e.zip", "1.0.0");
        set_archive(&mut spec, Some("zip"), Some("../../etc/passwd"));
        assert!(validate_sidecar_spec(&spec)
            .unwrap_err()
            .contains("traversal-safe"));
    }

    #[test]
    fn python_sidecar_requires_entry() {
        let spec = SidecarSpec {
            name: "tts".to_owned(),
            process: SidecarProcess::Python(ExternalRuntimeConfig {
                kind: "python".to_owned(),
                entry: "  ".to_owned(),
                ..Default::default()
            }),
            port: 8085,
            health_path: "/health".to_owned(),
        };
        assert!(validate_sidecar_spec(&spec).unwrap_err().contains("entry"));
    }
}
