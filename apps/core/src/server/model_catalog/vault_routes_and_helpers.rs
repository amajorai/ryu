//! Vault route builders, shared JSON helpers, the model catalog and Composio integrations: `vault_public_routes` through `oai_chat_completions`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Vault routes that authenticate in-handler (machine logins and
/// vault-token agent routes) rather than with the node bearer. Every one
/// rides `request_layer`, so login quotas, the client address that CIDR
/// bindings check, `X-Ryu-Wrap-TTL` wrapping, and the token-accessor audit
/// context apply to them exactly as they do on the protected vault routes.
pub(in crate::server) fn vault_public_routes() -> Router<ServerState> {
    Router::new()
        .merge(vault_engines_api::public_routes())
        .merge(vault_broker_api::public_routes())
        .merge(vault_totp_pwpolicy_api::public_routes())
        .merge(vault_crypto_api::public_routes())
        // HashiCorp Vault-compatible `/v1/*` KV v2 + auth surface; same
        // in-handler machine-token authentication (`X-Vault-Token`).
        .merge(vault_compat_api::public_routes())
        // TLS cert, AWS IAM, and Kubernetes machine login (same in-handler
        // authentication as AppRole/JWT).
        .merge(vault_seal_dynamic_api::public_routes())
        .layer(axum::middleware::from_fn(vault_tokens_api::request_layer))
        // Already carries its own `request_layer`; merged after the layer so
        // it is not applied twice.
        .merge(vault_tokens_api::public_routes())
}

