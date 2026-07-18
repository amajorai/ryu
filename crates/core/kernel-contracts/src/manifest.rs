//! The `plugin.json` **manifest model** — the single, pure-data definition of an
//! installable Ryu App/Plugin descriptor plus its `id`/semver/dependency
//! validation.
//!
//! This is the canonical contract shared by `apps/core` (which re-exports these
//! types and drives them from its I/O-bearing loader) and the Ryu SDK (which
//! re-exports them for manifest authoring/validation across language bindings).
//! It performs no I/O and links no runtime — serde/schemars/semver only.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::runnable::{RunnableKind, RunnableMeta};
use crate::schema::{self, RunnableEntry};

/// Maximum length of an app `id`. Reverse-domain ids are short; a generous cap
/// prevents pathological filesystem paths and absurdly long directory names.
pub const MAX_PLUGIN_ID_LEN: usize = 128;

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

/// An installable Ryu App manifest (`plugin.json`).
///
/// Modelled on Codex's `plugin.json` pattern: a thin descriptor that bundles one or
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
    #[serde(default)]
    pub permission_grants: Vec<String>,

    /// **Unified, deny-by-default runtime permission set** — the single typed
    /// grammar (`{fs, child_process, network, tool}`) Core lowers to every sandbox
    /// backend (wasmtime WASI preopens, Docker `--mount`/`--network` flags, Deno
    /// `--allow-*` flags). Absent = **deny-all** (the default for every manifest
    /// predating this field), so an app that declares nothing keeps today's exact
    /// zero-permission sandbox posture.
    ///
    /// # Relationship to [`permission_grants`]
    ///
    /// These are **two distinct lanes** that must not be conflated:
    /// - [`permission_grants`] are opaque strings the **Gateway** approves at
    ///   install/enable time — the *approval* lane (who is allowed to ask).
    /// - `permissions` is the typed set **Core** lowers into the actual sandbox at
    ///   spawn/exec time — the *runtime-enforcement* lane (what the code can touch).
    ///
    /// A grant says "this app may use the filesystem capability"; `permissions.fs`
    /// says "…and here are the exact read/write paths the sandbox is opened with."
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
        if let Some(surfaces) = &self.surfaces {
            return surfaces
                .get(&surface)
                .is_some_and(|e| e.support != SurfaceSupport::None);
        }
        self.targets.is_empty() || self.targets.contains(&surface)
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
        if let Some(permissions) = &self.permissions {
            permissions
                .validate()
                .map_err(|e| format!("plugin '{}': {e}", self.id))?;
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

    /// Cross-validate the capability edges (`requires.capabilities` + `provides`):
    /// version floors/strings parse, and every provided capability's referenced
    /// `sidecar`/`route` actually exists on this manifest — the same declare-by-id
    /// integrity `contributes` enforces, so a typo fails at load, not at bind.
    fn validate_capabilities(&self) -> Result<(), String> {
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

    /// Chat turn hooks the plugin contributes — server-side logic that runs at a
    /// turn boundary (e.g. `post_assistant_turn`) and returns a directive. These
    /// are **self-contained** (they carry their own inline `code`), so they are
    /// NOT cross-validated against `runnables` like the id-reference surfaces
    /// above; the Core `plugin_host` runtime executes them in the sandbox.
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TurnHookContribution {
    /// Stable id for this hook (for logging/audit), unique within the plugin.
    pub id: String,
    /// The turn boundary this hook fires on. Today only `"post_assistant_turn"`.
    pub on: String,
    /// The JS hook body executed in the sandbox (returns a directive).
    pub code: String,
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ContributionId {
    /// The runnable id this contribution points at. Must exist in `runnables`.
    pub id: String,

    /// Optional display title (e.g. the palette label for a command).
    #[serde(default)]
    pub title: Option<String>,
}

/// `engines` block — the required Ryu version, mirroring VS-Code's
/// `engines.vscode`. `ryu` is a semver **requirement** string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
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
}

/// Per-surface support level a plugin declares for a [`Surface`] in the
/// [`PluginManifest::surfaces`] map. Governs both whether the plugin appears on the
/// surface and how much of its UI that surface renders.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema,
)]
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runnable::RunnableKind;

    #[test]
    fn validate_plugin_id_accepts_bare_and_dotted_rejects_traversal() {
        assert!(validate_plugin_id("ghost").is_ok());
        assert!(validate_plugin_id("data-grid-explorer").is_ok());
        assert!(validate_plugin_id("com.example.research-assistant").is_ok());
        for bad in ["../../etc/x", "..", "a/../b", ".hidden", "app.", "-lead", ""] {
            assert!(validate_plugin_id(bad).is_err(), "'{bad}' must be rejected");
        }
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
            "requires": { "apps": [{ "id": "com.ryu.spaces", "min_version": "1.0.0" }] },
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
        assert!(!m.supports_surface(Surface::Island), "absent key ⇒ unsupported");
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
        for s in [Surface::Desktop, Surface::Gateway, Surface::Mobile, Surface::Cli] {
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
        assert_eq!(cli.commands[0].summary.as_deref(), Some("Show inbox status"));
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
            assert!(validate_cli_command_path(ok).is_ok(), "'{ok}' must be allowed");
        }
        // Every traversal / escape form is rejected — literal `..`, percent-encoded
        // `%2e`, backslash separators, encoded separators, and a non-absolute path.
        for bad in [
            "/../../../v1/chat/completions",
            "/../api/plugins/com.ryu.mail/uninstall",
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
        assert!(value.get("commands").is_none(), "empty commands must be omitted");
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
            m.contributes
                .as_ref()
                .unwrap()
                .referenced_ids()
                .is_empty(),
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

    // ── unified permission grammar ───────────────────────────────────────────────

    #[test]
    fn permission_set_default_is_deny_all() {
        let p = PermissionSet::default();
        assert!(p.fs.read.is_empty());
        assert!(p.fs.write.is_empty());
        assert!(!p.child_process);
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
        assert!(value.get("permissions").is_none(), "absent permissions omitted");
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
                "network": ["api.example.com:443", "cdn.example.com"],
                "tool": ["web_search"]
            }
        }"#;
        let m = PluginManifest::parse_and_validate(raw).expect("valid permissions");
        let p = m.permissions.as_ref().unwrap();
        assert_eq!(p.fs.read, vec!["/data/in".to_string()]);
        assert_eq!(p.fs.write, vec!["/data/out".to_string()]);
        assert!(p.child_process);
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
        assert_eq!(serde_json::to_string(&NetworkPermission::All(true)).unwrap(), "true");
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
}
