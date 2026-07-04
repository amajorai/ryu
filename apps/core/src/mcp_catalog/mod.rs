//! MCP catalog — browse and install MCP servers from the **official MCP
//! registry** (`https://registry.modelcontextprotocol.io`). **All logic lives
//! here in Core** so the desktop, mobile, and extension are pure GUI layers over
//! one HTTP API, exactly like the model ([`crate::model_catalog`]) and skill
//! ([`crate::skills_catalog`]) catalogs.
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md section 1): discovering an
//! MCP server is "what could run" and installing it (writing a server entry into
//! `~/.ryu/mcp.json`) is "what runs" (orchestration), so both belong in Core. A
//! freshly installed server lands in the same `~/.ryu/mcp.json` the
//! [`crate::sidecar::mcp::McpRegistry`] reads, so after a hot-reload its tools
//! are listable via `POST /api/mcp/tools/call`.
//!
//! ## Security (the seam was just hardened, this module reuses it)
//!
//! - Every remote fetch goes through [`crate::server::guarded_get`]: https-only,
//!   resolved IPs screened, pinned to the validated IPs (anti DNS-rebind), with
//!   redirects disabled. A registry base URL is operator/source supplied, so it
//!   must be SSRF-guarded at fetch time, not just at add time.
//! - A registry-supplied package spec becomes a launch **command** the moment
//!   the server is enabled and started. We therefore treat it as untrusted:
//!   install validates/normalizes the package identifier + version (no shell
//!   metacharacters, no path traversal), and the entry is written **disabled**
//!   so install never auto-launches anything. The user surfaces and enables it
//!   through the existing explicit start path.
//!
//! ## The official `server.json` shape we parse
//!
//! The registry's list endpoint (`/v0.1/servers`) returns a paginated envelope
//! whose `servers[]` entries follow the MCP `server.json` schema. We read the
//! subset that matters for surfacing + installing a server (unknown fields are
//! ignored):
//!
//! ```json
//! {
//!   "servers": [
//!     {
//!       "name": "io.github.owner/server",
//!       "description": "…",
//!       "version": "1.2.3",
//!       "packages": [
//!         { "registry_type": "npm", "identifier": "@scope/pkg",
//!           "version": "1.2.3", "transport": { "type": "stdio" } }
//!       ],
//!       "remotes": [
//!         { "type": "streamable-http", "url": "https://example.com/mcp" }
//!       ]
//!     }
//!   ],
//!   "metadata": { "next_cursor": "…" }
//! }
//! ```
//!
//! - `packages[]` describes a runnable package (npm/pypi/oci) with a transport
//!   (`stdio` or `http`/`streamable-http`/`sse`). A stdio package maps to a
//!   launch command (`npx`/`uvx`/`docker`).
//! - `remotes[]` describes an already-hosted endpoint (a URL); installing one
//!   writes a remote URL entry, no local command.

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

/// Default official MCP registry base. Swappable via `RYU_MCP_REGISTRY_URL` so
/// the source stays unhardcoded ("nothing hardcoded"); a custom Mcp source can
/// also carry its own `base_url`.
const DEFAULT_REGISTRY_BASE: &str = "https://registry.modelcontextprotocol.io";

/// The list endpoint path on the registry (the `v0.1` API surface).
const SERVERS_PATH: &str = "/v0.1/servers";

/// Resolve the registry base URL: an explicit `base_url` override (a custom
/// source), else `RYU_MCP_REGISTRY_URL`, else the official default. The trailing
/// slash is trimmed so path joins are clean.
pub fn registry_base(base_url: Option<&str>) -> String {
    let raw = base_url
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::env::var("RYU_MCP_REGISTRY_URL")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_else(|| DEFAULT_REGISTRY_BASE.to_string());
    raw.trim_end_matches('/').to_string()
}

// ── Wire types (the subset of server.json we read) ──────────────────────────

