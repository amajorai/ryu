//! The **Safe Actions** app host-bridge operation (`safeActions.request`).
//!
//! A Safe Actions Companion reviews persisted tool plans: it lists reviews and
//! receipts, approves or denies a pending plan, and attests tool contracts.
//! Approving a plan resumes its execution, so the approval IS the human review.
//! Two gates therefore hold at once and neither stands in for the other:
//!
//! - **the app grant** (`safe-actions:manage`), checked by the bridge
//!   (`server::plugin_bridge_api`) against the app's approved grants;
//! - **the signed-in user's role**: every `/api/tools/plans/*` handler runs
//!   `safe_actions::require_operator` against the verified caller (org Viewer to
//!   read, Admin to change or decide on a managed node), and approve / deny /
//!   contract writes record that caller's id as `reviewed_by` / `attested_by`.
//!
//! [`SafeActionsOp::run`] sends one request through `safe_actions::routes()` in
//! process, with the bridge's verified caller as the request's
//! `Option<VerifiedCaller>` extension and no forwarded headers. The handlers,
//! extractors and route set are the HTTP ones, so there is no second table to
//! drift. The identity is never read from the args: they are `{ method, path,
//! body? }` with unknown keys refused, and the handler bodies are
//! `deny_unknown_fields`, so a `reviewed_by` in either place is a 4xx.
//!
//! **Bridge-only.** There is no `KERNEL_CAPABILITIES` row: a sidecar carries no
//! user, and on an unbound node `require_operator` admits a missing user as
//! `local-operator`, so a row would make an app grant a plan approver. For the
//! same reason the bridge route is denied to the agent self-API
//! (`self_api::is_denied`), whose node-token loopback carries no user either.
//!
//! The in-process request skips the outer HTTP `route_policy` for
//! `/api/tools/plans`; the bridge route it arrives on is under the stricter
//! owner-only policy and still passes `require_auth` and the org route policy.

use axum::{
    body::Body,
    http::{header::CONTENT_TYPE, Method, Request, StatusCode},
};
use serde_json::Value;

use super::kernel_op::{decode_reply_bytes, read_handler_reply, KernelOpError};
use super::ServerState;
use crate::identity_verify::VerifiedCaller;

/// The Core mount every request is confined to.
const MOUNT: &str = "/api/tools/plans";

/// The longest relative path accepted.
const MAX_PATH_BYTES: usize = 1024;

/// The one Safe Actions operation. The wire name is the host-API method.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SafeActionsOp {
    /// One request onto the `/api/tools/plans` routes.
    Request,
}

/// `{ method?, path, body? }`. Unknown keys are refused, so no identity or
/// header can ride along.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestArgs {
    #[serde(default)]
    method: Option<String>,
    path: String,
    #[serde(default)]
    body: Option<Value>,
}

impl SafeActionsOp {
    /// The operation a host-method name selects, if any.
    pub(crate) fn from_name(name: &str) -> Option<Self> {
        match name {
            "safeActions.request" => Some(Self::Request),
            _ => None,
        }
    }

    /// Send one request for `caller`, the verified signed-in user (or `None`,
    /// which `require_operator` refuses on a managed node, exactly as over HTTP).
    pub(crate) async fn run(
        self,
        state: &ServerState,
        caller: &Option<VerifiedCaller>,
        args: &Value,
    ) -> Result<Value, KernelOpError> {
        let Self::Request = self;
        let RequestArgs { method, path, body } =
            serde_json::from_value(args.clone()).map_err(|e| {
                KernelOpError::invalid(format!(
                    "safeActions.request expects {{ method?, path, body? }}: {e}"
                ))
            })?;
        let method = parse_method(method.as_deref())?;
        validate_relative_path(&path)?;

        let mut builder = Request::builder()
            .method(method)
            .uri(format!("{MOUNT}{path}"));
        let request_body = match body {
            Some(body) => {
                builder = builder.header(CONTENT_TYPE, "application/json");
                let bytes = serde_json::to_vec(&body).map_err(|e| {
                    KernelOpError::invalid(format!("safeActions.request body is not JSON: {e}"))
                })?;
                Body::from(bytes)
            }
            None => Body::empty(),
        };
        let mut request = builder.body(request_body).map_err(|e| {
            KernelOpError::invalid(format!("safeActions.request is malformed: {e}"))
        })?;
        // The ONLY identity the handlers see: the bridge's verified caller.
        request
            .extensions_mut()
            .insert::<Option<VerifiedCaller>>(caller.clone());

        let router: axum::Router = crate::safe_actions::routes().with_state(state.clone());
        let response = match tower::ServiceExt::oneshot(router, request).await {
            Ok(response) => response,
            Err(never) => match never {},
        };
        let (status, bytes) = read_handler_reply(response).await?;
        if bytes.is_empty()
            && matches!(
                status,
                StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
            )
        {
            return Err(KernelOpError::new(status, "unknown Safe Actions route"));
        }
        decode_reply_bytes(status, &bytes)
    }
}