/// Protected Secret Vault routes (node bearer plus optional user JWT).
pub(in crate::server) fn vault_routes() -> Router<ServerState> {
    use axum::routing::patch;
    use vault_api as kv;
    use vault_engines_api as engines;
    let body = || DefaultBodyLimit::max(vault_api::MAX_REQUEST_BODY_BYTES);
    let bulk = || DefaultBodyLimit::max(vault_api::MAX_BULK_BODY_BYTES);
    Router::new()
        .route("/api/vault/secrets", get(kv::list_secrets))
        .route(
            "/api/vault/secrets/:name",
            put(kv::put_secret).delete(kv::delete_secret).layer(body()),
        )
        .route("/api/vault/secrets/:name/versions", get(kv::list_versions))
        .route(
            "/api/vault/secrets/:name/:action",
            post(kv::secret_action).layer(body()),
        )
        .route("/api/vault/export", post(kv::export).layer(body()))
        .route("/api/vault/import", post(kv::import).layer(bulk()))
        .route(
            "/api/vault/snapshot",
            post(kv::snapshot_export).layer(body()),
        )
        .route("/api/vault/scan", post(kv::scan).layer(bulk()))
        .route("/api/vault/environments", get(kv::list_environments))
        .route(
            "/api/vault/environments/:slug",
            put(kv::put_environment)
                .delete(kv::delete_environment)
                .layer(body()),
        )
        .route(
            "/api/vault/folders",
            get(kv::list_folders)
                .post(kv::create_folder)
                .delete(kv::delete_folder)
                .layer(body()),
        )
        .route(
            "/api/vault/imports",
            get(kv::list_imports).post(kv::add_import).layer(body()),
        )
        .route("/api/vault/imports/:id", delete(kv::remove_import))
        .route("/api/vault/policies", get(kv::list_policies))
        .route(
            "/api/vault/policies/:name",
            put(kv::put_policy).delete(kv::delete_policy).layer(body()),
        )
        .route(
            "/api/vault/policy-bindings",
            post(kv::add_binding).layer(body()),
        )
        .route("/api/vault/policy-bindings/:id", delete(kv::remove_binding))
        .route("/api/vault/change-requests", get(kv::list_change_requests))
        .route(
            "/api/vault/change-requests/:id/:decision",
            post(kv::decide_change_request).layer(body()),
        )
        .route("/api/vault/audit", get(kv::list_audit))
        .route("/api/vault/audit/verify", get(kv::verify_audit))
        .route(
            "/api/vault/audit/devices",
            get(vault_audit_events_api::list_devices),
        )
        .route(
            "/api/vault/audit/devices/:id",
            put(vault_audit_events_api::put_device)
                .delete(vault_audit_events_api::delete_device)
                .layer(body()),
        )
        .route(
            "/api/vault/sys/audit-hash",
            post(vault_audit_events_api::audit_hash).layer(body()),
        )
        .route(
            "/api/vault/sys/init/apply",
            post(vault_audit_events_api::init_apply),
        )
        .route("/api/vault/events", get(vault_audit_events_api::events))
        .route("/api/vault/sys/status", get(kv::sys_status))
        .route("/api/vault/sys/:action", post(kv::sys_action).layer(body()))
        .route("/api/vault/migrate-shared", post(kv::migrate_shared))
        .route(
            "/api/vault/transit/keys",
            get(engines::transit_list)
                .post(engines::transit_create)
                .layer(body()),
        )
        .route(
            "/api/vault/transit/keys/:name",
            patch(engines::transit_configure)
                .delete(engines::transit_delete)
                .layer(body()),
        )
        .route(
            "/api/vault/transit/:op/:name",
            post(engines::transit_operation).layer(DefaultBodyLimit::max(
                2 * crate::vault::transit::MAX_INPUT_BYTES,
            )),
        )
        .route(
            "/api/vault/pki/issuers",
            get(engines::pki_issuers)
                .post(engines::pki_create_issuer)
                .layer(body()),
        )
        .route(
            "/api/vault/pki/issuers/:name/certs",
            get(engines::pki_certs),
        )
        .route("/api/vault/pki/issuers/:name/crl", get(engines::pki_crl))
        .route("/api/vault/pki/roles", get(engines::pki_roles))
        .route(
            "/api/vault/pki/roles/:name",
            put(engines::pki_put_role)
                .delete(engines::pki_delete_role)
                .layer(body()),
        )
        .route(
            "/api/vault/pki/revoke",
            post(engines::pki_revoke).layer(body()),
        )
        .route(
            "/api/vault/pki/:op/:role",
            post(engines::pki_operation).layer(body()),
        )
        .route(
            "/api/vault/ssh/cas",
            get(engines::ssh_cas)
                .post(engines::ssh_create_ca)
                .layer(body()),
        )
        .route("/api/vault/ssh/roles", get(engines::ssh_roles))
        .route(
            "/api/vault/ssh/roles/:name",
            put(engines::ssh_put_role)
                .delete(engines::ssh_delete_role)
                .layer(body()),
        )
        .route(
            "/api/vault/ssh/sign/:role",
            post(engines::ssh_sign).layer(body()),
        )
        .route("/api/vault/dynamic/roles", get(engines::dynamic_roles))
        .route(
            "/api/vault/dynamic/roles/:name",
            put(engines::dynamic_put_role)
                .delete(engines::dynamic_delete_role)
                .layer(body()),
        )
        .route(
            "/api/vault/dynamic/roles/:name/revoke-all",
            post(engines::dynamic_revoke_role),
        )
        .route(
            "/api/vault/dynamic/issue/:role",
            post(engines::dynamic_issue).layer(body()),
        )
        .route("/api/vault/leases", get(engines::leases))
        .route(
            "/api/vault/leases/:id/:op",
            post(engines::lease_operation).layer(body()),
        )
        .route(
            "/api/vault/machines",
            get(engines::machines)
                .post(engines::machine_create)
                .layer(body()),
        )
        .route(
            "/api/vault/machines/:id",
            patch(engines::machine_update)
                .delete(engines::machine_delete)
                .layer(body()),
        )
        .route(
            "/api/vault/machines/:id/secret-ids",
            get(engines::machine_secret_ids)
                .post(engines::machine_issue_secret_id)
                .layer(body()),
        )
        .route(
            "/api/vault/secret-ids/:accessor",
            delete(engines::machine_revoke_secret_id),
        )
        .route(
            "/api/vault/tokens/:accessor/revoke",
            post(engines::token_revoke),
        )
        .merge(vault_broker_api::routes())
        .merge(vault_totp_pwpolicy_api::routes())
        .merge(vault_kv_api::routes())
        .merge(vault_policy_ext_api::routes())
        .merge(vault_crypto_api::routes())
        .merge(vault_external_api::routes())
        .merge(vault_pm_api::routes())
        .merge(vault_items_api::routes())
        .merge(vault_agent_accounts_api::routes())
        .merge(vault_seal_dynamic_api::routes())
        .merge(vault_tokens_api::routes())
        // Client address, quotas, and `X-Ryu-Wrap-TTL` response wrapping.
        .layer(axum::middleware::from_fn(vault_tokens_api::request_layer))
}

