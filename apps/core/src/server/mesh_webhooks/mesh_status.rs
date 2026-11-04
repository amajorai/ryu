//! Mesh status (#478).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Mesh status (#478) ───────────────────────────────────────────────────────

/// GET /api/mesh/status reports the selected private-network or public-tunnel backend.
///
/// The backend is tailscale, headscale, tailcat, or cloudflared. Tailcat reports
/// its short-lived connection bearer as tailcat_address. Cloudflared reports its
/// temporary public Quick Tunnel URL as cloudflaredUrl. When disabled, the
/// endpoint returns the all-default object with HTTP 200.
#[utoipa::path(
    get,
    path = "/api/mesh/status",
    tag = "Nodes",
    summary = "Private-network or Cloudflare Quick Tunnel status + peers",
    responses((status = 200, description = "Mesh status", body = serde_json::Value))
)]
pub(in crate::server) async fn mesh_status(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    let status = state.mesh.status().await;
    Json(serde_json::to_value(status).unwrap_or_default())
}

/// `GET /api/mesh/peers` — reachable tailnet peers + a candidate bearer for the
/// desktop's `addNode`, so a freshly added mesh peer's protected routes don't 401.
///
/// This route is on the protected router (`require_auth`), so only a caller who
/// already holds THIS node's `RYU_TOKEN` reaches it — returning that same token as
/// the peer bearer is not a disclosure. Fail-closed auth on the peer is NOT
/// weakened: the peer still requires a valid token; we merely hand one over. The
/// bearer is this node's `RYU_TOKEN` and is valid on a peer **only if that peer was
/// provisioned with the same token** (the shared-fleet convention). That
/// precondition is surfaced via `bearer_source`/`note` rather than faked — a peer
/// running a distinct token 401s and the operator must supply its own token.
#[utoipa::path(
    get,
    path = "/api/mesh/peers",
    tag = "Nodes",
    summary = "Reachable mesh peers + a candidate node-admittance bearer",
    responses((status = 200, description = "Mesh peers + bearer", body = serde_json::Value))
)]
pub(in crate::server) async fn mesh_peers(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    let status = state.mesh.status().await;
    // SHARED-fleet token, not `state.node_token`. The bearer in this response is
    // offered to the desktop to authenticate against a PEER, and the mesh admits
    // peers on a secret every node shares. A token this machine minted for itself
    // would be rejected by every peer, so advertising it would produce a peer entry
    // that looks enrollable and always 401s. `shared_fleet_token` returns `None` for
    // a minted token, which surfaces the existing, accurate "provision the same
    // RYU_TOKEN on both nodes" affordance instead.
    let resp =
        ryu_mesh::build_peers_response(&status, crate::node_token::shared_fleet_token().as_deref());
    Json(serde_json::to_value(resp).unwrap_or_default())
}

/// `POST /api/mesh/config` — enable or disable the network plane from the desktop.
///
/// Persists the `mesh-enabled` pref (so the choice survives a Core restart),
/// updates the in-process signal [`ryu_mesh::set_pref_enabled`] immediately, and
/// starts (enable) or stops (disable) the selected network sidecar. Always
/// answers 200 with the live status so the desktop toggle reflects the PERSISTED
/// state even when the daemon fails to start; a daemon-start failure rides in a
/// non-contract `start_error` field (the desktop surfaces it as a warning, not a
/// rolled-back toggle).
///
/// The optional backend request field accepts headscale, tailscale, tailcat, or
/// cloudflared. Cloudflared creates a temporary public Quick Tunnel URL. Supplying
/// a backend persists the selection and, when enabled, stops the previous adapter
/// before starting the selected one.
///
/// A missing client is the common `start_error`, and it is no longer a dead end.
/// PATH adoption still wins, but when there is no complete `tailscale`/`tailscaled`
/// pair Ryu can install a managed one, so this handler answers with two more
/// non-contract fields beside `start_error`:
///
/// - `missing_binaries: string[]` — what could not be resolved anywhere.
/// - `can_install: bool` — whether THIS node has a managed install route for the
///   selected network client. True ⇒ the background install starts; false ⇒ the
///   response names the operator-managed fallback.
///
/// **Enabling any network backend INSTALLS its client** when one is missing and
/// this node has an install route — the same way picking an engine installs it.
/// Tailcat uses a pinned, checksum-verified release asset; Tailscale/Headscale
/// use the pinned official userspace pair. The user asked for a connection, not
/// for a shopping list; making them find
/// `POST /api/setup/tailscale/install` themselves was the whole reason enabling
/// the mesh felt broken. So a third non-contract field rides along:
///
/// - `installing: bool` — an install was started for this enable; the client
///   should show progress (it also lands in the download overlay) and re-read
///   `/api/mesh/status` rather than treat `start_error` as final.
///
/// The install is still NOT inline. It is `tokio::spawn`ed via
/// [`spawn_mesh_backend_install`] precisely because these are minute-long
/// transfers; awaiting one inside the toggle handler would hang the request past
/// any client timeout. The daemon is started by that task once the binaries land,
/// so the client does not need to re-POST this route.
///
/// Security: enabling a network backend makes this Core reachable through a
/// tailnet, a Tailcat listener, or a public Cloudflare Quick Tunnel, so the
/// fail-closed token gate (`enforce_remote_auth`) requires a strong
/// non-placeholder `RYU_TOKEN` before this handler persists or starts the mesh, and
/// the same check runs again at startup. A node with no usable token cannot be
/// enabled or restarted with the mesh on. Loopback-admin trust
/// neutralization follows automatically: the gateway is (re)spawned with
/// `RYU_MESH_ENABLED=1` once `is_enabled()` reads true.
#[derive(serde::Deserialize, utoipa::ToSchema)]
#[schema(rename_all = "camelCase")]
pub(in crate::server) struct MeshConfigBody {
    pub(in crate::server) enabled: bool,
    /// Optional explicit tunnel backend. Existing callers may omit it and keep
    /// the stored selection. Values: headscale, tailscale, tailcat, cloudflared,
    /// opentunnel, plugin (the bound `network.tunnel` adapter).
    #[serde(default)]
    pub(in crate::server) backend: Option<String>,
}
