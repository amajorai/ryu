//! The **webhook registry** kernel capabilities (`webhooks.list`,
//! `webhooks.ingressStatus`).
//!
//! Core owns the inbound-webhook registry (the Composio receiver plus every
//! workflow `Webhook` trigger) and the ingress backend that makes it reachable.
//! An app reads it through these two read-only operations, gated by the
//! existing `webhooks:crud` grant:
//!
//! - a sidecar calls `POST /api/host/capability/webhooks.list` (a
//!   `KERNEL_CAPABILITIES` row in `sidecar::ext_proxy`);
//! - a Companion frame calls `window.ryu.webhooks.list()`, which the shell
//!   forwards to Core's app host bridge (`POST /api/plugins/:id/host`,
//!   `server::plugin_bridge_api`), checked against the app's approved grants.
//!
//! Both reach [`WebhookOp::run`], which is also what `GET /api/webhooks` and
//! `GET /api/webhook-ingress/status` answer. The replies are metadata only
//! (`has_secret` is a boolean).
//!
//! **Signing secrets** (`webhooks.secretGet` / `webhooks.secretSet`) are
//! bridge-only [`WebhookSecretOp`]s, never kernel rows: they need BOTH the app's
//! `webhooks:crud` grant (checked by the bridge) AND the verified signed-in
//! user's own permission, which the reused `/api/webhooks/:id/secret` handlers
//! check (`gateway.configure` for `composio`, otherwise `workflow.edit` on that
//! workflow). A sidecar carries no user, so an app grant alone can never read or
//! rotate a secret. The op is a separate type from [`WebhookOp`] so the sidecar
//! dispatcher, which matches `WebhookOp` only, cannot reach it.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde_json::{json, Value};

use super::kernel_op::{decode_handler_reply, KernelOpError};
use super::ServerState;
use crate::identity_verify::VerifiedCaller;

/// The grant both operations require. Already in the Gateway's reviewed
/// vocabulary and already declared by `@ryu/webhooks`.
pub(crate) const GRANT_WEBHOOKS: &str = "webhooks:crud";

/// One read-only operation over Core's webhook registry. The wire name is the
/// same on the kernel-capability table and the app host bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WebhookOp {
    /// The full endpoint registry with resolved public URLs.
    List,
    /// The active ingress backend and its public URL.
    IngressStatus,
}

impl WebhookOp {
    /// The operation a capability / host-method name selects, if any.
    pub(crate) fn from_name(name: &str) -> Option<Self> {
        match name {
            "webhooks.list" => Some(Self::List),
            "webhooks.ingressStatus" => Some(Self::IngressStatus),
            _ => None,
        }
    }

    /// Answer the operation. Infallible: missing ingress reads as `up: false`.
    pub(crate) async fn run(self, state: &ServerState) -> Value {
        match self {
            Self::List => registry(state).await,
            Self::IngressStatus => ingress_status(state).await,
        }
    }
}

/// The longest endpoint id a secret operation accepts (`composio` or a
/// workflow id).
const MAX_SECRET_ID_CHARS: usize = 256;

/// One signing-secret operation, reached only through the app host bridge
/// (never a `KERNEL_CAPABILITIES` row: a sidecar has no user to check).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WebhookSecretOp {
    /// Read one endpoint's signing secret.
    Get,
    /// Set (or mint, when none is supplied) one workflow endpoint's secret.
    Set,
}

/// `{ id, secret? }`. Unknown keys are refused, so an identity can never ride
/// along in the args.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SecretArgs {
    id: String,
    #[serde(default)]
    secret: Option<String>,
}

impl WebhookSecretOp {
    /// The operation a host-method name selects, if any.
    pub(crate) fn from_name(name: &str) -> Option<Self> {
        match name {
            "webhooks.secretGet" => Some(Self::Get),
            "webhooks.secretSet" => Some(Self::Set),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Get => "webhooks.secretGet",
            Self::Set => "webhooks.secretSet",
        }
    }

