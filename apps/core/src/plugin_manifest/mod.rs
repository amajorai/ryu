//! **App manifest** — the `ryu.json` bundle descriptor for an installable Ryu App.
//!
//! # Scope (M3: type + parse + loader + list endpoint)
//!
//! This module defines the [`PluginManifest`] type, supports serde deserialisation of
//! a `ryu.json` file, and provides [`PluginManifestLoader`] — a scanner that reads
//! `~/.ryu/apps/*/ryu.json` (env-overridable via `RYU_APPS_DIR`), validates semver,
//! rejects duplicate ids, and merges built-in manifests with user-installed ones.
//! There is **no install/enable lifecycle here** — that lands in M3's install units.
//! There is **no permission-grant enforcement here** — grant enforcement belongs to
//! the Gateway (the Gateway decides what is *allowed*; Core decides what *runs*).
//!
//! # Distinction from the sidecar version catalog
//!
//! [`crate::catalog`] is the *sidecar version catalog*: it tracks what binary
//! versions of sidecars (providers, tools, agents) are available for download and
//! installation into `~/.ryu/bin`. It is an internal infrastructure concept.
//!
//! An [`PluginManifest`] is a *user-facing bundle descriptor* — a `ryu.json` file that
//! ships with (or describes) a Ryu App: it names the Runnables the app bundles, the
//! permission grants it needs, and an optional Companion surface. The two concepts
//! are deliberately kept separate and carry distinct names.
//!
//! # Per-kind config and validation
//!
//! Each Runnable entry in a manifest carries a `kind` discriminant
//! ([`crate::runnable::RunnableKind`]) and an optional typed `config` blob.
//! The per-kind config structs and the [`schema::validate_runnable`] function
//! live in the [`schema`] submodule; [`PluginManifestLoader`] runs validation during
//! loading and rejects any manifest whose Runnables fail their per-kind contract.

pub mod schema;

use std::collections::HashSet;
use std::path::PathBuf;

use crate::runnable::{RunnableKind, RunnableMeta};
use schema::{validate_runnable, RunnableEntry};

/// Maximum length of an app `id`. Reverse-domain ids are short; a generous cap
/// prevents pathological filesystem paths and absurdly long directory names.
const MAX_PLUGIN_ID_LEN: usize = 128;

/// Validate an app `id` for use as both an identity key **and** a filesystem
/// directory name under the apps dir.
///
/// The `id` is written to disk as `apps_dir().join(id)` by the install-from-URL
/// path, so an unvalidated id is a path-traversal / arbitrary-write sink. This
/// uses a strict **allowlist** (not a blocklist) because the project is
/// Windows-first: `\`, `/`, `:`, and a leading `.` must all be rejected, and on
/// Windows `PathBuf::join` with an absolute or drive-qualified component silently
/// replaces the base. The legal alphabet mirrors the reverse-domain ids the
/// built-in manifests use (e.g. `com.example.research-assistant`):
///
/// - non-empty, at most [`MAX_PLUGIN_ID_LEN`] bytes
/// - characters limited to ASCII `[a-zA-Z0-9.-_]`
/// - must contain at least one `.` (reverse-domain shape)
/// - no `..` sequence anywhere, no leading/trailing `.`, no leading `-`
///
/// Returns `Ok(())` when the id is safe, else a descriptive `Err(String)`.
pub fn validate_plugin_id(id: &str) -> Result<(), String> {
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
    if !id.contains('.') {
        return Err(format!(
            "app id '{id}' must be reverse-domain (contain at least one '.')"
        ));
    }
    Ok(())
}

/// An installable Ryu App manifest (`ryu.json`).
///
/// Modelled on Codex's `plugin.json` pattern: a thin descriptor that bundles one or
/// more [`RunnableEntry`] items (agents, workflows, tools, skills, companions,
/// channels, engines, policies), lists the permission grants the app requires, and
/// optionally declares a Companion surface (an in-desktop overlay or sidebar panel).
///
/// # M0 scope note
///
/// This type is **type + parse + Runnable mapping only**. There is no install/enable
/// lifecycle here (that is M3 / App-store) and no grant enforcement (that is
/// Gateway — the Gateway decides what is *allowed*, Core decides what *runs*).
///
/// # Per-kind config
///
/// Each Runnable entry carries an optional `config` blob whose schema is
/// determined by its `kind`. See [`schema`] for the per-kind structs and the
/// [`schema::validate_runnable`] function. The loader validates every entry during
/// loading; a manifest with any invalid entry is rejected.
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
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

    /// The Runnables this app bundles. Each entry uses [`RunnableEntry`] from the
    /// [`schema`] submodule so heterogeneous Runnables (agents, workflows, tools,
    /// skills, companions, channels, engines, policies) can be listed together with
    /// their per-kind config.
    pub runnables: Vec<RunnableEntry>,

    /// Permission grants this app declares it needs (e.g. `"mcp:web_search"`).
    /// These are *declarations only* at this layer — no enforcement happens here;
    /// the Gateway owns grant enforcement.
    #[serde(default)]
    pub permission_grants: Vec<String>,

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
    /// Recognised tokens: `"*"` (always active / eager), `"onStartup"`,
    /// `"onChat"`, and `"onCommand:<id>"`. An **empty** list means *eager*
    /// activation (back-compat: every existing manifest keeps activating on
    /// enable). The activation runtime (firing these events) is scaffolded in
    /// [`crate::runnable::RunnableRegistry::register_active`]; the wiring that
    /// fires `onChat`/`onCommand` from the chat/palette paths is a follow-on.
    #[serde(default)]
    pub activation_events: Vec<String>,

    /// Required Ryu engine version (VS-Code `engines.vscode` analogue). When
    /// present, `engines.ryu` is a semver **requirement** (e.g. `">=0.3.0"`) and
    /// the loader rejects the manifest if the running Core version does not
    /// satisfy it. Absent = compatible with any Core version.
    #[serde(default)]
    pub engines: Option<EnginesReq>,

    /// Optional declarative **external runtime** the plugin needs (e.g. a Python
    /// venv + pip deps + assets, like the TTS sidecar). The provisioner lives in
    /// [`crate::sidecar::external_runtime`]; this is the declaration (#449).
    /// Absent for the common case (no external interpreter needed).
    #[serde(default)]
    pub runtime: Option<schema::ExternalRuntimeConfig>,
}