/// The request method: `GET` when omitted, else exactly one of the four verbs
/// the routes serve.
fn parse_method(method: Option<&str>) -> Result<Method, KernelOpError> {
    match method.unwrap_or("GET") {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "DELETE" => Ok(Method::DELETE),
        other => Err(KernelOpError::invalid(format!(
            "safeActions.request method must be GET, POST, PUT or DELETE, not '{other}'"
        ))),
    }
}

/// Whether `byte` may appear in an RFC 3986 path (`pchar` or `/`), not counting
/// `%`, which is checked separately as a `%XX` escape.
fn is_path_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'.'
                | b'_'
                | b'~'
                | b'!'
                | b'$'
                | b'&'
                | b'\''
                | b'('
                | b')'
                | b'*'
                | b'+'
                | b','
                | b';'
                | b'='
                | b':'
                | b'@'
                | b'/'
        )
}

/// Confine a frame-supplied path to the Safe Actions mount. Every failure is a
/// `400`, never a panic:
///
/// - at most 1024 bytes, starting with `/` and not `//`;
/// - only RFC 3986 path characters, with every `%` a well-formed `%XX` escape
///   (so no spaces, non-ASCII, `\`, `?`, `#` or raw control bytes);
/// - no segment that decodes to `.` or `..`, to invalid UTF-8, or to text with
///   `/`, `\` or a control character (`%00` included).
fn validate_relative_path(path: &str) -> Result<(), KernelOpError> {
    let refuse = |why: &str| {
        Err(KernelOpError::invalid(format!(
            "safeActions.request path {why}"
        )))
    };
    if path.len() > MAX_PATH_BYTES {
        return refuse("is too long");
    }
    if !path.starts_with('/') || path.starts_with("//") {
        return refuse("must start with a single '/'");
    }
    let bytes = path.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' {
            let escape = bytes.get(index + 1..index + 3);
            if !escape.is_some_and(|hex| hex.iter().all(u8::is_ascii_hexdigit)) {
                return refuse("has a malformed percent-escape");
            }
            index += 3;
            continue;
        }
        if !is_path_byte(byte) {
            return refuse("has a character outside a URL path");
        }
        index += 1;
    }
    for segment in path.split('/').skip(1) {
        let Ok(decoded) = urlencoding::decode(segment) else {
            return refuse("has a segment that is not UTF-8");
        };
        if matches!(decoded.as_ref(), "." | "..") {
            return refuse("must not traverse with '.' or '..'");
        }
        if decoded
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control())
        {
            return refuse("has an encoded separator or control character");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_verify::OrgRole;
    use crate::sidecar::control_plane::{
        with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
    };
    use axum::extract::{Extension, Path, State};
    use axum::Json;
    use serde_json::json;

    const APP: &str = "@example/plans";
    const GRANT: &str = "safe-actions:manage";

    fn caller(user_id: &str, org_id: &str, role: OrgRole) -> VerifiedCaller {
        VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some(org_id.to_owned()),
            role,
            teams: Vec::new(),
        }
    }

    fn org_node(org_id: &str) -> RegisteredNode {
        RegisteredNode {
            org: RegisteredOrg {
                id: org_id.to_owned(),
                name: org_id.to_owned(),
                slug: None,
            },
            node_id: "node-1".to_owned(),
            scope: NodeScope::Org,
            team_id: None,
            owner_user_id: None,
        }
    }

    /// An enabled app whose manifest declares only the grant under test,
    /// approved or not.
    async fn app_state(directory: &std::path::Path, approved: bool) -> ServerState {
        let state = crate::server::isolated_plugin_hook_test_state(directory);
        state.app_store.insert(APP, "1.0.0").await.unwrap();
        let grants: Vec<String> = if approved {
            vec![GRANT.to_owned()]
        } else {
            Vec::new()
        };
        state.app_store.set_enabled(APP, &grants).await.unwrap();
        let manifest: crate::plugin_manifest::PluginManifest = serde_json::from_value(json!({
            "id": APP, "name": "Plans", "version": "1.0.0", "runnables": [],
            "permission_grants": [GRANT],
        }))
        .unwrap();
        state.app_manifests.write().await.push(manifest);
        state
    }

    async fn bridge(
        state: &ServerState,
        caller: Option<VerifiedCaller>,
        args: Value,
    ) -> (StatusCode, Value) {
        let response = crate::server::plugin_bridge_api::plugin_bridge_dispatch(
            State(state.clone()),
            Extension(caller),
            Path(APP.to_owned()),
            axum::http::HeaderMap::new(),
            Json(crate::server::plugin_bridge_api::HostDispatchBody {
                method: "safeActions.request".to_owned(),
                args,
            }),
        )
        .await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    /// A deny request for a test review, echoing the plan hash the reviewer saw.
    fn deny(id: &str, mut body: Value) -> Value {
        body["expected_plan_hash"] = json!(crate::safe_actions::test_pending_review_plan_hash());
        json!({ "method": "POST", "path": format!("/reviews/{id}/deny"), "body": body })
    }

    fn contract_body() -> Value {
        json!({
            "tool": "app.echo",
            "contract": {
                "trust": "operator_attested",
                "effects": ["read"],
                "resources": ["test://echo/value"],
                "arguments_independent": true
            }
        })
    }

    #[test]
    fn op_name_matches_host_api_grant() {
        assert_eq!(
            SafeActionsOp::from_name("safeActions.request"),
            Some(SafeActionsOp::Request)
        );
        assert_eq!(
            ryu_kernel_contracts::host_api::grant_for("safeActions.request"),
            Some(GRANT)
        );
        assert_eq!(SafeActionsOp::from_name("safeActions.approve"), None);
        // No other in-process operation claims the name.
        assert_eq!(
            crate::server::app_webhooks::WebhookOp::from_name("safeActions.request"),
            None
        );
        assert_eq!(
            crate::server::app_webhooks::WebhookSecretOp::from_name("safeActions.request"),
            None
        );
        assert_eq!(
            crate::server::app_warmup::WarmupOp::from_name("safeActions.request"),
            None
        );
    }

    #[tokio::test]
    async fn bridge_refuses_without_the_grant() {
        let directory = tempfile::tempdir().unwrap();
        let state = app_state(directory.path(), false).await;
        let id = state.safe_actions.insert_test_pending_review().await;
        for args in [
            json!({ "path": "/reviews" }),
            deny(&id, json!({ "note": "no" })),
        ] {
            let (status, body) = bridge(&state, None, args).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
            assert_eq!(body["error"]["code"], "denied");
        }
        assert_eq!(
            state.safe_actions.test_review_state(&id).await,
            Some(("pending_review".to_owned(), None))
        );
    }

    #[tokio::test]
    async fn bridge_refuses_without_user_permission() {
        let directory = tempfile::tempdir().unwrap();
        let state = app_state(directory.path(), true).await;
        let id = state.safe_actions.insert_test_pending_review().await;
        with_test_node_binding(true, Some(org_node("org-1")), async {
            // No signed-in user on a managed node.
            let (status, body) = bridge(&state, None, json!({ "path": "/reviews" })).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
            assert_eq!(body["error"]["code"], "denied");

            // A Viewer may read but not decide or attest.
            let viewer = caller("viewer-1", "org-1", OrgRole::Viewer);
            let (status, body) =
                bridge(&state, Some(viewer.clone()), json!({ "path": "/reviews" })).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert!(body["result"]["reviews"].is_array(), "{body}");
            let (status, body) = bridge(
                &state,
                Some(viewer.clone()),
                deny(&id, json!({ "note": "no" })),
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
            let (status, body) = bridge(
                &state,
                Some(viewer),
                json!({ "method": "POST", "path": "/catalog/contracts", "body": contract_body() }),
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

            // An Admin of another organization holds nothing here.
            let foreign = caller("admin-2", "org-2", OrgRole::Admin);
            let (status, body) =
                bridge(&state, Some(foreign), deny(&id, json!({ "note": "no" }))).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        })
        .await;
        assert_eq!(
            state.safe_actions.test_review_state(&id).await,
            Some(("pending_review".to_owned(), None))
        );
    }

    #[tokio::test]
    async fn bridge_works_with_grant_and_user_and_records_the_verified_reviewer() {
        let directory = tempfile::tempdir().unwrap();
        let state = app_state(directory.path(), true).await;
        let managed = state.safe_actions.insert_test_pending_review().await;
        with_test_node_binding(true, Some(org_node("org-1")), async {
            let admin = caller("admin-1", "org-1", OrgRole::Admin);
            let (status, body) =
                bridge(&state, Some(admin), deny(&managed, json!({ "note": "no" }))).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(
                body["result"],
                json!({ "ok": true, "status": "denied_by_reviewer" })
            );
        })
        .await;
        assert_eq!(
            state.safe_actions.test_review_state(&managed).await,
            Some(("denied_by_reviewer".to_owned(), Some("admin-1".to_owned())))
        );

        // An unbound node: the signed-in user is still the reviewer.
        let unbound = state.safe_actions.insert_test_pending_review().await;
        with_test_node_binding(false, None, async {
            let operator = caller("operator-1", "org-9", OrgRole::Member);
            let (status, body) = bridge(&state, Some(operator), deny(&unbound, json!({}))).await;
            assert_eq!(status, StatusCode::OK, "{body}");
        })
        .await;
        assert_eq!(
            state.safe_actions.test_review_state(&unbound).await,
            Some((
                "denied_by_reviewer".to_owned(),
                Some("operator-1".to_owned())
            ))
        );
    }

    #[tokio::test]
    async fn reviewer_is_never_request_supplied() {
        let directory = tempfile::tempdir().unwrap();
        let state = app_state(directory.path(), true).await;
        let id = state.safe_actions.insert_test_pending_review().await;
        with_test_node_binding(false, None, async {
            let operator = Some(caller("operator-1", "org-1", OrgRole::Admin));
            // In the handler body: `deny_unknown_fields` refuses it.
            let (status, body) = bridge(
                &state,
                operator.clone(),
                deny(&id, json!({ "note": "x", "reviewed_by": "mallory" })),
            )
            .await;
            assert!(status.is_client_error(), "{status}: {body}");
            assert_eq!(body["error"]["code"], "invalid_args", "{body}");
            // In the bridge args: refused before any request is made.
            for extra in ["reviewed_by", "user_id", "headers"] {
                let mut args = deny(&id, json!({ "note": "x" }));
                args[extra] = json!("mallory");
                let (status, body) = bridge(&state, operator.clone(), args).await;
                assert_eq!(status, StatusCode::BAD_REQUEST, "{extra}: {body}");
                assert_eq!(body["error"]["code"], "invalid_args", "{extra}");
            }
        })
        .await;
        assert_eq!(
            state.safe_actions.test_review_state(&id).await,
            Some(("pending_review".to_owned(), None))
        );
    }

    #[tokio::test]
    async fn a_decision_must_echo_the_displayed_plan_hash() {
        let directory = tempfile::tempdir().unwrap();
        let state = app_state(directory.path(), true).await;
        let id = state.safe_actions.insert_test_pending_review().await;
        with_test_node_binding(false, None, async {
            let operator = Some(caller("operator-1", "org-1", OrgRole::Admin));
            // A stale surface showing a different review's plan cannot decide this one.
            let mut stale = deny(&id, json!({ "note": "stale" }));
            stale["body"]["expected_plan_hash"] = json!("sha256:plan-shown-for-another-review");
            let (status, body) = bridge(&state, operator.clone(), stale).await;
            assert!(!status.is_success(), "{status}: {body}");
            // An older client that binds nothing is refused too.
            let mut unbound = deny(&id, json!({ "note": "old client" }));
            unbound["body"]
                .as_object_mut()
                .unwrap()
                .remove("expected_plan_hash");
            let (status, body) = bridge(&state, operator, unbound).await;
            assert!(status.is_client_error(), "{status}: {body}");
        })
        .await;
        assert_eq!(
            state.safe_actions.test_review_state(&id).await,
            Some(("pending_review".to_owned(), None)),
            "neither request may decide the review"
        );
    }

    #[tokio::test]
    async fn path_and_method_containment() {
        let directory = tempfile::tempdir().unwrap();
        let state = app_state(directory.path(), true).await;
        let too_long = format!("/{}", "a".repeat(MAX_PATH_BYTES));
        with_test_node_binding(false, None, async {
            for path in [
                "/../mcp/tools",
                "/%2e%2e/x",
                "/%2E%2e/x",
                "/reviews/%2e",
                "//evil/x",
                "/reviews?x=1",
                "/reviews#f",
                "/a\\b",
                "/a b",
                "/r\u{e9}views",
                "/a%zz",
                "/a%2",
                "/a%ff%fe",
                "/a%00b",
                "/a%0a",
                "/a%2fb",
                "/a%5cb",
                "/a\u{7f}",
                too_long.as_str(),
                "relative",
                "",
            ] {
                let (status, body) = bridge(&state, None, json!({ "path": path })).await;
                assert_eq!(status, StatusCode::BAD_REQUEST, "{path:?}: {body}");
                assert_eq!(body["error"]["code"], "invalid_args", "{path:?}");
            }
            let (status, body) = bridge(&state, None, json!({ "path": "/nope" })).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
            assert_eq!(body["error"]["code"], "not_found");
            assert_eq!(body["error"]["message"], "unknown Safe Actions route");
            let (status, body) =
                bridge(&state, None, json!({ "method": "PUT", "path": "/reviews" })).await;
            assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{body}");
            assert_eq!(body["error"]["code"], "invalid_args");
            for method in ["PATCH", "get", "HEAD", ""] {
                let (status, body) = bridge(
                    &state,
                    None,
                    json!({ "method": method, "path": "/reviews" }),
                )
                .await;
                assert_eq!(status, StatusCode::BAD_REQUEST, "{method}: {body}");
                assert_eq!(body["error"]["code"], "invalid_args", "{method}");
            }
            for args in [json!(null), json!({}), json!({ "path": 7 })] {
                let (status, body) = bridge(&state, None, args.clone()).await;
                assert_eq!(status, StatusCode::BAD_REQUEST, "{args}: {body}");
            }
            // A well-formed path still reaches the routes.
            let (status, body) = bridge(&state, None, json!({ "path": "/receipts" })).await;
            assert_eq!(status, StatusCode::OK, "{body}");
        })
        .await;
    }

    #[test]
    fn well_formed_paths_pass_validation() {
        for path in [
            "/reviews",
            "/reviews/r-1/approve",
            "/policies/p_1.v2",
            "/receipts/abc%20def",
            "/policies/a:b@c",
        ] {
            assert!(validate_relative_path(path).is_ok(), "{path}");
        }
    }

    /// One request per `(method, route)` the Safe Actions router serves, with the
    /// `:id` segments filled in as `p-1` (policies) or `r-1` (reviews, receipts).
    fn one_request_per_route() -> Vec<(&'static str, &'static str, Option<Value>)> {
        vec![
            ("GET", "/policies", None),
            (
                "POST",
                "/policies",
                Some(json!({ "name": "x", "policy": {} })),
            ),
            ("GET", "/policies/p-1", None),
            (
                "PUT",
                "/policies/p-1",
                Some(json!({ "name": "x", "policy": {} })),
            ),
            (
                "DELETE",
                "/policies/p-1",
                Some(json!({ "expected_version": 1 })),
            ),
            ("POST", "/policies/p-1/check", None),
            ("GET", "/agents", None),
            ("GET", "/catalog", None),
            ("POST", "/catalog/contracts", Some(contract_body())),
            ("GET", "/reviews", None),
            ("GET", "/reviews/r-1", None),
            (
                "POST",
                "/reviews/r-1/approve",
                Some(json!({ "expected_plan_hash": "sha256:plan" })),
            ),
            (
                "POST",
                "/reviews/r-1/deny",
                Some(json!({ "expected_plan_hash": "sha256:plan" })),
            ),
            ("GET", "/receipts", None),
            ("GET", "/receipts/r-1", None),
        ]
    }

    /// Every `(METHOD, route)` pair `safe_actions::routes()` registers, read from
    /// its source (the way the app-boundary guards scan sources), so the table
    /// above cannot silently fall behind the router.
    fn routes_registered_by_the_router() -> std::collections::BTreeSet<(String, String)> {
        let source = include_str!("../safe_actions/mod.rs");
        let start = source
            .find("pub fn routes() -> Router")
            .expect("safe_actions::routes() is declared");
        let body = &source[start..];
        let body = &body[..body.find("\n}\n").expect("safe_actions::routes() ends")];
        let mut registered = std::collections::BTreeSet::new();
        for entry in body.split(".route(").skip(1) {
            let path = entry.split('"').nth(1).expect("a route path literal");
            let handlers = &entry[entry.find(',').expect("a route method router")..];
            let mut methods = 0;
            for method in ["get", "post", "put", "patch", "delete"] {
                for (index, _) in handlers.match_indices(&format!("{method}(")) {
                    let starts_a_call = handlers[..index]
                        .chars()
                        .last()
                        .is_none_or(|previous| !(previous.is_alphanumeric() || previous == '_'));
                    if starts_a_call {
                        registered.insert((method.to_ascii_uppercase(), path.to_owned()));
                        methods += 1;
                    }
                }
            }
            assert!(
                methods > 0,
                "route {path} uses a method router this scan does not read; extend it"
            );
        }
        registered
    }

    #[test]
    fn the_operator_table_covers_every_route_the_router_serves() {
        let tabled: std::collections::BTreeSet<(String, String)> = one_request_per_route()
            .into_iter()
            .map(|(method, path, _)| {
                let pattern = path
                    .split('/')
                    .map(|segment| match segment {
                        "p-1" | "r-1" => ":id",
                        other => other,
                    })
                    .collect::<Vec<_>>()
                    .join("/");
                (method.to_owned(), format!("/api/tools/plans{pattern}"))
            })
            .collect();
        assert_eq!(
            routes_registered_by_the_router(),
            tabled,
            "add the new route to one_request_per_route so its operator check is tested"
        );
    }

    /// Every route the Safe Actions router serves checks the operator role. The
    /// table is held against the router's source by
    /// `the_operator_table_covers_every_route_the_router_serves`, so a route added
    /// later without `require_operator` is noticed here.
    #[tokio::test]
    async fn every_route_requires_the_operator_role() {
        let directory = tempfile::tempdir().unwrap();
        let state = app_state(directory.path(), true).await;
        with_test_node_binding(true, Some(org_node("org-1")), async {
            for (method, path, body) in one_request_per_route() {
                let mut args = json!({ "method": method, "path": path });
                if let Some(body) = body {
                    args["body"] = body;
                }
                let (status, reply) = bridge(&state, None, args).await;
                assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {reply}");
            }
        })
        .await;
    }
}
