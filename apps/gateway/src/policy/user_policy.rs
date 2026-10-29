//! Per-caller model policy for shared nodes.
//!
//! `/gateway/resolve` only knows the gateway credential, so its policy carries
//! the organization/team/project (or personal owner) layers and never the user
//! layer of whoever is calling a shared node. When the gateway knows the caller
//! (a user JWT verified against the control plane, or a trusted forwarder such
//! as the node's own Core relaying its verified caller), it asks the control
//! plane for that caller's effective policy (`GET /gateway/tool-policy`) and
//! enforces the caller's model, provider, region, guardrail, and tool rules for
//! the request.
//!
//! The control plane resolves those rules from the same credential scope plus
//! the caller's user layer, and layers only ever tighten, so the caller's
//! result is never wider than the credential's policy at fetch time. Because a
//! cached result can outlive a narrowed credential policy, it is intersected
//! with the current credential policy on every request (see
//! [`policy_for_caller`]) rather than replacing it. An outage (transport error,
//! any status other than 400/401/403, or an undecodable body) keeps the last
//! result for that caller; an authoritative refusal (400 for a caller who is no
//! longer a member, 401 for a dead credential, 403 for an out-of-scope caller or
//! project) drops it, so the caller is denied from the next request rather than
//! for the rest of their token's lifetime. A caller who was never resolved is
//! denied rather than served the credential-wide policy.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;

use super::EffectivePolicy;

/// How long one caller's rules are served before they are refreshed.
const USER_POLICY_TTL: Duration = Duration::from_secs(60);
/// Bounded cache: the oldest entry is evicted past this size.
const MAX_ENTRIES: usize = 4096;
const ENV_CONTROL_PLANE_URL: &str = "CONTROL_PLANE_URL";
const ENV_GATEWAY_KEY: &str = "GATEWAY_KEY";
const ENV_PROJECT_ID: &str = "RYU_PROJECT_ID";

/// The model-routing and tool slice of one caller's effective policy.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPolicyRules {
    #[serde(default)]
    pub approved_models: Vec<String>,
    #[serde(default)]
    pub approved_providers: Vec<String>,
    #[serde(default)]
    pub allowed_regions: Vec<String>,
    #[serde(default)]
    pub locked_guardrails: Vec<String>,
    #[serde(default, deserialize_with = "crate::org_limits::null_as_default")]
    pub allowed_tools: Vec<String>,
    #[serde(default, deserialize_with = "crate::org_limits::null_as_default")]
    pub denied_tools: Vec<String>,
    #[serde(default, deserialize_with = "crate::org_limits::null_as_default")]
    pub allowed_mcp_servers: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserPolicyResponse {
    #[serde(default)]
    policy: UserPolicyBody,
}

#[derive(Debug, Default, Deserialize)]
struct UserPolicyBody {
    #[serde(default)]
    rules: UserPolicyRules,
}

struct Entry {
    at: Instant,
    rules: Arc<UserPolicyRules>,
}

/// Why a caller-policy refresh produced no rules.
#[derive(Debug)]
enum FetchError {
    /// The control plane answered and refused this caller (or this
    /// credential/scope). The last result must not be reused.
    Refused(reqwest::StatusCode),
    /// The control plane could not answer; the last result may be reused.
    Unavailable(&'static str),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(status) => write!(f, "caller policy refused with HTTP {status}"),
            Self::Unavailable(reason) => f.write_str(reason),
        }
    }
}

/// Exactly the statuses `/gateway/tool-policy` emits as a decision about this
/// caller or credential: 400 for a non-member (or a project outside the org),
/// 401 for a dead credential, 403 for an out-of-scope caller or project. Every
/// other status, including a route-level 404 from a rolling deploy or ingress,
/// 408/429 back-pressure, and 5xx, is an outage that keeps the last result.
fn is_authoritative_refusal(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::BAD_REQUEST
            | reqwest::StatusCode::UNAUTHORIZED
            | reqwest::StatusCode::FORBIDDEN
    )
}