/// The list envelope returned by `/v0.1/servers`.
#[derive(Debug, Clone, Deserialize)]
struct ServerListEnvelope {
    #[serde(default, deserialize_with = "deserialize_server_entries")]
    servers: Vec<ServerJson>,
    #[serde(default)]
    metadata: ListMetadata,
}

/// Pagination metadata; only the forward cursor is surfaced. The official
/// registry sends `nextCursor` (camelCase); older mirrors/fixtures use
/// `next_cursor` — accept both.
#[derive(Debug, Clone, Default, Deserialize)]
struct ListMetadata {
    #[serde(default, alias = "nextCursor")]
    next_cursor: Option<String>,
}

/// One element of the registry's `servers[]` array. The official v0.1 registry
/// wraps each server as `{ "server": { … }, "_meta": { … } }`; older mirrors and
/// our test fixtures use the flat `{ name, … }` shape. Accept both so a registry
/// shape change never blanks the catalog (the old flat parse returned 502).
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum ServerEntry {
    Wrapped { server: ServerJson },
    Flat(ServerJson),
}

impl ServerEntry {
    fn into_server(self) -> ServerJson {
        match self {
            ServerEntry::Wrapped { server } => server,
            ServerEntry::Flat(server) => server,
        }
    }
}

/// Deserialize a `servers[]` array of mixed wrapped/flat entries into flat
/// [`ServerJson`]s, so the rest of the pipeline stays shape-agnostic.
fn deserialize_server_entries<'de, D>(deserializer: D) -> Result<Vec<ServerJson>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries = Vec::<ServerEntry>::deserialize(deserializer)?;
    Ok(entries.into_iter().map(ServerEntry::into_server).collect())
}

/// One server entry in the registry, following the `server.json` schema. Only
/// the fields we surface are read; everything else is ignored.
///
/// `pub(crate)` so sibling Mcp sources (Smithery / Ryu-hosted #465) map their own
/// parsed data into this shape and reuse [`plan_from_server`] for the same
/// validation (no hand-built launch commands).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ServerJson {
    /// Reverse-DNS server name (also the catalog id), e.g. `io.github.acme/srv`.
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) version: Option<String>,
    #[serde(default)]
    pub(crate) packages: Vec<PackageJson>,
    #[serde(default)]
    pub(crate) remotes: Vec<RemoteJson>,
}

/// One runnable package for a server (npm/pypi/oci + transport).
#[derive(Debug, Clone, Deserialize)]
struct PackageJson {
    /// Package ecosystem: `npm`, `pypi`, `oci` (`registry_name` is the older
    /// field name; accept both).
    #[serde(default, alias = "registry_name")]
    registry_type: Option<String>,
    /// Package identifier (npm name, pypi name, oci image ref).
    #[serde(default, alias = "name")]
    identifier: Option<String>,
    #[serde(default)]
    version: Option<String>,
    /// Transport descriptor. May be a `{ "type": "stdio" }` object (newer) or a
    /// bare `transport_type` string sibling (older); both are normalized.
    #[serde(default)]
    transport: Option<TransportJson>,
    #[serde(default)]
    transport_type: Option<String>,
}

/// Transport object (`{ "type": "stdio" | "http" | "streamable-http" | "sse", … }`).
#[derive(Debug, Clone, Deserialize)]
struct TransportJson {
    #[serde(default, rename = "type")]
    transport_type: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

/// A hosted remote endpoint for a server.
#[derive(Debug, Clone, Deserialize)]
struct RemoteJson {
    #[serde(default, rename = "type", alias = "transport_type")]
    transport_type: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

impl ServerJson {
    /// Construct a remote-only server (a hosted MCP endpoint reached by URL).
    /// Used by sibling Mcp sources (Smithery #465) that map a hosted server into
    /// the canonical [`ServerJson`] shape so [`plan_from_server`] validates the
    /// URL and sanitizes the name with no duplicated logic.
    pub(crate) fn remote(
        name: impl Into<String>,
        description: Option<String>,
        url: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            description,
            version: None,
            packages: Vec::new(),
            remotes: vec![RemoteJson {
                transport_type: Some("streamable-http".to_string()),
                url: Some(url.into()),
            }],
        }
    }

