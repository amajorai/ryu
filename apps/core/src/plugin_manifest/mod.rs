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
/// replaces the base. The legal alphabet accepts both bare-kebab ids the built-in
/// manifests use (e.g. `ghost`, `data-grid-explorer`) and any legacy dotted
/// third-party id (e.g. `com.example.research-assistant`) for back-compat:
///
/// - non-empty, at most [`MAX_PLUGIN_ID_LEN`] bytes
/// - characters limited to ASCII `[a-zA-Z0-9.-_]`
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

    /// **Plugin-to-plugin dependencies** — the other plugins this one needs (the
    /// npm-shaped edge that lets the app decompose into a kernel + features).
    /// Resolved into a topological enable order by [`crate::plugins::graph`].
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

    /// Optional declarative **external runtime** the plugin needs (e.g. a Python
    /// venv + pip deps + assets, like the TTS sidecar). The provisioner lives in
    /// [`crate::sidecar::external_runtime`]; this is the declaration (#449).
    /// Absent for the common case (no external interpreter needed).
    #[serde(default)]
    pub runtime: Option<schema::ExternalRuntimeConfig>,

    /// Declarative **managed sidecars** the plugin ships (the app ⇄ sidecar
    /// bridge): each is a long-running child process Core downloads/provisions,
    /// spawns, and health-monitors via the [`crate::sidecar::SidecarManager`] on
    /// enable, exactly like a built-in sidecar. Gated at enable by the
    /// `sidecar:process` grant (Core-tier auto; Community needs the approved
    /// grant). Empty for the common case (no bundled process).
    #[serde(default)]
    pub sidecars: Vec<schema::SidecarSpec>,

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

    /// App-Store gallery screenshot URLs (Ryu extension).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub screenshots: Vec<String>,

    /// Publisher/author. Claude `author` — a bare string or an object with a
    /// `name` field; the detail builder extracts the display string into
    /// `developer`. Kept as a raw value so both shapes round-trip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<serde_json::Value>,

    /// Free-text category (Claude `category`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,

    /// Homepage/website URL (Claude `homepage`; emitted as `website`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,

    /// SPDX license identifier (Claude `license`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,

    /// Search keywords / tags (Claude `keywords`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,

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
    /// [`schema::capabilities_from_grants`]; declared values are used verbatim.
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
    /// **An empty `targets` list means every surface** — the backward-compatible
    /// default. Filtering applies only when `targets` is explicitly non-empty.
    pub fn supports_surface(&self, surface: Surface) -> bool {
        self.targets.is_empty() || self.targets.contains(&surface)
    }
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

    /// App widgets the plugin contributes (Ryu Apps). Each binds a tool id to a
    /// `ui://widget/<slug>.html` template the tool renders inline in chat. The
    /// field is shape-identical to the SDK `manifest.ts` `WidgetContribution`.
    #[serde(default)]
    pub widgets: Vec<WidgetContribution>,
}

/// One app-widget contribution (Ryu Apps). Binds the tool that renders the widget
/// to its HTML template. `ui_entry` is the source entry the SDK `ryu pack` builds
/// into the self-contained HTML for third-party apps; built-in apps serve HTML
/// from the in-process provider and leave it unset.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
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
    /// Run if the tool being called (`ctx.tool_name`) matches any of these
    /// patterns — for `pre_tool_use` / `post_tool_use` hooks. A pattern is a tool
    /// id with optional leading/trailing `*` wildcards (`"*"` = every tool,
    /// `"bash*"` = ids starting with `bash`). This keeps a tool-firewall hook from
    /// spawning the sandbox on every unrelated tool call.
    #[serde(default)]
    pub tools: Vec<String>,
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

/// `requires` block — the plugin's **plugin-to-plugin** dependencies.
///
/// This is the npm-shaped edge that lets the app decompose into a minimal kernel
/// plus features: a plugin declares the other plugins it needs, and the lifecycle
/// (see [`crate::plugins::graph`]) resolves them into a topological enable order.
///
/// Distinct from [`EnginesReq`], which constrains plugin→**Core** (the engine
/// version). `requires` constrains plugin→**plugin**.
///
/// Absent (the default, and the case for every manifest that predates this field)
/// means *no dependencies* — the plugin enables standalone exactly as before.
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
pub struct Requires {
    /// Other plugins that must be installed (and are auto-enabled, in dependency
    /// order) before this one can enable.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub apps: Vec<AppDependency>,

