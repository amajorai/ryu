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
//!   install requires an exact version, verifies npm/PyPI ownership metadata or
//!   an immutable OCI digest, validates the identifier (no shell metacharacters
//!   or path traversal), and writes the entry **disabled**. Install never
//!   downloads or launches a package. The user surfaces and enables it through
//!   the existing explicit start path.
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
//!   (`stdio` or `http`/`streamable-http`/`sse`). A verified stdio package maps
//!   to a launch command (`npx`/`uvx`/`docker`).
//! - `remotes[]` describes an already-hosted endpoint (a URL); installing one
//!   writes a remote URL entry, no local command.

use std::sync::{Arc, OnceLock};

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

// ── Kernel seam (the one coupling this primitive inverts back into Core) ─────

/// The narrow kernel seam this extracted primitive inverts back into Core.
///
/// The catalog itself is pure orchestration (wire parsing, card/detail shaping,
/// install-plan validation), but one coupling is process-global Core state: the
/// **SSRF-guarded registry fetch**. A registry base URL is operator/source
/// supplied, so every remote fetch must go through Core's `guarded_get_bytes`
/// (https-only, resolved-IP screening, redirect-disabled) rather than a raw
/// client. Core implements this once (`apps/core/src/mcp_catalog_host.rs`) and
/// installs it at boot via [`set_global_host`], BEFORE the first catalog call.
/// Production [`host`] is strict: it panics if the host was never installed
/// rather than silently dropping the SSRF guard.
#[async_trait::async_trait]
pub trait McpCatalogHost: Send + Sync {
    /// Fetch a URL's bytes through Core's SSRF-guarded client (https-only,
    /// resolved IPs screened + pinned against DNS-rebind, redirects disabled).
    async fn guarded_get_bytes(&self, url: &str) -> Result<Vec<u8>>;
}

fn host_slot() -> &'static OnceLock<Arc<dyn McpCatalogHost>> {
    static HOST: OnceLock<Arc<dyn McpCatalogHost>> = OnceLock::new();
    &HOST
}

/// Install the process-wide [`McpCatalogHost`]. Called once at Core boot, before
/// any catalog route can run. Idempotent-friendly for tests (first install wins).
pub fn set_global_host(host: Arc<dyn McpCatalogHost>) {
    let _ = host_slot().set(host);
}

/// Fetch the installed host. Strict by design: panics if [`set_global_host`] was
/// never called, rather than silently issuing an un-guarded fetch.
fn host() -> Arc<dyn McpCatalogHost> {
    host_slot().get().cloned().expect(
        "ryu-mcp-catalog host not installed — call ryu_mcp_catalog::set_global_host at boot",
    )
}

/// Default official MCP registry base. Swappable via `RYU_MCP_REGISTRY_URL` so
/// the source stays unhardcoded ("nothing hardcoded"); a custom Mcp source can
/// also carry its own `base_url`.
const DEFAULT_REGISTRY_BASE: &str = "https://registry.modelcontextprotocol.io";
const NPM_REGISTRY_BASE: &str = "https://registry.npmjs.org";
const PYPI_REGISTRY_BASE: &str = "https://pypi.org";

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
pub struct ServerJson {
    /// Reverse-DNS server name (also the catalog id), e.g. `io.github.acme/srv`.
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub(crate) version: Option<String>,
    #[serde(default)]
    pub(crate) packages: Vec<PackageJson>,
    #[serde(default)]
    pub(crate) remotes: Vec<RemoteJson>,
    /// Set only after the caller has independently verified the package's
    /// registry metadata. A parsed catalog document is untrusted data and must
    /// never become a launch command without this explicit provenance bit.
    #[serde(skip)]
    package_provenance_verified: bool,
}

