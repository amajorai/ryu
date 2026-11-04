//! App catalog browse, install-from-URL and hot reload: `install_app_from_url` through `install_app_from_url`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/apps/install` — install an app by fetching its `ryu.json` from an
/// `https://` URL, validating it, writing it under the apps dir, and hot-reloading.
///
/// ## Security (SSRF guard)
///
/// Only `https://` URLs are accepted. The host is resolved with `getaddrinfo`
/// and rejected if *any* resolved IP is loopback / private / link-local / ULA /
/// CGNAT (so a DNS name pointing at an internal address is caught, not just
/// literal IPs). The fetch client is then pinned to those validated IPs (no
/// re-resolution, defeating DNS rebinding) and redirects are disabled so a
/// remote cannot bounce the request to an internal host after the check.
#[utoipa::path(
    post,
    path = "/api/plugins/install",
    tag = "Plugins",
    summary = "Install a plugin from a URL",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn install_app_from_url(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<InstallFromUrlRequest>,
) -> axum::response::Response {
    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_INSTALL,
    )
    .await
    {
        return response;
    }

    let url = body.url.trim().to_string();
    if !url.starts_with("https://") {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Only https:// URLs are allowed".to_owned(),
        );
    }

    // Parse the URL and pull out the host + port for resolution.
    let parsed = match url::Url::parse(&url) {
        Ok(p) => p,
        Err(e) => {
            return json_error(StatusCode::BAD_REQUEST, format!("Invalid URL: {e}"));
        }
    };
    let host = match parsed.host_str() {
        Some(h) => h.to_owned(),
        None => {
            return json_error(StatusCode::BAD_REQUEST, "URL has no host".to_owned());
        }
    };
    if host.eq_ignore_ascii_case("localhost") {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Private/loopback URLs are not allowed".to_owned(),
        );
    }
    if let Err(e) = screen_guarded_hostname(&host) {
        return json_error(StatusCode::BAD_REQUEST, e);
    }
    let port = parsed.port_or_known_default().unwrap_or(443);

    // Resolve the host (getaddrinfo) off the async runtime and reject if ANY
    // resolved IP is private/loopback/link-local/etc. This catches DNS names
    // that point at internal addresses, not just literal IPs.
    let resolve_host = host.clone();
    let resolved: Vec<std::net::SocketAddr> = match tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        (resolve_host.as_str(), port)
            .to_socket_addrs()
            .map(|it| it.collect::<Vec<_>>())
    })
    .await
    {
        Ok(Ok(addrs)) => addrs,
        Ok(Err(e)) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                format!("Failed to resolve host: {e}"),
            );
        }
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("DNS resolution task failed: {e}"),
            );
        }
    };
    if resolved.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Host did not resolve".to_owned());
    }
    if resolved.iter().any(|addr| is_blocked_ip(addr.ip())) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Private/loopback URLs are not allowed".to_owned(),
        );
    }

    // Fetch the manifest with a client pinned to the validated IPs (no
    // re-resolution → no DNS rebinding) and redirects disabled (a remote can't
    // bounce us to an internal host after the check).
    let client = match pin_screened_http_client(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none()),
        &host,
        &resolved,
    )
    .build()
    {
        Ok(c) => c,
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to build HTTP client: {e}"),
            );
        }
    };

    // Cap the manifest body so an allowlisted host can't OOM us with a huge
    // response. A ryu.json manifest is small; 2 MiB is a generous ceiling.
    const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
    let manifest_json = match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            if let Some(len) = resp.content_length() {
                if len > MAX_MANIFEST_BYTES {
                    return json_error(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "Manifest is too large".to_owned(),
                    );
                }
            }
            match resp.bytes().await {
                Ok(bytes) if (bytes.len() as u64) > MAX_MANIFEST_BYTES => {
                    return json_error(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "Manifest is too large".to_owned(),
                    );
                }
                Ok(bytes) => match String::from_utf8(bytes.to_vec()) {
                    Ok(text) => text,
                    Err(e) => {
                        return json_error(
                            StatusCode::UNPROCESSABLE_ENTITY,
                            format!("Manifest is not valid UTF-8: {e}"),
                        );
                    }
                },
                Err(e) => {
                    return json_error(
                        StatusCode::BAD_GATEWAY,
                        format!("Failed to read response: {e}"),
                    );
                }
            }
        }
        Ok(resp) => {
            return json_error(
                StatusCode::BAD_GATEWAY,
                format!("Remote returned status {}", resp.status()),
            );
        }
        Err(e) => {
            return json_error(
                StatusCode::BAD_GATEWAY,
                format!("Failed to fetch manifest: {e}"),
            );
        }
    };

    // A URL install has no signature Core can verify, so the inline node backend
    // is unattested executable code: strip it exactly like the marketplace path
    // strips an unsigned item's backend. What reaches disk is the stripped form.
    let manifest_json = match strip_unattested_url_backend(&manifest_json) {
        Ok(json) => json,
        Err(e) => return json_error(StatusCode::UNPROCESSABLE_ENTITY, e),
    };

    // Parse and validate the manifest.
    let manifest: crate::plugin_manifest::PluginManifest =
        match serde_json::from_str(&manifest_json) {
            Ok(m) => m,
            Err(e) => {
                return json_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    format!("Invalid manifest JSON: {e}"),
                );
            }
        };

    // Sandboxed JS must arrive INLINE here. Only the manifest is persisted by this
    // path — never the sibling `hooks/*.js` / `adapters/*.js` a `code_file` names —
    // so accepting one would install a hook whose body can never be resolved, and an
    // empty body is indistinguishable from a hook that chose to do nothing.
    //
    // Inline hook/adapter `code` is deliberately KEPT, unlike the inline node
    // backend stripped above: it is the only form in which a URL-installed plugin
    // can carry a hook at all (there is no package to resolve `code_file` from).
    // What protects the user is not provenance but containment, all still in force:
    //   - the sandbox: hook/adapter bodies run in Core's JS sandbox with no ambient
    //     authority (no env, filesystem, network or subprocess beyond grants);
    //   - grants: every `host.*` call is checked against the plugin's Gateway-
    //     APPROVED grants, and the install lands disabled, so nothing is approved
    //     until the user enables it (a URL install is Community authority);
    //   - the trust gate: a manifest that does not match a reviewed built-in never
    //     gets automatic hook trust, so its hooks need explicit user trust first.
    if let Err(e) = manifest.validate_code_sources() {
        return json_error(StatusCode::UNPROCESSABLE_ENTITY, e);
    }
    // URL installs have no verified package provenance and are always Community
    // authority: their declarative HTTP may reach only their own ext mount.
    if let Err(error) = manifest.validate_declarative_http_policy(false) {
        return json_error(StatusCode::UNPROCESSABLE_ENTITY, error);
    }

    // Validate the app id BEFORE it is ever used as a filesystem path component
    // (see `apps_dir().join(&manifest.id)` below). A crafted id like
    // "../../etc/x" or an absolute/drive-qualified path would otherwise escape
    // the apps directory and write an arbitrary file. `validate_plugin_id` uses a
    // strict allowlist, so traversal and absolute-path ids are both rejected.
    if let Err(e) = crate::plugin_manifest::validate_plugin_id(&manifest.id) {
        return json_error(StatusCode::UNPROCESSABLE_ENTITY, e);
    }

    // Validate semver up front so a bad version is a 422, not a silent install.
    if semver::Version::parse(&manifest.version).is_err() {
        return json_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "manifest version '{}' is not valid semver",
                manifest.version
            ),
        );
    }

    // Validate each Runnable's per-kind config contract.
    for entry in &manifest.runnables {
        if let Err(e) = crate::plugin_manifest::schema::validate_runnable(entry) {
            return json_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("Invalid runnable '{}': {e}", entry.id),
            );
        }
    }

    // Reject a duplicate id (don't clobber an existing app).
    {
        let manifests = state.app_manifests.read().await;
        if manifests.iter().any(|m| m.id == manifest.id) {
            return json_error(
                StatusCode::CONFLICT,
                format!("App '{}' is already installed", manifest.id),
            );
        }
    }

    // Write to disk under the plugins dir (same resolver the loader reads from).
    let app_dir = crate::plugin_manifest::PluginManifestLoader::plugins_dir()
        .join(crate::plugin_manifest::plugin_dir_name(&manifest.id));
    if let Err(e) = tokio::fs::create_dir_all(&app_dir).await {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to create plugin directory: {e}"),
        );
    }
    let manifest_path = app_dir.join(crate::plugin_manifest::MANIFEST_FILE_NAME);
    if let Err(e) = tokio::fs::write(&manifest_path, &manifest_json).await {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to write manifest: {e}"),
        );
    }

    // Hot-reload so the new app appears in `GET /api/apps` without a restart.
    reload_manifests_inner(&state).await;

    Json(json!({
        "success": true,
        "app": { "id": manifest.id, "name": manifest.name, "version": manifest.version }
    }))
    .into_response()
}