    /// Construct an npm-package stdio server. Used by sibling sources that expose
    /// a launchable npm package (Smithery stdio connection #465); the identifier
    /// + version are validated by [`plan_from_server`].
    pub(crate) fn npm_stdio(
        name: impl Into<String>,
        description: Option<String>,
        identifier: impl Into<String>,
        version: Option<String>,
    ) -> Self {
        Self {
            name: name.into(),
            description,
            version: version.clone(),
            packages: vec![PackageJson {
                registry_type: Some("npm".to_string()),
                identifier: Some(identifier.into()),
                version,
                transport: Some(TransportJson {
                    transport_type: Some("stdio".to_string()),
                    url: None,
                }),
                transport_type: None,
            }],
            remotes: Vec::new(),
        }
    }
}

impl PackageJson {
    /// The transport string, normalized (`stdio` is the default when unstated —
    /// a package with no transport is assumed stdio-launchable).
    fn transport_str(&self) -> String {
        self.transport
            .as_ref()
            .and_then(|t| t.transport_type.clone())
            .or_else(|| self.transport_type.clone())
            .unwrap_or_else(|| "stdio".to_string())
            .to_ascii_lowercase()
    }

    fn is_stdio(&self) -> bool {
        self.transport_str() == "stdio"
    }
}

// ── Public catalog API (card + detail JSON) ─────────────────────────────────

/// Search the registry, returning a `{ servers, next_cursor }` envelope of
/// catalog cards. `query` filters client-side by name/description (the official
/// registry list endpoint has no full-text search yet); `cursor` paginates.
pub async fn search_servers_json(
    base_url: Option<&str>,
    query: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<Value> {
    let (servers, next_cursor) = fetch_servers(base_url, limit, cursor).await?;
    let needle = query.trim().to_ascii_lowercase();
    let cards: Vec<Value> = servers
        .iter()
        .filter(|s| {
            if needle.is_empty() {
                return true;
            }
            s.name.to_ascii_lowercase().contains(&needle)
                || s.description
                    .as_deref()
                    .is_some_and(|d| d.to_ascii_lowercase().contains(&needle))
        })
        .map(server_to_card)
        .collect();
    Ok(json!({
        "servers": cards,
        "next_cursor": next_cursor,
    }))
}

/// Fetch a single server's detail payload (card + its packages + remotes), so a
/// client can show what installing it would launch (the command) before
/// committing.
pub async fn server_detail_json(base_url: Option<&str>, id: &str) -> Result<Value> {
    let server = find_server(base_url, id).await?;
    Ok(server_to_detail(&server))
}

/// Map a server into the catalog-card JSON the desktop list renders.
///
/// `pub(crate)` so sibling Mcp sources that parse into [`ServerJson`] reuse the
/// exact card shape with no client change (#465).
pub(crate) fn server_to_card(s: &ServerJson) -> Value {
    let transports: Vec<String> = s
        .packages
        .iter()
        .map(PackageJson::transport_str)
        .chain(s.remotes.iter().map(|r| {
            r.transport_type
                .clone()
                .unwrap_or_else(|| "http".to_string())
        }))
        .collect();
    json!({
        "id": s.name,
        "name": s.name,
        "description": s.description,
        "version": s.version,
        "has_packages": !s.packages.is_empty(),
        "has_remotes": !s.remotes.is_empty(),
        "transports": transports,
        "installed": false,
    })
}

/// Map a server into the detail JSON exposing its packages + remotes so the user
/// can review the launch command before installing.
///
/// `pub(crate)` so sibling Mcp sources reuse the exact detail shape (#465).
pub(crate) fn server_to_detail(s: &ServerJson) -> Value {
    let packages: Vec<Value> = s
        .packages
        .iter()
        .map(|p| {
            json!({
                "registry_type": p.registry_type,
                "identifier": p.identifier,
                "version": p.version,
                "transport": p.transport_str(),
            })
        })
        .collect();
    let remotes: Vec<Value> = s
        .remotes
        .iter()
        .map(|r| {
            json!({
                "transport_type": r.transport_type,
                "url": r.url,
            })
        })
        .collect();
    json!({
        "card": server_to_card(s),
        "packages": packages,
        "remotes": remotes,
    })
}

// ── Registry fetch (SSRF-guarded) ───────────────────────────────────────────

/// Fetch one page of servers from the registry list endpoint. Returns the parsed
/// entries plus the next pagination cursor (when the registry supplies one).
async fn fetch_servers(
    base_url: Option<&str>,
    limit: usize,
    cursor: Option<&str>,
) -> Result<(Vec<ServerJson>, Option<String>)> {
    let base = registry_base(base_url);
    let mut url = format!("{base}{SERVERS_PATH}");
    let mut params: Vec<String> = Vec::new();
    if limit > 0 {
        params.push(format!("limit={limit}"));
    }
    if let Some(c) = cursor.filter(|c| !c.is_empty()) {
        params.push(format!("cursor={}", urlencode(c)));
    }
    if !params.is_empty() {
        url.push('?');
        url.push_str(&params.join("&"));
    }
    // The registry base is operator/source supplied, so SSRF-guard the fetch:
    // resolve + screen IPs, pin the client, disable redirects.
    let body = crate::server::guarded_get_bytes(&url)
        .await
        .with_context(|| format!("fetching MCP registry {url}"))?;
    let envelope =
        parse_server_list_envelope(&body).with_context(|| format!("parsing MCP registry {url}"))?;
    Ok((envelope.servers, envelope.metadata.next_cursor))
}

/// Find a server by its registry `name` (the catalog id). The official list
/// endpoint has no per-name lookup yet, so we page through and match.
async fn find_server(base_url: Option<&str>, id: &str) -> Result<ServerJson> {
    // A single generous page covers the current registry size; cursor follow-up
    // can be added when it grows past one page.
    let (servers, _next) = fetch_servers(base_url, 200, None).await?;
    servers
        .into_iter()
        .find(|s| s.name == id)
        .ok_or_else(|| anyhow!("MCP server `{id}` not found in registry"))
}

/// Parse a registry list document, returning just the servers. Accepts the
/// documented `{ servers, metadata }` envelope and a bare `[ … ]` array.
///
/// `pub(crate)` so the Ryu-hosted source (#465) parses a server.json-shaped
/// hosted index with the exact same tolerant parser (never panics on bad input).
pub(crate) fn parse_server_list(bytes: &[u8]) -> Result<Vec<ServerJson>> {
    Ok(parse_server_list_envelope(bytes)?.servers)
}

/// Parse a registry list document into the full envelope (servers + pagination).
/// Accepts the documented `{ servers, metadata }` envelope, and also a bare
/// `[ … ]` array for resilience (never panics on bad input — a parse failure is
/// a clear error, not a crash).
fn parse_server_list_envelope(bytes: &[u8]) -> Result<ServerListEnvelope> {
    // Try the envelope first.
    if let Ok(env) = serde_json::from_slice::<ServerListEnvelope>(bytes) {
        if !env.servers.is_empty() || env.metadata.next_cursor.is_some() {
            return Ok(env);
        }
    }
    // Fall back to a bare array of server entries (wrapped or flat).
    let entries: Vec<ServerEntry> = serde_json::from_slice(bytes).map_err(|e| {
        anyhow!("registry response is neither a servers envelope nor an array: {e}")
    })?;
    Ok(ServerListEnvelope {
        servers: entries.into_iter().map(ServerEntry::into_server).collect(),
        metadata: ListMetadata::default(),
    })
}

/// Minimal percent-encoding for a cursor value's reserved characters. The cursor
/// is registry-supplied and opaque; we only escape what would break the query.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ── Install: build a validated mcp.json entry ───────────────────────────────

/// The kind of mcp.json entry an install resolves to: a local stdio launch
/// command, or a remote URL. Kept as an enum so the route can report which path
/// was taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpEntryPlan {
    /// A local stdio server: a launch command + its args.
    Stdio { command: String, args: Vec<String> },
    /// A hosted remote server reached by URL.
    Remote { url: String },
}

/// The resolved install plan: the server name (the mcp.json key) plus the entry
/// to write and a human description. Returned by [`plan_install`] so the route
/// can write the entry and surface the command to the user.
#[derive(Debug, Clone)]
pub struct InstallPlan {
    /// The mcp.json key (sanitized server name; no `__`, no whitespace).
    pub server_name: String,
    /// The entry to write.
    pub entry: McpEntryPlan,
    /// Human description carried into the mcp.json entry's `description`.
    pub description: Option<String>,
}

/// Resolve a registry server `id` into a validated [`InstallPlan`]. Prefers a
/// stdio package (the local launch path) and falls back to the first remote URL.
/// The package identifier/version are validated to reject shell metacharacters
/// and path traversal before they are baked into a launch command. **This never
/// launches anything** — it only builds the descriptor.
pub async fn plan_install(base_url: Option<&str>, id: &str) -> Result<InstallPlan> {
    let server = find_server(base_url, id).await?;
    plan_from_server(&server)
}

/// Build an [`InstallPlan`] from a parsed server (shared by [`plan_install`] and
/// the no-network tests).
///
/// `pub(crate)` so sibling Mcp sources (Smithery #465, Ryu-hosted #465) map their
/// own parsed data into a [`ServerJson`] and get the exact same validation
/// (`validate_package_identifier` / `validate_version` / `sanitize_server_name` /
/// `validate_remote_url`) for free — no hand-built launch commands.
pub(crate) fn plan_from_server(server: &ServerJson) -> Result<InstallPlan> {
    let server_name = sanitize_server_name(&server.name)?;
    let description = server.description.clone();

    // Prefer a stdio package (a local launch). Fall back to a remote URL.
    if let Some(pkg) = server.packages.iter().find(|p| p.is_stdio()) {
        let entry = stdio_entry_for_package(pkg)?;
        return Ok(InstallPlan {
            server_name,
            entry,
            description,
        });
    }
    if let Some(remote) = server.remotes.iter().find_map(|r| {
        r.url
            .as_deref()
            .filter(|u| !u.trim().is_empty())
            .map(str::to_string)
    }) {
        let url = validate_remote_url(&remote)?;
        return Ok(InstallPlan {
            server_name,
            entry: McpEntryPlan::Remote { url },
            description,
        });
    }
    // A non-stdio package with no remote (e.g. an http package carrying a URL).
    if let Some(pkg) = server.packages.first() {
        if let Some(t) = pkg.transport.as_ref() {
            if let Some(url) = t.url.as_deref().filter(|u| !u.trim().is_empty()) {
                let url = validate_remote_url(url)?;
                return Ok(InstallPlan {
                    server_name,
                    entry: McpEntryPlan::Remote { url },
                    description,
                });
            }
        }
    }
    bail!(
        "MCP server `{}` has no installable stdio package or remote URL",
        server.name
    )
}

/// Build a stdio launch entry for a package: pick the runner for its ecosystem
/// (`npx` for npm, `uvx` for pypi, `docker run` for oci) and append the validated
/// `identifier@version`. The identifier + version are validated first.
fn stdio_entry_for_package(pkg: &PackageJson) -> Result<McpEntryPlan> {
    let identifier = pkg
        .identifier
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("package has no identifier"))?;
    validate_package_identifier(identifier)?;