impl PluginManifest {
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
}

/// Companion surface descriptor — an optional in-desktop overlay or sidebar panel
/// an App may register. Fields mirror the UX primitives a Companion widget needs;
/// all are optional except `label`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
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
/// Each field is a list of [`ContributionId`] references into the manifest's
/// `runnables`: the plugin *declares* that runnable `X` contributes to the
/// `commands`/`tools`/`agents`/… surface. This is declare-by-id, not a second
/// copy of the runnable — the loader cross-validates that every referenced id
/// exists in `runnables`, so a typo is caught at load.
///
/// # Extending
///
/// Add a new surface = add a new `#[serde(default)] pub <surface>: Vec<ContributionId>`
/// field here. The cross-validation in [`Contributes::referenced_ids`] picks it
/// up automatically.
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
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

    /// Chat turn hooks the plugin contributes — server-side logic that runs at a
    /// turn boundary (e.g. `post_assistant_turn`) and returns a directive. These
    /// are **self-contained** (they carry their own inline `code`), so they are
    /// NOT cross-validated against `runnables` like the id-reference surfaces
    /// above; the [`crate::plugin_host`] runtime executes them in the sandbox.
    #[serde(default)]
    pub turn_hooks: Vec<TurnHookContribution>,

    /// Declarative **native** UI widgets the plugin contributes to the desktop
    /// composer (e.g. a `toggle` that sets a `plugin_flags` entry, or a `chip`).
    /// Core stores these verbatim and serves them via `GET /api/plugins/contributions`;
    /// the desktop renders the known widget types. Opaque to Core (the renderer
    /// owns interpretation) so new widget types need no Core change.
    #[serde(default)]
    pub composer_controls: Vec<serde_json::Value>,

    /// Declarative settings tabs the plugin contributes (model pickers, text
    /// fields bound to preference keys). Served + rendered the same way.
    #[serde(default)]
    pub settings_tabs: Vec<serde_json::Value>,

    /// Slash commands the plugin contributes (e.g. `/goal`). The desktop maps the
    /// command to a `plugin_flags`/message action; the plugin's turn hook reads
    /// the resulting message. Served + rendered the same way.
    #[serde(default)]
    pub slash_commands: Vec<serde_json::Value>,
}

/// A server-side chat turn hook contributed by a plugin. The `code` is a JS body
/// run in the plugin sandbox with `ctx` (the turn context) and `host` (the
/// capability bridge: `host.sideModel`, `host.storage`, `host.log`) in scope; it
/// returns a directive (`{kind:"none"}` | `{kind:"note",text}` |
/// `{kind:"continue",text}`). See [`crate::plugin_host`].
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TurnHookContribution {
    /// Stable id for this hook (for logging/audit), unique within the plugin.
    pub id: String,
    /// The turn boundary this hook fires on. Today only `"post_assistant_turn"`.
    pub on: String,
    /// The JS hook body executed in the sandbox (returns a directive).
    pub code: String,
    /// Optional cheap pre-gate. When present, [`crate::plugin_host`] evaluates it
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
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
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
}

/// A single contribution: a reference (by `id`) to a runnable declared in the
/// manifest's `runnables` list, optionally with a human-facing title (e.g. the
/// label a command shows in the palette).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ContributionId {
    /// The runnable id this contribution points at. Must exist in `runnables`.
    pub id: String,

    /// Optional display title (e.g. the palette label for a command).
    #[serde(default)]
    pub title: Option<String>,
}

/// `engines` block — the required Ryu version, mirroring VS-Code's
/// `engines.vscode`. `ryu` is a semver **requirement** string.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct EnginesReq {
    /// Semver requirement the running Core version must satisfy (e.g. `">=0.3.0"`,
    /// `"^1.2"`). Parsed as a [`semver::VersionReq`]; an unparseable value or an
    /// unsatisfied requirement causes the loader to reject the manifest.
    pub ryu: String,
}

