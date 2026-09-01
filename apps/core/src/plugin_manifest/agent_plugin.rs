//! Agent Plugins v1.0.0 import — loading a foreign, vendor-neutral plugin.
//!
//! The [Agent Plugins Specification](https://agent-plugins.org/) (TSC: Amazon,
//! Cursor, Microsoft, OpenAI, Vercel) defines a small portable floor: a plugin is
//! a directory with `plugin.json` at its root, Agent Skills under
//! `skills/<slug>/SKILL.md`, and MCP servers in `mcp.json`. Nothing else in it is
//! portable — distribution, permissions, UX and every richer component type are
//! explicitly left to each client.
//!
//! This module is the **import** half of our support for it (the export half is
//! `packages/sdk/src/agent-plugin.ts`, which projects our `manifest.json` onto the
//! same two files). It reads a spec plugin directory and produces a NATIVE manifest
//! value, which the caller then feeds through [`PluginManifestLoader::parse_and_validate`]
//! exactly like any other manifest.
//!
//! That indirection is the design: import is a *translation*, not a second loader.
//! Everything Core already enforces on a manifest — id validation, legacy-id
//! canonicalization, semver, duplicate-id rejection, `code_file` hydration — keeps
//! applying to an imported plugin, because it takes the identical path.
//!
//! ## Security posture
//!
//! An imported plugin is unsigned by construction: it comes from an arbitrary
//! directory under `~/.ryu/plugins`, with no Gateway signature over it. Its
//! `mcp.json` therefore describes a process it wants us to spawn or a remote
//! endpoint it wants us to contact — which is exactly the surface
//! [`crate::sidecar::mcp::may_register_mcp_servers`] gates.
//!
//! We inherit that gate rather than re-implement it: anything loaded off disk is
//! [`PluginTier::Community`], and Community-tier `mcp_servers` register only with
//! the Gateway-**approved** `mcp:server` grant. The `permission_grants` this module
//! writes are a *declaration* (what the plugin asks for), never an approval. So
//! importing a plugin can never, by itself, make a foreign command spawnable.
//!
//! ## What we deliberately do not support yet
//!
//! - **`cwd`.** Neither [`McpServerDecl`] nor `McpStdioCommand` carries a working
//!   directory, so an entry that declares one is skipped rather than silently run
//!   from the wrong directory. `${PLUGIN_ROOT}` expansion in `args`/`env` covers
//!   the common reason to want it.
//! - **`${PLUGIN_DATA}` is a path, not a promise.** The placeholder expands to a
//!   client-managed directory that is NOT created here — nothing should read the
//!   expansion as a guarantee that the directory exists.
//! - **Skills only materialize when the directory name matches the id.** The
//!   folder-convention materializer resolves a plugin's `skills/` through
//!   `plugin_dir_name(id)`, so a package whose directory name differs from its
//!   derived id (the common case for a hand-cloned foreign plugin) loads its
//!   manifest and MCP servers but not its skills. This is pre-existing behaviour
//!   of the materializer — a native manifest with a mismatched directory has the
//!   same gap — so it is REPORTED at import rather than papered over by making a
//!   directory name mean identity for spec plugins only.
//!
//! [`PluginTier::Community`]: crate::plugin_manifest::PluginTier::Community
//! [`McpServerDecl`]: crate::plugin_manifest::McpServerDecl
//! [`PluginManifestLoader::parse_and_validate`]: crate::plugin_manifest::PluginManifestLoader

use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value};

/// Every canonical schema identifier the spec defines starts with this. Used only
/// to *recognize* a spec file; the exact version is checked separately.
pub const SPEC_SCHEMA_PREFIX: &str = "https://agent-plugins.org/schemas/";

/// The one manifest schema identifier we implement (§5.2).
pub const PLUGIN_SCHEMA_URL: &str = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

/// The one MCP configuration schema identifier we implement (§7.2.1).
pub const MCP_SCHEMA_URL: &str = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/// Our reverse-domain client extension namespace (§8) — the key we read Ryu data
/// back out of, and the same constant the TypeScript exporter writes.
pub const EXTENSION_NS: &str = "com.ryuhq.ryu";

/// Spec manifest file name (§5.1).
pub const MANIFEST_FILE: &str = "plugin.json";

/// Spec MCP configuration file name (§7.2.1).
pub const MCP_FILE: &str = "mcp.json";

/// Fallback scope for a foreign plugin's derived id. A spec `name` is a bare slug,
/// so it becomes `@agent-plugins/<name>`: scoped like every other id we mint, and
/// namespaced so a foreign `ghost` can never shadow our `@ryu/ghost`.
const IMPORT_SCOPE: &str = "@agent-plugins";

