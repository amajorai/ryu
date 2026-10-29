//! Organization GitHub App installation tokens for cloud environment
//! checkouts.
//!
//! On a registered org- or team-bound node, Core asks the control plane for a
//! short-lived installation token scoped to the environment's repositories:
//! `POST /api/control-plane/gateway/integrations/github/token` with the node's
//! gateway key AND the caller's verified Better Auth JWT, so the control plane
//! re-checks membership and the team/project repository grants itself. The
//! control plane binds that JWT to the live sign-in session it was minted from
//! and the key to this node (`packages/api/src/lib/forwarded-user-jwt.ts`), so
//! a signed-out or revoked session gets no token, and the organization's
//! access policy applies to that session. When
//! no grant exists (or the node is personal, unregistered, or the control
//! plane is unreachable) the caller falls back to the per-owner sealed PAT.
//!
//! The request carries the node's bound project (`RYU_PROJECT_ID`) as
//! `projectId` so project repository grants can match. Cloud environments and
//! tasks carry no project of their own (they run in a disposable workspace,
//! not a mapped local root), so the node binding is the only project context.
//!
//! Tokens are cached in memory only, per node binding (org, scope, team,
//! project), user and repository set, until five minutes before GitHub's
//! expiry, so a rebind never serves a token minted for the previous org.
//! They are never written to the store.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;

use super::ResolvedAuthorization;

const TOKEN_PATH: &str = "/api/control-plane/gateway/integrations/github/token";
/// Refresh this long before GitHub's stated expiry.
const REFRESH_MARGIN_SECS: i64 = 300;
const MAX_CACHE_ENTRIES: usize = 256;
const MAX_REPOSITORIES: usize = 100;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    token: String,
    expires_at: String,
}

#[derive(Clone)]
struct CachedToken {
    token: String,
    expires_at: chrono::DateTime<chrono::Utc>,
}

fn cache() -> &'static Mutex<HashMap<String, CachedToken>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedToken>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default()
    })
}

/// `owner/name` for each environment repository, in order, deduplicated
/// case-insensitively. Entries that are not GitHub `owner/name` are dropped.
pub(super) fn repository_names(repositories: &[String]) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    repositories
        .iter()
        .map(|repository| {
            repository
                .strip_prefix("https://github.com/")
                .unwrap_or(repository)
                .trim_end_matches(".git")
                .to_owned()
        })
        .filter(|repo| super::valid_repository(repo))
        .filter(|repo| seen.insert(repo.to_ascii_lowercase()))
        .take(MAX_REPOSITORIES)
        .collect()
}

/// Whether this node may ask for org tokens at all: registered, not
/// personal, holding a gateway key, with a verified user JWT on the request.
fn eligible(
    scope: Option<crate::sidecar::control_plane::NodeScope>,
    has_gateway_key: bool,
    has_user_jwt: bool,
) -> bool {
    use crate::sidecar::control_plane::NodeScope;
    matches!(scope, Some(NodeScope::Org | NodeScope::Team)) && has_gateway_key && has_user_jwt
}

/// Which node binding a token was minted for. Part of the cache key, so a
/// registration change (another org, team or project) misses the cache.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Binding {
    org_id: String,
    scope: &'static str,
    team_id: Option<String>,
    project_id: Option<String>,
}

impl Binding {
    fn of(
        node: &crate::sidecar::control_plane::RegisteredNode,
        project_id: Option<String>,
    ) -> Self {
        use crate::sidecar::control_plane::NodeScope;
        Self {
            org_id: node.org.id.clone(),
            scope: match node.scope {
                NodeScope::Org => "org",
                NodeScope::Team => "team",
                NodeScope::Personal => "personal",
            },
            team_id: node.team_id.clone(),
            project_id,
        }
    }
}

fn cache_key(binding: &Binding, user_id: &str, repositories: &[String]) -> String {
    let mut names: Vec<String> = repositories
        .iter()
        .map(|repo| repo.to_ascii_lowercase())
        .collect();
    names.sort();
    format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{user_id}\u{1f}{}",
        binding.org_id,
        binding.scope,
        binding.team_id.as_deref().unwrap_or_default(),
        binding.project_id.as_deref().unwrap_or_default(),
        names.join("\u{1f}")
    )
}

