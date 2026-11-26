//! Who asked the enable route to switch an app on, and what that caller may approve.
//!
//! Enabling an app stores the permissions it is approved for. The person's own
//! client can show that list before it calls the route. An agent's self-API
//! call shows at most the route, and nothing at all after "Allow for this
//! chat". So an agent's call may switch an app on, but it never approves a
//! permission (security finding CE-20):
//!
//! - An app that is already on keeps the stored set. A plain re-enable would
//!   store the manifest's full list again and so restore every permission the
//!   person switched off.
//! - An app that is off is not switched on when that would approve at least one
//!   permission, for the app itself or for a dependency the call would switch on
//!   with it. Disabling clears the stored set, so this is also what keeps
//!   "disable, then enable" from restoring the full list.
//!
//! The person's own client is not changed.

use crate::plugin_manifest::PluginManifest;
use crate::plugins::lifecycle::{enable_app, plan_enable_app, EnableError, EnableOutcome};
use crate::plugins::PluginStore;
use crate::server::*;

/// Told to an agent whose call found the app already on.
pub(in crate::server) const PERMISSIONS_KEPT_NOTICE: &str =
    "This app was already on. Its approved permissions were left as the person set them; \
     an agent's call does not change them.";

/// Who called the enable route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::server) enum EnableCaller {
    /// The person's own client: the desktop, the CLI, anything else that holds
    /// the node token.
    Person,
    /// An agent's tool call that arrived over the self-API loopback.
    Agent,
}

impl EnableCaller {
    /// Read the caller from the request. See
    /// [`crate::self_api::SELF_API_CALL_HEADER`] for why the mark needs no proof.
    pub(in crate::server) fn of(headers: &axum::http::HeaderMap) -> Self {
        if crate::self_api::is_self_api_call(headers) {
            Self::Agent
        } else {
            Self::Person
        }
    }
}

/// How the lifecycle reaches the Gateway's grant check.
#[derive(Clone, Copy)]
pub(in crate::server) struct GrantGate<'a> {
    pub(in crate::server) url: &'a str,
    pub(in crate::server) token: Option<&'a str>,
    pub(in crate::server) client: &'a reqwest::Client,
}

/// One app an agent's enable call would have approved permissions for.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub(in crate::server) struct UnapprovedPermissions {
    pub(in crate::server) app: String,
    pub(in crate::server) permissions: Vec<String>,
}

/// What the enable route does next.
#[derive(Debug)]
pub(in crate::server) enum CallerEnable {
    /// Activate these records. `notice` is set when an agent's call found the
    /// app already on and nothing was stored.
    Enabled {
        outcome: EnableOutcome,
        notice: Option<&'static str>,
    },
    /// An agent's call that would have approved these permissions. Nothing was
    /// switched on; the person does it where the list is shown.
    NeedsThePerson(Vec<UnapprovedPermissions>),
}

/// The enable (or its dry run) of the route, for either caller.
pub(in crate::server) async fn enable_for_caller(
    caller: EnableCaller,
    dry_run: bool,
    store: &PluginStore,
    manifest: &PluginManifest,
    all_manifests: &[PluginManifest],
    gate: GrantGate<'_>,
) -> Result<CallerEnable, EnableError> {
    let enabled = |outcome: EnableOutcome| CallerEnable::Enabled {
        outcome,
        notice: None,
    };
    if dry_run {
        return plan_enable_app(
            store,
            manifest,
            all_manifests,
            gate.url,
            gate.token,
            gate.client,
        )
        .await
        .map(enabled);
    }
    if caller == EnableCaller::Agent {
        return agent_enable(store, manifest, all_manifests, gate).await;
    }
    enable_app(
        store,
        manifest,
        all_manifests,
        gate.url,
        gate.token,
        gate.client,
    )
    .await
    .map(enabled)
}

/// An agent's enable: every check of a real enable, and no approval.
async fn agent_enable(
    store: &PluginStore,
    manifest: &PluginManifest,
    all_manifests: &[PluginManifest],
    gate: GrantGate<'_>,
) -> Result<CallerEnable, EnableError> {
    // The dry run makes every check of a real enable (installed, revocation,
    // dependency graph, capability bindings, the Gateway's grant check) and
    // writes nothing. Its records say what a real enable would store.
    let plan = plan_enable_app(
        store,
        manifest,
        all_manifests,
        gate.url,
        gate.token,
        gate.client,
    )
    .await?;

    // The raw record, as the lifecycle reads it.
    let stored = store
        .get_record(&manifest.id)
        .await
        .map_err(EnableError::Other)?;
    if let Some(record) = stored.filter(|record| record.enabled) {
        // Already on. The stored set is the person's choice, so nothing is
        // written. The route still activates the app again, as a re-enable
        // always did.
        return Ok(CallerEnable::Enabled {
            outcome: EnableOutcome {
                dependencies: Vec::new(),
                target: record,
            },
            notice: Some(PERMISSIONS_KEPT_NOTICE),
        });
    }

    let unapproved: Vec<UnapprovedPermissions> = plan
        .in_enable_order()
        .filter(|record| !record.approved_grants.is_empty())
        .map(|record| UnapprovedPermissions {
            app: record.id.clone(),
            permissions: record.approved_grants.clone(),
        })
        .collect();
    if !unapproved.is_empty() {
        return Ok(CallerEnable::NeedsThePerson(unapproved));
    }

    // Nothing this call switches on asks for a permission, so there is
    // nothing to approve.
    enable_app(
        store,
        manifest,
        all_manifests,
        gate.url,
        gate.token,
        gate.client,
    )
    .await
    .map(|outcome| CallerEnable::Enabled {
        outcome,
        notice: None,
    })
}

/// The 403 an agent gets when its enable call would have approved permissions.
pub(in crate::server) fn needs_the_person_response(
    id: &str,
    unapproved: &[UnapprovedPermissions],
) -> axum::response::Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "success": false,
            "error": format!(
                "turning on app '{id}' would approve permissions, and an agent cannot approve \
                 an app's permissions. Tell the person which permissions are asked for; they \
                 turn the app on themselves, where the list is shown"
            ),
            "needs_person": true,
            "unapproved_permissions": unapproved,
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests;