    let version = match pkg
        .version
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(v) => {
            validate_version(v)?;
            Some(v.to_string())
        }
        None => None,
    };

    let registry = pkg
        .registry_type
        .as_deref()
        .unwrap_or("npm")
        .to_ascii_lowercase();

    let (command, args) = match registry.as_str() {
        "npm" => {
            let spec = match &version {
                Some(v) => format!("{identifier}@{v}"),
                None => identifier.to_string(),
            };
            ("npx".to_string(), vec!["-y".to_string(), spec])
        }
        "pypi" => {
            // uvx runs a python tool; pin the version with `package==x.y.z`.
            let spec = match &version {
                Some(v) => format!("{identifier}=={v}"),
                None => identifier.to_string(),
            };
            ("uvx".to_string(), vec![spec])
        }
        "oci" | "docker" => {
            // OCI images launch via `docker run -i --rm <image>[:tag]`.
            let spec = match &version {
                Some(v) => format!("{identifier}:{v}"),
                None => identifier.to_string(),
            };
            (
                "docker".to_string(),
                vec![
                    "run".to_string(),
                    "-i".to_string(),
                    "--rm".to_string(),
                    spec,
                ],
            )
        }
        other => bail!("unsupported package registry_type `{other}`"),
    };

    Ok(McpEntryPlan::Stdio { command, args })
}

