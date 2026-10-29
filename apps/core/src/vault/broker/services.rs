//! Broker services: which hosts get which credentials.
//!
//! A service binds a host pattern (`api.example.com` or `*.example.com`), an
//! optional port, and a path prefix in one environment to an auth rule and a
//! list of placeholder substitutions. Credentials are `secret:` references
//! resolved at request time; a service record never holds a value, so the
//! table is plaintext metadata.
//!
//! Matching picks the most specific service: an exact host beats a wildcard
//! (a longer wildcard suffix beats a shorter one), an explicit port beats any
//! port, and a longer path prefix beats a shorter one. Two equally specific
//! matches are ambiguous and the request is refused (409) rather than guessed.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::substitute::{self, Surface};
use crate::vault::{now_millis, VaultError};

/// Most substitutions per service.
pub const MAX_SUBSTITUTIONS: usize = 16;
/// Most custom headers per service.
pub const MAX_CUSTOM_HEADERS: usize = 8;
/// Largest agent-notes markdown per service or environment.
pub const MAX_NOTES_BYTES: usize = 64 * 1024;
const MAX_HOST_LEN: usize = 253;
const MAX_PATH_PREFIX_LEN: usize = 512;
const MAX_DESCRIPTION_LEN: usize = 512;

/// How the broker authenticates a matched request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServiceAuth {
    /// `Authorization: Bearer <token>`.
    Bearer { token: String },
    /// `Authorization: Basic base64(username:password)`; the username may be a
    /// literal or a reference.
    Basic { username: String, password: String },
    /// `<header>: <prefix><value>`.
    ApiKey {
        header: String,
        value: String,
        #[serde(default)]
        prefix: String,
    },
    /// Header templates with `{{secret:REF}}` tokens.
    Custom { headers: BTreeMap<String, String> },
    /// No injection; the request is forwarded as sent (placeholders still
    /// substitute).
    Passthrough,
}

impl ServiceAuth {
    /// Short kind name for listings and discovery.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Bearer { .. } => "bearer",
            Self::Basic { .. } => "basic",
            Self::ApiKey { .. } => "api_key",
            Self::Custom { .. } => "custom",
            Self::Passthrough => "passthrough",
        }
    }

    /// Every `secret:` reference the rule uses.
    pub fn refs(&self) -> Vec<String> {
        match self {
            Self::Bearer { token } => vec![token.clone()],
            Self::Basic { username, password } => {
                let mut refs = vec![password.clone()];
                if substitute::is_credential_ref(username) {
                    refs.push(username.clone());
                }
                refs
            }
            Self::ApiKey { value, .. } => vec![value.clone()],
            Self::Custom { headers } => headers
                .values()
                .flat_map(|template| substitute::parse_template(template).unwrap_or_default())
                .filter_map(|segment| match segment {
                    substitute::Segment::Ref(reference) => Some(reference),
                    substitute::Segment::Literal(_) => None,
                })
                .collect(),
            Self::Passthrough => Vec::new(),
        }
    }

    /// Replace every reference that is a key of `map` with its value.
    pub fn replace_refs(&mut self, map: &BTreeMap<String, String>) {
        let swap = |reference: &mut String| {
            if let Some(replacement) = map.get(reference.as_str()) {
                reference.clone_from(replacement);
            }
        };
        match self {
            Self::Bearer { token } => swap(token),
            Self::Basic { username, password } => {
                swap(password);
                if substitute::is_credential_ref(username) {
                    swap(username);
                }
            }
            Self::ApiKey { value, .. } => swap(value),
            Self::Custom { headers } => {
                for template in headers.values_mut() {
                    let Ok(segments) = substitute::parse_template(template) else {
                        continue;
                    };
                    if !segments.iter().any(|segment| {
                        matches!(segment, substitute::Segment::Ref(r) if map.contains_key(r))
                    }) {
                        continue;
                    }
                    *template = segments
                        .into_iter()
                        .map(|segment| match segment {
                            substitute::Segment::Literal(text) => text,
                            substitute::Segment::Ref(reference) => {
                                format!("{{{{{}}}}}", map.get(&reference).unwrap_or(&reference))
                            }
                        })
                        .collect();
                }
            }
            Self::Passthrough => {}
        }
    }

    /// Header names this rule sets (lowercase).
    pub fn header_names(&self) -> Vec<String> {
        match self {
            Self::Bearer { .. } | Self::Basic { .. } => vec!["authorization".to_owned()],
            Self::ApiKey { header, .. } => vec![header.to_ascii_lowercase()],
            Self::Custom { headers } => headers.keys().map(|h| h.to_ascii_lowercase()).collect(),
            Self::Passthrough => Vec::new(),
        }
    }

    fn validate(&self) -> Result<()> {
        match self {
            Self::Bearer { token } => substitute::validate_ref(token),
            Self::Basic { username, password } => {
                substitute::validate_ref(password)?;
                if substitute::is_credential_ref(username) {
                    substitute::validate_ref(username)
                } else if username.contains(':') || !substitute::is_safe_header_value(username) {
                    bail!("basic username must not contain `:` or control characters")
                } else {
                    Ok(())
                }
            }
            Self::ApiKey {
                header,
                value,
                prefix,
            } => {
                validate_header_name(header)?;
                if !substitute::is_safe_header_value(prefix) || prefix.len() > 64 {
                    bail!("api key prefix is invalid");
                }
                substitute::validate_ref(value)
            }
            Self::Custom { headers } => {
                if headers.is_empty() || headers.len() > MAX_CUSTOM_HEADERS {
                    bail!("custom auth needs 1-{MAX_CUSTOM_HEADERS} headers");
                }
                for (name, template) in headers {
                    validate_header_name(name)?;
                    if !substitute::is_safe_header_value(template) || template.len() > 1024 {
                        bail!("header template for `{name}` is invalid");
                    }
                    substitute::parse_template(template)?;
                }
                Ok(())
            }
            Self::Passthrough => Ok(()),
        }
    }
}

