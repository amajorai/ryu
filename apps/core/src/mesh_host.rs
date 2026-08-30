//! Core's implementation of the extracted [`ryu_mesh::MeshHost`] seam.
//!
//! The `ryu-mesh` crate owns the network read/shape side — the
//! `RYU_MESH_ENABLED` gate, the `GET /api/mesh/status` (Contract 6) shaping, the
//! fail-closed shared-mesh-token bearer resolution, and the Funnel helpers. What
//! it cannot own — because it is process machinery, the "what runs" half — are
//! the `tailscale`/`tailscaled` and Tailcat process adapters (the `Sidecar`s
//! managed by `SidecarManager`). This shim implements the provider dispatch, and
//! Core installs it once at boot via [`install`], mirroring the
//! `CryptoHost`/`RecipesHost` precedent.
//!
//! The install is unconditional (the mesh dep is non-optional): the crate's
//! enabled-side entry points are only reached when `ryu_mesh::is_enabled()`
//! (the `RYU_MESH_ENABLED` env OR the `mesh-enabled` pref) is true, but Core
//! wires the host anyway so an enabled node always has a live daemon bridge.

use anyhow::Result;
use async_trait::async_trait;

use ryu_mesh::MeshHost;

/// The Core preference holding the desktop-driven mesh enable (written by
/// `POST /api/mesh/config`, seeded into [`ryu_mesh::set_pref_enabled`] at boot).
/// The `RYU_MESH_ENABLED` env var still wins when set — see
/// [`ryu_mesh::is_enabled`].
pub const MESH_ENABLED_PREF_KEY: &str = "mesh-enabled";

/// The Core preference holding which control plane the tunnel enrolls against —
/// `"headscale"` (self-hosted, the default), `"tailscale"` (SaaS), or `"tailcat"`
/// (short-lived point-to-point). Written by the node selector's **Tunnel** layer;
/// read by
/// [`crate::sidecar::tailscale::mesh_backend`].
///
/// This is a SETTING and must not be confused with `MeshStatus::backend`, which is
/// *derived* from the control server the daemon reports once it is connected. The
/// derived field cannot be the writer: before a node has ever enrolled there is
/// nothing to derive from, so the picker would have no selection to render.
pub const MESH_BACKEND_PREF_KEY: &str = "mesh-backend";

/// The Core preference deciding whether first run PRE-INSTALLS the mesh client
/// (`tailscale` + `tailscaled`) even though the mesh itself is off.
///
/// Deliberately a SEPARATE key from [`MESH_ENABLED_PREF_KEY`]: pre-installing
/// stages binaries, enabling changes the node's security posture (Core becomes
/// reachable over the tailnet and loopback-admin trust is neutralized). Nothing
/// may write `mesh-enabled` on behalf of the user; this key exists so the install
/// half can be defaulted ON without dragging the enablement half with it.
///
/// The Tailscale client serves both control planes ([`MESH_BACKEND_PREF_KEY`]:
/// Headscale or Tailscale SaaS). Tailcat is a separate adopted CLI and is not
/// part of the Tailscale pre-install path.
pub const MESH_PREINSTALL_PREF_KEY: &str = "mesh-preinstall-client";

/// Default for [`MESH_PREINSTALL_PREF_KEY`] when the pref was never written —
/// i.e. on the fresh install this exists to serve. ON, matching how llama.cpp and
/// the default Gemma GGUF are fetched unconditionally on first run: a user who
/// later flips the Tunnel toggle then connects immediately instead of waiting out
/// a ~38 MB transfer (or a `brew install`) behind the toggle.
pub const MESH_PREINSTALL_DEFAULT: bool = true;

/// Environment override for [`MESH_PREINSTALL_PREF_KEY`], with the same truthiness
/// as `RYU_MESH_ENABLED` and the same precedence rule (env wins when SET, so
/// `RYU_MESH_PREINSTALL_CLIENT=0` forces the pre-install off).
///
/// Needed because the pref cannot be written before the very first boot, which is
/// exactly the boot that would download: CI, images and bandwidth-constrained
/// installs need a way to opt out that does not require a running Core.
pub const MESH_PREINSTALL_ENV: &str = "RYU_MESH_PREINSTALL_CLIENT";

/// Resolve the pre-install decision from the env override and the stored pref.
///
/// `pref` is the raw `mesh-preinstall-client` value (`None` when unwritten).
/// Parsing goes through [`ryu_mesh::parse_enabled`] so the truthiness matches the
/// mesh's own signal instead of being a second, subtly different copy.
pub fn preinstall_client_wanted(pref: Option<&str>) -> bool {
    if let Ok(env) = std::env::var(MESH_PREINSTALL_ENV) {
        return ryu_mesh::parse_enabled(Some(&env));
    }
    preinstall_client_from_pref(pref)
}

