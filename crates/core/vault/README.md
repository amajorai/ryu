# ryu-vault

The Identity Vault primitive (#518): crypto-sealed, per-domain agent connections.
When a Ryu agent acts on the user's behalf on a real service (a logged-in
dashboard, a paid feed, a channel), its credential state lives here.

## Role in the decomposition

An extracted Core capability crate (L0), **compiled into Core by default** —
function-call hot path, no IPC — and consumed as a NON-optional path dependency.
ZERO dependency on `apps/core`. It generalizes the Composio-specific login model
into a provider-agnostic identity layer, modeled on kernel.sh Managed Auth:

```
Agent card ─binds─▶ Profile (1) ─has─▶ Connection (N, one per domain) ─▶ Domain
                                        status: AUTHENTICATED | NEEDS_AUTH
```

## Key API / modules

- `IdentityStore` (`store`) — SQLite store of `ConnectionRecord` / `Profile`.
  `IdentityStore::open(dir)` is the single construction site; sealing routes
  through `ryu_crypto::global_cipher` (the `enc:v1:` envelope). `set_global` /
  `global` expose a process-wide handle.
- `SealedState` (ciphertext) and `SecretState` (plaintext) — newtypes whose
  `Debug` is **redacted**, so a `ConnectionRecord` can be logged without leaking.
  `SecretState::expose` is the single intentional readout, used at seal time.
- `ConnectionStatus` / `FlowStatus` — the connection + capture-flow state enums.
- `source` — the swappable `CredentialSource` capture/rotation seam
  (`ManualImport` default + per-domain `CredentialSourceRegistry`).
- `health` — the staleness health-sweep engine.

## How it is consumed

The one kernel coupling — the `~/.ryu` data dir — is inverted as the
`IdentityStore::open(dir)` parameter (no lazy global, so no `CryptoHost`-style
host trait is needed). A `test-support` feature exposes an in-memory store +
deterministic cipher seeding to Core's identity-governance tests; never enabled
in production.

## Swap seam

`CredentialSource` / `CredentialSourceRegistry` — new capture or rotation backends
register per domain without touching the store.

## Placement

The store, encryption seam, capture backends, and health sweep decide *what runs*
over stored secrets → this crate. Identity **governance** — the `identity.read`
grant + audit chokepoint (`crate::identity::read_credential`, #523), tool-call
consult, and elicitation — stays kernel-side in `apps/core` because it decides
*what is allowed/measured*. See `docs/identity-vault-spec.md`.