/// Cache of per-caller rules, keyed by credential fingerprint and user id.
pub struct UserPolicyCache {
    control_plane_url: String,
    http: reqwest::Client,
    static_key: Option<String>,
    project_id: Option<String>,
    entries: Mutex<HashMap<String, Entry>>,
}

impl UserPolicyCache {
    /// Build from environment. `None` when no control plane is configured.
    pub fn from_env(http: reqwest::Client) -> Option<Self> {
        let url = std::env::var(ENV_CONTROL_PLANE_URL)
            .ok()
            .filter(|value| !value.trim().is_empty())?;
        let non_empty = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        Some(Self::new(
            url,
            http,
            non_empty(ENV_GATEWAY_KEY),
            non_empty(ENV_PROJECT_ID),
        ))
    }

    pub fn new(
        control_plane_url: String,
        http: reqwest::Client,
        static_key: Option<String>,
        project_id: Option<String>,
    ) -> Self {
        Self {
            control_plane_url: control_plane_url.trim_end_matches('/').to_owned(),
            http,
            static_key,
            project_id,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// This gateway's own control-plane key (`GATEWAY_KEY`), used for callers
    /// a trusted forwarder relays on the statically configured policy path.
    pub fn static_key(&self) -> Option<&str> {
        self.static_key.as_deref()
    }

    fn cache_key(token: &str, user_id: &str) -> String {
        format!("{}\0{user_id}", ryu_gw_credentials::fingerprint(token))
    }

    fn cached(&self, key: &str, fresh_only: bool) -> Option<Arc<UserPolicyRules>> {
        let entries = self.entries.lock().ok()?;
        let entry = entries.get(key)?;
        (!fresh_only || entry.at.elapsed() < USER_POLICY_TTL).then(|| Arc::clone(&entry.rules))
    }

    fn evict(&self, key: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(key);
        }
    }

    fn store(&self, key: String, rules: Arc<UserPolicyRules>) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        if entries.len() >= MAX_ENTRIES && !entries.contains_key(&key) {
            if let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, entry)| entry.at)
                .map(|(key, _)| key.clone())
            {
                entries.remove(&oldest);
            }
        }
        entries.insert(
            key,
            Entry {
                at: Instant::now(),
                rules,
            },
        );
    }

    async fn fetch(&self, token: &str, user_id: &str) -> Result<UserPolicyRules, FetchError> {
        let mut request = self
            .http
            .get(format!(
                "{}/api/control-plane/gateway/tool-policy",
                self.control_plane_url
            ))
            .header("x-gateway-key", token)
            .query(&[("userId", user_id)])
            .timeout(Duration::from_secs(5));
        if let Some(project) = &self.project_id {
            request = request.header("x-project-id", project);
        }
        let response = request
            .send()
            .await
            .map_err(|_| FetchError::Unavailable("caller policy transport unavailable"))?;
        let status = response.status();
        if is_authoritative_refusal(status) {
            return Err(FetchError::Refused(status));
        }
        if !status.is_success() {
            return Err(FetchError::Unavailable("caller policy service unavailable"));
        }
        let body: UserPolicyResponse = response
            .json()
            .await
            .map_err(|_| FetchError::Unavailable("caller policy response was invalid"))?;
        Ok(body.policy.rules)
    }

    /// The caller's rules: fresh cache, else the control plane, else (only
    /// when the control plane could not answer) the last result for this
    /// caller. `None` means this caller is unresolved or was refused.
    pub async fn rules_for(&self, token: &str, user_id: &str) -> Option<Arc<UserPolicyRules>> {
        let key = Self::cache_key(token, user_id);
        if let Some(rules) = self.cached(&key, true) {
            return Some(rules);
        }
        match self.fetch(token, user_id).await {
            Ok(rules) => {
                let rules = Arc::new(rules);
                self.store(key, Arc::clone(&rules));
                Some(rules)
            }
            Err(error @ FetchError::Refused(_)) => {
                tracing::info!(%error, "caller policy refused; dropping cached result");
                self.evict(&key);
                None
            }
            Err(error @ FetchError::Unavailable(_)) => {
                tracing::warn!(%error, "caller policy refresh failed; serving last known result");
                self.cached(&key, false)
            }
        }
    }
}