/// Headers the broker owns or that are connection-scoped; a rule cannot set
/// them.
pub const RESERVED_HEADERS: &[&str] = &[
    "host",
    "connection",
    "proxy-authorization",
    "proxy-authenticate",
    "proxy-connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
];

fn validate_header_name(name: &str) -> Result<()> {
    let lower = name.to_ascii_lowercase();
    if hyper::header::HeaderName::from_bytes(lower.as_bytes()).is_err()
        || RESERVED_HEADERS.contains(&lower.as_str())
    {
        bail!("header `{name}` cannot be set by a broker service");
    }
    Ok(())
}

/// A placeholder the broker replaces with a credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Substitution {
    pub placeholder: String,
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(rename = "in", default = "substitute::default_surfaces")]
    pub surfaces: Vec<Surface>,
}

/// A service as written by an operator (or proposed by an agent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInput {
    pub name: String,
    #[serde(default = "default_environment")]
    pub environment: String,
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default = "default_path_prefix")]
    pub path_prefix: String,
    pub auth: ServiceAuth,
    #[serde(default)]
    pub substitutions: Vec<Substitution>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Inject credentials over plain `http://`. Off by default so a credential
    /// never crosses the network unencrypted by accident.
    #[serde(default)]
    pub allow_insecure_http: bool,
    #[serde(default)]
    pub description: String,
    /// Markdown instructions shown to agents through discovery.
    #[serde(default)]
    pub notes: String,
}

fn default_environment() -> String {
    crate::vault::DEFAULT_ENVIRONMENT.to_owned()
}

fn default_path_prefix() -> String {
    "/".to_owned()
}

fn default_true() -> bool {
    true
}

/// A stored service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerService {
    #[serde(flatten)]
    pub input: ServiceInput,
    pub created_at: i64,
    pub updated_at: i64,
}

impl BrokerService {
    pub fn name(&self) -> &str {
        &self.input.name
    }