/// The pref half of [`preinstall_client_wanted`], split out so the default and the
/// opt-out are testable without mutating the process environment.
pub fn preinstall_client_from_pref(pref: Option<&str>) -> bool {
    match pref {
        Some(value) => ryu_mesh::parse_enabled(Some(value)),
        None => MESH_PREINSTALL_DEFAULT,
    }
}

/// Install [`CoreMeshHost`] as the process-global mesh host. Idempotent (a second
/// call is a no-op). Called once from `main` at boot.
pub fn install() {
    ryu_mesh::set_global_host(std::sync::Arc::new(CoreMeshHost));
}

/// Core's `MeshHost` — the process side of the network seam. Status dispatches to
/// the selected Tailscale/Headscale or Tailcat adapter; Funnel remains a
/// Tailscale-only capability.
pub struct CoreMeshHost;

#[async_trait]
impl MeshHost for CoreMeshHost {
    async fn status_json(&self) -> Result<serde_json::Value> {
        match crate::sidecar::tailscale::mesh_backend().await.0 {
            crate::sidecar::tailscale::MeshBackend::Tailcat => {
                crate::sidecar::tailcat::status_json()
            }
            crate::sidecar::tailscale::MeshBackend::Headscale
            | crate::sidecar::tailscale::MeshBackend::Tailscale => {
                crate::sidecar::tailscale::status_json().await
            }
        }
    }

    async fn ensure_funnel(&self, port: u16) -> Result<String> {
        match crate::sidecar::tailscale::mesh_backend().await.0 {
            crate::sidecar::tailscale::MeshBackend::Tailcat => {
                anyhow::bail!(
                    "Tailcat does not provide Funnel ingress; select Tailscale for Funnel"
                )
            }
            crate::sidecar::tailscale::MeshBackend::Headscale
            | crate::sidecar::tailscale::MeshBackend::Tailscale => {
                crate::sidecar::tailscale::ensure_funnel(port).await
            }
        }
    }