/// The token request body: the repositories plus the node's project, when
/// bound, so project grants match.
fn request_body(repositories: &[String], project_id: Option<&str>) -> serde_json::Value {
    let mut body = serde_json::json!({ "repositories": repositories });
    if let Some(project_id) = project_id {
        body["projectId"] = serde_json::Value::from(project_id);
    }
    body
}

fn fresh(entry: &CachedToken, now: chrono::DateTime<chrono::Utc>) -> bool {
    entry.expires_at - chrono::Duration::seconds(REFRESH_MARGIN_SECS) > now
}

fn cached(key: &str, now: chrono::DateTime<chrono::Utc>) -> Option<String> {
    let mut guard = cache().lock().ok()?;
    match guard.get(key) {
        Some(entry) if fresh(entry, now) => Some(entry.token.clone()),
        Some(_) => {
            guard.remove(key);
            None
        }
        None => None,
    }
}

fn remember(key: String, entry: CachedToken, now: chrono::DateTime<chrono::Utc>) {
    if let Ok(mut guard) = cache().lock() {
        if guard.len() >= MAX_CACHE_ENTRIES {
            guard.retain(|_, existing| fresh(existing, now));
            if guard.len() >= MAX_CACHE_ENTRIES {
                guard.clear();
            }
        }
        guard.insert(key, entry);
    }
}

fn forget(key: &str) {
    if let Ok(mut guard) = cache().lock() {
        guard.remove(key);
    }
}

fn parse_response(body: &[u8]) -> Option<CachedToken> {
    let parsed: TokenResponse = serde_json::from_slice(body).ok()?;
    if parsed.token.is_empty() || parsed.token.len() > 4096 {
        return None;
    }
    let expires_at = chrono::DateTime::parse_from_rfc3339(&parsed.expires_at)
        .ok()?
        .with_timezone(&chrono::Utc);
    Some(CachedToken {
        token: parsed.token,
        expires_at,
    })
}