/// Version used when the spec manifest omits `version` or states one Core's semver
/// gate would reject. The spec explicitly forbids rejecting a plugin for a
/// non-semver `version` (§5.4), while Core requires semver — so it is normalized
/// here rather than turned into a load failure.
const FALLBACK_VERSION: &str = "0.0.0";

const MAX_SPEC_NAME_LEN: usize = 64;

/// The result of translating a spec plugin directory.
#[derive(Debug)]
pub struct ImportedAgentPlugin {
    /// The native manifest, ready for `parse_and_validate`.
    pub manifest: Value,
    /// Everything skipped, ignored, or rewritten — surfaced by the caller as
    /// warnings. The spec requires a client to *report* these rather than fail
    /// (§6.2, §7.2.2), so silence here would be a conformance bug, not tidiness.
    pub notes: Vec<String>,
}

/// Whether a raw JSON document is an Agent Plugins spec manifest.
///
/// This predicate is load-bearing. `plugin.json` is BOTH the spec's manifest name
/// and a legacy alias for our own `manifest.json` (see `MANIFEST_FILE_NAMES`), so
/// a resolver that takes the first matching name would hand a spec file to the
/// native parser and reject the plugin for having no `id`. A spec manifest MUST
/// declare `$schema` with a canonical agent-plugins.org identifier (§5.2), and no
/// native manifest has ever carried that field, so the discriminator is exact.
#[must_use]
pub fn is_agent_plugin_manifest(raw: &str) -> bool {
    serde_json::from_str::<Value>(raw).is_ok_and(|v| {
        v.get("$schema")
            .and_then(Value::as_str)
            .is_some_and(|s| s.starts_with(SPEC_SCHEMA_PREFIX))
    })
}

/// Validate a spec plugin `name` (§5.5): 1–64 chars of `a-z 0-9 - .`, alphanumeric
/// at both ends, no `--` and no `..`.
///
/// Enforced strictly because `name` is the only required field besides `$schema`,
/// and because it becomes part of a plugin id — which reaches path contexts. The
/// constraints happen to exclude every traversal shape on their own (`/`, `\`, and
/// a leading `.` are all illegal), and `validate_plugin_id` re-checks downstream.
fn validate_spec_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > MAX_SPEC_NAME_LEN {
        return Err(format!(
            "plugin name '{name}' must be 1-{MAX_SPEC_NAME_LEN} characters"
        ));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
    {
        return Err(format!(
            "plugin name '{name}' may contain only lowercase letters, digits, '-' and '.'"
        ));
    }
    let first_last_alnum = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    if !name.starts_with(first_last_alnum) || !name.ends_with(first_last_alnum) {
        return Err(format!(
            "plugin name '{name}' must start and end with an alphanumeric character"
        ));
    }
    if name.contains("--") || name.contains("..") {
        return Err(format!(
            "plugin name '{name}' must not contain '--' or '..'"
        ));
    }
    Ok(())
}

/// The client-managed data directory a plugin's `${PLUGIN_DATA}` expands to.
///
/// Kept OUT of the package directory: the spec treats package files as read-only
/// content under containment rules (§4.1) and gives `${PLUGIN_DATA}` its own
/// separate containment boundary (§7.2.1), so mixing them would blur the two.
fn plugin_data_dir(dir_name: &str) -> PathBuf {
    crate::plugin_manifest::PluginManifestLoader::plugins_dir()
        .join(".plugin-data")
        .join(dir_name)
}

/// Expand `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` (§7.2.1) in an `args`/`env` value.
///
/// `command` is deliberately NOT run through this — the spec forbids expansion
/// there, so a placeholder in a command stays a literal and fails containment.
fn expand_placeholders(raw: &str, plugin_root: &Path, plugin_data: &Path) -> String {
    raw.replace("${PLUGIN_ROOT}", &plugin_root.to_string_lossy())
        .replace("${PLUGIN_DATA}", &plugin_data.to_string_lossy())
}

fn lexically_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