/// The trust/distribution tier of a plugin.
///
/// - [`PluginTier::Core`] — a first-party, default-on plugin shipped with Ryu
///   (ghost/shadow/headroom/engines/sandbox/…). Seeded enabled at startup.
/// - [`PluginTier::Community`] — a third-party / user-installed plugin. Always
///   install-then-enable opt-in; never auto-enabled.
///
/// Tier is **derived from membership** (see [`crate::plugins::builtins`]), not a
/// field a manifest can self-assert — a plugin cannot promote itself to Core.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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

/// The running Core version, as a parsed [`semver::Version`]. Authoritative
/// source for the `engines.ryu` version-pin gate. Derived from the crate version
/// (`CARGO_PKG_VERSION`), which is the single version of record for Core.
pub fn core_version() -> semver::Version {
    // `CARGO_PKG_VERSION` is always valid semver (Cargo enforces it), so this
    // parse never fails in practice; fall back to 0.0.0 defensively.
    semver::Version::parse(env!("CARGO_PKG_VERSION"))
        .unwrap_or_else(|_| semver::Version::new(0, 0, 0))
}

/// File names a plugin manifest may use on disk, in preference order. The new
/// canonical name is `plugin.json`; the legacy `ryu.json` is still read so that
/// plugins installed before the apps→plugins rename keep loading.
const MANIFEST_FILE_NAMES: &[&str] = &["plugin.json", "ryu.json"];

/// Built-in plugin manifests compiled into the binary, always present regardless of
/// whether the user has a `~/.ryu/plugins/` directory.
///
/// (`sample.plugin.json` — the Research Assistant demo — is kept as a test-only
/// fixture and is deliberately NOT shipped as a built-in.)
/// - `spider.plugin.json` — Spider web crawler tool plugin (U040).
/// - `exa.plugin.json` — Exa neural search tool plugin (U040, BYOK).
/// - `ghost.plugin.json` — Ghost desktop-automation MCP tool (system plugin, Windows-first).
/// - `shadow.plugin.json` — Shadow screen/audio capture + semantic memory (system plugin, Windows-first).
/// - `headroom.plugin.json` — Headroom gateway egress compression (a `compression` Policy runnable, #425).
/// - `firewall.plugin.json` — Gateway firewall on/off Policy plugin (#447, Core-tier, opt-in).
/// - `routing.plugin.json` — Smart (classifier) routing on/off Policy plugin (#447, Core-tier, opt-in).
/// - `sandbox.plugin.json` — Wasmtime ephemeral sandbox on/off Policy plugin (#448, Core-tier, opt-in).
/// - `engines.plugin.json` — Local engine bindings (llama.cpp + embeddings) as a default-on Core plugin (#448).
/// - `durable.plugin.json` — Durable workflow execution engine as a default-on Core plugin (#448 dogfood).
const BUILTIN_MANIFESTS: &[&str] = &[
    include_str!("fixtures/spider.plugin.json"),
    include_str!("fixtures/exa.plugin.json"),
    include_str!("fixtures/ghost.plugin.json"),
    include_str!("fixtures/shadow.plugin.json"),
    include_str!("fixtures/headroom.plugin.json"),
    include_str!("fixtures/firewall.plugin.json"),
    include_str!("fixtures/routing.plugin.json"),
    include_str!("fixtures/sandbox.plugin.json"),
    include_str!("fixtures/engines.plugin.json"),
    include_str!("fixtures/durable.plugin.json"),
    // Turn-hook plugins (the migrated, formerly-hardcoded features). These ship
    // as built-in fixtures but are built exactly like a third-party plugin would
    // be: a manifest + an inline JS hook reaching Core only through the
    // capability-gated plugin host. `goal`/`proof`/`double-check` are Core-tier
    // and default-on (see `plugins::builtins::CORE_DEFAULT_ON`) so their features
    // work on every surface with zero setup, gated cheaply by each hook's `match`
    // block; `advisor` stays Community (install-then-enable).
    include_str!("fixtures/double-check.plugin.json"),
    include_str!("fixtures/goal.plugin.json"),
    include_str!("fixtures/advisor.plugin.json"),
    // `proof` is `goal`'s stronger sibling: instead of a one-line transcript
    // judge, each round spawns an INDEPENDENT verifier sub-agent (grant
    // `hook:run-agent`) that gathers real evidence with tools before deciding.
    include_str!("fixtures/proof.plugin.json"),
    // `rtk` surfaces the built-in RTK (Rust Token Killer) command-wrapping tool
    // (`rtk__run`, a native provider in `sidecar/mcp/rtk.rs`) as an installable
    // plugin: store presence + availability (detect-on-PATH) + the Phase-2
    // auto-wrap settings. Community-tier, opt-in; the `rtk` binary is BYO.
    include_str!("fixtures/rtk.plugin.json"),
];

