//! The `manifest.json` **manifest model** — the single, pure-data definition of an
//! installable Ryu App/Plugin descriptor plus its `id`/semver/dependency
//! validation.
//!
//! This is the canonical contract shared by `apps/core` (which re-exports these
//! types and drives them from its I/O-bearing loader) and the Ryu SDK (which
//! re-exports them for manifest authoring/validation across language bindings).
//! It performs no I/O and links no runtime — serde/schemars/semver only.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::runnable::{RunnableKind, RunnableMeta};
use crate::schema::{self, RunnableEntry};

/// Maximum length of an app `id`. Reverse-domain ids are short; a generous cap
/// prevents pathological filesystem paths and absurdly long directory names.
pub const MAX_PLUGIN_ID_LEN: usize = 128;

/// The ONLY directories a manifest `code_file` may name, one segment deep.
///
/// Deliberately a closed, flat allowlist rather than a free-form relative path.
/// Two things depend on it being provably flat: the path is joined onto a plugin
/// directory (so it is a traversal sink, like [`validate_plugin_id`]), and
/// `tools/mirror-public.sh` vendors these files into the published tree with a
/// literal `plugins-store/*/<dir>/*.js` glob. A nested layout would make that
/// glob *accidentally* rather than provably sufficient, and the miss would first
/// surface as a public-tree compile failure after publication.
pub const CODE_FILE_DIRS: &[&str] = &["hooks", "adapters"];

/// Largest sandboxed-JS file a manifest may reference, in bytes. Generous for a
/// hook body (the largest first-party one is ~6 KB) and small enough that a
/// resolver cannot be pointed at something enormous.
pub const MAX_CODE_FILE_BYTES: usize = 256 * 1024;

/// Validate a manifest `code_file` path: exactly `<dir>/<name>.js`, where `<dir>`
/// is one of [`CODE_FILE_DIRS`].
///
/// The path is resolved against a plugin's own directory, so this is the
/// load-time gate that keeps a malicious manifest from reading outside it. Same
/// posture as [`validate_plugin_id`]: an ASCII allowlist, not an escape blocklist,
/// because `\` is a path separator on Windows and a drive-qualified or absolute
/// component silently replaces the base in `PathBuf::join`.
pub fn validate_code_file_path(rel: &str) -> Result<(), String> {
    if rel.is_empty() {
        return Err("code_file must not be empty".to_string());
    }
    let mut segments = rel.split('/');
    let (Some(dir), Some(file), None) = (segments.next(), segments.next(), segments.next()) else {
        return Err(format!(
            "code_file '{rel}' must be exactly '<dir>/<name>.js' (allowed dirs: {})",
            CODE_FILE_DIRS.join(", ")
        ));
    };
    if !CODE_FILE_DIRS.contains(&dir) {
        return Err(format!(
            "code_file '{rel}' must live under one of: {}",
            CODE_FILE_DIRS.join(", ")
        ));
    }
    if !(file.ends_with(".js") || file.ends_with(".mjs")) {
        return Err(format!("code_file '{rel}' must name a .js or .mjs file"));
    }
    let stem_ok = file
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if !stem_ok {
        return Err(format!(
            "code_file '{rel}' contains illegal characters (allowed: a-z A-Z 0-9 . - _)"
        ));
    }
    if file.contains("..") || file.starts_with('.') {
        return Err(format!(
            "code_file '{rel}' must not traverse or start with '.'"
        ));
    }
    Ok(())
}

/// Normalize the two tool-id separators accepted by manifests to the
/// dispatcher-facing dotted form. A canonical dot before a legacy separator
/// means the latter is part of the tool name and must be preserved.
fn canonical_provider_tool_id(id: &str) -> String {
    let canonical = id.find('.');
    let legacy = id.find("__");
    if canonical.is_some_and(|dot| legacy.is_some_and(|separator| dot < separator)) {
        return id.to_owned();
    }
    id.split_once("__")
        .map(|(server, tool)| format!("{server}.{tool}"))
        .unwrap_or_else(|| id.to_owned())
}

/// The ONE directory a manifest `pi_extensions[].file` may name, one segment deep.
///
/// A sibling of [`CODE_FILE_DIRS`] rather than a member of it, because the two
/// carry different things and must not be interchangeable: a `code_file` is
/// sandboxed JS Core splices into a Deno IIFE, whereas a file under here is
/// TypeScript loaded by the managed Pi process with full host privilege. Same
/// flatness requirement for the same reason — `tools/mirror-public.sh` vendors
/// these with a literal `plugins-store/*/*/pi-extensions/*.ts` glob, and a nested
/// layout would make that glob accidentally rather than provably sufficient.
pub const PI_EXTENSION_DIR: &str = "pi-extensions";

/// Validate a `pi_extensions[].file` path: exactly `pi-extensions/<name>.ts`.
///
/// Deliberately a near-copy of [`validate_code_file_path`] rather than a call into
/// it with a wider dir/extension allowlist. Merging them would let a `code_file`
/// name a `.ts` (which the sandbox cannot run) or a `pi_extensions` entry name a
/// `hooks/*.js` (which would ship sandboxed code into the unsandboxed Pi process).
/// The two allowlists are the gate; one shared, parameterised gate is one edit away
/// from being neither.
pub fn validate_pi_extension_path(rel: &str) -> Result<(), String> {
    if rel.is_empty() {
        return Err("pi extension file must not be empty".to_string());
    }
    let mut segments = rel.split('/');
    let (Some(dir), Some(file), None) = (segments.next(), segments.next(), segments.next()) else {
        return Err(format!(
            "pi extension file '{rel}' must be exactly '{PI_EXTENSION_DIR}/<name>.ts'"
        ));
    };
    if dir != PI_EXTENSION_DIR {
        return Err(format!(
            "pi extension file '{rel}' must live under '{PI_EXTENSION_DIR}/'"
        ));
    }
    if !(file.ends_with(".ts") || file.ends_with(".mts")) {
        return Err(format!(
            "pi extension file '{rel}' must name a .ts or .mts file"
        ));
    }
    let stem_ok = file
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if !stem_ok {
        return Err(format!(
            "pi extension file '{rel}' contains illegal characters (allowed: a-z A-Z 0-9 . - _)"
        ));
    }
    if file.contains("..") || file.starts_with('.') {
        return Err(format!(
            "pi extension file '{rel}' must not traverse or start with '.'"
        ));
    }
    Ok(())
}

/// The ONE directory a manifest `output_styles[].file` may name, one segment deep.
///
/// A third sibling of [`CODE_FILE_DIRS`] and [`PI_EXTENSION_DIR`] rather than a
/// member of either, for the same reason those two are separate: the three carry
/// things of wildly different privilege — sandboxed JS, unsandboxed TypeScript, and
/// inert prose — and a single parameterised gate is one edit away from letting any
/// of them wear another's clothes.
///
/// The name is deliberately the same as the directory a *user's* own styles live in
/// (`<claude-dir>/output-styles/`), so a style moves between a plugin package and a
/// user root by plain copy, with no path rewriting and no second layout to learn.
pub const OUTPUT_STYLE_DIR: &str = "output-styles";

/// Largest output-style file a manifest may reference, in bytes.
///
/// Separate from [`MAX_CODE_FILE_BYTES`] because the two bound different risks. A
/// code file is bounded so a resolver cannot be aimed at something enormous; a style
/// is bounded because its `source` is hydrated INLINE and then travels on every
/// `GET /api/plugins/contributions` response and into every manifest clone — and,
/// downstream of that, into the system prompt of every turn. 64 KB is already an
/// order of magnitude more prose than any sane style (the built-ins are 1–3 KB).
pub const MAX_OUTPUT_STYLE_BYTES: usize = 64 * 1024;

/// Validate an `output_styles[].file` path: exactly `output-styles/<name>.md`.
///
/// A near-copy of [`validate_pi_extension_path`] for the reason that function's own
/// comment gives — the allowlists ARE the gate, and merging them would let a style
/// name a `hooks/*.js` or a `code_file` name a `.md`. Same traversal-sink posture as
/// both siblings: the path is joined onto a plugin directory, and `\` is a separator
/// on Windows where a drive-qualified component silently replaces the base in
/// `PathBuf::join`.
///
/// Flatness is load-bearing beyond safety: `tools/mirror-public.sh` step 1c vendors
/// these into the published tree with a literal `plugins-store/*/*/output-styles/*.md`
/// glob, and a nested layout would make that glob accidentally rather than provably
/// sufficient — a miss that first surfaces as a public-tree build failure *after*
/// publication.
pub fn validate_output_style_path(rel: &str) -> Result<(), String> {
    if rel.is_empty() {
        return Err("output style file must not be empty".to_string());
    }
    let mut segments = rel.split('/');
    let (Some(dir), Some(file), None) = (segments.next(), segments.next(), segments.next()) else {
        return Err(format!(
            "output style file '{rel}' must be exactly '{OUTPUT_STYLE_DIR}/<name>.md'"
        ));
    };
    if dir != OUTPUT_STYLE_DIR {
        return Err(format!(
            "output style file '{rel}' must live under '{OUTPUT_STYLE_DIR}/'"
        ));
    }
    if !file.ends_with(".md") {
        return Err(format!("output style file '{rel}' must name a .md file"));
    }
    let stem_ok = file
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if !stem_ok {
        return Err(format!(
            "output style file '{rel}' contains illegal characters (allowed: a-z A-Z 0-9 . - _)"
        ));
    }
    if file.contains("..") || file.starts_with('.') {
        return Err(format!(
            "output style file '{rel}' must not traverse or start with '.'"
        ));
    }
    Ok(())
}

/// Hydrate one code-bearing node: enforce exactly-one-of `code`/`code_file`,
/// resolve the path, move the contents into `code`, and clear `code_file` so the
/// hydrated manifest is byte-indistinguishable from an inline one.
fn hydrate_one(
    label: &str,
    code: &mut String,
    code_file: &mut Option<String>,
    resolve: &mut impl FnMut(&str) -> Result<String, String>,
) -> Result<(), String> {
    let has_inline = !code.trim().is_empty();
    let Some(rel) = code_file.clone() else {
        if has_inline {
            return Ok(());
        }
        return Err(format!("{label} declares neither 'code' nor 'code_file'"));
    };
    if has_inline {
        return Err(format!(
            "{label} declares both 'code' and 'code_file' ('{rel}') — exactly one is allowed"
        ));
    }
    validate_code_file_path(&rel).map_err(|e| format!("{label}: {e}"))?;
    let body = resolve(&rel).map_err(|e| format!("{label}: cannot resolve code_file: {e}"))?;
    if body.len() > MAX_CODE_FILE_BYTES {
        return Err(format!(
            "{label}: code_file '{rel}' is {} bytes (max {MAX_CODE_FILE_BYTES})",
            body.len()
        ));
    }
    if body.trim().is_empty() {
        return Err(format!("{label}: code_file '{rel}' is empty"));
    }
    *code = body;
    *code_file = None;
    Ok(())
}

/// The [`hydrate_one`] twin for an output style: exactly-one-of `source`/`file`,
/// resolve the path, move the contents into `source`, clear `file`.
///
/// A parallel helper rather than a call into [`hydrate_one`] because the two nodes
/// spell "not provided" differently — a hook's body is a `String` that is absent by
/// being empty, a style's is an `Option<String>` — and because the size cap and the
/// path allowlist differ. Sharing them would mean threading three parameters through
/// to reach one shared `if`.
fn hydrate_one_output_style(
    label: &str,
    source: &mut Option<String>,
    file: &mut Option<String>,
    resolve: &mut impl FnMut(&str) -> Result<String, String>,
) -> Result<(), String> {
    let has_inline = source.as_deref().is_some_and(|s| !s.trim().is_empty());
    let Some(rel) = file.clone() else {
        if has_inline {
            return Ok(());
        }
        return Err(format!("{label} declares neither 'source' nor 'file'"));
    };
    if has_inline {
        return Err(format!(
            "{label} declares both 'source' and 'file' ('{rel}') — exactly one is allowed"
        ));
    }
    validate_output_style_path(&rel).map_err(|e| format!("{label}: {e}"))?;
    let body = resolve(&rel).map_err(|e| format!("{label}: cannot resolve file: {e}"))?;
    if body.len() > MAX_OUTPUT_STYLE_BYTES {
        return Err(format!(
            "{label}: file '{rel}' is {} bytes (max {MAX_OUTPUT_STYLE_BYTES})",
            body.len()
        ));
    }
    if body.trim().is_empty() {
        return Err(format!("{label}: file '{rel}' is empty"));
    }
    *source = Some(body);
    *file = None;
    Ok(())
}

/// Validate an app `id`.
///
/// Two shapes are legal, and they are matched as **exact shapes** — never by
/// widening one permissive character allowlist to cover both:
///
/// 1. **Scoped** (`@scope/name`, e.g. `@ryu/meetings`) — the current form.
/// 2. **Legacy flat** (`ghost`, `@example/research-assistant`) — every id
///    predating the scoped scheme. Still legal *forever*, because the alias map
///    ([`canonical_plugin_id`]) lets a third-party manifest that was never updated
///    keep loading.
///
/// # Why exact shapes and not one wider alphabet
///
/// The id reaches filesystem-path contexts (`apps_dir().join(...)`), so an
/// unvalidated id is a path-traversal / arbitrary-write sink, and the original
/// allowlist rejected `/`, `\`, `:` and a leading `.` deliberately — the project is
/// Windows-first, where `PathBuf::join` with an absolute or drive-qualified
/// component silently **replaces** the base. A scoped id contains a `/`, so simply
/// adding `/` and `@` to that alphabet would make `@a/../../etc` a legal id and
/// reopen exactly that hole. Instead the scoped branch splits on the single `/` and
/// holds each half to the strict legacy alphabet, so no traversal segment can
/// survive in either half.
///
/// Note the disk never sees this `/` regardless: [`plugin_dir_name`] flattens a
/// scoped id before it is ever joined onto a path.
///
/// Both halves:
/// - non-empty, whole id at most [`MAX_PLUGIN_ID_LEN`] bytes
/// - characters limited to ASCII `[a-zA-Z0-9.-_]`
/// - no `..` sequence, no leading/trailing `.`, no leading `-`
///
/// Returns `Ok(())` when the id is safe, else a descriptive `Err(String)`.
pub fn validate_plugin_id(id: &str) -> Result<(), String> {
    // Scoped form: `@scope/name`. Exactly one `/`, `@` only as the first byte.
    if let Some(rest) = id.strip_prefix('@') {
        if id.len() > MAX_PLUGIN_ID_LEN {
            return Err(format!(
                "app id is too long ({} bytes, max {MAX_PLUGIN_ID_LEN})",
                id.len()
            ));
        }
        let Some((scope, name)) = rest.split_once('/') else {
            return Err(format!(
                "scoped app id '{id}' must be '@scope/name' (missing '/')"
            ));
        };
        if name.contains('/') {
            return Err(format!("scoped app id '{id}' must contain exactly one '/'"));
        }
        // Each half must itself be a legal flat id — this is what keeps `..`,
        // leading `.`/`-`, `\`, `:` and `@` out of BOTH halves.
        validate_flat_plugin_id(scope).map_err(|e| format!("scope of '{id}': {e}"))?;
        validate_flat_plugin_id(name).map_err(|e| format!("name of '{id}': {e}"))?;
        return Ok(());
    }
    validate_flat_plugin_id(id)
}

/// The strict legacy alphabet, applied to a whole flat id or to one half of a
/// scoped one. See [`validate_plugin_id`] for why this stays narrow.
fn validate_flat_plugin_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("app id must not be empty".to_string());
    }
    if id.len() > MAX_PLUGIN_ID_LEN {
        return Err(format!(
            "app id is too long ({} bytes, max {MAX_PLUGIN_ID_LEN})",
            id.len()
        ));
    }
    let valid_chars = id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if !valid_chars {
        return Err(format!(
            "app id '{id}' contains illegal characters (allowed: a-z A-Z 0-9 . - _)"
        ));
    }
    if id.contains("..") {
        return Err(format!("app id '{id}' must not contain '..'"));
    }
    if id.starts_with('.') || id.ends_with('.') {
        return Err(format!("app id '{id}' must not start or end with '.'"));
    }
    if id.starts_with('-') {
        return Err(format!("app id '{id}' must not start with '-'"));
    }
    Ok(())
}

/// The **on-disk directory name** for a plugin id.
///
/// A scoped id contains a `/` (`@ryu/meetings`), and the id is used as a directory
/// name under the plugins/apps dir. Joining the raw id would create a NESTED path —
/// and the manifest scanner uses a single-level `read_dir`, so a nested plugin would
/// be silently invisible rather than loudly broken. It would also put a path
/// separator into a value that reaches `PathBuf::join`, which is precisely the
/// surface [`validate_plugin_id`] exists to keep closed.
///
/// So the disk name is a FLATTENED derivation: `@ryu/meetings` → `@ryu+meetings`.
/// `+` is not legal in an id ([`validate_plugin_id`]'s alphabet excludes it), so the
/// mapping is unambiguous and cannot collide with a legacy flat id.
///
/// Every site that joins a plugin id onto a path must call this. The id itself stays
/// scoped everywhere else — this is a storage detail, not a rename.
#[must_use]
pub fn plugin_dir_name(id: &str) -> String {
    id.replace('/', "+")
}

/// Canonicalize a possibly-legacy plugin id to its current form.
///
/// The scoped rename (`@ryu/meetings` → `@ryu/meetings`) would otherwise orphan
/// real user state — the id is the `app_store` record key (carrying enabled-state and
/// Gateway-approved grants), the `plugin_storage` KV prefix, and the hash input for
/// every sidecar's minted ext token. This map is what lets the old id keep resolving
/// forever, so a third-party manifest that was never updated still loads.
///
/// Applied at the manifest-load chokepoint so everything downstream — `app_store`
/// lookups, hook dispatch, `may_emit_event` — only ever sees canonical ids and needs
/// no alias awareness of its own. The one caller that must apply it explicitly is the
/// sidecar callback authenticator, because the ext token is a hash over the raw id
/// string a sidecar presents.
#[must_use]
pub fn canonical_plugin_id(id: &str) -> &str {
    LEGACY_PLUGIN_ID_ALIASES
        .iter()
        .find(|(old, _)| *old == id)
        .map_or(id, |(_, new)| *new)
}

/// Old id → current id. Generated from the rename; append-only.
///
/// Deliberately a plain sorted slice rather than a map: it is read rarely (load and
/// sidecar auth), it must be greppable, and a static map would need a dependency to
/// buy nothing at this size.
pub const LEGACY_PLUGIN_ID_ALIASES: &[(&str, &str)] = &[
    ("agentbrowser", "@ryu/agentbrowser"),
    ("brave", "@ryu/brave"),
    ("chat-title", "@ryu/chat-title"),
    (
        "com.example.research-assistant",
        "@example/research-assistant",
    ),
    ("com.ryu.activity", "@ryu/activity"),
    ("com.ryu.agents", "@ryu/agents"),
    ("com.ryu.approvals", "@ryu/approvals"),
    ("com.ryu.browser", "@ryu/browser"),
    ("com.ryu.calendar", "@ryu/calendar"),
    ("com.ryu.canvas", "@ryu/canvas"),
    ("com.ryu.clips", "@ryu/clips"),
    ("com.ryu.dashboards", "@ryu/dashboards"),
    ("com.ryu.docling", "@ryu/docling"),
    ("com.ryu.finetune", "@ryu/finetune"),
    ("com.ryu.hardware", "@ryu/hardware"),
    ("com.ryu.healing", "@ryu/healing"),
    ("com.ryu.layers", "@ryu/layers"),
    ("com.ryu.learning", "@ryu/learning"),
    ("com.ryu.mail", "@ryu/mail"),
    ("com.ryu.markitdown", "@ryu/markitdown"),
    ("com.ryu.media", "@ryu/media"),
    ("com.ryu.meetings", "@ryu/meetings"),
    ("com.ryu.memory", "@ryu/memory"),
    ("com.ryu.mineru", "@ryu/mineru"),
    ("com.ryu.monitors", "@ryu/monitors"),
    ("com.ryu.quests", "@ryu/quests"),
    ("com.ryu.rag", "@ryu/rag"),
    ("com.ryu.recipes", "@ryu/recipes"),
    ("com.ryu.research", "@ryu/research"),
    ("com.ryu.simulator", "@ryu/simulator"),
    ("com.ryu.skill-editor", "@ryu/skill-editor"),
    ("com.ryu.skills", "@ryu/skills"),
    ("com.ryu.spaces", "@ryu/spaces"),
    ("com.ryu.teams", "@ryu/teams"),
    ("com.ryu.timeline", "@ryu/timeline"),
    ("com.ryu.unstructured", "@ryu/unstructured"),
    ("com.ryu.voice", "@ryu/voice"),
    ("com.ryu.warmup", "@ryu/warmup"),
    ("com.ryu.webhooks", "@ryu/webhooks"),
    ("com.ryu.whiteboard", "@ryu/whiteboard"),
    ("com.ryu.workflows", "@ryu/workflows"),
    ("com.ryuhq.advisor", "@ryu/advisor"),
    ("com.ryuhq.auto-expand", "@ryu/auto-expand"),
    ("com.ryuhq.hook-observers", "@ryu/hook-observers"),
    ("com.ryuhq.session-context", "@ryu/session-context"),
    ("com.ryuhq.tool-firewall", "@ryu/tool-firewall"),
    ("dictation", "@ryu/dictation"),
    ("double-check", "@ryu/double-check"),
    ("durable", "@ryu/durable"),
    ("engines", "@ryu/engines"),
    ("exa", "@ryu/exa"),
    ("firecrawl", "@ryu/firecrawl"),
    ("firewall", "@ryu/firewall"),
    ("ghost", "@ryu/ghost"),
    ("goal", "@ryu/goal"),
    ("headroom", "@ryu/headroom"),
    ("honcho", "@ryu/honcho"),
    ("mem0", "@ryu/mem0"),
    ("predict", "@ryu/predict"),
    ("proof", "@ryu/proof"),
    ("routing", "@ryu/routing"),
    ("rtk", "@ryu/rtk"),
    ("sample-widget", "@ryu/sample-widget"),
    ("sandbox", "@ryu/sandbox"),
    ("scrapling", "@ryu/scrapling"),
    ("security-guidance", "@ryu/security-guidance"),
    ("serper", "@ryu/serper"),
    ("shadow", "@ryu/shadow"),
    ("spider", "@ryu/spider"),
    ("spidercloud", "@ryu/spidercloud"),
    ("tavily", "@ryu/tavily"),
];

/// An installable Ryu App manifest (`manifest.json`).
///
/// Modelled on Codex's `manifest.json` pattern: a thin descriptor that bundles one or
/// more [`RunnableEntry`] items (agents, workflows, tools, skills, companions,
/// channels, engines, policies), lists the permission grants the app requires, and
/// optionally declares a Companion surface (an in-desktop overlay or sidebar panel).
///
/// # Per-kind config
///
/// Each Runnable entry carries an optional `config` blob whose schema is
/// determined by its `kind`. See [`crate::schema`] for the per-kind structs and the
/// [`crate::schema::validate_runnable`] function.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct PluginManifest {
    /// Reverse-domain unique identifier for the app (e.g. `"com.example.my-app"`).
    pub id: String,

    /// Human-readable display name shown in the app store / launcher.
    pub name: String,

    /// Semver version string (e.g. `"1.0.0"`).
    pub version: String,

    /// Lower-case hex `sha256(utf8_bytes(ui_code))` binding the plugin's bundled
    /// sandboxed-UI code to this manifest. Because the Gateway signs the manifest
    /// verbatim (canonical key-sorted encoding), this hash is INSIDE the signed
    /// surface while the `ui_code` blob itself rides OUTSIDE it as payload; the
    /// install path recomputes the hash over the fetched code and rejects a
    /// mismatch fail-closed. Absent for a manifest-only plugin (no bundled UI) and
    /// for unsigned seed items. Written by `ryu pack`/`ryu publish`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_code_sha256: Option<String>,

    /// The plugin's **backend bundle** — the JavaScript source of the extension-host
    /// entry module a [`crate::schema::SidecarProcess::Node`] sidecar runs (RFC Option
    /// B). This is the backend analogue of `ui_code`: a payload blob that Core writes
    /// to the plugin dir at the node sidecar's declared `entry` path at spawn, then
    /// loads via the embedded host bootstrap. Unlike `ui_code` (which the install path
    /// splits into a DB column so the on-disk manifest stays small), the backend blob
    /// rides **inline** in the manifest so the spawn path is self-contained (it reads
    /// the reconstituted manifest, no separate carriage channel) AND, for a
    /// marketplace plugin, the code is INSIDE the Gateway-signed surface — the whole
    /// backend is signed, not merely hash-bound. Absent for a plugin with no node
    /// backend. Written by `ryu pack`/`ryu publish`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_code: Option<String>,

    /// Lower-case hex `sha256(utf8_bytes(backend_code))` — the integrity gate for the
    /// node backend, mirroring [`ui_code_sha256`]. When present, Core recomputes the
    /// hash over the on-disk entry file at spawn and **refuses to start** the node
    /// sidecar on mismatch (fail-closed), so an entry file swapped on disk between
    /// install and spawn can never run. Absent = trust the bundle as written (the same
    /// posture `ui_code_sha256` uses when omitted).
    ///
    /// [`ui_code_sha256`]: PluginManifest::ui_code_sha256
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_sha256: Option<String>,

    /// The Runnables this app bundles. Each entry uses [`RunnableEntry`] from the
    /// [`crate::schema`] module so heterogeneous Runnables (agents, workflows,
    /// tools, skills, companions, channels, engines, policies) can be listed
    /// together with their per-kind config.
    pub runnables: Vec<RunnableEntry>,

    /// Permission grants this app declares it needs (e.g. `"mcp:web_search"`).
    /// These are *declarations only* at this layer — no enforcement happens here;
    /// the Gateway owns grant enforcement.
    ///
    /// This is the **app→host** lane and has nothing to do with
    /// [`permission_levels`], the **app→human** lane. See that field's doc comment
    /// for the three-way table; conflating the two is the likeliest future bug here.
    ///
    /// [`permission_levels`]: PluginManifest::permission_levels
    #[serde(default)]
    pub permission_grants: Vec<String>,

    /// **The user-facing permission vocabulary this app declares** — the set of
    /// levels ("read", "edit", …) an administrator can later grant to a person or a
    /// team *inside* this app. Absent/empty = the app declares no vocabulary, which
    /// is every manifest predating this field.
    ///
    /// Spaces declaring `read` and `edit` is what makes "team X may edit in Spaces"
    /// expressible at all: a grant has to name a level, and a UI has to render a
    /// list of them. Without a declaration there is nothing to bind to.
    ///
    /// # Three lanes, one prefix — do not conflate them
    ///
    /// | field | direction | who decides | what it means |
    /// |---|---|---|---|
    /// | [`permission_grants`] | app → host | the **Gateway**, at install/enable | which host capabilities the app may *ask* for |
    /// | [`permissions`] ([`PermissionSet`]) | app → sandbox | **Core**, at spawn/exec | what the app's code may *touch* (FS paths, hosts, subprocess) |
    /// | `permission_levels` | app → human | an **admin**, per person/team | what a *person* may do inside the app |
    ///
    /// Only the first two are enforced today. This field is **declaration only**:
    /// nothing consumes it yet, so declaring `edit` gates nothing by itself. It is
    /// the vocabulary the ACL layer will bind grants against.
    ///
    /// # Ordering and implication
    ///
    /// Declaration order is display order — render the list as written. Strength is
    /// expressed with [`PermissionLevel::implies`] rather than a separate rank, so
    /// there is exactly one ordering and it cannot contradict itself: `edit` implying
    /// `read` means granting `edit` already conveys `read`, and no admin has to grant
    /// the same person both.
    ///
    /// [`permission_grants`]: PluginManifest::permission_grants
    /// [`permissions`]: PluginManifest::permissions
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permission_levels: Vec<PermissionLevel>,

    /// **Unified, deny-by-default runtime permission set** — the single typed
    /// grammar (`{fs, child_process, run, network, tool}`) Core lowers to every sandbox
    /// backend (wasmtime WASI preopens, Docker `--mount`/`--network` flags, Deno
    /// `--allow-*` flags). Absent = **deny-all** (the default for every manifest
    /// predating this field), so an app that declares nothing keeps today's exact
    /// zero-permission sandbox posture.
    ///
    /// # Relationship to [`permission_grants`] and [`permission_levels`]
    ///
    /// These are **three distinct lanes** that must not be conflated:
    /// - [`permission_grants`] are opaque strings the **Gateway** approves at
    ///   install/enable time — the *approval* lane (who is allowed to ask).
    /// - `permissions` is the typed set **Core** lowers into the actual sandbox at
    ///   spawn/exec time — the *runtime-enforcement* lane (what the code can touch).
    /// - [`permission_levels`] is the app's *user-facing* vocabulary an admin grants
    ///   to a person or team — it never reaches the sandbox at all.
    ///
    /// A grant says "this app may use the filesystem capability"; `permissions.fs`
    /// says "…and here are the exact read/write paths the sandbox is opened with."
    ///
    /// [`permission_levels`]: PluginManifest::permission_levels
    ///
    /// # Altitude (manifest-level, per-runnable override is a followup)
    ///
    /// Declared at the manifest root because **both** current enforcement sites
    /// resolve their config from the owning manifest, not from a sub-entry: an
    /// `inline_deno` tool's backend is resolved from the manifest by
    /// `McpRegistry::resolve_app_tool_backend`, and a managed sidecar is spawned
    /// from the manifest by `ManifestSidecar`. A per-[`crate::schema::ToolConfig`] /
    /// per-[`crate::schema::SidecarSpec`] override is a clean future extension (the
    /// resolver would fall back to this manifest-level set) but is intentionally not
    /// in v1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<PermissionSet>,

    /// Optional Companion surface descriptor: an in-desktop overlay or sidebar panel
    /// the app may register. Absent when the app has no Companion surface.
    #[serde(default)]
    pub companion: Option<CompanionSurface>,

    /// VS-Code-style **contribution points**: a declare-by-id block naming which
    /// of the manifest's `runnables` the plugin contributes to each extensible
    /// surface. Every id referenced here MUST exist in `runnables` (the loader
    /// cross-validates). Absent when the plugin contributes nothing extra
    /// (the common case — a plugin's `runnables` are already its contributions).
    #[serde(default)]
    pub contributes: Option<Contributes>,

    /// Activation events that lazily wake the plugin — VS-Code `activationEvents`.
    /// Recognised tokens: `"*"` (always active / eager), `"onStartup"`, `"onChat"`,
    /// `"onCommand:<id>"`, `"onRoute"` (fired the first time a lazy sidecar is woken
    /// by an inbound proxy hit), and `"onCapabilityCall"` (the broker analogue —
    /// fired when a lazy provider sidecar is woken by a capability-broker hit). An
    /// **empty** list means *eager* activation (back-compat: every existing manifest
    /// keeps activating on enable). The activation runtime firing these events lives
    /// in Core's `RunnableRegistry::register_active` + `fire_activation_event`;
    /// `onStartup`/`onChat`/`onRoute`/`onCapabilityCall` fire from Core, while
    /// `onCommand:<id>` fires from the desktop command palette.
    #[serde(default)]
    pub activation_events: Vec<String>,

    /// Required Ryu engine version (VS-Code `engines.vscode` analogue). When
    /// present, `engines.ryu` is a semver **requirement** (e.g. `">=0.3.0"`) and
    /// the loader rejects the manifest if the running Core version does not
    /// satisfy it. Absent = compatible with any Core version.
    #[serde(default)]
    pub engines: Option<EnginesReq>,

    /// **Plugin-to-plugin dependencies** — the other plugins this one needs (the
    /// npm-shaped edge that lets the app decompose into a kernel + features).
    /// Resolved into a topological enable order by Core's `plugins::graph`.
    ///
    /// Absent = **no dependencies** (every manifest predating this field).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires: Option<Requires>,

    /// Host surfaces this plugin runs on (desktop / island / mobile / …).
    ///
    /// **Empty or absent = runs on EVERY surface.** This is the backward-compatible
    /// default and must never be read as "runs nowhere" — every manifest that
    /// predates this field declares no targets and must keep surfacing everywhere.
    /// Filtering happens ONLY when this list is explicitly non-empty, and only at
    /// the read/surface boundary (see [`PluginManifest::supports_surface`]) — never
    /// in the storage layer, so an unsupported-target plugin stays installable and
    /// inspectable.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<Surface>,

    /// Per-surface support + UI declaration — the richer successor to [`targets`].
    ///
    /// When **present**, this map is authoritative and [`targets`] is ignored: a
    /// surface is supported iff it has an entry whose [`SurfaceSupport`] is not
    /// [`SurfaceSupport::None`], and an **absent key means the surface is not
    /// supported** (see [`PluginManifest::supports_surface`]). When **absent**, the
    /// predicate falls back to the legacy [`targets`] semantics (empty/absent =
    /// every surface) — so every manifest that predates this field keeps its exact
    /// behaviour. Never make an absent `surfaces` mean "no surfaces".
    ///
    /// [`targets`]: PluginManifest::targets
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surfaces: Option<BTreeMap<Surface, SurfaceEntry>>,

    /// **Capabilities this plugin provides** — the inverse of
    /// [`Requires::capabilities`]. Each entry names a capability the plugin's
    /// sidecar can serve for other plugins through the capability broker, binding
    /// the capability to one of this manifest's declared `sidecars` + a proxied
    /// route. Absent/empty for the common case (a plugin that consumes but does not
    /// provide capabilities). The loader cross-validates that every referenced
    /// `sidecar`/`route` exists (like `contributes`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provides: Vec<ProvidesEntry>,

    /// Optional declarative **external runtime** the plugin needs (e.g. a Python
    /// venv + pip deps + assets, like the TTS sidecar). The provisioner lives in
    /// Core (`crate::sidecar::external_runtime`); this is the declaration (#449).
    /// Absent for the common case (no external interpreter needed).
    #[serde(default)]
    pub runtime: Option<schema::ExternalRuntimeConfig>,

    /// Declarative **managed sidecars** the plugin ships (the app ⇄ sidecar
    /// bridge): each is a long-running child process Core downloads/provisions,
    /// spawns, and health-monitors via the Core `SidecarManager` on enable,
    /// exactly like a built-in sidecar. Gated at enable by the `sidecar:process`
    /// grant (Core-tier auto; Community needs the approved grant). Empty for the
    /// common case (no bundled process).
    #[serde(default)]
    pub sidecars: Vec<schema::SidecarSpec>,

    /// Declarative **stdio MCP servers** this plugin registers into Core's MCP
    /// registry on enable and deregisters on disable/uninstall. Each entry is a
    /// [`McpServerDecl`] keyed by the server name the registry uses (the same key a
    /// user's `mcp.json` would use). This is the manifest-owned successor to Core's
    /// hardcoded built-in MCP servers: a plugin declares its server here instead of
    /// Core baking a `com.ryu.<app>` server into `builtin_servers()`. Empty for the
    /// common case (a plugin that ships no MCP server). A user `mcp.json` entry with
    /// the same name still wins (user-overrides-builtin precedence is preserved by
    /// the registry).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mcp_servers: BTreeMap<String, McpServerDecl>,

    // ── Rich marketplace metadata (Phase 1.5) ─────────────────────────────────
    //
    // All optional/additive so older manifests still load and render. These feed
    // the marketplace **detail** contract the desktop dialog consumes; where a
    // field aligns with the Claude `.claude-plugin/marketplace.json` plugin-entry
    // standard it keeps that JSON key (`author`, `homepage`, `category`,
    // `license`, `keywords`), and the Ryu extensions use their contract key.
    /// Long plaintext/markdown description. Empty when absent (the built-in card
    /// historically emitted `""` for this; preserved).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Short one-line tagline shown under the name (Ryu extension).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tagline: Option<String>,

    /// Logo URL (contract key `iconUrl`; Ryu extension).
    #[serde(default, rename = "iconUrl", skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,

    /// Icon-primitive id for the listing card (Ryu extension: `icon`). An
    /// Iconify/icons0 `prefix:name`, a bare Hugeicons name, or a URL — resolved by
    /// the shared `Icon` primitive. Distinct from `icon_url`: this is a GLYPH id the
    /// card masks with `currentColor`, `icon_url` is a raster logo. When absent the
    /// card falls back to `icon_url`, then a default glyph.
    ///
    /// One id shape is NOT a glyph: `svgl:<slug>` (or `svgl:<light>|<dark>`) names a
    /// brand mark on svgl.app, which the card renders as a full-colour image instead
    /// — masking a brand's logo to `currentColor` would flatten it to a silhouette.
    /// Prefer it over `icon_url` for a listing that fronts a known product (Brave,
    /// Firecrawl, Notion, …): it is a stable, versionless id rather than a URL that
    /// can rot, and svgl's own API supplies the dark-theme variant when one exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// Dithered-gradient background for the card's icon square (Ryu extension:
    /// `iconDither`). Opaque passthrough `{ from, to?, direction? }` mirroring
    /// dither-kit's `DitherGradient` props (`from`/`to` are a palette-colour name or
    /// a hue number, `direction` is up|down|left|right). Kept as raw JSON like
    /// `banner` so an untrusted/typo'd value never fails the manifest parse — the
    /// render layer validates and falls back before painting.
    #[serde(
        default,
        rename = "iconDither",
        skip_serializing_if = "Option::is_none"
    )]
    pub icon_dither: Option<serde_json::Value>,

    /// CSS background for the icon square (Ryu extension: `iconBackground`).
    #[serde(
        default,
        rename = "iconBackground",
        skip_serializing_if = "Option::is_none"
    )]
    pub icon_background: Option<String>,

    /// Inset for the card's icon square (Ryu extension: `iconPadding`).
    ///
    /// A product LOGO that is edge-to-edge in its own art has no breathing room
    /// inside the square and reads as a sticker rather than an icon. One of
    /// `none` | `sm` | `md` | `lg`.
    ///
    /// Any value other than `none` ALSO letterboxes the art (`object-contain`)
    /// instead of cropping it. That coupling is load-bearing, not a convenience:
    /// a listing declaring a bare `iconUrl` (no `icon`) is not in the brand lane,
    /// so it is painted `object-cover` — inset alone would be silently inert for
    /// exactly the raw-logo case this field exists for.
    ///
    /// `Option<String>` rather than a Rust enum, for the same forward-compat
    /// reason `icon_dither` is raw JSON: an unknown value must never fail the
    /// manifest parse. The render layer validates and falls back.
    #[serde(
        default,
        rename = "iconPadding",
        skip_serializing_if = "Option::is_none"
    )]
    pub icon_padding: Option<String>,

    /// Primary brand accent color, hex (Ryu extension: `accentColor`).
    #[serde(
        default,
        rename = "accentColor",
        skip_serializing_if = "Option::is_none"
    )]
    pub accent_color: Option<String>,

    /// Detail-page hero banner spec; opaque passthrough (Ryu ext).
    ///
    /// The banner is the listing's OWN background, not its icon enlarged. Declared
    /// or not, the hero always paints something: with no `banner` the detail page
    /// derives its wash from `icon_dither`, so an app that never thinks about this
    /// key still opens on its own colour rather than a grey slab. Declaring one is
    /// how an author says "my hero is not just my icon, bigger".
    ///
    /// Accepted keys, all optional — the render layer picks the first that paints
    /// and falls back down the list, so an unknown or malformed value degrades to
    /// the derived wash rather than failing:
    ///
    /// - `background` — a flat CSS background (a colour, a `linear-gradient(…)`).
    /// - `imageUrl` — a raster banner, painted `object-cover`. http(s) only.
    /// - `colors: [String]` — two or more stops, ramped 135°.
    /// - `style: "gradient" | "dither" | "flat" | "image"` — how to treat the
    ///   above; `dither` adds the noise overlay, `flat`/`image` select `background`
    ///   / `imageUrl` explicitly.
    /// - `seed: Number` — the dither noise seed, so two apps sharing a palette do
    ///   not share a texture.
    ///
    /// Kept as raw JSON like `icon_dither`, for the same reason: this is
    /// PUBLISHER-supplied and reaches a CSS background, so it must never fail the
    /// manifest parse, and the client validates before painting (`safeHttpUrl` for
    /// `imageUrl`; the flat string is trusted exactly as far as `icon_background`
    /// already is). Core does not read any of these keys — it copies the whole
    /// value onto the catalog entry — so a new one needs no Core release.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub banner: Option<serde_json::Value>,

    /// App-Store gallery screenshot URLs (Ryu extension).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub screenshots: Vec<String>,

    /// Publisher/author. Claude `author` — a bare string or an object with a
    /// `name` field; the detail builder extracts the display string into
    /// `developer`. Kept as a raw value so both shapes round-trip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<serde_json::Value>,

    /// Public source repository URL (Claude/Codex `repository`). This is listing
    /// metadata only; install and signature resolution still use the catalog's
    /// authoritative source fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,

    /// Whether the provider operates outside the local Ryu runtime, for example a
    /// hosted browser or remote MCP service. This is a presentation/provenance
    /// flag, not a permission grant; the actual remote endpoint remains declared
    /// under `mcp_servers` and is governed by the Gateway.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub external: bool,

    /// Free-text category (Claude `category`). The Store groups its Apps and
    /// Plugins tabs by this string, so two listings that mean the same shelf must
    /// spell it the same way — see the canonical set in `docs/`-adjacent
    /// `STORE_CATEGORY_ORDER` (`packages/marketplace/src/catalog/categories.ts`),
    /// which also decides shelf ORDER. An unrecognised value still renders; it just
    /// sorts after the known shelves, so a new category needs no client release.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,

    /// Hide this listing from the Store without uninstalling or disabling it.
    ///
    /// The listing keeps working for anyone who already has it — this is a
    /// *catalog* control, not a lifecycle one. It exists so an app that is built
    /// but not ready to be discovered can ship dark: the manifest stays compiled
    /// in, the routes stay registered, and the card simply is not offered.
    ///
    /// Absent ⇒ visible, matching the identically-named field the published
    /// `marketplace.json` already carries for third-party indexes
    /// (`catalog_source::sources`), so both tiers spell "don't list this" the same
    /// way and a client that predates the field just shows everything.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,

    /// How finished this listing is: `alpha`, `beta`, `rc`, … Absent or `stable`
    /// means finished and renders no badge.
    ///
    /// Free-form, NOT an enum, for the same reason the marketplace-index copy of
    /// this field is: an unrecognised tier renders verbatim rather than being
    /// dropped, so publishing a `canary` needs no client release.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stability: Option<String>,

    /// This plugin is REQUIRED FOR CORE: the UI must never offer to disable or
    /// uninstall it, and the lifecycle refuses both — with no `force` escape, which
    /// is what separates it from the softer
    /// [`crate::manifest`]-external load-bearing guard.
    ///
    /// **Declaring this does not grant it.** A manifest is untrusted input, and an
    /// undisableable plugin is exactly what a hostile one would ask to be, so the
    /// enforcement set is a Core-owned constant (`plugins::builtins::
    /// MANDATORY_PLUGINS`) and this field is only the manifest-side declaration of
    /// it. A bijection test keeps the two in lockstep, and a third-party manifest
    /// that sets it is ignored by the lifecycle — it only ever affects how the
    /// listing renders. Same posture as `CORE_PLUGINS`: privilege is never
    /// self-asserted.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub mandatory: bool,

    /// Homepage/website URL (Claude `homepage`; emitted as `website`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,

    /// SPDX license identifier (Claude `license`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,

    /// Search keywords / tags (Claude `keywords`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,

    /// Curated store-filter tags (Ryu extension). Unlike `keywords`, which is
    /// publisher search vocabulary, these stable labels are the values the
    /// Marketplace filter exposes. Keeping both fields lets Claude/Codex
    /// manifests round-trip their native `keywords` while Ryu authors opt into
    /// a deliberately bounded taxonomy.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,

    /// Privacy policy URL (contract key `privacyPolicyUrl`; Ryu extension).
    #[serde(
        default,
        rename = "privacyPolicyUrl",
        skip_serializing_if = "Option::is_none"
    )]
    pub privacy_policy_url: Option<String>,

    /// Terms-of-service URL (contract key `termsOfServiceUrl`; Ryu extension).
    #[serde(
        default,
        rename = "termsOfServiceUrl",
        skip_serializing_if = "Option::is_none"
    )]
    pub terms_of_service_url: Option<String>,

    /// Human-readable capability strings (Ryu extension). When absent the detail
    /// builder DERIVES these from `permission_grants` via
    /// [`crate::schema::capabilities_from_grants`]; declared values are used verbatim.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,

    /// Prompt-chip examples (contract key `examplePrompts`; Ryu extension).
    #[serde(
        default,
        rename = "examplePrompts",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub example_prompts: Vec<String>,

    /// Optional companion/config setup card, or an array of such steps (Ryu
    /// extension). Opaque to Core — passed through to the detail payload verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<serde_json::Value>,

    /// Provenance hint for the marketplace index: `"builtin"`, an `owner/repo`
    /// slug, or a git/raw URL an external plugin ships from. Absent ⇒ `"builtin"`.
    /// This is an index HINT only — Core derives the real trust tier from
    /// `plugins::builtins` membership at runtime, NOT from this field. Consumed by
    /// the marketplace generator (`tools/mirror-plugins.sh`) to populate each
    /// entry's `source`/`builtin` pair.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

impl PluginManifest {
    /// The `developer` display string for the detail contract, extracted from the
    /// Claude `author` field: a bare string is used directly, an object's `name`
    /// field is read, any other shape yields `None`.
    pub fn developer(&self) -> Option<String> {
        match self.author.as_ref()? {
            serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
            serde_json::Value::Object(map) => map
                .get("name")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            _ => None,
        }
    }

    /// Resolve the `capabilities` label list for the detail contract: declared
    /// values verbatim, else derived from `permission_grants`.
    pub fn resolved_capabilities(&self) -> Vec<String> {
        if self.capabilities.is_empty() {
            schema::capabilities_from_grants(&self.permission_grants)
        } else {
            self.capabilities.clone()
        }
    }

    /// The plugin-to-plugin dependency edges this manifest declares. Empty when
    /// `requires` is absent (no dependencies) — the common case.
    pub fn dependencies(&self) -> &[AppDependency] {
        self.requires.as_ref().map_or(&[], |r| r.apps.as_slice())
    }

    /// Whether this plugin should be surfaced on `surface`.
    ///
    /// Two eras, in precedence order:
    /// 1. If [`surfaces`] is **present**, it is authoritative and [`targets`] is
    ///    ignored: supported iff the surface has an entry whose [`SurfaceSupport`]
    ///    is not [`SurfaceSupport::None`]. An **absent key means unsupported**.
    /// 2. Otherwise fall back to the legacy [`targets`] rule — **an empty/absent
    ///    `targets` list means every surface** (the backward-compatible default);
    ///    a non-empty list filters to its members.
    ///
    /// Never read an absent `surfaces` as "no surfaces" — that would vanish every
    /// manifest predating the field.
    ///
    /// [`surfaces`]: PluginManifest::surfaces
    /// [`targets`]: PluginManifest::targets
    pub fn supports_surface(&self, surface: Surface) -> bool {
        // A caller only ever asks about a REAL surface. `Surface::Unknown` is a
        // deserialization landing pad for a token this build does not know, so
        // answering it is meaningless — and answering `true` would let a manifest
        // widen its own support by naming a surface we cannot verify.
        if surface == Surface::Unknown {
            return false;
        }
        if let Some(surfaces) = &self.surfaces {
            return surfaces
                .get(&surface)
                .is_some_and(|e| e.support.is_supported());
        }
        // Legacy flat list. Unknown entries are surfaces a NEWER Ryu added, so they
        // can never match what we were asked about — but they still prove the author
        // declared an explicit target list. Dropping them and falling back to
        // "empty means everywhere" would turn a manifest aimed only at future
        // surfaces into one that renders on every current surface, which is the
        // opposite of what it asked for.
        if self.targets.is_empty() {
            return true;
        }
        self.targets.contains(&surface)
    }

    /// The capability edges this manifest requires (empty when `requires` is absent
    /// or declares no capabilities). Consumed by the capability binding registry.
    pub fn required_capabilities(&self) -> &[CapabilityReq] {
        self.requires
            .as_ref()
            .map_or(&[], |r| r.capabilities.as_slice())
    }

    /// The capabilities this manifest provides (empty for a pure consumer).
    pub fn provided_capabilities(&self) -> &[ProvidesEntry] {
        &self.provides
    }

    /// Returns the list of [`RunnableEntry`] items bundled by this manifest.
    ///
    /// Each entry carries `id`, `name`, [`RunnableKind`], and an optional per-kind
    /// `config` blob so callers can distinguish all eight Runnable kinds in a single
    /// heterogeneous list without downcasting.
    pub fn runnables(&self) -> &[RunnableEntry] {
        &self.runnables
    }

    /// Returns only the bundled Runnables of a specific [`RunnableKind`].
    pub fn runnables_of_kind(&self, kind: RunnableKind) -> Vec<&RunnableEntry> {
        self.runnables.iter().filter(|r| r.kind == kind).collect()
    }

    /// Returns a [`RunnableMeta`] view of each bundled Runnable (id + name + kind,
    /// no per-kind config). Useful when callers only need identity metadata.
    pub fn runnable_metas(&self) -> Vec<RunnableMeta> {
        self.runnables
            .iter()
            .map(|e| RunnableMeta {
                id: e.id.clone(),
                name: e.name.clone(),
                kind: e.kind,
            })
            .collect()
    }

    /// Parse a manifest from JSON and fully validate it (id, semver, per-kind
    /// Runnable contracts). The single entry point a binding/SDK should use when
    /// loading an untrusted manifest.
    ///
    /// Note: this is the *portable* validation surface (id + semver + runnable
    /// contracts). Core's own loader runs a stricter superset (engines pin,
    /// sidecar specs, contribution cross-checks, duplicate-id detection).
    pub fn parse_and_validate(raw: &str) -> Result<Self, String> {
        let manifest: Self =
            serde_json::from_str(raw).map_err(|e| format!("JSON parse error: {e}"))?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// [`Self::parse_and_validate`] for a manifest that may declare its sandboxed
    /// JS as `code_file` paths instead of inline `code` — the form every
    /// first-party plugin under `plugins-store/` uses.
    ///
    /// `resolve` maps one plugin-root-relative path to that file's contents; the
    /// caller owns the I/O (this crate is pure data), so a built-in plugin can
    /// resolve from a compiled-in table while an on-disk plugin reads its own
    /// directory. Hydration runs BEFORE validation, so the manifest a caller gets
    /// back is always in the runtime-ready form: `code` populated, `code_file`
    /// cleared.
    pub fn parse_and_validate_with_code(
        raw: &str,
        resolve: impl FnMut(&str) -> Result<String, String>,
    ) -> Result<Self, String> {
        let mut manifest: Self =
            serde_json::from_str(raw).map_err(|e| format!("JSON parse error: {e}"))?;
        manifest.hydrate_code_files(resolve)?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// Every plugin-root-relative `code_file` path this manifest declares, in walk
    /// order. Empty once the manifest has been hydrated.
    ///
    /// Exists so a packaging/mirroring step can enumerate the files a plugin's
    /// manifest depends on without duplicating the walk.
    pub fn code_file_refs(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(contributes) = &self.contributes {
            for hook in &contributes.turn_hooks {
                if let Some(rel) = hook.code_file.as_deref() {
                    out.push(rel.to_string());
                }
            }
        }
        for entry in &self.provides {
            for binding in entry.tools.values() {
                if let Some(rel) = binding
                    .adapter
                    .as_ref()
                    .and_then(|a| a.code_file.as_deref())
                {
                    out.push(rel.to_string());
                }
            }
        }
        out
    }

    /// Every plugin-root-relative `pi_extensions[].file` path this manifest
    /// declares, in walk order.
    ///
    /// The [`Self::code_file_refs`] analogue for the OTHER carriage path, and
    /// deliberately a separate list: `code_file_refs` is the input to the
    /// sandboxed-JS embed table's bijection, and folding unsandboxed `.ts` into it
    /// would both break that bijection and conflate two things with very different
    /// privilege.
    ///
    /// # Why there is no `hydrate_pi_extensions` twin
    ///
    /// A `code_file` hydrates into `code` because every consumer downstream of
    /// parsing — the sandbox host, the capability facade, the Gateway-signed pack
    /// bundle — reads one inline string, so the file has to become part of the
    /// signed surface. A Pi extension has no such consumer: it is a **file Pi opens
    /// by path** at process start, and the only thing Core does with it is copy the
    /// bytes into the managed Pi's `extensions/` dir. Hydrating would push a 50 KB
    /// TypeScript program into a JSON string on `GET /api/plugins` and into every
    /// manifest clone, which is exactly what
    /// `packaged_plugin_manifests_declare_no_inline_sandbox_code` exists to prevent.
    /// The path→bytes resolution therefore happens once, at the materializer.
    pub fn pi_extension_refs(&self) -> Vec<String> {
        self.contributes
            .iter()
            .flat_map(|c| c.pi_extensions.iter())
            .map(|ext| ext.file.clone())
            .collect()
    }

    /// Every plugin-root-relative `output_styles[].file` path this manifest declares,
    /// in walk order. Empty once the manifest has been hydrated.
    ///
    /// The [`Self::code_file_refs`] analogue for the style carriage path, and a third
    /// separate list for the same reason `pi_extension_refs` is a second one: each
    /// feeds a different embed table's bijection assertion
    /// (`BUILTIN_CODE_FILES` / `BUILTIN_PI_EXTENSIONS` / the output-style table), and
    /// folding them together would break all three at once.
    pub fn output_style_refs(&self) -> Vec<String> {
        self.contributes
            .iter()
            .flat_map(|c| c.output_styles.iter())
            .filter_map(|style| style.file.clone())
            .collect()
    }

    /// Replace every `code_file` reference with the file's contents, in place.
    ///
    /// # The invariant this encodes
    ///
    /// `code_file` is the **source** form and `code` is the **wire** form. A plugin
    /// is authored with its sandboxed JS in real `.js` files — readable, lintable,
    /// diffable, and auditable for malware — while everything downstream of parsing
    /// (Core's `plugin_host`, the capability facade, the Gateway-signed marketplace
    /// bundle `ryu pack` emits) keeps seeing the single inline `code` string it
    /// always saw. That is deliberate and must not be "helpfully" relaxed: inlining
    /// at pack time is what keeps the whole hook/adapter body INSIDE the signed
    /// surface, so no new unsigned-code carriage channel is introduced by letting
    /// authors use files.
    ///
    /// # Fail-closed
    ///
    /// A code-bearing node must declare **exactly one** of `code` / `code_file`,
    /// and an unresolvable `code_file` is a hard error. Neither ever degrades to an
    /// empty body: a hook that silently becomes a no-op is the exact failure this
    /// whole seam has to avoid, since nothing downstream can tell an empty hook
    /// from a hook that chose to do nothing.
    pub fn hydrate_code_files(
        &mut self,
        mut resolve: impl FnMut(&str) -> Result<String, String>,
    ) -> Result<(), String> {
        let plugin = self.id.clone();
        if let Some(contributes) = &mut self.contributes {
            for hook in &mut contributes.turn_hooks {
                let label = format!("plugin '{plugin}' turn hook '{}'", hook.id);
                hydrate_one(&label, &mut hook.code, &mut hook.code_file, &mut resolve)?;
            }
        }
        for entry in &mut self.provides {
            let capability = entry.capability.clone();
            for (verb, binding) in &mut entry.tools {
                let Some(adapter) = binding.adapter.as_mut() else {
                    continue;
                };
                let label = format!("plugin '{plugin}' capability '{capability}' adapter '{verb}'");
                hydrate_one(
                    &label,
                    &mut adapter.code,
                    &mut adapter.code_file,
                    &mut resolve,
                )?;
            }
        }
        Ok(())
    }

    /// Replace every `output_styles[].file` reference with the file's contents, in
    /// place — the prose twin of [`Self::hydrate_code_files`], and the function
    /// `docs/output-styles.md` §4 names.
    ///
    /// Same source/wire invariant, for the same reason: a style body is authored as a
    /// real `.md` file (diffable, copyable straight into a user's own
    /// `output-styles/` directory) and every consumer downstream of parsing — the
    /// registry, `GET /api/plugins/contributions`, the Gateway-signed bundle `ryu
    /// pack` emits — sees only the inline `source` string. Inlining at pack time is
    /// what keeps the whole body INSIDE the signed surface, so authoring in files
    /// adds no unsigned carriage channel.
    ///
    /// # `source` carries the WHOLE file, frontmatter included
    ///
    /// Not a pre-split body plus mirrored `name`/`description` manifest keys. Two
    /// things fall out of that. There stays exactly ONE parser
    /// (`parse_output_style_md`) for a style off disk and a style out of a manifest,
    /// so the two can never drift in how they read frontmatter; and the frontmatter
    /// remains the single source of truth for a style's metadata, so a manifest key
    /// cannot disagree with the file it points at.
    ///
    /// # Fail-closed
    ///
    /// Exactly one of `source` / `file`, and an unresolvable `file` is a hard error —
    /// never an empty body. An empty style would silently degrade to "no style", the
    /// one outcome indistinguishable at every read site from the user's own choice
    /// not to use one.
    pub fn hydrate_output_style_files(
        &mut self,
        mut resolve: impl FnMut(&str) -> Result<String, String>,
    ) -> Result<(), String> {
        let plugin = self.id.clone();
        let Some(contributes) = &mut self.contributes else {
            return Ok(());
        };
        for style in &mut contributes.output_styles {
            let label = format!("plugin '{plugin}' output style '{}'", style.id);
            hydrate_one_output_style(&label, &mut style.source, &mut style.file, &mut resolve)?;
        }
        Ok(())
    }

    /// Reject a manifest that is not in the runtime-ready code form: a residual
    /// `code_file` (parsed without a resolver — see
    /// [`Self::parse_and_validate_with_code`]) or an empty `code` body.
    ///
    /// Both are loud failures on purpose. The alternative — parse, leave `code`
    /// empty, and let the sandbox run nothing — is indistinguishable at every read
    /// site from a hook that legitimately did nothing.
    ///
    /// Called by [`Self::validate`], and separately by the **install ingest** paths
    /// (install-from-URL, install-from-local-bundle, install-from-marketplace).
    /// Those deserialize a `PluginManifest` straight off the wire without running
    /// the full [`Self::validate`] superset, and they persist ONLY the manifest —
    /// no sibling `.js` files — so a `code_file` arriving there could never be
    /// resolved afterwards. `ryu pack` inlines it before publishing precisely so it
    /// never does; this is the gate that makes that a contract instead of a habit.
    pub fn validate_code_sources(&self) -> Result<(), String> {
        let check = |label: &str, code: &str, code_file: Option<&str>| -> Result<(), String> {
            if let Some(rel) = code_file {
                return Err(format!(
                    "{label} still declares code_file '{rel}' — the manifest was parsed \
                     without a code resolver (use PluginManifest::parse_and_validate_with_code)"
                ));
            }
            if code.trim().is_empty() {
                return Err(format!("{label} declares neither 'code' nor 'code_file'"));
            }
            Ok(())
        };
        if let Some(contributes) = &self.contributes {
            for hook in &contributes.turn_hooks {
                check(
                    &format!("plugin '{}' turn hook '{}'", self.id, hook.id),
                    &hook.code,
                    hook.code_file.as_deref(),
                )?;
            }
        }
        for entry in &self.provides {
            for (verb, binding) in &entry.tools {
                if let Some(adapter) = binding.adapter.as_ref() {
                    check(
                        &format!(
                            "plugin '{}' capability '{}' adapter '{verb}'",
                            self.id, entry.capability
                        ),
                        &adapter.code,
                        adapter.code_file.as_deref(),
                    )?;
                }
            }
        }
        Ok(())
    }

    /// Validate this manifest's id, version, and every Runnable entry.
    pub fn validate(&self) -> Result<(), String> {
        validate_plugin_id(&self.id)?;
        if semver::Version::parse(&self.version).is_err() {
            return Err(format!(
                "plugin '{}' has invalid semver version '{}'",
                self.id, self.version
            ));
        }
        for entry in &self.runnables {
            schema::validate_runnable(entry).map_err(|e| format!("plugin '{}': {e}", self.id))?;
        }
        self.validate_capabilities()?;
        self.validate_surface_commands()?;
        self.validate_mcp_oauth()?;
        self.validate_code_sources()?;
        // Portable validation cannot know whether Core loaded these exact bytes as
        // a trusted built-in, but it can still enforce the universal half of the
        // contract: safe Core-relative paths and GET-only automatic sources.
        self.validate_declarative_http_policy(true)?;
        if let Some(contributes) = &self.contributes {
            contributes
                .validate_settings_contributions()
                .map_err(|e| format!("plugin '{}': {e}", self.id))?;
            contributes
                .validate_hook_events(&self.id)
                .map_err(|e| format!("plugin '{}': {e}", self.id))?;
            contributes
                .validate_pi_extensions()
                .map_err(|e| format!("plugin '{}': {e}", self.id))?;
            contributes
                .validate_output_styles()
                .map_err(|e| format!("plugin '{}': {e}", self.id))?;
            if let Some(templates) = &contributes.chat_widget_templates {
                validate_chat_widget_templates(templates)
                    .map_err(|e| format!("plugin '{}': {e}", self.id))?;
            }
        }
        if let Some(permissions) = &self.permissions {
            permissions
                .validate()
                .map_err(|e| format!("plugin '{}': {e}", self.id))?;
        }
        validate_permission_levels(&self.permission_levels)
            .map_err(|e| format!("plugin '{}': {e}", self.id))?;
        validate_route_permissions(&self.sidecars, &self.permission_levels)
            .map_err(|e| format!("plugin '{}': {e}", self.id))?;
        Ok(())
    }

    /// Validate every renderer-executed declarative HTTP declaration.
    ///
    /// `allow_core_routes` is a Core-owned provenance decision. `true` is reserved
    /// for an exact compiled/verified Core-tier manifest; `false` confines every
    /// source/action to this plugin's generic `/api/ext/<id>` owner mount.
    pub fn validate_declarative_http_policy(&self, allow_core_routes: bool) -> Result<(), String> {
        let Some(contributes) = &self.contributes else {
            return Ok(());
        };
        validate_declarative_http_contributions(&self.id, contributes, allow_core_routes)
            .map_err(|error| format!("plugin '{}': {error}", self.id))
    }

    /// Validate the publisher-controlled half of remote MCP OAuth.
    ///
    /// OAuth is deliberately narrower than static MCP configuration: only a
    /// remote HTTPS endpoint (or an explicit loopback development endpoint) may
    /// request it, static `Authorization` cannot compete with Core's bearer, and
    /// both the process-registration and credential-read grants must be declared.
    fn validate_mcp_oauth(&self) -> Result<(), String> {
        for (server_name, server) in &self.mcp_servers {
            let Some(auth) = &server.auth else {
                continue;
            };
            let url = server
                .url
                .as_deref()
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .ok_or_else(|| {
                    format!(
                        "plugin '{}': MCP server '{server_name}' declares OAuth but no remote url",
                        self.id
                    )
                })?;
            if server
                .transport
                .as_deref()
                .is_some_and(|transport| transport.trim().eq_ignore_ascii_case("stdio"))
            {
                return Err(format!(
                    "plugin '{}': MCP server '{server_name}' cannot declare OAuth on a stdio transport",
                    self.id
                ));
            }
            if server
                .command
                .as_deref()
                .is_some_and(|command| !command.trim().is_empty())
            {
                return Err(format!(
                    "plugin '{}': MCP server '{server_name}' cannot combine OAuth with a stdio command",
                    self.id
                ));
            }
            if server
                .headers
                .keys()
                .any(|name| name.eq_ignore_ascii_case("authorization"))
            {
                return Err(format!(
                    "plugin '{}': MCP server '{server_name}' cannot combine OAuth with a static Authorization header",
                    self.id
                ));
            }

            let parsed = url::Url::parse(url).map_err(|error| {
                format!(
                    "plugin '{}': MCP server '{server_name}' has an invalid OAuth resource url: {error}",
                    self.id
                )
            })?;
            let loopback = parsed.host_str().is_some_and(|host| {
                host.eq_ignore_ascii_case("localhost")
                    || host
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
            });
            if parsed.scheme() != "https" && !(parsed.scheme() == "http" && loopback) {
                return Err(format!(
                    "plugin '{}': MCP server '{server_name}' OAuth url must use https (http is allowed only for loopback development)",
                    self.id
                ));
            }
            if parsed.username() != "" || parsed.password().is_some() || parsed.fragment().is_some()
            {
                return Err(format!(
                    "plugin '{}': MCP server '{server_name}' OAuth url must not contain userinfo or a fragment",
                    self.id
                ));
            }
            if auth
                .client_id()
                .is_some_and(|client_id| client_id.trim().is_empty())
            {
                return Err(format!(
                    "plugin '{}': MCP server '{server_name}' OAuth client_id must not be empty",
                    self.id
                ));
            }
            for grant in ["mcp:server", "identity.read"] {
                if !self
                    .permission_grants
                    .iter()
                    .any(|declared| declared == grant)
                {
                    return Err(format!(
                        "plugin '{}': MCP server '{server_name}' declares OAuth but is missing required permission grant '{grant}'",
                        self.id
                    ));
                }
            }
        }
        Ok(())
    }

    /// Validate every contributed CLI subcommand path in the `surfaces` map.
    ///
    /// A `surfaces.cli.commands[].path` is appended to `/api/ext/<plugin_id>` by the
    /// TUI and fetched, so an unvalidated `path` is a **client-side path-traversal /
    /// SSRF sink**: a WHATWG URL parser resolves `..` segments (and their
    /// percent-encoded `%2e` and backslash-separated forms — `\` is a path separator
    /// for http URLs) BEFORE the request is sent, escaping the `/api/ext/<id>/` scope
    /// so the request reaches an arbitrary internal Core/Gateway route carrying the
    /// full node bearer. This is the **load-time** gate that makes a malicious
    /// manifest fail to install rather than fail at call — see
    /// [`validate_cli_command_path`].
    fn validate_surface_commands(&self) -> Result<(), String> {
        let Some(surfaces) = &self.surfaces else {
            return Ok(());
        };
        for entry in surfaces.values() {
            for cmd in &entry.commands {
                validate_cli_command_path(&cmd.path).map_err(|e| {
                    format!(
                        "plugin '{}': cli command '{}' has an invalid path '{}': {e}",
                        self.id, cmd.name, cmd.path
                    )
                })?;
            }
        }
        Ok(())
    }

    /// Return the native tool ids this manifest actually registers. Alias
    /// runnables deliberately do not contribute ownership: they re-expose a
    /// tool owned by another registry entry and must not become a capability
    /// provider escape hatch.
    fn owned_native_tool_ids(&self) -> Result<BTreeSet<String>, String> {
        let mut ids = BTreeSet::new();
        for runnable in &self.runnables {
            if runnable.kind != RunnableKind::Tool {
                continue;
            }
            let Some(config) = runnable.config.as_ref() else {
                continue;
            };
            let tool: schema::ToolConfig = serde_json::from_value(config.clone()).map_err(|e| {
                format!(
                    "plugin '{}': tool runnable '{}' has invalid config: {e}",
                    self.id, runnable.id
                )
            })?;
            let backend = tool.resolve_backend().map_err(|e| {
                format!(
                    "plugin '{}': tool runnable '{}' has invalid backend: {e}",
                    self.id, runnable.id
                )
            })?;
            if matches!(backend, schema::ToolBackend::Alias { .. }) {
                continue;
            }
            let slug = canonical_provider_tool_id(&tool.slug);
            if tool.slug.contains('.') || tool.slug.contains("__") {
                ids.insert(slug);
            } else {
                ids.insert(format!("app.{slug}"));
            }
        }
        Ok(ids)
    }

    fn owns_provider_tool(&self, target: &str, native_ids: &BTreeSet<String>) -> bool {
        let target = canonical_provider_tool_id(target.trim());
        if native_ids.contains(&target) {
            return true;
        }
        self.mcp_servers.keys().any(|server| {
            target
                .strip_prefix(&format!("{server}."))
                .is_some_and(|tool| !tool.is_empty())
        })
    }

    /// Cross-validate the capability edges (`requires.capabilities` + `provides`):
    /// version floors/strings parse, every provided capability's referenced
    /// `sidecar`/`route` exists on this manifest, and each bound tool belongs to
    /// this provider. The last check is what prevents a declarative binding or
    /// `callNamed` adapter from dispatching through another plugin's tool.
    fn validate_capabilities(&self) -> Result<(), String> {
        let native_tool_ids = self.owned_native_tool_ids()?;
        for req in self.required_capabilities() {
            if req.capability.trim().is_empty() {
                return Err(format!(
                    "plugin '{}': a required capability has an empty name",
                    self.id
                ));
            }
            if let Some(min) = &req.min_version {
                parse_min_version(min).map_err(|e| {
                    format!(
                        "plugin '{}': required capability '{}' has invalid min_version: {e}",
                        self.id, req.capability
                    )
                })?;
            }
        }
        for prov in &self.provides {
            if prov.capability.trim().is_empty() {
                return Err(format!(
                    "plugin '{}': a provided capability has an empty name",
                    self.id
                ));
            }
            if semver::Version::parse(&prov.version).is_err() {
                return Err(format!(
                    "plugin '{}': provided capability '{}' has invalid version '{}'",
                    self.id, prov.capability, prov.version
                ));
            }
            for (verb, binding) in &prov.tools {
                if !self.owns_provider_tool(&binding.tool, &native_tool_ids) {
                    return Err(format!(
                        "plugin '{}': capability '{}' verb '{}' targets tool '{}' that is not owned by this provider",
                        self.id, prov.capability, verb, binding.tool
                    ));
                }
                if let Some(adapter) = &binding.adapter {
                    for target in &adapter.tools {
                        if !self.owns_provider_tool(target, &native_tool_ids) {
                            return Err(format!(
                                "plugin '{}': capability '{}' verb '{}' adapter targets tool '{}' that is not owned by this provider",
                                self.id, prov.capability, verb, target
                            ));
                        }
                    }
                }
            }
            match (&prov.sidecar, &prov.route) {
                (Some(sc_name), route) => {
                    let Some(sidecar) = self.sidecars.iter().find(|s| &s.name == sc_name) else {
                        return Err(format!(
                            "plugin '{}': provided capability '{}' names sidecar '{}' which is not declared",
                            self.id, prov.capability, sc_name
                        ));
                    };
                    if let Some(route) = route {
                        let declared = sidecar
                            .http
                            .as_ref()
                            .is_some_and(|h| h.routes.iter().any(|r| &r.path == route));
                        if !declared {
                            return Err(format!(
                                "plugin '{}': provided capability '{}' route '{}' is not declared on sidecar '{}'",
                                self.id, prov.capability, route, sc_name
                            ));
                        }
                    }
                }
                (None, Some(_)) => {
                    return Err(format!(
                        "plugin '{}': provided capability '{}' declares a route but no sidecar",
                        self.id, prov.capability
                    ));
                }
                (None, None) => {}
            }
        }
        Ok(())
    }
}

/// One declarative **MCP server** a plugin registers (see
/// [`PluginManifest::mcp_servers`]) — either a stdio command to spawn or a remote
/// HTTP endpoint to call.
///
/// This is the manifest-side, dependency-free mirror of Core's runtime
/// `McpServerConfig`: pure data (schemars/serde only) so it can live in
/// kernel-contracts, with Core lowering it into its registry type on enable. A
/// stdio server is spawned per request as `command args…`; `command_env` lets
/// the manifest name an env var Core resolves to an absolute binary path
/// (e.g. `RYU_GHOST_BIN`) so a downloaded `~/.ryu/bin` binary can override the
/// bare `command`. An HTTP server names a [`url`](McpServerDecl::url) instead and
/// spawns nothing at all.
///
/// The field names mirror the `mcp.json` dialect users already paste from Cursor
/// and Claude Desktop (`type` / `url` / `headers`) precisely so a manifest and a
/// hand-written config entry are the same shape. Static API-key auth may live in
/// [`headers`](McpServerDecl::headers). User-delegated OAuth is declared through
/// [`auth`](McpServerDecl::auth), and Core owns the resulting token lifecycle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct McpServerDecl {
    /// Executable to spawn (e.g. `npx`, an absolute path, or a `~/.ryu/bin` name).
    /// Absent for a remote (`url`) server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,

    /// Transport: `stdio`, `http`, `streamable-http`, or `sse`. Absent ⇒ inferred
    /// from whichever of `command`/`url` is present. `http` and `streamable-http`
    /// select Streamable HTTP; `sse` selects the legacy HTTP+SSE transport.
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,

    /// Endpoint URL for a remote (HTTP) server. Absent for a stdio server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,

    /// Request headers sent with every call to a remote server (auth lives here).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,

    /// Core-owned OAuth for this remote MCP server. The manifest may name only an
    /// optional public client id; discovery, PKCE, tokens and redirect URIs are
    /// intentionally outside the publisher-controlled manifest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<McpServerAuthDecl>,

    /// Optional env var whose value, when set, OVERRIDES [`command`] with an
    /// absolute binary path. Lets a plugin ship a bare `command` that Core repoints
    /// at a profile-specific downloaded binary. Absent ⇒ use `command` verbatim.
    ///
    /// [`command`]: McpServerDecl::command
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_env: Option<String>,

    /// Arguments passed to the command.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,

    /// Extra environment variables for the server process.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,

    /// Optional human description for the MCP listing endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// When false, the server is registered but skipped by list/call. Defaults to
    /// true so a bare `{ command }` entry just works.
    #[serde(default = "default_mcp_server_enabled")]
    pub enabled: bool,
}

const fn default_mcp_server_enabled() -> bool {
    true
}

impl Default for McpServerDecl {
    /// A blank stdio declaration with `enabled: true` — matching what serde
    /// produces for `{}`. Exists so a caller (or a test) can name only the fields
    /// it cares about now that the struct spans two transports; without it every
    /// stdio literal has to spell out three remote fields it will never use.
    fn default() -> Self {
        Self {
            command: None,
            transport: None,
            url: None,
            headers: BTreeMap::new(),
            auth: None,
            command_env: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            description: None,
            enabled: default_mcp_server_enabled(),
        }
    }
}

/// Authentication Ryu performs on behalf of the user for a remote MCP server.
///
/// `deny_unknown_fields` is a security boundary: a publisher cannot smuggle a
/// client secret, token endpoint, redirect URI, token or scope list into a signed
/// manifest and have an older Core silently ignore it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum McpServerAuthDecl {
    /// OAuth 2.1 authorization code with PKCE. `client_id`, when present, is a
    /// provider-issued public client id; confidential client secrets are never a
    /// manifest field.
    OAuth {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
    },
}

impl McpServerAuthDecl {
    /// Optional pre-registered public OAuth client id.
    pub fn client_id(&self) -> Option<&str> {
        match self {
            Self::OAuth { client_id } => client_id.as_deref(),
        }
    }
}

/// Companion surface descriptor — an optional in-desktop overlay or sidebar panel
/// an App may register. Fields mirror the UX primitives a Companion widget needs;
/// all are optional except `label`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CompanionSurface {
    /// Display label for the companion panel tab or tooltip.
    pub label: String,

    /// Icon identifier (resolved by the desktop shell).
    #[serde(default)]
    pub icon: Option<String>,

    /// Keyboard shortcut string (e.g. `"ctrl+shift+r"`).
    #[serde(default)]
    pub shortcut: Option<String>,
}

/// VS-Code-style **contribution points** (`contributes` in `package.json`).
///
/// The original five surfaces (`commands`/`tools`/`agents`/`workflows`/`policies`)
/// are lists of [`ContributionId`] references into the manifest's `runnables`: the
/// plugin *declares* that runnable `X` contributes to that surface. This is
/// declare-by-id, not a second copy of the runnable — the loader cross-validates
/// that every referenced id exists in `runnables`, so a typo is caught at load.
///
/// Most surfaces added since are **self-contained**: they carry their own payload
/// and reference no runnable at all (`widgets`, `views`, `dock_panels`,
/// `sidebar_sections`, `sidebar_buttons`, `settings_tabs`, `composer_controls`,
/// `chat_features`, `slash_commands`, `turn_hooks`, `tool_filters`, `lsp_servers`,
/// `message_actions`, `selection_actions`, `context_menu_items`,
/// `agent_edit_panels`).
///
/// # Extending
///
/// Adding a surface is two decisions, and getting either wrong is silent:
///
/// 1. **Id-reference or self-contained?** An id-reference surface is a
///    `Vec<ContributionId>` and MUST be chained into [`Contributes::referenced_ids`]
///    so the loader can catch a typo. A self-contained surface must be left OUT of
///    it — every id in it names something other than a runnable (a PATH binary, a
///    route, a tool namespace), so including it would reject every valid manifest.
///    `referenced_ids` therefore covers exactly the five original surfaces and
///    nothing else; that omission is deliberate, not an oversight to be tidied up.
/// 2. **Core-interpreted or client-rendered?** If Core acts on the payload
///    (`tool_filters`, `turn_hooks`, `widgets`, `lsp_servers`) it gets a fully typed
///    struct, because a key Core does not know is by construction a key Core cannot
///    act on. If a client shell renders it (`views`, `dock_panels`,
///    `sidebar_sections`, `settings_tabs`, `composer_controls`,
///    `agent_edit_panels`) it stays opaque
///    JSON, because deserializing into a struct here would DROP any key this Core
///    build does not know about and a newer desktop would lose exactly the fields it
///    was shipped to render.
///
/// Client-rendered surfaces are then served, tagged with the owning plugin id, from
/// `GET /api/plugins/contributions`. Core-interpreted ones deliberately are not —
/// they are gathered at their own consumption site instead.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct Contributes {
    /// Command-palette commands the plugin contributes (referenced by runnable id).
    #[serde(default)]
    pub commands: Vec<ContributionId>,

    /// Callable tools the plugin contributes (referenced by runnable id).
    #[serde(default)]
    pub tools: Vec<ContributionId>,

    /// Agents the plugin contributes (referenced by runnable id).
    #[serde(default)]
    pub agents: Vec<ContributionId>,

    /// Workflows the plugin contributes (referenced by runnable id).
    #[serde(default)]
    pub workflows: Vec<ContributionId>,

    /// Gateway policies the plugin contributes (referenced by runnable id).
    #[serde(default)]
    pub policies: Vec<ContributionId>,

    /// Hooks the plugin contributes — server-side logic that runs at a hook
    /// boundary and returns a directive. These are **self-contained** (they carry
    /// their own inline `code`), so they are NOT cross-validated against
    /// `runnables` like the id-reference surfaces above; the Core `plugin_host`
    /// runtime executes them in the sandbox.
    ///
    /// The field name is historical. It originally held only *chat* turn
    /// boundaries (`post_assistant_turn`, `pre_user_turn`); a hook's `on` is now
    /// any hook phase, including an **app event** another plugin declared in its
    /// [`Contributes::hook_events`] (`@example/meetings#meeting.ended`). It is
    /// deliberately NOT renamed: `turn_hooks` is load-bearing in every packaged
    /// manifest, the published JSON Schema, the SDK's TS mirror and the loader's
    /// invariant tests, and the rename would buy nothing but churn.
    #[serde(default)]
    pub turn_hooks: Vec<TurnHookContribution>,

    /// **App events this plugin emits** — the *provider* half of the hook system,
    /// and the mirror image of [`Contributes::turn_hooks`] (the *consumer* half).
    ///
    /// Core's own hook phases (`post_assistant_turn`, `pre_tool_use`, `context`, …)
    /// are a closed set built into `plugin_host`, so before this surface existed a
    /// plugin could only react to things happening *in a chat turn*. An app that
    /// owns a real-world lifecycle — a meeting ending, a workflow run failing, an
    /// alert firing — had no way to let anything else react to it. That forced the
    /// classic anti-pattern: every consumer polls the producer's HTTP routes, and
    /// every new integration is bespoke wiring between two apps that must both be
    /// changed.
    ///
    /// Declaring an event here makes it a first-class hook phase. Any other plugin
    /// consumes it by naming it in a `turn_hooks[].on`, and any workflow consumes it
    /// with an `event` trigger — neither the producer nor Core learns anything about
    /// the consumer. Apps therefore both **provide** and **consume** over one
    /// mechanism.
    ///
    /// # Ids are namespaced, and that is what makes collisions impossible
    ///
    /// Every id MUST be `<owning plugin id>#<event name>` — the owning half is
    /// checked against the manifest's own `id` at load, and the name half is
    /// `[a-z0-9][a-z0-9._-]*`. Because a Core phase name never contains `/`, an app
    /// literally cannot declare an event that shadows one, no reserved-word list
    /// required. It is also why the emit path can authorize purely from the
    /// manifest: the caller's authenticated plugin id must be the id in the event
    /// name, so an app can only ever emit its **own** events.
    ///
    /// # Core-interpreted, so a typed struct
    ///
    /// Core reads this table to authorize emits and to serve the event catalog, so
    /// per this type's own doc comment it gets a typed struct rather than opaque
    /// JSON. It names event strings rather than runnable ids, so it is
    /// **self-contained** and stays out of [`Contributes::referenced_ids`].
    #[serde(default)]
    pub hook_events: Vec<HookEventContribution>,

    /// Declarative **native** UI widgets the plugin contributes to the desktop
    /// composer. Core stores these verbatim and serves them via
    /// `GET /api/plugins/contributions` (tagged with the owning `plugin` id); the
    /// desktop renders the known control types. Opaque to Core (the renderer owns
    /// interpretation) so a new control type needs no Core change — an entry Core has
    /// never heard of is forwarded byte-for-byte, so a desktop newer than the node it
    /// talks to still gets everything it was shipped to render.
    ///
    /// # The control vocabulary
    ///
    /// Every entry is an object carrying `id`, a `type` discriminant, a `label` and a
    /// `flag`; the remaining keys belong to that type. `flag` is universal because the
    /// per-request `plugin_flags` map is the composer's ONLY channel to the turn — a
    /// control the turn hook cannot observe would do nothing. `type` is deliberately NOT
    /// an enum (same reasoning as [`ViewContribution::view`]): an unknown member must
    /// reach a newer shell intact rather than being rejected at load by an older Core.
    /// The vocabulary the desktop composer understands today:
    ///
    /// - `"toggle"` — a switch row in the composer "+" menu, with an optional
    ///   `description`. Flipping it puts `flag: true` into `plugin_flags`. This is the
    ///   original — and until now the ONLY — rendered type.
    /// - `"select"` — a menu/segmented picker. Carries an `options` array of
    ///   `{ value, label, description?, icon? }` plus an optional `default`. The chosen
    ///   `value` (a string, not a bool) lands in `plugin_flags[flag]`, so a plugin can
    ///   offer modes ("fast" / "thorough") instead of on/off.
    /// - `"chip"` — an inline pill in the composer bar showing a LIVE value rather than
    ///   a menu row. Carries an optional `icon` and a `source` (the same
    ///   `@ryu/app-host/views` `ViewSource` a declarative view uses) the shell polls for
    ///   the displayed text, and exposes/clears its value through `flag`. This is what a
    ///   rich bespoke control (a recording indicator, a selected-clip pill) needs in
    ///   order to stop being hand-written host code.
    /// - `"action"` — a button that DISPATCHES rather than holding state. Carries an
    ///   optional `icon` and a `capability` (+ optional `args`) the shell invokes
    ///   through the plugin's granted capability seam — never inline code, and never a
    ///   capability the owning plugin was not granted — then marks `flag` so the turn
    ///   hook sees that it fired.
    ///
    /// A control may also carry `placement` (`"menu"`, the default, or `"bar"`) and
    /// `order`; the renderer, not Core, decides what to do with an unknown key.
    ///
    /// Renderers MUST ignore an entry whose `type` they do not know (the desktop
    /// filters by `type`), so shipping a new control type degrades to "not shown on
    /// older shells" instead of breaking the composer.
    #[serde(default)]
    pub composer_controls: Vec<serde_json::Value>,

    /// Declarative chat feature descriptors. These are opaque, client-rendered
    /// declarations used to feature-detect chat behaviors whose implementation
    /// remains in the host (for example side chats or temporary chats). The
    /// owning plugin id is stamped by Core when the contribution endpoint serves
    /// them, so a disabled plugin removes both the descriptor and its UI affordance.
    #[serde(default)]
    pub chat_features: Vec<serde_json::Value>,

    /// Declarative settings tabs the plugin contributes (model pickers, text
    /// fields bound to preference keys). Served + rendered the same way.
    ///
    /// The **contract** for each entry is [`SettingsTabContribution`] — that is what
    /// the published JSON Schema advertises (`schemars(with = …)`) and what the
    /// loader holds every manifest to at import (see `validate_settings_tab`), so a
    /// malformed tab is rejected with a diagnostic instead of reaching the desktop
    /// and being silently dropped by the renderer's defensive parser.
    ///
    /// The *stored* type stays `serde_json::Value` on purpose. `GET
    /// /api/plugins/contributions` tags each entry in place with its owning `plugin`
    /// id and forwards it verbatim; deserializing into the struct here would silently
    /// DROP any key this Core build does not know about, so a desktop newer than the
    /// node it talks to would lose exactly the fields it was shipped to render. Parse
    /// once at the validation chokepoint, forward the original bytes.
    #[serde(default)]
    #[schemars(with = "Vec<SettingsTabContribution>")]
    pub settings_tabs: Vec<serde_json::Value>,

    /// Tools this plugin wants **hidden** from the model's offered tool list —
    /// the declarative half of a tool firewall (see [`ToolFilterContribution`]).
    ///
    /// Purely declarative here: this contract defines and validates the shape, and
    /// the filter is applied where tools are offered to the model. Like
    /// [`Contributes::turn_hooks`] this is self-contained (the ids name tools from
    /// *other* plugins/servers by design — hiding your own tool is just not
    /// declaring it), so it is NOT cross-validated against `runnables`.
    #[serde(default)]
    pub tool_filters: Vec<ToolFilterContribution>,

    /// Slash commands the plugin contributes (e.g. `/goal`). The desktop maps the
    /// command to a `plugin_flags`/message action; the plugin's turn hook reads
    /// the resulting message. Served + rendered the same way.
    #[serde(default)]
    pub slash_commands: Vec<serde_json::Value>,

    /// App widgets the plugin contributes (Ryu Apps). Each binds a tool id to a
    /// `ui://widget/<slug>.html` template the tool renders inline in chat. The
    /// field is shape-identical to the SDK `manifest.ts` `WidgetContribution`.
    #[serde(default)]
    pub widgets: Vec<WidgetContribution>,

    /// Metadata-only chat widget templates. Unlike [`Contributes::widgets`], this
    /// catalog is safe to show before a turn runs: it names a host-owned prompt
    /// affordance and a tool/view binding, never HTML, React, or capabilities.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_widget_templates: Option<Vec<ChatWidgetTemplateContribution>>,

    /// **Declarative views** the plugin contributes (the Raycast tier). Each entry
    /// is a [`ViewContribution`]: a typed envelope (`id`/`view`) around an **opaque**
    /// `spec` payload the host renderer interprets. The app returns DATA
    /// (`items`/`columns`/`actions`/`fields`) — never code — and the shell renders it
    /// with the host's own `@ryu/ui` components (desktop) or the compact command-bar
    /// idiom (island), so one spec renders natively on every surface and cannot be
    /// made ugly. Like [`composer_controls`]/[`settings_tabs`] this is **self-contained**
    /// (not cross-validated against `runnables`), and the `view` discriminant + `spec`
    /// stay opaque to Core so a new view kind needs no Core change — the renderer owns
    /// the vocabulary (`list-detail`, `data-table`, `form`, `action-panel`,
    /// `filter-bar`, `empty-state`, `stat-card-row`).
    ///
    /// [`composer_controls`]: Contributes::composer_controls
    /// [`settings_tabs`]: Contributes::settings_tabs
    #[serde(default)]
    pub views: Vec<ViewContribution>,

    /// App-registered sidebar **sections** — a header plus a live list of rows the
    /// shell fetches from a declared Core `/api/` path. Lets an app own its sidebar
    /// section (Canvas/Whiteboard/Meetings recent-doc lists) instead of the shell
    /// hardcoding it. Self-contained + opaque `spec` (see [`SidebarSectionContribution`]),
    /// so a new section capability needs no Core change; served + tagged with the
    /// owning `plugin` id at `GET /api/plugins/contributions`.
    #[serde(default)]
    pub sidebar_sections: Vec<SidebarSectionContribution>,

    /// App-registered sidebar **buttons** — a single nav row (e.g. Memory →
    /// `/library/memory`). The button-shaped sibling of [`Contributes::sidebar_sections`]
    /// (no live list, just a label/icon + a client route). See [`SidebarButtonContribution`].
    #[serde(default)]
    pub sidebar_buttons: Vec<SidebarButtonContribution>,

    /// App-registered sidebar **modes** — a named preset of the whole left sidebar:
    /// which sections it offers as tabs, and which one it opens on.
    ///
    /// The third axis of the sidebar contract, after "what sections exist"
    /// ([`Contributes::sidebar_sections`]) and "what nav rows exist"
    /// ([`Contributes::sidebar_buttons`]): **how the sidebar as a whole is
    /// arranged**. The shell ships three modes of its own (every section stacked;
    /// every section as a tab; Bot mode, which is the pair Sessions ⇄ Agents), and
    /// before this member an app could add a section to that list but could not
    /// propose an arrangement — so a plugin wanting the Grok/Hermes bot-mode posture
    /// had to ask for a shell change. See [`SidebarModeContribution`].
    ///
    /// Self-contained (it names sections, not runnables), so it stays out of
    /// [`Contributes::referenced_ids`]; served + tagged with the owning `plugin` id
    /// at `GET /api/plugins/contributions`.
    #[serde(default)]
    pub sidebar_modes: Vec<SidebarModeContribution>,

    /// **Colour themes** the plugin ships — the seam that makes a theme an ordinary
    /// marketplace item instead of a hardcoded entry in the shell's preset table.
    ///
    /// This is deliberately the VS Code / Zed shape: a theme is not its own catalog
    /// kind, it is a plugin that contributes one. That choice is load-bearing rather
    /// than cosmetic — it means a theme inherits install/uninstall/enable, versioning,
    /// signing, the Store detail page, reviews and the trust scorecard for free, and
    /// it means a plugin that ships a theme ALONGSIDE other contributions (an app with
    /// a matching skin) is expressible. A new `CatalogKind::Theme` would have bought a
    /// second, weaker copy of all of that.
    ///
    /// Each entry is a [`ThemeContribution`]: pure design tokens, no code. Themes are
    /// therefore the one contribution family that is safe with **zero** grants — the
    /// worst a hostile theme can do is look bad, because the shell only ever reads
    /// `tokens` into CSS custom properties and never evaluates them.
    ///
    /// Self-contained (it names no runnable), so it stays out of
    /// [`Contributes::referenced_ids`]. Typed rather than opaque JSON because Core
    /// does interpret it: the mode/token split is what lets a client ask for "the dark
    /// themes" without parsing every payload.
    #[serde(default)]
    pub themes: Vec<ThemeContribution>,

    /// **Output styles** the plugin ships — Markdown files that change *how* an agent
    /// answers (role, tone, default response shape) by editing the system prompt for
    /// the turn. See `docs/output-styles.md`.
    ///
    /// A style is NOT its own catalog kind, for exactly the argument
    /// [`Contributes::themes`] makes one field up: as a contribution it inherits
    /// install/uninstall/enable, versioning, signing, the Store detail page, reviews
    /// and the trust scorecard for free, and a plugin that ships a style ALONGSIDE
    /// other contributions (an app with a matching voice) stays expressible. A
    /// `CatalogKind::OutputStyle` would have been a second, weaker copy of all of
    /// that — and `CatalogKind::ALL` is a closed five-member enum that must stay
    /// that way, because every surface that switches on it exhaustively is a place a
    /// sixth member would have to be threaded by hand.
    ///
    /// # Safe with zero grants, unlike the other file-bearing family here
    ///
    /// The body is prose: nothing in the pipeline evaluates it, it only ever lands in
    /// a system prompt as text. So a style sits with themes on the safe side of the
    /// line — the worst a hostile one can do is make the agent tiresome — and
    /// pointedly NOT with [`Contributes::pi_extensions`], which is unsandboxed code
    /// and therefore tier-gated at the materializer.
    ///
    /// # Served on the contributions endpoint
    ///
    /// Unlike [`Contributes::pi_extensions`] and [`Contributes::lsp_servers`], which
    /// Core consumes at their own sites, this one IS served from
    /// `GET /api/plugins/contributions` — the desktop composer's style picker is a
    /// client-rendered surface and needs the declaration, not just its effect.
    ///
    /// Self-contained (it names no runnable), so it stays out of
    /// [`Contributes::referenced_ids`].
    ///
    /// ```json
    /// "output_styles": [
    ///   { "id": "eli5", "file": "output-styles/eli5.md" }
    /// ]
    /// ```
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub output_styles: Vec<OutputStyleContribution>,

    /// App-registered **marketplace tabs** — one section in the Store's nav bar,
    /// carrying the app's own installable catalog (workflow templates, meeting-notes
    /// templates, monitor presets, …). The Store-shaped sibling of
    /// [`Contributes::dock_panels`]: it lets an app own its browse-and-install
    /// surface instead of the shell welding the section into a closed `StoreSection`
    /// union. Self-contained + opaque `spec` (see [`StoreTabContribution`]).
    ///
    /// **Served OUTSIDE the enabled filter**, unlike every sibling family here: each
    /// entry is tagged with `plugin` plus `app_installed` / `app_enabled` and the
    /// renderer decides. Serving the declaration unconditionally keeps the door open
    /// for a surface that wants the tab as an acquisition funnel; the DATA behind it
    /// stays gated by the app's own route gate either way.
    ///
    /// The desktop Store deliberately renders only the tabs whose app is installed
    /// AND enabled. A pill present whether or not you own the app reads exactly like
    /// a section the shell hardcoded, and clicking it produced a "Turn on X" prompt
    /// where a catalog belongs. Apps are acquired from the Apps tab; the app's own
    /// sections appear with it.
    #[serde(default)]
    pub store_tabs: Vec<StoreTabContribution>,

    /// App-registered **workspace dock panels** — a tab in the desktop's bottom or
    /// right dock (Terminal / Code Review / Browser / Simulator live there today).
    /// This is the seam that lets an app OWN its dock tab instead of the shell
    /// welding the app into a closed `TabKind` union: `@ryu/browser` and
    /// `@ryu/simulator` are apps, and their tabs are contributions, not enum
    /// variants. Self-contained + opaque `spec` (see [`DockPanelContribution`]), so a
    /// new panel capability needs no Core change; served + tagged with the owning
    /// `plugin` id at `GET /api/plugins/contributions`.
    #[serde(default)]
    pub dock_panels: Vec<DockPanelContribution>,

    /// **Live activities** the plugin contributes — small, always-live status cards
    /// the desktop shell's "Dynamic Island" dock (empty-shell launchpad + sidebar)
    /// renders for something in progress: an agent run, a download, a pending
    /// approval, a recording. The desktop half of the same status vocabulary the
    /// mobile `AgentActivity` uses, so one mental model spans devices.
    ///
    /// Each entry is a [`LiveActivityContribution`]: a typed envelope (`id`/`title`/
    /// `icon`/`accent`/`order`) around an **opaque** `spec` payload the desktop
    /// renderer interprets. Like a [`Contributes::sidebar_sections`] entry it carries
    /// a `ViewSource` (a Core `/api/` path the shell polls) and a field-map; unlike a
    /// section it maps response ROWS to live-activity cards (status/progress/target)
    /// instead of nav rows. The app returns DATA — never code — so a live activity
    /// cannot be made ugly and needs zero sidecar code.
    ///
    /// Self-contained (it names no runnable), so it stays out of
    /// [`Contributes::referenced_ids`]; the `spec` stays opaque to Core so a new
    /// activity capability is a renderer change, not a Core change. Served + tagged
    /// with the owning `plugin` id at `GET /api/plugins/contributions`.
    #[serde(default)]
    pub live_activities: Vec<LiveActivityContribution>,

    /// Per-message actions the plugin contributes to the desktop message toolbar
    /// (thumbs, rate, transform, …). Lets an app own a control in the per-message
    /// toolbar instead of the shell welding the action into the closed set of
    /// built-in toolbar buttons. Self-contained + opaque `spec` (see
    /// [`MessageActionContribution`]), so a new action kind needs no Core change;
    /// served + tagged with the owning `plugin` id at
    /// `GET /api/plugins/contributions`. A renderer that does not know a `kind`
    /// ignores it, so an older shell degrades to "not shown" rather than breaking.
    ///
    /// **Stored raw, validated at the chokepoint** — same rule as
    /// [`Contributes::settings_tabs`]: the desktop forwards the original bytes, so
    /// a shell newer than this Core build still gets every field it was shipped to
    /// render.
    #[serde(default)]
    #[schemars(with = "Vec<MessageActionContribution>")]
    pub message_actions: Vec<serde_json::Value>,

    /// Buttons the plugin contributes to the floating text-selection toolbar.
    /// This is the bridge between enabled apps/plugins and shared chat blocks:
    /// Core validates and tags the declaration, while the desktop owns the
    /// rendered toolbar and dispatches the selected text. A selection action may
    /// either name a granted `capability` or provide a host-owned `args.dispatch`
    /// (for example, a first-party shell action such as Side Chat). Self-contained
    /// + opaque for the same forward-compatibility reason as `message_actions`.
    #[serde(default)]
    #[schemars(with = "Vec<SelectionActionContribution>")]
    pub selection_actions: Vec<serde_json::Value>,

    /// Context-menu rows the plugin contributes to a shell entity menu (the
    /// conversation-row dropdown, a message right-click, a space row). Lets an app
    /// own a menu row instead of the shell hardcoding it (e.g. "Make a skill from
    /// this chat" is a Learning contribution, not an `AppSidebar` if). See
    /// [`ContextMenuContribution`]; served + tagged with the owning `plugin` id at
    /// `GET /api/plugins/contributions`.
    ///
    /// **Stored raw, validated at the chokepoint** — same rule as
    /// [`Contributes::message_actions`].
    #[serde(default)]
    #[schemars(with = "Vec<ContextMenuContribution>")]
    pub context_menu_items: Vec<serde_json::Value>,

    /// "New X" rows the app contributes to the shell's create menu (the sidebar
    /// footer "+"). See [`CreateActionContribution`].
    ///
    /// This exists because the create menu's only app seam used to be
    /// `sidebar_sections[].spec.create` — section-scoped, so an app that
    /// contributes no sidebar section could not put a row there at all. The shell
    /// therefore hardcoded rows for apps it happened to know about, and those rows
    /// stayed in the menu when the app was not installed, leading straight to an
    /// error page. A create action is its own contribution precisely so the row
    /// appears and disappears with the app.
    ///
    /// **Stored raw, validated at the chokepoint** — same rule as
    /// [`Contributes::context_menu_items`].
    #[serde(default)]
    #[schemars(with = "Vec<CreateActionContribution>")]
    pub create_actions: Vec<serde_json::Value>,

    /// Client-rendered panels for the agent edit page. Entries are deliberately
    /// opaque and self-contained: the desktop owns the panel vocabulary, while
    /// Core only stores, tags, and forwards the declaration through the plugin
    /// contributions endpoint. This lets a newer desktop add an agent-edit
    /// panel type without requiring every Core node to learn that type first.
    /// These entries name no runnable ids and therefore are intentionally absent
    /// from [`Contributes::referenced_ids`].
    #[serde(default)]
    pub agent_edit_panels: Vec<serde_json::Value>,

    /// **Deletable data categories** the app owns — one "Delete all X" row in
    /// Settings → Danger Zone (see [`DataCategoryContribution`]).
    ///
    /// The danger zone used to be two hardcoded lists that had to be edited
    /// together: a `DataCategory` enum in Core and a `CATEGORIES` array carrying the
    /// user-facing copy in the closed desktop source. Monitors and Meetings are
    /// app-owned data, so both lists named apps — which meant a node where Monitors
    /// was never enabled still offered to delete monitors, and the count was always
    /// 0. Declaring the category here makes the owning app the single source of both
    /// its existence and its wording, and makes the row appear and disappear with
    /// the app instead of with a client-side feature-detect.
    ///
    /// # Core-interpreted, so a typed struct — and NOT on the contributions endpoint
    ///
    /// Core has to resolve the id to something that can actually count and delete
    /// the rows, so per this type's own doc comment this gets a typed struct rather
    /// than opaque JSON, and it is gathered at its consumption site
    /// (`GET /api/data/counts`, which serves each category's descriptor next to its
    /// live count) rather than at `GET /api/plugins/contributions` — the same
    /// disposition as [`Contributes::tool_filters`] and [`Contributes::lsp_servers`].
    ///
    /// # Declaration, not implementation
    ///
    /// A declared category is served only when Core knows how to clear it; an id
    /// Core does not implement is skipped with a warn rather than being offered as a
    /// button that 400s. That split is deliberate and not a stepping stone to a
    /// generic HTTP truncate: clearing monitors has to tear down each monitor's
    /// backing scheduler job, and clearing meetings has to broadcast on the meetings
    /// SSE stream, so a blind `DELETE /monitors` would leave jobs ticking forever.
    /// The manifest owns *whether the row exists and what it says*; Core owns *what
    /// deleting actually entails*.
    #[serde(default)]
    pub data_categories: Vec<DataCategoryContribution>,

    /// **Language servers** the plugin declares, keyed by server name — the
    /// agent-neutral mirror of Claude Code's `.lsp.json` / `lspServers`, so a config
    /// written for either host loads in the other:
    ///
    /// ```json
    /// "lsp_servers": {
    ///   "go": { "command": "gopls", "args": ["serve"], "extensionToLanguage": { ".go": "go" } }
    /// }
    /// ```
    ///
    /// Only the container key is Ryu's (`lsp_servers`, snake_case like every sibling
    /// here); every key INSIDE a server entry is Claude's own camelCase spelling
    /// verbatim, because that body is what actually travels between the two hosts.
    /// No `lspServers` alias is accepted on purpose. `lsp_servers` — this exact
    /// spelling — is registered in the SDK's zod mirror (`ContributesSchema` in
    /// `packages/sdk/src/manifest.ts`), and that mirror STRIPS every key it does not
    /// list. An alias would therefore parse here and be silently deleted at
    /// `ryu pack` time, before the manifest is signed, which is a worse failure than
    /// a key that never parsed at all. One spelling, registered in both places.
    ///
    /// The plugin ships CONFIG ONLY, never the server binary — `command` is resolved
    /// from `PATH` at spawn time and a missing binary is a visible skip, not a load
    /// error. Core spawns and supervises these processes itself, so unlike the
    /// client-rendered surfaces above this one is fully typed
    /// ([`LspServerContribution`]) and is NOT served from
    /// `GET /api/plugins/contributions`; it is gathered at the spawn site, the same
    /// disposition as [`Contributes::tool_filters`].
    ///
    /// # Ordering is part of the contract
    ///
    /// Registration is **first-registration-wins per file extension**: if two enabled
    /// servers both claim `.go`, the first one registered owns it, the others never
    /// start for that extension, and the spawn site warns naming the owner. That rule
    /// is only reproducible if iteration order is, so this is a [`BTreeMap`] — it
    /// iterates lexicographically by server key, never in hash order and never in
    /// JSON authoring order. The full resolved invariant across a node is
    /// **(plugin enable order, then server key ascending)**.
    ///
    /// Note this makes the tie-break deterministic, not byte-identical to Claude
    /// Code's, which falls out of JS object insertion order. Two servers fighting
    /// over one extension is a misconfiguration in either host; what matters is that
    /// the same node always resolves it the same way and says who won.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub lsp_servers: BTreeMap<String, LspServerContribution>,

    /// **Pi extensions** the plugin ships — TypeScript files the managed `ryu` (Pi)
    /// agent loads at process start:
    ///
    /// ```json
    /// "pi_extensions": [
    ///   { "id": "shell", "file": "pi-extensions/ryu-shell.ts",
    ///     "description": "background bash for the managed Pi agent" }
    /// ]
    /// ```
    ///
    /// Pi ships none of plan mode, sub-agents, permission prompts or background bash
    /// and says so deliberately in its own docs — "you can build or install those
    /// workflows as extensions or packages". This surface is that seam: the
    /// capabilities Core used to hardcode into the spawn path become plugins the user
    /// can enable and disable, and a third party can ship one at all.
    ///
    /// # This is UNSANDBOXED code, and the tier gate is not optional
    ///
    /// A [`Contributes::turn_hooks`] body runs in the deny-by-default Deno sandbox
    /// behind capability-gated `host.*` calls. A file named here runs **inside the Pi
    /// process** with full host privilege: the first-party ones spawn children and
    /// POST to Core. That is the same arbitrary-code-execution class as
    /// [`PluginManifest::mcp_servers`], so Core gates it identically — Core tier is
    /// auto-allowed, Community tier needs an operator-allowlisted grant, and the gate
    /// sits at the materializer, because writing the file is what makes it run.
    ///
    /// # Core-interpreted, so a typed struct — and NOT on the contributions endpoint
    ///
    /// Core resolves each `file` and projects it into the managed Pi's config dir, so
    /// per this type's own doc comment it gets a typed struct and is gathered at its
    /// consumption site (`pi_config::app_extensions`) rather than served from
    /// `GET /api/plugins/contributions` — the same disposition as
    /// [`Contributes::lsp_servers`].
    ///
    /// The `file` is deliberately NOT hydrated into an inline string the way a
    /// `code_file` is; see [`PluginManifest::pi_extension_refs`] for why.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pi_extensions: Vec<PiExtensionContribution>,
}

/// One **Pi extension** a plugin ships (a [`Contributes::pi_extensions`] row).
///
/// Carries a path, never a body: unlike [`TurnHookContribution`] there is no inline
/// `code` twin, because nothing downstream reads the source as a string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PiExtensionContribution {
    /// Stable id for this extension within the plugin (`[a-z0-9][a-z0-9._-]*`).
    ///
    /// Part of the materialized file name, so it is what makes one plugin's
    /// extensions distinguishable from another's on disk — and why it is validated
    /// with the same alphabet as an event name rather than left free-form.
    pub id: String,

    /// Path to the TypeScript source, relative to the plugin root — exactly
    /// `pi-extensions/<name>.ts`. See [`validate_pi_extension_path`].
    pub file: String,

    /// Optional human-facing one-liner (what the extension adds to the agent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One **output style** a plugin ships (a [`Contributes::output_styles`] row).
///
/// Carries the style's *body* in one of two forms and NOTHING else — no `name`, no
/// `description`, no `keep-coding-instructions`. Every one of those lives in the
/// file's own YAML frontmatter, which [`PluginManifest::hydrate_output_style_files`]
/// explains: mirroring them up here would create a second place a style's metadata
/// can be stated, and therefore a place it can disagree with itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct OutputStyleContribution {
    /// Stable id for this style within the plugin (`[a-z0-9][a-z0-9._-]*`).
    ///
    /// Validated with the same alphabet as a [`PiExtensionContribution::id`], and for
    /// a related reason: the registry merges plugin, user, project and managed styles
    /// into one id-keyed table where later entries win, and the persisted per-turn /
    /// per-conversation / node-default selection is this id. A free-form id would
    /// make a selection unresolvable the moment it contained something a settings key
    /// or a URL path could not carry.
    pub id: String,

    /// SOURCE form: path to the Markdown file, relative to the plugin root — exactly
    /// `output-styles/<name>.md`. See [`validate_output_style_path`].
    ///
    /// Exactly one of `file` / `source` is set. Authors write `file`;
    /// [`PluginManifest::hydrate_output_style_files`] turns it into `source` at parse
    /// time and clears this, so a hydrated manifest is byte-indistinguishable from
    /// one that was authored inline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,

    /// WIRE form: the file's contents **verbatim, frontmatter included**.
    ///
    /// Deliberately the whole file rather than a pre-split body, so that a style
    /// contributed by a plugin and a style sitting in a user's `output-styles/`
    /// directory are the same bytes and go through the same single parser. See
    /// [`PluginManifest::hydrate_output_style_files`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// One **declarative view** contribution (the Raycast tier — see [`Contributes::views`]).
///
/// A typed envelope around an opaque `spec`: Core stores it verbatim, tags it with
/// the owning `plugin` id at `GET /api/plugins/contributions`, and forwards it to the
/// surface shell, which maps `view` + `spec` to native components. The `spec` shape is
/// owned by the shared TS vocabulary (`@ryu/app-host/views`), NOT by this contract, so
/// adding a view kind is a renderer change, never a Core change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ViewContribution {
    /// Stable id for this view within the plugin (route/anchor key, unique per plugin).
    pub id: String,

    /// Optional human-facing title (tab label / palette entry). Absent = the shell
    /// derives one from the view kind or the plugin name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// The vocabulary member this view renders as — the discriminant the per-surface
    /// renderer switches on (`"list-detail"`, `"data-table"`, `"form"`,
    /// `"action-panel"`, `"filter-bar"`, `"empty-state"`, `"stat-card-row"`). Opaque
    /// to Core; an unknown kind is passed through so a newer shell can render it.
    pub view: String,

    /// The DATA payload for the view (items/columns/actions/fields/…). Opaque to Core
    /// — the shared renderer interprets it per the `view` kind. Absent = an empty view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<serde_json::Value>,
}

/// Which of the desktop shell's workspace docks a [`DockPanelContribution`] opens in.
///
/// Unlike the `panel` discriminant this is a CLOSED enum on purpose: the docks are
/// shell geometry, not app vocabulary — there are exactly two of them (the bottom
/// drawer and the right rail), and an app cannot conjure a third. Adding a dock is a
/// shell change, so it is correct for it to also be a contract change here.
///
/// Closed does NOT mean "fails the load", though: see
/// [`deserialize_dock_panel_placement`]. The set of valid values being fixed and the
/// blast radius of an unrecognised one are separate decisions, and the second answer
/// has to match every sibling vocabulary field in this file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DockPanelPlacement {
    /// The bottom drawer (Terminal / Code Review sit here).
    #[default]
    Bottom,
    /// The right rail (Files / Changes sit here).
    Right,
    /// Offered in BOTH docks — the user picks where to open it. This is what the
    /// Browser and Simulator tabs do today.
    Both,
}

impl DockPanelPlacement {
    /// The concrete docks this placement offers the panel in. `Both` fans out to the
    /// two real docks so a renderer never has to special-case the fan-out itself.
    pub fn docks(self) -> &'static [DockPanelPlacement] {
        match self {
            Self::Bottom => &[Self::Bottom],
            Self::Right => &[Self::Right],
            Self::Both => &[Self::Bottom, Self::Right],
        }
    }
}

/// Coerce a raw `placement` value to a known [`DockPanelPlacement`]: anything that is
/// not `"right"` or `"both"` — including a null, a number, or a dock name from a
/// future shell — resolves to [`DockPanelPlacement::Bottom`], the same value a missing
/// key gets.
///
/// Same reasoning as [`deserialize_settings_scope`], and it is what keeps the closed
/// enum honest. `placement` is closed because the docks are shell geometry, but that
/// only fixes the *set of valid values* — it says nothing about what an unrecognised
/// one should COST. Serde's derived enum deserializer makes it a hard parse error,
/// which takes the entire manifest down (every runnable, sidecar and tool the plugin
/// ships) over one cosmetic geometry hint. And the hazard is live by the enum's own
/// admission that "adding a dock is a shell change": the moment a newer shell grows a
/// third dock, every older Core would refuse to load an app that opts into it, rather
/// than merely opening its panel in the drawer. That would also contradict the sibling
/// `panel` field two lines away, whose whole point is that an unknown member must
/// reach a newer shell intact instead of being rejected at load by an older Core.
///
/// The verbatim string survives on the wire regardless — `GET
/// /api/plugins/contributions` re-serializes this struct, so a shell that understands
/// the newer dock reads it from a manifest its own Core parsed leniently.
fn deserialize_dock_panel_placement<'de, D>(deserializer: D) -> Result<DockPanelPlacement, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(deserializer)?;
    Ok(match raw.as_str() {
        Some("right") => DockPanelPlacement::Right,
        Some("both") => DockPanelPlacement::Both,
        _ => DockPanelPlacement::Bottom,
    })
}

/// One app-registered **workspace dock panel** — a tab in the desktop's bottom or
/// right dock (see [`Contributes::dock_panels`]).
///
/// The dock sibling of [`ViewContribution`] / [`SidebarSectionContribution`]: a typed
/// envelope (`id` / `title` / `icon` / `placement`) around an OPAQUE description of
/// what the tab renders. Core stores it verbatim, tags it with the owning `plugin` id
/// at `GET /api/plugins/contributions`, and never interprets `panel` or `spec` — so a
/// new panel capability is a renderer change, never a Core change.
///
/// # The `panel` vocabulary
///
/// `panel` is the render-mode discriminant the desktop's dock renderer switches on.
/// It is a plain `String` (not an enum) for the same reason [`ViewContribution::view`]
/// is: an unknown member must reach a newer shell intact rather than being rejected at
/// load by an older Core. The vocabulary the desktop understands today:
///
/// - `"companion"` — mount the app's sandboxed companion surface in the dock. The
///   `spec` names it: `{ "companion": "<runnable id>" }`. This is the third-party
///   path: an app ships one companion UI and can surface it in the dock, the sidebar,
///   or a full tab without any host code.
/// - `"view"` — render one of the plugin's own [`Contributes::views`] entries inside
///   the dock chrome: `{ "view": "<view id>" }`. Data-only, drawn with the host's own
///   `@ryu/ui` components, so a dock panel gets the Raycast tier for free.
/// - `"native"` — the shell's OWN component, registered under `<plugin>/<id>`. This is
///   the migration seam for first-party apps whose panel is hand-written React driving
///   their sidecar through the ext-proxy (`@ryu/browser`, `@ryu/simulator`): the
///   *component* stays in the shell, but its existence, label, icon and placement stop
///   being a hardcoded `TabKind` variant and become the app's own declaration, so
///   disabling the app removes the tab. An unknown `<plugin>/<id>` simply renders
///   nothing — a native panel is never a code channel.
///
/// The full `spec` shape is owned by the shared TS vocabulary (`@ryu/app-host/views`
/// `DockPanelSpec`), NOT by this contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DockPanelContribution {
    /// Stable id for this panel within the plugin (the dock's tab key, namespaced by
    /// the shell as `plugin:<pluginId>:<id>` so two apps can reuse an id).
    pub id: String,

    /// Tab label shown on the dock tab strip and in the "new tab" menu.
    pub title: String,

    /// Optional glyph id resolved by the shell's Icon primitive (Iconify/Hugeicons).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// Which dock the panel opens in. Defaults to [`DockPanelPlacement::Bottom`], the
    /// drawer a terminal-shaped panel belongs in — and falls back to it for an
    /// unrecognised dock too, rather than failing the whole manifest
    /// (see [`deserialize_dock_panel_placement`]).
    #[serde(default, deserialize_with = "deserialize_dock_panel_placement")]
    pub placement: DockPanelPlacement,

    /// Optional ordering hint within the dock's tab-type menu (lower = earlier).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,

    /// The render-mode discriminant (`"companion"`, `"view"`, `"native"`, …). Opaque
    /// to Core; an unknown member is passed through so a newer shell can render it.
    pub panel: String,

    /// The payload for the render mode (`{ "companion": … }` / `{ "view": … }` / any
    /// future panel capability). Opaque to Core — the desktop dock renderer interprets
    /// it per `panel`. Absent = the mode needs no payload (the `"native"` case).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<serde_json::Value>,
}

/// One **language server** a plugin declares (see [`Contributes::lsp_servers`]).
///
/// Field-for-field Claude Code's language-server config, camelCase on the wire, so
/// the same JSON body loads in either host. Required by Claude's spec: `command`
/// and `extensionToLanguage`. Everything else is optional and defaulted here to
/// Claude's documented default.
///
/// # Why `command` and `extensionToLanguage` are `#[serde(default)]` anyway
///
/// They are required by the SPEC, not by serde, and that is deliberate. Claude Code
/// **skips** a server whose config is invalid and starts the rest; making either
/// field a non-defaulted serde field would instead turn a missing one into a parse
/// error on the entire [`PluginManifest`], costing the plugin every runnable,
/// sidecar and tool it ships over one broken language-server entry. Defaulting them
/// is what makes the per-server skip reachable at all: the manifest parses, and
/// [`LspServerContribution::validate`] reports the reason at the spawn site.
///
/// Unknown keys are dropped rather than rejected (no `deny_unknown_fields`
/// anywhere in this file), so a field from a newer Claude release costs a plugin
/// nothing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LspServerContribution {
    /// The server executable, resolved from `PATH` at spawn time (`gopls`,
    /// `rust-analyzer`, `typescript-language-server`, …).
    ///
    /// The plugin ships the CONFIG, never the binary. A `command` that is not on
    /// `PATH` is a graceful skip with a visible reason — the user is told which
    /// server did not start and why, and the rest of the node is unaffected.
    /// Defaulted to `""` so a missing one is a skipped server, not a dead manifest
    /// (see the type doc).
    #[serde(default)]
    pub command: String,

    /// Arguments passed to [`command`](LspServerContribution::command)
    /// (e.g. `["serve"]` for `gopls`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,

    /// File extension → LSP language id (`{ ".go": "go" }`) — the map that decides
    /// which files this server handles, and the thing two servers can collide on.
    ///
    /// Claude Code authors keys with a leading dot and in lowercase; a hand-written
    /// manifest will not always. Compare through
    /// [`normalize_lsp_extension_key`] (or read
    /// [`normalized_extensions`](LspServerContribution::normalized_extensions))
    /// rather than indexing this map directly, so `go`, `.go` and `.GO` all resolve
    /// to the same entry. Empty ⇒ the server claims nothing and is skipped.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extension_to_language: BTreeMap<String, String>,

    /// How the host talks to the server: `"stdio"` (the default, and the only
    /// transport Core implements today) or `"socket"`.
    ///
    /// A plain `String` and not an enum, matching this file's other discriminants
    /// ([`ViewContribution::view`], [`DockPanelContribution::panel`]). The reason is
    /// sharper here than for those: [`DockPanelPlacement`] can afford to coerce an
    /// unrecognised value to its default because a panel opening in the wrong dock is
    /// cosmetic, whereas coercing an unrecognised transport to `stdio` would spawn a
    /// process and then speak a protocol it does not understand. The verbatim string
    /// survives instead, and the spawn site refuses what it cannot drive — see
    /// [`LspTransport`] and [`LspServerContribution::transport_kind`].
    #[serde(default = "default_lsp_transport")]
    pub transport: String,

    /// Extra environment variables for the server process, merged over the inherited
    /// environment.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,

    /// Sent verbatim as `initializationOptions` in the LSP `initialize` request.
    /// Opaque JSON on purpose: the shape is the individual language server's, and
    /// Ryu is a courier for it, not an interpreter. Absent = send none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initialization_options: Option<serde_json::Value>,

    /// Sent verbatim as the payload of `workspace/didChangeConfiguration` once the
    /// server is initialized. Opaque for the same reason as
    /// [`initialization_options`](LspServerContribution::initialization_options).
    /// Absent = send nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<serde_json::Value>,

    /// Root directory the server is rooted at. Absent (the common case) = the
    /// session's workspace root, which is why this is an `Option` rather than a
    /// defaulted `String`: "unset, inherit the workspace" and "explicitly rooted
    /// somewhere" are different instructions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_folder: Option<String>,

    /// Milliseconds to wait for `initialize` to come back before giving up on the
    /// server. Absent = the spawn site's own default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_timeout: Option<u64>,

    /// Milliseconds to wait for a clean `shutdown`/`exit` before killing the
    /// process. Absent = the spawn site's own default.
    ///
    /// That default is the one place this type knowingly parts company with Claude
    /// Code, whose reference says an unset `shutdownTimeout` means **no timeout
    /// applies** — it waits on a wedged server indefinitely. Ryu's spawn sites
    /// impose a finite one (5s in `assets/pi-extensions/ryu-lsp.ts`, documented at
    /// the constant), because Pi is spawned per session and an unbounded wait would
    /// hold every teardown open behind one unresponsive server. An explicitly
    /// declared value is honoured verbatim, so a config written for either host
    /// still behaves identically; only the *unset* case differs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shutdown_timeout: Option<u64>,

    /// Restart the server when it exits unexpectedly. Defaults to **true** (Claude
    /// Code parity).
    ///
    /// Note this needs an explicit default fn: a bare `#[serde(default)]` on a
    /// `bool` yields `false` and would silently invert the documented behaviour.
    /// Like [`McpServerDecl::enabled`] it carries no `skip_serializing_if`, so the
    /// value always ships and a reader never has to know the default.
    #[serde(default = "default_lsp_restart_on_crash")]
    pub restart_on_crash: bool,

    /// Cap on automatic restarts before the server is left down. Absent = the spawn
    /// site's own default; meaningless when
    /// [`restart_on_crash`](LspServerContribution::restart_on_crash) is false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_restarts: Option<u32>,

    /// Push this server's diagnostics into the model's context after edits. Defaults
    /// to **true** (Claude Code parity); same `default` caveat as
    /// [`restart_on_crash`](LspServerContribution::restart_on_crash).
    #[serde(default = "default_lsp_diagnostics")]
    pub diagnostics: bool,
}

fn default_lsp_transport() -> String {
    LspTransport::STDIO.to_owned()
}

const fn default_lsp_restart_on_crash() -> bool {
    true
}

const fn default_lsp_diagnostics() -> bool {
    true
}

/// The transports a [`LspServerContribution::transport`] string can resolve to.
///
/// A classification of the wire string, NOT the serialized form of it — the
/// manifest keeps the author's verbatim value (see the field doc). `Unsupported`
/// exists so the spawn site has a name for "parsed fine, cannot be driven", which
/// is the honest status of `"socket"` today: nothing in Claude Code's documented
/// field set carries a host or a port, so a socket server would validate and then
/// have nowhere to connect. Until that gap is resolved upstream, a socket server is
/// skipped with a visible reason — the same treatment as a `command` that is not on
/// `PATH`, and strictly better than a config that looks live and silently is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LspTransport {
    /// Spawn the server as a child process and speak LSP over its stdin/stdout.
    Stdio,
    /// Connect to an already-listening server over a socket. Parsed, not implemented.
    Socket,
    /// A transport this build does not know. Never guessed at.
    Unsupported,
}

impl LspTransport {
    /// The wire spelling of [`LspTransport::Stdio`], and the value a manifest that
    /// omits `transport` is given.
    pub const STDIO: &'static str = "stdio";

    /// The wire spelling of [`LspTransport::Socket`].
    pub const SOCKET: &'static str = "socket";
}

/// Normalise a file-extension key to the form used for server lookup: trimmed,
/// lowercased, with exactly one leading dot. `go`, `.go`, `.GO` and ` .Go ` all
/// become `.go`.
///
/// Claude Code writes `".go"`, but a hand-written manifest reasonably writes `"go"`,
/// and a file on disk is `main.GO` on a case-insensitive volume. Routing on the raw
/// key would make those three different languages.
///
/// Takes an EXTENSION, not a filename: `"main.go"` normalises to `".main.go"` and
/// matches nothing. A caller holding a path must split the extension off first.
pub fn normalize_lsp_extension_key(raw: &str) -> String {
    let trimmed = raw.trim().to_lowercase();
    if trimmed.is_empty() || trimmed.starts_with('.') {
        trimmed
    } else {
        format!(".{trimmed}")
    }
}

impl LspServerContribution {
    /// Can this server be started as declared? `Ok(())`, or a human-facing reason
    /// naming `server_name`.
    ///
    /// The two conditions are Claude Code's: an empty `command`, or an empty
    /// `extensionToLanguage`. A server that fails either is **skipped** — the other
    /// servers still start and it does NOT claim its extensions, so a sibling server
    /// declaring the same extension gets it.
    ///
    /// Deliberately NOT wired into [`Contributes::validate_settings_contributions`],
    /// even though [`validate_tool_filter`] is called from there and this looks like
    /// the same shape. The loader `?`s that function, so one `Err` skips the WHOLE
    /// manifest with a warning — the precise outcome Claude's "skip the server, start
    /// the others" rule exists to avoid. This stays a pure helper the spawn site
    /// calls per server, turning `Err` into a skip plus a visible warning.
    ///
    /// Transport support is a SEPARATE gate: a `"socket"` server is valid config and
    /// passes here, but cannot be driven today. The spawn site must check
    /// [`transport_kind`](LspServerContribution::transport_kind) as well.
    pub fn validate(&self, server_name: &str) -> Result<(), String> {
        if self.command.trim().is_empty() {
            return Err(format!(
                "lsp server '{server_name}' declares no 'command' and cannot be started"
            ));
        }
        if self.extension_to_language.is_empty() {
            return Err(format!(
                "lsp server '{server_name}' declares an empty 'extensionToLanguage' and would handle no files"
            ));
        }
        Ok(())
    }

    /// Classify [`transport`](LspServerContribution::transport). Absent/empty and any
    /// casing of `"stdio"` are [`LspTransport::Stdio`]; `"socket"` is
    /// [`LspTransport::Socket`]; anything else is [`LspTransport::Unsupported`] and
    /// is never guessed into a transport that would spawn a process.
    pub fn transport_kind(&self) -> LspTransport {
        let t = self.transport.trim().to_lowercase();
        match t.as_str() {
            "" | LspTransport::STDIO => LspTransport::Stdio,
            LspTransport::SOCKET => LspTransport::Socket,
            _ => LspTransport::Unsupported,
        }
    }

    /// This server's `extensionToLanguage` map with every key run through
    /// [`normalize_lsp_extension_key`] — the form an extension→server registry
    /// should index on.
    ///
    /// Two raw keys that normalise to the same extension (`"go"` and `".GO"`) keep
    /// the FIRST by the source map's ascending key order, mirroring the
    /// first-registration-wins rule that resolves the same collision between two
    /// servers.
    pub fn normalized_extensions(&self) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        for (ext, language) in &self.extension_to_language {
            let key = normalize_lsp_extension_key(ext);
            if key.is_empty() {
                continue;
            }
            out.entry(key).or_insert_with(|| language.clone());
        }
        out
    }

    /// The LSP language id this server declares for `extension`, comparing through
    /// [`normalize_lsp_extension_key`] on both sides so the author's spelling and the
    /// caller's need not match. Takes an extension, not a filename.
    pub fn language_for_extension(&self, extension: &str) -> Option<String> {
        let wanted = normalize_lsp_extension_key(extension);
        if wanted.is_empty() {
            return None;
        }
        self.extension_to_language
            .iter()
            .find(|(ext, _)| normalize_lsp_extension_key(ext) == wanted)
            .map(|(_, language)| language.clone())
    }
}

/// One app-registered **sidebar section** — a header plus a live list of rows the
/// desktop's compact sidebar renderer draws (the app-owned replacement for the
/// hardcoded Canvas/Whiteboard/Meetings sections). A typed envelope around an opaque
/// `spec` (the `SidebarSectionSpec` in `@ryu/app-host/views`: a `ViewSource` for the
/// rows, an `itemTarget` route template for `openTab`, optional `itemActions` and a
/// `create` action). Core stores it verbatim and tags it with the owning `plugin` id;
/// the `spec` stays opaque so a new section capability is a renderer change, not a
/// Core change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SidebarSectionContribution {
    /// Stable id for this section within the plugin (namespaced into the shell's
    /// section key as `plugin:<pluginId>:<id>`).
    pub id: String,

    /// Header label shown in the sidebar and the Customize dialog.
    pub title: String,

    /// Optional glyph id resolved by the shell's Icon primitive (Iconify/Hugeicons).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// Optional placement hint among the sidebar sections (lower = higher up).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,

    /// The opaque section spec (source/itemTarget/itemActions/create). Interpreted by
    /// the desktop renderer, never by Core. Absent = a header with no rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<serde_json::Value>,
}

/// One app-registered **live activity** — a small, always-live status card the
/// desktop's "Dynamic Island" dock (empty-shell launchpad + sidebar) renders for
/// something in progress: an agent run, a download, a pending approval, a
/// recording. The desktop half of the status vocabulary the mobile `AgentActivity`
/// uses (`running` / `waiting` / `review` / `done` / `error`), so one mental model
/// spans devices.
///
/// A typed envelope around an opaque `spec` (the `LiveActivitySpec` in
/// `@ryu/app-host/live-activity`: a `ViewSource` for the live rows, a field-map
/// from rows to card fields, and a `target` route template). Core stores it
/// verbatim and tags it with the owning `plugin` id; the `spec` stays opaque so a
/// new activity capability is a renderer change, not a Core change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LiveActivityContribution {
    /// Stable id for this activity within the plugin (namespaced into the shell's
    /// dock identity as `plugin:<pluginId>:<id>:<rowId>`).
    pub id: String,

    /// Human-facing title shown on the dock card (falls back to the row title).
    pub title: String,

    /// Optional glyph id resolved by the shell's Icon primitive (Iconify/Hugeicons).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// Optional accent colour hint (any CSS color) tinting the card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,

    /// Optional placement hint among the dock's activities (lower = first).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,

    /// The opaque activity spec (source/map/target). Interpreted by the desktop
    /// renderer, never by Core. Absent = a header-only activity (renders nothing).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<serde_json::Value>,
}

/// One app-registered **sidebar mode** — a named arrangement of the whole left
/// sidebar: the sections it offers as tabs, and the one it opens on.
///
/// The shape is deliberately thin, and every field it does NOT have is the point:
///
/// - **No renderer, no code.** A mode names existing sections. It cannot draw a row,
///   which is why it needs no grants and cannot be a carriage channel — the worst a
///   hostile mode can do is offer a tab list the user does not want, one menu row
///   away from being switched off.
/// - **No row style.** How a section's rows draw belongs to that SECTION
///   (`SidebarSectionSpec.rowStyle` in `@ryu/app-host/views`), because it is a
///   property of the feed, not of an arrangement: a roster of named bots wants
///   avatars whether or not the user is in a mode that features it. Putting it here
///   would also mean a mode reaching across into another contribution's rendering,
///   which is the coupling this member exists to avoid.
/// - **No `hidden` list.** A mode is a positive statement about what to show. The
///   sections it does not name are simply not tabs in it.
///
/// Section ids are the shell's own keys (`agents`, `chats`, `spaces`, …) or another
/// contributed section's namespaced key (`plugin:<pluginId>:<sectionId>`). A named
/// section that does not resolve is dropped rather than failing the mode — an app
/// may legitimately name a section from a sibling app the user has not installed,
/// and losing one tab is a better answer than losing the mode.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SidebarModeContribution {
    /// Stable id for this mode within the plugin (namespaced by the shell into the
    /// stored mode key as `plugin:<pluginId>:<id>`, so two apps can both ship a
    /// `bots` mode).
    pub id: String,

    /// Label shown in the sidebar's mode menu and the Appearance tab.
    pub title: String,

    /// Optional glyph id resolved by the shell's Icon primitive (Iconify/Hugeicons).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// Optional ordering hint among the modes on offer (lower = earlier).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,

    /// One-line description shown under the title where the mode is offered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// The sections this mode offers as tabs, in display order. Empty = the mode is
    /// inert and the shell ignores it; a mode with one entry is a legitimate
    /// single-surface arrangement, not an error.
    #[serde(default)]
    pub sections: Vec<String>,

    /// Which of `sections` the mode opens on. Absent (or naming a section not in
    /// `sections`) = the first one. This is the field that makes a mode an opinion
    /// rather than a filter: the shell's own Bot mode lists Sessions first but
    /// opens on Agents, because the roster is what the mode is for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_section: Option<String>,
}

/// One app-registered **marketplace tab** — a section in the Store's nav bar whose
/// content is the app's own installable catalog. A typed envelope around an opaque
/// `spec` (the `StoreTabSpec` in `@ryu/app-host/views`: a `ViewSource` for the rows,
/// a `groupBy`/`groups` split into card sections, an `install` action, and per-item
/// actions). Core stores it verbatim and tags it with the owning `plugin` id; the
/// `spec` stays opaque so a new catalog capability is a renderer change, not a Core
/// change.
///
/// **There is no first-party escape hatch.** This contribution used to carry a
/// `view` naming a hand-written renderer the shell kept in a plugin-id allowlist,
/// for the one tab whose detail pane the vocabulary could not express (the
/// workflow-template graph). That made the flagship example of "an app can own a
/// Store section" the single section no other app could reproduce. The graph is a
/// declarative primitive now (`spec.detail.graph`), the field is gone, and every
/// contributed tab — first-party or not — renders from the same spec.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StoreTabContribution {
    /// Stable id for this tab within the plugin. The shell namespaces it into the
    /// section key as `plugin:<pluginId>:<id>` so two apps can both ship a
    /// `templates` tab.
    pub id: String,

    /// Nav-pill label.
    pub title: String,

    /// One-line description shown under the title in the section header.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,

    /// Optional glyph id resolved by the shell's Icon primitive (Iconify/Hugeicons).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// Which nav cluster the pill joins — the shell draws a divider wherever the
    /// group changes. Built-in groups: `discover`, `catalog`, `community`, `manage`,
    /// `account`. An unknown value gets its own cluster rather than being dropped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,

    /// Placement hint within the group (lower = further left).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,

    /// The opaque tab spec (source/map/groups/search/install/itemActions). Interpreted
    /// by the desktop renderer, never by Core. Absent alongside an absent `view` = an
    /// empty tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<serde_json::Value>,
}

/// One app-registered **sidebar button** — a single nav row (the button-shaped
/// sibling of [`SidebarSectionContribution`]). No live list: just a label/icon and a
/// client route the shell opens with `openTab`. Migrates hardcoded header-chrome
/// buttons (e.g. Memory) to the owning app.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SidebarButtonContribution {
    /// Stable id for this button within the plugin.
    pub id: String,

    /// Button label.
    pub title: String,

    /// Optional glyph id resolved by the shell's Icon primitive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// The client route this button opens (e.g. `"/library/memory"`).
    pub target: String,

    /// Optional mount context passed to the owning Companion when the button opens it.
    /// The host applies this only to the button's own app surface.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<serde_json::Map<String, serde_json::Value>>,

    /// Optional placement hint among the sidebar buttons.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,
}

/// One colour theme a plugin contributes (`contributes.themes`).
///
/// Shape-identical to the shell's own `ThemeVariant` (`@ryu/ui/theme/presets`), so a
/// theme installed from the marketplace and a theme that ships in the binary are the
/// same object by the time the picker renders them — there is no second rendering
/// path to keep in sync, and a plugin can never express a theme the built-ins could
/// not.
///
/// # Why `tokens` is an untyped map
///
/// The keys are CSS custom properties (`--background`, `--sidebar-ring`, …). Typing
/// them as a fixed struct would mean every new token added to the design system
/// silently DROPS out of third-party themes until Core is rebuilt and redeployed —
/// exactly the drift `settings_tabs` documents for its own `serde_json::Value`. The
/// values are never evaluated, only assigned to CSS variables, so an unknown key is
/// inert rather than dangerous.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ThemeContribution {
    /// Stable id used as the persisted preset selection. Namespace it with the
    /// plugin id (e.g. `"@acme/themes:midnight"`) so two plugins cannot collide, and
    /// so a selection survives the theme being renamed.
    pub id: String,

    /// Human name shown in the theme picker.
    pub label: String,

    /// Which mode slot this theme fills: `"light"` or `"dark"`. A plugin shipping a
    /// pair contributes two entries, mirroring how the shell keeps an independent
    /// preset per mode rather than one theme with two halves.
    pub mode: String,

    /// The four swatch colours the picker paints before the theme is applied.
    pub preview: ThemePreview,

    /// CSS custom property name → value (e.g. `"--background"` → `"oklch(1 0 0)"`).
    pub tokens: std::collections::BTreeMap<String, String>,
}

/// The swatch a theme shows in the picker, without applying the theme.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ThemePreview {
    pub bg: String,
    pub surface: String,
    pub primary: String,
    pub text: String,
}

/// One app-widget contribution (Ryu Apps). Binds the tool that renders the widget
/// to its HTML template. `ui_entry` is the source entry the SDK `ryu pack` builds
/// into the self-contained HTML for third-party apps; built-in apps serve HTML
/// from the in-process provider and leave it unset.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WidgetContribution {
    /// The fully-qualified tool id whose result renders this widget.
    pub tool_id: String,
    /// `ui://widget/<slug>.html` — the widget resource uri.
    pub uri: String,
    /// Source entry (e.g. `src/apps/checklist/index.tsx`) for `ryu pack`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_entry: Option<String>,
    /// Widget MIME dialect (default `text/html+skybridge`).
    #[serde(default = "default_widget_mime")]
    pub mime: String,
    /// Default display mode (`inline` | `fullscreen` | `pip`).
    #[serde(default = "default_widget_display_mode")]
    pub default_display_mode: String,
}

/// A metadata-only entry the host may offer as a compact chat affordance.
///
/// `backing` selects exactly one existing tool or view by id. The host owns the
/// eventual rendering and action dispatch; `safe_action_ids` are identifiers only
/// and are never executable payloads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ChatWidgetTemplateContribution {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub triggers: Vec<String>,
    #[serde(default)]
    pub examples: Vec<String>,
    pub backing: ChatWidgetTemplateBacking,
    /// Open vocabulary so newer shells can add display modes without breaking
    /// older Core nodes; the desktop simply ignores modes it does not know.
    pub display_mode: String,
    #[serde(default)]
    pub safe_action_ids: Vec<String>,
    /// `available`, `coming-soon`, or `unavailable`; unknown values are forwarded
    /// for forward compatibility and are not offered by older shells.
    #[serde(default = "default_chat_widget_availability")]
    pub availability: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct ChatWidgetTemplateBacking {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_id: Option<String>,
}

fn default_chat_widget_availability() -> String {
    "available".to_owned()
}

fn valid_chat_widget_id(id: &str) -> bool {
    id.chars()
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-' | ':')
        })
}

fn valid_chat_widget_tool_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && !id.contains("..")
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/'))
}

/// Validate the metadata catalog while keeping its display vocabulary open for
/// newer hosts. A template is only executable-looking when it has exactly one
/// safe, namespaced binding and a valid stable id.
pub fn validate_chat_widget_templates(
    templates: &[ChatWidgetTemplateContribution],
) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    for template in templates {
        if !valid_chat_widget_id(&template.id) {
            return Err(format!(
                "chat widget template '{}' has invalid id",
                template.id
            ));
        }
        if !seen.insert(template.id.as_str()) {
            return Err(format!(
                "duplicate chat widget template id '{}'",
                template.id
            ));
        }
        if template.title.trim().is_empty() || template.display_mode.trim().is_empty() {
            return Err(format!(
                "chat widget template '{}' needs title and display_mode",
                template.id
            ));
        }
        for action_id in &template.safe_action_ids {
            if !valid_chat_widget_id(action_id) {
                return Err(format!(
                    "chat widget template '{}' has invalid safe action id '{}'",
                    template.id, action_id
                ));
            }
        }
        let has_tool = template
            .backing
            .tool_id
            .as_deref()
            .is_some_and(|id| valid_chat_widget_tool_id(id));
        let has_view = template
            .backing
            .view_id
            .as_deref()
            .is_some_and(|id| valid_chat_widget_id(id));
        if has_tool == has_view {
            let unavailable_without_binding = template.availability != "available"
                && template.backing.tool_id.is_none()
                && template.backing.view_id.is_none();
            if !unavailable_without_binding {
                return Err(format!("chat widget template '{}' must declare exactly one valid backing tool_id or view_id", template.id));
            }
        }
    }
    Ok(())
}

fn default_widget_mime() -> String {
    "text/html+skybridge".to_owned()
}

fn default_widget_display_mode() -> String {
    "inline".to_owned()
}

/// A server-side chat turn hook contributed by a plugin. The `code` is a JS body
/// run in the plugin sandbox with `ctx` (the turn context) and `host` (the
/// capability bridge: `host.sideModel`, `host.storage`, `host.log`) in scope; it
/// returns a directive (`{kind:"none"}` | `{kind:"note",text}` |
/// `{kind:"continue",text}`). See Core's `plugin_host`.
///
/// The body is authored as a **file** ([`code_file`]) and hydrated into [`code`]
/// at parse time — see [`PluginManifest::hydrate_code_files`] for why the two
/// fields are a source-form/wire-form pair rather than alternatives.
///
/// [`code`]: Self::code
/// [`code_file`]: Self::code_file
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TurnHookContribution {
    /// Stable id for this hook (for logging/audit), unique within the plugin.
    pub id: String,
    /// The turn boundary this hook fires on. Today only `"post_assistant_turn"`.
    pub on: String,
    /// Higher-priority hooks run first within a phase. Ties are resolved by
    /// plugin id and hook id, which makes first-writer-wins directives stable.
    #[serde(default)]
    pub priority: i32,
    /// The JS hook body executed in the sandbox (returns a directive).
    ///
    /// Empty in a **source** manifest that declares [`Self::code_file`] instead;
    /// [`PluginManifest::hydrate_code_files`] fills it in before any consumer sees
    /// the manifest, and [`PluginManifest::validate`] refuses a manifest where it
    /// is still empty. Every read site therefore keeps reading exactly this field.
    #[serde(default)]
    pub code: String,
    /// Path to the file holding the hook body, relative to the plugin root
    /// (`hooks/<name>.js`) — the authoring form. Mutually exclusive with
    /// [`Self::code`]; see [`PluginManifest::hydrate_code_files`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_file: Option<String>,
    /// Optional cheap pre-gate. When present, Core's `plugin_host` evaluates it
    /// in Rust **before** spawning the sandbox, so an idle hook (e.g. double-check
    /// with its toggle off, or goal with no active condition) costs a flag/prefix
    /// check or one KV read instead of a Deno process. This is what makes it safe
    /// to ship these hooks **enabled by default** on every surface. Absent (or all
    /// fields empty) → the hook always runs, preserving prior behaviour.
    #[serde(default, rename = "match")]
    pub run_when: Option<HookMatch>,
}

/// A declarative pre-gate for a [`TurnHookContribution`]. The conditions are
/// OR-ed: the hook runs if **any** present condition matches. An empty match
/// (every field default) means "always run". Kept intentionally small — richer
/// matching belongs inside the hook JS, this only exists to skip the sandbox
/// spawn on turns where the hook provably cannot act.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct HookMatch {
    /// Run only if the request set this composer flag true (`ctx.flags[flag]`),
    /// e.g. `"io.ryu.double-check"`.
    #[serde(default)]
    pub flag: Option<String>,
    /// Run if the last user message (trimmed) starts with any of these prefixes,
    /// e.g. `["/goal"]`. This is how a slash-command hook wakes up.
    #[serde(default)]
    pub commands: Vec<String>,
    /// Run if the plugin has stored state for this conversation (its default KV
    /// namespace has a value keyed by `conversation_id`), e.g. an active goal.
    #[serde(default)]
    pub stateful: bool,
    /// Run if the tool being called (`ctx.tool_name`) matches any of these
    /// patterns — for `pre_tool_use` / `post_tool_use` hooks. A pattern is a tool
    /// id with optional leading/trailing `*` wildcards (`"*"` = every tool,
    /// `"bash*"` = ids starting with `bash`). This keeps a tool-firewall hook from
    /// spawning the sandbox on every unrelated tool call.
    #[serde(default)]
    pub tools: Vec<String>,
}

/// One **app event** a plugin declares it emits (a [`Contributes::hook_events`]
/// row). This is a *declaration*, not code: the event is raised at runtime by the
/// plugin's own sidecar calling the `events.emit` kernel capability, and Core
/// checks the emit against this table.
///
/// The payload the emitter sends is delivered to every consumer as `ctx.event`, so
/// [`Self::payload_example`] is the contract a consumer author reads. Keep it
/// honest — it is the only description of the payload anyone gets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HookEventContribution {
    /// The fully-qualified event id: `<owning plugin id>#<event name>`, e.g.
    /// `@example/meetings#meeting.ended`. Validated at load against the owning
    /// manifest's `id`; see [`Contributes::hook_events`] for why the namespace is
    /// mandatory rather than conventional.
    ///
    /// Name the event after **what happened**, in the past tense, never after who
    /// should react to it: a consumer that renames the producer's event to suit
    /// itself is exactly the coupling this surface removes. The house patterns are
    /// `x.started` / `x.ended` / `x.failed` for a lifecycle, `x.ready` for a
    /// produced artifact, and `x.created` / `x.updated` / `x.deleted` for state.
    pub id: String,
    /// Human-readable title for the event picker (workflow trigger UI, docs).
    pub title: String,
    /// What the event means and, critically, *when* it fires — including whether it
    /// can fire more than once for the same subject.
    #[serde(default)]
    pub description: Option<String>,
    /// An example of the payload delivered as `ctx.event`. Documentation, not a
    /// schema: Core forwards whatever the emitter sends verbatim and validates
    /// nothing beyond the size cap, so this exists for the human writing a consumer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_example: Option<serde_json::Value>,
}

/// The separator between the owning plugin id and the event name in a
/// [`HookEventContribution::id`].
///
/// `#` and not `/`, because a **scoped plugin id contains a slash**
/// (`@ryu/meetings`) — a `/` separator would make `@ryu/meetings/meeting.ended`
/// ambiguous between "scope `@ryu`, plugin `meetings`" and any other split. `#` also
/// cannot appear in an id at all (see [`validate_plugin_id`]), and no Core hook phase
/// name contains it (they are bare `[a-z_]+` words), so the two namespaces still
/// cannot collide — which is the property this separator exists to guarantee.
///
/// Safe in every context an event id actually travels through: manifest JSON, the
/// workflow `event` trigger field, and the picker. Event ids never appear in a URL
/// path or query, where `#` would truncate.
pub const HOOK_EVENT_SEPARATOR: char = '#';

/// Split a fully-qualified app-event id into `(owning plugin id, event name)`, or
/// `None` when it is not app-event shaped (i.e. it is a Core phase name).
///
/// The owner half may itself contain a `/` (a scoped id like `@ryu/meetings`); only
/// the [`HOOK_EVENT_SEPARATOR`] delimits owner from event name.
///
/// The one place the namespace rule is implemented. Load-time validation, the emit
/// authorization check and the consumer catalog all route through it, so they cannot
/// drift into three subtly different parsers.
#[must_use]
pub fn split_hook_event_id(id: &str) -> Option<(&str, &str)> {
    let (owner, name) = id.split_once(HOOK_EVENT_SEPARATOR)?;
    if owner.is_empty() || name.is_empty() || name.contains(HOOK_EVENT_SEPARATOR) {
        return None;
    }
    Some((owner, name))
}

/// Whether `on` names an **app event** rather than one of Core's built-in hook
/// phases. Purely structural: app events are namespaced, Core phases are bare words.
#[must_use]
pub fn is_app_event(on: &str) -> bool {
    split_hook_event_id(on).is_some()
}

/// Validate one [`HookEventContribution`] against the manifest that declares it.
/// Returns a diagnostic string on rejection.
///
/// Fail-closed at load rather than at emit: a malformed id would otherwise become an
/// event that can be declared and consumed but never successfully emitted — a
/// silently dead subscription, which is the worst failure mode this surface has.
///
/// # Errors
/// Returns `Err` when the id is not `<plugin_id>/<name>` shaped, is namespaced to a
/// different plugin, or the name half is not `[a-z0-9][a-z0-9._-]*`.
pub fn validate_hook_event(event: &HookEventContribution, plugin_id: &str) -> Result<(), String> {
    let Some((owner, name)) = split_hook_event_id(&event.id) else {
        return Err(format!(
            "hook_events[{}]: id must be `<plugin id>#<event name>` (e.g. `{plugin_id}#thing.ended`)",
            event.id
        ));
    };
    if owner != plugin_id {
        return Err(format!(
            "hook_events[{}]: namespaced to `{owner}` but declared by `{plugin_id}` — a plugin may only declare events in its own namespace",
            event.id
        ));
    }
    let valid_name = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'));
    if !valid_name {
        return Err(format!(
            "hook_events[{}]: event name `{name}` must match [a-z0-9][a-z0-9._-]*",
            event.id
        ));
    }
    if event.title.trim().is_empty() {
        return Err(format!(
            "hook_events[{}]: title must not be empty",
            event.id
        ));
    }
    Ok(())
}

/// Which settings dialog a [`SettingsTabContribution`] belongs in.
///
/// The two dialogs are not cosmetic: a `node` preference is stored on the node and
/// is therefore shared by **every** user of that node, while a `user` preference is
/// client-local. Defaulting to `node` preserves the historical behaviour (tabs
/// always wrote node-scoped preferences through the active node); a plugin that
/// wants a per-user knob has to say so.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SettingsScope {
    /// Affects the whole node/gateway — shared by every user on it. The default.
    #[default]
    Node,
    /// Per-user / client-local, like appearance. Rendered in App Settings.
    User,
}

/// Coerce a raw `scope` value to a known [`SettingsScope`]: anything that is not
/// the literal string `"user"` — including a null, a number, or a scope name from a
/// future Core — resolves to [`SettingsScope::Node`].
///
/// This mirrors the desktop's `parseScope` byte for byte, and deliberately does NOT
/// use serde's derived enum deserializer: that would make an unrecognised scope a
/// hard parse error and take the *entire manifest* down (every runnable, sidecar and
/// tool the plugin ships) over one cosmetic routing hint. Falling back to the
/// safer-to-render dialog keeps the plugin working.
fn deserialize_settings_scope<'de, D>(deserializer: D) -> Result<SettingsScope, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(deserializer)?;
    Ok(if raw.as_str() == Some("user") {
        SettingsScope::User
    } else {
        SettingsScope::Node
    })
}

/// The control one [`SettingsFieldContribution`] renders as.
///
/// This list is the desktop renderer's `FieldControl` switch, transcribed: every
/// variant here has a real control behind it, and there is nothing the renderer
/// handles that is missing. Adding a variant means teaching the renderer first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SettingsFieldType {
    /// Single-line text input. The default for a field that omits `type`.
    #[default]
    Text,
    /// Multi-line text input.
    Textarea,
    /// Numeric input (still persisted as a bare string, like every preference).
    Number,
    /// On/off switch, persisted as `"true"`/`"false"`.
    Toggle,
    /// Dropdown over the field's declared `options` (which are then REQUIRED).
    Select,
    /// The composer's provider/model picker, so "which model runs this" is a
    /// catalog pick rather than a typo-prone free-text string. Persists a bare
    /// model id.
    ModelPicker,
    /// The composer's FULL target picker — agent, provider, model, thinking
    /// level, reasoning effort, and ACP access mode — persisted as one
    /// `AgentSelection` JSON object.
    ///
    /// Prefer this over [`ModelPicker`](Self::ModelPicker) when the plugin can
    /// be served by an *agent* and not only a raw model call; a field left
    /// unset inherits the node-wide default selection either way, since the
    /// resolver reads both forms from the same key.
    AgentPicker,
    /// A **write-only masked** credential input — the BYOK control.
    ///
    /// Unlike every other variant, this one does NOT persist to preferences. The
    /// value is submitted to `PUT /api/plugins/{id}/secrets/{key}` and stored
    /// **encrypted at rest** in the per-plugin secret store, keyed by
    /// `(plugin_id, pref_key)`. It is never read back: the renderer can ask
    /// whether a secret is set (`GET /api/plugins/{id}/secrets` returns names and
    /// timestamps, never values) and shows "Set" or "Not set" beside an empty
    /// input. Submitting a blank value CLEARS the secret.
    ///
    /// The stored value is what a manifest's `secret_headers` `env:VARNAME` token
    /// falls back to when the process environment has no such var, so `pref_key`
    /// must be the ENV VAR NAME the manifest already names (e.g.
    /// `RYU_TAVILY_API_KEY`), not a preference-style dotted key. Process env still
    /// wins when both are set, and the same namespace gate that restricts which
    /// vars a plugin may read applies to the stored value.
    Secret,
}

/// Coerce a raw field `type` to a known [`SettingsFieldType`], falling back to
/// [`SettingsFieldType::Text`] for anything unrecognised.
///
/// Same reasoning as [`deserialize_settings_scope`], plus one more: the renderer's
/// `default:` branch *already* draws an unknown type as a text input, so a plugin
/// that declares a control a newer desktop understands still renders usefully on an
/// older one. Rejecting the manifest instead would make the plugin unusable rather
/// than merely plain-looking. The verbatim string survives on the wire regardless —
/// [`Contributes::settings_tabs`] forwards the original JSON, not this struct.
fn deserialize_settings_field_type<'de, D>(deserializer: D) -> Result<SettingsFieldType, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = serde_json::Value::deserialize(deserializer)?;
    Ok(match raw.as_str() {
        Some("textarea") => SettingsFieldType::Textarea,
        Some("number") => SettingsFieldType::Number,
        Some("toggle") => SettingsFieldType::Toggle,
        Some("select") => SettingsFieldType::Select,
        Some("model_picker") => SettingsFieldType::ModelPicker,
        Some("agent_picker") => SettingsFieldType::AgentPicker,
        // NOTE the asymmetry with every arm above: an older desktop that does not
        // know `secret` falls back to a plain TEXT input, which would persist the
        // typed credential to preferences in the clear. That is a renderer
        // obligation, not a parser one — the fallback here only decides what this
        // Core believes the field is, and Core reads `Secret` to route the write to
        // the encrypted store instead of the preference KV.
        Some("secret") => SettingsFieldType::Secret,
        _ => SettingsFieldType::Text,
    })
}

/// One selectable option for a [`SettingsFieldType::Select`] field.
///
/// Accepts both spellings the desktop's `parseOptions` accepts: a bare string
/// (value and label are the same) or an object with an explicit `label`. Keeping
/// both is not indulgence — the bare-string form is what every hand-written
/// manifest reaches for, and rejecting it would push authors into boilerplate for
/// the common case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum SettingsFieldOption {
    /// `"fast"` — the stored value doubles as the label.
    Value(String),
    /// `{ "value": "fast", "label": "Fast" }`.
    Labeled {
        /// The value persisted to the preference key.
        value: String,
        /// Display label. Absent = show the raw `value`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
}

impl SettingsFieldOption {
    /// The value this option persists.
    pub fn value(&self) -> &str {
        match self {
            Self::Value(value) | Self::Labeled { value, .. } => value,
        }
    }

    /// The label this option displays (the value itself when none was given).
    pub fn label(&self) -> &str {
        match self {
            Self::Value(value) => value,
            Self::Labeled { value, label } => label.as_deref().unwrap_or(value),
        }
    }
}

/// One configurable field inside a [`SettingsTabContribution`], bound to exactly
/// one preference key.
///
/// `pref_key` is both the storage binding (`GET/PUT /api/preferences/:key`) **and**
/// the field's identity — the renderer keys its React elements by it — so two
/// fields sharing one `pref_key` inside a tab is a bug, not a shorthand, and the
/// loader rejects it.
///
/// The `default`/`required`/`min`/`max`/`min_length`/`max_length` block is
/// validation metadata: declaring it is how a plugin gets its settings checked at
/// *import* instead of discovering at runtime that a user typed `"maybe"` into what
/// the hook reads as a number. It is cross-checked against `type` at load, because
/// validation metadata that is silently ignored (a `min` on a toggle) is worse than
/// none — it reads as a guarantee that was never enforced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SettingsFieldContribution {
    /// The control to render. Absent or unrecognised = a plain text input.
    #[serde(
        default,
        rename = "type",
        deserialize_with = "deserialize_settings_field_type"
    )]
    pub field_type: SettingsFieldType,

    /// The preference key this field reads/writes. Required, non-empty, and
    /// restricted to a path-safe alphabet (it becomes a URL path segment).
    #[serde(alias = "prefKey")]
    pub pref_key: String,

    /// Display label. Absent = the renderer shows the `pref_key`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,

    /// Helper caption shown under the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Placeholder for text / model-picker inputs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,

    /// Choices for a [`SettingsFieldType::Select`]; required for that type and
    /// inert for every other one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<SettingsFieldOption>,

    /// Default value, in the field's own JSON type (bool for a toggle, number for
    /// a number, string elsewhere) — NOT the stringified form preferences are
    /// stored in, so a manifest stays readable and the type is checkable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,

    /// Whether the user must supply a value (advisory: enforced by the renderer,
    /// declared here so the contract is one place).
    #[serde(default)]
    pub required: bool,

    /// Inclusive lower bound for a [`SettingsFieldType::Number`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,

    /// Inclusive upper bound for a [`SettingsFieldType::Number`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,

    /// Granularity for a [`SettingsFieldType::Number`] — the increment its stepper
    /// moves by, and the grid a typed value must land on.
    ///
    /// Distinct from [`Self::min`]/[`Self::max`], which bound the range: a value can
    /// sit inside the range and still be meaningless at this field's resolution
    /// (`0.5` where the setting counts whole pages). The renderer enforces it, so a
    /// field that declares it rejects an off-grid value rather than persisting one
    /// the plugin cannot use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<f64>,

    /// Minimum length for a text/textarea value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_length: Option<u64>,

    /// Maximum length for a text/textarea value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u64>,
}

/// One **settings tab** a plugin contributes (see [`Contributes::settings_tabs`]).
///
/// A tab is EITHER declarative (`fields`, rendered by the shared plugin-settings
/// renderer against Core's preference store) OR a named `view` the shell resolves to
/// a bespoke component — for an app whose settings genuinely cannot be expressed as
/// a list of fields. A tab with neither renders as an empty section, which the
/// desktop's defensive parser drops on the floor; the loader rejects it instead so
/// the author gets told.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SettingsTabContribution {
    /// Stable id for this tab within the plugin — the settings nav routes to it and
    /// the renderer keys by it. Required: the desktop's fallback (`<plugin>.settings`)
    /// collides the moment a plugin declares a second tab.
    pub id: String,

    /// Header label for the section. Absent = `"Settings"`, matching the renderer.
    #[serde(default = "default_settings_tab_title")]
    pub title: String,

    /// Which settings dialog this tab lands in. Absent/unrecognised = `node`.
    #[serde(default, deserialize_with = "deserialize_settings_scope")]
    pub scope: SettingsScope,

    /// A rich settings view this app ships instead of declarative `fields`. Opaque
    /// here — the settings renderer owns the vocabulary and resolves the name to a
    /// component (first-party) or a sandboxed UI (third-party).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,

    /// The declarative fields this tab renders. Empty is only legal alongside a
    /// `view`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<SettingsFieldContribution>,
}

fn default_settings_tab_title() -> String {
    "Settings".to_owned()
}

/// One **tool filter**: a fully-qualified tool id a plugin wants withheld from the
/// model's offered tool list.
///
/// Tools are namespaced `<server>.<tool>` (e.g. `browser.navigate`), so `tool`
/// must carry the namespace — a bare `navigate` would be ambiguous across servers
/// and is rejected at load. A **trailing** `*` is a prefix wildcard, which is how a
/// plugin withholds a whole server (`shadow.*`); it is the only wildcard position
/// allowed, because an interior or leading `*` invites a pattern that silently
/// matches far more than the author pictured.
///
/// This type is declaration + validation only. The filter is **applied** where the
/// tool list is assembled for the model (the MCP offer site in
/// `apps/core/src/sidecar/mcp`), which calls [`ToolFilterContribution::matches`] so
/// the wildcard rule has exactly one implementation. Hiding a tool from the model
/// is not a security boundary — it does not revoke the capability, it only stops the
/// tool being advertised; enforcement stays with permissions and grants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ToolFilterContribution {
    /// Fully-qualified tool id (`<server>.<tool>`), optionally ending in `*` to
    /// hide every tool whose id starts with the preceding prefix.
    pub tool: String,

    /// Why the plugin hides it — surfaced in the plugin's listing so a user can see
    /// what a plugin is removing from the model's view before installing it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl ToolFilterContribution {
    /// Does this filter hide `tool_id`? Exact match, or prefix match when the
    /// pattern ends in `*`. The single implementation of the wildcard rule — the
    /// offer site calls this rather than re-deriving it.
    pub fn matches(&self, tool_id: &str) -> bool {
        self.tool.strip_suffix('*').map_or_else(
            || self.tool == tool_id,
            |prefix| tool_id.starts_with(prefix),
        )
    }
}

/// Validate one [`ToolFilterContribution`] pattern.
///
/// Returns `Ok(())` when the pattern is well-formed, else a descriptive `Err`.
pub fn validate_tool_filter(filter: &ToolFilterContribution) -> Result<(), String> {
    let tool = filter.tool.trim();
    if tool.is_empty() {
        return Err("tool_filters entry has an empty 'tool' pattern".to_string());
    }
    if tool != filter.tool {
        return Err(format!(
            "tool_filters pattern '{}' has leading/trailing whitespace",
            filter.tool
        ));
    }
    if tool.chars().any(char::is_whitespace) {
        return Err(format!(
            "tool_filters pattern '{tool}' must not contain whitespace"
        ));
    }
    // Only a TRAILING `*` is a wildcard. An interior one (`br*ser.nav`) would look
    // like a glob and behave like a literal, which is the worst of both.
    let body = tool.strip_suffix('*').unwrap_or(tool);
    if body.contains('*') {
        return Err(format!(
            "tool_filters pattern '{tool}' may only use '*' as its final character"
        ));
    }
    // `*` alone (or any pattern that does not name a server) would hide every tool
    // on the node from the model — a plugin that wants that is almost certainly a
    // mistake or hostile, and either way the user should not learn about it by
    // watching the agent lose its hands.
    let has_namespace = body.split_once('.').is_some_and(|(server, tool_name)| {
        !server.is_empty() && (!tool_name.is_empty() || tool.ends_with('*'))
    });
    if !has_namespace {
        return Err(format!(
            "tool_filters pattern '{tool}' must be a fully-qualified '<server>.<tool>' id (a bare name or '*' would match across every server)"
        ));
    }
    Ok(())
}

/// Category ids the **kernel** owns, and which an app therefore may not claim.
///
/// These name data no app created — conversations, Spaces, long-term memory — so
/// there is no manifest that could legitimately declare them, and Core clears each
/// with the owning store's transactional `clear_all`. An app that claimed `chats`
/// would get its Danger Zone row wired to that truncate, which is a plugin
/// deleting every conversation on the node from a manifest string; the loader
/// rejects the claim instead.
pub const KERNEL_DATA_CATEGORY_IDS: &[&str] = &["chats", "spaces", "memory"];

/// One **deletable data category** an app owns (see [`Contributes::data_categories`]).
///
/// Everything the Danger Zone needs to draw and arm one destructive row, so the copy
/// lives with the app whose data it describes rather than in the desktop's source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DataCategoryContribution {
    /// Stable id — this is the `category` a `POST /api/data/clear` names, so it is
    /// the app's half of the delete contract and renaming it breaks the button.
    pub id: String,

    /// The destructive button label and confirm-dialog title ("Delete all monitors").
    pub title: String,

    /// Plural noun for the live count line ("42 monitors" / "No monitors") and the
    /// "N deleted" toast. Lower-case: it is used mid-sentence.
    pub noun: String,

    /// The word the user must type to arm the delete. Absent = the [`noun`], which is
    /// the right default often enough that requiring it would just be ceremony.
    /// Matched case-insensitively by the client.
    ///
    /// [`noun`]: DataCategoryContribution::noun
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_word: Option<String>,

    /// Exactly what disappears, shown in the confirm dialog. Required, and required
    /// to be specific: this is the last thing the user reads before an irreversible
    /// delete, and "this cannot be undone" tells them nothing they did not know.
    pub detail: String,
}

impl DataCategoryContribution {
    /// The word to type to arm this delete — the declared one, or the [`noun`].
    ///
    /// [`noun`]: DataCategoryContribution::noun
    pub fn confirm_word(&self) -> &str {
        self.confirm_word
            .as_deref()
            .map(str::trim)
            .filter(|w| !w.is_empty())
            .unwrap_or(&self.noun)
    }
}

/// Validate one [`DataCategoryContribution`].
///
/// The `id` rule is the strict one because the id is interpolated nowhere but
/// compared everywhere: it is the wire value of `POST /api/data/clear`, the key the
/// desktop renders rows by, and the name Core resolves to a clear implementation. A
/// lowercase `[a-z0-9][a-z0-9._-]*` allowlist keeps it unambiguous in all three
/// places, and [`KERNEL_DATA_CATEGORY_IDS`] is refused outright.
pub fn validate_data_category(category: &DataCategoryContribution) -> Result<(), String> {
    let id = category.id.trim();
    if id.is_empty() {
        return Err("data category has an empty 'id'".to_string());
    }
    if id != category.id {
        return Err(format!(
            "data category id '{}' has leading/trailing whitespace",
            category.id
        ));
    }
    let mut chars = id.chars();
    let legal = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-' | '_'));
    if !legal {
        return Err(format!(
            "data category id '{id}' must be lower-case '[a-z0-9][a-z0-9._-]*' — it is the wire value of POST /api/data/clear"
        ));
    }
    if KERNEL_DATA_CATEGORY_IDS.contains(&id) {
        return Err(format!(
            "data category id '{id}' is owned by the kernel and cannot be claimed by an app"
        ));
    }
    for (label, value) in [
        ("title", &category.title),
        ("noun", &category.noun),
        ("detail", &category.detail),
    ] {
        if value.trim().is_empty() {
            return Err(format!("data category '{id}' has an empty '{label}'"));
        }
    }
    Ok(())
}

/// Validate one [`SettingsTabContribution`] and every field it declares.
///
/// This is the Rust twin of the schema an SDK author gets from `manifest.ts`: the
/// same rules, enforced on the Core side so a hand-written manifest (or one from a
/// language with no SDK) cannot skip them. Returns `Ok(())` when the tab is
/// well-formed, else a descriptive `Err` naming the tab and field at fault.
pub fn validate_settings_tab(tab: &SettingsTabContribution) -> Result<(), String> {
    if tab.id.trim().is_empty() {
        return Err("settings tab has an empty 'id'".to_string());
    }
    if tab.title.trim().is_empty() {
        return Err(format!("settings tab '{}' has an empty 'title'", tab.id));
    }

    let has_view = tab.view.as_ref().is_some_and(|v| !v.trim().is_empty());
    if tab.fields.is_empty() && !has_view {
        return Err(format!(
            "settings tab '{}' declares neither 'fields' nor a 'view' and would render as an empty section",
            tab.id
        ));
    }

    let mut seen_keys: BTreeSet<&str> = BTreeSet::new();
    for field in &tab.fields {
        validate_settings_field(&tab.id, field)?;
        if !seen_keys.insert(field.pref_key.as_str()) {
            return Err(format!(
                "settings tab '{}' declares two fields bound to '{}'; a preference key is a field's identity, so the second would overwrite the first",
                tab.id, field.pref_key
            ));
        }
    }
    Ok(())
}

/// One per-message toolbar action a plugin contributes (see
/// [`Contributes::message_actions`]).
///
/// The `kind` discriminant is deliberately NOT an enum (same reasoning as
/// [`ViewContribution::view`]): a member an older shell has never heard of must
/// reach a newer shell intact rather than being rejected at load. Renderers ignore
/// a `kind` they do not know, so a new kind degrades to "not shown" instead of
/// breaking the message toolbar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MessageActionContribution {
    /// Stable id for this action within the plugin (the shell's element key and
    /// dispatch tag, namespaced as `plugin:<pluginId>:<id>`).
    pub id: String,

    /// Accessible label (tooltip / aria-label) for the action button.
    pub label: String,

    /// Optional glyph id resolved by the shell's Icon primitive (Iconify/Hugeicons).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// Which messages the action attaches to: `"assistant"` | `"user"` | `"any"`.
    /// Open string — an unknown role is ignored, not rejected.
    pub target: String,

    /// Render mode: `"button"` (fire-and-forget) | `"toggle-group"` (mutually
    /// exclusive states, what thumbs is) | `"menu"`. Open string.
    pub kind: String,

    /// For `kind: "toggle-group"`: the states, each `{ value, label, icon?,
    /// active_icon? }`. Opaque to Core; the renderer owns the shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub states: Option<serde_json::Value>,

    /// The granted capability the shell invokes when the action fires, plus static
    /// `args`. Never inline code, never a capability the owning plugin was not
    /// granted — identical to the `action` composer control's dispatch rule.
    pub capability: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,

    /// Optional `ViewSource` the shell polls to hydrate current state (what lights
    /// the thumb on reload). Same `/api/`-path guard as views.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_source: Option<serde_json::Value>,

    /// Sort position among contributed actions (ascending).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i32>,
}

/// One button a plugin contributes to the floating text-selection toolbar (see
/// [`Contributes::selection_actions`]).
///
/// `capability` is optional because a host-owned renderer can use an opaque
/// `args.dispatch` bridge instead. The desktop never executes manifest code: it
/// only renders this label and forwards the selected text to the owning host
/// handler.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SelectionActionContribution {
    /// Stable id for this action within the plugin.
    pub id: String,

    /// Accessible label shown in the selection toolbar.
    pub label: String,

    /// Optional glyph id resolved by the shell's icon primitive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// Render mode. The current desktop renders `"button"`; this remains open
    /// so newer shells can add a mode without making older cores reject it.
    pub kind: String,

    /// Optional granted capability for a plugin-owned dispatch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability: Option<String>,

    /// Static renderer/dispatch arguments. The selected text is supplied by the
    /// host at click time and is never serialized into the manifest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,

    /// Sort position among contributed selection actions (ascending).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i32>,
}

/// One context-menu row a plugin contributes (see
/// [`Contributes::context_menu_items`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ContextMenuContribution {
    /// Stable id for this row within the plugin.
    pub id: String,

    /// Row label.
    pub label: String,

    /// Optional glyph id resolved by the shell's Icon primitive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// WHICH menu. Closed-ish enum by convention, open by encoding (same call as
    /// [`DockPanelPlacement`]): `"conversation"` | `"message"` | `"space"` |
    /// `"agent"` | `"project"` | `"workflow"` | `"skill"` | `"channel"`. The shell
    /// owns the anchor set; an app cannot conjure a new menu, but an unknown value
    /// must not fail the load.
    ///
    /// An anchor names an ENTITY, not a place, so one declaration reaches every
    /// surface that shows it. The desktop renders these in the sidebar row's menu
    /// AND — for whatever entity a tab is showing — in that tab's right-click menu,
    /// on both the horizontal strip and the vertical tab list. `"channel"` is in the
    /// list because a channel is one of those tab-visible entities; it is not a
    /// desktop-only extension.
    pub anchor: String,

    /// The granted capability the shell invokes when the row is clicked, plus
    /// static `args`. Never inline code, never a capability the owning plugin was
    /// not granted.
    pub capability: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,

    /// Optional feedback text for the shell's toast: `{ loading, success, error }`.
    /// Lets the app own its copy without owning the toast component.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<serde_json::Value>,

    /// Sort position among contributed rows (ascending).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i32>,
}

/// Validate one [`MessageActionContribution`]. The `capability` must be a
/// non-empty dotted verb (it is dispatched through the host-capability seam, and an
/// empty capability would render a button that can never do anything).
pub fn validate_message_action(action: &MessageActionContribution) -> Result<(), String> {
    if action.id.trim().is_empty() {
        return Err("message action has an empty 'id'".to_string());
    }
    if action.label.trim().is_empty() {
        return Err(format!(
            "message action '{}' has an empty 'label'",
            action.id
        ));
    }
    let target = action.target.trim();
    if target.is_empty() {
        return Err(format!(
            "message action '{}' has an empty 'target'",
            action.id
        ));
    }
    if !matches!(target, "assistant" | "user" | "any") {
        return Err(format!(
            "message action '{}' has an unknown 'target' '{}' (expected 'assistant' | 'user' | 'any')",
            action.id, target
        ));
    }
    let kind = action.kind.trim();
    if kind.is_empty() {
        return Err(format!(
            "message action '{}' has an empty 'kind'",
            action.id
        ));
    }
    if !matches!(kind, "button" | "toggle-group" | "menu") {
        return Err(format!(
            "message action '{}' has an unknown 'kind' '{}' (expected 'button' | 'toggle-group' | 'menu')",
            action.id, kind
        ));
    }
    if action.capability.trim().is_empty() {
        return Err(format!(
            "message action '{}' declares no 'capability'; a message action dispatches through the host-capability seam",
            action.id
        ));
    }
    Ok(())
}

/// Validate one [`SelectionActionContribution`]. A selection action must have a
/// real dispatch path: either a granted capability or a non-empty host dispatch
/// tag in its static args.
pub fn validate_selection_action(action: &SelectionActionContribution) -> Result<(), String> {
    if action.id.trim().is_empty() {
        return Err("selection action has an empty 'id'".to_string());
    }
    if action.label.trim().is_empty() {
        return Err(format!(
            "selection action '{}' has an empty 'label'",
            action.id
        ));
    }
    if action.kind.trim().is_empty() {
        return Err(format!(
            "selection action '{}' has an empty 'kind'",
            action.id
        ));
    }
    let has_capability = action
        .capability
        .as_deref()
        .is_some_and(|capability| !capability.trim().is_empty());
    let has_dispatch = action
        .args
        .as_ref()
        .and_then(serde_json::Value::as_object)
        .and_then(|args| args.get("dispatch"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|dispatch| !dispatch.trim().is_empty());
    if !(has_capability || has_dispatch) {
        return Err(format!(
            "selection action '{}' declares neither a non-empty 'capability' nor an 'args.dispatch' bridge",
            action.id
        ));
    }
    Ok(())
}

/// Validate one [`ContextMenuContribution`]. Same `capability` rule as
/// [`validate_message_action`].
pub fn validate_context_menu_item(item: &ContextMenuContribution) -> Result<(), String> {
    if item.id.trim().is_empty() {
        return Err("context menu item has an empty 'id'".to_string());
    }
    if item.label.trim().is_empty() {
        return Err(format!(
            "context menu item '{}' has an empty 'label'",
            item.id
        ));
    }
    if item.anchor.trim().is_empty() {
        return Err(format!(
            "context menu item '{}' has an empty 'anchor'",
            item.id
        ));
    }
    if item.capability.trim().is_empty() {
        return Err(format!(
            "context menu item '{}' declares no 'capability'; a context menu item dispatches through the host-capability seam",
            item.id
        ));
    }
    Ok(())
}

/// One "New X" row a plugin contributes to the shell's create menu (see
/// [`Contributes::create_actions`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CreateActionContribution {
    /// Stable id for this row within the plugin.
    pub id: String,

    /// Row label, written as the user reads it — "New workflow", not "Workflow".
    pub label: String,

    /// Optional glyph id resolved by the shell's Icon primitive. The desktop's
    /// create menu draws no icons today (its rows are label-only by design), so
    /// this is read and ignored there — it exists for shells that do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// In-app route the shell opens, e.g. `/workflows/new`. Must be a path, not a
    /// URL: this is a navigation inside the shell, and accepting a scheme here
    /// would turn a create row into an arbitrary-link affordance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,

    /// Title for the tab `target` opens. Falls back to `label`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// Granted capability to invoke instead of navigating, plus static `args` —
    /// for a create that is an action rather than a destination. Dispatched
    /// through the same host seam as a context-menu row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,

    /// Sort position among contributed rows (ascending).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i32>,
}

/// Validate one [`CreateActionContribution`].
pub fn validate_create_action(action: &CreateActionContribution) -> Result<(), String> {
    if action.id.trim().is_empty() {
        return Err("create action has an empty 'id'".to_string());
    }
    if action.label.trim().is_empty() {
        return Err(format!(
            "create action '{}' has an empty 'label'",
            action.id
        ));
    }
    let target = action.target.as_deref().unwrap_or("").trim();
    let capability = action.capability.as_deref().unwrap_or("").trim();
    if target.is_empty() && capability.is_empty() {
        return Err(format!(
            "create action '{}' declares neither 'target' nor 'capability'; a row that does nothing when clicked is worse than no row",
            action.id
        ));
    }
    if !target.is_empty() && !target.starts_with('/') {
        return Err(format!(
            "create action '{}' has a 'target' that is not an in-app route (it must start with '/')",
            action.id
        ));
    }
    Ok(())
}

/// Characters a `pref_key` may contain. It is interpolated into the preference
/// route (`/api/preferences/<key>`), so a `/`, a backslash or a `..` segment would
/// escape the key space and address an unrelated route; a strict allowlist (not a
/// blocklist) is the only form of this check that stays correct as the route table
/// grows.
fn pref_key_char_is_legal(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':')
}

/// Longest accepted [`SettingsFieldType::Secret`] `pref_key`.
pub const MAX_SECRET_KEY_LEN: usize = 128;

/// Whether `name` is shaped like a POSIX environment variable
/// (`[A-Za-z_][A-Za-z0-9_]*`, at most [`MAX_SECRET_KEY_LEN`] chars).
///
/// THE ONE DEFINITION of a legal [`SettingsFieldType::Secret`] key, shared by the
/// manifest validator (which rejects a bad one at import) and Core's
/// `PUT /api/plugins/{id}/secrets/{key}` handler (which rejects a bad one at
/// write). Two copies would drift, and drift here means a field that validates on
/// load and 400s on save — a failure the plugin author never sees because it only
/// happens in the user's browser.
///
/// This is STRICTER than [`pref_key_char_is_legal`], which also admits `.`, `-`
/// and `:`. It has to be: a secret's `pref_key` is not a preference key at all, it
/// is the env var name the plugin's own `secret_headers` `env:` token names, and a
/// name that could not be an env var can never be read back.
pub fn is_env_var_name(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_SECRET_KEY_LEN {
        return false;
    }
    let mut chars = name.chars();
    let first_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    first_ok && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn validate_settings_field(tab_id: &str, field: &SettingsFieldContribution) -> Result<(), String> {
    let key = field.pref_key.trim();
    if key.is_empty() {
        return Err(format!(
            "settings tab '{tab_id}' has a field with an empty 'pref_key'; a field with nothing to persist is an inert control"
        ));
    }
    if key != field.pref_key {
        return Err(format!(
            "settings tab '{tab_id}' field pref_key '{}' has leading/trailing whitespace",
            field.pref_key
        ));
    }
    if !key.chars().all(pref_key_char_is_legal) {
        return Err(format!(
            "settings tab '{tab_id}' field pref_key '{key}' contains illegal characters (allowed: a-z A-Z 0-9 . - _ :)"
        ));
    }
    if key.contains("..") {
        return Err(format!(
            "settings tab '{tab_id}' field pref_key '{key}' must not contain '..'"
        ));
    }
    // A `secret` field's key is NOT a preference key: it is the environment
    // variable name the plugin's own `secret_headers` `env:` token names, and it is
    // what Core stores the credential under. The general `pref_key` alphabet admits
    // `.`, `-` and `:`, none of which can appear in an env var — so a field
    // declared as `"pref_key": "tavily.api-key"` would validate here, render
    // normally, and then fail only when a user pressed Save. Rejecting at import
    // puts the error in front of the author instead of the user.
    if field.field_type == SettingsFieldType::Secret && !is_env_var_name(key) {
        return Err(format!(
            "settings tab '{tab_id}' field pref_key '{key}' is type 'secret', so it must be the \
             environment variable name the manifest's secret_headers reads (a letter or \
             underscore followed by letters, digits or underscores, e.g. 'RYU_TAVILY_API_KEY')"
        ));
    }

    let is_select = field.field_type == SettingsFieldType::Select;
    if is_select {
        // The renderer silently degrades an optionless select to a free-text box, so
        // the user gets a control that looks nothing like what the author declared.
        if field.options.is_empty() {
            return Err(format!(
                "settings tab '{tab_id}' field '{key}' is type 'select' but declares no options"
            ));
        }
        let mut seen_values: BTreeSet<&str> = BTreeSet::new();
        for option in &field.options {
            if option.value().trim().is_empty() {
                return Err(format!(
                    "settings tab '{tab_id}' field '{key}' has a select option with an empty value"
                ));
            }
            if !seen_values.insert(option.value()) {
                return Err(format!(
                    "settings tab '{tab_id}' field '{key}' declares duplicate select option '{}'",
                    option.value()
                ));
            }
        }
    }

    validate_settings_field_bounds(tab_id, key, field)?;
    validate_settings_field_default(tab_id, key, field)
}

/// Cross-check the numeric / length bounds against the field's declared `type`.
/// Bounds attached to a type that cannot use them are rejected rather than ignored:
/// an author who writes `min` on a toggle believes something is being enforced.
fn validate_settings_field_bounds(
    tab_id: &str,
    key: &str,
    field: &SettingsFieldContribution,
) -> Result<(), String> {
    let is_number = field.field_type == SettingsFieldType::Number;
    if (field.min.is_some() || field.max.is_some() || field.step.is_some()) && !is_number {
        return Err(format!(
            "settings tab '{tab_id}' field '{key}' declares min/max/step but is not type 'number'"
        ));
    }
    // A non-positive step is not a granularity — the renderer would either reject
    // every value or divide by zero, so refuse it at import where the author can see
    // it rather than at the first blur.
    if let Some(step) = field.step {
        if !(step.is_finite() && step > 0.0) {
            return Err(format!(
                "settings tab '{tab_id}' field '{key}' has step {step}, which must be a finite positive number"
            ));
        }
    }
    if let (Some(min), Some(max)) = (field.min, field.max) {
        if min > max {
            return Err(format!(
                "settings tab '{tab_id}' field '{key}' has min {min} greater than max {max}"
            ));
        }
    }

    let is_textual = matches!(
        field.field_type,
        SettingsFieldType::Text | SettingsFieldType::Textarea
    );
    if (field.min_length.is_some() || field.max_length.is_some()) && !is_textual {
        return Err(format!(
            "settings tab '{tab_id}' field '{key}' declares min_length/max_length but is not type 'text' or 'textarea'"
        ));
    }
    if let (Some(min), Some(max)) = (field.min_length, field.max_length) {
        if min > max {
            return Err(format!(
                "settings tab '{tab_id}' field '{key}' has min_length {min} greater than max_length {max}"
            ));
        }
    }
    Ok(())
}

/// Check that a declared `default` is of the field's own type and inside its own
/// bounds. A default that violates either would be written straight into the
/// preference store the first time the tab renders, so catching it at import is the
/// difference between a load-time warning and a runtime value nothing can parse.
fn validate_settings_field_default(
    tab_id: &str,
    key: &str,
    field: &SettingsFieldContribution,
) -> Result<(), String> {
    let Some(default) = &field.default else {
        return Ok(());
    };
    let mismatch = |expected: &str| {
        format!("settings tab '{tab_id}' field '{key}' is type '{expected}' but its default is {default}")
    };

    match field.field_type {
        SettingsFieldType::Toggle => {
            if !default.is_boolean() {
                return Err(mismatch("toggle"));
            }
        }
        SettingsFieldType::Number => {
            let Some(value) = default.as_f64() else {
                return Err(mismatch("number"));
            };
            let below_min = field.min.is_some_and(|min| value < min);
            let above_max = field.max.is_some_and(|max| value > max);
            if below_min || above_max {
                return Err(format!(
                    "settings tab '{tab_id}' field '{key}' default {value} is outside its declared min/max"
                ));
            }
        }
        SettingsFieldType::Select => {
            let Some(value) = default.as_str() else {
                return Err(mismatch("select"));
            };
            if !field.options.iter().any(|o| o.value() == value) {
                return Err(format!(
                    "settings tab '{tab_id}' field '{key}' default '{value}' is not one of its declared options"
                ));
            }
        }
        SettingsFieldType::Text | SettingsFieldType::Textarea => {
            let Some(value) = default.as_str() else {
                return Err(mismatch("text"));
            };
            let len = value.chars().count() as u64;
            let too_short = field.min_length.is_some_and(|min| len < min);
            let too_long = field.max_length.is_some_and(|max| len > max);
            if too_short || too_long {
                return Err(format!(
                    "settings tab '{tab_id}' field '{key}' default is outside its declared min_length/max_length"
                ));
            }
        }
        SettingsFieldType::ModelPicker => {
            if !default.is_string() {
                return Err(mismatch("model_picker"));
            }
        }
        // A selection is stored as JSON, but a manifest may equally declare its
        // default as a bare model id (the legacy form the resolver still reads),
        // so both spellings are valid here.
        SettingsFieldType::AgentPicker => {
            if !(default.is_string() || default.is_object()) {
                return Err(mismatch("agent_picker"));
            }
        }
        // A secret field has NO valid default. Whatever a manifest put there would
        // be a credential shipped in a file that travels with the plugin — the
        // exact thing this field type exists to stop — and it could never be
        // honoured anyway, since the value lives in the encrypted store, not in
        // preferences. Rejecting at import makes the mistake loud at the moment it
        // is committed rather than silently ignored forever.
        SettingsFieldType::Secret => {
            return Err(format!(
                "settings tab '{tab_id}' field '{key}' is type 'secret' and must not declare a \
                 default (a credential must never ship inside a manifest)"
            ));
        }
    }
    Ok(())
}

impl Contributes {
    /// Every runnable id referenced across all contribution surfaces. Used by the
    /// loader to verify each one resolves to a `runnables` entry.
    pub fn referenced_ids(&self) -> Vec<&str> {
        self.commands
            .iter()
            .chain(self.tools.iter())
            .chain(self.agents.iter())
            .chain(self.workflows.iter())
            .chain(self.policies.iter())
            .map(|c| c.id.as_str())
            .collect()
    }

    /// Hold `settings_tabs`, `tool_filters` and `data_categories` to their typed
    /// contracts.
    ///
    /// `settings_tabs` is stored as raw JSON (see [`Contributes::settings_tabs`]),
    /// so this is where it is actually parsed as [`SettingsTabContribution`] — the
    /// ONE implementation, called from both [`PluginManifest::validate`] (the SDK /
    /// FFI path) and Core's manifest loader, so an author cannot get a different
    /// answer depending on which door they came through.
    ///
    /// Errors are unprefixed; each caller wraps them in its own house style.
    ///
    /// [`Contributes::lsp_servers`] is intentionally NOT checked here. An `Err` from
    /// this function skips the whole manifest, but an invalid language server must
    /// cost only itself — see [`LspServerContribution::validate`], which the spawn
    /// site calls per server instead.
    pub fn validate_settings_contributions(&self) -> Result<(), String> {
        let mut seen_tab_ids: BTreeSet<&str> = BTreeSet::new();
        let mut tabs: Vec<SettingsTabContribution> = Vec::with_capacity(self.settings_tabs.len());
        for (index, raw) in self.settings_tabs.iter().enumerate() {
            let tab: SettingsTabContribution = serde_json::from_value(raw.clone())
                .map_err(|e| format!("settings tab #{index} is not a valid settings tab: {e}"))?;
            validate_settings_tab(&tab)?;
            tabs.push(tab);
        }
        // Two tabs sharing an id collide in the settings nav (which routes by id) and
        // in the renderer's element keys, so the second silently shadows the first.
        for tab in &tabs {
            if !seen_tab_ids.insert(tab.id.as_str()) {
                return Err(format!("duplicate settings tab id '{}'", tab.id));
            }
        }

        // `message_actions`, `selection_actions`, and `context_menu_items` are stored raw (see their
        // field doc comments) so the contributions endpoint can tag and forward each
        // entry verbatim; this is where they are actually parsed as their typed
        // contracts, exactly like `settings_tabs` above.
        let mut actions: Vec<MessageActionContribution> =
            Vec::with_capacity(self.message_actions.len());
        for (index, raw) in self.message_actions.iter().enumerate() {
            let action: MessageActionContribution =
                serde_json::from_value(raw.clone()).map_err(|e| {
                    format!("message action #{index} is not a valid message action: {e}")
                })?;
            validate_message_action(&action)?;
            actions.push(action);
        }
        let mut seen_action_ids: BTreeSet<&str> = BTreeSet::new();
        for action in &actions {
            if !seen_action_ids.insert(action.id.as_str()) {
                return Err(format!("duplicate message action id '{}'", action.id));
            }
        }

        let mut selection_actions: Vec<SelectionActionContribution> =
            Vec::with_capacity(self.selection_actions.len());
        for (index, raw) in self.selection_actions.iter().enumerate() {
            let action: SelectionActionContribution =
                serde_json::from_value(raw.clone()).map_err(|e| {
                    format!("selection action #{index} is not a valid selection action: {e}")
                })?;
            validate_selection_action(&action)?;
            selection_actions.push(action);
        }
        let mut seen_selection_ids: BTreeSet<&str> = BTreeSet::new();
        for action in &selection_actions {
            if !seen_selection_ids.insert(action.id.as_str()) {
                return Err(format!("duplicate selection action id '{}'", action.id));
            }
        }

        let mut menu_items: Vec<ContextMenuContribution> =
            Vec::with_capacity(self.context_menu_items.len());
        for (index, raw) in self.context_menu_items.iter().enumerate() {
            let item: ContextMenuContribution =
                serde_json::from_value(raw.clone()).map_err(|e| {
                    format!("context menu item #{index} is not a valid context menu item: {e}")
                })?;
            validate_context_menu_item(&item)?;
            menu_items.push(item);
        }
        let mut seen_menu_ids: BTreeSet<&str> = BTreeSet::new();
        for item in &menu_items {
            if !seen_menu_ids.insert(item.id.as_str()) {
                return Err(format!("duplicate context menu item id '{}'", item.id));
            }
        }

        let mut create_actions: Vec<CreateActionContribution> =
            Vec::with_capacity(self.create_actions.len());
        for (index, raw) in self.create_actions.iter().enumerate() {
            let action: CreateActionContribution = serde_json::from_value(raw.clone())
                .map_err(|e| format!("create action #{index} is not a valid create action: {e}"))?;
            validate_create_action(&action)?;
            create_actions.push(action);
        }
        let mut seen_create_ids: BTreeSet<&str> = BTreeSet::new();
        for action in &create_actions {
            if !seen_create_ids.insert(action.id.as_str()) {
                return Err(format!("duplicate create action id '{}'", action.id));
            }
        }

        for filter in &self.tool_filters {
            validate_tool_filter(filter)?;
        }

        // Two categories sharing an id would put two "Delete all X" buttons in the
        // danger zone that POST the same `category`, so one of them deletes something
        // other than what its copy promised — the one failure mode an irreversible
        // action must not have.
        let mut seen_category_ids: BTreeSet<&str> = BTreeSet::new();
        for category in &self.data_categories {
            validate_data_category(category)?;
            if !seen_category_ids.insert(category.id.as_str()) {
                return Err(format!("duplicate data category id '{}'", category.id));
            }
        }
        Ok(())
    }

    /// Hold `hook_events` to the namespace rule, and reject duplicate ids.
    ///
    /// Takes the owning `plugin_id` because a [`Contributes`] does not know which
    /// manifest holds it, and the whole point of the check is that an event's
    /// namespace half must *be* that id (see [`Contributes::hook_events`]).
    ///
    /// Deliberately does NOT validate `turn_hooks[].on` against any known event.
    /// A consumer naming an event no installed plugin declares is normal and must
    /// keep working: it is how you install a consumer before its provider, and how a
    /// consumer survives its provider being temporarily disabled. An unmatched `on`
    /// simply never fires — the same posture `tool_filters` takes toward naming
    /// another plugin's tools.
    ///
    /// # Errors
    /// Returns `Err` on a malformed or foreign-namespaced event id, or a duplicate.
    pub fn validate_hook_events(&self, plugin_id: &str) -> Result<(), String> {
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for event in &self.hook_events {
            validate_hook_event(event, plugin_id)?;
            if !seen.insert(event.id.as_str()) {
                return Err(format!("duplicate hook event id '{}'", event.id));
            }
        }
        Ok(())
    }

    /// Cross-validate [`Contributes::pi_extensions`]: unique ids in the id alphabet,
    /// and a `file` that is a legal [`PI_EXTENSION_DIR`] path.
    ///
    /// Runs at LOAD, not at spawn, on purpose. The materializer is best-effort and
    /// fail-open (a bad extension must never take the agent down), so a typo checked
    /// only there would surface as a warn line on a Pi spawn nobody is watching. The
    /// duplicate-id half matters for the same reason the path half does: the id is
    /// part of the materialized file name, so two rows sharing one would silently
    /// overwrite each other on disk.
    pub fn validate_pi_extensions(&self) -> Result<(), String> {
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for ext in &self.pi_extensions {
            let valid_id = ext
                .id
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                && ext.id.chars().all(|c| {
                    c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-')
                });
            if !valid_id {
                return Err(format!(
                    "pi_extensions[{}]: id must match [a-z0-9][a-z0-9._-]*",
                    ext.id
                ));
            }
            if !seen.insert(ext.id.as_str()) {
                return Err(format!("duplicate pi extension id '{}'", ext.id));
            }
            validate_pi_extension_path(&ext.file)
                .map_err(|e| format!("pi_extensions[{}]: {e}", ext.id))?;
        }
        Ok(())
    }

    /// Cross-validate [`Contributes::output_styles`]: unique ids in the id alphabet,
    /// exactly one of `file` / `source`, and a legal [`OUTPUT_STYLE_DIR`] path.
    ///
    /// Checks the *shape*, deliberately not the *hydration state*. A residual `file`
    /// is legal here — unlike a residual `code_file`, which
    /// [`PluginManifest::validate_code_sources`] rejects outright. That asymmetry is
    /// intentional: the code rule is safe only because every loader path provably
    /// hydrates before validating, and an `Err` from here skips the WHOLE manifest.
    /// Failing an entire app to load because one prose file had not been inlined yet
    /// is a wildly disproportionate blast radius for a contribution that cannot
    /// execute anything.
    ///
    /// The duplicate-id half matters for the reason [`OutputStyleContribution::id`]
    /// gives: two rows sharing an id collapse to one entry in the merged registry, so
    /// the persisted selection silently resolves to whichever loaded last.
    pub fn validate_output_styles(&self) -> Result<(), String> {
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for style in &self.output_styles {
            let valid_id = style
                .id
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                && style.id.chars().all(|c| {
                    c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-')
                });
            if !valid_id {
                return Err(format!(
                    "output_styles[{}]: id must match [a-z0-9][a-z0-9._-]*",
                    style.id
                ));
            }
            if !seen.insert(style.id.as_str()) {
                return Err(format!("duplicate output style id '{}'", style.id));
            }
            match (&style.file, &style.source) {
                (Some(rel), None) => validate_output_style_path(rel)
                    .map_err(|e| format!("output_styles[{}]: {e}", style.id))?,
                (None, Some(source)) if !source.trim().is_empty() => {}
                (Some(rel), Some(_)) => {
                    return Err(format!(
                        "output_styles[{}] declares both 'source' and 'file' ('{rel}') — exactly \
                         one is allowed",
                        style.id
                    ));
                }
                // Covers both "neither key" and an inline `source` that is blank. A
                // style with no body would load as a style that changes nothing,
                // which no read site can tell apart from the user having picked none.
                _ => {
                    return Err(format!(
                        "output_styles[{}] declares neither 'source' nor 'file'",
                        style.id
                    ));
                }
            }
        }
        Ok(())
    }
}

/// A single contribution: a reference (by `id`) to a runnable declared in the
/// manifest's `runnables` list, optionally with a human-facing title (e.g. the
/// label a command shows in the palette).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ContributionId {
    /// The runnable id this contribution points at. Must exist in `runnables`.
    pub id: String,

    /// Optional display title (e.g. the palette label for a command).
    #[serde(default)]
    pub title: Option<String>,
}

/// `engines` block — the **host** version floors, mirroring VS-Code's
/// `engines.vscode`. Every value is a semver **requirement** string.
///
/// `ryu` is the Core floor and is the only required key (every manifest written
/// before per-surface floors existed carries just that one). The rest are optional
/// per-[`Surface`] floors: a plugin that needs a Gateway API added in 0.1.5 and a
/// desktop panel API added in 0.2.0 says so, instead of over-declaring one Core
/// floor and hoping the release train kept them in step.
///
/// ## Why this is a flat struct and not a `BTreeMap<Surface, String>`
///
/// The [`PluginManifest::surfaces`] map would be the obvious home, but it is
/// **absent from the SDK's zod mirror** (`packages/sdk/src/manifest.ts`), and zod
/// strips unlisted keys — so a floor declared there would be silently dropped from
/// every bundle `ryu pack` produces. `engines` is the block that already means
/// "host floor", it is what a manifest author reaches for, and mirroring it costs
/// one schema addition rather than a nested map.
///
/// ## Unknown ≠ unsatisfied
///
/// Core observes its own version and (via `/health`) the Gateway's. It does NOT
/// know the desktop, island, mobile, extension or web version — those are separate
/// installs that never report in. A floor against a surface whose version is
/// unknown is therefore **advisory, never blocking**: see
/// `HostVersions::evaluate`. Blocking on unknown would delist every plugin from
/// every surface Core cannot see, which is most of them.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct EnginesReq {
    /// Semver requirement the running **Core** version must satisfy (e.g.
    /// `">=0.3.0"`, `"^1.2"`). Parsed as a [`semver::VersionReq`]; an unparseable
    /// value causes the loader to reject the manifest, and an unsatisfied one moves
    /// it to the incompatible lane (shown in the marketplace, refused at install).
    ///
    /// Named `ryu` rather than `core` for backwards compatibility: every manifest
    /// in the wild spells it this way. [`EnginesReq::floor_for`] maps
    /// [`Surface::Core`] onto it.
    pub ryu: String,

    /// Floor for the **Gateway**. The one non-Core surface Core can actually
    /// observe (it spawns the Gateway and reads `version` from its `/health`), so a
    /// floor here is genuinely enforceable rather than advisory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway: Option<String>,

    /// Floor for the **desktop** app (Tauri shell).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<String>,

    /// Floor for the **island** (the always-on overlay surface).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub island: Option<String>,

    /// Floor for the **mobile** app. The one surface with a genuinely independent
    /// release train (App Store / Play review lag), so it is the floor most likely
    /// to be unsatisfied in practice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mobile: Option<String>,

    /// Floor for the **terminal** (`cli`) surface — the TUI that dispatches
    /// `ryu <app> <cmd>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli: Option<String>,

    /// Floor for the **browser extension** surface.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension: Option<String>,

    /// Floor for the **web** surface.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web: Option<String>,
}

impl EnginesReq {
    /// The declared floor for `surface`, if any.
    ///
    /// [`Surface::Core`] maps onto [`ryu`](EnginesReq::ryu) — the legacy spelling of
    /// the same thing. [`Surface::Unknown`] never has a floor: a manifest written
    /// against a newer Ryu may name a surface this build cannot resolve, and the
    /// honest reading is "no floor I can evaluate" rather than a spurious refusal.
    pub fn floor_for(&self, surface: Surface) -> Option<&str> {
        match surface {
            Surface::Core => Some(self.ryu.as_str()),
            Surface::Gateway => self.gateway.as_deref(),
            Surface::Desktop => self.desktop.as_deref(),
            Surface::Island => self.island.as_deref(),
            Surface::Mobile => self.mobile.as_deref(),
            Surface::Cli => self.cli.as_deref(),
            Surface::Extension => self.extension.as_deref(),
            Surface::Web => self.web.as_deref(),
            Surface::Unknown => None,
        }
    }

    /// Every `(surface, requirement)` pair this block declares, Core first, then in
    /// [`Surface`] declaration order. Used to build the marketplace's
    /// "Requires" list and to drive the compatibility evaluation.
    pub fn declared_floors(&self) -> Vec<(Surface, &str)> {
        [
            Surface::Core,
            Surface::Gateway,
            Surface::Desktop,
            Surface::Island,
            Surface::Mobile,
            Surface::Cli,
            Surface::Extension,
            Surface::Web,
        ]
        .into_iter()
        .filter_map(|s| self.floor_for(s).map(|r| (s, r)))
        .collect()
    }
}

/// Why one declared host floor is not satisfied.
///
/// Carries the surface, the requirement as written, and the version actually
/// present, so a UI renders "Requires Gateway 0.2.0 or newer — you have 0.1.12"
/// without string-parsing a message.
/// Tagged on `code` (not `reason`) to match [`crate::manifest`]'s sibling
/// `DependencyError` in Core, and because `reason` is already a field name here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum UnmetRequirement {
    /// The surface's version is known and does NOT satisfy the floor. **Blocking.**
    TooOld {
        surface: Surface,
        /// The requirement as written in the manifest.
        required: String,
        /// The version actually running.
        present: String,
    },

    /// The surface's version is not known to whoever evaluated this — Core cannot
    /// observe desktop / island / mobile / extension / web. **Advisory, never
    /// blocking**: refusing on unknown would delist every plugin from every surface
    /// Core cannot see. A client that DOES know its own version (the desktop reads
    /// Tauri's `getVersion()`) re-evaluates locally and can upgrade this to
    /// [`TooOld`].
    Unknown { surface: Surface, required: String },

    /// The requirement string is not parseable semver. **Blocking** — a gate that
    /// cannot decide must refuse, not wave the plugin through. Normally unreachable
    /// from the loader, which rejects such a manifest outright; kept because this
    /// type is also evaluated against catalog data Core did not parse.
    InvalidRequirement {
        surface: Surface,
        required: String,
        reason: String,
    },
}

impl UnmetRequirement {
    /// The surface this concerns.
    pub const fn surface(&self) -> Surface {
        match self {
            UnmetRequirement::TooOld { surface, .. }
            | UnmetRequirement::Unknown { surface, .. }
            | UnmetRequirement::InvalidRequirement { surface, .. } => *surface,
        }
    }

    /// Whether this alone makes the plugin uninstallable. `false` for
    /// [`Unknown`](UnmetRequirement::Unknown), which is advisory by design.
    pub const fn is_blocking(&self) -> bool {
        matches!(
            self,
            UnmetRequirement::TooOld { .. } | UnmetRequirement::InvalidRequirement { .. }
        )
    }
}

/// The result of checking a manifest's `engines` block against the running hosts.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
pub struct CompatibilityVerdict {
    /// True when nothing BLOCKING is unmet. Advisory
    /// [`Unknown`](UnmetRequirement::Unknown) entries do not clear this flag, so a
    /// plugin whose only problem is an unobservable surface stays installable.
    pub compatible: bool,

    /// Every floor that is not satisfied, blocking and advisory alike, in
    /// [`Surface`] order. Empty when the manifest declares no `engines` block.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unmet: Vec<UnmetRequirement>,
}

impl CompatibilityVerdict {
    /// A verdict with nothing to report — the shape for a manifest that declares no
    /// `engines` block at all.
    pub fn satisfied() -> Self {
        Self {
            compatible: true,
            unmet: Vec::new(),
        }
    }

    /// The blocking entries only — what an install refusal should name.
    pub fn blocking(&self) -> impl Iterator<Item = &UnmetRequirement> {
        self.unmet.iter().filter(|u| u.is_blocking())
    }
}

/// The versions of the host surfaces currently running, as far as the evaluator
/// knows them.
///
/// Deliberately sparse. Core populates `core` from its own crate version and
/// `gateway` from the observed `/health` value; everything else is absent unless a
/// surface self-reports. A client evaluating locally overlays its own entry (the
/// desktop knows its Tauri version) before rendering.
///
/// An absent surface is **unknown, not old** — see [`UnmetRequirement::Unknown`].
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
pub struct HostVersions {
    /// Surface → version string. A value that is not parseable semver is treated as
    /// unknown rather than as a failure: it is the evaluator's own data, and a
    /// malformed local version must not make every plugin look incompatible.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub versions: BTreeMap<Surface, String>,
}

impl HostVersions {
    /// Record `surface` as running `version`.
    pub fn with(mut self, surface: Surface, version: impl Into<String>) -> Self {
        self.versions.insert(surface, version.into());
        self
    }

    /// The known version for `surface`, if it parses as semver.
    fn parsed(&self, surface: Surface) -> Option<semver::Version> {
        self.versions
            .get(&surface)
            .and_then(|v| semver::Version::parse(v.trim_start_matches(['v', 'V'])).ok())
    }

    /// Check every floor `engines` declares against what is known to be running.
    ///
    /// `None` (no `engines` block) is [`CompatibilityVerdict::satisfied`] — the case
    /// for every manifest predating host floors.
    pub fn evaluate(&self, engines: Option<&EnginesReq>) -> CompatibilityVerdict {
        let Some(engines) = engines else {
            return CompatibilityVerdict::satisfied();
        };

        let mut unmet = Vec::new();
        for (surface, required) in engines.declared_floors() {
            let req = match semver::VersionReq::parse(required) {
                Ok(r) => r,
                Err(e) => {
                    unmet.push(UnmetRequirement::InvalidRequirement {
                        surface,
                        required: required.to_owned(),
                        reason: e.to_string(),
                    });
                    continue;
                }
            };
            match self.parsed(surface) {
                // A prerelease (`0.2.0-nightly.3`) does NOT match a plain `>=0.1.0`
                // under semver's own rules, which would mark every nightly build
                // incompatible with every plugin. Compare on the release triple so a
                // channel suffix never decides compatibility.
                Some(present) => {
                    let release_only =
                        semver::Version::new(present.major, present.minor, present.patch);
                    if !req.matches(&release_only) {
                        unmet.push(UnmetRequirement::TooOld {
                            surface,
                            required: required.to_owned(),
                            present: present.to_string(),
                        });
                    }
                }
                None => unmet.push(UnmetRequirement::Unknown {
                    surface,
                    required: required.to_owned(),
                }),
            }
        }

        CompatibilityVerdict {
            compatible: !unmet.iter().any(UnmetRequirement::is_blocking),
            unmet,
        }
    }
}

/// `requires` block — the plugin's **plugin-to-plugin** dependencies.
///
/// This is the npm-shaped edge that lets the app decompose into a minimal kernel
/// plus features: a plugin declares the other plugins it needs, and the lifecycle
/// (Core's `plugins::graph`) resolves them into a topological enable order.
///
/// Distinct from [`EnginesReq`], which constrains plugin→**Core** (the engine
/// version). `requires` constrains plugin→**plugin**.
///
/// Absent (the default, and the case for every manifest that predates this field)
/// means *no dependencies* — the plugin enables standalone exactly as before.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct Requires {
    /// Other plugins that must be installed (and are auto-enabled, in dependency
    /// order) before this one can enable.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub apps: Vec<AppDependency>,

    /// **Capabilities** this plugin requires — the layered, provider-agnostic edge
    /// (`requires: [rag]`) that the capability broker resolves to a concrete
    /// provider app at bind time. Distinct from [`apps`]: an `apps` edge names a
    /// specific plugin id; a `capabilities` edge names an abstract capability and
    /// lets the binding registry pick (or the user override) which enabled provider
    /// serves it. Each is lowered to an app-id graph edge once bound, so the
    /// topological enable/disable/cycle machinery is shared. Empty for the common
    /// case.
    ///
    /// [`apps`]: Requires::apps
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<CapabilityReq>,

    /// Permission grants implied by the dependencies. Declaration only — the
    /// Gateway remains the sole authority on what a grant *allows* (Core decides
    /// what runs; the Gateway decides what is permitted).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grants: Vec<String>,
}

/// One **required capability** edge (in [`Requires::capabilities`]).
///
/// Names an abstract capability plus an optional minimum *capability* version. The
/// version floor is checked at bind time against the bound provider's
/// [`ProvidesEntry::version`] — NOT against the provider plugin's own semver — so a
/// lowered graph edge carries no `min_version` (the app-version gate would compare
/// the wrong number). See the capability broker in Core.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CapabilityReq {
    /// The capability name (e.g. `"rag"`, `"tts"`). Matched against a provider's
    /// [`ProvidesEntry::capability`].
    pub capability: String,

    /// Optional minimum **capability** version the bound provider must satisfy
    /// (bare `"1.2.0"` = `">=1.2.0"`, via [`parse_min_version`]). Absent = any
    /// version of the capability is acceptable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_version: Option<String>,
}

/// One **provided capability** entry (in [`PluginManifest::provides`]).
///
/// Binds an abstract capability name to a concrete serving surface on THIS
/// manifest: the local `sidecar` name whose declared HTTP `route` implements the
/// capability, plus the `grant` a consumer must hold to invoke it. The broker
/// routes a consumer's `/api/host/capability/<cap>` call to this sidecar's route
/// using the *provider's* minted token — the consumer never sees it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
pub struct ProvidesEntry {
    /// The capability name this plugin serves (e.g. `"rag"`). Consumers match on
    /// this against their [`Requires::capabilities`].
    pub capability: String,

    /// The capability's own semver version (independent of the plugin version), so
    /// a consumer's [`CapabilityReq::min_version`] floor can be checked against the
    /// capability contract rather than the app release.
    pub version: String,

    /// The local `name` of one of this manifest's declared `sidecars` that serves
    /// the capability. The loader cross-validates it exists. Absent = an in-process
    /// capability with no dedicated sidecar (the broker declines to proxy it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidecar: Option<String>,

    /// The proxied sub-path (on the named sidecar's [`crate::schema::HttpProxySpec`])
    /// the broker forwards capability calls to (e.g. `"/rag/query"`). The loader
    /// cross-validates that the named sidecar declares a matching route.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,

    /// The grant a consumer must hold (Gateway-approved) to invoke this capability
    /// via the broker. Absent = no extra grant beyond declaring the edge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<String>,

    /// The human name of the **capability** (not of this provider): `"Search"` for
    /// `web.search`, `"Document Parsing"` for `document.parse`. What a layer picker
    /// puts above the provider list.
    ///
    /// Declared here, on the provider, because the capability itself is not a
    /// manifest — it exists only as the string its providers agree on — and there is
    /// nowhere else to hang the name. So every provider of a capability should carry
    /// the same `title`, and the layer keeps its name when the default provider is
    /// uninstalled.
    ///
    /// Deliberately NOT unanimity-checked the way [`Self::selectable`] is: forcing
    /// six independent `web.search` manifests to spell one cosmetic string
    /// byte-identically or fail to load trades a real capability for a label. Core
    /// picks one with the same ladder the binder uses (declared default, else
    /// lowest plugin id) and disagreement costs at most a differently-worded header.
    ///
    /// Absent = the client falls back to its own naming (a built-in table, else the
    /// capability's last dotted segment). No server-side humaniser derives it from
    /// the id — that route reads `news.crud` as "News Crud".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    /// Opt in to the **selectable** flavour: many providers of this capability may
    /// be enabled at once and the user *picks* one, exactly like a local engine.
    ///
    /// A non-selectable capability (the original, strict flavour used by `rag` /
    /// `engines`) treats a second enabled provider as an explicit
    /// `BindingError::Ambiguous` refusal. A selectable one resolves deterministically
    /// instead: user override > sole provider > the provider declaring
    /// [`Self::default_provider`] > lexicographically-lowest provider id. The pick is
    /// a pure function of the candidate set, so the disable-safety reconstruction
    /// argument in Core's binding registry is unchanged.
    ///
    /// Selectability is a property of the *capability*, so every provider of a given
    /// capability must agree on the flag; the loader rejects a mixed declaration.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub selectable: bool,

    /// Preferred pick among the providers of a [`Self::selectable`] capability when
    /// the user has set no override. At most one provider per capability may declare
    /// it. Meaningless (and ignored) on a non-selectable capability.
    #[serde(
        default,
        rename = "default",
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub default_provider: bool,

    /// WHAT this provider acts on, when the capability controls a machine or an
    /// environment rather than answering a query.
    ///
    /// Exists because "swap the provider" quietly means two different things.
    /// Swapping `web.search` from exa to tavily changes who answers; the question is
    /// the same. Swapping `computer.control` from ghost to bytebot changes **which
    /// computer gets typed on** — ghost drives the machine Ryu runs on, bytebot
    /// drives the desktop `bytebotd` runs on (a containerized Linux desktop in the
    /// shipped product). A picker that renders those two swaps identically is
    /// telling the user something false, and until this field existed the
    /// distinction lived only in a prose `description` that nothing structured
    /// could read.
    ///
    /// Absent = not applicable or unspecified. That is the honest default for the
    /// capabilities where locality is meaningless (`web.search`, `memory`, `rag`),
    /// and it is deliberately NOT [`ProviderTarget::LocalMachine`]: defaulting to
    /// "this machine" would silently mislabel every future hosted provider that
    /// forgets to declare it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ProviderTarget>,

    /// Capability **verb → this provider's tool** bindings, the seam that keeps the
    /// model-visible tool surface stable across a swap.
    ///
    /// The key is a canonical verb from the host's capability verb table (e.g.
    /// `"web.search"`); the value names the provider's own registered tool plus the
    /// argument/response mapping into the canonical shape. A provider that omits a
    /// verb simply does not serve it — the facade reports the verb unavailable
    /// rather than guessing.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tools: BTreeMap<String, CapabilityToolBinding>,
}

/// What a capability provider acts on — see [`ProvidesEntry::target`].
///
/// Deliberately two coarse values rather than a taxonomy. The only question a user
/// needs answered before swapping is "will this act on the machine in front of me,
/// or somewhere else?", and a finer vocabulary (container / VM / cloud / another
/// host) would be guesswork the manifests cannot honestly support.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderTarget {
    /// Acts on the machine Ryu itself is running on: `ghost` types on this
    /// keyboard, the Chromium sidecar opens a window on this display.
    LocalMachine,
    /// Acts on a SEPARATE machine or virtual desktop — a container, a VM, a hosted
    /// browser. Selecting it is not another way to drive your own computer, and the
    /// picker must say so.
    RemoteDesktop,
}

/// How one capability **verb** maps onto a concrete provider tool.
///
/// The facade tool (`web.search`, `browser.navigate`, …) is registered by the host
/// from its canonical verb table; at call time it resolves the capability's bound
/// provider, reads this binding, renames the arguments, re-enters tool dispatch on
/// [`Self::tool`], and maps the response back. Swapping the provider therefore
/// changes neither the tool id nor its schema.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
pub struct CapabilityToolBinding {
    /// The provider's own fully-qualified tool id (e.g. `"exa.search"`,
    /// `"app.firecrawl_scrape"`) that implements this verb.
    pub tool: String,

    /// Canonical argument name → this provider's argument name. A canonical argument
    /// with no entry is passed through under its own name; map it to the empty string
    /// to drop it (the provider cannot express it).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub args: BTreeMap<String, String>,

    /// Constant arguments merged into every call (provider-specific knobs the
    /// canonical schema does not expose, e.g. `{"search_depth": "advanced"}`).
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub arg_defaults: serde_json::Map<String, serde_json::Value>,

    /// A request-body TEMPLATE this provider needs, with `{canonical_arg}`
    /// placeholders substituted from the call.
    ///
    /// `args` renames flat keys and `[]` wraps a scalar in an array; neither can build
    /// a NESTED shape. Real APIs need them: Mem0's write endpoint takes
    /// `messages: [{role, content}]`, so without a template the whole write half of
    /// that provider is unbindable — which is precisely the gap that made Ryu's
    /// memory bridges inert while Hermes, which writes per-provider adapter CODE, had
    /// none. This closes it declaratively instead of admitting code per provider.
    ///
    /// A string that is EXACTLY `"{arg}"` is replaced by that argument's value with
    /// its JSON type preserved (`5` stays a number); a string merely CONTAINING
    /// `{arg}` interpolates as text. An argument consumed by the template is not also
    /// passed through, so it cannot appear twice under two names.
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub arg_template: serde_json::Map<String, serde_json::Value>,

    /// Per-argument numeric limits this provider can actually honour, keyed by the
    /// **canonical** argument name (before any rename).
    ///
    /// Exists because canonical schemas describe what agents may ask for, while
    /// providers differ in what they accept: `web.search.limit` allows up to 100,
    /// but Brave's `count` maxes at 20. Without this, selecting Brave turns a
    /// perfectly valid `limit: 50` into an upstream 4xx — the swap stops being
    /// transparent, which is the entire point of the facade. Clamping is the right
    /// resolution rather than erroring: the caller asked for "up to N", and fewer
    /// results is a normal outcome, whereas a failed search is not.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub arg_clamp: BTreeMap<String, ArgBounds>,

    /// Optional response normalization into the canonical result shape. Absent = the
    /// provider's output is returned verbatim under `{ provider, raw }`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<CapabilityResponseMap>,

    /// Optional provider-shipped ADAPTER: JavaScript that maps this verb onto the
    /// provider's tool when the shapes are too far apart for the declarative fields
    /// above to bridge.
    ///
    /// The declarative path ([`Self::args`] … [`Self::response`]) stays the default
    /// and covers the ~80% of providers that are a rename plus a field map: no code
    /// review, no sandbox, no supply-chain surface, and a third party ships one file.
    /// But some provider shapes no amount of JSON can express — an async job API that
    /// must be polled (`POST /crawl` → job id → `GET /crawl/{id}`), a token vocabulary
    /// that needs per-provider normalization, a body that must read a `pref:` value.
    /// Growing the grammar one vendor quirk at a time pushed provider-specific logic
    /// into shared kernel code; an adapter puts it back in the provider's own manifest.
    ///
    /// Present = the adapter REPLACES the declarative mapping for this verb: it
    /// receives the canonical arguments and returns the canonical result, and
    /// [`Self::args`] / [`Self::arg_template`] / [`Self::arg_clamp`] / [`Self::response`]
    /// are not applied (the adapter is doing that job). [`Self::tool`] still names the
    /// target and is still the ONLY tool the adapter can reach.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter: Option<CapabilityAdapter>,
}

/// Provider-shipped JavaScript that maps one capability verb onto one provider tool.
///
/// Runs in the SAME Deno sandbox as an `inline_deno` plugin tool, under the same
/// [`crate`-level] grant model: the providing plugin must hold `tool:execute`, so
/// shipping code is a visible, approvable act rather than a silent one.
///
/// The program is handed:
/// - `input` — the canonical verb arguments, after layer defaults are applied.
/// - `defaults` — the provider's resolved `arg_defaults`, including any `pref:`
///   tokens already looked up. This is what lets an adapter read per-install
///   configuration a template could not (`arg_template` expands from the CALLER's
///   arguments, so it can never see a resolved preference).
/// - `callTool(args)` — invokes the provider's own [`CapabilityToolBinding::tool`]
///   and resolves to its raw response. It takes NO tool id: the target is fixed by
///   the manifest, so sandboxed code cannot redirect the call at another tool. An
///   adapter therefore grants no authority the declarative path did not already
///   grant — it is strictly the same single re-entry, expressed as code.
///
/// It returns the canonical result shape, which the facade passes through unchanged.
///
/// **Bounded by the sandbox wall-clock.** A run gets `DEFAULT_DEADLINE_SECS` of
/// active compute, and time spent awaiting a tool call counts against it. An
/// adapter that polls an async job must therefore treat "still running" as a normal
/// outcome to report, not something to wait out.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
pub struct CapabilityAdapter {
    /// The adapter body. Evaluated as the tail of a sandbox program that has already
    /// bound `input`, `defaults`, `callTool` and `callNamed`; it `return`s the
    /// canonical result.
    ///
    /// Empty in a **source** manifest that declares [`Self::code_file`] instead;
    /// [`PluginManifest::hydrate_code_files`] fills it in at parse time and
    /// [`PluginManifest::validate`] refuses a manifest where it is still empty.
    #[serde(default)]
    pub code: String,

    /// Path to the file holding the adapter body, relative to the plugin root
    /// (`adapters/<verb>.js`) — the authoring form. Mutually exclusive with
    /// [`Self::code`]; see [`PluginManifest::hydrate_code_files`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_file: Option<String>,

    /// ADDITIONAL provider tool ids this adapter may call, beyond
    /// [`CapabilityToolBinding::tool`], reachable from the body as
    /// `callNamed(id, args)`.
    ///
    /// Exists because a whole class of real APIs is two calls, not one: an async job
    /// API starts work at one endpoint and reads the result from another
    /// (`POST /crawl` → job id → `GET /crawl/{id}`). A single-tool adapter cannot
    /// express that, so those providers would stay unbindable — the gap that
    /// excluded every async API from every layer.
    ///
    /// This is an ALLOWLIST fixed by the manifest and checked host-side: a name not
    /// listed here (and not [`CapabilityToolBinding::tool`]) is refused. Sandboxed
    /// code chooses only *among* tools the provider declared, never a tool of its
    /// own — which is what keeps the id-taking form from becoming an escalation seam.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
}

/// Inclusive numeric bounds a provider can honour for one canonical argument.
/// Integers, not floats. Every clampable canonical argument is a COUNT — result
/// limits, crawl depth, page caps — so `i64` is the honest type, and it keeps the
/// whole manifest tree `Eq` (a float would force `PartialEq`-only all the way up
/// through `ProvidesEntry` and `PluginManifest`) while avoiding float comparison.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
pub struct ArgBounds {
    /// Smallest value the provider accepts. Absent = no lower bound.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<i64>,
    /// Largest value the provider accepts. Absent = no upper bound.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<i64>,
}

/// Normalizes one provider's response into the capability's canonical shape.
///
/// Deliberately a flat rename table rather than a general transform language: the
/// canonical shapes are small and list-of-records shaped, and a manifest that can
/// run arbitrary extraction logic is a much larger trust surface.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
pub struct CapabilityResponseMap {
    /// Dotted path to the provider's result array within its response (e.g.
    /// `"results"`, `"data.items"`). Absent = the response itself is the array, or —
    /// when it is not an array — a single record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub results: Option<String>,

    /// Canonical per-item field name → the provider's field name (dotted paths
    /// allowed). Fields with no entry are dropped from the canonical item but remain
    /// available under the item's `raw` key.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
}

/// Per-surface support level a plugin declares for a [`Surface`] in the
/// [`PluginManifest::surfaces`] map. Governs both whether the plugin appears on the
/// surface and how much of its UI that surface renders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SurfaceSupport {
    /// Full first-class UI + backend on this surface.
    Full,
    /// A reduced/limited UI (e.g. a read-only or single-pane view).
    Limited,
    /// A list/index entry only (no dedicated page).
    List,
    /// Command-palette / CLI commands only (no rendered UI) — e.g. the TUI tier.
    Commands,
    /// Explicitly unsupported on this surface. Equivalent to omitting the key, made
    /// explicit so a manifest can document intent.
    #[default]
    None,

    /// A support level this build does not know — a manifest written against a newer
    /// Ryu that added a level (say `read-only`).
    ///
    /// Deserializing to this instead of failing is what lets a newer manifest load on
    /// an older Core at all. It counts as **supported**, deliberately: the author said
    /// the plugin works here, just in a way we cannot describe, and the honest
    /// degradation is to offer it and let the surface render what it can. The opposite
    /// choice (treat as [`None`]) would silently delist a plugin from a surface its
    /// author explicitly listed.
    ///
    /// Never write this — it exists only as a deserialization landing pad.
    #[serde(other)]
    Unknown,
}

impl SurfaceSupport {
    /// Whether this level means the plugin appears on the surface at all.
    ///
    /// Everything except [`SurfaceSupport::None`] counts, including
    /// [`SurfaceSupport::Unknown`] — see that variant for why.
    pub const fn is_supported(self) -> bool {
        !matches!(self, SurfaceSupport::None)
    }
}

/// One [`PluginManifest::surfaces`] entry: the support level plus an optional UI
/// descriptor the surface shell resolves (opaque here — pure data).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct SurfaceEntry {
    /// How much of the plugin this surface supports.
    #[serde(default)]
    pub support: SurfaceSupport,

    /// Optional surface-specific UI descriptor (bundle id, mount point, …),
    /// interpreted by the surface's app host. Opaque to the contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<serde_json::Value>,

    /// Terminal subcommands this app contributes to the `cli` surface (the TUI's
    /// `ryu <app> <cmd>` dispatcher). Only meaningful on the `cli` surface entry;
    /// ignored on other surfaces. Empty/absent = the app contributes no commands.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<CliCommandSpec>,
}

/// One terminal subcommand an app contributes to the `cli` surface (the TUI's
/// `ryu <app> <cmd>` dispatcher). Routed through Core's `ext_proxy` to the app's
/// sidecar: Core forwards `<method> /api/ext/<plugin_id><path>`. `path` MUST be a
/// route the app's sidecar declares in `http.routes`, or the proxy 404s.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
pub struct CliCommandSpec {
    /// Subcommand token, e.g. `status` in `ryu mail status`.
    pub name: String,

    /// One-line help shown in `ryu <app>` / `ryu <app> --help`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,

    /// HTTP method for the `ext_proxy` call. Absent = `POST`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,

    /// Sub-path appended after `/api/ext/<plugin_id>`. Validated by
    /// [`validate_cli_command_path`] at manifest load: it MUST be an absolute
    /// (`/`-leading), traversal-free sub-path — no `..` segment in any form — so it
    /// cannot escape the plugin's proxy scope when a URL parser normalizes it.
    pub path: String,
}

/// Validate one [`CliCommandSpec::path`] as a safe `ext_proxy` sub-path.
///
/// The path is concatenated onto `/api/ext/<plugin_id>` on the client and fetched.
/// A WHATWG URL parser resolves `..` path segments — including their percent-encoded
/// (`%2e`) and backslash-separated forms (`\` is a path separator for special/http
/// schemes) — BEFORE the request leaves the process, so a traversal path escapes the
/// `/api/ext/<id>/` scope and reaches an arbitrary internal route with the node
/// bearer. Rejecting these at manifest load is the authoritative gate; the TUI also
/// re-checks defensively (`isSafeCommandPath` in `packages/core-client`).
///
/// Accepts only an absolute, single-origin sub-path: leading `/`, no backslash, no
/// literal or percent-encoded `..`, and no percent-encoded path separators.
pub fn validate_cli_command_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err("path must start with '/'".to_string());
    }
    // `\` is normalized to `/` by the WHATWG URL parser for special (http) schemes,
    // so a backslash can smuggle a `..` traversal segment past a naive `/`-only scan.
    if path.contains('\\') {
        return Err("path must not contain a backslash".to_string());
    }
    let lower = path.to_ascii_lowercase();
    // A literal `..` and its percent-encoded dot forms (`%2e%2e`, `.%2e`, `%2e.`) are
    // all recognized as double-dot path segments and normalized away by the parser.
    if path.contains("..") || lower.contains("%2e") {
        return Err("path must not contain a '..' path-traversal segment".to_string());
    }
    // Percent-encoded separators have no legitimate use in a static route path and
    // could smuggle extra segments past route matching; reject them defensively.
    if lower.contains("%2f") || lower.contains("%5c") {
        return Err("path must not contain percent-encoded path separators".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeclarativeHttpUse {
    Action,
    Source,
}

const DECLARATIVE_ACTION_METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE"];

/// Validate the shared opaque contribution vocabulary without turning it into a
/// second lossy schema. The walk recognizes the two executable seams (`source` /
/// `state_source` and `http`) and deliberately skips request bodies/opaque args so
/// data that happens to contain an `http` key is never mistaken for executable
/// configuration.
fn validate_declarative_http_contributions(
    plugin_id: &str,
    contributes: &Contributes,
    allow_core_routes: bool,
) -> Result<(), String> {
    let mut roots: Vec<(String, &serde_json::Value)> = Vec::new();
    for (index, value) in contributes.composer_controls.iter().enumerate() {
        roots.push((format!("composer_controls[{index}]"), value));
    }
    for (index, view) in contributes.views.iter().enumerate() {
        if let Some(spec) = view.spec.as_ref() {
            roots.push((format!("views[{index}].spec"), spec));
        }
    }
    for (index, section) in contributes.sidebar_sections.iter().enumerate() {
        if let Some(spec) = section.spec.as_ref() {
            roots.push((format!("sidebar_sections[{index}].spec"), spec));
        }
    }
    for (index, tab) in contributes.store_tabs.iter().enumerate() {
        if let Some(spec) = tab.spec.as_ref() {
            roots.push((format!("store_tabs[{index}].spec"), spec));
        }
    }
    for (index, activity) in contributes.live_activities.iter().enumerate() {
        if let Some(spec) = activity.spec.as_ref() {
            roots.push((format!("live_activities[{index}].spec"), spec));
        }
    }
    for (index, value) in contributes.message_actions.iter().enumerate() {
        roots.push((format!("message_actions[{index}]"), value));
    }

    for (label, value) in roots {
        validate_declarative_http_value(
            plugin_id,
            value,
            DeclarativeHttpUse::Action,
            allow_core_routes,
            &label,
        )?;
    }
    Ok(())
}

fn validate_declarative_http_value(
    plugin_id: &str,
    value: &serde_json::Value,
    usage: DeclarativeHttpUse,
    allow_core_routes: bool,
    label: &str,
) -> Result<(), String> {
    match value {
        serde_json::Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                validate_declarative_http_value(
                    plugin_id,
                    child,
                    usage,
                    allow_core_routes,
                    &format!("{label}[{index}]"),
                )?;
            }
        }
        serde_json::Value::Object(object) => {
            if let Some(http) = object.get("http") {
                validate_declarative_http_request(
                    plugin_id,
                    http,
                    usage,
                    allow_core_routes,
                    &format!("{label}.http"),
                )?;
            }
            for (key, child) in object {
                if matches!(
                    key.as_str(),
                    "http" | "body" | "args" | "payload" | "map" | "filter" | "cells"
                ) {
                    continue;
                }
                let child_usage = if matches!(key.as_str(), "source" | "state_source") {
                    DeclarativeHttpUse::Source
                } else {
                    DeclarativeHttpUse::Action
                };
                validate_declarative_http_value(
                    plugin_id,
                    child,
                    child_usage,
                    allow_core_routes,
                    &format!("{label}.{key}"),
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_declarative_http_request(
    plugin_id: &str,
    value: &serde_json::Value,
    usage: DeclarativeHttpUse,
    allow_core_routes: bool,
    label: &str,
) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{label} must be an object"))?;
    let path = object
        .get("path")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("{label}.path must be a string"))?;
    let method = object
        .get("method")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("GET");
    match usage {
        DeclarativeHttpUse::Source if method != "GET" => {
            return Err(format!(
                "{label} automatic sources must use GET, got '{method}'"
            ));
        }
        DeclarativeHttpUse::Action if !DECLARATIVE_ACTION_METHODS.contains(&method) => {
            return Err(format!("{label} uses unsupported method '{method}'"));
        }
        _ => {}
    }

    validate_declarative_core_path(path).map_err(|error| format!("{label}.path {error}"))?;
    if allow_core_routes {
        return Ok(());
    }
    let pathname = path.split(['?', '#']).next().unwrap_or(path);
    let owner_mount = format!("/api/ext/{plugin_id}");
    if pathname != owner_mount && !pathname.starts_with(&format!("{owner_mount}/")) {
        return Err(format!(
            "{label}.path '{path}' is outside the owning app mount '{owner_mount}'"
        ));
    }
    Ok(())
}

fn validate_declarative_core_path(path: &str) -> Result<(), String> {
    if path.starts_with("//") {
        return Err("must not be protocol-relative".to_string());
    }
    let pathname = path.split(['?', '#']).next().unwrap_or(path);
    validate_cli_command_path(pathname)?;
    let is_workflow = pathname == "/workflows" || pathname.starts_with("/workflows/");
    if !pathname.starts_with("/api/") && !is_workflow {
        return Err("must be a Core-relative /api/ or /workflows path".to_string());
    }
    Ok(())
}

/// A single plugin-to-plugin dependency edge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AppDependency {
    /// The `id` of the plugin this one depends on.
    pub id: String,

    /// Optional **minimum** version the dependency must satisfy.
    ///
    /// A bare version (`"1.2.0"`) is a *minimum*, i.e. `">=1.2.0"` — deliberately
    /// NOT semver's default caret (`^1.2.0`), which would reject `2.0.0`. Explicit
    /// comparator syntax (`">=1.2, <2"`, `"^1.2"`, `"~1.2"`) is honoured verbatim.
    /// See [`parse_min_version`], the single parser both validation and resolution
    /// use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_version: Option<String>,
}

/// A host surface a plugin can declare support for via `targets`.
///
/// `core` is the headless node (a Core running with no UI at all).
///
/// An **empty/absent** `targets` list means the plugin runs on *every* surface —
/// that is the backward-compatible default and MUST NOT be read as "hidden".
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum Surface {
    /// The Ryu Gateway.
    Gateway,
    /// A headless Core node (no UI).
    Core,
    /// The Tauri desktop app.
    Desktop,
    /// The Electron dynamic-island companion.
    Island,
    /// The Expo/React-Native mobile app.
    Mobile,
    /// The browser extension.
    Extension,
    /// The Next.js web app.
    Web,
    /// The terminal client.
    Cli,

    /// A surface this build has never heard of — a manifest written against a newer
    /// Ryu that added one.
    ///
    /// Before this variant existed, an unrecognised surface token failed
    /// deserialization and took the **entire manifest** down with it, so one new
    /// surface in a future release would break the plugin on every older client. Now
    /// it lands here and reads as "not this surface", which is what an older client
    /// should conclude.
    ///
    /// Two rules keep it honest:
    /// - It never equals a real surface, so it can only ever *narrow* support, never
    ///   widen it. [`PluginManifest::supports_surface`] is only ever asked about real
    ///   surfaces, and no real surface is `Unknown`.
    /// - [`Surface::parse`] still returns `None` for an unknown token, so this variant
    ///   is unreachable from the `x-ryu-surface` header. That asymmetry is deliberate:
    ///   an unknown *caller* means "do not filter", while an unknown *declaration*
    ///   means "not here". Collapsing the two would let a client opt out of filtering
    ///   by sending a garbage surface.
    ///
    /// Round-trip caveat: re-serializing a manifest that carried an unknown surface
    /// emits `"unknown"` rather than the original token. Only the SDK bindings
    /// (`crates/sdk/*`) re-serialize a parsed manifest, and they hand it to a client
    /// that could not have handled the real token either. Nothing writes a parsed
    /// manifest back to its source file.
    #[serde(other)]
    Unknown,
}

impl Surface {
    /// The key this surface's floor is written under inside a manifest's
    /// [`EnginesReq`] block.
    ///
    /// Identical to [`Surface::as_str`] except for [`Surface::Core`], whose floor is
    /// spelled `ryu` for backwards compatibility. Use this — never `as_str` — when
    /// naming the offending key in a diagnostic, or the message points an author at
    /// an `engines.core` key that does not exist.
    pub const fn engines_key(self) -> &'static str {
        match self {
            Surface::Core => "ryu",
            other => other.as_str(),
        }
    }

    /// Stable kebab-case identifier — the exact token used on the wire (in a
    /// manifest's `targets` and in the `x-ryu-surface` request header).
    pub const fn as_str(self) -> &'static str {
        match self {
            Surface::Gateway => "gateway",
            Surface::Core => "core",
            Surface::Desktop => "desktop",
            Surface::Island => "island",
            Surface::Mobile => "mobile",
            Surface::Extension => "extension",
            Surface::Web => "web",
            Surface::Cli => "cli",
            Surface::Unknown => "unknown",
        }
    }

    /// Parse a surface token (e.g. the `x-ryu-surface` header). Case-insensitive.
    /// Returns `None` for an unknown surface, which callers MUST treat as
    /// "unknown caller → do not filter" rather than "filter everything out".
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "gateway" => Some(Surface::Gateway),
            "core" => Some(Surface::Core),
            "desktop" => Some(Surface::Desktop),
            "island" => Some(Surface::Island),
            "mobile" => Some(Surface::Mobile),
            "extension" => Some(Surface::Extension),
            "web" => Some(Surface::Web),
            "cli" => Some(Surface::Cli),
            _ => None,
        }
    }
}

/// Parse a dependency `min_version` into a [`semver::VersionReq`].
///
/// **The single definition** of the min-version semantics, used by both the
/// manifest shape-validation (which rejects a malformed requirement at load) and
/// the graph resolver (which checks satisfiability against the installed set).
///
/// A bare version is a **minimum**, not a caret range:
/// `"1.2.0"` → `">=1.2.0"` (so an installed `2.0.0` satisfies it). This differs
/// from [`semver::VersionReq::parse`], whose bare form means `^1.2.0` and would
/// reject `2.0.0`. Anything that is not a bare version (`"^1.2"`, `">=1.0, <2"`,
/// `"*"`) is passed through to `VersionReq` verbatim.
pub fn parse_min_version(raw: &str) -> Result<semver::VersionReq, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("min_version must not be empty".to_string());
    }
    // A bare, fully-qualified version means ">= that version".
    if let Ok(v) = semver::Version::parse(trimmed) {
        return semver::VersionReq::parse(&format!(">={v}"))
            .map_err(|e| format!("invalid min_version '{raw}': {e}"));
    }
    // Otherwise it is comparator syntax — honour it as written.
    semver::VersionReq::parse(trimmed).map_err(|e| format!("invalid min_version '{raw}': {e}"))
}

/// The trust/distribution tier of a plugin.
///
/// - [`PluginTier::Core`] — a first-party, default-on plugin shipped with Ryu
///   (ghost/shadow/headroom/engines/sandbox/…). Seeded enabled at startup.
/// - [`PluginTier::Community`] — a third-party / user-installed plugin. Always
///   install-then-enable opt-in; never auto-enabled.
///
/// Tier is **derived from membership** (see Core's `plugins::builtins`), not a
/// field a manifest can self-assert — a plugin cannot promote itself to Core.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginTier {
    /// First-party, default-on.
    Core,
    /// Third-party / user-installed, opt-in.
    Community,
}

impl PluginTier {
    /// Stable lowercase identifier for the tier (for the `GET /api/plugins` JSON).
    pub const fn as_str(self) -> &'static str {
        match self {
            PluginTier::Core => "core",
            PluginTier::Community => "community",
        }
    }
}

// ── Unified permission grammar (one deny-by-default set) ──────────────────────

/// The single, typed, **deny-by-default** permission set a plugin manifest
/// declares, lowered by Core to every sandbox backend.
///
/// This is the one grammar that replaces three historically-disjoint ones:
/// the wasmtime/Docker [`crate`]-external `SandboxCapabilities` (typed but
/// unreachable from a manifest), the Deno PTC's hardcoded zero-allow-flag spawn,
/// and the opaque grant strings. A manifest declares ONE `permissions` block and
/// Core lowers it to WASI preopens, Docker mount/network flags, or Deno
/// `--allow-*` flags as appropriate.
///
/// **Every field defaults to empty/false — the zero value is deny-all.** A missing
/// `permissions` block (or an explicit `{}`) is byte-for-byte the same posture as
/// today's zero-permission sandbox, which is what preserves the existing live
/// deny-all tests.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
pub struct PermissionSet {
    /// Filesystem read/write path allowlists. Empty = no FS access.
    #[serde(default, skip_serializing_if = "FsPermissions::is_empty")]
    pub fs: FsPermissions,

    /// Whether the sandboxed code may spawn child processes. `false` (default) =
    /// no subprocess execution. Lowers to Deno's `--allow-run`; the wasmtime/Docker
    /// lowering has no subprocess channel to open, so this is a no-op there (a WASI
    /// module cannot fork, and the Docker exec is a single fixed argv).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub child_process: bool,

    /// Executable names sandboxed code may spawn when [`Self::child_process`] is
    /// true. Core lowers this to Deno's scoped `--allow-run=<name,...>` list in
    /// addition to declared capability shims. Empty grants no arbitrary binary.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub run: Vec<String>,

    /// Outbound network permission. `false`/absent (default) = no network; `true` =
    /// all hosts; a list of `host[:port]` entries = only those hosts (the shape
    /// Deno's `--allow-net` supports). See [`NetworkPermission`].
    #[serde(default, skip_serializing_if = "NetworkPermission::is_deny")]
    pub network: NetworkPermission,

    /// **Declaration-only** in v1: the registry tool ids this plugin's sandboxed
    /// code may call through the stdio `tools.*` bridge. Tools are brokered over
    /// stdout/stdin by Core (never an OS capability), so this does NOT lower to any
    /// `--allow-*` flag; it records intent and is a clean future extension for the
    /// `SandboxToolInvoker` allowlist. Empty (default) records no extra tool intent.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool: Vec<String>,
}

impl PermissionSet {
    /// Validate the declared paths and hosts. Each FS path and each network host
    /// must be **non-empty** and must not contain a `..` traversal segment (a path
    /// that could escape its intended root once lowered to a real preopen/mount).
    pub fn validate(&self) -> Result<(), String> {
        for (label, paths) in [("fs.read", &self.fs.read), ("fs.write", &self.fs.write)] {
            for path in paths {
                if path.trim().is_empty() {
                    return Err(format!("permissions.{label} contains an empty path"));
                }
                if path.contains("..") {
                    return Err(format!(
                        "permissions.{label} path '{path}' must not contain a '..' traversal segment"
                    ));
                }
            }
        }
        if !self.run.is_empty() && !self.child_process {
            return Err("permissions.run requires permissions.child_process=true".to_string());
        }
        for executable in &self.run {
            let trimmed = executable.trim();
            if trimmed.is_empty()
                || trimmed != executable
                || executable.chars().any(char::is_whitespace)
                || executable.contains('/')
                || executable.contains('\\')
                || executable.contains(',')
                || executable == "."
                || executable == ".."
            {
                return Err(format!(
                    "permissions.run executable '{executable}' must be one bare program name"
                ));
            }
        }
        if let NetworkPermission::Hosts(hosts) = &self.network {
            for host in hosts {
                if host.trim().is_empty() {
                    return Err("permissions.network contains an empty host entry".to_string());
                }
            }
        }
        for tool in &self.tool {
            if tool.trim().is_empty() {
                return Err("permissions.tool contains an empty tool id".to_string());
            }
        }
        Ok(())
    }
}

/// Filesystem read/write path allowlists. Empty sets = no filesystem access, which
/// is the deny-all default.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
pub struct FsPermissions {
    /// Absolute paths the sandbox may **read**. Empty = no read access.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub read: Vec<String>,
    /// Absolute paths the sandbox may **write**. Empty = no write access.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub write: Vec<String>,
}

impl FsPermissions {
    /// Whether both path sets are empty (the deny-all default) — the
    /// `skip_serializing_if` predicate that keeps a bare permission set lean.
    pub fn is_empty(&self) -> bool {
        self.read.is_empty() && self.write.is_empty()
    }
}

/// Outbound network permission, in the shape Deno's `--allow-net` supports: a bare
/// boolean (`false` = deny all, `true` = allow all) or an explicit `host[:port]`
/// allowlist.
///
/// Untagged so the wire form is natural: `false` / `true` deserialize to
/// [`NetworkPermission::All`]; a JSON array deserializes to
/// [`NetworkPermission::Hosts`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum NetworkPermission {
    /// Allow all hosts (`true`) or none (`false`).
    All(bool),
    /// Allow only these `host[:port]` entries.
    Hosts(Vec<String>),
}

impl Default for NetworkPermission {
    /// Deny-all: `All(false)`.
    fn default() -> Self {
        NetworkPermission::All(false)
    }
}

impl NetworkPermission {
    /// Whether this permission denies **all** network access — `All(false)` or an
    /// empty host list. The deny-all default and the `skip_serializing_if`
    /// predicate that keeps a bare permission set lean.
    pub fn is_deny(&self) -> bool {
        match self {
            NetworkPermission::All(allowed) => !*allowed,
            NetworkPermission::Hosts(hosts) => hosts.is_empty(),
        }
    }

    /// Whether **any** outbound network is permitted (the inverse of
    /// [`Self::is_deny`]). Used by the wasmtime/Docker lowering, whose network knob
    /// is a single boolean (host-scoping only lowers to Deno's `--allow-net=…`).
    pub fn is_allowed(&self) -> bool {
        !self.is_deny()
    }
}

/// One entry in an app's **user-facing permission vocabulary** — a level an admin
/// can grant to a person or a team inside that app (see
/// [`PluginManifest::permission_levels`], which also explains why this is a
/// different axis from `permission_grants` and `permissions`).
///
/// Deliberately self-describing: an admin UI renders the grant picker from `label`
/// + `description` alone, so a level whose meaning lives only in the app's own docs
/// cannot exist.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
pub struct PermissionLevel {
    /// Stable machine id (e.g. `"read"`). Lower-case ASCII alphanumerics plus
    /// `-`, `_` and `.`, at most [`MAX_PLUGIN_ID_LEN`] bytes, and unique within the
    /// manifest.
    ///
    /// The alphabet is narrower than a plugin id's on purpose: these ids end up in
    /// API paths and in persisted grant strings, so `Read` and `read` must not be
    /// two levels that look identical to a human granting them.
    pub id: String,

    /// Short human label for the grant picker (e.g. `"Can edit"`). Required —
    /// an unlabelled level is unrenderable.
    pub label: String,

    /// One sentence telling an admin what granting this level actually allows.
    /// Required for the same reason as [`label`]: the admin deciding is usually
    /// not the person who wrote the app.
    ///
    /// [`label`]: PermissionLevel::label
    pub description: String,

    /// Ids of other levels in **this same manifest** that this level subsumes.
    ///
    /// This is the whole ordering mechanism — there is no separate rank, so the
    /// order can never contradict itself. `edit` implying `read` means a person
    /// granted `edit` already holds `read`; granting both is redundant, never
    /// required. Resolved transitively by
    /// [`resolve_implied_permission_levels`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub implies: Vec<String>,
}

/// Validate a declared permission vocabulary: every id is well-formed and unique,
/// every level is renderable, and the implication graph is closed and acyclic.
///
/// Called from [`PluginManifest::validate`] (the SDK/FFI path) and from Core's
/// manifest loader, so a malformed vocabulary fails where the author can still see
/// it rather than at the moment an admin tries to grant a level that does not
/// resolve.
pub fn validate_permission_levels(levels: &[PermissionLevel]) -> Result<(), String> {
    let mut index: BTreeMap<&str, usize> = BTreeMap::new();
    for (position, level) in levels.iter().enumerate() {
        validate_permission_level_id(&level.id)?;
        if level.label.trim().is_empty() {
            return Err(format!(
                "permission level '{}' has an empty label",
                level.id
            ));
        }
        if level.description.trim().is_empty() {
            return Err(format!(
                "permission level '{}' has an empty description",
                level.id
            ));
        }
        if index.insert(level.id.as_str(), position).is_some() {
            return Err(format!("duplicate permission level id '{}'", level.id));
        }
    }

    // Closed graph first: a dangling `implies` is the likelier authoring mistake (a
    // typo), and reporting it as a typo is far more useful than whatever the cycle
    // walk below would say about an edge that resolves to nothing.
    for level in levels {
        for implied in &level.implies {
            if !index.contains_key(implied.as_str()) {
                return Err(format!(
                    "permission level '{}' implies '{implied}', which this manifest does not declare",
                    level.id
                ));
            }
        }
    }

    // Three-colour DFS. A cycle is not merely redundant: if `edit` implies `read`
    // implies `edit`, the two levels are indistinguishable, so granting the weaker
    // one silently conveys the stronger — an admin cannot express "read only" at
    // all. Iterative rather than recursive because the level count comes from an
    // untrusted manifest and a long chain would otherwise blow the stack.
    #[derive(Clone, Copy, PartialEq)]
    enum Visit {
        Unseen,
        Open,
        Done,
    }
    let mut visit = vec![Visit::Unseen; levels.len()];
    let mut stack: Vec<(usize, usize)> = Vec::new();
    for root in 0..levels.len() {
        if visit[root] != Visit::Unseen {
            continue;
        }
        visit[root] = Visit::Open;
        stack.push((root, 0));
        while let Some(&(node, cursor)) = stack.last() {
            let Some(next) = levels[node].implies.get(cursor) else {
                visit[node] = Visit::Done;
                stack.pop();
                continue;
            };
            let top = stack.len() - 1;
            stack[top].1 = cursor + 1;
            let child = index[next.as_str()];
            match visit[child] {
                // Also catches self-implication (`edit` implies `edit`), which is a
                // one-node cycle and just as unexpressible.
                Visit::Open => {
                    return Err(format!(
                        "permission level '{}' implies '{}', which closes an implication cycle",
                        levels[node].id, levels[child].id
                    ))
                }
                Visit::Done => {}
                Visit::Unseen => {
                    visit[child] = Visit::Open;
                    stack.push((child, 0));
                }
            }
        }
    }
    Ok(())
}

/// Every level `id` conveys **transitively**, excluding `id` itself. Empty when
/// `id` is not declared in `levels`.
///
/// This is what makes "granting `edit` already grants `read`" true in one place
/// instead of at every future call site: with `admin → edit → read`, resolving
/// `admin` yields `{edit, read}`, so an admin never has to grant a level twice.
///
/// Terminates on a cyclic vocabulary even though [`validate_permission_levels`]
/// rejects one — the visited set is the loop bound — so a caller holding levels
/// from an unvalidated source cannot hang.
pub fn resolve_implied_permission_levels(levels: &[PermissionLevel], id: &str) -> BTreeSet<String> {
    let by_id: BTreeMap<&str, &PermissionLevel> =
        levels.iter().map(|l| (l.id.as_str(), l)).collect();
    let mut implied = BTreeSet::new();
    let Some(root) = by_id.get(id) else {
        return implied;
    };
    let mut pending: Vec<&str> = root.implies.iter().map(String::as_str).collect();
    while let Some(next) = pending.pop() {
        if !implied.insert(next.to_string()) {
            continue;
        }
        if let Some(level) = by_id.get(next) {
            pending.extend(level.implies.iter().map(String::as_str));
        }
    }
    implied
}

/// The narrow alphabet for a [`PermissionLevel::id`]. See that field for why it is
/// stricter than [`validate_plugin_id`].
pub fn validate_permission_level_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("a permission level has an empty id".to_string());
    }
    if id.len() > MAX_PLUGIN_ID_LEN {
        return Err(format!(
            "permission level id '{id}' is too long ({} bytes, max {MAX_PLUGIN_ID_LEN})",
            id.len()
        ));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-' | '_'))
    {
        return Err(format!(
            "permission level id '{id}' contains illegal characters (allowed: a-z 0-9 . - _)"
        ));
    }
    // The alphabet admits `.`, so it also admits `..` — and these ids are destined
    // for API paths, where a `..` segment is a traversal escape.
    if id.contains("..") {
        return Err(format!(
            "permission level id '{id}' must not contain a '..' traversal segment"
        ));
    }
    Ok(())
}

/// Whether two route patterns can match at least one same path. Route patterns use
/// literal segments, one-segment `:params`, and trailing `*rest` wildcards. This is
/// intentionally conservative: a manifest with ambiguous auth postures must fail
/// validation instead of relying on declaration order at the proxy.
fn route_segments(path: &str) -> Vec<&str> {
    let path = path.trim_matches('/');
    if path.is_empty() {
        Vec::new()
    } else {
        path.split('/').collect()
    }
}

fn route_patterns_overlap(left: &str, right: &str) -> bool {
    let left = route_segments(left);
    let right = route_segments(right);
    let common_len = left.len().min(right.len());

    for index in 0..common_len {
        let left_segment = left[index];
        let right_segment = right[index];
        if left_segment.starts_with('*') || right_segment.starts_with('*') {
            return true;
        }
        if left_segment.starts_with(':')
            || right_segment.starts_with(':')
            || left_segment == right_segment
        {
            continue;
        }
        return false;
    }

    if left.len() == right.len() {
        return true;
    }
    let remaining = if left.len() > common_len {
        left[common_len]
    } else {
        right[common_len]
    };
    remaining.starts_with('*')
}

/// Rank a route using the same precedence as Core's sidecar proxy: non-wildcard
/// routes first, then more literal segments, then more segments. Equal-specificity
/// overlaps are rejected, so declaration order never decides an auth posture.
pub fn route_specificity(path: &str) -> (bool, usize, usize) {
    let mut literals = 0;
    let mut segment_count = 0;
    let mut has_wildcard = false;
    for segment in route_segments(path) {
        segment_count += 1;
        if segment.starts_with('*') {
            has_wildcard = true;
        } else if !segment.starts_with(':') {
            literals += 1;
        }
    }
    (!has_wildcard, literals, segment_count)
}

fn earlier_route_wins(left: &str, right: &str) -> bool {
    route_specificity(left) > route_specificity(right)
}

/// Validate every proxied route's permission annotation against the vocabulary the
/// SAME manifest declares.
///
/// A route naming a level nobody declared is a manifest ERROR rather than a route
/// that quietly never resolves: the id would reach Core's permission registry
/// undeclared, the resolver would deny it, and the app's route would return 403
/// forever with the mistake visible nowhere. Failing at load puts it in front of the
/// author, who is the only person who can fix it.
pub fn validate_route_permissions(
    sidecars: &[crate::schema::SidecarSpec],
    levels: &[PermissionLevel],
) -> Result<(), String> {
    let routes: Vec<&crate::schema::RouteSpec> = sidecars
        .iter()
        .filter_map(|sidecar| sidecar.http.as_ref())
        .flat_map(|http| http.routes.iter())
        .collect();
    for (route_index, route) in routes.iter().enumerate() {
        for other in routes.iter().skip(route_index + 1) {
            let methods_overlap =
                route.method.is_none() || other.method.is_none() || route.method == other.method;
            if methods_overlap
                && route_patterns_overlap(&route.path, &other.path)
                && !earlier_route_wins(&route.path, &other.path)
            {
                return Err(format!(
                    "route patterns '{}' and '{}' overlap for methods {:?} and {:?}; the earlier route must be strictly more specific",
                    route.path, other.path, route.method, other.method
                ));
            }
        }
    }

    for sidecar in sidecars {
        let Some(http) = &sidecar.http else { continue };
        for route in &http.routes {
            if let Some(method) = route.method.as_deref() {
                const SUPPORTED_METHODS: &[&str] =
                    &["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];
                if !SUPPORTED_METHODS.contains(&method) {
                    return Err(format!(
                        "route '{}' declares unsupported or non-canonical method '{method}'",
                        route.path
                    ));
                }
            }
            let Some(permission) = route.permission.as_deref() else {
                // A resource param with nothing to gate is dead weight that reads
                // like a rule, so it is refused rather than ignored.
                if route.resource_param.is_some() {
                    return Err(format!(
                        "route '{}' declares resource_param without a permission",
                        route.path
                    ));
                }
                if !levels.is_empty()
                    && matches!(route.auth, crate::schema::RouteAuth::Protected)
                    && route.path != sidecar.health_path
                {
                    return Err(format!(
                        "route '{}' has no permission even though this manifest declares permission_levels",
                        route.path
                    ));
                }
                continue;
            };
            if !levels.iter().any(|level| level.id == permission) {
                return Err(format!(
                    "route '{}' requires permission '{permission}', which this manifest does not declare",
                    route.path
                ));
            }
            // A Public route serves callers who hold NO identity (an inbound
            // webhook). On an org-bound node an anonymous caller is refused
            // outright, so the annotation would turn a working webhook into a
            // permanent 403 — and it would fail at delivery time, on someone
            // else's infrastructure, long after the manifest was written. The
            // field's doc comment already forbids this; without the check it was
            // only a suggestion.
            if matches!(route.auth, crate::schema::RouteAuth::Public) {
                return Err(format!(
                    "route '{}' is public but requires permission '{permission}'; a public route \
                     has no caller identity to check, so this would deny it outright on an \
                     org-bound node",
                    route.path
                ));
            }
            let Some(param) = route.resource_param.as_deref() else {
                continue;
            };
            // Matched against the pattern's own segments, not a substring search: a
            // param named `id` must not be satisfied by a literal `/ids` segment.
            let declared = route
                .path
                .split('/')
                .any(|segment| segment.strip_prefix(':') == Some(param));
            if !declared {
                return Err(format!(
                    "route '{}' names resource_param ':{param}', which its path does not contain",
                    route.path
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runnable::RunnableKind;

    fn provider_manifest(
        tool_slug: &str,
        backend: &str,
        bound_tool: &str,
        adapter_tools: &[&str],
        mcp_server: bool,
    ) -> String {
        let mut manifest = serde_json::json!({
            "id": "com.example.provider",
            "name": "Provider",
            "version": "1.0.0",
            "runnables": [],
            "provides": [{
                "capability": "search",
                "version": "1.0.0",
                "tools": {
                    "search": {
                        "tool": bound_tool,
                        "adapter": {
                            "code": "return input;",
                            "tools": adapter_tools
                        }
                    }
                }
            }]
        });
        if !mcp_server {
            manifest["runnables"] = serde_json::json!([{
                "id": "provider-search",
                "name": "Provider search",
                "kind": "tool",
                "config": {
                    "slug": tool_slug,
                    "backend": backend,
                    "url": "https://provider.example/search"
                }
            }]);
        } else {
            manifest["mcp_servers"] = serde_json::json!({
                "provider": { "command": "provider-mcp" }
            });
        }
        serde_json::to_string(&manifest).expect("provider manifest serializes")
    }

    #[test]
    fn capability_binding_must_target_a_provider_owned_native_tool() {
        let raw = provider_manifest("provider.search", "http", "provider.search", &[], false);
        assert!(PluginManifest::parse_and_validate(&raw).is_ok());

        let alias = provider_manifest("provider.search", "alias", "provider.search", &[], false);
        let error =
            PluginManifest::parse_and_validate(&alias).expect_err("aliases do not own tools");
        assert!(error.contains("not owned by this provider"), "{error}");

        let cross_provider =
            provider_manifest("provider.search", "http", "other.search", &[], false);
        let error = PluginManifest::parse_and_validate(&cross_provider)
            .expect_err("a provider cannot bind another plugin's tool");
        assert!(error.contains("other.search"), "{error}");
    }

    #[test]
    fn capability_binding_accepts_declared_mcp_tools_and_checks_adapter_targets() {
        let mcp = provider_manifest("ignored", "alias", "provider.search", &[], true);
        assert!(PluginManifest::parse_and_validate(&mcp).is_ok());

        let cross_provider_adapter = provider_manifest(
            "provider.search",
            "http",
            "provider.search",
            &["other.lookup"],
            false,
        );
        let error = PluginManifest::parse_and_validate(&cross_provider_adapter)
            .expect_err("adapter callNamed targets must be provider-owned");
        assert!(error.contains("other.lookup"), "{error}");
    }

    // ── host version floors (engines) ──────────────────────────────────────────

    fn engines(ryu: &str) -> EnginesReq {
        EnginesReq {
            ryu: ryu.to_owned(),
            ..Default::default()
        }
    }

    #[test]
    fn no_engines_block_is_satisfied() {
        let v = HostVersions::default().evaluate(None);
        assert!(v.compatible);
        assert!(v.unmet.is_empty());
    }

    #[test]
    fn a_satisfied_core_floor_is_compatible() {
        let hosts = HostVersions::default().with(Surface::Core, "0.1.12");
        let v = hosts.evaluate(Some(&engines(">=0.1.0")));
        assert!(v.compatible, "0.1.12 satisfies >=0.1.0");
        assert!(v.unmet.is_empty());
    }

    #[test]
    fn an_unsatisfied_core_floor_blocks_and_reports_both_versions() {
        let hosts = HostVersions::default().with(Surface::Core, "0.1.12");
        let v = hosts.evaluate(Some(&engines(">=0.2.0")));
        assert!(!v.compatible);
        assert_eq!(
            v.unmet,
            vec![UnmetRequirement::TooOld {
                surface: Surface::Core,
                required: ">=0.2.0".to_owned(),
                present: "0.1.12".to_owned(),
            }]
        );
        assert_eq!(v.blocking().count(), 1);
    }

    /// The whole point of the design: Core cannot observe desktop/island/mobile, and
    /// refusing on that would delist every plugin from every surface it cannot see.
    #[test]
    fn an_unknown_surface_version_is_advisory_never_blocking() {
        let hosts = HostVersions::default().with(Surface::Core, "0.1.12");
        let req = EnginesReq {
            ryu: ">=0.1.0".to_owned(),
            mobile: Some(">=9.0.0".to_owned()),
            ..Default::default()
        };
        let v = hosts.evaluate(Some(&req));
        assert!(
            v.compatible,
            "an unobservable surface must not block the install"
        );
        assert_eq!(
            v.unmet,
            vec![UnmetRequirement::Unknown {
                surface: Surface::Mobile,
                required: ">=9.0.0".to_owned(),
            }],
            "but it must still be REPORTED so the UI can warn"
        );
        assert_eq!(v.blocking().count(), 0);
    }

    /// A client that DOES know its own version turns the advisory into a refusal.
    #[test]
    fn a_client_overlaying_its_own_version_upgrades_unknown_to_too_old() {
        let req = EnginesReq {
            ryu: ">=0.1.0".to_owned(),
            desktop: Some(">=2.0.0".to_owned()),
            ..Default::default()
        };
        let hosts = HostVersions::default()
            .with(Surface::Core, "0.1.12")
            .with(Surface::Desktop, "1.4.0");
        let v = hosts.evaluate(Some(&req));
        assert!(!v.compatible);
        assert_eq!(v.unmet[0].surface(), Surface::Desktop);
        assert!(v.unmet[0].is_blocking());
    }

    /// Regression guard: semver says a prerelease does NOT satisfy a plain `>=`
    /// range, so comparing `0.1.12-nightly.3` against `>=0.1.0` verbatim would mark
    /// EVERY plugin incompatible on EVERY nightly build.
    #[test]
    fn a_prerelease_host_still_satisfies_a_plain_floor() {
        let hosts = HostVersions::default().with(Surface::Core, "0.1.12-nightly.20260728.932");
        let v = hosts.evaluate(Some(&engines(">=0.1.0")));
        assert!(
            v.compatible,
            "a nightly must not be incompatible with everything"
        );
    }

    #[test]
    fn a_v_prefixed_host_version_is_accepted() {
        let hosts = HostVersions::default().with(Surface::Core, "v0.1.12");
        assert!(hosts.evaluate(Some(&engines(">=0.1.0"))).compatible);
    }

    /// A gate that cannot decide must refuse.
    #[test]
    fn an_unparseable_requirement_blocks() {
        let hosts = HostVersions::default().with(Surface::Core, "0.1.12");
        let v = hosts.evaluate(Some(&engines("not-a-range")));
        assert!(!v.compatible);
        assert!(matches!(
            v.unmet[0],
            UnmetRequirement::InvalidRequirement { .. }
        ));
    }

    /// A malformed LOCAL version is the evaluator's own data — it must degrade to
    /// unknown (advisory), not make every plugin look incompatible.
    #[test]
    fn an_unparseable_host_version_degrades_to_unknown() {
        let hosts = HostVersions::default().with(Surface::Core, "garbage");
        let v = hosts.evaluate(Some(&engines(">=0.1.0")));
        assert!(v.compatible);
        assert!(matches!(v.unmet[0], UnmetRequirement::Unknown { .. }));
    }

    #[test]
    fn floor_for_maps_core_onto_the_legacy_ryu_key() {
        let req = engines(">=0.1.0");
        assert_eq!(req.floor_for(Surface::Core), Some(">=0.1.0"));
        assert_eq!(req.floor_for(Surface::Gateway), None);
        assert_eq!(
            req.floor_for(Surface::Unknown),
            None,
            "a surface this build cannot resolve has no evaluable floor"
        );
    }

    #[test]
    fn declared_floors_lists_every_declared_surface_core_first() {
        let req = EnginesReq {
            ryu: ">=0.1.0".to_owned(),
            gateway: Some(">=0.1.5".to_owned()),
            mobile: Some(">=1.0.0".to_owned()),
            ..Default::default()
        };
        assert_eq!(
            req.declared_floors(),
            vec![
                (Surface::Core, ">=0.1.0"),
                (Surface::Gateway, ">=0.1.5"),
                (Surface::Mobile, ">=1.0.0"),
            ]
        );
    }

    /// Back-compat: a manifest carrying only `{"ryu": …}` must still deserialize,
    /// and must not start serializing eight nulls.
    #[test]
    fn a_legacy_engines_block_round_trips_without_new_keys() {
        let parsed: EnginesReq = serde_json::from_str(r#"{"ryu":">=0.1.0"}"#).unwrap();
        assert_eq!(parsed.ryu, ">=0.1.0");
        assert_eq!(parsed.gateway, None);
        assert_eq!(
            serde_json::to_string(&parsed).unwrap(),
            r#"{"ryu":">=0.1.0"}"#
        );
    }

    #[test]
    fn per_surface_floors_deserialize_from_their_kebab_names() {
        let parsed: EnginesReq = serde_json::from_str(
            r#"{"ryu":">=0.1.0","gateway":">=0.1.5","desktop":">=0.2.0","island":">=0.1.0",
                "mobile":">=1.0.0","cli":">=0.1.0","extension":">=0.1.0","web":">=0.1.0"}"#,
        )
        .unwrap();
        assert_eq!(parsed.declared_floors().len(), 8);
    }

    #[test]
    fn validate_plugin_id_accepts_bare_and_dotted_rejects_traversal() {
        assert!(validate_plugin_id("ghost").is_ok());
        assert!(validate_plugin_id("data-grid-explorer").is_ok());
        assert!(validate_plugin_id("@example/research-assistant").is_ok());
        for bad in [
            "../../etc/x",
            "..",
            "a/../b",
            ".hidden",
            "app.",
            "-lead",
            "",
        ] {
            assert!(validate_plugin_id(bad).is_err(), "'{bad}' must be rejected");
        }
    }

    // ── scoped plugin ids ────────────────────────────────────────────────────

    /// The scoped form is matched as an exact SHAPE. The traversal cases matter most:
    /// a wider character allowlist covering `@` and `/` would make `@a/../../etc`
    /// legal, and the id reaches `PathBuf::join`.
    #[test]
    fn scoped_plugin_ids_are_shape_matched_and_reject_traversal() {
        for ok in [
            "@ryu/meetings",
            "@ryu/skill-editor",
            "@example/research-assistant",
        ] {
            assert!(validate_plugin_id(ok).is_ok(), "'{ok}' must be accepted");
        }
        for bad in [
            "@a/../../etc",   // traversal in the name half
            "@../x/y",        // traversal in the scope half
            "@ryu/a/b",       // more than one slash
            "@ryu/",          // empty name
            "@/meetings",     // empty scope
            "@ryu/.hidden",   // leading dot in name
            "@ryu/-lead",     // leading dash in name
            "@ryu/C:drive",   // Windows drive-qualified component
            "@ryu/a\\b",      // backslash separator
            "ryu/meetings",   // slash without the @ marker
            "@@ryu/meetings", // '@' inside a half
        ] {
            assert!(validate_plugin_id(bad).is_err(), "'{bad}' must be rejected");
        }
    }

    /// Legacy flat ids stay legal forever — the alias map means a third-party
    /// manifest that was never updated must keep loading.
    #[test]
    fn legacy_flat_ids_remain_valid_alongside_scoped_ones() {
        for ok in ["ghost", "data-grid-explorer", "com.acme.research-assistant"] {
            assert!(
                validate_plugin_id(ok).is_ok(),
                "'{ok}' must still be accepted"
            );
        }
    }

    /// A scoped id must never reach a path with its `/` intact: the manifest scanner
    /// is a single-level `read_dir`, so a nested dir is INVISIBLE rather than broken.
    #[test]
    fn scoped_ids_flatten_to_a_single_disk_component() {
        assert_eq!(plugin_dir_name("@ryu/meetings"), "@ryu+meetings");
        assert!(!plugin_dir_name("@ryu/meetings").contains('/'));
        // A legacy id is its own disk name, so nothing on disk moves for them.
        assert_eq!(plugin_dir_name("ghost"), "ghost");
        assert_eq!(
            plugin_dir_name("com.acme.research-assistant"),
            "com.acme.research-assistant"
        );
        // `+` is outside the id alphabet, so the flattened form can never collide
        // with a real id.
        assert!(validate_plugin_id("@ryu+meetings").is_err());
    }

    /// An unknown id passes through unchanged — canonicalization must never invent
    /// a mapping.
    #[test]
    fn canonicalizing_an_unaliased_id_is_identity() {
        assert_eq!(canonical_plugin_id("@ryu/meetings"), "@ryu/meetings");
        assert_eq!(canonical_plugin_id("totally-unknown"), "totally-unknown");
        for (old, new) in LEGACY_PLUGIN_ID_ALIASES {
            assert_eq!(canonical_plugin_id(old), *new, "alias '{old}' must resolve");
            assert_eq!(
                canonical_plugin_id(new),
                *new,
                "canonicalization must be idempotent for '{new}'"
            );
        }
    }

    // ── hook events (the provider half of the hook system) ───────────────────

    fn event(id: &str) -> HookEventContribution {
        HookEventContribution {
            id: id.to_owned(),
            title: "Something happened".to_owned(),
            description: None,
            payload_example: None,
        }
    }

    /// The namespace rule is what makes an app event unable to shadow a Core hook
    /// phase, so it is checked at load rather than trusted at emit.
    #[test]
    fn hook_event_id_must_be_namespaced_to_its_own_plugin() {
        assert!(
            validate_hook_event(&event("com.acme.meet#meeting.ended"), "com.acme.meet").is_ok()
        );

        // Bare (un-namespaced) — this is the shape that could collide with a Core
        // phase, and the exact thing the separator rule exists to reject.
        assert!(validate_hook_event(&event("meeting.ended"), "com.acme.meet").is_err());
        assert!(validate_hook_event(&event("post_assistant_turn"), "com.acme.meet").is_err());

        // Namespaced to somebody ELSE — declaring this would let an app publish a
        // contract in a namespace it cannot emit into.
        assert!(validate_hook_event(&event("com.other.app#thing.done"), "com.acme.meet").is_err());

        // Malformed halves.
        assert!(validate_hook_event(&event("#meeting.ended"), "com.acme.meet").is_err());
        assert!(validate_hook_event(&event("com.acme.meet#"), "com.acme.meet").is_err());
        assert!(validate_hook_event(&event("com.acme.meet#a#b"), "com.acme.meet").is_err());
        assert!(
            validate_hook_event(&event("com.acme.meet#Meeting.Ended"), "com.acme.meet").is_err()
        );
        assert!(validate_hook_event(&event("com.acme.meet#.leading"), "com.acme.meet").is_err());
    }

    /// A titleless event is invisible in the picker, so it is rejected rather than
    /// shipped as a blank row.
    #[test]
    fn hook_event_requires_a_title() {
        let mut e = event("com.acme.meet#meeting.ended");
        e.title = "  ".to_owned();
        assert!(validate_hook_event(&e, "com.acme.meet").is_err());
    }

    /// No Core hook phase may be app-event shaped, and no app event may be
    /// Core-phase shaped. This is the whole collision argument, asserted directly
    /// rather than left as a comment.
    #[test]
    fn core_phase_names_and_app_events_occupy_disjoint_namespaces() {
        for phase in [
            "post_assistant_turn",
            "pre_user_turn",
            "session_start",
            "stop",
            "pre_tool_use",
            "post_tool_use",
            "tool_result",
            "subagent_stop",
            "session_end",
            "notification",
            "context",
            "message_end",
            "session_before_compact",
            "session_compact",
            "model_select",
            "session_tree",
        ] {
            assert!(
                !is_app_event(phase),
                "'{phase}' must not parse as an app event"
            );
        }
        assert!(is_app_event("com.acme.meet#meeting.ended"));
        assert_eq!(
            split_hook_event_id("com.acme.meet#meeting.ended"),
            Some(("com.acme.meet", "meeting.ended"))
        );
    }

    /// Two rows with the same id mean the second silently shadows the first in the
    /// catalog, so the duplicate is a load error.
    #[test]
    fn duplicate_hook_event_ids_are_rejected() {
        let contributes = Contributes {
            hook_events: vec![
                event("com.acme.meet#meeting.ended"),
                event("com.acme.meet#meeting.ended"),
            ],
            ..Default::default()
        };
        assert!(contributes.validate_hook_events("com.acme.meet").is_err());
    }

    #[test]
    fn chat_widget_template_validation_requires_safe_single_backing() {
        let valid = ChatWidgetTemplateContribution {
            id: "meeting.summary".to_owned(),
            title: "Meeting summary".to_owned(),
            description: Some("Summarize the latest meeting".to_owned()),
            triggers: vec!["meeting summary".to_owned()],
            examples: vec!["Summarize my latest meeting".to_owned()],
            backing: ChatWidgetTemplateBacking {
                tool_id: Some("meetings.summarize".to_owned()),
                view_id: None,
            },
            display_mode: "inline".to_owned(),
            safe_action_ids: vec!["refresh".to_owned()],
            availability: "available".to_owned(),
        };
        assert!(validate_chat_widget_templates(&[valid]).is_ok());

        let mut invalid = ChatWidgetTemplateContribution {
            id: "meeting/summary".to_owned(),
            title: "Meeting summary".to_owned(),
            description: None,
            triggers: vec![],
            examples: vec![],
            backing: ChatWidgetTemplateBacking {
                tool_id: Some("meetings.summarize".to_owned()),
                view_id: Some("meeting-summary".to_owned()),
            },
            display_mode: "inline".to_owned(),
            safe_action_ids: vec!["refresh/all".to_owned()],
            availability: "available".to_owned(),
        };
        assert!(validate_chat_widget_templates(&[invalid.clone()]).is_err());
        invalid.id = "meeting.summary".to_owned();
        invalid.backing.view_id = None;
        assert!(validate_chat_widget_templates(&[invalid]).is_err());
    }

    #[test]
    fn unavailable_chat_widget_template_may_omit_binding_for_forward_compatibility() {
        let template = ChatWidgetTemplateContribution {
            id: "future.widget".to_owned(),
            title: "Coming soon".to_owned(),
            description: None,
            triggers: vec!["future widget".to_owned()],
            examples: vec![],
            backing: ChatWidgetTemplateBacking::default(),
            display_mode: "inline".to_owned(),
            safe_action_ids: vec![],
            availability: "coming-soon".to_owned(),
        };
        assert!(validate_chat_widget_templates(&[template]).is_ok());
    }

    /// A consumer may subscribe to an event nothing declares — that is how a
    /// consumer gets installed before its provider, and it must not be a load error.
    #[test]
    fn consuming_an_undeclared_event_is_not_a_load_error() {
        let contributes = Contributes {
            turn_hooks: vec![TurnHookContribution {
                id: "on-meeting-end".to_owned(),
                on: "com.not.installed#meeting.ended".to_owned(),
                priority: 0,
                code: "return {kind:'none'}".to_owned(),
                code_file: None,
                run_when: None,
            }],
            ..Default::default()
        };
        assert!(contributes
            .validate_hook_events("com.acme.consumer")
            .is_ok());
    }

    // ── data categories (danger zone) ────────────────────────────────────────

    fn category(id: &str) -> DataCategoryContribution {
        DataCategoryContribution {
            id: id.to_owned(),
            title: format!("Delete all {id}"),
            noun: id.to_owned(),
            confirm_word: None,
            detail: format!("Every {id} record will be permanently deleted."),
        }
    }

    fn create_action(raw: serde_json::Value) -> Result<(), String> {
        let action: CreateActionContribution =
            serde_json::from_value(raw).map_err(|e| e.to_string())?;
        validate_create_action(&action)
    }

    /// The failure this validation exists for: a create-menu row that navigates
    /// nowhere and invokes nothing still renders, so the user clicks it and the
    /// menu closes with nothing to show for it.
    #[test]
    fn a_create_action_must_do_something_when_clicked() {
        assert!(create_action(serde_json::json!({
            "id": "workflows.new", "label": "New workflow"
        }))
        .is_err());
        assert!(create_action(serde_json::json!({
            "id": "workflows.new", "label": "New workflow", "target": "/workflows/new"
        }))
        .is_ok());
        assert!(create_action(serde_json::json!({
            "id": "x.new", "label": "New thing", "capability": "x.create"
        }))
        .is_ok());
    }

    #[test]
    fn selection_actions_accept_host_dispatch_or_plugin_capability() {
        let host_action = Contributes {
            selection_actions: vec![serde_json::json!({
                "id": "side-chats.explain-selection",
                "label": "Explain",
                "kind": "button",
                "args": { "dispatch": "side-chat.selection", "intent": "explain" }
            })],
            ..Default::default()
        };
        assert!(host_action.validate_settings_contributions().is_ok());

        let plugin_action = Contributes {
            selection_actions: vec![serde_json::json!({
                "id": "example.lookup",
                "label": "Look up",
                "kind": "button",
                "capability": "example.lookup"
            })],
            ..Default::default()
        };
        assert!(plugin_action.validate_settings_contributions().is_ok());
    }

    #[test]
    fn selection_actions_without_a_dispatch_path_are_rejected() {
        let contributes = Contributes {
            selection_actions: vec![serde_json::json!({
                "id": "example.broken",
                "label": "Broken",
                "kind": "button"
            })],
            ..Default::default()
        };
        let error = contributes.validate_settings_contributions().unwrap_err();
        assert!(
            error.contains("neither a non-empty 'capability'"),
            "got: {error}"
        );
    }

    /// `target` is an in-app route, not a link. Accepting a scheme here would turn
    /// a create row into an arbitrary-navigation affordance any installed app could
    /// point wherever it liked.
    #[test]
    fn a_create_action_target_must_be_an_in_app_route() {
        assert!(create_action(serde_json::json!({
            "id": "x.new", "label": "New thing", "target": "https://example.com"
        }))
        .is_err());
    }

    /// The whole point of the surface: a well-formed app declaration loads.
    #[test]
    fn a_well_formed_data_category_validates() {
        let contributes = Contributes {
            data_categories: vec![category("monitors")],
            ..Default::default()
        };
        assert!(contributes.validate_settings_contributions().is_ok());
    }

    /// An app claiming a kernel id would get its danger-zone row wired to the
    /// kernel's truncate — a manifest string that deletes every conversation on the
    /// node. Refused at load, for every kernel id.
    #[test]
    fn an_app_cannot_claim_a_kernel_owned_category() {
        for id in KERNEL_DATA_CATEGORY_IDS {
            let contributes = Contributes {
                data_categories: vec![category(id)],
                ..Default::default()
            };
            let err = contributes.validate_settings_contributions().unwrap_err();
            assert!(
                err.contains("owned by the kernel"),
                "expected '{id}' to be refused as kernel-owned, got: {err}"
            );
        }
    }

    /// The id is the wire value of `POST /api/data/clear` and the desktop's row key,
    /// so it stays a lower-case slug in all three places.
    #[test]
    fn data_category_ids_are_lower_case_slugs() {
        for bad in ["Monitors", "web monitors", "", " monitors", "-monitors"] {
            let contributes = Contributes {
                data_categories: vec![category(bad)],
                ..Default::default()
            };
            assert!(
                contributes.validate_settings_contributions().is_err(),
                "expected id '{bad}' to be rejected"
            );
        }
    }

    /// Two rows POSTing the same `category` means one of them deletes something
    /// other than what its copy promised.
    #[test]
    fn duplicate_data_category_ids_are_rejected() {
        let contributes = Contributes {
            data_categories: vec![category("monitors"), category("monitors")],
            ..Default::default()
        };
        let err = contributes.validate_settings_contributions().unwrap_err();
        assert!(err.contains("duplicate data category id"), "got: {err}");
    }

    /// Empty copy renders a confirm dialog that says nothing before an irreversible
    /// delete, so each of the three required strings is checked.
    #[test]
    fn data_category_copy_is_required() {
        for mutate in [
            (|c: &mut DataCategoryContribution| c.title = "  ".to_owned()) as fn(&mut _),
            |c: &mut DataCategoryContribution| c.noun = String::new(),
            |c: &mut DataCategoryContribution| c.detail = String::new(),
        ] {
            let mut declared = category("monitors");
            mutate(&mut declared);
            let contributes = Contributes {
                data_categories: vec![declared],
                ..Default::default()
            };
            assert!(contributes.validate_settings_contributions().is_err());
        }
    }

    /// An absent (or blank) `confirm_word` falls back to the noun rather than to an
    /// empty string — which would arm the delete on an empty input box.
    #[test]
    fn confirm_word_falls_back_to_the_noun() {
        let mut declared = category("monitors");
        assert_eq!(declared.confirm_word(), "monitors");
        declared.confirm_word = Some("   ".to_owned());
        assert_eq!(declared.confirm_word(), "monitors");
        declared.confirm_word = Some("Monitors".to_owned());
        assert_eq!(declared.confirm_word(), "Monitors");
    }

    // ── code_file hydration ──────────────────────────────────────────────────

    /// A manifest with one turn hook and one capability adapter, both declaring
    /// their body by `code_file`.
    fn code_file_manifest() -> &'static str {
        r#"{
            "id": "com.example.hooks",
            "name": "Hooks",
            "version": "1.0.0",
            "runnables": [{
                "id": "x-search",
                "name": "Search",
                "kind": "tool",
                "config": {
                    "slug": "x.search",
                    "backend": "http",
                    "url": "https://provider.example/search"
                }
            }],
            "contributes": {
                "turn_hooks": [
                    { "id": "h.one", "on": "post_assistant_turn", "code_file": "hooks/one.js" }
                ]
            },
            "provides": [
                {
                    "capability": "web.search",
                    "version": "1.0.0",
                    "tools": {
                        "web.search": {
                            "tool": "x.search",
                            "adapter": { "code_file": "adapters/web.search.js" }
                        }
                    }
                }
            ]
        }"#
    }

    #[test]
    fn hydration_fills_code_and_clears_code_file() {
        let m = PluginManifest::parse_and_validate_with_code(code_file_manifest(), |rel| {
            Ok(format!("// {rel}\nreturn null;\n"))
        })
        .expect("hydrates");

        let hook = &m.contributes.as_ref().unwrap().turn_hooks[0];
        assert_eq!(hook.code, "// hooks/one.js\nreturn null;\n");
        assert!(
            hook.code_file.is_none(),
            "code_file must be cleared so the hydrated manifest is indistinguishable from an \
             inline one and every read site keeps reading `code`"
        );
        let adapter = m.provides[0].tools["web.search"].adapter.as_ref().unwrap();
        assert_eq!(adapter.code, "// adapters/web.search.js\nreturn null;\n");
        assert!(adapter.code_file.is_none());
    }

    #[test]
    fn code_file_refs_lists_both_nodes_then_empties_after_hydration() {
        let mut m: PluginManifest = serde_json::from_str(code_file_manifest()).unwrap();
        assert_eq!(
            m.code_file_refs(),
            vec![
                "hooks/one.js".to_string(),
                "adapters/web.search.js".to_string()
            ]
        );
        m.hydrate_code_files(|_| Ok("return null;".to_string()))
            .expect("hydrates");
        assert!(m.code_file_refs().is_empty());
    }

    /// Parsing a `code_file` manifest WITHOUT a resolver must fail loudly. The
    /// alternative — `code` left empty and the sandbox running nothing — is
    /// indistinguishable at every read site from a hook that chose to do nothing.
    #[test]
    fn parse_without_a_resolver_rejects_a_code_file_manifest() {
        let err = PluginManifest::parse_and_validate(code_file_manifest()).unwrap_err();
        assert!(
            err.contains("code_file") && err.contains("parse_and_validate_with_code"),
            "error must name the missing resolver: {err}"
        );
    }

    #[test]
    fn declaring_both_code_and_code_file_is_rejected() {
        let raw = r#"{
            "id": "com.example.both",
            "name": "Both",
            "version": "1.0.0",
            "runnables": [],
            "contributes": {
                "turn_hooks": [{
                    "id": "h.one", "on": "post_assistant_turn",
                    "code": "return null;", "code_file": "hooks/one.js"
                }]
            }
        }"#;
        let err =
            PluginManifest::parse_and_validate_with_code(raw, |_| Ok("return null;".to_string()))
                .unwrap_err();
        assert!(err.contains("exactly one is allowed"), "got: {err}");
    }

    #[test]
    fn declaring_neither_code_nor_code_file_is_rejected() {
        let raw = r#"{
            "id": "com.example.neither",
            "name": "Neither",
            "version": "1.0.0",
            "runnables": [],
            "contributes": {
                "turn_hooks": [{ "id": "h.one", "on": "post_assistant_turn" }]
            }
        }"#;
        let err =
            PluginManifest::parse_and_validate_with_code(raw, |_| Ok("return null;".to_string()))
                .unwrap_err();
        assert!(err.contains("declares neither"), "got: {err}");
    }

    #[test]
    fn an_unresolvable_code_file_is_an_error_not_an_empty_body() {
        let err = PluginManifest::parse_and_validate_with_code(code_file_manifest(), |rel| {
            Err(format!("no such file: {rel}"))
        })
        .unwrap_err();
        assert!(err.contains("cannot resolve code_file"), "got: {err}");
    }

    #[test]
    fn an_empty_code_file_is_an_error() {
        let err = PluginManifest::parse_and_validate_with_code(code_file_manifest(), |_| {
            Ok("   \n".to_string())
        })
        .unwrap_err();
        assert!(err.contains("is empty"), "got: {err}");
    }

    /// The path is joined onto a plugin's own directory, so it is a traversal sink.
    /// Windows matters here: `\` is a separator and a drive-qualified component
    /// silently replaces the base in `PathBuf::join`.
    #[test]
    fn code_file_path_allowlist_rejects_traversal_and_stray_dirs() {
        assert!(validate_code_file_path("hooks/one.js").is_ok());
        assert!(validate_code_file_path("adapters/web.search.mjs").is_ok());
        for bad in [
            "",
            "one.js",              // no dir segment
            "hooks/nested/one.js", // not flat: breaks the mirror's glob
            "src/one.js",          // dir not in CODE_FILE_DIRS
            "hooks/../../../etc/passwd",
            "../hooks/one.js",
            "/etc/passwd",
            "hooks\\one.js", // Windows separator
            "C:/hooks/one.js",
            "hooks/one.txt", // not JS
            "hooks/.hidden.js",
            "hooks/one.js.js/../x.js",
        ] {
            assert!(
                validate_code_file_path(bad).is_err(),
                "'{bad}' must be rejected"
            );
        }
    }

    /// Same traversal-sink argument as the `code_file` allowlist above, plus the
    /// cross-check that the two allowlists do NOT overlap: a `code_file` must never
    /// name a `.ts` (the sandbox cannot run it) and a pi extension must never name a
    /// `hooks/*.js` (that would ship sandboxed code into the unsandboxed Pi process).
    #[test]
    fn pi_extension_path_allowlist_rejects_traversal_and_stray_dirs() {
        assert!(validate_pi_extension_path("pi-extensions/ryu-shell.ts").is_ok());
        assert!(validate_pi_extension_path("pi-extensions/x.mts").is_ok());
        for bad in [
            "",
            "ryu-shell.ts",                      // no dir segment
            "pi-extensions/nested/ryu-shell.ts", // not flat: breaks the mirror's glob
            "hooks/ryu-shell.ts",                // wrong dir
            "pi-extensions/../../../etc/passwd",
            "../pi-extensions/x.ts",
            "/etc/passwd",
            "pi-extensions\\x.ts", // Windows separator
            "C:/pi-extensions/x.ts",
            "pi-extensions/x.js", // sandboxed-JS extension, not a Pi extension
            "pi-extensions/.hidden.ts",
        ] {
            assert!(
                validate_pi_extension_path(bad).is_err(),
                "'{bad}' must be rejected"
            );
        }
        // The two allowlists are disjoint in both directions.
        assert!(validate_code_file_path("pi-extensions/ryu-shell.ts").is_err());
        assert!(validate_pi_extension_path("hooks/loop.js").is_err());
    }

    /// A malformed `pi_extensions` declaration must fail at LOAD, not at spawn:
    /// the materializer is best-effort and fail-open, so a typo checked only there
    /// would surface as a warn line on a Pi spawn nobody is watching.
    #[test]
    fn a_malformed_pi_extension_declaration_fails_validation() {
        let manifest = |pi_extensions: serde_json::Value| {
            serde_json::json!({
                "id": "@example/x",
                "name": "X",
                "version": "1.0.0",
                "runnables": [],
                "contributes": { "pi_extensions": pi_extensions },
            })
            .to_string()
        };

        let bad_path = manifest(serde_json::json!([
            { "id": "shell", "file": "../../etc/passwd" }
        ]));
        let err = PluginManifest::parse_and_validate_with_code(&bad_path, |_| unreachable!())
            .unwrap_err();
        assert!(err.contains("pi extension file"), "got: {err}");

        let bad_id = manifest(serde_json::json!([
            { "id": "Shell!", "file": "pi-extensions/a.ts" }
        ]));
        let err =
            PluginManifest::parse_and_validate_with_code(&bad_id, |_| unreachable!()).unwrap_err();
        assert!(err.contains("[a-z0-9]"), "got: {err}");

        // Two rows sharing an id would flatten onto ONE file name on disk, so one
        // would silently overwrite the other.
        let dup = manifest(serde_json::json!([
            { "id": "shell", "file": "pi-extensions/a.ts" },
            { "id": "shell", "file": "pi-extensions/b.ts" }
        ]));
        let err =
            PluginManifest::parse_and_validate_with_code(&dup, |_| unreachable!()).unwrap_err();
        assert!(err.contains("duplicate pi extension id"), "got: {err}");

        let ok = manifest(serde_json::json!([
            { "id": "shell", "file": "pi-extensions/ryu-shell.ts" }
        ]));
        let parsed = PluginManifest::parse_and_validate_with_code(&ok, |_| unreachable!())
            .expect("a well-formed declaration loads");
        assert_eq!(
            parsed.pi_extension_refs(),
            vec!["pi-extensions/ryu-shell.ts".to_owned()],
            "the file is enumerated, never hydrated into the manifest"
        );
    }

    // ── output styles ────────────────────────────────────────────────────────

    /// Same traversal-sink argument as the two allowlists above, plus the cross-check
    /// that all three stay disjoint: prose must never be loadable as sandboxed JS or
    /// as an unsandboxed Pi extension, and neither of those may be smuggled in as a
    /// style.
    #[test]
    fn output_style_path_allowlist_rejects_traversal_and_stray_dirs() {
        assert!(validate_output_style_path("output-styles/eli5.md").is_ok());
        assert!(validate_output_style_path("output-styles/i-have-adhd.md").is_ok());
        for bad in [
            "",
            "eli5.md",                   // no dir segment
            "output-styles/nested/x.md", // not flat: breaks the mirror's glob
            "styles/eli5.md",            // wrong dir
            "output-styles/../../etc/passwd",
            "../output-styles/eli5.md",
            "/etc/passwd",
            "output-styles\\eli5.md", // Windows separator
            "C:/output-styles/eli5.md",
            "output-styles/eli5.markdown", // near-miss extension
            "output-styles/eli5.js",       // sandboxed-JS extension, not prose
            "output-styles/.hidden.md",
        ] {
            assert!(
                validate_output_style_path(bad).is_err(),
                "'{bad}' must be rejected"
            );
        }
        // All three allowlists are disjoint in every direction.
        assert!(validate_code_file_path("output-styles/eli5.md").is_err());
        assert!(validate_pi_extension_path("output-styles/eli5.md").is_err());
        assert!(validate_output_style_path("hooks/loop.js").is_err());
        assert!(validate_output_style_path("pi-extensions/ryu-shell.ts").is_err());
    }

    /// A style body is authored as a file and travels as an inline string. The whole
    /// file — frontmatter included — is what lands in `source`, because one parser
    /// has to read a plugin style and a disk style identically.
    #[test]
    fn output_style_hydration_inlines_the_whole_file_and_clears_the_path() {
        let raw = r#"{
            "id": "@ryu/output-styles",
            "name": "Output styles",
            "version": "1.0.0",
            "runnables": [],
            "contributes": {
                "output_styles": [{ "id": "eli5", "file": "output-styles/eli5.md" }]
            }
        }"#;
        let body =
            "---\nname: ELI5\nkeep-coding-instructions: true\n---\n\nTalk to me like I'm 5.\n";

        let mut m: PluginManifest = serde_json::from_str(raw).unwrap();
        assert_eq!(
            m.output_style_refs(),
            vec!["output-styles/eli5.md".to_owned()]
        );
        m.hydrate_output_style_files(|rel| {
            assert_eq!(rel, "output-styles/eli5.md");
            Ok(body.to_owned())
        })
        .expect("hydrates");

        let style = &m.contributes.as_ref().unwrap().output_styles[0];
        assert_eq!(
            style.source.as_deref(),
            Some(body),
            "the frontmatter travels with the body — it is the style's metadata"
        );
        assert!(
            style.file.is_none(),
            "file must be cleared so a hydrated manifest is indistinguishable from an inline one"
        );
        assert!(m.output_style_refs().is_empty());
        m.validate().expect("the hydrated form still validates");
    }

    #[test]
    fn an_unresolvable_or_oversized_output_style_is_an_error_not_an_empty_style() {
        let manifest = |styles: serde_json::Value| {
            serde_json::json!({
                "id": "@example/styles",
                "name": "Styles",
                "version": "1.0.0",
                "runnables": [],
                "contributes": { "output_styles": styles },
            })
            .to_string()
        };
        let one = manifest(serde_json::json!([
            { "id": "eli5", "file": "output-styles/eli5.md" }
        ]));

        let mut m: PluginManifest = serde_json::from_str(&one).unwrap();
        let err = m
            .hydrate_output_style_files(|rel| Err(format!("no such file: {rel}")))
            .unwrap_err();
        assert!(err.contains("cannot resolve file"), "got: {err}");

        let mut m: PluginManifest = serde_json::from_str(&one).unwrap();
        let err = m
            .hydrate_output_style_files(|_| Ok("   \n".to_owned()))
            .unwrap_err();
        assert!(err.contains("is empty"), "got: {err}");

        let big = "x".repeat(MAX_OUTPUT_STYLE_BYTES + 1);
        let mut m: PluginManifest = serde_json::from_str(&one).unwrap();
        let err = m
            .hydrate_output_style_files(|_| Ok(big.clone()))
            .unwrap_err();
        assert!(err.contains("max"), "got: {err}");
    }

    /// A malformed declaration must fail at LOAD. Note what is deliberately NOT an
    /// error: a residual `file`. See [`Contributes::validate_output_styles`].
    #[test]
    fn a_malformed_output_style_declaration_fails_validation() {
        let manifest = |styles: serde_json::Value| {
            serde_json::json!({
                "id": "@example/styles",
                "name": "Styles",
                "version": "1.0.0",
                "runnables": [],
                "contributes": { "output_styles": styles },
            })
            .to_string()
        };

        let bad_path = manifest(serde_json::json!([
            { "id": "eli5", "file": "../../etc/passwd" }
        ]));
        let err = PluginManifest::parse_and_validate(&bad_path).unwrap_err();
        assert!(err.contains("output style file"), "got: {err}");

        let bad_id = manifest(serde_json::json!([
            { "id": "ELI5!", "file": "output-styles/eli5.md" }
        ]));
        let err = PluginManifest::parse_and_validate(&bad_id).unwrap_err();
        assert!(err.contains("[a-z0-9]"), "got: {err}");

        let dup = manifest(serde_json::json!([
            { "id": "eli5", "file": "output-styles/a.md" },
            { "id": "eli5", "file": "output-styles/b.md" }
        ]));
        let err = PluginManifest::parse_and_validate(&dup).unwrap_err();
        assert!(err.contains("duplicate output style id"), "got: {err}");

        let both = manifest(serde_json::json!([
            { "id": "eli5", "file": "output-styles/a.md", "source": "---\nname: x\n---\nhi" }
        ]));
        let err = PluginManifest::parse_and_validate(&both).unwrap_err();
        assert!(err.contains("exactly one is allowed"), "got: {err}");

        let neither = manifest(serde_json::json!([{ "id": "eli5" }]));
        let err = PluginManifest::parse_and_validate(&neither).unwrap_err();
        assert!(err.contains("declares neither"), "got: {err}");

        // The un-hydrated source form is valid on its own: validation checks shape,
        // not whether a resolver has run yet.
        let unhydrated = manifest(serde_json::json!([
            { "id": "eli5", "file": "output-styles/eli5.md" }
        ]));
        PluginManifest::parse_and_validate(&unhydrated)
            .expect("a well-formed, un-hydrated declaration loads");
    }

    /// The wire form must survive a JSON round trip unchanged — it is what
    /// `GET /api/plugins/contributions` serves and what `ryu pack` signs.
    #[test]
    fn a_manifest_carrying_output_styles_round_trips_through_json() {
        let raw = r#"{
            "id": "@ryu/output-styles",
            "name": "Output styles",
            "version": "1.2.3",
            "runnables": [],
            "contributes": {
                "output_styles": [
                    { "id": "eli5", "source": "---\nname: ELI5\n---\n\nSmall words.\n" },
                    { "id": "plain-text", "file": "output-styles/plain-text.md" }
                ],
                "themes": []
            }
        }"#;
        let m = PluginManifest::parse_and_validate(raw).expect("validates");
        let styles = &m.contributes.as_ref().unwrap().output_styles;
        assert_eq!(styles.len(), 2);
        assert_eq!(
            styles[0].source.as_deref(),
            Some("---\nname: ELI5\n---\n\nSmall words.\n")
        );
        assert!(styles[0].file.is_none());
        assert_eq!(
            styles[1].file.as_deref(),
            Some("output-styles/plain-text.md")
        );
        assert!(styles[1].source.is_none());

        let round_tripped: PluginManifest =
            serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(round_tripped, m);

        // Absent by default, and absent from the serialized form when empty — an
        // existing manifest gains no key by this field existing.
        let bare = PluginManifest::parse_and_validate(
            r#"{ "id": "@example/bare", "name": "Bare", "version": "1.0.0", "runnables": [],
                 "contributes": {} }"#,
        )
        .expect("validates");
        assert!(bare.contributes.as_ref().unwrap().output_styles.is_empty());
        assert!(
            !serde_json::to_string(&bare)
                .unwrap()
                .contains("output_styles"),
            "an empty list must not appear on the wire"
        );
    }

    #[test]
    fn an_oversized_code_file_is_rejected() {
        let big = "x".repeat(MAX_CODE_FILE_BYTES + 1);
        let err =
            PluginManifest::parse_and_validate_with_code(code_file_manifest(), |_| Ok(big.clone()))
                .unwrap_err();
        assert!(err.contains("max"), "got: {err}");
    }

    #[test]
    fn an_inline_only_manifest_still_parses_without_a_resolver() {
        let raw = r#"{
            "id": "com.example.inline",
            "name": "Inline",
            "version": "1.0.0",
            "runnables": [],
            "contributes": {
                "turn_hooks": [{
                    "id": "h.one", "on": "post_assistant_turn", "code": "return null;"
                }]
            }
        }"#;
        let m = PluginManifest::parse_and_validate(raw).expect("inline form is still valid");
        assert_eq!(m.contributes.unwrap().turn_hooks[0].code, "return null;");
    }

    #[test]
    fn parse_and_validate_minimal_manifest() {
        let raw = r#"{
            "id": "com.example.minimal",
            "name": "Minimal",
            "version": "0.1.0",
            "runnables": [ { "id": "agent-x", "name": "Agent X", "kind": "agent" } ]
        }"#;
        let m = PluginManifest::parse_and_validate(raw).expect("validate");
        assert_eq!(m.runnables().len(), 1);
        assert_eq!(m.runnable_metas()[0].kind, RunnableKind::Agent);
        assert!(m.supports_surface(Surface::Desktop));
    }

    #[test]
    fn full_manifest_round_trips_through_json() {
        let raw = r#"{
            "id": "com.example.meetings",
            "name": "Meetings",
            "version": "1.0.0",
            "runnables": [],
            "requires": { "apps": [{ "id": "@ryu/spaces", "min_version": "1.0.0" }] },
            "targets": ["core", "desktop"]
        }"#;
        let m = PluginManifest::parse_and_validate(raw).expect("parse");
        assert_eq!(m.dependencies().len(), 1);
        assert!(!m.supports_surface(Surface::Gateway));
        let round =
            PluginManifest::parse_and_validate(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(m, round);
    }

    #[test]
    fn parse_min_version_bare_is_minimum() {
        let req = parse_min_version("1.2.0").unwrap();
        assert!(req.matches(&semver::Version::parse("2.0.0").unwrap()));
    }

    // ── surfaces map: present is authoritative, absent delegates to targets ──────

    #[test]
    fn surfaces_present_is_authoritative_and_targets_ignored() {
        // `surfaces` present ⇒ only listed non-none surfaces supported; `targets`
        // (which would say gateway too) is ignored.
        let raw = r#"{
            "id": "com.example.surf",
            "name": "Surf",
            "version": "1.0.0",
            "runnables": [],
            "targets": ["gateway"],
            "surfaces": {
                "desktop": { "support": "full" },
                "web": { "support": "list" },
                "mobile": { "support": "none" }
            }
        }"#;
        let m = PluginManifest::parse_and_validate(raw).expect("parse");
        assert!(m.supports_surface(Surface::Desktop), "declared full");
        assert!(m.supports_surface(Surface::Web), "declared list");
        assert!(!m.supports_surface(Surface::Mobile), "explicit none");
        assert!(
            !m.supports_surface(Surface::Island),
            "absent key ⇒ unsupported"
        );
        assert!(
            !m.supports_surface(Surface::Gateway),
            "targets ignored when surfaces present"
        );
        // Round-trips.
        let round =
            PluginManifest::parse_and_validate(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(m, round);
    }

    #[test]
    fn surfaces_absent_falls_back_to_targets_all_surfaces() {
        // The tripwire: no surfaces + no targets ⇒ every surface (back-compat).
        let raw = r#"{
            "id": "com.example.legacy",
            "name": "Legacy",
            "version": "1.0.0",
            "runnables": []
        }"#;
        let m = PluginManifest::parse_and_validate(raw).expect("parse");
        assert!(m.surfaces.is_none());
        for s in [
            Surface::Desktop,
            Surface::Gateway,
            Surface::Mobile,
            Surface::Cli,
        ] {
            assert!(m.supports_surface(s), "absent surfaces ⇒ all surfaces");
        }
    }

    #[test]
    fn surfaces_cli_commands_parse_round_trip_and_skip_when_empty() {
        // A cli-only app declaring `ryu <app> <cmd>` subcommands.
        let raw = r#"{
            "id": "com.example.mail",
            "name": "Mail",
            "version": "1.0.0",
            "runnables": [],
            "surfaces": {
                "cli": {
                    "support": "commands",
                    "commands": [
                        { "name": "status", "summary": "Show inbox status", "method": "GET", "path": "/status" },
                        { "name": "send", "path": "/send" }
                    ]
                }
            }
        }"#;
        let m = PluginManifest::parse_and_validate(raw).expect("parse");
        // (a) the cli surface is supported (support != None).
        assert!(m.supports_surface(Surface::Cli), "commands ⇒ cli supported");
        assert!(!m.supports_surface(Surface::Desktop), "only cli declared");
        // (b) the commands are carried through, method/summary optional.
        let cli = m.surfaces.as_ref().unwrap().get(&Surface::Cli).unwrap();
        assert_eq!(cli.commands.len(), 2);
        assert_eq!(cli.commands[0].name, "status");
        assert_eq!(cli.commands[0].method.as_deref(), Some("GET"));
        assert_eq!(
            cli.commands[0].summary.as_deref(),
            Some("Show inbox status")
        );
        assert_eq!(cli.commands[1].name, "send");
        assert_eq!(cli.commands[1].method, None);
        assert_eq!(cli.commands[1].summary, None);
        // (c) round-trips through serde_json preserving commands.
        let value = serde_json::to_value(&m).unwrap();
        assert_eq!(
            value["surfaces"]["cli"]["commands"][0]["name"],
            serde_json::json!("status")
        );
        let round =
            PluginManifest::parse_and_validate(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(m, round);
    }

    #[test]
    fn cli_command_path_rejects_traversal_and_accepts_plain_subpaths() {
        // Safe, plain absolute sub-paths pass.
        for ok in ["/status", "/inboxes/send", "/a-b_c/1", "/x?y=1"] {
            assert!(
                validate_cli_command_path(ok).is_ok(),
                "'{ok}' must be allowed"
            );
        }
        // Every traversal / escape form is rejected — literal `..`, percent-encoded
        // `%2e`, backslash separators, encoded separators, and a non-absolute path.
        for bad in [
            "/../../../v1/chat/completions",
            "/../api/plugins/@ryu/mail/uninstall",
            "/foo/../../bar",
            "/%2e%2e/%2e%2e/v1",
            "/foo/%2E%2E/bar",
            "/..\\..\\v1",
            "/foo%2fbar",
            "status", // not absolute
            "",       // empty
        ] {
            assert!(
                validate_cli_command_path(bad).is_err(),
                "'{bad}' must be rejected"
            );
        }
    }

    #[test]
    fn manifest_with_traversal_cli_command_fails_to_validate() {
        // The load-time gate: a malicious app shipping a `..` command path is
        // rejected at parse_and_validate, so it never installs.
        let raw = r#"{
            "id": "com.evil.app",
            "name": "Evil",
            "version": "1.0.0",
            "runnables": [],
            "surfaces": {
                "cli": {
                    "support": "commands",
                    "commands": [
                        { "name": "pwn", "method": "POST", "path": "/../../../v1/chat/completions" }
                    ]
                }
            }
        }"#;
        let err = PluginManifest::parse_and_validate(raw).unwrap_err();
        assert!(err.contains("path-traversal"), "got: {err}");
        assert!(err.contains("pwn"), "names the offending command: {err}");
    }

    fn declarative_http_manifest(contributes: serde_json::Value) -> PluginManifest {
        serde_json::from_value(serde_json::json!({
            "id": "@acme/notes",
            "name": "Notes",
            "version": "1.0.0",
            "runnables": [],
            "contributes": contributes,
        }))
        .expect("manifest shape")
    }

    #[test]
    fn declarative_automatic_sources_are_get_only() {
        let manifest = declarative_http_manifest(serde_json::json!({
            "sidebar_sections": [{
                "id": "notes",
                "title": "Notes",
                "spec": {
                    "source": {
                        "http": {
                            "method": "DELETE",
                            "path": "/api/ext/@acme/notes/items"
                        }
                    }
                }
            }]
        }));
        let error = manifest
            .validate_declarative_http_policy(false)
            .expect_err("automatic DELETE must be rejected");
        assert!(error.contains("automatic sources must use GET"), "{error}");
    }

    #[test]
    fn community_declarative_http_is_confined_to_its_owner_mount() {
        let valid = declarative_http_manifest(serde_json::json!({
            "views": [{
                "id": "notes",
                "view": "list-detail",
                "spec": {
                    "view": "list-detail",
                    "items": [],
                    "source": { "http": { "path": "/api/ext/@acme/notes/items" } },
                    "actions": [{
                        "id": "create",
                        "label": "Create",
                        "http": {
                            "method": "POST",
                            "path": "/api/ext/@acme/notes/items"
                        }
                    }]
                }
            }]
        }));
        valid
            .validate_declarative_http_policy(false)
            .expect("owner source and action are allowed");

        for path in [
            "/api/preferences",
            "/api/ext/@acme/other/items",
            "/api/ext/@acme/notes/%2e%2e/other/items",
            "/api/ext/@acme/notes/x%2f..%2fother",
        ] {
            let hostile = declarative_http_manifest(serde_json::json!({
                "composer_controls": [{
                    "id": "status",
                    "type": "chip",
                    "label": "Status",
                    "flag": "status",
                    "source": { "http": { "path": path } }
                }]
            }));
            assert!(
                hostile.validate_declarative_http_policy(false).is_err(),
                "community path must be rejected: {path}"
            );
        }
    }

    #[test]
    fn trusted_core_declarative_actions_keep_governed_core_routes() {
        let manifest = declarative_http_manifest(serde_json::json!({
            "store_tabs": [{
                "id": "templates",
                "title": "Templates",
                "spec": {
                    "source": { "http": { "path": "/api/workflows/catalog" } },
                    "install": {
                        "http": {
                            "method": "POST",
                            "path": "/api/workflows/catalog/install"
                        }
                    }
                }
            }]
        }));
        manifest
            .validate_declarative_http_policy(true)
            .expect("trusted Core route is allowed");
        assert!(manifest.validate_declarative_http_policy(false).is_err());
    }

    #[test]
    fn surfaces_entry_omits_empty_commands_key() {
        // A surface entry with no commands must NOT serialize a `commands` key
        // (skip_serializing_if), so existing manifests stay byte-stable.
        let entry = SurfaceEntry {
            support: SurfaceSupport::Full,
            ui: None,
            commands: Vec::new(),
        };
        let value = serde_json::to_value(&entry).unwrap();
        assert!(
            value.get("commands").is_none(),
            "empty commands must be omitted"
        );
    }

    // ── provides / requires.capabilities validation ─────────────────────────────

    #[test]
    fn provides_and_requires_capabilities_round_trip() {
        let raw = r#"{
            "id": "com.example.rag",
            "name": "RAG",
            "version": "1.0.0",
            "runnables": [],
            "sidecars": [{
                "name": "rag",
                "process": { "kind": "binary", "url": "https://example.com/rag", "version": "1.0.0", "sha256": "0000000000000000000000000000000000000000000000000000000000000000" },
                "port": 9099,
                "http": { "routes": [{ "path": "/query" }] }
            }],
            "provides": [{ "capability": "rag", "version": "1.5.0", "sidecar": "rag", "route": "/query", "grant": "cap:rag" }]
        }"#;
        let m = PluginManifest::parse_and_validate(raw).expect("valid provides");
        assert_eq!(m.provided_capabilities().len(), 1);
        assert_eq!(m.provided_capabilities()[0].version, "1.5.0");

        let consumer = r#"{
            "id": "com.example.spaces",
            "name": "Spaces",
            "version": "1.0.0",
            "runnables": [],
            "requires": { "capabilities": [{ "capability": "rag", "min_version": "1.0.0" }] }
        }"#;
        let c = PluginManifest::parse_and_validate(consumer).expect("valid consumer");
        assert_eq!(c.required_capabilities().len(), 1);
        assert_eq!(c.required_capabilities()[0].capability, "rag");
    }

    #[test]
    fn provides_referencing_unknown_sidecar_is_rejected() {
        let raw = r#"{
            "id": "com.example.bad",
            "name": "Bad",
            "version": "1.0.0",
            "runnables": [],
            "provides": [{ "capability": "rag", "version": "1.0.0", "sidecar": "nope", "route": "/query" }]
        }"#;
        let err = PluginManifest::parse_and_validate(raw).unwrap_err();
        assert!(err.contains("not declared"), "got: {err}");
    }

    #[test]
    fn provides_route_not_on_sidecar_is_rejected() {
        let raw = r#"{
            "id": "com.example.bad2",
            "name": "Bad2",
            "version": "1.0.0",
            "runnables": [],
            "sidecars": [{
                "name": "rag",
                "process": { "kind": "binary", "url": "https://example.com/rag", "version": "1.0.0", "sha256": "0000000000000000000000000000000000000000000000000000000000000000" },
                "port": 9099,
                "http": { "routes": [{ "path": "/query" }] }
            }],
            "provides": [{ "capability": "rag", "version": "1.0.0", "sidecar": "rag", "route": "/missing" }]
        }"#;
        let err = PluginManifest::parse_and_validate(raw).unwrap_err();
        assert!(err.contains("route '/missing'"), "got: {err}");
    }

    #[test]
    fn python_sidecar_process_parses_despite_the_kind_tag_collision() {
        // Regression: SidecarProcess is `#[serde(tag = "kind")]` and its Python
        // variant wraps ExternalRuntimeConfig which also had a required `kind` — the
        // outer tag consumed `"kind"`, so the inner field was reported missing and a
        // whole default-on app (finetune) silently never loaded. The inner `kind`
        // now defaults to "python".
        let raw = r#"{
            "id": "com.example.py",
            "name": "Py",
            "version": "1.0.0",
            "runnables": [],
            "sidecars": [{
                "name": "worker",
                "process": { "kind": "python", "entry": "my_worker" },
                "port": 8200
            }]
        }"#;
        let m = PluginManifest::parse_and_validate(raw).expect("python sidecar parses");
        match &m.sidecars[0].process {
            crate::schema::SidecarProcess::Python(rt) => {
                assert_eq!(rt.kind, "python");
                assert_eq!(rt.entry, "my_worker");
            }
            other => panic!("expected Python process, got {other:?}"),
        }
    }

    #[test]
    fn views_contribution_round_trips_and_is_self_contained() {
        // A `views` contribution is opaque + self-contained: its `view`/`spec` are
        // NOT cross-validated against `runnables` (like composer_controls), so a
        // manifest that declares only a view still validates and round-trips.
        let raw = r#"{
            "id": "com.example.hello-views",
            "name": "Hello Views",
            "version": "1.0.0",
            "runnables": [],
            "contributes": {
                "views": [
                    {
                        "id": "hello",
                        "title": "Hello",
                        "view": "list-detail",
                        "spec": {
                            "items": [
                                { "id": "a", "title": "Alpha", "detail": "The first letter." }
                            ]
                        }
                    }
                ]
            }
        }"#;
        let m = PluginManifest::parse_and_validate(raw).expect("views manifest validates");
        let views = &m.contributes.as_ref().unwrap().views;
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].id, "hello");
        assert_eq!(views[0].view, "list-detail");
        assert_eq!(views[0].title.as_deref(), Some("Hello"));
        assert!(views[0].spec.is_some(), "opaque spec is carried through");
        // A view id is NOT a runnable reference, so it never appears in referenced_ids.
        assert!(
            m.contributes.as_ref().unwrap().referenced_ids().is_empty(),
            "views must not be cross-validated as runnable references"
        );
        let round =
            PluginManifest::parse_and_validate(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(m, round);
    }

    #[test]
    fn views_omit_optional_fields_when_absent() {
        // A minimal view (no title, no spec) drops both keys via skip_serializing_if,
        // so the wire stays lean and existing manifests are byte-stable.
        let vc = ViewContribution {
            id: "bare".to_string(),
            title: None,
            view: "empty-state".to_string(),
            spec: None,
        };
        let value = serde_json::to_value(&vc).unwrap();
        assert!(value.get("title").is_none(), "absent title omitted");
        assert!(value.get("spec").is_none(), "absent spec omitted");
        assert_eq!(value["view"], serde_json::json!("empty-state"));
    }

    #[test]
    fn dock_panel_contribution_round_trips_and_is_self_contained() {
        // The dock sibling of `views_contribution_round_trips_and_is_self_contained`:
        // a `dock_panels` entry is opaque + self-contained, so a manifest that declares
        // only a panel (no runnables) still validates and round-trips, and its `panel`
        // discriminant / `spec` are NOT cross-validated against `runnables`.
        let raw = r#"{
            "id": "com.example.dock",
            "name": "Dock",
            "version": "1.0.0",
            "runnables": [],
            "contributes": {
                "dock_panels": [
                    {
                        "id": "preview",
                        "title": "Preview",
                        "icon": "hugeicons:globe-02",
                        "placement": "both",
                        "order": 10,
                        "panel": "companion",
                        "spec": { "companion": "preview-ui" }
                    }
                ]
            }
        }"#;
        let m = PluginManifest::parse_and_validate(raw).expect("dock panel manifest validates");
        let panels = &m.contributes.as_ref().unwrap().dock_panels;
        assert_eq!(panels.len(), 1);
        assert_eq!(panels[0].id, "preview");
        assert_eq!(panels[0].panel, "companion");
        assert_eq!(panels[0].placement, DockPanelPlacement::Both);
        assert_eq!(panels[0].order, Some(10));
        assert!(panels[0].spec.is_some(), "opaque spec is carried through");
        // `spec.companion` names a runnable, but the panel is still not a runnable
        // REFERENCE for cross-validation purposes — same contract as `views`.
        assert!(
            m.contributes.as_ref().unwrap().referenced_ids().is_empty(),
            "dock panels must not be cross-validated as runnable references"
        );
        let round =
            PluginManifest::parse_and_validate(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(m, round);
    }

    #[test]
    fn dock_panel_omits_optional_fields_and_fans_out_both() {
        // A minimal panel drops icon/order/spec via skip_serializing_if, but `placement`
        // has no skip: it always ships so a renderer never has to know the default.
        let dp = DockPanelContribution {
            id: "bare".to_string(),
            title: "Bare".to_string(),
            icon: None,
            placement: DockPanelPlacement::default(),
            order: None,
            panel: "native".to_string(),
            spec: None,
        };
        let value = serde_json::to_value(&dp).unwrap();
        assert!(value.get("icon").is_none(), "absent icon omitted");
        assert!(value.get("order").is_none(), "absent order omitted");
        assert!(value.get("spec").is_none(), "absent spec omitted");
        assert_eq!(value["placement"], serde_json::json!("bottom"));
        // `Both` fans out to the two REAL docks, never to itself.
        assert_eq!(
            DockPanelPlacement::Both.docks(),
            &[DockPanelPlacement::Bottom, DockPanelPlacement::Right]
        );
        assert_eq!(
            DockPanelPlacement::Right.docks(),
            &[DockPanelPlacement::Right]
        );
    }

    #[test]
    fn unknown_dock_placement_falls_back_instead_of_failing() {
        // A dock name from a newer shell must cost the plugin its PLACEMENT, not its
        // whole manifest: the sidecar/tool/runnable it ships keep loading and the panel
        // simply opens in the drawer. Same contract as an unknown settings field type.
        let raw = r#"{
            "id": "com.example.dock",
            "name": "Dock",
            "version": "1.0.0",
            "runnables": [],
            "contributes": {
                "dock_panels": [
                    { "id": "p", "title": "P", "placement": "left", "panel": "native" }
                ]
            }
        }"#;
        let m = PluginManifest::parse_and_validate(raw)
            .expect("an unrecognised dock must not fail the manifest");
        let panels = &m.contributes.as_ref().unwrap().dock_panels;
        assert_eq!(panels[0].placement, DockPanelPlacement::Bottom);
    }

    // ── language servers ─────────────────────────────────────────────────────────

    #[test]
    fn lsp_server_parses_claude_code_config_verbatim() {
        // The interop claim, tested literally: a Claude Code language-server body
        // pasted under `lsp_servers` must parse with every field landing where it
        // belongs. Only the container key is Ryu's; the entry is Claude's camelCase.
        let raw = r#"{
            "id": "com.example.lsp",
            "name": "LSP",
            "version": "1.0.0",
            "runnables": [],
            "contributes": {
                "lsp_servers": {
                    "go": {
                        "command": "gopls",
                        "args": ["serve"],
                        "extensionToLanguage": { ".go": "go" },
                        "transport": "stdio",
                        "env": { "GOFLAGS": "-mod=mod" },
                        "initializationOptions": { "usePlaceholders": true },
                        "settings": { "gopls": { "staticcheck": true } },
                        "workspaceFolder": "/srv/project",
                        "startupTimeout": 15000,
                        "shutdownTimeout": 2000,
                        "restartOnCrash": false,
                        "maxRestarts": 3,
                        "diagnostics": false
                    }
                }
            }
        }"#;
        let m = PluginManifest::parse_and_validate(raw).expect("lsp manifest validates");
        let servers = &m.contributes.as_ref().unwrap().lsp_servers;
        assert_eq!(servers.len(), 1);
        let go = &servers["go"];
        assert_eq!(go.command, "gopls");
        assert_eq!(go.args, vec!["serve".to_string()]);
        assert_eq!(go.extension_to_language[".go"], "go");
        assert_eq!(go.transport, "stdio");
        assert_eq!(go.transport_kind(), LspTransport::Stdio);
        assert_eq!(go.env["GOFLAGS"], "-mod=mod");
        assert_eq!(
            go.initialization_options,
            Some(serde_json::json!({ "usePlaceholders": true }))
        );
        assert_eq!(
            go.settings,
            Some(serde_json::json!({ "gopls": { "staticcheck": true } }))
        );
        assert_eq!(go.workspace_folder.as_deref(), Some("/srv/project"));
        assert_eq!(go.startup_timeout, Some(15000));
        assert_eq!(go.shutdown_timeout, Some(2000));
        assert!(!go.restart_on_crash, "explicit false is honoured");
        assert_eq!(go.max_restarts, Some(3));
        assert!(!go.diagnostics, "explicit false is honoured");
        // A server name is not a runnable id — it names a PATH binary — so it must
        // never reach the loader's cross-validation.
        assert!(
            m.contributes.as_ref().unwrap().referenced_ids().is_empty(),
            "lsp servers must not be cross-validated as runnable references"
        );
        let round =
            PluginManifest::parse_and_validate(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(m, round);
    }

    #[test]
    fn lsp_server_accepts_the_documented_claude_code_example_byte_for_byte() {
        // The `.lsp.json` example from Claude Code's plugins reference, pasted
        // verbatim — a whole `.lsp.json` file IS the value of `lsp_servers`, which is
        // the interop claim stated as an equation rather than reasoned about. The
        // test above exercises every field; this one pins the exact bytes a user
        // copies out of the docs, and the defaults they get for the twelve fields
        // that example omits.
        const CLAUDE_CODE_LSP_JSON: &str = r#"{
  "go": {
    "command": "gopls",
    "args": ["serve"],
    "extensionToLanguage": {
      ".go": "go"
    }
  }
}"#;
        let servers: BTreeMap<String, LspServerContribution> =
            serde_json::from_str(CLAUDE_CODE_LSP_JSON).expect("a real .lsp.json parses as-is");
        let go = &servers["go"];
        assert_eq!(go.command, "gopls");
        assert_eq!(go.args, vec!["serve".to_string()]);
        assert_eq!(go.extension_to_language[".go"], "go");
        // The defaults this example leans on, from THIS input rather than a
        // hand-built struct: stdio transport, restart on crash, diagnostics pushed.
        assert_eq!(go.transport, LspTransport::STDIO);
        assert_eq!(go.transport_kind(), LspTransport::Stdio);
        assert!(go.restart_on_crash, "restartOnCrash defaults to true");
        assert!(go.diagnostics, "diagnostics defaults to true");
        go.validate("go")
            .expect("the documented example is startable");

        // Round-trip: what we serialize back is what Claude Code reads, so the same
        // bytes survive a trip through Ryu and land in the other host unchanged.
        let round: BTreeMap<String, LspServerContribution> =
            serde_json::from_str(&serde_json::to_string(&servers).unwrap()).unwrap();
        assert_eq!(servers, round);

        // And the whole file drops into `contributes.lsp_servers` unedited.
        let manifest = format!(
            r#"{{"id":"com.example.lsp","name":"LSP","version":"1.0.0","runnables":[],
                "contributes": {{ "lsp_servers": {CLAUDE_CODE_LSP_JSON} }} }}"#
        );
        let m = PluginManifest::parse_and_validate(&manifest).expect("manifest validates");
        assert_eq!(m.contributes.as_ref().unwrap().lsp_servers, servers);
    }

    #[test]
    fn lsp_server_defaults_match_claude_code() {
        // `restartOnCrash` and `diagnostics` default TRUE in Claude Code. A bare
        // `#[serde(default)]` on a bool would yield false and silently invert both,
        // and nothing else in the suite would notice — this is that guard.
        let raw = r#"{
            "id": "com.example.lsp",
            "name": "LSP",
            "version": "1.0.0",
            "runnables": [],
            "contributes": {
                "lsp_servers": {
                    "rust": { "command": "rust-analyzer", "extensionToLanguage": { ".rs": "rust" } }
                }
            }
        }"#;
        let m = PluginManifest::parse_and_validate(raw).expect("minimal lsp manifest validates");
        let rust = &m.contributes.as_ref().unwrap().lsp_servers["rust"];
        assert!(rust.restart_on_crash, "restartOnCrash defaults to true");
        assert!(rust.diagnostics, "diagnostics defaults to true");
        assert_eq!(rust.transport, LspTransport::STDIO);
        assert_eq!(rust.transport_kind(), LspTransport::Stdio);
        assert!(rust.args.is_empty());
        assert!(rust.env.is_empty());
        assert_eq!(rust.workspace_folder, None);
        assert_eq!(rust.startup_timeout, None);
        assert_eq!(rust.shutdown_timeout, None);
        assert_eq!(rust.max_restarts, None);
    }

    #[test]
    fn lsp_server_serializes_claude_camel_case_keys() {
        // `extensionToLanguage` IS the interop contract with Claude Code; a rename to
        // snake_case would be invisible in Rust and fatal on the wire. The defaulted
        // bools carry no skip_serializing_if, so they always ship.
        let server = LspServerContribution {
            command: "gopls".to_string(),
            args: Vec::new(),
            extension_to_language: BTreeMap::from([(".go".to_string(), "go".to_string())]),
            transport: LspTransport::STDIO.to_string(),
            env: BTreeMap::new(),
            initialization_options: None,
            settings: None,
            workspace_folder: None,
            startup_timeout: None,
            shutdown_timeout: None,
            restart_on_crash: true,
            max_restarts: None,
            diagnostics: true,
        };
        let value = serde_json::to_value(&server).unwrap();
        assert_eq!(value["extensionToLanguage"][".go"], serde_json::json!("go"));
        assert!(
            value.get("extension_to_language").is_none(),
            "the Rust field name must never reach the wire"
        );
        assert_eq!(value["restartOnCrash"], serde_json::json!(true));
        assert_eq!(value["diagnostics"], serde_json::json!(true));
        assert_eq!(value["transport"], serde_json::json!("stdio"));
        assert!(value.get("args").is_none(), "absent args omitted");
        assert!(value.get("env").is_none(), "absent env omitted");
        assert!(
            value.get("workspaceFolder").is_none(),
            "absent workspaceFolder omitted"
        );
        assert!(
            value.get("startupTimeout").is_none(),
            "absent startupTimeout omitted"
        );
        assert!(
            value.get("maxRestarts").is_none(),
            "absent maxRestarts omitted"
        );
    }

    #[test]
    fn invalid_lsp_server_skips_itself_not_the_manifest() {
        // Claude Code skips a server with invalid config and starts the rest. That is
        // only reachable because `command`/`extensionToLanguage` are serde-defaulted:
        // the manifest PARSES, and validate() supplies the per-server reason.
        let raw = r#"{
            "id": "com.example.lsp",
            "name": "LSP",
            "version": "1.0.0",
            "runnables": [],
            "contributes": {
                "lsp_servers": {
                    "broken": { "extensionToLanguage": { ".go": "go" } },
                    "claimless": { "command": "gopls" },
                    "fine": { "command": "rust-analyzer", "extensionToLanguage": { ".rs": "rust" } }
                }
            }
        }"#;
        let m = PluginManifest::parse_and_validate(raw)
            .expect("a broken lsp server must not fail the whole manifest");
        let servers = &m.contributes.as_ref().unwrap().lsp_servers;

        let missing_command = servers["broken"].validate("broken").unwrap_err();
        assert!(
            missing_command.contains("broken") && missing_command.contains("command"),
            "reason names the server and the missing field: {missing_command}"
        );
        let no_extensions = servers["claimless"].validate("claimless").unwrap_err();
        assert!(
            no_extensions.contains("claimless") && no_extensions.contains("extensionToLanguage"),
            "reason names the server and the empty map: {no_extensions}"
        );
        // A whitespace-only command is as unstartable as an absent one.
        let blank = LspServerContribution {
            command: "   ".to_string(),
            ..servers["fine"].clone()
        };
        assert!(blank.validate("blank").is_err());
        // The valid sibling is untouched by either.
        servers["fine"]
            .validate("fine")
            .expect("valid server passes");
    }

    #[test]
    fn unknown_lsp_transport_parses_but_is_not_guessed_at() {
        // An unrecognised transport must not fail the manifest (the plugin's runnables
        // and sidecars are unaffected) and must not be coerced to stdio either, which
        // would spawn a process that cannot speak the protocol. It stays verbatim and
        // classifies as Unsupported so the spawn site skips it with a reason.
        let raw = r#"{
            "id": "com.example.lsp",
            "name": "LSP",
            "version": "1.0.0",
            "runnables": [],
            "contributes": {
                "lsp_servers": {
                    "future": { "command": "x", "extensionToLanguage": { ".x": "x" }, "transport": "quic" },
                    "sock": { "command": "y", "extensionToLanguage": { ".y": "y" }, "transport": "Socket" }
                }
            }
        }"#;
        let m = PluginManifest::parse_and_validate(raw)
            .expect("an unrecognised transport must not fail the manifest");
        let servers = &m.contributes.as_ref().unwrap().lsp_servers;
        assert_eq!(servers["future"].transport, "quic", "value kept verbatim");
        assert_eq!(
            servers["future"].transport_kind(),
            LspTransport::Unsupported
        );
        // Socket is valid config Core cannot drive yet, so it passes validate() and is
        // gated by the separate transport check instead.
        assert_eq!(servers["sock"].transport_kind(), LspTransport::Socket);
        servers["sock"]
            .validate("sock")
            .expect("socket config is valid, just unimplemented");
    }

    #[test]
    fn lsp_extension_keys_normalise_for_lookup() {
        // `.GO`, `go` and `.go` are one extension. Routing on the raw key would make
        // them three, so lookup normalises both sides.
        assert_eq!(normalize_lsp_extension_key("go"), ".go");
        assert_eq!(normalize_lsp_extension_key(".GO"), ".go");
        assert_eq!(normalize_lsp_extension_key("  .Go "), ".go");
        assert_eq!(normalize_lsp_extension_key(""), "");
        // It takes an EXTENSION, not a filename — documented, and asserted so the
        // contract is not discovered by a caller passing a path.
        assert_eq!(normalize_lsp_extension_key("main.go"), ".main.go");

        let server = LspServerContribution {
            command: "gopls".to_string(),
            args: Vec::new(),
            extension_to_language: BTreeMap::from([
                ("GO".to_string(), "go".to_string()),
                (".tmpl".to_string(), "gotmpl".to_string()),
            ]),
            transport: LspTransport::STDIO.to_string(),
            env: BTreeMap::new(),
            initialization_options: None,
            settings: None,
            workspace_folder: None,
            startup_timeout: None,
            shutdown_timeout: None,
            restart_on_crash: true,
            max_restarts: None,
            diagnostics: true,
        };
        assert_eq!(server.language_for_extension(".go").as_deref(), Some("go"));
        assert_eq!(server.language_for_extension("go").as_deref(), Some("go"));
        assert_eq!(server.language_for_extension(".GO").as_deref(), Some("go"));
        assert_eq!(server.language_for_extension(".rs"), None);
        assert_eq!(server.language_for_extension(""), None);

        let normalized = server.normalized_extensions();
        assert_eq!(normalized[".go"], "go");
        assert_eq!(normalized[".tmpl"], "gotmpl");

        // Two raw keys in ONE server that normalise to the same extension resolve
        // first-wins by ascending source-key order — the per-server twin of the
        // first-registration-wins rule between servers. `.` (0x2E) sorts before `G`
        // (0x47), so the dotted spelling is the one that survives. Without this the
        // helper could quietly become last-wins and nothing would notice.
        let colliding = LspServerContribution {
            extension_to_language: BTreeMap::from([
                (".go".to_string(), "go-dotted".to_string()),
                ("GO".to_string(), "go-bare".to_string()),
            ]),
            ..server
        };
        assert_eq!(colliding.normalized_extensions()[".go"], "go-dotted");
        assert_eq!(
            colliding.language_for_extension("go").as_deref(),
            Some("go-dotted")
        );
    }

    #[test]
    fn lsp_servers_iterate_in_deterministic_key_order() {
        // First-registration-wins per extension is only reproducible if iteration is.
        // BTreeMap fixes it to ascending key order — NOT the JSON authoring order the
        // raw below deliberately scrambles, and never hash order.
        let raw = r#"{
            "id": "com.example.lsp",
            "name": "LSP",
            "version": "1.0.0",
            "runnables": [],
            "contributes": {
                "lsp_servers": {
                    "zed": { "command": "z", "extensionToLanguage": { ".go": "go" } },
                    "alpha": { "command": "a", "extensionToLanguage": { ".go": "go" } },
                    "mid": { "command": "m", "extensionToLanguage": { ".go": "go" } }
                }
            }
        }"#;
        let m = PluginManifest::parse_and_validate(raw).unwrap();
        let names: Vec<&str> = m
            .contributes
            .as_ref()
            .unwrap()
            .lsp_servers
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(names, vec!["alpha", "mid", "zed"]);
    }

    // ── unified permission grammar ───────────────────────────────────────────────

    #[test]
    fn permission_set_default_is_deny_all() {
        let p = PermissionSet::default();
        assert!(p.fs.read.is_empty());
        assert!(p.fs.write.is_empty());
        assert!(!p.child_process);
        assert!(p.run.is_empty());
        assert!(p.network.is_deny(), "default network denies all");
        assert!(!p.network.is_allowed());
        assert!(p.tool.is_empty());
        // An empty set validates (deny-all is always valid).
        assert!(p.validate().is_ok());
    }

    #[test]
    fn manifest_without_permissions_omits_the_key() {
        // Back-compat tripwire: a manifest that declares no permissions must NOT
        // serialize a `permissions` key, so existing manifests stay byte-stable and
        // `permissions: None` reads as deny-all.
        let raw = r#"{
            "id": "com.example.noperm",
            "name": "NoPerm",
            "version": "1.0.0",
            "runnables": []
        }"#;
        let m = PluginManifest::parse_and_validate(raw).expect("parse");
        assert!(m.permissions.is_none());
        let value = serde_json::to_value(&m).unwrap();
        assert!(
            value.get("permissions").is_none(),
            "absent permissions omitted"
        );
    }

    #[test]
    fn permission_set_full_round_trips_and_network_untagged_dispatch() {
        // A rich set with both fs sets, child_process, host-scoped net, and tools.
        let raw = r#"{
            "id": "com.example.perm",
            "name": "Perm",
            "version": "1.0.0",
            "runnables": [],
            "permissions": {
                "fs": { "read": ["/data/in"], "write": ["/data/out"] },
                "child_process": true,
                "run": ["ego-browser"],
                "network": ["api.example.com:443", "cdn.example.com"],
                "tool": ["web_search"]
            }
        }"#;
        let m = PluginManifest::parse_and_validate(raw).expect("valid permissions");
        let p = m.permissions.as_ref().unwrap();
        assert_eq!(p.fs.read, vec!["/data/in".to_string()]);
        assert_eq!(p.fs.write, vec!["/data/out".to_string()]);
        assert!(p.child_process);
        assert_eq!(p.run, vec!["ego-browser".to_string()]);
        assert!(matches!(&p.network, NetworkPermission::Hosts(h) if h.len() == 2));
        assert!(p.network.is_allowed());
        assert_eq!(p.tool, vec!["web_search".to_string()]);
        // Round-trips byte-identically.
        let round =
            PluginManifest::parse_and_validate(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(m, round);
    }

    #[test]
    fn network_permission_untagged_both_arms() {
        // Untagged dispatch is by JSON type: bool → All, array → Hosts.
        let all_true: NetworkPermission = serde_json::from_str("true").unwrap();
        assert_eq!(all_true, NetworkPermission::All(true));
        assert!(all_true.is_allowed());
        let all_false: NetworkPermission = serde_json::from_str("false").unwrap();
        assert_eq!(all_false, NetworkPermission::All(false));
        assert!(all_false.is_deny());
        let hosts: NetworkPermission = serde_json::from_str(r#"["h:443"]"#).unwrap();
        assert_eq!(hosts, NetworkPermission::Hosts(vec!["h:443".to_string()]));
        // An empty host list denies (a list with no reachable host is not "allow").
        assert!(NetworkPermission::Hosts(vec![]).is_deny());
        // Serialize round-trips the type: All(bool) → bool, Hosts → array.
        assert_eq!(
            serde_json::to_string(&NetworkPermission::All(true)).unwrap(),
            "true"
        );
        assert_eq!(
            serde_json::to_string(&NetworkPermission::Hosts(vec!["h".to_string()])).unwrap(),
            r#"["h"]"#
        );
    }

    #[test]
    fn permission_traversal_path_is_rejected_at_validate() {
        // The gate must actually run inside validate(): a `..` path fails to parse.
        let raw = r#"{
            "id": "com.evil.perm",
            "name": "EvilPerm",
            "version": "1.0.0",
            "runnables": [],
            "permissions": { "fs": { "read": ["../../etc/passwd"], "write": [] } }
        }"#;
        let err = PluginManifest::parse_and_validate(raw).unwrap_err();
        assert!(err.contains("traversal"), "got: {err}");
        // An empty path is also rejected.
        let mut bad = PermissionSet::default();
        bad.fs.write.push(String::new());
        assert!(bad.validate().is_err(), "empty path must be rejected");
    }

    #[test]
    fn permission_run_requires_child_process_and_bare_names() {
        let mut no_child = PermissionSet::default();
        no_child.run.push("ego-browser".to_owned());
        assert!(no_child.validate().unwrap_err().contains("child_process"));

        let mut path = PermissionSet {
            child_process: true,
            ..Default::default()
        };
        path.run.push("bin/ego-browser".to_owned());
        assert!(path.validate().unwrap_err().contains("bare program"));

        let mut comma = PermissionSet {
            child_process: true,
            ..Default::default()
        };
        comma.run.push("ego-browser,other".to_owned());
        assert!(comma.validate().unwrap_err().contains("bare program"));
    }

    #[test]
    fn provides_bad_version_is_rejected() {
        let raw = r#"{
            "id": "com.example.bad3",
            "name": "Bad3",
            "version": "1.0.0",
            "runnables": [],
            "provides": [{ "capability": "rag", "version": "not-semver" }]
        }"#;
        let err = PluginManifest::parse_and_validate(raw).unwrap_err();
        assert!(err.contains("invalid version"), "got: {err}");
    }

    /// The two tab shapes every shipped built-in uses — a `model_picker` field tab
    /// (advisor/double-check/goal/proof/…) and a `view`-only tab (meetings/memory/
    /// quests/predict) — must keep validating, and must survive as raw JSON.
    #[test]
    fn builtin_settings_tab_shapes_still_validate_and_round_trip_verbatim() {
        let raw = r#"{
            "id": "com.example.settings",
            "name": "Settings",
            "version": "1.0.0",
            "runnables": [],
            "contributes": { "settings_tabs": [
                {
                    "id": "advisor.settings",
                    "title": "Advisor",
                    "fields": [
                        { "type": "model_picker", "pref_key": "advisor-model", "label": "Advisor model" }
                    ]
                },
                { "id": "meetings.settings", "title": "Meetings", "scope": "node", "view": "meetings" }
            ] }
        }"#;
        let manifest = PluginManifest::parse_and_validate(raw).expect("built-in shapes validate");
        let tabs = manifest.contributes.expect("contributes").settings_tabs;
        assert_eq!(tabs.len(), 2);
        // Stored verbatim (not re-serialized from the struct), so a desktop newer
        // than this Core still receives every key it was shipped to render.
        assert_eq!(tabs[0]["fields"][0]["type"], "model_picker");
        assert_eq!(tabs[1]["view"], "meetings");
    }

    /// Each of these used to reach the desktop and be dropped by the renderer's
    /// defensive parser, leaving the author with a missing row and no diagnostic.
    #[test]
    fn settings_tab_rules_reject_the_silently_broken_shapes() {
        let with_fields = |fields: &str| {
            format!(
                r#"{{
                    "id": "com.example.bad-settings",
                    "name": "Bad",
                    "version": "1.0.0",
                    "runnables": [],
                    "contributes": {{ "settings_tabs": [
                        {{ "id": "t", "title": "T", "fields": {fields} }}
                    ] }}
                }}"#
            )
        };
        let reject = |fields: &str, needle: &str| {
            let err = PluginManifest::parse_and_validate(&with_fields(fields))
                .expect_err("must be rejected");
            assert!(err.contains(needle), "expected '{needle}', got: {err}");
        };

        // Two fields on one preference key: the second silently overwrites the first.
        reject(r#"[{"pref_key":"k"},{"pref_key":"k"}]"#, "identity");
        // A select with no options degrades into a free-text box.
        reject(r#"[{"type":"select","pref_key":"k"}]"#, "no options");
        // A default of the wrong type is written straight into the preference store.
        reject(
            r#"[{"type":"toggle","pref_key":"k","default":"yes"}]"#,
            "toggle",
        );
        // Bounds on a type that cannot enforce them read as a guarantee and are not one.
        reject(r#"[{"type":"toggle","pref_key":"k","min":1}]"#, "min/max");
        // A pref_key that would escape the `/api/preferences/<key>` route.
        reject(r#"[{"pref_key":"../secrets"}]"#, "illegal characters");
        // Neither fields nor a view = an empty section.
        reject("[]", "empty section");
    }

    /// A `secret` field's `pref_key` is the ENV VAR NAME the plugin's own
    /// `secret_headers` `env:` token reads, so it must be env-var-shaped even though
    /// the general `pref_key` alphabet also admits `.`, `-` and `:`. Without this,
    /// `"pref_key": "tavily.api-key"` validates at import, renders normally, and
    /// then 400s the first time a user presses Save — a failure the author never
    /// sees. And a `default` on a secret field is a credential committed to a file
    /// that travels with the plugin.
    #[test]
    fn a_secret_field_must_name_an_env_var_and_carry_no_default() {
        let with_field = |field: &str| {
            format!(
                r#"{{
                    "id": "com.example.byok",
                    "name": "BYOK",
                    "version": "1.0.0",
                    "runnables": [],
                    "contributes": {{ "settings_tabs": [
                        {{ "id": "t", "title": "T", "fields": [{field}] }}
                    ] }}
                }}"#
            )
        };
        let reject = |field: &str, needle: &str| {
            let err = PluginManifest::parse_and_validate(&with_field(field))
                .expect_err("must be rejected");
            assert!(err.contains(needle), "expected '{needle}', got: {err}");
        };

        // Every spelling the general pref_key alphabet allows but an env var cannot.
        for bad_key in ["tavily.api_key", "tavily-api-key", "ryu:tavily", "1KEY"] {
            reject(
                &format!(r#"{{"type":"secret","pref_key":"{bad_key}"}}"#),
                "environment variable name",
            );
        }
        // A credential must never ship inside a manifest.
        reject(
            r#"{"type":"secret","pref_key":"RYU_TAVILY_API_KEY","default":"tvly-live-abc"}"#,
            "must not declare a default",
        );

        // The shape a real BYOK provider declares loads cleanly.
        let ok = PluginManifest::parse_and_validate(&with_field(
            r#"{"type":"secret","pref_key":"RYU_TAVILY_API_KEY","label":"Tavily API key"}"#,
        ))
        .expect("an env-var-shaped secret field validates");
        let tabs = ok.contributes.expect("contributes").settings_tabs;
        assert_eq!(tabs[0]["fields"][0]["type"], "secret");
        // The SAME predicate Core's PUT handler applies, so the two cannot drift.
        assert!(is_env_var_name("RYU_TAVILY_API_KEY"));
        assert!(!is_env_var_name("tavily.api_key"));
    }

    /// A control a NEWER desktop understands must not sink the whole manifest — the
    /// renderer already draws an unknown type as a text input.
    #[test]
    fn unknown_settings_field_type_falls_back_instead_of_failing() {
        let raw = r#"{
            "id": "com.example.future",
            "name": "Future",
            "version": "1.0.0",
            "runnables": [],
            "contributes": { "settings_tabs": [
                { "id": "t", "title": "T", "fields": [ { "type": "color_picker", "pref_key": "k" } ] }
            ] }
        }"#;
        let manifest =
            PluginManifest::parse_and_validate(raw).expect("a future control must still load");
        let tabs = manifest.contributes.expect("contributes").settings_tabs;
        assert_eq!(tabs[0]["fields"][0]["type"], "color_picker");
    }

    #[test]
    fn tool_filter_matches_exactly_or_by_trailing_wildcard() {
        let exact = ToolFilterContribution {
            tool: "browser.navigate".to_owned(),
            reason: None,
        };
        assert!(exact.matches("browser.navigate"));
        assert!(!exact.matches("browser.navigate_back"));
        assert!(validate_tool_filter(&exact).is_ok());

        let wildcard = ToolFilterContribution {
            tool: "shadow.*".to_owned(),
            reason: Some("replaced by this plugin's own search".to_owned()),
        };
        assert!(wildcard.matches("shadow.search"));
        assert!(!wildcard.matches("browser.search"));
        assert!(validate_tool_filter(&wildcard).is_ok());

        // `*` alone or an unqualified name would strip tools across every server;
        // an interior `*` looks like a glob and behaves like a literal.
        for bad in ["", "*", "navigate", "br*ser.nav", "browser.nav "] {
            let filter = ToolFilterContribution {
                tool: bad.to_owned(),
                reason: None,
            };
            assert!(
                validate_tool_filter(&filter).is_err(),
                "must reject pattern '{bad}'"
            );
        }
    }

    // ── permission levels (the user-facing vocabulary) ────────────────────────

    fn level(id: &str, implies: &[&str]) -> PermissionLevel {
        PermissionLevel {
            id: id.to_owned(),
            label: format!("Can {id}"),
            description: format!("Lets a person {id} in this app."),
            implies: implies.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    /// The back-compat contract: every manifest written before this field existed
    /// must still deserialize, and must declare an *empty* vocabulary rather than
    /// failing or defaulting to something granted.
    #[test]
    fn a_manifest_without_permission_levels_still_parses_and_declares_none() {
        let raw = r#"{
            "id": "com.example.legacy",
            "name": "Legacy",
            "version": "1.0.0",
            "runnables": []
        }"#;
        let manifest = PluginManifest::parse_and_validate(raw).expect("legacy manifest must load");
        assert!(manifest.permission_levels.is_empty());
        // …and it must not reappear on the wire, or every existing manifest's
        // canonical encoding (which the Gateway signs) would change.
        let round_tripped = serde_json::to_value(&manifest).expect("manifest serialises");
        assert!(round_tripped.get("permission_levels").is_none());
    }

    /// The shape an app like Spaces actually declares, end to end through serde —
    /// this is the case the whole field exists for.
    #[test]
    fn a_declared_vocabulary_parses_and_keeps_declaration_order() {
        let raw = r#"{
            "id": "com.ryu.spaces",
            "name": "Spaces",
            "version": "1.0.0",
            "runnables": [],
            "permission_levels": [
                { "id": "read", "label": "Can view", "description": "View spaces." },
                { "id": "edit", "label": "Can edit", "description": "Edit spaces.", "implies": ["read"] }
            ]
        }"#;
        let manifest = PluginManifest::parse_and_validate(raw).expect("vocabulary must load");
        let ids: Vec<&str> = manifest
            .permission_levels
            .iter()
            .map(|l| l.id.as_str())
            .collect();
        // Declaration order is display order — a set or a map here would lose it.
        assert_eq!(ids, ["read", "edit"]);
        assert_eq!(
            resolve_implied_permission_levels(&manifest.permission_levels, "edit"),
            BTreeSet::from(["read".to_owned()])
        );
    }

    #[test]
    fn route_permissions_can_distinguish_http_methods_on_one_path() {
        let raw = r#"{
            "id": "com.example.method-gated",
            "name": "Method gated",
            "version": "1.0.0",
            "runnables": [],
            "permission_levels": [
                { "id": "items.view", "label": "Can view", "description": "View items." },
                { "id": "items.edit", "label": "Can edit", "description": "Edit items.", "implies": ["items.view"] }
            ],
            "sidecars": [{
                "name": "api",
                "process": { "kind": "local", "command": "items-api" },
                "port": 9111,
                "http": { "routes": [
                    { "path": "/items", "method": "GET", "permission": "items.view" },
                    { "path": "/items", "method": "POST", "permission": "items.edit" }
                ] }
            }]
        }"#;
        let manifest = PluginManifest::parse_and_validate(raw).expect("method ACLs must load");
        let routes = &manifest.sidecars[0].http.as_ref().expect("http").routes;
        assert_eq!(routes[0].method.as_deref(), Some("GET"));
        assert_eq!(routes[1].method.as_deref(), Some("POST"));
    }

    #[test]
    fn permission_vocabulary_requires_every_protected_non_health_route_to_be_gated() {
        let raw = r#"{
            "id": "com.example.incomplete-gates",
            "name": "Incomplete gates",
            "version": "1.0.0",
            "runnables": [],
            "permission_levels": [
                { "id": "items.view", "label": "Can view", "description": "View items." }
            ],
            "sidecars": [{
                "name": "api",
                "process": { "kind": "local", "command": "items-api" },
                "port": 9111,
                "health_path": "/health",
                "http": { "routes": [
                    { "path": "/health" },
                    { "path": "/items" }
                ] }
            }]
        }"#;
        let error = PluginManifest::parse_and_validate(raw)
            .expect_err("a protected data route cannot bypass the declared vocabulary");
        assert!(
            error.contains("route '/items' has no permission"),
            "got: {error}"
        );
    }

    /// Two levels with one id make a grant ambiguous: whichever the reader
    /// de-duplicates to decides what the grant means.
    #[test]
    fn duplicate_permission_level_ids_are_rejected() {
        let err = validate_permission_levels(&[level("read", &[]), level("read", &[])])
            .expect_err("a duplicate id must not validate");
        assert!(
            err.contains("duplicate permission level id 'read'"),
            "got: {err}"
        );
    }

    /// The alphabet is deliberately narrower than a plugin id's: `Read` and `read`
    /// are indistinguishable to the admin granting them, and `..` is a traversal
    /// segment once the id reaches an API path.
    #[test]
    fn permission_level_ids_are_restricted_to_a_safe_lowercase_charset() {
        for good in [
            "read",
            "edit",
            "space.read",
            "read-only",
            "read_write",
            "a1",
        ] {
            assert!(
                validate_permission_level_id(good).is_ok(),
                "'{good}' must be accepted"
            );
        }
        for bad in [
            "",
            "Read",        // uppercase: a case-collision with `read`
            "read write",  // space
            "read/write",  // path separator
            "read:write",  // grant-string separator
            "..",          // traversal
            "space..read", // traversal, interior
            "read\n",
        ] {
            assert!(
                validate_permission_level_id(bad).is_err(),
                "'{bad}' must be rejected"
            );
        }
        // The cap is the plugin-id cap because these ids sit beside plugin ids in
        // API paths; one bound is easier to reason about than two.
        assert!(validate_permission_level_id(&"a".repeat(MAX_PLUGIN_ID_LEN)).is_ok());
        assert!(validate_permission_level_id(&"a".repeat(MAX_PLUGIN_ID_LEN + 1)).is_err());
    }

    /// A level nobody can read or understand cannot be rendered in a grant picker,
    /// so it is rejected at declaration rather than shown as a blank row.
    #[test]
    fn a_permission_level_without_a_label_or_description_is_rejected() {
        let mut unlabelled = level("read", &[]);
        unlabelled.label = "   ".to_owned();
        assert!(validate_permission_levels(&[unlabelled]).is_err());

        let mut undescribed = level("read", &[]);
        undescribed.description = String::new();
        assert!(validate_permission_levels(&[undescribed]).is_err());
    }

    /// A typo'd `implies` would otherwise resolve to nothing — the grant would look
    /// correct and silently convey less than the author meant.
    #[test]
    fn an_implies_reference_to_an_undeclared_level_is_rejected() {
        let err = validate_permission_levels(&[level("edit", &["raed"])])
            .expect_err("a dangling implies must not validate");
        assert!(
            err.contains("implies 'raed'") && err.contains("does not declare"),
            "got: {err}"
        );
    }

    /// A cycle makes the levels in it indistinguishable, so "read only" stops being
    /// expressible. Both lengths matter: the self-edge is the one a visited-set-only
    /// walk would miss.
    #[test]
    fn cyclic_implications_are_rejected_including_a_self_edge() {
        let two = validate_permission_levels(&[level("edit", &["read"]), level("read", &["edit"])])
            .expect_err("a 2-cycle must not validate");
        assert!(two.contains("implication cycle"), "got: {two}");

        let three = validate_permission_levels(&[
            level("admin", &["edit"]),
            level("edit", &["read"]),
            level("read", &["admin"]),
        ])
        .expect_err("a 3-cycle must not validate");
        assert!(three.contains("implication cycle"), "got: {three}");

        let itself = validate_permission_levels(&[level("edit", &["edit"])])
            .expect_err("a self-implication must not validate");
        assert!(itself.contains("implication cycle"), "got: {itself}");
    }

    /// A diamond is legal — two levels may imply the same weaker one — and must not
    /// be mistaken for a cycle by the DFS's already-visited bookkeeping.
    #[test]
    fn a_diamond_shaped_vocabulary_is_not_a_cycle() {
        let levels = [
            level("admin", &["edit", "share"]),
            level("edit", &["read"]),
            level("share", &["read"]),
            level("read", &[]),
        ];
        validate_permission_levels(&levels).expect("a DAG must validate");
        assert_eq!(
            resolve_implied_permission_levels(&levels, "admin"),
            BTreeSet::from(["edit".to_owned(), "share".to_owned(), "read".to_owned()])
        );
    }

    /// The point of the field: granting the strongest level must convey everything
    /// beneath it, so an admin never grants the same person two levels. A two-hop
    /// chain is the shortest case that fails if resolution is only one hop deep.
    #[test]
    fn implication_resolves_transitively_and_excludes_the_level_itself() {
        let levels = [
            level("admin", &["edit"]),
            level("edit", &["read"]),
            level("read", &[]),
        ];
        assert_eq!(
            resolve_implied_permission_levels(&levels, "admin"),
            BTreeSet::from(["edit".to_owned(), "read".to_owned()])
        );
        assert!(resolve_implied_permission_levels(&levels, "read").is_empty());
        // An id nobody declared conveys nothing — never a panic, never everything.
        assert!(resolve_implied_permission_levels(&levels, "delete").is_empty());
    }

    /// Resolution is reachable from unvalidated input (a manifest read straight off
    /// the wire), so a cycle must terminate rather than hang the caller.
    #[test]
    fn resolution_terminates_on_a_cyclic_vocabulary() {
        let levels = [level("edit", &["read"]), level("read", &["edit"])];
        assert_eq!(
            resolve_implied_permission_levels(&levels, "edit"),
            BTreeSet::from(["read".to_owned(), "edit".to_owned()])
        );
    }

    /// The vocabulary is gated by the same `validate()` every other manifest rule
    /// runs through — not by a separate call an ingest path could forget.
    #[test]
    fn manifest_validation_rejects_a_bad_vocabulary() {
        let raw = r#"{
            "id": "com.example.bad",
            "name": "Bad",
            "version": "1.0.0",
            "runnables": [],
            "permission_levels": [
                { "id": "edit", "label": "Can edit", "description": "Edit.", "implies": ["read"] }
            ]
        }"#;
        let err = PluginManifest::parse_and_validate(raw)
            .expect_err("a dangling implies must fail whole-manifest validation");
        assert!(
            err.contains("com.example.bad"),
            "must name the plugin: {err}"
        );
        assert!(err.contains("implies 'read'"), "got: {err}");
    }

    #[test]
    fn route_patterns_reject_ambiguous_auth_postures() {
        assert!(route_patterns_overlap("/:id", "/admin"));
        assert!(route_patterns_overlap("/files/*rest", "/files/:id"));
        assert!(!route_patterns_overlap("/items/:id", "/items/:id/details"));
        assert!(!route_patterns_overlap("/health", "/admin"));
        assert!(earlier_route_wins("/admin", "/:id"));
        assert!(!earlier_route_wins(
            "/requests/:requestId",
            "/:boardSlug/requests"
        ));
        assert!(!earlier_route_wins("/:id", "/admin"));

        let raw = r#"
        {
            "id": "com.example.ambiguous",
            "name": "Ambiguous",
            "version": "1.0.0",
            "runnables": [],
            "sidecars": [{
                "name": "api",
                "process": { "kind": "local", "command": "ambiguous-api" },
                "port": 9111,
                "http": { "routes": [
                    { "path": "/:id", "auth": "public" },
                    { "path": "/admin" }
                ] }
            }]
        }
        "#;
        let err = PluginManifest::parse_and_validate(raw)
            .expect_err("overlapping public and protected routes must fail validation");
        assert!(err.contains("overlap"), "got: {err}");
    }

    // ── route permissions (the vocabulary's consumers) ────────────────────────

    /// A manifest with one sidecar route, so each case below differs only in the
    /// route JSON and the vocabulary it may or may not declare.
    fn manifest_with_route(route_json: &str, levels_json: &str) -> String {
        format!(
            r#"{{
                "id": "com.example.gated",
                "name": "Gated",
                "version": "1.0.0",
                "runnables": [],
                "permission_levels": {levels_json},
                "sidecars": [{{
                    "name": "api",
                    "process": {{ "kind": "local", "command": "gated-api" }},
                    "port": 9111,
                    "http": {{ "routes": [{route_json}] }}
                }}]
            }}"#
        )
    }

    const CLOSE_LEVEL: &str =
        r#"[{ "id": "tabs.close", "label": "Can close tabs", "description": "Closes tabs." }]"#;

    #[test]
    fn a_public_route_may_not_require_a_permission() {
        // The failure this prevents happens at DELIVERY time on someone else's
        // infrastructure: an annotated public webhook 403s for every external
        // caller on an org-bound node, long after the manifest was written.
        let err = PluginManifest::parse_and_validate(&manifest_with_route(
            r#"{ "path": "/webhook", "auth": "public", "permission": "tabs.close" }"#,
            CLOSE_LEVEL,
        ))
        .expect_err("a public route carrying a permission must be refused");
        assert!(
            err.contains("public"),
            "the error must name the cause: {err}"
        );

        // The same annotation on a non-public route is exactly the supported case.
        assert!(PluginManifest::parse_and_validate(&manifest_with_route(
            r#"{ "path": "/webhook", "permission": "tabs.close" }"#,
            CLOSE_LEVEL,
        ))
        .is_ok());
    }

    #[test]
    fn a_route_permission_naming_a_declared_level_validates_and_round_trips() {
        let raw = manifest_with_route(
            r#"{ "path": "/tabs/:id/close", "permission": "tabs.close", "resource_param": "id" }"#,
            CLOSE_LEVEL,
        );
        let manifest =
            PluginManifest::parse_and_validate(&raw).expect("a declared level validates");
        let route = &manifest.sidecars[0].http.as_ref().expect("http").routes[0];
        assert_eq!(route.permission.as_deref(), Some("tabs.close"));
        assert_eq!(route.resource_param.as_deref(), Some("id"));
    }

    /// The gate the whole field depends on: an id nothing declares can never be
    /// granted, so a route requiring it would 403 forever with no visible cause.
    #[test]
    fn a_route_requiring_an_undeclared_permission_is_rejected() {
        let err = PluginManifest::parse_and_validate(&manifest_with_route(
            r#"{ "path": "/tabs/:id/close", "permission": "tabs.destroy" }"#,
            CLOSE_LEVEL,
        ))
        .expect_err("an undeclared permission must fail validation");
        assert!(
            err.contains("com.example.gated"),
            "must name the plugin: {err}"
        );
        assert!(err.contains("'tabs.destroy'"), "must name the level: {err}");

        // Including the case where the manifest declares NO vocabulary at all —
        // the likeliest version of the mistake.
        assert!(PluginManifest::parse_and_validate(&manifest_with_route(
            r#"{ "path": "/tabs", "permission": "tabs.close" }"#,
            "[]",
        ))
        .is_err());
    }

    /// A typo here does not fail loudly at runtime — it silently degrades a rule the
    /// author wrote as per-object into a per-app one, which is strictly weaker.
    #[test]
    fn a_resource_param_the_route_path_does_not_contain_is_rejected() {
        let err = PluginManifest::parse_and_validate(&manifest_with_route(
            r#"{ "path": "/tabs/:id/close", "permission": "tabs.close", "resource_param": "tab" }"#,
            CLOSE_LEVEL,
        ))
        .expect_err("a param absent from the path must fail validation");
        assert!(err.contains(":tab"), "must name the param: {err}");

        // A LITERAL segment of the same name is not a param and must not satisfy it.
        assert!(PluginManifest::parse_and_validate(&manifest_with_route(
            r#"{ "path": "/tabs/id", "permission": "tabs.close", "resource_param": "id" }"#,
            CLOSE_LEVEL,
        ))
        .is_err());
    }

    #[test]
    fn a_resource_param_without_a_permission_is_rejected() {
        let err = PluginManifest::parse_and_validate(&manifest_with_route(
            r#"{ "path": "/tabs/:id", "resource_param": "id" }"#,
            CLOSE_LEVEL,
        ))
        .expect_err("a resource param gating nothing must fail validation");
        assert!(err.contains("resource_param"), "got: {err}");
    }

    /// The back-compat contract, same as [`a_manifest_without_permission_levels_still_parses_and_declares_none`]:
    /// an existing manifest must parse unchanged AND re-serialize without the new
    /// keys, or every shipped manifest's canonical (Gateway-signed) encoding moves.
    #[test]
    fn an_unannotated_route_parses_ungated_and_emits_no_new_keys() {
        let manifest = PluginManifest::parse_and_validate(&manifest_with_route(
            r#"{ "path": "/tabs" }"#,
            "[]",
        ))
        .expect("an unannotated route is still valid");
        let route = &manifest.sidecars[0].http.as_ref().expect("http").routes[0];
        assert!(route.permission.is_none());
        assert!(route.resource_param.is_none());

        let wire = serde_json::to_value(&manifest).expect("manifest serialises");
        let encoded = wire["sidecars"][0]["http"]["routes"][0]
            .as_object()
            .expect("route object");
        assert!(!encoded.contains_key("permission"), "got: {encoded:?}");
        assert!(!encoded.contains_key("resource_param"), "got: {encoded:?}");
    }

    fn oauth_manifest(server: &str, grants: &str) -> String {
        format!(
            r#"{{
                "id": "com.example.oauth",
                "name": "OAuth MCP",
                "version": "1.0.0",
                "permission_grants": {grants},
                "mcp_servers": {{ "mail": {server} }},
                "runnables": []
            }}"#
        )
    }

    #[test]
    fn remote_mcp_oauth_accepts_only_the_public_client_contract() {
        let raw = oauth_manifest(
            r#"{
                "type": "streamable-http",
                "url": "https://mcp.example.com/v1",
                "auth": { "type": "oauth", "client_id": "public-client" }
            }"#,
            r#"["mcp:server", "identity.read"]"#,
        );
        let parsed = PluginManifest::parse_and_validate(&raw).expect("OAuth manifest validates");
        assert_eq!(
            parsed.mcp_servers["mail"]
                .auth
                .as_ref()
                .and_then(McpServerAuthDecl::client_id),
            Some("public-client")
        );

        let secret = raw.replace(
            r#""client_id": "public-client""#,
            r#""client_id": "public-client", "client_secret": "must-not-parse""#,
        );
        assert!(
            serde_json::from_str::<PluginManifest>(&secret).is_err(),
            "unknown auth fields must fail closed"
        );
    }

    #[test]
    fn remote_mcp_oauth_rejects_unsafe_transport_and_competing_auth() {
        for server in [
            r#"{ "command": "npx", "type": "stdio", "auth": { "type": "oauth" } }"#,
            r#"{ "command": "npx", "url": "https://mcp.example.com", "auth": { "type": "oauth" } }"#,
            r#"{ "url": "http://mcp.example.com", "auth": { "type": "oauth" } }"#,
            r#"{ "url": "https://mcp.example.com/#token", "auth": { "type": "oauth" } }"#,
            r#"{
                "url": "https://mcp.example.com",
                "headers": { "authorization": "Bearer plaintext" },
                "auth": { "type": "oauth" }
            }"#,
        ] {
            let raw = oauth_manifest(server, r#"["mcp:server", "identity.read"]"#);
            assert!(
                PluginManifest::parse_and_validate(&raw).is_err(),
                "got: {server}"
            );
        }

        let loopback = oauth_manifest(
            r#"{ "url": "http://127.0.0.1:3000/mcp", "auth": { "type": "oauth" } }"#,
            r#"["mcp:server", "identity.read"]"#,
        );
        assert!(PluginManifest::parse_and_validate(&loopback).is_ok());
    }

    #[test]
    fn remote_mcp_oauth_requires_both_governance_grants() {
        for grants in [r#"[]"#, r#"["mcp:server"]"#, r#"["identity.read"]"#] {
            let raw = oauth_manifest(
                r#"{ "url": "https://mcp.example.com", "auth": { "type": "oauth" } }"#,
                grants,
            );
            assert!(
                PluginManifest::parse_and_validate(&raw).is_err(),
                "got: {grants}"
            );
        }
    }
}