/// Status for a failed catalog-source search: a `cursor` the source could not
/// have issued is the caller's mistake (400, as the Marketplace answers it);
/// anything else is an upstream failure (502).
pub(in crate::server) fn catalog_search_error_status(error: &anyhow::Error) -> StatusCode {
    if error
        .downcast_ref::<crate::catalog_source::InvalidCatalogCursor>()
        .is_some()
    {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::BAD_GATEWAY
    }
}

pub(in crate::server) fn json_error(status: StatusCode, msg: String) -> axum::response::Response {
    // Serialize via serde so quotes/backslashes/control chars in `msg`
    // (e.g. serde parse errors, resolver errors) can't produce malformed JSON.
    let body = json!({ "error": msg }).to_string();
    axum::response::Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response())
}

pub(in crate::server) fn no_store_response(
    mut response: axum::response::Response,
) -> axum::response::Response {
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    response
}

#[utoipa::path(
    post,
    path = "/v1/chat/completions",
    tag = "Chat",
    summary = "OpenAI-compatible chat completions (proxied)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn oai_chat_completions(
    State(state): State<ServerState>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    use axum::{body::Body, http::StatusCode};

    let json_body: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, format!("invalid json: {e}")),
    };

    let model = json_body
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let is_stream = json_body
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let upstream_base = if model.starts_with("zeroclaw") {
        "http://127.0.0.1:42617"
    } else if model.starts_with("openclaw") {
        "http://127.0.0.1:3118"
    } else {
        "http://127.0.0.1:11434"
    };

    // Ollama launch settings live in a derived model (see
    // `sidecar::providers::ollama::derived`); serve the base name from it.
    let body = match (upstream_base == "http://127.0.0.1:11434")
        .then(|| crate::sidecar::providers::ollama::derived::routed_model(model))
        .flatten()
    {
        Some(derived) => {
            let mut routed = json_body.clone();
            routed["model"] = serde_json::Value::String(derived);
            match serde_json::to_vec(&routed) {
                Ok(bytes) => axum::body::Bytes::from(bytes),
                Err(_) => body,
            }
        }
        None => body,
    };

    let url = format!("{upstream_base}/v1/chat/completions");
    tracing::debug!(model, upstream = %url, stream = is_stream, "oai_chat_completions: routing");

    let upstream_resp = match state
        .client
        .post(&url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return json_error(
                StatusCode::BAD_GATEWAY,
                format!("upstream unreachable: {e}"),
            );
        }
    };

    let status = upstream_resp.status();
    let content_type = upstream_resp
        .headers()
        .get("content-type")
        .cloned()
        .unwrap_or_else(|| axum::http::HeaderValue::from_static("application/json"));

    let mut builder = axum::response::Response::builder()
        .status(status)
        .header("content-type", content_type);

    if is_stream {
        builder = builder
            .header("cache-control", "no-cache")
            .header("x-accel-buffering", "no");
    }

    builder
        .body(Body::from_stream(upstream_resp.bytes_stream()))
        .unwrap()
}
