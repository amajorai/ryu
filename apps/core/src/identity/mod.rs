//! Identity governance + tool-plane wiring over the [`ryu_vault`] primitive.
//!
//! The credential **storage + rotation mechanics** — the sealed [`IdentityStore`],
//! the [`SealedState`]/[`SecretState`] newtypes, the [`source`] capture backends,
//! and the [`health`] staleness sweep — were extracted into the `ryu-vault`
//! library crate (in-process default, function-call hot path). What stays here in
//! the Core kernel is the identity *governance* that decides *what is
//! allowed/measured* and depends on the Gateway / tool plane:
//!
//! - [`governed::read_credential`] — the fail-closed `identity.read` grant + audit
//!   chokepoint on every credential read (#523).
//! - [`consult::consult_for_tool_call`] — the tool-call-time vault consult that
//!   injects a bound connection's credential under the gateway grant.
//! - [`elicitation`] — the `NEEDS_AUTH` → connect-URL elicitation seam.
//!
//! Everything the rest of Core reaches as `crate::identity::*` is re-exported
//! below, so the extraction is transparent to existing call sites.

mod consult;
mod elicitation;
mod governed;

pub use consult::{consult_for_tool_call, ConsultOutcome};
pub use elicitation::{needs_connection, to_envelope};
pub use governed::{read_credential, IDENTITY_READ_SCOPE};

// The `crate::identity::{health,source}::…` module paths used across Core
// (main, scheduler, elicitation), re-exported unchanged.
pub use ryu_vault::{health, source};

// The vault primitive's types + store, re-exported so every `crate::identity::*`
// call site (and intra-doc link) resolves unchanged after the extraction. A
// transparent facade: this binary crate flags re-exports it does not itself
// consume, so the block is `allow`ed — the surface exists for Core's other
// modules and API parity, not for this file.
#[allow(unused_imports)]
pub use ryu_vault::{
    global, is_known_source, known_source_ids, set_global, ConnectionRecord, ConnectionStatus,
    CredentialBackend, CredentialSource, CredentialSourceRegistry, FlowStatus, HealthEngine,
    HealthEvent, IdentityStore, LoginFlow, LoginKind, ManualImport, Profile, SealedState,
    SecretState, DEFAULT_SOURCE_ENV,
};