/// Resolve a spec `command` (§7.2.1) to something we can spawn, or explain why not.
///
/// Two legal forms: a bare executable name (resolved by the platform's search
/// rules, so passed through untouched) or a plugin-relative path beginning with
/// `./`. The relative form is resolved against the plugin root and must still be
/// inside it after resolution — §4.1's containment rule, and the reason a bundled
/// `./bin/server` cannot become `../../../bin/anything`.
fn resolve_command(command: &str, plugin_root: &Path) -> Result<String, String> {
    if command.is_empty() {
        return Err("command is empty".to_string());
    }
    if command.chars().any(char::is_whitespace) {
        return Err(format!(
            "command '{command}' is not a single executable token"
        ));
    }
    if let Some(relative) = command.strip_prefix("./") {
        let joined = plugin_root.join(relative);
        // Compare against the resolved root when both sides resolve, so a symlink
        // pointing out of the package is caught (§4.1); fall back to the lexical
        // path when the file does not exist yet, which `starts_with` still rejects
        // for a `../` escape.
        let resolved = joined
            .canonicalize()
            .unwrap_or_else(|_| lexically_normalize(&joined));
        let root = plugin_root
            .canonicalize()
            .unwrap_or_else(|_| lexically_normalize(plugin_root));
        if !resolved.starts_with(&root) {
            return Err(format!(
                "command '{command}' resolves outside the plugin root"
            ));
        }
        return Ok(resolved.to_string_lossy().into_owned());
    }
    if command.contains('/') || command.contains('\\') || command.starts_with('~') {
        return Err(format!(
            "command '{command}' must be a bare executable name or a './'-relative path"
        ));
    }
    Ok(command.to_string())
}

/// Validate a remote MCP URL before it enters the native manifest.
///
/// Core applies the runtime SSRF screen again when it connects. This import-time
/// check keeps malformed and credential-bearing endpoint events out of the
/// registry while still allowing the same loopback HTTP endpoints that local MCP
/// clients commonly use.
fn validate_remote_url(name: &str, raw: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw)
        .map_err(|error| format!("server '{name}' has an invalid remote url: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("server '{name}' remote url must use http or https"));
    }
    if parsed.host_str().is_none() {
        return Err(format!("server '{name}' remote url has no host"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!(
            "server '{name}' remote url must not contain credentials"
        ));
    }
    if parsed.fragment().is_some() {
        return Err(format!(
            "server '{name}' remote url must not contain a fragment"
        ));
    }
    Ok(())
}

/// Copy and validate the optional static headers on a remote server.
fn native_remote_headers(name: &str, value: Option<&Value>) -> Result<Option<Value>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let object = value
        .as_object()
        .ok_or_else(|| format!("server '{name}' has a non-object 'headers'"))?;
    let mut names: Vec<&str> = Vec::with_capacity(object.len());
    let mut headers = Map::new();
    for (key, raw_value) in object {
        reqwest::header::HeaderName::from_bytes(key.as_bytes())
            .map_err(|error| format!("server '{name}' has invalid header name '{key}': {error}"))?;
        let header_value = raw_value
            .as_str()
            .ok_or_else(|| format!("server '{name}' has a non-string value for header '{key}'"))?;
        reqwest::header::HeaderValue::from_str(header_value).map_err(|error| {
            format!("server '{name}' has invalid value for header '{key}': {error}")
        })?;
        if names
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(key))
        {
            return Err(format!(
                "server '{name}' declares duplicate headers that differ only by case: '{key}'"
            ));
        }
        names.push(key);
        headers.insert(key.clone(), Value::String(header_value.to_owned()));
    }
    Ok((!headers.is_empty()).then_some(Value::Object(headers)))
}