/// Sanitize a registry server name into a safe mcp.json key. The name is the map
/// key (not executed), but it must not contain the `__` tool-id separator or
/// whitespace, and must be non-empty.
fn sanitize_server_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        bail!("server name is empty");
    }
    if trimmed.contains("__") {
        bail!("server name `{trimmed}` contains the reserved `__` separator");
    }
    if trimmed.chars().any(char::is_whitespace) {
        bail!("server name `{trimmed}` contains whitespace");
    }
    Ok(trimmed.to_string())
}

/// Validate a package identifier (npm/pypi name or oci image ref). This becomes
/// part of an executed launch command, so it is treated as untrusted: reject
/// shell metacharacters and path traversal. Allows the characters real package
/// names use: letters, digits, and `@ / . _ - : +`.
fn validate_package_identifier(identifier: &str) -> Result<()> {
    if identifier.is_empty() {
        bail!("package identifier is empty");
    }
    // Path traversal guard (an identifier must never escape into a path).
    if identifier.contains("..") {
        bail!("package identifier `{identifier}` contains `..`");
    }
    // Reject a leading non [A-Za-z0-9@] char (argv flag-smuggling guard): an
    // identifier like `--foo` or `-x` would otherwise be parsed as an *option* by
    // npx / uvx / docker (not a package name) when the server is later launched.
    let first = identifier.chars().next().unwrap_or(' ');
    if !(first.is_ascii_alphanumeric() || first == '@') {
        bail!("package identifier `{identifier}` must start with a letter, digit, or `@`");
    }
    // Reject any character outside the safe package-name set. This rejects shell
    // metacharacters (; | & $ ` > < ( ) { } * ? ! \ ' " space newline …) outright.
    let ok = identifier
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '.' | '_' | '-' | ':' | '+'));
    if !ok {
        bail!("package identifier `{identifier}` contains disallowed characters");
    }
    Ok(())
}