    /// Permission grants implied by the dependencies. Declaration only — the
    /// Gateway remains the sole authority on what a grant *allows* (Core decides
    /// what runs; the Gateway decides what is permitted).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grants: Vec<String>,
}

/// A single plugin-to-plugin dependency edge.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
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
}

impl Surface {
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
/// - `spider.plugin.json` — Spider web crawler tool (system plugin, sidecar-backed).
/// - `agentbrowser.plugin.json` — Agent Browser web-browsing tool (system plugin, npx MCP-backed).
/// - `exa.plugin.json` — Exa neural search tool plugin (U040, BYOK).
/// - `ghost.plugin.json` — Ghost desktop-automation MCP tool (system plugin, Windows-first).
/// - `shadow.plugin.json` — Shadow screen/audio capture + semantic memory (system plugin, Windows-first).
///
/// The four sidecar-backed system tools (`spider`, `agentbrowser`, `ghost`,
/// `shadow`) declare an **empty** `runnables` list on purpose: their tools are
/// owned by their dedicated MCP provider (the `ghost`/`shadow`/`spider` modules
/// in `sidecar/mcp/`, and the `agentbrowser` npx MCP server registered in
/// `sidecar/mcp/mod.rs::builtin_servers`). The plugin record is the
/// install/enable/tier **governance shell** around that provider; declaring the
/// tools again here would double-list every one as an `app__<slug>` alias
/// (`fire_activation_event` → the Tool handler in `server/mod.rs`). Do not
/// re-add tool runnables to these fixtures.
/// - `headroom.plugin.json` — Headroom gateway egress compression (a `compression` Policy runnable, #425).
/// - `firewall.plugin.json` — Gateway firewall on/off Policy plugin (#447, Core-tier, opt-in).
/// - `routing.plugin.json` — Smart (classifier) routing on/off Policy plugin (#447, Core-tier, opt-in).
/// - `sandbox.plugin.json` — Wasmtime ephemeral sandbox on/off Policy plugin (#448, Core-tier, opt-in).
/// - `engines.plugin.json` — Local engine bindings (llama.cpp + embeddings) as a default-on Core plugin (#448).
/// - `durable.plugin.json` — Durable workflow execution engine as a default-on Core plugin (#448 dogfood).
/// - `predict.plugin.json` — System-wide predictive typing on/off (a `predict` Policy runnable; Core-tier, opt-in). The plugin is the single switch for the `/api/predict/*` brain.
const BUILTIN_MANIFESTS: &[&str] = &[
    include_str!("fixtures/spider.plugin.json"),
    include_str!("fixtures/agentbrowser.plugin.json"),
    include_str!("fixtures/exa.plugin.json"),
    include_str!("fixtures/ghost.plugin.json"),
    include_str!("fixtures/shadow.plugin.json"),
    include_str!("fixtures/headroom.plugin.json"),
    include_str!("fixtures/firewall.plugin.json"),
    include_str!("fixtures/routing.plugin.json"),
    include_str!("fixtures/sandbox.plugin.json"),
    include_str!("fixtures/engines.plugin.json"),
    include_str!("fixtures/durable.plugin.json"),
    // System-wide predictive typing on/off (Policy-gated, Core-local). Opt-in like
    // firewall/routing/sandbox: enabling the plugin is the single switch for the
    // /api/predict/* brain — there is no separate config toggle.
    include_str!("fixtures/predict.plugin.json"),
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
    // `security-guidance` ports Anthropic's security-guidance Claude Code plugin
    // onto Ryu's turn-hook substrate: a flag-gated `post_assistant_turn` hook that
    // (1) runs a ~22-rule regex pattern scan over the last answer and (2) does a
    // second-model diff review via `host.sideModel` (grant `hook:side-model`),
    // surfacing findings as an out-of-band note. Toggle + `/security` command +
    // reviewer-model picker mirror `double-check`. Community-tier, opt-in.
    include_str!("fixtures/security-guidance.plugin.json"),
    // `auto-expand` is the first `pre_user_turn` hook: before a message is sent it
    // calls a configurable model (`hook:side-model`) to rewrite the prompt into a
    // clearer form and returns a `replace` directive, so the improved prompt is
    // what gets sent and persisted. Composer toggle (auto-expand every message) +
    // `/expand` command (one-off). Core-tier, default-on; the flag/command `match`
    // keeps it free when idle.
    include_str!("fixtures/auto-expand.plugin.json"),
    // `session-context` is a reference `session_start` hook: on the first turn of a
    // conversation it injects the current date/time (a common blind spot for local
    // models) via a `replace`/`inject` directive. Community-tier, opt-in; the
    // reference a third party forks for richer setup-context injection. The other
    // new phases (pre/post_tool_use, subagent_stop, session_end, notification) fire
    // from off-chat-path sites through the process-global dispatcher; their
    // reference fixtures (`tool-firewall`, `hook-observers`) are deliberately NOT
    // registered here so those hot paths (esp. per tool call) stay lookup-free
    // until a user installs a plugin that actually uses them.
    include_str!("fixtures/hook-session-context.plugin.json"),
    // Ryu Apps (widget-rendering in-process apps). Each declares its tool
    // runnables + `contributes.widgets[]`; apps that push a follow-up turn also
    // declare the `chat.sendFollowUp` grant (governance §4.2). Default-on Core.
    include_str!("fixtures/checklist.plugin.json"),
    include_str!("fixtures/smart-intake-form.plugin.json"),
    include_str!("fixtures/data-grid-explorer.plugin.json"),
    include_str!("fixtures/chart-studio.plugin.json"),
    include_str!("fixtures/decision-wizard.plugin.json"),
    include_str!("fixtures/quest-board.plugin.json"),
    include_str!("fixtures/worktree-diff-review.plugin.json"),
    include_str!("fixtures/gateway-budget-dial.plugin.json"),
    // The Whiteboard app — a full-page Companion (`ui_format:"html"`, Path B) that
    // OWNS its Space documents via `spaces:docs`. Ships default-on with a UI bundle
    // + host-bridge grants seeded in `main.rs` (the generic CORE_DEFAULT_ON loop
    // seeds neither, so it has a dedicated seed block). Replaces the built-in
    // whiteboard editor.
    include_str!("fixtures/whiteboard.plugin.json"),
    // The Canvas app — a full-page Companion (`ui_format:"html"`, Path B) that owns
    // its Space documents via `spaces:docs` and runs generation nodes through the
    // window.ryu media/agent bridge (`media:generate` / `media:transcribe` /
    // `hook:run-agent` / `hook:side-model`) + reads catalogs via `core:list_agents`.
    // Ships default-on with a UI bundle + those grants seeded in `main.rs`. Replaces
    // the built-in creative-canvas board.
    include_str!("fixtures/canvas.plugin.json"),
    // The Fine-tuning app — a full-page Companion (`ui_format:"html"`, Path B) that
    // drives Core's fine-tune orchestration + durable job store via the
    // `finetune:runs` bridge and OWNS its Unsloth training sidecar (a
    // manifest-declared Python process, `sidecar:process`). Ships default-on with a
    // UI bundle + those grants seeded in `main.rs`. Replaces the built-in
    // fine-tuning page.
    include_str!("fixtures/finetune.plugin.json"),
    // Spaces + Meetings — the first REAL plugin→plugin dependency edge.
    //
    // Both are "governance shells" (zero runnables, like ghost/shadow): the code
    // stays in-crate (`server/spaces.rs`, `server/meetings_api.rs`) and the record
    // is what governs it — install/enable/disable + the route gate. Declaring a
    // runnable here would register a PHANTOM tool with no implementation.
    //
    // Order matters only for readability: `plugins::seed` resolves the topological
    // order from `requires`, so the dependency is seeded before its dependent no
    // matter how these are listed.
    include_str!("fixtures/spaces.plugin.json"),
    // Meetings `requires` Spaces because it genuinely writes its notes into the
    // "Meetings" Space (`server/meetings_api.rs::save_notes_to_space` →
    // `state.spaces.ingest_document` / `create_space`). Disabling Spaces under it
    // would leave that write path pointing at a disabled capability, which is
    // exactly what `plugins::graph` now refuses.
    include_str!("fixtures/meetings.plugin.json"),
];

/// The Canvas app's plugin id (its Space documents are `kind = app:<this>`). Shared
/// by the default-on seed (`main.rs`), the legacy file-store migration
/// (`server/canvas_migrate.rs`), and the desktop create/route flow.
pub const CANVAS_PLUGIN_ID: &str = "com.ryu.canvas";

/// The Canvas app's prebuilt, self-contained UI bundle (a `vite-plugin-singlefile`
/// build of `packages/canvas-app`, all JS/CSS inlined). Seeded as the plugin's
/// `ui_code` on a fresh install. Rebuild with `bun run --cwd packages/canvas-app
/// build` and copy `dist/index.html` to `fixtures/canvas.ui.html` to refresh it.
pub const CANVAS_UI_HTML: &str = include_str!("fixtures/canvas.ui.html");

/// The Whiteboard app's plugin id (its Space documents are `kind = app:<this>`).
/// Shared by the default-on seed (`main.rs`), the legacy-kind migration
/// (`server/spaces.rs`), and the desktop create/route flow.
pub const WHITEBOARD_PLUGIN_ID: &str = "com.ryu.whiteboard";

/// The Whiteboard app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `packages/whiteboard-app`, all JS/CSS/fonts
/// inlined). Seeded as the plugin's `ui_code` on a fresh install so the default-on
/// companion has a UI without going through `ryu pack` / install-bundle. Rebuild
/// with `bun run --cwd packages/whiteboard-app build` and copy `dist/index.html`
/// to `fixtures/whiteboard.ui.html` to refresh it.
pub const WHITEBOARD_UI_HTML: &str = include_str!("fixtures/whiteboard.ui.html");

/// The Fine-tuning app's plugin id. Shared by the default-on seed (`main.rs`), the
/// manifest-sidecar ensure in `server/finetune.rs`, and the desktop "Fine-tune this
/// model" open path.
pub const FINETUNE_PLUGIN_ID: &str = "com.ryu.finetune";

/// The Fine-tuning app's prebuilt, self-contained UI bundle (a
/// `vite-plugin-singlefile` build of `packages/finetune-app`, all JS/CSS inlined).
/// Seeded as the plugin's `ui_code` on a fresh install so the default-on companion
/// has a UI without going through `ryu pack`. Rebuild with `bun run --cwd
/// packages/finetune-app build` and copy `dist/index.html` to
/// `fixtures/finetune.ui.html` to refresh it.
pub const FINETUNE_UI_HTML: &str = include_str!("fixtures/finetune.ui.html");

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