/// Translate one `mcp.json` server entry into a native `McpServerDecl` value.
///
/// Returns `Ok(None)` with a note when the entry is valid spec but unsupported
/// here, and `Err` when the entry itself violates the spec. Both outcomes skip
/// only THIS entry and leave the rest of the plugin loading (§7.2.2 rules 3–4) —
/// a stricter failure boundary than the manifest's, where an unknown top-level
/// field is merely reported.
fn to_native_server(
    name: &str,
    entry: &Value,
    plugin_root: &Path,
    plugin_data: &Path,
) -> Result<Option<Value>, String> {
    let object = entry
        .as_object()
        .ok_or_else(|| format!("server '{name}' is not an object"))?;

    let transport = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("server '{name}' has no 'type'"))?;

    match transport {
        "stdio" => {}
        "streamable-http" | "sse" => {
            for key in object.keys() {
                if !matches!(key.as_str(), "type" | "url" | "headers") {
                    return Err(format!(
                        "server '{name}' has field '{key}', which is not part of the remote variant"
                    ));
                }
            }
            let url = object
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .ok_or_else(|| format!("server '{name}' has no 'url'"))?;
            validate_remote_url(name, url)?;

            let mut decl = Map::new();
            decl.insert("type".to_string(), Value::String(transport.to_owned()));
            decl.insert("url".to_string(), Value::String(url.to_owned()));
            if let Some(headers) = native_remote_headers(name, object.get("headers"))? {
                decl.insert("headers".to_string(), headers);
            }
            return Ok(Some(Value::Object(decl)));
        }
        other => return Err(format!("server '{name}' has unknown type '{other}'")),
    }

    // §7.2.1: each variant is CLOSED. An unknown field, or a field belonging to the
    // other variant, invalidates the entry — so this is an allowlist check, not a
    // convenience.
    for key in object.keys() {
        if !matches!(key.as_str(), "type" | "command" | "args" | "env" | "cwd") {
            return Err(format!(
                "server '{name}' has field '{key}', which is not part of the stdio variant"
            ));
        }
    }

    if object.contains_key("cwd") {
        return Err(format!(
            "server '{name}' declares 'cwd', which this client cannot honour (see module docs)"
        ));
    }

    let command = object
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("server '{name}' has no 'command'"))?;
    let command =
        resolve_command(command, plugin_root).map_err(|e| format!("server '{name}': {e}"))?;

    let mut decl = Map::new();
    decl.insert("command".to_string(), Value::String(command));

    if let Some(args) = object.get("args") {
        let args = args
            .as_array()
            .ok_or_else(|| format!("server '{name}' has a non-array 'args'"))?;
        let mut expanded = Vec::with_capacity(args.len());
        for arg in args {
            let arg = arg
                .as_str()
                .ok_or_else(|| format!("server '{name}' has a non-string arg"))?;
            expanded.push(Value::String(expand_placeholders(
                arg,
                plugin_root,
                plugin_data,
            )));
        }
        decl.insert("args".to_string(), Value::Array(expanded));
    }

    if let Some(env) = object.get("env") {
        let env = env
            .as_object()
            .ok_or_else(|| format!("server '{name}' has a non-object 'env'"))?;
        let mut expanded = Map::new();
        for (key, value) in env {
            let value = value
                .as_str()
                .ok_or_else(|| format!("server '{name}' has a non-string env value"))?;
            expanded.insert(
                key.clone(),
                Value::String(expand_placeholders(value, plugin_root, plugin_data)),
            );
        }
        decl.insert("env".to_string(), Value::Object(expanded));
    }

    Ok(Some(Value::Object(decl)))
}

/// Read and translate `<dir>/mcp.json`, if present.
///
/// A malformed or version-mismatched file disables MCP for the plugin but leaves
/// the rest of it loading (§7.2.2 rule 2) — MCP is one component type, not the
/// plugin.
fn import_mcp(dir: &Path, notes: &mut Vec<String>) -> Map<String, Value> {
    let mut servers = Map::new();
    let path = dir.join(MCP_FILE);
    if !path.is_file() {
        // Absent is not an error (§6.2); a present-but-wrong-kind path is.
        if path.exists() {
            notes.push(format!("{MCP_FILE} is not a regular file; MCP disabled"));
        }
        return servers;
    }

    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) => {
            notes.push(format!("could not read {MCP_FILE}: {e}; MCP disabled"));
            return servers;
        }
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(e) => {
            notes.push(format!("{MCP_FILE} is not valid JSON: {e}; MCP disabled"));
            return servers;
        }
    };
    let Some(object) = parsed.as_object() else {
        notes.push(format!("{MCP_FILE} is not an object; MCP disabled"));
        return servers;
    };

    match object.get("$schema").and_then(Value::as_str) {
        Some(MCP_SCHEMA_URL) => {}
        Some(other) => {
            notes.push(format!(
                "{MCP_FILE} targets unsupported schema '{other}'; MCP disabled"
            ));
            return servers;
        }
        None => {
            notes.push(format!("{MCP_FILE} has no $schema; MCP disabled"));
            return servers;
        }
    }
    for key in object.keys() {
        if !matches!(key.as_str(), "$schema" | "mcpServers") {
            notes.push(format!(
                "{MCP_FILE} has unexpected top-level field '{key}'; MCP disabled"
            ));
            return servers;
        }
    }

    let Some(declared) = object.get("mcpServers").and_then(Value::as_object) else {
        notes.push(format!(
            "{MCP_FILE} has no 'mcpServers' object; MCP disabled"
        ));
        return servers;
    };

    let plugin_data = plugin_data_dir(
        &dir.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    );
    for (name, entry) in declared {
        match to_native_server(name, entry, dir, &plugin_data) {
            Ok(Some(decl)) => {
                servers.insert(name.clone(), decl);
            }
            Ok(None) => notes.push(format!(
                "mcp server '{name}' uses a transport this client does not support; skipped"
            )),
            Err(e) => notes.push(format!("mcp server skipped: {e}")),
        }
    }
    servers
}

