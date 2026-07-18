# ryu-mesh

The **read/shape side** of Ryu's optional Tailscale/Headscale mesh plane (unified-tool-
gateway epic #478, P5–P7). Core owns *what runs* — the optional `tailscaled` daemon,
a `Sidecar` managed Core-side. This crate shapes its status, resolves the peer-listing
bearer, and exposes the Funnel helpers public webhook ingress consumes.

## Role in the decomposition

An extracted **Core capability crate**, compiled into `apps/core` as the in-process
default (every entry point is a plain function call, never IPC) and consumed as a
**non-optional** path dependency — the fail-closed startup gate reads `is_enabled()` /
`is_insecure_auth_token_placeholder()` unconditionally.

Zero dependency on `apps/core`. The one kernel coupling — the `tailscale` /
`tailscaled` process shell-outs — inverts through the narrow **`MeshHost`** trait
(`status_json`, `ensure_funnel`, `funnel_url`), implemented in
`apps/core/src/mesh_host.rs` and installed once at boot via `set_global_host`.
**That trait is the swap seam.**

## Key surface

- `MeshHost` + `set_global_host` — the inverted daemon shell-out seam.
- `query_status` — shapes `tailscale status --json` into the canonical
  `GET /api/mesh/status` contract (Contract 6).
- Fail-closed shared-mesh-token bearer resolution for `GET /api/mesh/peers`; the
  node-admittance security model this crate anchors — `enforce_remote_auth` stays in
  Core and consults `is_insecure_auth_token_placeholder` here.
- `ensure_funnel` / `funnel_url` — the Funnel primitives P6 (webhook ingress)
  consumes for a public URL.

The mesh is **opt-in** (`RYU_MESH_ENABLED`) and never in `startup_order`. When off,
`query_status` returns the all-default object (HTTP 200) **without** touching the
host, so a build that never installs a host still runs the default (mesh-disabled)
install correctly.

## Consumed as

Compiled-into-Core crate; served over Core's `/api/mesh/*` routes.

Deps: anyhow, async-trait, serde/serde_json, tracing. Dev: tokio.