    /// Parse ONLY the compiled-in built-in manifests, ignoring `~/.ryu/plugins`.
    ///
    /// Test-only. [`Self::load`] scans the real user plugins directory, so a test
    /// that asserts something about "the built-ins" via `load()` would also be
    /// asserting it about whatever the developer happens to have installed
    /// locally — a spurious failure waiting to happen. This keeps built-in
    /// assertions hermetic.
    #[cfg(test)]
    pub(crate) fn load_builtins() -> Vec<PluginManifest> {
        let mut seen_ids: HashSet<String> = HashSet::new();
        BUILTIN_MANIFESTS
            .iter()
            .filter_map(|raw| Self::parse_and_validate(raw, "<built-in>", &mut seen_ids).ok())
            .collect()
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

        // Dependency SHAPE gate (`requires.apps`). This is deliberately per-manifest
        // only — self-dependency, a malformed `min_version`, and duplicate edges are
        // all decidable from this manifest alone. Whether a declared dependency
        // EXISTS, is version-SATISFIABLE, and is ACYCLIC are cross-manifest
        // questions that this function structurally cannot answer (it sees one
        // manifest and a `seen_ids` set, never the other 36); those resolve later
        // against the full installed set in `crate::plugins::graph`.
        {
            let mut seen_deps: HashSet<&str> = HashSet::new();
            for dep in manifest.dependencies() {
                validate_plugin_id(&dep.id).map_err(|e| {
                    format!(
                        "app '{}' declares dependency with invalid id: {e} (source: {source})",
                        manifest.id
                    )
                })?;
                if dep.id == manifest.id {
                    return Err(format!(
                        "app '{}' cannot depend on itself (source: {source})",
                        manifest.id
                    ));
                }
                if !seen_deps.insert(dep.id.as_str()) {
                    return Err(format!(
                        "app '{}' declares duplicate dependency '{}' (source: {source})",
                        manifest.id, dep.id
                    ));
                }
                if let Some(min) = &dep.min_version {
                    parse_min_version(min).map_err(|e| {
                        format!(
                            "app '{}' dependency '{}': {e} (source: {source})",
                            manifest.id, dep.id
                        )
                    })?;
                }
            }
        }

        // Validate each Runnable's per-kind config contract.
        for entry in &manifest.runnables {
            validate_runnable(entry)
                .map_err(|e| format!("app '{}' (source: {source}): {e}", manifest.id))?;
        }

        // Validate each declared managed sidecar (name safety, health path, and
        // per-process-kind required fields). Duplicate local names would collide on
        // the same `<plugin_id>/<name>` manager key, so reject them at load.
        {
            let mut seen: HashSet<&str> = HashSet::new();
            for spec in &manifest.sidecars {
                crate::plugin_manifest::schema::validate_sidecar_spec(spec)
                    .map_err(|e| format!("app '{}' (source: {source}): {e}", manifest.id))?;
                if !seen.insert(spec.name.as_str()) {
                    return Err(format!(
                        "app '{}' declares duplicate sidecar name '{}' (source: {source})",
                        manifest.id, spec.name
                    ));
                }
            }
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

    /// The three companion apps exist as TWO copies of one manifest: the package
    /// source (`packages/<x>-app/plugin.json`, what the app team edits) and the
    /// fixture Core actually compiles in via `include_str!`
    /// (`src/plugin_manifest/fixtures/<x>.plugin.json`). Editing only the package
    /// copy is a **dead edit** — Core never reads it — and silently diverges the
    /// two. This test is the guard: the pair must stay byte-identical.
    ///
    /// Read at runtime (not `include_str!`) and skipped when `packages/` is absent,
    /// so the OSS Core mirror — which ships `apps/core` without `packages/` — still
    /// builds and tests green.
    #[test]
    fn companion_fixtures_match_their_package_manifests() {
        let core = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let repo_root = core.join("..").join("..");
        let mut checked = 0;

        for (pkg, fixture) in [
            ("canvas-app", "canvas.plugin.json"),
            ("whiteboard-app", "whiteboard.plugin.json"),
            ("finetune-app", "finetune.plugin.json"),
        ] {
            let pkg_path = repo_root.join("packages").join(pkg).join("plugin.json");
            let Ok(pkg_json) = std::fs::read_to_string(&pkg_path) else {
                // OSS mirror (no `packages/`) — nothing to compare against.
                continue;
            };
            let fixture_path = core
                .join("src")
                .join("plugin_manifest")
                .join("fixtures")
                .join(fixture);
            let fixture_json = std::fs::read_to_string(&fixture_path)
                .unwrap_or_else(|e| panic!("fixture {} unreadable: {e}", fixture_path.display()));

            assert_eq!(
                fixture_json,
                pkg_json,
                "'{}' and '{}' have diverged. Core loads the FIXTURE (include_str!), so an edit \
                 to the package copy alone does nothing. Apply the change to both.",
                fixture_path.display(),
                pkg_path.display()
            );
            checked += 1;
        }

        assert!(
            checked == 0 || checked == 3,
            "expected all three companion manifests (or none, on the OSS mirror), found {checked}"
        );
    }

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
    fn validate_plugin_id_accepts_bare_kebab_and_legacy_dotted() {
        // Bare-kebab ids (the new built-in convention) must pass.
        assert!(validate_plugin_id("ghost").is_ok());
        assert!(validate_plugin_id("data-grid-explorer").is_ok());
        assert!(validate_plugin_id("rtk").is_ok());
        // Legacy dotted third-party ids must still pass (back-compat).
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
        for id in ["firewall", "routing", "sandbox", "engines", "durable"] {
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
            manifests.iter().any(|m| m.id == "spider"),
            "built-in Spider manifest should be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "exa"),
            "built-in Exa manifest should be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "ghost"),
            "built-in Ghost manifest should be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "shadow"),
            "built-in Shadow manifest should be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "proof"),
            "built-in Proof of Work manifest should be loaded"
        );
        assert!(
            manifests.iter().any(|m| m.id == "security-guidance"),
            "built-in Security Guidance manifest should be loaded"
        );
        // The Whiteboard app (the FIRST companion runnable in BUILTIN_MANIFESTS) must
        // load AND validate as a companion whose config carries `ui_entry` + the
        // Path B `ui_format:"html"` discriminator. `cargo check` compiles the
        // `include_str!` but never RUNS this loader, so without this a fixture that
        // fails `parse_and_validate` would be silently dropped → the default-on seed
        // finds no version → the whole feature is inert while every check stays green.
        let whiteboard = manifests
            .iter()
            .find(|m| m.id == WHITEBOARD_PLUGIN_ID)
            .expect("whiteboard app manifest must load and validate");
        let companion = whiteboard
            .runnables()
            .iter()
            .find(|r| r.kind == RunnableKind::Companion)
            .expect("whiteboard must expose a companion runnable");
        let cfg = companion
            .config
            .as_ref()
            .expect("whiteboard companion must carry a config");
        assert!(
            cfg.get("ui_entry").and_then(|v| v.as_str()).is_some(),
            "whiteboard companion config must set ui_entry (so has_ui is true)"
        );
        assert_eq!(
            cfg.get("ui_format").and_then(|v| v.as_str()),
            Some("html"),
            "whiteboard companion must declare ui_format:\"html\" (Path B)"
        );
    }

    #[test]
    fn security_guidance_fixture_has_gated_turn_hook() {
        // The ported security-guidance plugin must contribute a flag-gated
        // `post_assistant_turn` hook with the side-model grant, so it is free on
        // the hot path (skipped unless the toggle/command is set) and can review.
        let manifests = PluginManifestLoader::load();
        let m = manifests
            .iter()
            .find(|m| m.id == "security-guidance")
            .expect("security-guidance must load");
        assert!(
            m.permission_grants.iter().any(|g| g == "hook:side-model"),
            "must declare the side-model grant"
        );
        let hooks = &m.contributes.as_ref().expect("contributes").turn_hooks;
        assert_eq!(hooks.len(), 1, "one turn hook");
        assert_eq!(hooks[0].on, "post_assistant_turn");
        let gate = hooks[0].run_when.as_ref().expect("a match gate");
        assert_eq!(gate.flag.as_deref(), Some("io.ryu.security-guidance"));
        assert!(gate.commands.iter().any(|c| c == "/security"));
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

    // ── requires / targets ────────────────────────────────────────────────────

    /// Parse a manifest through the real validation funnel (the same one the
    /// loader uses for built-ins and disk manifests).
    fn parse(raw: &str) -> Result<PluginManifest, String> {
        let mut seen = HashSet::new();
        PluginManifestLoader::parse_and_validate(raw, "<test>", &mut seen)
    }

    const NO_DEPS: &str = r#"{
        "id": "legacy.plugin",
        "name": "Legacy Plugin",
        "version": "1.0.0",
        "runnables": []
    }"#;

    /// BACKWARD COMPAT — the single most important test here. A manifest with
    /// neither `requires` nor `targets` (i.e. all 37 shipped fixtures) must still
    /// parse, and must mean "no dependencies, runs on EVERY surface". An absent
    /// `targets` must never be read as "hidden", or every existing plugin vanishes.
    #[test]
    fn manifest_without_requires_or_targets_means_no_deps_all_surfaces() {
        let m = parse(NO_DEPS).expect("a manifest with no requires/targets must parse");

        assert!(m.requires.is_none());
        assert!(m.dependencies().is_empty(), "absent requires = no deps");

        assert!(m.targets.is_empty());
        for surface in [
            Surface::Gateway,
            Surface::Core,
            Surface::Desktop,
            Surface::Island,
            Surface::Mobile,
            Surface::Extension,
            Surface::Web,
            Surface::Cli,
        ] {
            assert!(
                m.supports_surface(surface),
                "empty targets must mean EVERY surface, not none ({surface:?})"
            );
        }
    }

    /// Every shipped built-in must still load with the new fields present on the
    /// struct — the concrete guarantee that these fields break no existing plugin.
    ///
    /// The guarantee is precisely about manifests that declare **nothing**: absent
    /// `requires` = no dependencies, absent/empty `targets` = every surface. It is
    /// NOT "no built-in may ever declare them" — a built-in that *does* (Meetings
    /// requires Spaces; anything with explicit `targets`) is the feature working as
    /// designed. So each assertion is scoped to the undeclared case, which is the
    /// one that must never change behaviour.
    #[test]
    fn builtins_that_declare_nothing_keep_their_old_permissive_behaviour() {
        // `load_builtins`, not `load`: the latter also scans the developer's real
        // ~/.ryu/plugins, which would make this assertion depend on what they
        // happen to have installed.
        let manifests = PluginManifestLoader::load_builtins();
        assert!(!manifests.is_empty(), "built-ins must load");
        for m in &manifests {
            if m.requires.is_none() {
                assert!(
                    m.dependencies().is_empty(),
                    "built-in '{}' declares no `requires`, so it must have no dependencies",
                    m.id
                );
            }
            if m.targets.is_empty() {
                for surface in [
                    Surface::Gateway,
                    Surface::Core,
                    Surface::Desktop,
                    Surface::Island,
                    Surface::Mobile,
                    Surface::Extension,
                    Surface::Web,
                    Surface::Cli,
                ] {
                    assert!(
                        m.supports_surface(surface),
                        "built-in '{}' declares no `targets`, so it must surface on \
                         EVERY host ({surface:?})",
                        m.id
                    );
                }
            }
        }
    }

    #[test]
    fn requires_and_targets_round_trip() {
        let raw = r#"{
            "id": "meetings",
            "name": "Meetings",
            "version": "1.0.0",
            "runnables": [],
            "requires": {
                "apps": [
                    { "id": "spaces", "min_version": "1.2.0" },
                    { "id": "voice" }
                ],
                "grants": ["spaces:docs"]
            },
            "targets": ["desktop", "island"]
        }"#;
        let m = parse(raw).expect("requires/targets must parse");

        let deps = m.dependencies();
        assert_eq!(deps.len(), 2);
        assert_eq!(deps[0].id, "spaces");
        assert_eq!(deps[0].min_version.as_deref(), Some("1.2.0"));
        assert_eq!(deps[1].id, "voice");
        assert!(deps[1].min_version.is_none(), "min_version is optional");
        assert_eq!(
            m.requires.as_ref().unwrap().grants,
            vec!["spaces:docs".to_owned()]
        );

        assert_eq!(m.targets, vec![Surface::Desktop, Surface::Island]);

        // Serialising and re-parsing preserves both (the manifest is signed
        // verbatim, so the round-trip must be lossless).
        let json = serde_json::to_string(&m).unwrap();
        let back: PluginManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(back, m);
    }

    /// The omitted fields must not appear in the serialised form — an existing
    /// manifest must re-serialise byte-identically, so its signature still verifies.
    #[test]
    fn absent_requires_and_targets_are_not_serialised() {
        let m = parse(NO_DEPS).unwrap();
        let json = serde_json::to_value(&m).unwrap();
        assert!(json.get("requires").is_none(), "absent requires must be omitted");
        assert!(json.get("targets").is_none(), "empty targets must be omitted");
    }

    // ── explicit targets: filtering ───────────────────────────────────────────

    #[test]
    fn explicit_targets_are_respected() {
        let raw = r#"{
            "id": "desktop.only",
            "name": "Desktop Only",
            "version": "1.0.0",
            "runnables": [],
            "targets": ["desktop"]
        }"#;
        let m = parse(raw).unwrap();
        assert!(m.supports_surface(Surface::Desktop));
        assert!(!m.supports_surface(Surface::Mobile));
        assert!(!m.supports_surface(Surface::Cli));
        assert!(!m.supports_surface(Surface::Core));
    }