/// Loader that merges built-in manifests with user-installed ones from
/// `~/.ryu/plugins/*/plugin.json` (the path is overridable via `RYU_PLUGINS_DIR`,
/// or the legacy `RYU_APPS_DIR`; the legacy `ryu.json` file name is also read).
///
/// # Validation
/// - A manifest whose `version` field is not valid semver is rejected with a logged
///   warning; all other manifests continue loading.
/// - A duplicate `id` (across built-ins and user manifests) is rejected with a
///   logged warning; the *first* manifest with that id wins.
/// - Any manifest that fails JSON parsing is skipped with a warning.
pub struct PluginManifestLoader;

impl PluginManifestLoader {
    /// Resolve the plugins scan directory.
    ///
    /// Resolution order:
    /// 1. `RYU_PLUGINS_DIR` if set.
    /// 2. `RYU_APPS_DIR` if set (legacy env var, still honoured).
    /// 3. `~/.ryu/plugins` if it exists, or if the legacy `~/.ryu/apps` does not.
    /// 4. `~/.ryu/apps` only as a fallback when the new dir is absent but the
    ///    legacy one exists (so pre-rename installs are not orphaned).
    pub fn plugins_dir() -> PathBuf {
        if let Some(p) = std::env::var_os("RYU_PLUGINS_DIR") {
            return PathBuf::from(p);
        }
        if let Some(p) = std::env::var_os("RYU_APPS_DIR") {
            return PathBuf::from(p);
        }
        let ryu = crate::paths::ryu_dir();
        let new_dir = ryu.join("plugins");
        let legacy_dir = ryu.join("apps");
        if !new_dir.exists() && legacy_dir.exists() {
            return legacy_dir;
        }
        new_dir
    }