/// One runnable package for a server (npm/pypi/oci + transport).
#[derive(Debug, Clone, Deserialize)]
struct PackageJson {
    /// Package ecosystem: `npm`, `pypi`, `oci` (`registry_name` is the older
    /// field name; accept both).
    #[serde(default, alias = "registry_name", alias = "registryType")]
    registry_type: Option<String>,
    /// Package registry base URL from the current camelCase server.json schema.
    #[serde(default, alias = "registry_base_url", alias = "registryBaseUrl")]
    registry_base_url: Option<String>,
    /// Package identifier (npm name, pypi name, oci image ref).
    #[serde(default, alias = "name")]
    identifier: Option<String>,
    #[serde(default)]
    version: Option<String>,
    /// Optional package-file digest from the server.json schema. It is surfaced
    /// for review, but execution still requires registry provenance below.
    #[serde(default, alias = "file_sha256", alias = "fileSha256")]
    file_sha256: Option<String>,
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
    pub fn remote(
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
            package_provenance_verified: false,
        }
    }

    /// Construct an npm-package stdio server. Used by sibling sources that expose
    /// a launchable npm package (Smithery stdio connection #465); the identifier
    /// + version are validated by [`plan_from_server`].
    pub fn npm_stdio(
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
                registry_base_url: Some(NPM_REGISTRY_BASE.to_string()),
                identifier: Some(identifier.into()),
                version,
                file_sha256: None,
                transport: Some(TransportJson {
                    transport_type: Some("stdio".to_string()),
                    url: None,
                }),
                transport_type: None,
            }],
            remotes: Vec::new(),
            package_provenance_verified: false,
        }
    }

    /// Mark package metadata as verified by a trusted source. Callers must only
    /// use this after checking the package registry's exact name/version and
    /// ownership marker, not merely because a catalog document parsed.
    pub fn mark_package_provenance_verified(&mut self) {
        self.package_provenance_verified = true;
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
pub fn server_to_card(s: &ServerJson) -> Value {
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
pub fn server_to_detail(s: &ServerJson) -> Value {
    let packages: Vec<Value> = s
        .packages
        .iter()
        .map(|p| {
            json!({
                "registry_type": p.registry_type,
                "registry_base_url": p.registry_base_url,
                "identifier": p.identifier,
                "version": p.version,
                "file_sha256": p.file_sha256,
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
    // resolve + screen IPs, pin the client, disable redirects. The guard lives
    // in Core (kernel); the primitive reaches it through the installed host.
    let body = host()
        .guarded_get_bytes(&url)
        .await
        .with_context(|| format!("fetching MCP registry {url}"))?;
    let envelope =
        parse_server_list_envelope(&body).with_context(|| format!("parsing MCP registry {url}"))?;
    Ok((envelope.servers, envelope.metadata.next_cursor))
}

/// Pages a registry walk may follow. Bounds a broken or looping cursor.
const MAX_REGISTRY_PAGES: usize = 50;

/// Whether `candidate` is a newer registry version than `current`. Semver when
/// both parse; otherwise the later listing wins, which matches a registry that
/// lists versions oldest-first.
fn registry_version_is_newer(current: Option<&str>, candidate: Option<&str>) -> bool {
    let parse = |v: &str| semver::Version::parse(v.trim().trim_start_matches(['v', 'V'])).ok();
    match (current, candidate) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(a), Some(b)) => match (parse(a), parse(b)) {
            (Some(a), Some(b)) => b > a,
            _ => true,
        },
    }
}

/// Fold one more registry entry into a `name → newest entry` choice.
fn keep_newest(best: &mut Option<ServerJson>, candidate: ServerJson) {
    let replace = match best {
        None => true,
        Some(current) => {
            registry_version_is_newer(current.version.as_deref(), candidate.version.as_deref())
        }
    };
    if replace {
        *best = Some(candidate);
    }
}

/// Find a server by its registry `name` (the catalog id). The official list
/// endpoint has no per-name lookup yet, so we page through and match.
///
/// Walks EVERY page and keeps the newest version listed under the name: the
/// update check already reads the whole registry, so stopping at the first page
/// offered updates for servers beyond it that then failed with "not found", and
/// taking the first match could install an older version than the one the check
/// reported — a row that never cleared.
async fn find_server(base_url: Option<&str>, id: &str) -> Result<ServerJson> {
    let mut best: Option<ServerJson> = None;
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_REGISTRY_PAGES {
        let (servers, next) = fetch_servers(base_url, 200, cursor.as_deref()).await?;
        for server in servers.into_iter().filter(|s| s.name == id) {
            keep_newest(&mut best, server);
        }
        match next {
            Some(c) if !c.is_empty() => cursor = Some(c),
            _ => break,
        }
    }
    best.ok_or_else(|| anyhow!("MCP server `{id}` not found in registry"))
}

/// Parse a registry list document, returning just the servers. Accepts the
/// documented `{ servers, metadata }` envelope and a bare `[ … ]` array.
///
/// `pub(crate)` so the Ryu-hosted source (#465) parses a server.json-shaped
/// hosted index with the exact same tolerant parser (never panics on bad input).
pub fn parse_server_list(bytes: &[u8]) -> Result<Vec<ServerJson>> {
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
    /// Registry version at install time (recorded so an update can be detected).
    pub version: Option<String>,
    /// The catalog id (registry server name) — how to look the server up later.
    pub catalog_id: String,
}

/// Map of registry server name (catalog id) → current version, from one registry
/// fetch. The update check compares this against installed servers' recorded
/// versions. Best-effort: any fetch/parse error yields an empty map (no updates
/// reported rather than an error).
pub async fn latest_versions(base_url: Option<&str>) -> std::collections::HashMap<String, String> {
    // Page through the whole registry (following `next_cursor`) so a server that
    // sits beyond the first page can still report an update. Bounded by a page
    // cap so a broken/looping cursor can never spin forever.
    let mut map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_REGISTRY_PAGES {
        let (servers, next) = match fetch_servers(base_url, 200, cursor.as_deref()).await {
            Ok(page) => page,
            Err(_) => break,
        };
        for s in servers {
            let Some(v) = s.version else {
                continue;
            };
            // The registry can list one entry per published version; keep the
            // newest rather than whichever happened to come last.
            let newer = registry_version_is_newer(map.get(&s.name).map(String::as_str), Some(&v));
            if newer {
                map.insert(s.name, v);
            }
        }
        match next {
            Some(c) if !c.is_empty() => cursor = Some(c),
            _ => break,
        }
    }
    map
}

/// Resolve a registry server `id` into a verified [`InstallPlan`]. Prefers a
/// stdio package (the local launch path) and falls back to the first remote URL.
/// Executable packages must prove exact registry ownership before they are baked
/// into a launch command. **This never launches or downloads anything** — it only
/// builds the descriptor.
pub async fn plan_install(base_url: Option<&str>, id: &str) -> Result<InstallPlan> {
    let server = find_server(base_url, id).await?;
    if has_stdio_package(&server) && registry_base(base_url) != DEFAULT_REGISTRY_BASE {
        bail!(
            "refusing executable MCP packages from a non-official registry mirror; use a hosted remote or the official MCP registry"
        );
    }
    verify_and_plan(&server).await
}

/// Verify the package registry metadata before turning a parsed server into a
/// launch command. Remote-only servers do not need package verification.
///
/// This is the boundary that prevents a public instruction/catalog file from
/// becoming `npx`, `uvx`, or `docker` execution. The package manager still owns
/// its normal artifact-integrity checks, but Ryu first requires an exact package
/// name/version and the ownership marker used by the upstream MCP registries.
pub async fn verify_and_plan(server: &ServerJson) -> Result<InstallPlan> {
    let mut verified = server.clone();
    if let Some(package) = server.packages.iter().find(|package| package.is_stdio()) {
        verify_package_metadata(server, package).await?;
        verified.mark_package_provenance_verified();
    }
    plan_from_server(&verified)
}

/// Build an [`InstallPlan`] from a parsed server (shared by [`plan_install`] and
/// the no-network tests).
///
/// `pub(crate)` so sibling Mcp sources (Smithery #465, Ryu-hosted #465) map their
/// own parsed data into a [`ServerJson`] and get the exact same validation
/// (`validate_package_identifier` / `validate_version` / `sanitize_server_name` /
/// `validate_remote_url`) for free — no hand-built launch commands.
pub fn plan_from_server(server: &ServerJson) -> Result<InstallPlan> {
    let server_name = sanitize_server_name(&server.name)?;
    let description = server.description.clone();
    // Recorded on the installed entry so an update check can compare later.
    let version = server.version.clone();
    let catalog_id = server.name.clone();

    // Prefer a stdio package (a local launch). Fall back to a remote URL.
    if let Some(pkg) = server.packages.iter().find(|p| p.is_stdio()) {
        if !server.package_provenance_verified {
            bail!(
                "refusing to install executable MCP package `{}` without verified registry provenance",
                pkg.identifier.as_deref().unwrap_or("<unknown>")
            );
        }
        let entry = stdio_entry_for_package(pkg)?;
        return Ok(InstallPlan {
            server_name,
            entry,
            description,
            version,
            catalog_id,
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
            version,
            catalog_id,
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
                    version,
                    catalog_id,
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
/// exact version or digest. Provenance is checked by [`verify_and_plan`] first.
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
        None => bail!("executable package `{identifier}` must declare an immutable version"),
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
            (
                "npx".to_string(),
                vec!["--ignore-scripts".to_string(), "-y".to_string(), spec],
            )
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
            // OCI tags are mutable. Only an image digest is launchable from a
            // catalog; the package version is metadata, not an OCI tag.
            validate_oci_digest(identifier)?;
            let spec = identifier.to_string();
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
/// key (not executed), but it must not contain the `__` legacy tool-id separator or
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
    let lowered = version.to_ascii_lowercase();
    if matches!(
        lowered.as_str(),
        "latest" | "stable" | "next" | "dev" | "canary" | "*"
    ) || !version.chars().any(|c| c.is_ascii_digit())
    {
        bail!("package version `{version}` is not an immutable version");
    }
    let ok = version
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_'));
    if !ok {
        bail!("package version `{version}` contains disallowed characters");
    }
    Ok(())
}

fn has_stdio_package(server: &ServerJson) -> bool {
    server.packages.iter().any(PackageJson::is_stdio)
}

fn validate_oci_digest(identifier: &str) -> Result<()> {
    let Some((_, digest)) = identifier.rsplit_once("@sha256:") else {
        bail!("OCI package `{identifier}` must use an immutable @sha256 digest instead of a tag");
    };
    if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
        bail!("OCI package `{identifier}` has an invalid sha256 digest");
    }
    Ok(())
}

fn validate_registry_base(package: &PackageJson, expected: &str) -> Result<()> {
    if let Some(base) = package
        .registry_base_url
        .as_deref()
        .map(str::trim)
        .filter(|base| !base.is_empty())
    {
        let normalized = base.trim_end_matches('/');
        if normalized != expected {
            bail!("package registry `{normalized}` is not the verified `{expected}` registry");
        }
    }
    Ok(())
}

fn validate_optional_file_sha256(package: &PackageJson) -> Result<()> {
    let Some(digest) = package.file_sha256.as_deref() else {
        return Ok(());
    };
    if digest.len() != 64
        || !digest
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
    {
        bail!("package file_sha256 must be 64 lowercase hexadecimal characters");
    }
    Ok(())
}

async fn verify_package_metadata(server: &ServerJson, package: &PackageJson) -> Result<()> {
    let identifier = package
        .identifier
        .as_deref()
        .map(str::trim)
        .filter(|identifier| !identifier.is_empty())
        .ok_or_else(|| anyhow!("package has no identifier"))?;
    validate_package_identifier(identifier)?;
    let version = package
        .version
        .as_deref()
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .ok_or_else(|| anyhow!("package `{identifier}` has no immutable version"))?;
    validate_version(version)?;
    validate_optional_file_sha256(package)?;

    let registry = package
        .registry_type
        .as_deref()
        .unwrap_or("npm")
        .to_ascii_lowercase();
    match registry.as_str() {
        "npm" => {
            validate_registry_base(package, NPM_REGISTRY_BASE)?;
            let url = format!(
                "{NPM_REGISTRY_BASE}/{}/{}",
                urlencode(identifier),
                urlencode(version)
            );
            let body = host()
                .guarded_get_bytes(&url)
                .await
                .with_context(|| format!("verifying npm package `{identifier}@{version}`"))?;
            let metadata: Value = serde_json::from_slice(&body)
                .with_context(|| format!("parsing npm metadata for `{identifier}@{version}`"))?;
            let actual_name = metadata.get("name").and_then(Value::as_str);
            let actual_version = metadata.get("version").and_then(Value::as_str);
            let mcp_name = metadata.get("mcpName").and_then(Value::as_str);
            if actual_name != Some(identifier)
                || actual_version != Some(version)
                || mcp_name != Some(server.name.as_str())
            {
                bail!(
                    "npm package `{identifier}@{version}` does not prove ownership of MCP server `{}`",
                    server.name
                );
            }
        }
        "pypi" => {
            validate_registry_base(package, PYPI_REGISTRY_BASE)?;
            let url = format!(
                "{PYPI_REGISTRY_BASE}/pypi/{}/{}/json",
                urlencode(identifier),
                urlencode(version)
            );
            let body = host()
                .guarded_get_bytes(&url)
                .await
                .with_context(|| format!("verifying PyPI package `{identifier}=={version}`"))?;
            let metadata: Value = serde_json::from_slice(&body)
                .with_context(|| format!("parsing PyPI metadata for `{identifier}=={version}`"))?;
            let info = metadata
                .get("info")
                .ok_or_else(|| anyhow!("PyPI metadata has no `info` object"))?;
            let actual_name = info.get("name").and_then(Value::as_str);
            let actual_version = info.get("version").and_then(Value::as_str);
            let description = info
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            if actual_name
                .is_none_or(|name| normalize_python_name(name) != normalize_python_name(identifier))
                || actual_version != Some(version)
                || !has_mcp_name_marker(description, &server.name)
            {
                bail!(
                    "PyPI package `{identifier}=={version}` does not prove ownership of MCP server `{}`",
                    server.name
                );
            }
        }
        "oci" | "docker" => {
            validate_oci_digest(identifier)?;
        }
        other => bail!("unsupported package registry_type `{other}`"),
    }
    Ok(())
}

fn normalize_python_name(name: &str) -> String {
    name.chars()
        .map(|character| match character {
            '_' | '.' => '-',
            other => other.to_ascii_lowercase(),
        })
        .collect()
}

fn has_mcp_name_marker(description: &str, server_name: &str) -> bool {
    let marker = format!("mcp-name: {server_name}");
    let mut offset = 0;
    while let Some(relative) = description[offset..].find(&marker) {
        let start = offset + relative;
        let before_ok = start == 0
            || description[..start]
                .chars()
                .next_back()
                .is_some_and(|character| character.is_whitespace() || character == '<');
        let end = start + marker.len();
        let after_ok = description[end..]
            .chars()
            .next()
            .is_none_or(|character| character.is_whitespace() || character == '<');
        if before_ok && after_ok {
            return true;
        }
        offset = end;
    }
    false
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

    fn verified_server_named(name: &str) -> ServerJson {
        let mut server = server_named(name);
        server.mark_package_provenance_verified();
        server
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
    fn accepts_current_camel_case_package_fields() {
        let json = br#"{
            "servers": [{
                "name": "io.github.acme/files",
                "packages": [{
                    "registryType": "npm",
                    "registryBaseUrl": "https://registry.npmjs.org",
                    "identifier": "@acme/mcp-files",
                    "version": "1.4.0",
                    "fileSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                    "transport": { "type": "stdio" }
                }]
            }]
        }"#;
        let servers = parse_server_list(json).expect("camelCase package fields parse");
        let detail = server_to_detail(&servers[0]);
        assert_eq!(detail["packages"][0]["registry_type"], "npm");
        assert_eq!(
            detail["packages"][0]["registry_base_url"],
            "https://registry.npmjs.org"
        );
        assert_eq!(
            detail["packages"][0]["file_sha256"].as_str().map(str::len),
            Some(64)
        );
    }

    #[test]
    fn stdio_npm_package_builds_npx_entry() {
        let plan = plan_from_server(&verified_server_named("io.github.acme/files")).expect("plan");
        assert_eq!(plan.server_name, "io.github.acme/files");
        assert_eq!(
            plan.entry,
            McpEntryPlan::Stdio {
                command: "npx".to_string(),
                args: vec![
                    "--ignore-scripts".to_string(),
                    "-y".to_string(),
                    "@acme/mcp-files@1.4.0".to_string(),
                ],
            }
        );
    }

    #[test]
    fn stdio_pypi_package_builds_uvx_entry() {
        let plan =
            plan_from_server(&verified_server_named("io.github.acme/py-tool")).expect("plan");
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
    fn registry_versions_keep_the_newest_by_semver() {
        assert!(registry_version_is_newer(Some("1.2.0"), Some("1.10.0")));
        assert!(!registry_version_is_newer(Some("1.10.0"), Some("1.2.0")));
        assert!(!registry_version_is_newer(Some("1.2.0"), None));
        assert!(registry_version_is_newer(None, Some("0.1.0")));
        assert!(!registry_version_is_newer(Some("v2.0.0"), Some("2.0.0")));
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
    fn executable_packages_require_verified_provenance() {
        let error = plan_from_server(&server_named("io.github.acme/files"))
            .expect_err("unverified package must not become a launch command");
        assert!(error.to_string().contains("verified registry provenance"));
    }

    #[test]
    fn rejects_bad_version_and_name() {
        assert!(validate_version("1.2.3").is_ok());
        assert!(validate_version("1.2.3-rc.1").is_ok());
        assert!(validate_version("latest").is_err());
        assert!(validate_version("next").is_err());
        assert!(validate_version("main").is_err());
        assert!(validate_version("1.2.3; rm").is_err());

        assert!(sanitize_server_name("io.github.acme/files").is_ok());
        assert!(sanitize_server_name("bad.name").is_ok());
        assert!(sanitize_server_name("bad__name").is_err());
        assert!(sanitize_server_name("has space").is_err());
        assert!(sanitize_server_name("   ").is_err());
    }

    #[test]
    fn rejects_floating_or_unpinned_oci_packages() {
        let mut server = ServerJson::npm_stdio(
            "io.github.acme/container",
            None,
            "ghcr.io/acme/mcp",
            Some("1.0.0".to_string()),
        );
        server.packages[0].registry_type = Some("oci".to_string());
        server.mark_package_provenance_verified();
        let error = plan_from_server(&server).expect_err("OCI tags are mutable");
        assert!(error.to_string().contains("@sha256"));
    }

    #[test]
    fn package_ownership_markers_are_boundary_aware() {
        assert!(has_mcp_name_marker(
            "<!-- mcp-name: io.acme/weather -->",
            "io.acme/weather"
        ));
        assert!(!has_mcp_name_marker(
            "mcp-name: io.acme/weather.evil",
            "io.acme/weather"
        ));
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
