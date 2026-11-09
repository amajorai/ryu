//! Dispatch: the loopback HTTP call back into this Core.

use super::*;

// ── Dispatch (loopback HTTP) ──────────────────────────────────────────────────

/// This node's own base URL + admittance token for the loopback call.
pub(super) fn self_target() -> (String, Option<String>) {
    (
        crate::sidecar::gateway::core_self_url(),
        crate::node_token::active_token().filter(|token| !token.is_empty()),
    )
}

/// Header carrying [`self_call_proof`] on a loopback that acts for a person.
pub const SELF_CALL_PROOF_HEADER: &str = "x-ryu-self-call-proof";
/// Header naming the person a proven loopback acts for.
pub const SELF_CALL_USER_HEADER: &str = "x-ryu-self-call-user";

/// A random secret that exists only in this Core process. A loopback carrying
/// it alongside the node token runs as the named person instead of as the node
/// owner, so handlers apply that person's role. Nothing outside this process
/// can mint it, so holding the node token alone never lets a client claim to be
/// a particular member.
pub fn self_call_proof() -> &'static str {
    static PROOF: OnceLock<String> = OnceLock::new();
    PROOF.get_or_init(|| {
        let bytes: [u8; 32] = rand::random();
        hex::encode(bytes)
    })
}

/// The person a node-token request acts for, when it carries a self-call proof.
pub enum SelfCallIdentity {
    /// No proof header: an ordinary node-token request.
    Absent,
    /// A valid proof naming this person.
    Acting(String),
    /// A proof header that does not match, or names nobody.
    Invalid,
}

/// Read the self-call headers. Only meaningful after the node token checked out.
pub fn self_call_identity(headers: &axum::http::HeaderMap) -> SelfCallIdentity {
    let Some(proof) = headers.get(SELF_CALL_PROOF_HEADER) else {
        return SelfCallIdentity::Absent;
    };
    let proof_matches = proof
        .to_str()
        .is_ok_and(|proof| crate::server::ct_eq(proof, self_call_proof()));
    let user = headers
        .get(SELF_CALL_USER_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|user| !user.is_empty());
    match (proof_matches, user) {
        (true, Some(user)) => SelfCallIdentity::Acting(user.to_owned()),
        _ => SelfCallIdentity::Invalid,
    }
}

/// Execute a CoreApi tool by id: resolve the route, then loop back over HTTP to
/// this Core with its own token. The tenancy and role checks are enforced by the
/// caller (`sidecar/mcp/mod.rs`) *before* this runs. `acting_user` is set on an
/// org-bound node, so the handlers see that person rather than the node owner.
pub async fn dispatch(
    http: &reqwest::Client,
    tool_id: &str,
    args: Value,
    acting_user: Option<&str>,
) -> Result<Value> {
    let route = routes()
        .iter()
        .find(|r| r.id == tool_id)
        .ok_or_else(|| anyhow!("unknown core-api tool '{tool_id}'"))?;
    let (base, token) = self_target();
    send_request_as(http, &base, token.as_deref(), route, &args, acting_user).await
}

/// The pure request builder + sender (base/token injected, so tests can point it
/// at an ephemeral server without touching process env).
pub async fn send_request(
    http: &reqwest::Client,
    base: &str,
    token: Option<&str>,
    route: &CoreApiRoute,
    args: &Value,
) -> Result<Value> {
    send_request_as(http, base, token, route, args, None).await
}

/// [`send_request`] acting for a person (see [`self_call_proof`]).
pub async fn send_request_as(
    http: &reqwest::Client,
    base: &str,
    token: Option<&str>,
    route: &CoreApiRoute,
    args: &Value,
    acting_user: Option<&str>,
) -> Result<Value> {
    // Substitute path params. SECURITY: a path parameter is a SINGLE path
    // segment. The denylist ([`is_denied`]) is evaluated once, at descriptor
    // build time, against the route *template* — so an unsanitized value like
    // `../auth/x` or `..%2f..` would reshape the resolved path past the denylist
    // and hit an arbitrary Core endpoint under the node token (traversal / IDOR).
    // Reject any value that could escape its segment, then re-run the denylist on
    // the fully-resolved path as defense-in-depth.
    let mut path = route.path_template.clone();
    for p in &route.path_params {
        let v = args
            .get(p)
            .filter(|v| !v.is_null())
            .map(value_to_string)
            .ok_or_else(|| {
                anyhow!(
                    "core-api tool '{}' is missing required path parameter '{p}'",
                    route.id
                )
            })?;
        if !is_safe_path_segment(&v) {
            return Err(anyhow!(
                "core-api tool '{}' path parameter '{p}' has an unsafe value \
				 (path separators, URL delimiters, '..', '%', or control characters are rejected)",
                route.id
            ));
        }
        path = path.replace(&format!("{{{p}}}"), &v);
    }
    // Defense-in-depth: the resolved path must still clear the denylist.
    if is_denied(&path, &route.method) {
        return Err(anyhow!(
            "core-api tool '{}' resolved to a denied path '{path}'",
            route.id
        ));
    }
    if let Some(section) = gateway_config_settings_only_section(&path, &route.method, args) {
        return Err(anyhow!(
            "core-api tool '{}' cannot change the Gateway's `{section}` settings. They carry \
             credentials, network egress, safety filters, or the audit trail; change them in \
             Settings instead",
            route.id
        ));
    }
    let url = format!("{}{}", base.trim_end_matches('/'), path);

    let method = reqwest::Method::from_bytes(route.method.as_bytes())
        .map_err(|e| anyhow!("core-api tool '{}' has a bad method: {e}", route.id))?;
    let mut req = http.request(method, &url).timeout(LOOPBACK_TIMEOUT);

    // Query params (reqwest handles the encoding).
    let query: Vec<(String, String)> = route
        .query_params
        .iter()
        .filter_map(|q| {
            args.get(q)
                .filter(|v| !v.is_null())
                .map(|v| (q.clone(), value_to_string(v)))
        })
        .collect();
    if !query.is_empty() {
        req = req.query(&query);
    }
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    if let Some(user) = acting_user {
        req = req
            .header(SELF_CALL_PROOF_HEADER, self_call_proof())
            .header(SELF_CALL_USER_HEADER, user);
    }
    if route.has_body {
        req = req.json(&args.get("body").cloned().unwrap_or(Value::Null));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| anyhow!("core-api loopback to {} failed: {e}", route.path_template))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    // Return the parsed JSON body when possible, else the raw text.
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    Ok(json!({
        "status": status.as_u16(),
        "ok": status.is_success(),
        "body": body,
    }))
}

/// Stringify a JSON value for use in a path/query position (strings unquoted).
pub(super) fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// True when `v` is safe to substitute into a single path segment. Rejects the
/// separators and encodings an attacker would use to escape the segment and
/// reshape the resolved path (`/`, `\`, `..`, `%`-encoding) plus ASCII control
/// characters. Empty is rejected too — a required path param must have a value.
pub(super) fn is_safe_path_segment(v: &str) -> bool {
    !v.is_empty()
        && !v.contains('/')
        && !v.contains('\\')
        && !v.contains('?')
        && !v.contains('#')
        && !v.contains("..")
        && !v.contains('%')
        && !v.chars().any(|c| c.is_control())
}