/// Read the Ryu extension namespace (§8.1), returning `(id, display_name)`.
///
/// A plugin we exported ourselves round-trips through here back to its real scoped
/// id and display name. For a foreign plugin both are absent and derived instead.
/// Malformed extension data is ignored rather than fatal: §8.1 makes the contents
/// of a namespace the implementing client's business, and the plugin is still a
/// perfectly good spec plugin without ours.
fn read_ryu_extension(
    manifest: &Map<String, Value>,
    notes: &mut Vec<String>,
) -> (Option<String>, Option<String>) {
    let Some(extensions) = manifest.get("extensions") else {
        return (None, None);
    };
    let Some(extensions) = extensions.as_object() else {
        notes.push("'extensions' is not an object; ignored".to_string());
        return (None, None);
    };
    let Some(ours) = extensions.get(EXTENSION_NS).and_then(Value::as_object) else {
        return (None, None);
    };

    let id = ours.get("id").and_then(Value::as_str).and_then(|id| {
        // A hostile extension block must not be able to claim a built-in's id or
        // smuggle a path segment: the id is re-validated here and, on failure,
        // dropped in favour of the derived one.
        match crate::plugin_manifest::validate_plugin_id(id) {
            Ok(()) => Some(id.to_string()),
            Err(e) => {
                notes.push(format!(
                    "extension id '{id}' is invalid ({e}); derived instead"
                ));
                None
            }
        }
    });
    let display = ours
        .get("displayName")
        .and_then(Value::as_str)
        .map(str::to_string);
    (id, display)
}