/// An org installation token for `repositories` (`owner/name`), or `None`
/// when the caller should fall back to the per-owner PAT.
pub(super) async fn token_for(
    auth: &ResolvedAuthorization,
    repositories: &[String],
) -> Option<String> {
    if repositories.is_empty() {
        return None;
    }
    let node = crate::sidecar::control_plane::registered_node();
    let gateway_key = crate::sidecar::control_plane::gateway_key();
    let jwt = auth.verified_user_jwt.as_deref();
    if !eligible(
        node.as_ref().map(|node| node.scope),
        gateway_key.is_some(),
        jwt.is_some(),
    ) {
        return None;
    }
    let (gateway_key, jwt, node) = (gateway_key?, jwt?, node?);
    let user_id = auth.caller.as_ref()?.user_id.clone();
    let binding = Binding::of(&node, crate::sidecar::control_plane::node_project_id());
    let key = cache_key(&binding, &user_id, repositories);
    let now = chrono::Utc::now();
    if let Some(token) = cached(&key, now) {
        return Some(token);
    }
    let base = crate::sidecar::control_plane::control_plane_url();
    let response = http()
        .post(format!("{}{TOKEN_PATH}", base.trim_end_matches('/')))
        .header("x-gateway-key", gateway_key)
        .bearer_auth(jwt)
        .json(&request_body(repositories, binding.project_id.as_deref()))
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            tracing::debug!("org GitHub token request failed: {error}");
            return None;
        }
    };
    if !response.status().is_success() {
        // A refusal (no grant, lost membership, revoked key) or an outage:
        // never keep serving an older token for this key.
        tracing::debug!("org GitHub token request returned {}", response.status());
        forget(&key);
        return None;
    }
    let body = response.bytes().await.ok()?;
    if body.len() > 65_536 {
        return None;
    }
    let entry = parse_response(&body)?;
    let token = entry.token.clone();
    if fresh(&entry, now) {
        remember(key, entry, now);
    }
    Some(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::control_plane::NodeScope;

    #[test]
    fn only_registered_shared_nodes_with_a_verified_user_are_eligible() {
        assert!(eligible(Some(NodeScope::Org), true, true));
        assert!(eligible(Some(NodeScope::Team), true, true));
        assert!(!eligible(Some(NodeScope::Personal), true, true));
        assert!(!eligible(None, true, true));
        assert!(!eligible(Some(NodeScope::Org), false, true));
        assert!(!eligible(Some(NodeScope::Org), true, false));
    }

    #[test]
    fn repository_names_normalize_and_dedupe() {
        let names = repository_names(&[
            "https://github.com/acme/api.git".into(),
            "acme/API".into(),
            "acme/web".into(),
            "not a repo".into(),
        ]);
        assert_eq!(names, vec!["acme/api".to_owned(), "acme/web".to_owned()]);
    }

    fn binding(org: &str, team: Option<&str>, project: Option<&str>) -> Binding {
        Binding {
            org_id: org.to_owned(),
            scope: if team.is_some() { "team" } else { "org" },
            team_id: team.map(str::to_owned),
            project_id: project.map(str::to_owned),
        }
    }

    #[test]
    fn cache_key_is_order_and_case_insensitive_per_user() {
        let org = binding("org_a", None, None);
        let a = cache_key(&org, "u1", &["acme/web".into(), "acme/API".into()]);
        let b = cache_key(&org, "u1", &["acme/api".into(), "acme/web".into()]);
        assert_eq!(a, b);
        assert_ne!(
            a,
            cache_key(&org, "u2", &["acme/api".into(), "acme/web".into()])
        );
    }

    #[test]
    fn cache_key_changes_with_the_node_binding() {
        let repos = vec!["acme/api".to_owned()];
        let base = cache_key(&binding("org_a", None, None), "u1", &repos);
        for other in [
            binding("org_b", None, None),
            binding("org_a", Some("team-1"), None),
            binding("org_a", None, Some("project-1")),
        ] {
            assert_ne!(base, cache_key(&other, "u1", &repos), "{other:?}");
        }
        // A token cached under org A is not served after a rebind to org B.
        let now = chrono::Utc::now();
        remember(
            base.clone(),
            CachedToken {
                token: "inst-token-org-a".into(),
                expires_at: now + chrono::Duration::seconds(3600),
            },
            now,
        );
        assert_eq!(cached(&base, now).as_deref(), Some("inst-token-org-a"));
        let rebound = cache_key(&binding("org_b", None, None), "u1", &repos);
        assert_eq!(cached(&rebound, now), None);
    }

    #[test]
    fn token_request_carries_the_bound_project() {
        let repos = vec!["acme/api".to_owned()];
        assert_eq!(
            request_body(&repos, Some("project-1")),
            serde_json::json!({ "repositories": ["acme/api"], "projectId": "project-1" })
        );
        assert_eq!(
            request_body(&repos, None),
            serde_json::json!({ "repositories": ["acme/api"] })
        );
    }

    #[test]
    fn cached_tokens_expire_before_github_does() {
        let now = chrono::Utc::now();
        let key = cache_key(
            &binding("org_cache_test", None, None),
            "cache-test-user",
            &["acme/api".into()],
        );
        remember(
            key.clone(),
            CachedToken {
                token: "inst-token-cached".into(),
                expires_at: now + chrono::Duration::seconds(3600),
            },
            now,
        );
        assert_eq!(cached(&key, now).as_deref(), Some("inst-token-cached"));
        let near_expiry = now + chrono::Duration::seconds(3600 - REFRESH_MARGIN_SECS + 1);
        assert_eq!(cached(&key, near_expiry), None);
        // The stale entry is dropped, not served later.
        assert_eq!(cached(&key, now), None);
    }

    #[test]
    fn parses_only_well_formed_token_responses() {
        let parsed = parse_response(
            br#"{"token":"inst-token-x","expiresAt":"2030-01-01T00:00:00Z","repositories":["acme/api"]}"#,
        )
        .expect("valid response");
        assert_eq!(parsed.token, "inst-token-x");
        assert!(parse_response(br#"{"token":"","expiresAt":"2030-01-01T00:00:00Z"}"#).is_none());
        assert!(parse_response(br#"{"token":"inst-token-x","expiresAt":"tomorrow"}"#).is_none());
        assert!(parse_response(b"not json").is_none());
    }
}
