//! Authority rules for `POST /api/plugins/install-bundle` and its sidecar
//! host-call twin (`plugins.installBundle`).
//!
//! A local bundle carries no Marketplace signature. Two rules keep it from
//! widening what its caller may do:
//!
//! - an `update: true` bundle replaces the code of an installed app that keeps
//!   its enabled state, approved grants and hook trust, so it needs the authority
//!   to install and enable that code, not `app.update` alone;
//! - a sidecar may install or update only apps inside its own namespace,
//!   `com.local.<name>.`, and only a first-party `@ryu/<name>` sidecar has one
//!   (the same rule `packages/app-host/src/app-bundle.ts` applies to frames).

use crate::identity_verify::permissions::{APP_ENABLE, APP_INSTALL, APP_UPDATE};

/// The first-party scope whose app names are unique and Ryu-published. A scope
/// prefix, not an app id, so it is not declared as an `@ryu/…` id constant (the
/// `app_boundary_guard` inventory of per-app ids).
fn first_party_name(plugin_id: &str) -> Option<&str> {
    plugin_id.strip_prefix("@ryu/")
}

/// The node lifecycle permissions a local-bundle request must hold.
pub(super) fn bundle_lifecycle_permissions(update: bool) -> &'static [&'static str] {
    if update {
        &[APP_UPDATE, APP_INSTALL, APP_ENABLE]
    } else {
        &[APP_INSTALL]
    }
}

fn is_slug(value: &str) -> bool {
    let mut parts = value.split('-');
    let Some(first) = parts.next() else {
        return false;
    };
    let starts_with_letter = first.chars().next().is_some_and(|c| c.is_ascii_lowercase());
    let lower_alnum = |part: &str| {
        !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    };
    starts_with_letter && lower_alnum(first) && parts.all(lower_alnum)
}

/// The id prefix every app a sidecar of `caller_plugin_id` installs must carry,
/// or `None` when that plugin may not install apps.
pub(super) fn sidecar_bundle_id_prefix(caller_plugin_id: &str) -> Option<String> {
    let name = first_party_name(caller_plugin_id)?;
    is_slug(name).then(|| format!("com.local.{name}."))
}

/// Why a sidecar of `caller_plugin_id` may not install `bundle`, if it may not.
pub(super) fn sidecar_bundle_namespace_denial(
    caller_plugin_id: &str,
    bundle: &serde_json::Value,
) -> Option<String> {
    let Some(prefix) = sidecar_bundle_id_prefix(caller_plugin_id) else {
        return Some(format!("'{caller_plugin_id}' cannot install other apps"));
    };
    let id = bundle
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    match id.strip_prefix(prefix.as_str()) {
        Some(rest) if !rest.is_empty() => None,
        _ => Some(format!("App id must look like {prefix}<name>")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_update_needs_install_and_enable_authority() {
        assert_eq!(bundle_lifecycle_permissions(false), &[APP_INSTALL]);
        let update = bundle_lifecycle_permissions(true);
        for permission in [APP_UPDATE, APP_INSTALL, APP_ENABLE] {
            assert!(update.contains(&permission), "missing {permission}");
        }
    }

    #[test]
    fn a_first_party_sidecar_installs_inside_its_own_namespace() {
        let site = json!({ "id": "com.local.sites.site-abc123" });
        assert_eq!(sidecar_bundle_namespace_denial("@ryu/sites", &site), None);
        assert_eq!(
            sidecar_bundle_id_prefix("@ryu/app-studio").as_deref(),
            Some("com.local.app-studio.")
        );
    }

    #[test]
    fn a_sidecar_cannot_reach_another_apps_namespace_or_id() {
        for id in [
            "com.local.app-studio.notes",
            "@ryu/browser",
            "com.local.sites.",
            "com.local.sitesx.y",
        ] {
            let bundle = json!({ "id": id });
            assert!(
                sidecar_bundle_namespace_denial("@ryu/sites", &bundle).is_some(),
                "{id} should be refused"
            );
        }
        assert!(sidecar_bundle_namespace_denial("@ryu/sites", &json!({})).is_some());
    }

    #[test]
    fn a_third_party_sidecar_with_a_colliding_name_has_no_namespace() {
        let bundle = json!({ "id": "com.local.app-studio.notes" });
        for caller in [
            "@acme/app-studio",
            "com.acme.app-studio",
            "@ryu/acme.app-studio",
            "@ryu/",
        ] {
            assert_eq!(sidecar_bundle_id_prefix(caller), None, "{caller}");
            assert!(sidecar_bundle_namespace_denial(caller, &bundle).is_some());
        }
    }
}