    /// Every `secret:` reference this service uses (auth and substitutions).
    pub fn refs(&self) -> Vec<String> {
        self.input.refs()
    }
}

/// Whether `host` is a valid host pattern: a lowercase DNS name or IPv4
/// literal, optionally prefixed by one `*.` wildcard label.
pub fn is_valid_host_pattern(host: &str) -> bool {
    let bare = host.strip_prefix("*.").unwrap_or(host);
    !bare.is_empty()
        && host.len() <= MAX_HOST_LEN
        && (bare != host || !host.contains('*'))
        && bare.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
        && (bare == host || bare.contains('.'))
}

fn is_valid_path_prefix(prefix: &str) -> bool {
    prefix.starts_with('/')
        && prefix.len() <= MAX_PATH_PREFIX_LEN
        && !prefix
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '?' || c == '#')
}

impl ServiceInput {
    /// Every `secret:` reference this service uses (auth and substitutions).
    pub fn refs(&self) -> Vec<String> {
        let mut refs = self.auth.refs();
        refs.extend(self.substitutions.iter().map(|s| s.reference.clone()));
        refs.sort();
        refs.dedup();
        refs
    }

    /// Replace every reference (auth and substitutions) that is a key of
    /// `map` with its value.
    pub fn replace_refs(&mut self, map: &BTreeMap<String, String>) {
        self.auth.replace_refs(map);
        for substitution in &mut self.substitutions {
            if let Some(replacement) = map.get(&substitution.reference) {
                substitution.reference.clone_from(replacement);
            }
        }
    }

    /// Normalize and validate in place.
    pub fn normalize(mut self) -> Result<Self> {
        let invalid = |message: String| anyhow::Error::from(VaultError::Invalid(message));
        if !crate::vault::transit::is_valid_key_name(&self.name) {
            return Err(invalid(
                "service name must be 1-64 characters of [a-z0-9_-]".into(),
            ));
        }
        if !crate::vault::is_valid_environment(&self.environment) {
            return Err(invalid("invalid environment".into()));
        }
        self.host = self.host.trim().trim_end_matches('.').to_ascii_lowercase();
        if !is_valid_host_pattern(&self.host) {
            return Err(invalid(format!("invalid host pattern `{}`", self.host)));
        }
        if self.port == Some(0) {
            return Err(invalid("port must be 1-65535".into()));
        }
        if self.path_prefix.trim().is_empty() {
            self.path_prefix = default_path_prefix();
        }
        if !is_valid_path_prefix(&self.path_prefix) {
            return Err(invalid("pathPrefix must start with `/`".into()));
        }
        self.auth
            .validate()
            .map_err(|error| invalid(format!("{error:#}")))?;
        if self.substitutions.len() > MAX_SUBSTITUTIONS {
            return Err(invalid(format!(
                "at most {MAX_SUBSTITUTIONS} substitutions"
            )));
        }
        let mut seen = Vec::new();
        for substitution in &mut self.substitutions {
            if !substitute::is_valid_placeholder(&substitution.placeholder) {
                return Err(invalid(format!(
                    "placeholder `{}` must look like __NAME__",
                    substitution.placeholder
                )));
            }
            if seen.contains(&substitution.placeholder) {
                return Err(invalid("duplicate placeholder".into()));
            }
            seen.push(substitution.placeholder.clone());
            substitute::validate_ref(&substitution.reference)
                .map_err(|error| invalid(format!("{error:#}")))?;
            substitution.surfaces.sort();
            substitution.surfaces.dedup();
            if substitution.surfaces.is_empty() {
                return Err(invalid("a substitution needs at least one surface".into()));
            }
        }
        if self.description.len() > MAX_DESCRIPTION_LEN {
            return Err(invalid("description is too long".into()));
        }
        if self.notes.len() > MAX_NOTES_BYTES {
            return Err(invalid("notes exceed 64 KiB".into()));
        }
        Ok(self)
    }
}