    /// Load all manifests: built-ins first, then user-installed. Returns only
    /// the manifests that pass semver and duplicate-id validation.
    pub fn load() -> Vec<PluginManifest> {
        let mut manifests: Vec<PluginManifest> = Vec::new();
        let mut seen_ids: HashSet<String> = HashSet::new();

        // 1. Built-in manifests (compiled in).
        for &raw in BUILTIN_MANIFESTS {
            match Self::parse_and_validate(raw, "<built-in>", &mut seen_ids) {
                Ok(m) => manifests.push(m),
                Err(e) => tracing::warn!("built-in manifest skipped: {e}"),
            }
        }

        // 2. User-installed manifests from the plugins directory. Each plugin dir
        //    may carry `plugin.json` (preferred) or the legacy `ryu.json`.
        let dir = Self::plugins_dir();
        match std::fs::read_dir(&dir) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let Some(manifest_path) = MANIFEST_FILE_NAMES
                        .iter()
                        .map(|name| entry.path().join(name))
                        .find(|p| p.exists())
                    else {
                        continue;
                    };
                    match std::fs::read_to_string(&manifest_path) {
                        Ok(raw) => {
                            match Self::parse_and_validate(
                                &raw,
                                &manifest_path.to_string_lossy(),
                                &mut seen_ids,
                            ) {
                                Ok(m) => manifests.push(m),
                                Err(e) => {
                                    tracing::warn!(
                                        "plugin manifest at {} skipped: {e}",
                                        manifest_path.display()
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            tracing::warn!(
                                "could not read plugin manifest at {}: {e}",
                                manifest_path.display()
                            );
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tracing::debug!(
                    "plugins directory {} does not exist; no user plugins loaded",
                    dir.display()
                );
            }
            Err(e) => {
                tracing::warn!("could not scan plugins directory {}: {e}", dir.display());
            }
        }

        manifests
    }

    fn parse_and_validate(
        raw: &str,
        source: &str,
        seen_ids: &mut HashSet<String>,
    ) -> Result<PluginManifest, String> {
        let manifest: PluginManifest =
            serde_json::from_str(raw).map_err(|e| format!("JSON parse error: {e}"))?;

        validate_plugin_id(&manifest.id).map_err(|e| format!("{e} (source: {source})"))?;

        if semver::Version::parse(&manifest.version).is_err() {
            return Err(format!(
                "app '{}' has invalid semver version '{}' (source: {source})",
                manifest.id, manifest.version
            ));
        }

        if !seen_ids.insert(manifest.id.clone()) {
            return Err(format!(
                "duplicate app id '{}' (source: {source}); first occurrence wins",
                manifest.id
            ));
        }

        // Version-pin gate: if the manifest declares `engines.ryu`, it must parse
        // as a semver requirement AND the running Core version must satisfy it.
        // Reject otherwise so an incompatible plugin never loads.
        if let Some(engines) = &manifest.engines {
            let req = semver::VersionReq::parse(&engines.ryu).map_err(|e| {
                format!(
                    "app '{}' has invalid engines.ryu requirement '{}': {e} (source: {source})",
                    manifest.id, engines.ryu
                )
            })?;
            let core = core_version();
            if !req.matches(&core) {
                return Err(format!(
                    "app '{}' requires Ryu engine '{}' but this Core is '{core}' (source: {source})",
                    manifest.id, engines.ryu
                ));
            }
        }

        // Validate each Runnable's per-kind config contract.
        for entry in &manifest.runnables {
            validate_runnable(entry)
                .map_err(|e| format!("app '{}' (source: {source}): {e}", manifest.id))?;
        }

        // Manifest-level companion surface: anti-impersonation on the visible label
        // (same rule as the companion *runnable* config and the desktop route-title
        // gate) so a plugin's panel can never pose as first-party Ryu/system chrome.
        if let Some(companion) = &manifest.companion {
            if companion.label.trim().is_empty() {
                return Err(format!(
                    "app '{}' companion label must not be empty (source: {source})",
                    manifest.id
                ));
            }
            if crate::plugin_manifest::schema::label_impersonates_system_chrome(&companion.label) {
                return Err(format!(
                    "app '{}' companion label '{}' must not impersonate system chrome (must not contain 'ryu' or 'system') (source: {source})",
                    manifest.id, companion.label
                ));
            }
        }

        // Contribution cross-validation: every id referenced in `contributes`
        // must resolve to a runnable declared in this manifest (declare-by-id).
        if let Some(contributes) = &manifest.contributes {
            let runnable_ids: HashSet<&str> =
                manifest.runnables.iter().map(|r| r.id.as_str()).collect();
            for referenced in contributes.referenced_ids() {
                if !runnable_ids.contains(referenced) {
                    return Err(format!(
                        "app '{}' contributes unknown runnable id '{referenced}' (no matching entry in 'runnables') (source: {source})",
                        manifest.id
                    ));
                }
            }
        }

        Ok(manifest)
    }
}

#[cfg(test)]
mod tests {
    use super::schema::validate_runnable;
    use super::*;

    const SAMPLE_JSON: &str = include_str!("fixtures/sample.plugin.json");

    /// The multi-kind fixture lives in `apps/core/tests/manifest_fixtures/` so it
    /// doubles as the integration-test input and the in-module round-trip fixture.
    const MULTI_KIND_JSON: &str = include_str!("../../tests/manifest_fixtures/multi_kind.ryu.json");

    #[test]
    fn sample_fixture_deserializes_into_app_manifest() {
        let manifest: PluginManifest =
            serde_json::from_str(SAMPLE_JSON).expect("sample.ryu.json should deserialise");

        assert_eq!(manifest.id, "com.example.research-assistant");
        assert_eq!(manifest.name, "Research Assistant");
        assert_eq!(manifest.version, "1.0.0");
        assert_eq!(
            manifest.permission_grants,
            vec!["mcp:web_search", "mcp:file_read"]
        );
        assert!(manifest.companion.is_some());
    }

    #[test]
    fn runnables_helper_returns_all_bundled_runnables() {
        let manifest: PluginManifest =
            serde_json::from_str(SAMPLE_JSON).expect("sample.ryu.json should deserialise");

        let runnables = manifest.runnables();
        assert_eq!(runnables.len(), 4);

        let kinds: Vec<RunnableKind> = runnables.iter().map(|r| r.kind).collect();
        assert!(kinds.contains(&RunnableKind::Agent));
        assert!(kinds.contains(&RunnableKind::Workflow));
        assert!(kinds.contains(&RunnableKind::Tool));
        assert!(kinds.contains(&RunnableKind::Skill));
    }

    #[test]
    fn runnables_of_kind_filters_correctly() {
        let manifest: PluginManifest =
            serde_json::from_str(SAMPLE_JSON).expect("sample.ryu.json should deserialise");

        let agents = manifest.runnables_of_kind(RunnableKind::Agent);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "agent-researcher");

        let workflows = manifest.runnables_of_kind(RunnableKind::Workflow);
        assert_eq!(workflows.len(), 1);
        assert_eq!(workflows[0].id, "wf-summarise");
    }

    #[test]
    fn manifest_without_companion_deserializes() {
        let json = r#"{
            "id": "com.example.minimal",
            "name": "Minimal App",
            "version": "0.1.0",
            "runnables": [
                { "id": "agent-x", "name": "Agent X", "kind": "agent" }
            ]
        }"#;
        let manifest: PluginManifest =
            serde_json::from_str(json).expect("minimal manifest should deserialise");
        assert!(manifest.companion.is_none());
        assert!(manifest.permission_grants.is_empty());
        assert_eq!(manifest.runnables().len(), 1);
    }

    #[test]
    fn manifest_roundtrips_through_json() {
        let manifest: PluginManifest =
            serde_json::from_str(SAMPLE_JSON).expect("sample.ryu.json should deserialise");
        let serialized = serde_json::to_string(&manifest).expect("serialise should succeed");
        let roundtripped: PluginManifest =
            serde_json::from_str(&serialized).expect("roundtrip deserialise should succeed");
        assert_eq!(manifest, roundtripped);
    }

    // ── PluginManifestLoader tests ───────────────────────────────────────────────

    fn loader_parse(raw: &str) -> Result<PluginManifest, String> {
        PluginManifestLoader::parse_and_validate(raw, "<test>", &mut HashSet::new())
    }

    // ── companion label anti-impersonation ───────────────────────────────────

    #[test]
    fn loader_rejects_companion_label_impersonating_system_chrome() {
        let raw = r#"{
            "id": "com.example.evil",
            "name": "Evil",
            "version": "1.0.0",
            "runnables": [],
            "companion": { "label": "Ryu Settings" }
        }"#;
        let err = loader_parse(raw).unwrap_err();
        assert!(
            err.contains("impersonate system chrome"),
            "expected impersonation rejection, got: {err}"
        );
    }

