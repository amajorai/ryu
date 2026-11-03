//! Who may own a Core-level `http.public_mount` prefix.
//!
//! A public mount is registered directly in Core's own route table (not under the
//! generic `/api/ext/<id>/*` namespace), so a manifest that chooses its own prefix
//! can shadow a Core route (`/api/vault/secrets/<name>`, a method Core does not
//! serve on `/api/health`, ...) or hand axum an invalid pattern that panics router
//! construction on every boot. Only compiled first-party manifests are trusted to
//! pick that prefix: an installed package keeps a mount only when its id is a
//! compiled-in manifest, and then always with the COMPILED value, never its own.

use std::collections::HashMap;

use super::PluginManifest;

/// Whether `mount` is a plain literal prefix: one or more `/segment` parts made of
/// lowercase ASCII letters, digits, `-` and `_` (a single trailing `/` is ignored).
/// Rejects axum/matchit syntax (`:param`, `*rest`, `{x}`), empty segments, dots,
/// and uppercase so a mount can never become a route pattern of its own.
pub(crate) fn is_literal_public_mount(mount: &str) -> bool {
    let mount = mount.strip_suffix('/').unwrap_or(mount);
    let Some(rest) = mount.strip_prefix('/') else {
        return false;
    };
    !rest.is_empty()
        && rest.split('/').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        })
}

/// Replace every installed manifest's `public_mount` with the value its compiled
/// first-party counterpart declares for the same sidecar, or drop it when there is
/// no compiled counterpart. `compiled` is the compiled built-in manifest list.
pub(crate) fn restrict_installed_public_mounts(
    installed: &mut [PluginManifest],
    compiled: &[PluginManifest],
) {
    let compiled_by_id: HashMap<&str, &PluginManifest> =
        compiled.iter().map(|m| (m.id.as_str(), m)).collect();
    for manifest in installed.iter_mut() {
        let trusted = compiled_by_id.get(manifest.id.as_str()).copied();
        for sidecar in &mut manifest.sidecars {
            let Some(http) = sidecar.http.as_mut() else {
                continue;
            };
            let compiled_mount = trusted
                .and_then(|c| c.sidecars.iter().find(|s| s.name == sidecar.name))
                .and_then(|s| s.http.as_ref())
                .and_then(|h| h.public_mount.clone());
            if http.public_mount.is_some() && compiled_mount.is_none() {
                tracing::warn!(
                    plugin = %manifest.id,
                    sidecar = %sidecar.name,
                    mount = ?http.public_mount,
                    "ignoring public_mount: only compiled first-party manifests may own a Core route prefix"
                );
            }
            http.public_mount = compiled_mount;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_manifest::PluginManifestLoader;

    fn compiled_mail() -> PluginManifest {
        PluginManifestLoader::load_builtins()
            .into_iter()
            .find(|m| m.id == "@ryu/mail")
            .expect("@ryu/mail is compiled in")
    }

    fn mounts(manifest: &PluginManifest) -> Vec<Option<String>> {
        manifest
            .sidecars
            .iter()
            .filter_map(|s| s.http.as_ref())
            .map(|h| h.public_mount.clone())
            .collect()
    }

    fn with_mount(mut manifest: PluginManifest, id: &str, mount: &str) -> PluginManifest {
        manifest.id = id.to_owned();
        for sidecar in &mut manifest.sidecars {
            if let Some(http) = sidecar.http.as_mut() {
                http.public_mount = Some(mount.to_owned());
            }
        }
        manifest
    }

    #[test]
    fn literal_mounts_accept_plain_prefixes_only() {
        for ok in [
            "/api/mail",
            "/bots",
            "/api/video-studio",
            "/api/token_table/",
        ] {
            assert!(is_literal_public_mount(ok), "{ok} should be accepted");
        }
        for bad in [
            "",
            "/",
            "api/mail",
            "/x/*y",
            "/api/:name",
            "/api/{x}",
            "//api",
            "/api//x",
            "/API",
            "/api/../vault",
            "/api/a.b",
        ] {
            assert!(!is_literal_public_mount(bad), "{bad} should be rejected");
        }
    }

    #[test]
    fn third_party_manifest_loses_its_public_mount_in_the_router_snapshot() {
        let evil = with_mount(
            compiled_mail(),
            "community.evil",
            "/api/vault/secrets/OPENAI_API_KEY",
        );
        let manifests = PluginManifestLoader::for_router(&[evil]);
        let evil = manifests.iter().find(|m| m.id == "community.evil").unwrap();
        assert!(
            mounts(evil).iter().all(Option::is_none),
            "{:?}",
            mounts(evil)
        );
    }

    #[test]
    fn installed_first_party_copy_keeps_the_compiled_mount_not_its_own() {
        let compiled = compiled_mail();
        let expected = mounts(&compiled);
        assert!(expected.iter().any(|m| m.as_deref() == Some("/api/mail")));
        let tampered = with_mount(compiled, "@ryu/mail", "/api/health");
        let manifests = PluginManifestLoader::for_router(&[tampered]);
        let mail = manifests.iter().find(|m| m.id == "@ryu/mail").unwrap();
        assert_eq!(mounts(mail), expected);
    }
}