    #[test]
    fn unknown_surface_is_rejected() {
        let raw = r#"{
            "id": "bad.surface",
            "name": "Bad Surface",
            "version": "1.0.0",
            "runnables": [],
            "targets": ["toaster"]
        }"#;
        assert!(parse(raw).is_err(), "an unknown surface must be rejected");
    }

    #[test]
    fn surface_tokens_round_trip_through_parse() {
        for s in [
            Surface::Gateway,
            Surface::Core,
            Surface::Desktop,
            Surface::Island,
            Surface::Mobile,
            Surface::Extension,
            Surface::Web,
            Surface::Cli,
        ] {
            assert_eq!(Surface::parse(s.as_str()), Some(s));
            // The wire token must match the serde (kebab-case) encoding exactly.
            let json = serde_json::to_string(&s).unwrap();
            assert_eq!(json, format!("\"{}\"", s.as_str()));
        }
        assert_eq!(Surface::parse("DESKTOP"), Some(Surface::Desktop));
        assert_eq!(Surface::parse("nonsense"), None);
    }

    // ── requires: shape validation ────────────────────────────────────────────

    #[test]
    fn self_dependency_is_rejected_at_load() {
        let raw = r#"{
            "id": "narcissus",
            "name": "Narcissus",
            "version": "1.0.0",
            "runnables": [],
            "requires": { "apps": [{ "id": "narcissus" }] }
        }"#;
        let err = parse(raw).expect_err("a self-dependency must be rejected");
        assert!(err.contains("cannot depend on itself"), "got: {err}");
    }

    #[test]
    fn malformed_min_version_is_rejected_at_load() {
        let raw = r#"{
            "id": "app",
            "name": "App",
            "version": "1.0.0",
            "runnables": [],
            "requires": { "apps": [{ "id": "lib", "min_version": "not-a-version" }] }
        }"#;
        let err = parse(raw).expect_err("a malformed min_version must be rejected");
        assert!(err.contains("min_version"), "got: {err}");
    }

    #[test]
    fn duplicate_dependency_is_rejected_at_load() {
        let raw = r#"{
            "id": "app",
            "name": "App",
            "version": "1.0.0",
            "runnables": [],
            "requires": { "apps": [{ "id": "lib" }, { "id": "lib" }] }
        }"#;
        let err = parse(raw).expect_err("a duplicate dependency must be rejected");
        assert!(err.contains("duplicate dependency"), "got: {err}");
    }

    // ── min_version semantics ─────────────────────────────────────────────────

    /// The load-bearing semver decision: a bare `min_version` is a MINIMUM, not
    /// semver's default caret range. `VersionReq::parse("1.2.0")` means `^1.2.0`
    /// and would REJECT 2.0.0; `parse_min_version` must accept it.
    #[test]
    fn bare_min_version_is_a_minimum_not_a_caret() {
        let req = parse_min_version("1.2.0").unwrap();
        assert!(req.matches(&semver::Version::parse("1.2.0").unwrap()), "exact");
        assert!(req.matches(&semver::Version::parse("1.9.9").unwrap()), "minor");
        assert!(
            req.matches(&semver::Version::parse("2.0.0").unwrap()),
            "a bare min_version must accept a NEWER MAJOR — this is the whole point"
        );
        assert!(
            !req.matches(&semver::Version::parse("1.1.0").unwrap()),
            "below the minimum is still rejected"
        );
    }

    #[test]
    fn explicit_comparators_are_honoured_verbatim() {
        // The caret escape hatch still pins the major when asked for explicitly.
        let caret = parse_min_version("^1.2.0").unwrap();
        assert!(caret.matches(&semver::Version::parse("1.9.0").unwrap()));
        assert!(!caret.matches(&semver::Version::parse("2.0.0").unwrap()));

        let range = parse_min_version(">=1.0, <2").unwrap();
        assert!(range.matches(&semver::Version::parse("1.5.0").unwrap()));
        assert!(!range.matches(&semver::Version::parse("2.0.0").unwrap()));
    }

    #[test]
    fn invalid_min_version_strings_are_errors() {
        assert!(parse_min_version("not-a-version").is_err());
        assert!(parse_min_version("").is_err());
    }
}