/// The control plane's "allow nothing" allowlist value (`POLICY_DENY_ALL` in
/// `packages/db/src/models/control-plane.model.ts`); `[]` means unrestricted.
const POLICY_DENY_ALL: &str = "<deny-all>";

fn is_deny_all(list: &[String]) -> bool {
    list.iter()
        .any(|entry| entry.trim().eq_ignore_ascii_case(POLICY_DENY_ALL))
}

/// True when every string `entry` matches is also matched by `pattern`, both
/// being globs. Mirrors `policyGlobCovers` (`packages/db/src/models/policy-glob.ts`):
/// case-insensitive; a `*` in `pattern` absorbs any run of `entry` (wildcards
/// included), a `?` absorbs one non-`*` character, a literal matches only the
/// same literal.
fn glob_covers(pattern: &str, entry: &str) -> bool {
    let pattern: Vec<char> = pattern.to_lowercase().chars().collect();
    let entry: Vec<char> = entry.to_lowercase().chars().collect();
    let (mut pi, mut ei) = (0, 0);
    let mut star: Option<usize> = None;
    let mut star_entry = 0;
    while ei < entry.len() {
        let pc = pattern.get(pi).copied();
        let ec = entry[ei];
        let literal =
            pc.is_some_and(|pc| pc != '*' && pc != '?' && pc == ec) && ec != '*' && ec != '?';
        let single = pc == Some('?') && ec != '*';
        if literal || single {
            pi += 1;
            ei += 1;
        } else if pc == Some('*') {
            star = Some(pi);
            star_entry = ei;
            pi += 1;
        } else if let Some(star_at) = star {
            pi = star_at + 1;
            star_entry += 1;
            ei = star_entry;
        } else {
            return false;
        }
    }
    while pattern.get(pi) == Some(&'*') {
        pi += 1;
    }
    pi == pattern.len()
}

/// Narrow `inherited` with the more specific `narrower`, exactly as the
/// control plane's `narrowPolicyAllowlist` does: an empty side inherits the
/// other, deny-all on either side stays deny-all, otherwise keep only entries
/// one side lists and the other covers, and an empty overlap is deny-all
/// (never `[]`, which would read as unrestricted).
fn narrow_allowlist(
    inherited: &[String],
    narrower: &[String],
    covers: fn(&str, &str) -> bool,
) -> Vec<String> {
    if is_deny_all(inherited) || is_deny_all(narrower) {
        return vec![POLICY_DENY_ALL.to_owned()];
    }
    if narrower.is_empty() {
        return inherited.to_vec();
    }
    if inherited.is_empty() {
        return narrower.to_vec();
    }
    let mut kept: Vec<String> = Vec::new();
    let pairs = narrower
        .iter()
        .filter(|entry| inherited.iter().any(|pattern| covers(pattern, entry)))
        .chain(
            inherited
                .iter()
                .filter(|entry| narrower.iter().any(|pattern| covers(pattern, entry))),
        );
    for entry in pairs {
        if !kept.contains(entry) {
            kept.push(entry.clone());
        }
    }
    if kept.is_empty() {
        vec![POLICY_DENY_ALL.to_owned()]
    } else {
        kept
    }
}

