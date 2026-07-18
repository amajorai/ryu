//! Core's implementation of the extracted [`ryu_mesh::MeshHost`] seam.
//!
//! The `ryu-mesh` crate owns the mesh read/shape side — the `RYU_MESH_ENABLED`
//! gate, the `GET /api/mesh/status` (Contract 6) shaping, the fail-closed
//! shared-mesh-token bearer resolution, and the Funnel helpers. What it cannot
//! own — because it is kernel machinery, the "what runs" half of the mesh — are
//! the `tailscale`/`tailscaled` process shell-outs ([`crate::sidecar::tailscale`],
//! a `Sidecar` managed by the `SidecarManager`). This shim implements those three
//! shell-outs, and Core installs it once at boot via [`install`], mirroring the
//! `CryptoHost`/`RecipesHost` precedent.
//!
//! The install is unconditional (the mesh dep is non-optional): the crate's
//! enabled-side entry points are only reached when `RYU_MESH_ENABLED` is set, but
//! Core wires the host anyway so an enabled node always has a live daemon bridge.

use anyhow::Result;
use async_trait::async_trait;

use ryu_mesh::MeshHost;

/// Install [`CoreMeshHost`] as the process-global mesh host. Idempotent (a second
/// call is a no-op). Called once from `main` at boot.
pub fn install() {
    ryu_mesh::set_global_host(std::sync::Arc::new(CoreMeshHost));
}

/// Core's `MeshHost` — the kernel side of the mesh seam. Each method forwards to
/// the `tailscale` CLI shell-outs in [`crate::sidecar::tailscale`].
pub struct CoreMeshHost;

#[async_trait]
impl MeshHost for CoreMeshHost {
    async fn status_json(&self) -> Result<serde_json::Value> {
        crate::sidecar::tailscale::status_json().await
    }

    async fn ensure_funnel(&self, port: u16) -> Result<String> {
        crate::sidecar::tailscale::ensure_funnel(port).await
    }

    async fn funnel_url(&self, port: u16) -> Option<String> {
        crate::sidecar::tailscale::funnel_url(port).await
    }
}

#[cfg(test)]
mod tests {
    // Fail-closed integration tests: the mesh-enabled signal + the shared-mesh
    // bearer resolved by `ryu-mesh` against Core's `enforce_remote_auth` gate (the
    // trust root, which stays in `server`). These assert the two halves agree —
    // they intentionally live Core-side because they cross the crate boundary.

    #[test]
    fn core_refuses_tokenless_start_under_mesh() {
        // Mesh on + no token → refuse (Err), the fail-closed control.
        let r = crate::server::enforce_remote_auth(None, true, false);
        assert!(r.is_err(), "tokenless start under mesh must be refused");
        // An empty/whitespace token is also rejected.
        let r = crate::server::enforce_remote_auth(Some("   ".to_owned()), true, false);
        assert!(r.is_err());
        // A real token under mesh is accepted and returned unchanged.
        let r = crate::server::enforce_remote_auth(Some("ryu_secret".to_owned()), true, false);
        assert_eq!(r.unwrap().as_deref(), Some("ryu_secret"));
    }

    #[test]
    fn core_refuses_tokenless_non_loopback_bind() {
        // Non-loopback bind alone (mesh off) also requires a token.
        assert!(crate::server::enforce_remote_auth(None, false, true).is_err());
    }

    #[test]
    fn loopback_tokenless_start_is_allowed() {
        // Vanilla install: no mesh, loopback bind, no token → allowed (None).
        let r = crate::server::enforce_remote_auth(None, false, false);
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
        assert!(crate::server::enforce_remote_auth(None, false, exposed).is_err());
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
        let accepted = crate::server::enforce_remote_auth(Some(bearer.clone()), true, false);
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
        assert!(
            crate::server::enforce_remote_auth(Some("CHANGE_ME".to_owned()), true, false).is_err()
        );
    }
}
