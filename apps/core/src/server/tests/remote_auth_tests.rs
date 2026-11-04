use crate::node_token::TokenSource;
use crate::server::{enforce_remote_auth, host_is_non_loopback};

#[test]
fn loopback_allows_tokenless_local_core() {
    let token = enforce_remote_auth(None, None, false, host_is_non_loopback("127.0.0.1:7980"))
        .expect("loopback-only Core may be tokenless");

    assert_eq!(token, None);
}

#[test]
fn exposed_core_requires_a_real_token() {
    assert!(enforce_remote_auth(None, None, false, true).is_err());
    assert!(enforce_remote_auth(Some("   ".to_string()), None, false, true).is_err());
    assert!(enforce_remote_auth(
        Some("CHANGE_ME".to_string()),
        Some(TokenSource::Env),
        false,
        true
    )
    .is_err());
    assert!(enforce_remote_auth(
        Some("replace_me".to_string()),
        Some(TokenSource::Env),
        true,
        false
    )
    .is_err());
    assert!(enforce_remote_auth(
        Some("weak-but-not-a-placeholder".to_string()),
        Some(TokenSource::Env),
        false,
        true
    )
    .is_err());

    let token = enforce_remote_auth(
        Some("strong-random-token-0123456789abcdef".to_string()),
        Some(TokenSource::Env),
        false,
        true,
    )
    .expect("strong non-placeholder tokens are accepted");

    assert_eq!(
        token.as_deref(),
        Some("strong-random-token-0123456789abcdef")
    );
}

/// A 256-bit token this machine minted secures a plain non-loopback bind
/// perfectly well. Refusing here would be a regression with no security gain
/// — the mesh's shared-secret assumption is what a mint actually breaks, and
/// that is gated separately below.
#[test]
fn non_loopback_bind_accepts_a_self_minted_token() {
    for source in [TokenSource::File, TokenSource::Minted] {
        let token = enforce_remote_auth(
            Some("ryu_deadbeef_0123456789abcdef0123456789abcdef".to_string()),
            Some(source),
            false,
            true,
        )
        .expect("a minted token is a real secret; a plain remote bind may use it");
        assert_eq!(
            token.as_deref(),
            Some("ryu_deadbeef_0123456789abcdef0123456789abcdef")
        );
    }
}

/// The mesh exposes this Core to the tailnet, so it still demands a STRONG,
/// non-placeholder token. But provenance is no longer the gate: a 256-bit
/// self-minted token secures the node's routes perfectly well, and the
/// shared-fleet precondition is reported honestly at peer-add
/// (`/api/mesh/peers` → `bearer_source:"none"` + note for a minted token)
/// rather than by refusing to boot. This is what lets the desktop's
/// pref-driven mesh enable work on a default install, where the token is
/// always minted.
#[test]
fn mesh_accepts_any_strong_non_placeholder_token() {
    // A strong token — minted, file-persisted, or env-provisioned — is accepted.
    for source in [TokenSource::File, TokenSource::Minted, TokenSource::Env] {
        let token = enforce_remote_auth(
            Some("ryu_deadbeef_0123456789abcdef0123456789abcdef".to_string()),
            Some(source),
            true,
            false,
        )
        .expect("mesh accepts a strong non-placeholder token whatever its provenance");
        assert_eq!(
            token.as_deref(),
            Some("ryu_deadbeef_0123456789abcdef0123456789abcdef")
        );
    }
}

/// The exposure control is provenance-independent and unchanged: an absent or
/// placeholder token is still a hard refusal whenever Core is reachable beyond
/// loopback, mesh or not.
#[test]
fn mesh_still_refuses_tokenless_and_placeholder_tokens() {
    assert!(enforce_remote_auth(None, None, true, false).is_err());
    assert!(enforce_remote_auth(
        Some("CHANGE_ME".to_string()),
        Some(TokenSource::Env),
        true,
        false
    )
    .is_err());
    assert!(enforce_remote_auth(
        Some("replace_me".to_string()),
        Some(TokenSource::Minted),
        true,
        false
    )
    .is_err());
}