/// The policy for one caller: the credential's policy narrowed by the caller's
/// model, provider, region, tool, and MCP-server allowlists, plus the union of
/// both guardrail sets and both tool deny lists. The caller's rules were cascaded from the same scope, but they may be
/// up to [`USER_POLICY_TTL`] old (or older during an outage) while `base` is
/// refreshed independently, so they are intersected with the current base
/// rather than replacing it: a narrowed org or team rule applies to every
/// caller from the next request. `None` (never resolved) yields an
/// unavailable policy, which denies.
pub fn policy_for_caller(
    base: &EffectivePolicy,
    rules: Option<&UserPolicyRules>,
) -> EffectivePolicy {
    let mut policy = base.clone();
    let Some(rules) = rules else {
        policy.available = false;
        return policy;
    };
    policy.approved_models =
        narrow_allowlist(&base.approved_models, &rules.approved_models, glob_covers);
    policy.approved_providers = narrow_allowlist(
        &base.approved_providers,
        &rules.approved_providers,
        glob_covers,
    );
    policy.allowed_regions = narrow_allowlist(
        &base.allowed_regions,
        &rules.allowed_regions,
        super::regions_match,
    );
    for guardrail in &rules.locked_guardrails {
        if !policy.locked_guardrails.contains(guardrail) {
            policy.locked_guardrails.push(guardrail.clone());
        }
    }
    policy.allowed_tools = narrow_allowlist(&base.allowed_tools, &rules.allowed_tools, glob_covers);
    policy.allowed_mcp_servers = narrow_allowlist(
        &base.allowed_mcp_servers,
        &rules.allowed_mcp_servers,
        glob_covers,
    );
    for denied in &rules.denied_tools {
        if !policy.denied_tools.contains(denied) {
            policy.denied_tools.push(denied.clone());
        }
    }
    policy
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caller_rules_narrow_allowlists_and_union_guardrails() {
        let base = EffectivePolicy {
            approved_models: vec!["gpt-4o".into(), "gpt-4o-mini".into()],
            locked_guardrails: vec!["pii".into()],
            ..EffectivePolicy::default()
        };
        let rules = UserPolicyRules {
            approved_models: vec!["gpt-4o-mini".into()],
            locked_guardrails: vec!["secrets".into(), "pii".into()],
            ..UserPolicyRules::default()
        };
        let policy = policy_for_caller(&base, Some(&rules));
        assert!(policy.allows_model("gpt-4o-mini"));
        assert!(!policy.allows_model("gpt-4o"));
        assert_eq!(policy.locked_guardrails, vec!["pii", "secrets"]);
        assert!(policy.available);
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    /// The caller's rules may be cached from before an admin narrowed the org
    /// or team policy; the refreshed base must still win, so stale caller
    /// allowlists cannot keep a model, provider, or region the base now forbids.
    #[test]
    fn stale_caller_rules_cannot_widen_a_narrowed_base() {
        let narrowed_base = EffectivePolicy {
            approved_models: strings(&["gpt-4o-mini"]),
            approved_providers: strings(&["openai"]),
            allowed_regions: strings(&["eu"]),
            ..EffectivePolicy::default()
        };
        let cached_caller = UserPolicyRules {
            approved_models: strings(&["gpt-4o", "gpt-4o-mini"]),
            approved_providers: strings(&["openai", "anthropic"]),
            allowed_regions: strings(&["eu-west-1", "us"]),
            ..UserPolicyRules::default()
        };
        let policy = policy_for_caller(&narrowed_base, Some(&cached_caller));
        assert!(policy.allows_model("gpt-4o-mini"));
        assert!(!policy.allows_model("gpt-4o"));
        assert!(policy.allows_provider("openai"));
        assert!(!policy.allows_provider("anthropic"));
        assert!(policy.allows_region(Some("eu-west-1")));
        assert!(
            !policy.allows_region(Some("eu-central-1")),
            "caller narrowed eu"
        );
        assert!(!policy.allows_region(Some("us-east-1")));
    }

    #[test]
    fn disjoint_or_deny_all_lists_allow_nothing_and_empty_lists_inherit() {
        let base = EffectivePolicy {
            approved_models: strings(&["claude-sonnet"]),
            approved_providers: strings(&["<deny-all>"]),
            allowed_regions: strings(&["us"]),
            ..EffectivePolicy::default()
        };
        let caller = UserPolicyRules {
            approved_models: strings(&["gpt-4o"]),
            approved_providers: Vec::new(),
            allowed_regions: strings(&["eu"]),
            ..UserPolicyRules::default()
        };
        let policy = policy_for_caller(&base, Some(&caller));
        assert_eq!(policy.approved_models, vec!["<deny-all>"]);
        assert!(!policy.allows_model("gpt-4o") && !policy.allows_model("claude-sonnet"));
        assert_eq!(policy.approved_providers, vec!["<deny-all>"]);
        assert!(!policy.allows_region(Some("eu-west-1")));
        assert!(!policy.allows_region(Some("us-east-1")));

        let unrestricted = policy_for_caller(&EffectivePolicy::default(), Some(&caller));
        assert_eq!(unrestricted.approved_models, vec!["gpt-4o"]);
        let inherited = policy_for_caller(&base, Some(&UserPolicyRules::default()));
        assert_eq!(inherited.approved_models, vec!["claude-sonnet"]);
        assert_eq!(inherited.allowed_regions, vec!["us"]);
    }

    #[test]
    fn glob_coverage_matches_the_control_plane() {
        assert!(glob_covers("gpt-*", "gpt-4o"));
        assert!(glob_covers("GPT-*", "gpt-4o-mini"));
        assert!(glob_covers("gpt-*", "gpt-4*"));
        assert!(glob_covers("gpt-4?", "gpt-4o"));
        assert!(!glob_covers("gpt-4?", "gpt-4*"), "? does not cover *");
        assert!(
            !glob_covers("gpt-4o", "gpt-*"),
            "a literal does not cover a glob"
        );
        assert!(!glob_covers("github.*", "*.read"));
        assert!(glob_covers("*", "anything"));
        let narrowed = narrow_allowlist(
            &strings(&["gpt-*"]),
            &strings(&["gpt-4o", "claude"]),
            glob_covers,
        );
        assert_eq!(narrowed, vec!["gpt-4o"]);
    }

    #[test]
    fn only_client_decisions_are_authoritative() {
        use reqwest::StatusCode;
        for status in [
            StatusCode::BAD_REQUEST,
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
        ] {
            assert!(is_authoritative_refusal(status), "{status}");
        }
        for status in [
            StatusCode::OK,
            StatusCode::NOT_FOUND,
            StatusCode::METHOD_NOT_ALLOWED,
            StatusCode::GONE,
            StatusCode::REQUEST_TIMEOUT,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::BAD_GATEWAY,
            StatusCode::SERVICE_UNAVAILABLE,
        ] {
            assert!(!is_authoritative_refusal(status), "{status}");
        }
    }

    /// Serve `/api/control-plane/gateway/tool-policy` with whatever status
    /// `status` currently holds, and a cache that points at it.
    async fn cache_against(
        status: Arc<std::sync::atomic::AtomicU16>,
    ) -> (UserPolicyCache, tokio::task::JoinHandle<()>) {
        use axum::{http::StatusCode, routing::get, Json, Router};
        let app = Router::new().route(
            "/api/control-plane/gateway/tool-policy",
            get(move || {
                let status = Arc::clone(&status);
                async move {
                    let code = status.load(std::sync::atomic::Ordering::SeqCst);
                    let body = serde_json::json!({
                        "policy": { "rules": { "approvedModels": ["m"] } }
                    });
                    (StatusCode::from_u16(code).unwrap(), Json(body))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let cache = UserPolicyCache::new(format!("http://{address}"), http, None, None);
        (cache, server)
    }

    fn expire(cache: &UserPolicyCache) {
        for entry in cache.entries.lock().unwrap().values_mut() {
            entry.at = Instant::now() - USER_POLICY_TTL - Duration::from_secs(1);
        }
    }

    #[tokio::test]
    async fn an_outage_keeps_the_last_result_but_a_refusal_drops_it() {
        use std::sync::atomic::{AtomicU16, Ordering};
        let status = Arc::new(AtomicU16::new(200));
        let (cache, server) = cache_against(Arc::clone(&status)).await;
        let token = "node-credential";
        let user = "member-1";

        let first = cache.rules_for(token, user).await.expect("resolved");
        assert_eq!(first.approved_models, vec!["m"]);

        expire(&cache);
        status.store(503, Ordering::SeqCst);
        let stale = cache.rules_for(token, user).await;
        assert_eq!(
            stale.as_deref(),
            Some(&*first),
            "5xx serves the last result"
        );

        expire(&cache);
        status.store(404, Ordering::SeqCst);
        assert_eq!(
            cache.rules_for(token, user).await.as_deref(),
            Some(&*first),
            "a route-level 404 (rolling deploy, ingress) serves the last result"
        );

        expire(&cache);
        status.store(400, Ordering::SeqCst);
        assert!(cache.rules_for(token, user).await.is_none(), "400 denies");

        status.store(503, Ordering::SeqCst);
        assert!(
            cache.rules_for(token, user).await.is_none(),
            "a refused caller is not revived by a later outage"
        );
        server.abort();
    }

    #[test]
    fn an_unresolved_caller_is_denied() {
        let policy = policy_for_caller(&EffectivePolicy::default(), None);
        assert!(!policy.available);
        assert!(!policy.allows_model("anything"));
    }

    #[test]
    fn decodes_the_control_plane_response() {
        let body: UserPolicyResponse = serde_json::from_str(
            r#"{"organizationId":"o","userId":"u","policy":{"lockedFields":[],"rules":{
                "allowedTools":[],"approvedModels":["m"],"approvedProviders":["p"],
                "allowedRegions":["eu"],"lockedGuardrails":["pii"]}}}"#,
        )
        .unwrap();
        assert_eq!(
            body.policy.rules,
            UserPolicyRules {
                approved_models: vec!["m".into()],
                approved_providers: vec!["p".into()],
                allowed_regions: vec!["eu".into()],
                locked_guardrails: vec!["pii".into()],
                ..UserPolicyRules::default()
            }
        );
        let tools: UserPolicyResponse = serde_json::from_str(
            r#"{"policy":{"rules":{"allowedTools":["composio.GMAIL_GET_*"],
                "deniedTools":["composio.GMAIL_SEND_EMAIL"],"allowedMcpServers":null}}}"#,
        )
        .unwrap();
        assert_eq!(
            tools.policy.rules.allowed_tools,
            vec!["composio.GMAIL_GET_*"]
        );
        assert_eq!(
            tools.policy.rules.denied_tools,
            vec!["composio.GMAIL_SEND_EMAIL"]
        );
        assert!(tools.policy.rules.allowed_mcp_servers.is_empty());
    }

    /// Tool rules combine deny-overrides: the caller's denies add to the
    /// credential's, the allowlists intersect, and a disjoint intersection
    /// denies every tool rather than reading as unrestricted.
    #[test]
    fn caller_tool_rules_union_denies_and_narrow_allowlists() {
        let base = EffectivePolicy {
            allowed_tools: strings(&["composio.*", "exa.search"]),
            denied_tools: strings(&["composio.GMAIL_DELETE_*"]),
            ..EffectivePolicy::default()
        };
        let caller = UserPolicyRules {
            allowed_tools: strings(&["composio.GMAIL_*"]),
            denied_tools: strings(&["composio.GMAIL_SEND_EMAIL"]),
            ..UserPolicyRules::default()
        };
        let policy = policy_for_caller(&base, Some(&caller));
        assert!(policy
            .evaluate_tool("composio.GMAIL_GET_MESSAGE", None)
            .is_ok());
        assert!(policy
            .evaluate_tool("composio.GMAIL_SEND_EMAIL", None)
            .is_err());
        assert!(policy
            .evaluate_tool("composio.GMAIL_DELETE_DRAFT", None)
            .is_err());
        assert!(policy
            .evaluate_tool("composio.SLACK_SEND_MESSAGE", None)
            .is_err());
        assert!(policy.evaluate_tool("exa.search", None).is_err());

        let disjoint = policy_for_caller(
            &EffectivePolicy {
                allowed_tools: strings(&["exa.search"]),
                ..EffectivePolicy::default()
            },
            Some(&UserPolicyRules {
                allowed_tools: strings(&["composio.*"]),
                ..UserPolicyRules::default()
            }),
        );
        assert_eq!(disjoint.allowed_tools, vec!["<deny-all>"]);
        assert!(disjoint.evaluate_tool("exa.search", None).is_err());
        assert!(disjoint
            .evaluate_tool("composio.GMAIL_GET_MESSAGE", None)
            .is_err());

        let unresolved = policy_for_caller(&EffectivePolicy::default(), None);
        assert!(unresolved.evaluate_tool("exa.search", None).is_err());
    }
}
