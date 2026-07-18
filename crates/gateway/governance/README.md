# ryu-gw-governance

Ryu **Gateway** marketplace-governance **crypto core** — grant-allowlist matching + ed25519 manifest
signing/verification (#468, ties #450). Extracted from `apps/gateway/src/governance/mod.rs`.

## What it is

The **pure** governance primitives — everything that operates over caller-supplied data and
*explicit* keys / allowlists, with no env, disk, or process-global state:

- **Grant validation** — `validate_grants(grants, allowlist) -> GrantDecision { approved, denied }`
  (`all_approved`). The allowlist *policy* is passed in.
- **Manifest signing** — `sign_manifest(&SigningKey, &Value) -> String` /
  `verify_manifest(&Value, sig_b64, &VerifyingKey) -> bool`, over a **canonicalized** (recursively
  key-sorted) JSON encoding (`canonical_bytes`), so a manifest verifies even after a Mongo/JSON
  round-trip.
- Key helpers: `signing_key_from_seed`, `verifying_key_from_b64`, `public_key_b64`.
- `SIGNING_ALGORITHM = "ed25519"` — the stable identifier stored alongside a signature.

## Role in the decomposition

A **pure "engine moves, key custody stays" core crate**. The signing-key custody path
(`RYU_MARKETPLACE_SIGNING_KEY` resolution, the dev-persisted on-disk key, the process `OnceLock`)
and the **default grant allowlist** stay in `apps/gateway/src/governance/mod.rs` — the marketplace
trust root, kept where the secret is custodied. The Gateway wrappers resolve the key/allowlist and
delegate here; behavior is identical.

## How it is consumed

Compiled **into the Gateway** binary (`apps/gateway`). Depends on `ed25519-dalek` / `base64` /
`serde_json`. Not a sidecar. This is the crypto the Gateway's publish/verify endpoints call.