    async fn funnel_url(&self, port: u16) -> Option<String> {
        match crate::sidecar::tailscale::mesh_backend().await.0 {
            crate::sidecar::tailscale::MeshBackend::Tailcat => None,
            crate::sidecar::tailscale::MeshBackend::Headscale
            | crate::sidecar::tailscale::MeshBackend::Tailscale => {
                crate::sidecar::tailscale::funnel_url(port).await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    // Fail-closed integration tests: the mesh-enabled signal + the shared-mesh
    // bearer resolved by `ryu-mesh` against Core's `enforce_remote_auth` gate (the
    // trust root, which stays in `server`). These assert the two halves agree —
    // they intentionally live Core-side because they cross the crate boundary.

    // Pre-install pref: the fresh-install default is the whole point of the key
    // (an unwritten pref is exactly the first-run case), and the opt-out has to
    // parse, or a user who turned it off still gets the download.
    #[test]
    fn mesh_client_preinstall_defaults_on_and_is_opt_outable() {
        use super::{preinstall_client_from_pref, MESH_PREINSTALL_DEFAULT};
        assert!(
            MESH_PREINSTALL_DEFAULT,
            "first run must stage the mesh client, like llama.cpp + the default GGUF"
        );
        assert!(
            preinstall_client_from_pref(None),
            "unwritten pref = fresh install = on"
        );
        for off in ["false", "0", "no", "", "  FALSE  "] {
            assert!(
                !preinstall_client_from_pref(Some(off)),
                "{off:?} must opt out of the pre-install"
            );
        }
        for on in ["true", "1", "yes"] {
            assert!(
                preinstall_client_from_pref(Some(on)),
                "{on:?} must keep it on"
            );
        }
    }

    // The two keys must never collide: pre-installing stages binaries, enabling
    // changes the node's security posture. Writing one through the other is the
    // documented failure mode.
    #[test]
    fn mesh_preinstall_key_is_distinct_from_the_enable_key() {
        assert_ne!(
            super::MESH_PREINSTALL_PREF_KEY,
            super::MESH_ENABLED_PREF_KEY
        );
        assert_ne!(
            super::MESH_PREINSTALL_PREF_KEY,
            super::MESH_BACKEND_PREF_KEY
        );
    }

    #[test]
    fn core_refuses_tokenless_start_under_mesh() {
        use crate::node_token::TokenSource;
        // Mesh on + no token → refuse (Err), the fail-closed control.
        let r = crate::server::enforce_remote_auth(None, None, true, false);
        assert!(r.is_err(), "tokenless start under mesh must be refused");
        // An empty/whitespace token is also rejected.
        let r = crate::server::enforce_remote_auth(Some("   ".to_owned()), None, true, false);
        assert!(r.is_err());
        // A real token under mesh is accepted unchanged (provenance no longer
        // gates startup — see `enforce_remote_auth`; the shared-fleet precondition
        // is surfaced honestly at peer-add instead).
        let r = crate::server::enforce_remote_auth(
            Some("ryu_secret".to_owned()),
            Some(TokenSource::Env),
            true,
            false,
        );
        assert_eq!(r.unwrap().as_deref(), Some("ryu_secret"));
    }

    #[test]
    fn core_refuses_tokenless_non_loopback_bind() {
        // Non-loopback bind alone (mesh off) also requires a token. Core mints one
        // on first boot, so reaching this needs a data dir it could not write.
        assert!(crate::server::enforce_remote_auth(None, None, false, true).is_err());
    }

    #[test]
    fn loopback_tokenless_start_is_allowed() {
        // A loopback Core with no token at all still starts (it behaves exactly as
        // it did before minting existed). In practice minting means this is the
        // unwritable-data-dir path, not the common one.
        let r = crate::server::enforce_remote_auth(None, None, false, false);
        assert!(r.is_ok());
        assert!(r.unwrap().is_none());
    }

    #[test]
    fn host_non_loopback_classification() {
        use crate::server::host_is_non_loopback;
        // Loopback binds (default + explicit) are NOT exposed.
        assert!(!host_is_non_loopback(""));
        assert!(!host_is_non_loopback("127.0.0.1:7980"));
        assert!(!host_is_non_loopback("[::1]:7980"));
        // Wildcard + concrete public binds ARE exposed.
        assert!(host_is_non_loopback("0.0.0.0:7980"));
        assert!(host_is_non_loopback("[::]:7980"));
        assert!(host_is_non_loopback(":7980"));
        assert!(host_is_non_loopback("192.168.1.10:7980"));
        // An unparseable host fails closed (assumed reachable).
        assert!(host_is_non_loopback("my-host.local:7980"));
    }

    #[test]
    fn bind_flag_value_is_caught_by_gate() {
        // #478 V1 regression: a `--bind=0.0.0.0:7980` value (the chain `main()`
        // resolves and passes to `create_router`) must trip the fail-closed gate
        // when tokenless, even with mesh off — the old gate only read RYU_BIND and
        // missed the flag entirely.
        let exposed = crate::server::host_is_non_loopback("0.0.0.0:7980");
        assert!(exposed);
        assert!(crate::server::enforce_remote_auth(None, None, false, exposed).is_err());
    }

    #[test]
    fn resolved_bearer_is_accepted_by_peer_enforce_remote_auth() {
        // The bearer `ryu-mesh` hands the desktop must be EXACTLY what a peer
        // provisioned with the same RYU_TOKEN accepts. `enforce_remote_auth(Some(t),
        // mesh=on)` is the fail-closed gate the peer runs at startup; `require_auth`
        // is then a string compare, so a token that passes the gate authenticates
        // by construction.
        let bearer = ryu_mesh::resolve_mesh_bearer(Some("ryu_shared_secret")).unwrap();
        assert_eq!(bearer, "ryu_shared_secret");
        let accepted = crate::server::enforce_remote_auth(
            Some(bearer.clone()),
            Some(crate::node_token::TokenSource::Env),
            true,
            false,
        );
        assert_eq!(accepted.unwrap().as_deref(), Some("ryu_shared_secret"));
    }

    #[test]
    fn resolve_bearer_rejects_absent_empty_and_placeholder() {
        // These are the discriminating cases: none of them is a usable bearer, so
        // offering one would be the "fake token that won't validate" the seam
        // forbids. A placeholder peer refuses to start under mesh (asserted here via
        // enforce_remote_auth), so a placeholder is never a valid bearer.
        assert!(ryu_mesh::resolve_mesh_bearer(None).is_none());
        assert!(ryu_mesh::resolve_mesh_bearer(Some("")).is_none());
        assert!(ryu_mesh::resolve_mesh_bearer(Some("   ")).is_none());
        assert!(ryu_mesh::resolve_mesh_bearer(Some("CHANGE_ME")).is_none());
        assert!(ryu_mesh::resolve_mesh_bearer(Some("change_me")).is_none());
        // Proof the placeholder rejection is not arbitrary: a peer with it refuses
        // to start under mesh, so it could never authenticate anyway.
        assert!(crate::server::enforce_remote_auth(
            Some("CHANGE_ME".to_owned()),
            Some(crate::node_token::TokenSource::Env),
            true,
            false
        )
        .is_err());
    }
}