/// Create the services table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_broker_services (
             name        TEXT PRIMARY KEY,
             environment TEXT NOT NULL,
             host        TEXT NOT NULL,
             port        INTEGER NOT NULL DEFAULT 0,
             path_prefix TEXT NOT NULL,
             record      TEXT NOT NULL,
             created_at  INTEGER NOT NULL,
             updated_at  INTEGER NOT NULL,
             UNIQUE (environment, host, port, path_prefix)
         );",
    )
    .context("initializing broker services schema")
}

fn row_to_service(record: String) -> rusqlite::Result<BrokerService> {
    serde_json::from_str(&record).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

/// List services, optionally in one environment, ordered by name.
pub fn list(conn: &Connection, environment: Option<&str>) -> Result<Vec<BrokerService>> {
    let mut stmt = conn.prepare(
        "SELECT record FROM vault_broker_services
         WHERE ?1 IS NULL OR environment = ?1 ORDER BY name",
    )?;
    let rows = stmt.query_map(params![environment], |row| row_to_service(row.get(0)?))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// One service by name.
pub fn get(conn: &Connection, name: &str) -> Result<Option<BrokerService>> {
    Ok(conn
        .query_row(
            "SELECT record FROM vault_broker_services WHERE name = ?1",
            params![name],
            |row| row_to_service(row.get(0)?),
        )
        .optional()?)
}

fn conflict_on_unique(error: rusqlite::Error, name: &str) -> anyhow::Error {
    if let rusqlite::Error::SqliteFailure(code, _) = &error {
        if code.code == rusqlite::ErrorCode::ConstraintViolation {
            return VaultError::Conflict(format!(
                "a service named `{name}` or with the same host, port, and path prefix exists"
            ))
            .into();
        }
    }
    error.into()
}

/// Insert a new (already normalized) service.
pub fn insert(conn: &Connection, input: ServiceInput) -> Result<BrokerService> {
    let now = now_millis();
    let service = BrokerService {
        input,
        created_at: now,
        updated_at: now,
    };
    let input = &service.input;
    conn.execute(
        "INSERT INTO vault_broker_services
            (name, environment, host, port, path_prefix, record, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            input.name,
            input.environment,
            input.host,
            input.port.unwrap_or(0),
            input.path_prefix,
            serde_json::to_string(&service)?,
            now
        ],
    )
    .map_err(|error| conflict_on_unique(error, &input.name))?;
    Ok(service)
}

/// Replace an existing service (the name is the key and cannot change).
pub fn update(conn: &Connection, input: ServiceInput) -> Result<BrokerService> {
    let existing = get(conn, &input.name)?
        .ok_or_else(|| VaultError::NotFound(format!("broker service `{}`", input.name)))?;
    let service = BrokerService {
        input,
        created_at: existing.created_at,
        updated_at: now_millis(),
    };
    let input = &service.input;
    conn.execute(
        "UPDATE vault_broker_services
         SET environment = ?2, host = ?3, port = ?4, path_prefix = ?5, record = ?6,
             updated_at = ?7
         WHERE name = ?1",
        params![
            input.name,
            input.environment,
            input.host,
            input.port.unwrap_or(0),
            input.path_prefix,
            serde_json::to_string(&service)?,
            service.updated_at
        ],
    )
    .map_err(|error| conflict_on_unique(error, &input.name))?;
    Ok(service)
}

/// Delete a service. Returns whether it existed.
pub fn delete(conn: &Connection, name: &str) -> Result<bool> {
    Ok(conn.execute(
        "DELETE FROM vault_broker_services WHERE name = ?1",
        params![name],
    )? > 0)
}

/// Services that use a `secret:` reference (for "where is this credential
/// used" lookups before rotating or deleting a value).
pub fn usage(conn: &Connection, reference: &str) -> Result<Vec<BrokerService>> {
    Ok(list(conn, None)?
        .into_iter()
        .filter(|service| service.refs().iter().any(|r| r == reference))
        .collect())
}

// ── Matching ──────────────────────────────────────────────────────────────

/// Result of matching a request against an environment's services.
#[derive(Debug, PartialEq, Eq)]
pub enum MatchOutcome<'a> {
    Matched(&'a BrokerService),
    Disabled(&'a BrokerService),
    /// Equally specific services; the names are returned for the error.
    Ambiguous(Vec<String>),
    Unmatched,
}

/// Specificity of a host pattern against `host`: `(exact, wildcard suffix
/// length)`, or `None` when it does not match.
fn host_rank(pattern: &str, host: &str) -> Option<(u8, usize)> {
    if pattern == host {
        return Some((1, pattern.len()));
    }
    let suffix = pattern.strip_prefix("*.")?;
    let matches = host.len() > suffix.len() + 1
        && host.ends_with(suffix)
        && host.as_bytes()[host.len() - suffix.len() - 1] == b'.';
    matches.then_some((0, suffix.len()))
}

/// Whether a host pattern (`api.example.com` or `*.example.com`) covers
/// `host`. Card merchant allowlists use the same matcher as services.
pub fn host_matches(pattern: &str, host: &str) -> bool {
    host_rank(pattern, host).is_some()
}

/// Whether a request path could be rewritten by URL normalization before it
/// reaches upstream: a `.` or `..` segment, raw or percent-encoded (`%2e`), or
/// a backslash (a path separator for http URLs). The matcher compares the
/// path as sent while the upstream URL is normalized, so such a path could
/// match `/repos/acme` here and reach `/user/keys` upstream; the proxy
/// refuses it instead.
pub fn has_dot_segment(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    if lower.contains('\\') || lower.contains("%5c") {
        return true;
    }
    lower.split('/').any(|segment| {
        let decoded = segment.replace("%2e", ".");
        decoded == "." || decoded == ".."
    })
}

fn path_matches(prefix: &str, path: &str) -> bool {
    prefix == "/"
        || path == prefix
        || (path.starts_with(prefix)
            && (prefix.ends_with('/') || path.as_bytes().get(prefix.len()) == Some(&b'/')))
}

type Rank = (u8, usize, u8, usize);

fn rank(service: &BrokerService, host: &str, port: u16, path: Option<&str>) -> Option<Rank> {
    let input = &service.input;
    let (exact, suffix) = host_rank(&input.host, host)?;
    let port_rank = match input.port {
        Some(p) if p == port => 1,
        Some(_) => return None,
        None => 0,
    };
    let prefix_len = match path {
        Some(path) if !path_matches(&input.path_prefix, path) => return None,
        _ => input.path_prefix.len(),
    };
    Some((exact, suffix, port_rank, prefix_len))
}

/// Pick the most specific service for a request.
pub fn match_request<'a>(
    services: &'a [BrokerService],
    host: &str,
    port: u16,
    path: &str,
) -> MatchOutcome<'a> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let mut best: Option<Rank> = None;
    let mut winners: Vec<&BrokerService> = Vec::new();
    for service in services {
        let Some(rank) = rank(service, &host, port, Some(path)) else {
            continue;
        };
        match best {
            Some(current) if rank < current => {}
            Some(current) if rank == current => winners.push(service),
            _ => {
                best = Some(rank);
                winners = vec![service];
            }
        }
    }
    match winners.as_slice() {
        [] => MatchOutcome::Unmatched,
        [one] if one.input.enabled => MatchOutcome::Matched(one),
        [one] => MatchOutcome::Disabled(one),
        many => MatchOutcome::Ambiguous(many.iter().map(|s| s.name().to_owned()).collect()),
    }
}

/// Whether any service (enabled or not) covers `host:port` on some path. Used
/// at CONNECT time, before the path is known, to decide between interception
/// and the unmatched-host policy.
pub fn host_is_brokered(services: &[BrokerService], host: &str, port: u16) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    services
        .iter()
        .any(|service| rank(service, &host, port, None).is_some())
}