    /// Run the operation for `caller`, the verified signed-in user (or `None`),
    /// through the same handlers `GET`/`POST /api/webhooks/:id/secret` use, so
    /// the per-endpoint permission check is the route's own.
    pub(crate) async fn run(
        self,
        state: &ServerState,
        caller: &Option<VerifiedCaller>,
        args: &Value,
    ) -> Result<Value, KernelOpError> {
        let SecretArgs { id, secret } = serde_json::from_value(args.clone()).map_err(|e| {
            KernelOpError::invalid(format!(
                "{} expects {{ id: string, secret?: string }}: {e}",
                self.name()
            ))
        })?;
        let id = id.trim();
        if id.is_empty() || id.chars().count() > MAX_SECRET_ID_CHARS {
            return Err(KernelOpError::invalid(format!(
                "{} requires an endpoint id of 1-{MAX_SECRET_ID_CHARS} characters",
                self.name()
            )));
        }
        if id.chars().any(char::is_control) {
            return Err(KernelOpError::invalid(format!(
                "{} endpoint id must not contain control characters",
                self.name()
            )));
        }
        let response = match self {
            Self::Get => {
                if secret.is_some() {
                    return Err(KernelOpError::invalid("webhooks.secretGet takes no secret"));
                }
                super::webhook_secret_get_authorized(
                    State(state.clone()),
                    Extension(caller.clone()),
                    Path(id.to_owned()),
                )
                .await
            }
            Self::Set => {
                super::webhook_secret_set_authorized(
                    State(state.clone()),
                    Extension(caller.clone()),
                    Path(id.to_owned()),
                    Json(super::WebhookSecretBody { secret }),
                )
                .await
            }
        };
        let value = decode_handler_reply(response).await?;
        // The handlers answer `{ secret }`; anything else is a server fault, not
        // something to forward.
        if value.get("secret").is_some_and(Value::is_string) {
            Ok(value)
        } else {
            Err(KernelOpError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "webhook secret handler returned no secret",
            ))
        }
    }
}

/// The active ingress backend, its public URL (if resolved), and whether
/// ingress is up (a public URL has been resolved).
pub(crate) async fn ingress_status(state: &ServerState) -> Value {
    let kind = crate::webhook_ingress::configured_kind(&state.preferences).await;
    let public_url = crate::webhook_ingress::public_url();
    let up = public_url.is_some();
    // The managed relay cannot start without a Ryu server to register with; say
    // so instead of leaving only a null `public_url`.
    let reason = (kind == crate::webhook_ingress::IngressKind::RyuRelay
        && !up
        && crate::webhook_ingress::relay_server_base().is_none())
    .then_some("no_ryu_server");
    json!({
        "kind": kind.as_str(),
        "public_url": public_url,
        "up": up,
        "reason": reason,
    })
}