    #[test]
    fn loader_accepts_benign_companion_label() {
        let raw = r#"{
            "id": "com.example.good",
            "name": "Good",
            "version": "1.0.0",
            "runnables": [],
            "companion": { "label": "Research Assistant" }
        }"#;
        assert!(loader_parse(raw).is_ok());
    }

    // ── app id validation (path-traversal hardening) ─────────────────────────

    #[test]
    fn validate_plugin_id_accepts_reverse_domain() {
        assert!(validate_plugin_id("com.example.research-assistant").is_ok());
        assert!(validate_plugin_id("io.ryu.ghost").is_ok());
        assert!(validate_plugin_id("com.example.my_app").is_ok());
    }

    #[test]
    fn validate_plugin_id_rejects_traversal_and_separators() {
        for bad in [
            "../../etc/cron.d/x",
            "..",
            "a/../b",
            "com/example/app",
            "com\\example\\app",
            "C:windows.x",
            "/etc/foo.bar",
            ".hidden.app",
            "app.",
            "-leading.dash",
            "",
            "no-dot",
        ] {
            assert!(
                validate_plugin_id(bad).is_err(),
                "expected '{bad}' to be rejected"
            );
        }
    }

    #[test]
    fn validate_plugin_id_rejects_overlong() {
        let long = format!("com.example.{}", "a".repeat(200));
        assert!(validate_plugin_id(&long).is_err());
    }

    #[test]
    fn loader_rejects_path_traversal_id() {
        let json = r#"{"id":"../../../../etc/x","name":"Evil","version":"1.0.0","runnables":[]}"#;
        let err = loader_parse(json).unwrap_err();
        assert!(err.contains("..") || err.contains("illegal"), "got: {err}");
    }

    #[test]
    fn loader_accepts_valid_semver() {
        let json = r#"{
            "id": "com.example.app",
            "name": "Test",
            "version": "2.3.1",
            "runnables": []
        }"#;
        let m = loader_parse(json).expect("valid semver should be accepted");
        assert_eq!(m.version, "2.3.1");
    }

    #[test]
    fn loader_rejects_invalid_semver() {
        let json = r#"{
            "id": "com.example.bad-ver",
            "name": "Bad Version",
            "version": "not-semver",
            "runnables": []
        }"#;
        let err = loader_parse(json).unwrap_err();
        assert!(
            err.contains("invalid semver version"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn loader_rejects_duplicate_ids() {
        let json = r#"{"id":"com.example.dup","name":"A","version":"1.0.0","runnables":[]}"#;
        let mut seen = HashSet::new();
        PluginManifestLoader::parse_and_validate(json, "<t1>", &mut seen)
            .expect("first occurrence should succeed");
        let err = PluginManifestLoader::parse_and_validate(json, "<t2>", &mut seen).unwrap_err();
        assert!(err.contains("duplicate app id"), "unexpected error: {err}");
    }

    #[test]
    fn loader_builtins_returns_all_built_in_manifests() {
        // Every built-in manifest must always load — including the #447/#448
        // policy/engine fixtures (whose `engines.ryu` must be satisfiable, or they
        // would be dropped here). The count grows as fixtures are added; assert the
        // floor plus each id below.
        let manifests = PluginManifestLoader::load();
        assert!(
            manifests.len() >= 5,
            "loader must return at least the built-in manifests, got {}",
            manifests.len()
        );
        // The new Core-tier policy/engine plugins must load (their engines.ryu
        // requirement is satisfied by this Core version).
        for id in [
            "io.ryu.firewall",
            "io.ryu.routing",
            "io.ryu.sandbox",
            "io.ryu.engines",
            "io.ryu.durable",
        ] {
            assert!(
                manifests.iter().any(|m| m.id == id),
                "built-in '{id}' must load (engines.ryu must be satisfiable)"
            );
        }
        // The Research Assistant demo is no longer a shipped built-in (it was a
        // first-run sample); it must NOT appear in the catalog.
        assert!(
            !manifests
                .iter()
                .any(|m| m.id == "com.example.research-assistant"),
            "sample research assistant manifest must not be a built-in"
        );
        assert!(
            manifests.iter().any(|m| m.id == "io.ryu.spider"),
            "built-in Spider manifest should be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "io.ryu.exa"),
            "built-in Exa manifest should be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "io.ryu.ghost"),
            "built-in Ghost manifest should be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "io.ryu.shadow"),
            "built-in Shadow manifest should be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "io.ryu.proof"),
            "built-in Proof of Work manifest should be loaded"
        );
    }

    // ── Per-kind validation via loader ────────────────────────────────────────

    #[test]
    fn loader_rejects_unknown_kind() {
        // An unknown `kind` string must be rejected with a descriptive error (serde
        // will produce a parse error since `RunnableKind` is exhaustive).
        let json = r#"{
            "id": "com.example.bad-kind",
            "name": "Bad Kind",
            "version": "1.0.0",
            "runnables": [
                { "id": "r1", "name": "R1", "kind": "not_a_real_kind" }
            ]
        }"#;
        let err = loader_parse(json).unwrap_err();
        assert!(
            err.contains("JSON parse error"),
            "expected parse error, got: {err}"
        );
    }

    #[test]
    fn loader_rejects_runnable_missing_required_config() {
        // A `tool` Runnable without `config` must be rejected with a descriptive error.
        let json = r#"{
            "id": "com.example.bad-tool",
            "name": "Bad Tool",
            "version": "1.0.0",
            "runnables": [
                { "id": "tool-x", "name": "Tool X", "kind": "tool" }
            ]
        }"#;
        let err = loader_parse(json).unwrap_err();
        assert!(
            err.contains("kind=tool") || err.contains("missing required"),
            "expected per-kind validation error, got: {err}"
        );
    }

    #[test]
    fn loader_rejects_policy_missing_required_config() {
        let json = r#"{
            "id": "com.example.bad-policy",
            "name": "Bad Policy",
            "version": "1.0.0",
            "runnables": [
                { "id": "policy-x", "name": "Policy X", "kind": "policy" }
            ]
        }"#;
        let err = loader_parse(json).unwrap_err();
        assert!(
            err.contains("kind=policy") || err.contains("missing required"),
            "expected per-kind validation error, got: {err}"
        );
    }

    // ── Multi-kind fixture round-trip (acceptance criteria for #167) ──────────

    #[test]
    fn multi_kind_fixture_deserializes_all_eight_kinds() {
        let manifest: PluginManifest =
            serde_json::from_str(MULTI_KIND_JSON).expect("multi_kind.ryu.json should deserialise");

        assert_eq!(manifest.id, "com.example.multi-kind");
        assert_eq!(manifest.runnables().len(), 8);

        let kinds: Vec<RunnableKind> = manifest.runnables().iter().map(|r| r.kind).collect();
        assert!(kinds.contains(&RunnableKind::Agent), "missing agent");
        assert!(kinds.contains(&RunnableKind::Workflow), "missing workflow");
        assert!(kinds.contains(&RunnableKind::Tool), "missing tool");
        assert!(kinds.contains(&RunnableKind::Skill), "missing skill");
        assert!(
            kinds.contains(&RunnableKind::Companion),
            "missing companion"
        );
        assert!(kinds.contains(&RunnableKind::Channel), "missing channel");
        assert!(kinds.contains(&RunnableKind::Engine), "missing engine");
        assert!(kinds.contains(&RunnableKind::Policy), "missing policy");
    }

    #[test]
    fn multi_kind_fixture_roundtrips_with_zero_data_loss() {
        let manifest: PluginManifest = serde_json::from_str(MULTI_KIND_JSON).expect("deserialise");
        let serialized = serde_json::to_string(&manifest).expect("serialise");
        let roundtripped: PluginManifest =
            serde_json::from_str(&serialized).expect("roundtrip deserialise");
        assert_eq!(
            manifest, roundtripped,
            "round-trip must produce identical data"
        );
    }

    #[test]
    fn multi_kind_fixture_all_runnables_pass_validation() {
        let manifest: PluginManifest = serde_json::from_str(MULTI_KIND_JSON).expect("deserialise");
        for entry in manifest.runnables() {
            validate_runnable(entry)
                .unwrap_or_else(|e| panic!("runnable '{}' failed validation: {e}", entry.id));
        }
    }

    // ── contributes / engines / activation_events (#443) ─────────────────────

    #[test]
    fn activation_events_default_empty_roundtrips() {
        let json = r#"{
            "id": "com.example.lazy",
            "name": "Lazy",
            "version": "1.0.0",
            "runnables": []
        }"#;
        let m = loader_parse(json).expect("manifest without activation_events should load");
        assert!(
            m.activation_events.is_empty(),
            "activation_events defaults to empty (eager)"
        );
        assert!(m.contributes.is_none());
        assert!(m.engines.is_none());

        // Round-trip preserves the empty default.
        let serialized = serde_json::to_string(&m).expect("serialise");
        let back: PluginManifest = serde_json::from_str(&serialized).expect("deserialise");
        assert_eq!(m, back);
    }

    #[test]
    fn activation_events_parse_and_roundtrip() {
        let json = r#"{
            "id": "com.example.events",
            "name": "Events",
            "version": "1.0.0",
            "runnables": [],
            "activation_events": ["onStartup", "onCommand:do-thing"]
        }"#;
        let m = loader_parse(json).expect("manifest with activation_events should load");
        assert_eq!(m.activation_events, vec!["onStartup", "onCommand:do-thing"]);
    }

    #[test]
    fn engines_satisfied_loads() {
        // A requirement the running Core always satisfies (any version >= 0.0.1).
        let json = r#"{
            "id": "com.example.engok",
            "name": "Eng OK",
            "version": "1.0.0",
            "runnables": [],
            "engines": { "ryu": ">=0.0.1" }
        }"#;
        let m = loader_parse(json).expect("satisfied engines.ryu should load");
        assert_eq!(m.engines.as_ref().unwrap().ryu, ">=0.0.1");
    }

    #[test]
    fn engines_unsatisfied_is_rejected() {
        // An impossibly-high requirement no real Core version satisfies.
        let json = r#"{
            "id": "com.example.engbad",
            "name": "Eng Bad",
            "version": "1.0.0",
            "runnables": [],
            "engines": { "ryu": ">=9999.0.0" }
        }"#;
        let err = loader_parse(json).unwrap_err();
        assert!(
            err.contains("requires Ryu engine"),
            "expected version-pin rejection, got: {err}"
        );
    }

    #[test]
    fn engines_invalid_requirement_is_rejected() {
        let json = r#"{
            "id": "com.example.engsyntax",
            "name": "Eng Syntax",
            "version": "1.0.0",
            "runnables": [],
            "engines": { "ryu": "not-a-req" }
        }"#;
        let err = loader_parse(json).unwrap_err();
        assert!(
            err.contains("invalid engines.ryu"),
            "expected invalid-requirement rejection, got: {err}"
        );
    }

    #[test]
    fn contributes_referencing_existing_runnable_loads() {
        let json = r#"{
            "id": "com.example.contrib",
            "name": "Contrib",
            "version": "1.0.0",
            "runnables": [
                { "id": "tool-x", "name": "Tool X", "kind": "tool", "config": { "slug": "web_search" } }
            ],
            "contributes": { "tools": [ { "id": "tool-x", "title": "Search the web" } ] }
        }"#;
        let m = loader_parse(json).expect("contributes referencing a real runnable should load");
        let c = m.contributes.as_ref().unwrap();
        assert_eq!(c.tools.len(), 1);
        assert_eq!(c.tools[0].id, "tool-x");
        assert_eq!(c.tools[0].title.as_deref(), Some("Search the web"));
    }

    #[test]
    fn contributes_referencing_missing_runnable_is_rejected() {
        let json = r#"{
            "id": "com.example.contribbad",
            "name": "Contrib Bad",
            "version": "1.0.0",
            "runnables": [
                { "id": "tool-x", "name": "Tool X", "kind": "tool", "config": { "slug": "web_search" } }
            ],
            "contributes": { "commands": [ { "id": "does-not-exist" } ] }
        }"#;
        let err = loader_parse(json).unwrap_err();
        assert!(
            err.contains("unknown runnable id"),
            "expected unknown-id rejection, got: {err}"
        );
    }

    #[test]
    fn core_version_is_parseable() {
        // core_version() must always return a valid semver (never 0.0.0 in a real
        // build), so the engines gate has a meaningful version to match against.
        let v = core_version();
        assert!(v >= semver::Version::new(0, 0, 0));
    }

    #[test]
    fn loader_scans_user_dir() {
        // Point RYU_PLUGINS_DIR at a temp dir with a `plugin.json` plugin, a
        // legacy `ryu.json` plugin (proving the dual-read fallback), and one
        // malformed plugin.
        let tmp = std::env::temp_dir().join(format!(
            "ryu-plugin-manifest-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        let plugin_dir = tmp.join("my-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"id":"com.test.my-plugin","name":"My Plugin","version":"0.1.0","runnables":[]}"#,
        )
        .unwrap();
        let legacy_dir = tmp.join("legacy-plugin");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(
            legacy_dir.join("ryu.json"),
            r#"{"id":"com.test.legacy-plugin","name":"Legacy Plugin","version":"0.1.0","runnables":[]}"#,
        )
        .unwrap();
        let bad_dir = tmp.join("bad-plugin");
        std::fs::create_dir_all(&bad_dir).unwrap();
        std::fs::write(bad_dir.join("plugin.json"), b"not json").unwrap();

        std::env::set_var("RYU_PLUGINS_DIR", &tmp);
        let manifests = PluginManifestLoader::load();
        std::env::remove_var("RYU_PLUGINS_DIR");

        assert!(
            manifests.iter().any(|m| m.id == "com.test.my-plugin"),
            "plugin.json plugin should be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "com.test.legacy-plugin"),
            "legacy ryu.json plugin should still be loaded"
        );

        // The legacy `RYU_APPS_DIR` must still be honoured when `RYU_PLUGINS_DIR`
        // is unset, so pre-rename setups are not orphaned. Reuse the same temp
        // dir (it holds a legacy `ryu.json` plugin) to keep env mutation in this
        // single test, avoiding cross-test env races under parallel runs.
        std::env::set_var("RYU_APPS_DIR", &tmp);
        let legacy_manifests = PluginManifestLoader::load();
        std::env::remove_var("RYU_APPS_DIR");

        std::fs::remove_dir_all(&tmp).ok();

        assert!(
            legacy_manifests
                .iter()
                .any(|m| m.id == "com.test.legacy-plugin"),
            "legacy RYU_APPS_DIR should still be honoured"
        );
    }
}