/// Translate a spec plugin directory into a native manifest value.
///
/// `raw` is the contents of `<dir>/plugin.json`. Fatal errors mirror §5.3/§5.2:
/// an unsupported `$schema`, a missing or invalid required field, or an `author`
/// object carrying a field the spec does not permit. Everything else degrades with
/// a note.
pub fn import_manifest(dir: &Path, raw: &str) -> Result<ImportedAgentPlugin, String> {
    let parsed: Value =
        serde_json::from_str(raw).map_err(|e| format!("{MANIFEST_FILE} is not valid JSON: {e}"))?;
    let manifest = parsed
        .as_object()
        .ok_or_else(|| format!("{MANIFEST_FILE} is not an object"))?;

    let mut notes: Vec<String> = Vec::new();

    // §5.2: a client MUST select its rules from a RECOGNIZED `$schema` and MUST NOT
    // fetch one. An unknown version is a rejection, not a best-effort parse.
    match manifest.get("$schema").and_then(Value::as_str) {
        Some(PLUGIN_SCHEMA_URL) => {}
        Some(other) => {
            return Err(format!(
                "unsupported Agent Plugins schema '{other}' (this client implements {PLUGIN_SCHEMA_URL})"
            ));
        }
        None => return Err("manifest has no $schema".to_string()),
    }

    // §5.2: an unknown top-level field is reported and ignored — NOT fatal. The
    // plugin keeps loading, which is what lets a v1 client read a manifest written
    // against a later minor version.
    const PERMITTED: [&str; 10] = [
        "$schema",
        "name",
        "version",
        "description",
        "author",
        "homepage",
        "repository",
        "license",
        "keywords",
        "extensions",
    ];
    for key in manifest.keys() {
        if !PERMITTED.contains(&key.as_str()) {
            notes.push(format!("unknown top-level field '{key}' ignored"));
        }
    }

    let name = manifest
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "manifest has no 'name'".to_string())?;
    validate_spec_name(name)?;

    let (extension_id, display_name) = read_ryu_extension(manifest, &mut notes);
    let id = extension_id.unwrap_or_else(|| format!("{IMPORT_SCOPE}/{name}"));

    let version = match manifest.get("version").and_then(Value::as_str) {
        Some(v) if semver::Version::parse(v).is_ok() => v.to_string(),
        Some(v) => {
            notes.push(format!(
                "version '{v}' is not semver; loaded as {FALLBACK_VERSION}"
            ));
            FALLBACK_VERSION.to_string()
        }
        None => FALLBACK_VERSION.to_string(),
    };

    let mut native = Map::new();
    native.insert("id".to_string(), Value::String(id));
    native.insert(
        "name".to_string(),
        Value::String(display_name.unwrap_or_else(|| name.to_string())),
    );
    native.insert("version".to_string(), Value::String(version));
    // A spec plugin contributes skills and MCP servers, neither of which is a
    // Runnable — so it declares none. Skills are picked up by the folder-convention
    // materializer from the same `skills/` directory the spec fixes (§7.1).
    native.insert("runnables".to_string(), Value::Array(Vec::new()));

    for (spec_key, native_key) in [
        ("description", "description"),
        ("homepage", "homepage"),
        ("license", "license"),
    ] {
        if let Some(value) = manifest.get(spec_key).and_then(Value::as_str) {
            native.insert(native_key.to_string(), Value::String(value.to_string()));
        }
    }
    if let Some(keywords) = manifest.get("keywords").and_then(Value::as_array) {
        native.insert("keywords".to_string(), Value::Array(keywords.clone()));
    }
    if let Some(author) = manifest.get("author") {
        let author = author
            .as_object()
            .ok_or_else(|| "'author' must be an object".to_string())?;
        // §5.4: `author` may carry ONLY name/email/url, each a string. Any other
        // member makes the manifest invalid — one of the few fatal metadata rules.
        for (key, value) in author {
            if !matches!(key.as_str(), "name" | "email" | "url") {
                return Err(format!("'author' has unpermitted field '{key}'"));
            }
            if !value.is_string() {
                return Err(format!("'author.{key}' must be a string"));
            }
        }
        native.insert("author".to_string(), Value::Object(author.clone()));
    }

    // Surface the skills gap at load time (see the module docs): a package whose
    // directory name is not the id's on-disk form ships skills the materializer
    // will never look for.
    if dir.join("skills").is_dir() {
        let expected =
            crate::plugin_manifest::plugin_dir_name(native["id"].as_str().unwrap_or_default());
        let actual = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if expected != actual {
            notes.push(format!(
                "skills/ present but the directory is '{actual}' while id '{}' resolves to '{expected}'; bundled skills will not be materialized until the directory is renamed",
                native["id"].as_str().unwrap_or_default()
            ));
        }
    }

    let servers = import_mcp(dir, &mut notes);
    if !servers.is_empty() {
        native.insert("mcp_servers".to_string(), Value::Object(servers));
        // A DECLARATION of what the plugin wants, never an approval. Registration
        // is gated on the Gateway-approved grant set for Community-tier plugins
        // (`may_register_mcp_servers`), which is every plugin loaded off disk.
        native.insert(
            "permission_grants".to_string(),
            Value::Array(vec![Value::String(
                crate::sidecar::mcp::GRANT_MCP_SERVER.to_string(),
            )]),
        );
    }

    Ok(ImportedAgentPlugin {
        manifest: Value::Object(native),
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec_manifest(extra: &str) -> String {
        format!(r#"{{"$schema":"{PLUGIN_SCHEMA_URL}","name":"summarize"{extra}}}"#)
    }

    #[test]
    fn recognizes_a_spec_manifest_by_schema() {
        assert!(is_agent_plugin_manifest(&spec_manifest("")));
        // A native manifest — the exact file name collision this guards.
        assert!(!is_agent_plugin_manifest(
            r#"{"id":"@ryu/advisor","name":"Advisor","version":"1.0.0","runnables":[]}"#
        ));
        assert!(!is_agent_plugin_manifest("not json"));
    }

    #[test]
    fn derives_a_scoped_id_for_a_foreign_plugin() {
        let dir = tempfile::tempdir().unwrap();
        let imported = import_manifest(dir.path(), &spec_manifest("")).unwrap();
        assert_eq!(imported.manifest["id"], "@agent-plugins/summarize");
        assert_eq!(imported.manifest["name"], "summarize");
        assert_eq!(imported.manifest["version"], "0.0.0");
        assert!(imported.manifest["runnables"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn round_trips_our_own_id_through_the_extension_namespace() {
        let dir = tempfile::tempdir().unwrap();
        let raw = spec_manifest(&format!(
            r#","version":"1.2.0","extensions":{{"{EXTENSION_NS}":{{"id":"@ryu/advisor","displayName":"Advisor"}}}}"#
        ));
        let imported = import_manifest(dir.path(), &raw).unwrap();
        assert_eq!(imported.manifest["id"], "@ryu/advisor");
        assert_eq!(imported.manifest["name"], "Advisor");
        assert_eq!(imported.manifest["version"], "1.2.0");
    }

    #[test]
    fn rejects_an_extension_id_that_is_not_a_legal_plugin_id() {
        let dir = tempfile::tempdir().unwrap();
        let raw = spec_manifest(&format!(
            r#","extensions":{{"{EXTENSION_NS}":{{"id":"@ryu/../../etc"}}}}"#
        ));
        let imported = import_manifest(dir.path(), &raw).unwrap();
        assert_eq!(imported.manifest["id"], "@agent-plugins/summarize");
        assert!(imported.notes.iter().any(|n| n.contains("invalid")));
    }

    #[test]
    fn rejects_an_unsupported_schema_version() {
        let dir = tempfile::tempdir().unwrap();
        let raw = r#"{"$schema":"https://agent-plugins.org/schemas/9.9.9/plugin.schema.json","name":"x"}"#;
        let err = import_manifest(dir.path(), raw).unwrap_err();
        assert!(err.contains("unsupported"), "{err}");
    }

    #[test]
    fn reports_unknown_top_level_fields_without_failing() {
        let dir = tempfile::tempdir().unwrap();
        let imported =
            import_manifest(dir.path(), &spec_manifest(r#","futureField":true"#)).unwrap();
        assert!(imported.notes.iter().any(|n| n.contains("futureField")));
        assert_eq!(imported.manifest["id"], "@agent-plugins/summarize");
    }

    #[test]
    fn rejects_an_author_field_the_spec_does_not_permit() {
        let dir = tempfile::tempdir().unwrap();
        let raw = spec_manifest(r#","author":{"name":"A","twitter":"@a"}"#);
        let err = import_manifest(dir.path(), &raw).unwrap_err();
        assert!(err.contains("twitter"), "{err}");
    }

    #[test]
    fn name_constraints_match_the_spec() {
        for good in ["my-plugin", "acme.tools", "lint3r", "a"] {
            assert!(validate_spec_name(good).is_ok(), "{good}");
        }
        for bad in [
            "My-Plugin",
            "-start",
            "has--double",
            "too.many..dots",
            "",
            "trailing-",
        ] {
            assert!(validate_spec_name(bad).is_err(), "{bad}");
        }
        assert!(validate_spec_name(&"a".repeat(65)).is_err());
    }

    fn write_mcp(dir: &Path, body: &str) {
        std::fs::write(dir.join(MCP_FILE), body).unwrap();
    }

    #[test]
    fn imports_a_stdio_server_and_declares_the_grant() {
        let dir = tempfile::tempdir().unwrap();
        write_mcp(
            dir.path(),
            &format!(
                r#"{{"$schema":"{MCP_SCHEMA_URL}","mcpServers":{{"tool":{{"type":"stdio","command":"npx","args":["-y","thing"]}}}}}}"#
            ),
        );
        let imported = import_manifest(dir.path(), &spec_manifest("")).unwrap();
        assert_eq!(imported.manifest["mcp_servers"]["tool"]["command"], "npx");
        assert_eq!(
            imported.manifest["permission_grants"][0],
            crate::sidecar::mcp::GRANT_MCP_SERVER
        );
    }

    #[test]
    fn expands_placeholders_in_args_but_never_in_command() {
        let dir = tempfile::tempdir().unwrap();
        write_mcp(
            dir.path(),
            &format!(
                r#"{{"$schema":"{MCP_SCHEMA_URL}","mcpServers":{{"tool":{{"type":"stdio","command":"npx","args":["--root","${{PLUGIN_ROOT}}/data"],"env":{{"D":"${{PLUGIN_DATA}}/x"}}}}}}}}"#
            ),
        );
        let imported = import_manifest(dir.path(), &spec_manifest("")).unwrap();
        let server = &imported.manifest["mcp_servers"]["tool"];
        let arg = server["args"][1].as_str().unwrap();
        assert!(arg.starts_with(dir.path().to_str().unwrap()), "{arg}");
        assert!(!server["env"]["D"]
            .as_str()
            .unwrap()
            .contains("${PLUGIN_DATA}"));
    }

    #[test]
    fn skips_a_server_whose_command_escapes_the_plugin_root() {
        let dir = tempfile::tempdir().unwrap();
        write_mcp(
            dir.path(),
            &format!(
                r#"{{"$schema":"{MCP_SCHEMA_URL}","mcpServers":{{"bad":{{"type":"stdio","command":"./../../evil"}},"ok":{{"type":"stdio","command":"npx"}}}}}}"#
            ),
        );
        let imported = import_manifest(dir.path(), &spec_manifest("")).unwrap();
        let servers = imported.manifest["mcp_servers"].as_object().unwrap();
        assert!(!servers.contains_key("bad"));
        assert!(servers.contains_key("ok"));
        assert!(imported.notes.iter().any(|n| n.contains("outside")));
    }

    #[test]
    fn skips_an_absolute_command_and_a_shell_string() {
        let dir = tempfile::tempdir().unwrap();
        write_mcp(
            dir.path(),
            &format!(
                r#"{{"$schema":"{MCP_SCHEMA_URL}","mcpServers":{{"abs":{{"type":"stdio","command":"/usr/bin/evil"}},"shell":{{"type":"stdio","command":"sh -c evil"}}}}}}"#
            ),
        );
        let imported = import_manifest(dir.path(), &spec_manifest("")).unwrap();
        assert!(imported.manifest.get("mcp_servers").is_none());
        assert_eq!(imported.notes.len(), 2);
    }

    #[test]
    fn imports_remote_transports_and_skips_unknown_fields_per_entry() {
        let dir = tempfile::tempdir().unwrap();
        write_mcp(
            dir.path(),
            &format!(
                r#"{{"$schema":"{MCP_SCHEMA_URL}","mcpServers":{{"remote":{{"type":"streamable-http","url":"https://x.example/mcp","headers":{{"Authorization":"Bearer static"}}}},"legacy":{{"type":"sse","url":"https://x.example/sse"}},"weird":{{"type":"stdio","command":"npx","enabled":false}},"ok":{{"type":"stdio","command":"npx"}}}}}}"#
            ),
        );
        let imported = import_manifest(dir.path(), &spec_manifest("")).unwrap();
        let servers = imported.manifest["mcp_servers"].as_object().unwrap();
        assert_eq!(servers.len(), 3);
        assert!(servers.contains_key("ok"));
        assert_eq!(servers["remote"]["type"], "streamable-http");
        assert_eq!(servers["remote"]["url"], "https://x.example/mcp");
        assert_eq!(
            servers["remote"]["headers"]["Authorization"],
            "Bearer static"
        );
        assert_eq!(servers["legacy"]["type"], "sse");
        assert!(!imported
            .notes
            .iter()
            .any(|n| n.contains("remote transport")));
        assert!(imported.notes.iter().any(|n| n.contains("enabled")));
    }

    #[test]
    fn preserves_http_remote_urls_and_rejects_invalid_headers_per_entry() {
        let dir = tempfile::tempdir().unwrap();
        write_mcp(
            dir.path(),
            &format!(
                r#"{{"$schema":"{MCP_SCHEMA_URL}","mcpServers":{{"insecure":{{"type":"streamable-http","url":"http://remote.example/mcp"}},"credentials":{{"type":"sse","url":"https://user:pass@example.com/sse"}},"headers":{{"type":"sse","url":"https://example.com/sse","headers":{{"Bad Header":"x"}}}},"ok":{{"type":"streamable-http","url":"https://x.example/mcp"}}}}}}"#
            ),
        );
        let imported = import_manifest(dir.path(), &spec_manifest("")).unwrap();
        let servers = imported.manifest["mcp_servers"].as_object().unwrap();
        assert_eq!(servers.len(), 2);
        assert!(servers.contains_key("ok"));
        assert!(servers.contains_key("insecure"));
        assert!(imported.notes.iter().any(|n| n.contains("credentials")));
        assert!(imported.notes.iter().any(|n| n.contains("header")));
    }

    #[test]
    fn skips_a_server_declaring_a_cwd_we_cannot_honour() {
        let dir = tempfile::tempdir().unwrap();
        write_mcp(
            dir.path(),
            &format!(
                r#"{{"$schema":"{MCP_SCHEMA_URL}","mcpServers":{{"s":{{"type":"stdio","command":"npx","cwd":"./data"}}}}}}"#
            ),
        );
        let imported = import_manifest(dir.path(), &spec_manifest("")).unwrap();
        assert!(imported.manifest.get("mcp_servers").is_none());
        assert!(imported.notes.iter().any(|n| n.contains("cwd")));
    }

    #[test]
    fn reports_bundled_skills_the_materializer_will_not_find() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("skills")).unwrap();
        let imported = import_manifest(dir.path(), &spec_manifest("")).unwrap();
        assert!(
            imported.notes.iter().any(|n| n.contains("skills/")),
            "{:?}",
            imported.notes
        );
    }

    #[test]
    fn a_bad_mcp_file_disables_mcp_without_failing_the_plugin() {
        let dir = tempfile::tempdir().unwrap();
        write_mcp(dir.path(), "{ not json");
        let imported = import_manifest(dir.path(), &spec_manifest("")).unwrap();
        assert_eq!(imported.manifest["id"], "@agent-plugins/summarize");
        assert!(imported.manifest.get("mcp_servers").is_none());
        assert!(imported.notes.iter().any(|n| n.contains("MCP disabled")));
    }

    #[test]
    fn an_mcp_file_targeting_another_spec_version_disables_mcp() {
        let dir = tempfile::tempdir().unwrap();
        write_mcp(
            dir.path(),
            r#"{"$schema":"https://agent-plugins.org/schemas/9.9.9/mcp.schema.json","mcpServers":{"s":{"type":"stdio","command":"npx"}}}"#,
        );
        let imported = import_manifest(dir.path(), &spec_manifest("")).unwrap();
        assert!(imported.manifest.get("mcp_servers").is_none());
        assert!(imported
            .notes
            .iter()
            .any(|n| n.contains("unsupported schema")));
    }
}