/// The unified webhook endpoint registry: the Composio webhook and every
/// workflow that declares a `Webhook` trigger, each with its resolved public URL,
/// whether a secret is configured, and its last-delivery time.
pub(crate) async fn registry(state: &ServerState) -> Value {
    let kind = crate::webhook_ingress::configured_kind(&state.preferences).await;
    // `base` is Some ONLY when the active ingress is a true origin that forwards
    // every path (the tunnel backends). Under the managed RyuRelay it is None, so
    // per-path (workflow) URLs are advertised as null rather than a dead URL.
    let base = crate::webhook_ingress::public_base_url();
    // The raw stored public URL — the relay's own composio ingress endpoint, or
    // `<origin>/api/composio/webhook` for the tunnel backends. Either way this is
    // the actual URL composio should POST to, so it is the composio endpoint URL.
    let raw_public_url = crate::webhook_ingress::public_url();
    let up = raw_public_url.is_some();

    // Resolve a per-endpoint public URL. A true path-forwarding origin (the tunnel
    // backends) gives `<origin><path>`. Under RyuRelay there is no origin base, but a
    // path IS reachable through the relay's generic inbound endpoint
    // (`<relay>/api/composio-relay/inbound/<token>/<path>`), so fall back to that so
    // a workflow webhook is discoverable on the default ingress too. `None` only when
    // neither is available (e.g. relay not yet registered).
    let resolve = |path: &str| -> Option<String> {
        base.as_ref()
            .map(|b| format!("{b}{path}"))
            .or_else(|| crate::webhook_ingress::relay_inbound_url(path))
    };

    let mut endpoints: Vec<Value> = Vec::new();

    // (1) The composio webhook — one endpoint, N subscriptions. Its reachable URL
    // is the raw stored public URL (the relay ingress, or origin+path), NOT a
    // base-composed path — so it is populated even under RyuRelay.
    let composio_path = crate::webhook_ingress::WEBHOOK_PATH;
    let composio_subs = match crate::composio_triggers::global() {
        Some(store) => store.list().await.map(|s| s.len()).unwrap_or(0),
        None => 0,
    };
    endpoints.push(json!({
        "kind": "composio",
        "id": "composio",
        "label": "Composio triggers",
        "path": composio_path,
        "public_url": raw_public_url,
        "has_secret": crate::composio_triggers::webhook_secret().is_some(),
        "subscription_count": composio_subs,
        "last_delivery": crate::webhook_ingress::last_delivery(composio_path),
    }));

    // (2) Every workflow that declares a Webhook trigger.
    for wf in crate::workflow::store::list_workflows() {
        for trigger in &wf.triggers {
            if let crate::workflow::WorkflowTrigger::Webhook { secret } = trigger {
                let path = crate::webhook_ingress::workflow_webhook_path(&wf.id);
                let has_secret = secret.as_ref().is_some_and(|s| !s.trim().is_empty());
                endpoints.push(json!({
                    "kind": "workflow",
                    "id": wf.id,
                    "label": wf.name,
                    "workflow_id": wf.id,
                    "workflow_name": wf.name,
                    "path": path,
                    "public_url": resolve(&path),
                    "has_secret": has_secret,
                    "last_delivery": crate::webhook_ingress::last_delivery(&path),
                }));
            }
        }
    }

    json!({
        "ingress_kind": kind.as_str(),
        "public_base_url": base,
        "up": up,
        "endpoints": endpoints,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_names_match_the_host_api_methods_and_their_grant() {
        for (name, op) in [
            ("webhooks.list", WebhookOp::List),
            ("webhooks.ingressStatus", WebhookOp::IngressStatus),
        ] {
            assert_eq!(WebhookOp::from_name(name), Some(op));
            // The Companion path gates on the host-API table's grant; it must be
            // the same existing grant the kernel-capability rows use.
            assert_eq!(
                ryu_kernel_contracts::host_api::grant_for(name),
                Some(GRANT_WEBHOOKS),
                "{name}"
            );
        }
        // The secret verbs are not kernel rows; bridge-only via WebhookSecretOp
        // (they need the verified user).
        assert_eq!(WebhookOp::from_name("webhooks.secretGet"), None);
        assert_eq!(WebhookOp::from_name("webhooks.secretSet"), None);
    }

    const APP: &str = "@example/hooks";

    fn org_caller(user_id: &str, role: crate::identity_verify::OrgRole) -> VerifiedCaller {
        VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org-1".to_owned()),
            role,
            teams: Vec::new(),
        }
    }

    fn org_node() -> crate::sidecar::control_plane::RegisteredNode {
        use crate::sidecar::control_plane::{NodeScope, RegisteredNode, RegisteredOrg};
        RegisteredNode {
            org: RegisteredOrg {
                id: "org-1".to_owned(),
                name: "Org".to_owned(),
                slug: None,
            },
            node_id: "node-1".to_owned(),
            scope: NodeScope::Org,
            team_id: None,
            owner_user_id: None,
        }
    }

    /// An enabled app whose manifest declares only `webhooks:crud`, approved or not.
    async fn app_state(directory: &std::path::Path, approved: bool) -> ServerState {
        let state = crate::server::isolated_plugin_hook_test_state(directory);
        state.app_store.insert(APP, "1.0.0").await.unwrap();
        let grants: Vec<String> = if approved {
            vec![GRANT_WEBHOOKS.to_owned()]
        } else {
            Vec::new()
        };
        state.app_store.set_enabled(APP, &grants).await.unwrap();
        let manifest: crate::plugin_manifest::PluginManifest = serde_json::from_value(json!({
            "id": APP, "name": "Hooks", "version": "1.0.0", "runnables": [],
            "permission_grants": [GRANT_WEBHOOKS],
        }))
        .unwrap();
        state.app_manifests.write().await.push(manifest);
        state
    }

    /// A persisted workflow in the process-wide workflow store, deleted again on
    /// drop (a failed assertion included), so no test leaves a live webhook
    /// endpoint with a known secret in the developer's data directory.
    struct WebhookWorkflow(String);

    impl Drop for WebhookWorkflow {
        fn drop(&mut self) {
            let _ = crate::workflow::store::delete_workflow(&self.0);
        }
    }

    /// A persisted workflow with one Webhook trigger holding `secret`.
    fn webhook_workflow(secret: &str) -> WebhookWorkflow {
        let id = format!("wf-secret-{}", uuid::Uuid::new_v4().simple());
        crate::workflow::store::save_workflow(&crate::workflow::Workflow {
            id: id.clone(),
            name: "secret bridge test".to_owned(),
            description: None,
            nodes: Vec::new(),
            edges: Vec::new(),
            triggers: vec![crate::workflow::WorkflowTrigger::Webhook {
                secret: Some(secret.to_owned()),
            }],
            max_concurrency: None,
            created_at: None,
            updated_at: None,
        })
        .expect("save workflow");
        WebhookWorkflow(id)
    }

    fn stored_secret(id: &str) -> Option<String> {
        crate::workflow::store::load_workflow(id)
            .unwrap()
            .triggers
            .into_iter()
            .find_map(|trigger| match trigger {
                crate::workflow::WorkflowTrigger::Webhook { secret } => secret,
                _ => None,
            })
    }

    async fn bridge(
        state: &ServerState,
        caller: Option<VerifiedCaller>,
        method: &str,
        args: Value,
    ) -> (StatusCode, Value) {
        let response = crate::server::plugin_bridge_api::plugin_bridge_dispatch(
            State(state.clone()),
            Extension(caller),
            Path(APP.to_owned()),
            axum::http::HeaderMap::new(),
            Json(crate::server::plugin_bridge_api::HostDispatchBody {
                method: method.to_owned(),
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

    const ORIGINAL: &str = "original-secret-0123456789";

    #[test]
    fn secret_ops_are_bridge_only() {
        for (name, op) in [
            ("webhooks.secretGet", WebhookSecretOp::Get),
            ("webhooks.secretSet", WebhookSecretOp::Set),
        ] {
            assert_eq!(WebhookSecretOp::from_name(name), Some(op));
            assert_eq!(
                ryu_kernel_contracts::host_api::grant_for(name),
                Some(GRANT_WEBHOOKS),
                "{name}"
            );
            assert_eq!(WebhookOp::from_name(name), None, "{name}");
        }
        assert_eq!(WebhookSecretOp::from_name("webhooks.list"), None);
    }

    #[tokio::test]
    async fn secret_bridge_refuses_without_the_grant() {
        let directory = tempfile::tempdir().unwrap();
        let state = app_state(directory.path(), false).await;
        let workflow = webhook_workflow(ORIGINAL);
        let id = workflow.0.clone();
        for (method, args) in [
            ("webhooks.secretGet", json!({ "id": id })),
            (
                "webhooks.secretSet",
                json!({ "id": id, "secret": "replacement-secret-0123456789" }),
            ),
        ] {
            let (status, body) = bridge(&state, None, method, args).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method}: {body}");
            assert_eq!(body["error"]["code"], "denied", "{method}");
            assert!(!body.to_string().contains(ORIGINAL), "{body}");
        }
        assert_eq!(stored_secret(&id).as_deref(), Some(ORIGINAL));
    }

    #[tokio::test]
    async fn secret_bridge_refuses_without_user_permission() {
        use crate::identity_verify::OrgRole;
        let directory = tempfile::tempdir().unwrap();
        let state = app_state(directory.path(), true).await;
        let workflow = webhook_workflow(ORIGINAL);
        let id = workflow.0.clone();
        crate::sidecar::control_plane::with_test_node_binding(true, Some(org_node()), async {
            let member = Some(org_caller("member-1", OrgRole::Member));
            for (caller, method, args) in [
                (
                    member.clone(),
                    "webhooks.secretGet",
                    json!({ "id": "composio" }),
                ),
                (member.clone(), "webhooks.secretGet", json!({ "id": id })),
                (
                    member,
                    "webhooks.secretSet",
                    json!({ "id": id, "secret": "replacement-secret-0123456789" }),
                ),
                (None, "webhooks.secretGet", json!({ "id": id })),
                (None, "webhooks.secretSet", json!({ "id": id })),
            ] {
                let (status, body) = bridge(&state, caller, method, args).await;
                assert_eq!(status, StatusCode::FORBIDDEN, "{method}: {body}");
                assert_eq!(body["error"]["code"], "denied", "{method}");
                assert!(!body.to_string().contains(ORIGINAL), "{body}");
            }
        })
        .await;
        assert_eq!(stored_secret(&id).as_deref(), Some(ORIGINAL));
    }

    #[tokio::test]
    async fn secret_bridge_works_with_grant_and_user() {
        use crate::identity_verify::OrgRole;
        let directory = tempfile::tempdir().unwrap();
        let state = app_state(directory.path(), true).await;
        let workflow = webhook_workflow(ORIGINAL);
        let id = workflow.0.clone();
        crate::sidecar::control_plane::with_test_node_binding(true, Some(org_node()), async {
            let admin = Some(org_caller("admin-1", OrgRole::Admin));
            let (status, body) = bridge(
                &state,
                admin.clone(),
                "webhooks.secretGet",
                json!({ "id": id }),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["result"], json!({ "secret": ORIGINAL }));

            let chosen = "chosen-secret-0123456789";
            let (status, body) = bridge(
                &state,
                admin.clone(),
                "webhooks.secretSet",
                json!({ "id": id, "secret": chosen }),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["result"], json!({ "secret": chosen }));
            let (_, body) = bridge(
                &state,
                admin.clone(),
                "webhooks.secretGet",
                json!({ "id": id }),
            )
            .await;
            assert_eq!(body["result"], json!({ "secret": chosen }));
        })
        .await;
        assert_eq!(
            stored_secret(&id).as_deref(),
            Some("chosen-secret-0123456789")
        );

        // An unbound node with no signed-in user is the single local operator,
        // exactly as over HTTP.
        crate::sidecar::control_plane::with_test_node_binding(false, None, async {
            let (status, body) =
                bridge(&state, None, "webhooks.secretSet", json!({ "id": id })).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            let minted = body["result"]["secret"].as_str().unwrap().to_owned();
            assert!(minted.len() >= 32, "{minted}");
            assert_eq!(stored_secret(&id).as_deref(), Some(minted.as_str()));

            for (method, args, status, code) in [
                (
                    "webhooks.secretSet",
                    json!({ "id": id, "secret": "short" }),
                    StatusCode::BAD_REQUEST,
                    "invalid_args",
                ),
                (
                    "webhooks.secretSet",
                    json!({ "id": "composio", "secret": "replacement-secret-0123456789" }),
                    StatusCode::CONFLICT,
                    "invalid_args",
                ),
                (
                    "webhooks.secretGet",
                    json!({ "id": "wf-does-not-exist" }),
                    StatusCode::NOT_FOUND,
                    "not_found",
                ),
                (
                    "webhooks.secretGet",
                    json!({ "id": id, "user_id": "mallory" }),
                    StatusCode::BAD_REQUEST,
                    "invalid_args",
                ),
                (
                    "webhooks.secretGet",
                    json!({ "id": id, "secret": "x" }),
                    StatusCode::BAD_REQUEST,
                    "invalid_args",
                ),
                (
                    "webhooks.secretGet",
                    json!({ "id": "  " }),
                    StatusCode::BAD_REQUEST,
                    "invalid_args",
                ),
                (
                    "webhooks.secretGet",
                    json!({ "id": "wf\u{0}x" }),
                    StatusCode::BAD_REQUEST,
                    "invalid_args",
                ),
                (
                    "webhooks.secretGet",
                    Value::Null,
                    StatusCode::BAD_REQUEST,
                    "invalid_args",
                ),
            ] {
                let (got, body) = bridge(&state, None, method, args.clone()).await;
                assert_eq!(got, status, "{method} {args}: {body}");
                assert_eq!(body["error"]["code"], code, "{method} {args}");
            }
            // The handlers' own 4xx messages reach the Companion verbatim.
            let (_, body) = bridge(
                &state,
                None,
                "webhooks.secretSet",
                json!({ "id": id, "secret": "short" }),
            )
            .await;
            assert_eq!(
                body["error"]["message"],
                "webhook secret must be at least 16 characters"
            );
        })
        .await;
    }

    #[tokio::test]
    async fn registry_and_status_are_metadata_only() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(dir.path());
        let registry = WebhookOp::List.run(&state).await;
        assert!(registry["endpoints"].is_array(), "{registry}");
        for endpoint in registry["endpoints"].as_array().unwrap() {
            assert!(endpoint.get("secret").is_none(), "{endpoint}");
            assert!(endpoint["has_secret"].is_boolean(), "{endpoint}");
        }
        let status = WebhookOp::IngressStatus.run(&state).await;
        assert!(
            status["kind"].is_string() && status["up"].is_boolean(),
            "{status}"
        );
    }
}
