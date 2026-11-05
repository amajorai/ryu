//! Admission of web-delegated requests.

use super::*;

/// The facts [`web_delegated_admission`] needs from the manifest snapshot, captured
/// while [`proxy_for_plugin`] still holds the manifest guard (the gate itself runs
/// after the guard is dropped, so it never nests a second read of the same lock).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct WebDelegationFacts {
    /// Whether the matched route declares a per-route `permission`.
    pub(super) route_declares_permission: bool,
    /// Whether the TARGET app strictly supports the web surface.
    pub(super) target_supports_web: bool,
    /// The named calling app, when the header held a valid id of an installed app.
    pub(super) caller_app: Option<WebCallerApp>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct WebCallerApp {
    pub(super) id: String,
    pub(super) supports_web: bool,
    pub(super) has_companion: bool,
}

/// Whether `manifest` declares the web surface at `full` or `limited`.
///
/// Deliberately NOT [`crate::plugin_manifest::PluginManifest::supports_surface`]: that
/// reads an absent `surfaces` map with empty legacy `targets` as "every surface" and an
/// unknown support level as supported, which is the right listing default but the wrong
/// answer for a credential-bearing web hop. Here an absent map, an absent key, and every
/// other level fail closed.
pub(super) fn strictly_supports_web(manifest: &crate::plugin_manifest::PluginManifest) -> bool {
    use crate::plugin_manifest::{Surface, SurfaceSupport};
    let Some(entry) = manifest
        .surfaces
        .as_ref()
        .and_then(|surfaces| surfaces.get(&Surface::Web))
    else {
        return false;
    };
    match entry.support {
        SurfaceSupport::Full | SurfaceSupport::Limited => true,
        SurfaceSupport::List
        | SurfaceSupport::Commands
        | SurfaceSupport::None
        | SurfaceSupport::Unknown => false,
    }
}

/// Capture the web-delegation facts for `target` from the manifest snapshot.
pub(super) fn web_delegation_facts(
    manifests: &[crate::plugin_manifest::PluginManifest],
    target: &crate::plugin_manifest::PluginManifest,
    route_declares_permission: bool,
    headers: &HeaderMap,
) -> WebDelegationFacts {
    let caller_app = headers
        .get(HDR_APP_CALLER)
        .and_then(|value| value.to_str().ok())
        .filter(|id| crate::plugin_manifest::validate_plugin_id(id).is_ok())
        .and_then(|id| manifests.iter().find(|manifest| manifest.id == id))
        .map(|manifest| WebCallerApp {
            id: manifest.id.clone(),
            supports_web: strictly_supports_web(manifest),
            has_companion: manifest
                .runnables
                .iter()
                .any(|entry| entry.kind == crate::runnable::RunnableKind::Companion),
        });
    WebDelegationFacts {
        route_declares_permission,
        target_supports_web: strictly_supports_web(target),
        caller_app,
    }
}

/// The manifest half of the web-delegated gate. Every refusal is a 404, the same
/// answer as an undeclared route or a disabled app, so a web caller cannot enumerate
/// which routes exist but are not web-reachable.
pub(super) fn web_delegated_route_gate(
    facts: &WebDelegationFacts,
) -> Result<&WebCallerApp, StatusCode> {
    if !(facts.route_declares_permission && facts.target_supports_web) {
        return Err(StatusCode::NOT_FOUND);
    }
    let caller_app = facts.caller_app.as_ref().ok_or(StatusCode::NOT_FOUND)?;
    if !(caller_app.supports_web && caller_app.has_companion) {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(caller_app)
}

/// The one reviewed grant edge a web-delegated request rides: `app:http` for the
/// calling app's own sidecar, or exactly `app:http:<target>` for another app's.
pub(super) fn web_caller_required_grant(caller_app: &str, target: &str) -> String {
    if caller_app == target {
        APP_HTTP_GRANT.to_owned()
    } else {
        format!("{APP_HTTP_GRANT}:{target}")
    }
}

/// The named calling app must be enabled and hold the exact grant edge in its CURRENT
/// approved set (approved AND still declared by its manifest), never the manifest claim.
pub(super) async fn web_caller_app_admitted(
    state: &ServerState,
    caller_app: &str,
    target: &str,
) -> Result<(), StatusCode> {
    let record = match state.app_store.get(caller_app).await {
        Ok(Some(record)) if record.enabled => record,
        Ok(_) => return Err(StatusCode::NOT_FOUND),
        Err(e) => {
            tracing::warn!("ext proxy: app_store lookup for caller app '{caller_app}' failed: {e}");
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    let approved =
        crate::plugin_host::current_approved_grants(state, caller_app, &record.approved_grants)
            .await;
    if approved.contains(&web_caller_required_grant(caller_app, target)) {
        Ok(())
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}

/// Admission for a request the web tier forwarded for a browser ([`HDR_WEB_DELEGATION`]).
///
/// The web tier reaches Core with the server-held node token, which on its own reads as
/// the node owner, so the boundary has to live here where the caller and the grants are
/// known. Runs before the per-route permission check, the registration/wake gate and the
/// body buffer, so a refused web caller can neither wake a sidecar nor push a body.
pub(super) async fn web_delegated_admission(
    state: &ServerState,
    target: &str,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    facts: &WebDelegationFacts,
) -> Result<(), StatusCode> {
    let Some(user) = caller.as_ref() else {
        return Err(StatusCode::FORBIDDEN);
    };
    // A shared web portal must never inherit the unbound-node owner semantics.
    crate::server::web_delegated_candidate(caller)?;
    let caller_app = web_delegated_route_gate(facts)?;
    web_caller_app_admitted(state, &caller_app.id, target).await?;
    tracing::info!(
        plugin = %target,
        caller_app = %caller_app.id,
        user_id = %user.user_id,
        "ext proxy: admitted a web-delegated request"
    );
    Ok(())
}

/// The echo [`mark_web_delegation_admitted`] stamps on a web-delegated forward.
pub(super) const WEB_DELEGATION_ADMITTED: &str = "admitted";

/// Tell the web tier this node ran [`web_delegated_admission`] for the request. The
/// web tier forwards only after `GET /api/version` advertised
/// [`crate::update::FEATURE_WEB_DELEGATED_EXT`]; this echo is its second check, and
/// any response without it is withheld. Overwrites a value the sidecar may have sent.
pub(super) fn mark_web_delegation_admitted(response: &mut Response) {
    response.headers_mut().insert(
        HDR_WEB_DELEGATION,
        axum::http::HeaderValue::from_static(WEB_DELEGATION_ADMITTED),
    );
}