#[cfg(test)]
pub(crate) fn test_service(
    name: &str,
    host: &str,
    port: Option<u16>,
    prefix: &str,
) -> ServiceInput {
    ServiceInput {
        name: name.to_owned(),
        environment: "default".to_owned(),
        host: host.to_owned(),
        port,
        path_prefix: prefix.to_owned(),
        auth: ServiceAuth::Bearer {
            token: "secret:API_TOKEN".to_owned(),
        },
        substitutions: Vec::new(),
        enabled: true,
        allow_insecure_http: false,
        description: String::new(),
        notes: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(input: ServiceInput) -> BrokerService {
        BrokerService {
            input: input.normalize().unwrap(),
            created_at: 0,
            updated_at: 0,
        }
    }

    fn name<'a>(outcome: MatchOutcome<'a>) -> &'a str {
        match outcome {
            MatchOutcome::Matched(service) => service.name(),
            other => panic!("expected a match, got {other:?}"),
        }
    }

    #[test]
    fn host_patterns_are_validated() {
        for ok in ["api.openai.com", "*.example.com", "localhost", "10.0.0.1"] {
            assert!(is_valid_host_pattern(ok), "{ok}");
        }
        for bad in [
            "", "*", "*.com", "a.*.com", "API.com", "a..b", "-a.com", "a b.com", "*.*.x.y",
        ] {
            assert!(!is_valid_host_pattern(bad), "{bad}");
        }
    }

    #[test]
    fn exact_beats_wildcard_beats_shorter_wildcard() {
        let services = vec![
            stored(test_service("wild", "*.example.com", None, "/")),
            stored(test_service("deep", "*.api.example.com", None, "/")),
            stored(test_service("exact", "v1.api.example.com", None, "/")),
        ];
        assert_eq!(
            name(match_request(&services, "v1.api.example.com", 443, "/")),
            "exact"
        );
        assert_eq!(
            name(match_request(&services, "v2.api.example.com", 443, "/")),
            "deep"
        );
        assert_eq!(
            name(match_request(&services, "x.example.com", 443, "/")),
            "wild"
        );
        assert_eq!(
            match_request(&services, "example.com", 443, "/"),
            MatchOutcome::Unmatched
        );
        assert_eq!(
            match_request(&services, "evilexample.com", 443, "/"),
            MatchOutcome::Unmatched
        );
    }

    #[test]
    fn port_and_longest_path_prefix_break_ties() {
        let services = vec![
            stored(test_service("any", "api.example.com", None, "/")),
            stored(test_service("port", "api.example.com", Some(8443), "/")),
            stored(test_service("v2", "api.example.com", None, "/v2")),
        ];
        assert_eq!(
            name(match_request(&services, "api.example.com", 8443, "/v1")),
            "port"
        );
        assert_eq!(
            name(match_request(&services, "api.example.com", 443, "/v2/x")),
            "v2"
        );
        assert_eq!(
            name(match_request(&services, "api.example.com", 443, "/v2")),
            "v2"
        );
        assert_eq!(
            name(match_request(&services, "api.example.com", 443, "/v20")),
            "any"
        );
        assert_eq!(
            name(match_request(&services, "API.example.com.", 443, "/")),
            "any"
        );
    }

    #[test]
    fn disabled_and_ambiguous_matches_are_reported() {
        let mut disabled = test_service("off", "api.example.com", None, "/");
        disabled.enabled = false;
        let services = vec![stored(disabled)];
        assert!(matches!(
            match_request(&services, "api.example.com", 443, "/"),
            MatchOutcome::Disabled(_)
        ));
        let mut b = test_service("b", "api.example.com", None, "/");
        b.environment = "default".into();
        let services = vec![
            stored(test_service("a", "api.example.com", None, "/")),
            stored(b),
        ];
        assert_eq!(
            match_request(&services, "api.example.com", 443, "/"),
            MatchOutcome::Ambiguous(vec!["a".into(), "b".into()])
        );
    }

    #[test]
    fn dot_segments_are_detected_raw_and_encoded() {
        for bad in [
            "/repos/acme/../../user/keys",
            "/repos/acme/./x",
            "/repos/acme/%2e%2e/user",
            "/repos/acme/%2E%2e/user",
            "/repos/acme/.%2E/user",
            "/repos/acme/%2e/x",
            "/repos/acme/..",
            "/repos/acme\\..\\user",
            "/repos/acme%5c..%5cuser",
        ] {
            assert!(has_dot_segment(bad), "{bad}");
        }
        for ok in [
            "/",
            "/repos/acme",
            "/a/.well-known/x",
            "/a/..b/c",
            "/a/b..",
            "/v1/file.txt",
        ] {
            assert!(!has_dot_segment(ok), "{ok}");
        }
    }

    #[test]
    fn connect_time_checks_ignore_the_path() {
        let services = vec![stored(test_service("v2", "api.example.com", None, "/v2"))];
        assert!(host_is_brokered(&services, "api.example.com", 443));
        assert!(!host_is_brokered(&services, "other.example.com", 443));
    }

    #[test]
    fn inputs_validate_auth_and_substitutions() {
        let mut input = test_service("svc", "API.Example.com", None, "");
        input.substitutions = vec![Substitution {
            placeholder: "__KEY__".into(),
            reference: "secret:prod:/db/KEY".into(),
            surfaces: vec![Surface::Path, Surface::Header, Surface::Path],
        }];
        let normalized = input.clone().normalize().unwrap();
        assert_eq!(normalized.host, "api.example.com");
        assert_eq!(normalized.path_prefix, "/");
        assert_eq!(
            normalized.substitutions[0].surfaces,
            vec![Surface::Header, Surface::Path]
        );

        let mut bad = input.clone();
        bad.auth = ServiceAuth::Bearer {
            token: "OPENAI_KEY".into(),
        };
        assert!(bad.normalize().is_err());
        let mut bad = input.clone();
        bad.auth = ServiceAuth::ApiKey {
            header: "Host".into(),
            value: "secret:K".into(),
            prefix: String::new(),
        };
        assert!(bad.normalize().is_err());
        let mut bad = input.clone();
        bad.substitutions[0].placeholder = "KEY".into();
        assert!(bad.normalize().is_err());
        let mut bad = input;
        bad.name = "Bad Name".into();
        assert!(bad.normalize().is_err());
    }

    #[test]
    fn refs_cover_auth_and_substitutions() {
        let mut input = test_service("svc", "api.example.com", None, "/");
        input.auth = ServiceAuth::Custom {
            headers: [("x-sig".to_owned(), "{{secret:A}}:{{secret:B}}".to_owned())].into(),
        };
        input.substitutions = vec![Substitution {
            placeholder: "__C__".into(),
            reference: "secret:C".into(),
            surfaces: vec![Surface::Query],
        }];
        let service = stored(input);
        assert_eq!(service.refs(), vec!["secret:A", "secret:B", "secret:C"]);
    }

    #[tokio::test]
    async fn crud_round_trips_and_rejects_duplicates() {
        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        let conn = store.conn.lock().await;
        let input = test_service("svc", "api.example.com", None, "/")
            .normalize()
            .unwrap();
        insert(&conn, input.clone()).unwrap();
        let error = insert(&conn, input.clone()).unwrap_err();
        assert_eq!(
            error.downcast_ref::<VaultError>().unwrap().code(),
            "vault_conflict"
        );
        let mut same_route = test_service("other", "api.example.com", None, "/");
        same_route = same_route.normalize().unwrap();
        assert!(insert(&conn, same_route).is_err());
        let mut changed = input.clone();
        changed.enabled = false;
        update(&conn, changed).unwrap();
        assert!(!get(&conn, "svc").unwrap().unwrap().input.enabled);
        assert_eq!(usage(&conn, "secret:API_TOKEN").unwrap().len(), 1);
        assert_eq!(list(&conn, Some("prod")).unwrap().len(), 0);
        assert!(delete(&conn, "svc").unwrap());
        assert!(!delete(&conn, "svc").unwrap());
    }
}