/// Validate a package version string. Versions are simple semver-ish tokens; we
/// allow letters, digits, and `. - + _` (covers `1.2.3`, `1.2.3-rc.1`, `latest`).
fn validate_version(version: &str) -> Result<()> {
    // A version is concatenated into the spec (`pkg@ver` / `pkg==ver` / `pkg:ver`),
    // so a leading `-` could still smuggle a flag; reject it for consistency.
    if version.starts_with('-') {
        bail!("package version `{version}` may not start with `-`");
    }
    let ok = version
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_'));
    if !ok {
        bail!("package version `{version}` contains disallowed characters");
    }
    Ok(())
}

/// Validate a remote URL: it must be a well-formed `https`/`http` URL. (We allow
/// `http` for localhost-style dev remotes; the SSRF guard only applies to *our*
/// fetches, not to a URL the user explicitly installs and later connects to.)
fn validate_remote_url(url: &str) -> Result<String> {
    let trimmed = url.trim();
    let parsed = url::Url::parse(trimmed)
        .map_err(|e| anyhow!("remote URL `{trimmed}` is not a valid URL: {e}"))?;
    match parsed.scheme() {
        "https" | "http" => Ok(trimmed.to_string()),
        other => bail!("remote URL scheme `{other}` is not supported (expected http/https)"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_LIST: &str = r#"{
        "servers": [
            {
                "name": "io.github.acme/files",
                "description": "Filesystem tools",
                "version": "1.4.0",
                "packages": [
                    { "registry_type": "npm", "identifier": "@acme/mcp-files",
                      "version": "1.4.0", "transport": { "type": "stdio" } }
                ]
            },
            {
                "name": "io.github.acme/weather",
                "description": "Hosted weather server",
                "version": "2.0.0",
                "remotes": [
                    { "type": "streamable-http", "url": "https://mcp.acme.com/weather" }
                ]
            },
            {
                "name": "io.github.acme/py-tool",
                "description": "A python MCP server",
                "packages": [
                    { "registry_type": "pypi", "identifier": "acme-mcp",
                      "version": "0.3.1", "transport": { "type": "stdio" } }
                ]
            }
        ],
        "metadata": { "next_cursor": "abc123" }
    }"#;

    fn server_named(name: &str) -> ServerJson {
        let env = parse_server_list_envelope(SAMPLE_LIST.as_bytes()).expect("parse");
        env.servers
            .into_iter()
            .find(|s| s.name == name)
            .expect("server present")
    }

    #[test]
    fn parses_list_into_cards_and_detail() {
        let env = parse_server_list_envelope(SAMPLE_LIST.as_bytes()).expect("parse list");
        assert_eq!(env.servers.len(), 3);
        assert_eq!(env.metadata.next_cursor.as_deref(), Some("abc123"));

        // Card maps the surfaced fields.
        let files = &env.servers[0];
        let card = server_to_card(files);
        assert_eq!(card["id"], "io.github.acme/files");
        assert_eq!(card["version"], "1.4.0");
        assert_eq!(card["has_packages"], true);
        assert_eq!(card["has_remotes"], false);
        assert_eq!(card["transports"][0], "stdio");

        // Detail exposes packages + remotes.
        let detail = server_to_detail(files);
        assert_eq!(detail["packages"][0]["registry_type"], "npm");
        assert_eq!(detail["packages"][0]["identifier"], "@acme/mcp-files");
        assert_eq!(detail["packages"][0]["transport"], "stdio");

        let weather = &env.servers[1];
        let wdetail = server_to_detail(weather);
        assert_eq!(wdetail["remotes"][0]["url"], "https://mcp.acme.com/weather");
    }

    #[test]
    fn rejects_malformed_list() {
        assert!(parse_server_list(b"not json").is_err());
        // A bare array of entries is accepted (resilience fallback).
        let arr = br#"[{ "name": "io.github.x/y" }]"#;
        let servers = parse_server_list(arr).expect("array fallback parses");
        assert_eq!(servers.len(), 1);
    }

    // The official v0.1 registry wraps each entry as `{ server, _meta }` and
    // paginates with `nextCursor` (camelCase). Regression for the 502 that shape
    // caused before the parser tolerated both wrapped and flat entries.
    const WRAPPED_LIST: &str = r#"{
        "servers": [
            {
                "server": {
                    "name": "io.github.acme/files",
                    "description": "Filesystem tools",
                    "version": "1.4.0",
                    "remotes": [
                        { "type": "streamable-http", "url": "https://mcp.acme.com/files" }
                    ]
                },
                "_meta": { "io.modelcontextprotocol.registry/official": { "id": "x" } }
            }
        ],
        "metadata": { "nextCursor": "next-page", "count": 1 }
    }"#;

    #[test]
    fn parses_wrapped_registry_shape() {
        let env = parse_server_list_envelope(WRAPPED_LIST.as_bytes()).expect("parse wrapped");
        assert_eq!(env.servers.len(), 1);
        assert_eq!(env.servers[0].name, "io.github.acme/files");
        assert_eq!(env.metadata.next_cursor.as_deref(), Some("next-page"));
        let card = server_to_card(&env.servers[0]);
        assert_eq!(card["id"], "io.github.acme/files");
        assert_eq!(card["has_remotes"], true);
    }

    #[test]
    fn parses_wrapped_bare_array() {
        // A bare array whose elements are wrapped also unwraps (resilience path).
        let arr = br#"[{ "server": { "name": "io.github.x/y" }, "_meta": {} }]"#;
        let servers = parse_server_list(arr).expect("wrapped array fallback parses");
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "io.github.x/y");
    }

    #[test]
    fn stdio_npm_package_builds_npx_entry() {
        let plan = plan_from_server(&server_named("io.github.acme/files")).expect("plan");
        assert_eq!(plan.server_name, "io.github.acme/files");
        assert_eq!(
            plan.entry,
            McpEntryPlan::Stdio {
                command: "npx".to_string(),
                args: vec!["-y".to_string(), "@acme/mcp-files@1.4.0".to_string()],
            }
        );
    }

    #[test]
    fn stdio_pypi_package_builds_uvx_entry() {
        let plan = plan_from_server(&server_named("io.github.acme/py-tool")).expect("plan");
        assert_eq!(
            plan.entry,
            McpEntryPlan::Stdio {
                command: "uvx".to_string(),
                args: vec!["acme-mcp==0.3.1".to_string()],
            }
        );
    }

    #[test]
    fn remote_server_builds_url_entry() {
        let plan = plan_from_server(&server_named("io.github.acme/weather")).expect("plan");
        assert_eq!(
            plan.entry,
            McpEntryPlan::Remote {
                url: "https://mcp.acme.com/weather".to_string(),
            }
        );
    }

    #[test]
    fn rejects_shell_metacharacters_in_identifier() {
        // A malicious package identifier carrying a shell injection is rejected
        // before it can become a launch command.
        assert!(validate_package_identifier("@acme/pkg; rm -rf /").is_err());
        assert!(validate_package_identifier("pkg$(whoami)").is_err());
        assert!(validate_package_identifier("pkg`id`").is_err());
        assert!(validate_package_identifier("pkg && curl evil").is_err());
        assert!(validate_package_identifier("../../etc/passwd").is_err());
        // Real package names pass.
        assert!(validate_package_identifier("@modelcontextprotocol/server-filesystem").is_ok());
        assert!(validate_package_identifier("mcp-server-git").is_ok());
        assert!(validate_package_identifier("ghcr.io/acme/mcp:1.0").is_ok());
    }

    #[test]
    fn rejects_bad_version_and_name() {
        assert!(validate_version("1.2.3").is_ok());
        assert!(validate_version("1.2.3-rc.1").is_ok());
        assert!(validate_version("latest").is_ok());
        assert!(validate_version("1.2.3; rm").is_err());

        assert!(sanitize_server_name("io.github.acme/files").is_ok());
        assert!(sanitize_server_name("bad__name").is_err());
        assert!(sanitize_server_name("has space").is_err());
        assert!(sanitize_server_name("   ").is_err());
    }

    #[test]
    fn remote_url_must_be_http_s() {
        assert!(validate_remote_url("https://example.com/mcp").is_ok());
        assert!(validate_remote_url("http://localhost:3000/mcp").is_ok());
        assert!(validate_remote_url("file:///etc/passwd").is_err());
        assert!(validate_remote_url("not a url").is_err());
    }

    #[test]
    fn registry_base_trims_and_defaults() {
        assert_eq!(registry_base(None), DEFAULT_REGISTRY_BASE);
        assert_eq!(
            registry_base(Some("https://mirror.example/")),
            "https://mirror.example"
        );
    }
}
