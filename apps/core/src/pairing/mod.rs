//! Device-code pairing: how a client that cannot read `node-auth.token` earns a
//! bearer for THIS node.
//!
//! [`crate::node_token`] made Core authenticate its local API by default. Every
//! surface that runs as a process on the same machine just reads the minted file.
//! Two classes of client cannot:
//!
//!   - **Browser surfaces** — the hosted webapp (`app.ryuhq.com` talks
//!     cross-origin to loopback Core) and the extension. A page cannot read
//!     `~/.ryu/node-auth.token`, and never will be able to.
//!   - **Another machine** — the desktop on a Windows box reaching a self-hosted
//!     Mac mini node. The token is on the mini's disk, not this one's.
//!
//! Both are solved by the same shape the OAuth 2.0 device-authorization grant
//! uses, and which this codebase already speaks in [`crate::auth`] for signing a
//! user in to the CONTROL PLANE: the client asks for a code, a human approves it
//! somewhere already trusted, and the client polls until it gets a credential.
//!
//! The critical difference from [`crate::auth`]: **the verifier here is Core
//! itself**, not Better Auth. This node is the thing being accessed, so it is the
//! thing that decides. That also means pairing works with no network, no account,
//! and no control plane — which matters, because a local-first node must not need
//! an internet round trip to let its own user in.
//!
//! ## What approval requires
//!
//! `POST /api/pair/code` and `POST /api/pair/token` are PUBLIC (an unpaired client
//! has no bearer to present — that is the whole point). Approval is not: it lives
//! behind `require_auth`, so only a caller that ALREADY holds a valid credential
//! can approve a new one. On a laptop that is the desktop app reading the minted
//! file; on a headless cloud node it is the desktop holding the node token from
//! the control plane. Pairing therefore never widens who can get in — it only
//! lets an existing trusted client vouch for another.
//!
//! ## Tokens are stored hashed
//!
//! Only the SHA-256 of an issued token is persisted. Reading
//! `paired-clients.json` yields no usable credential, so a backup, a log, or a
//! stray profile copy does not hand over live access to the node.

use crate::authorization::{
    AuthorizationContext, CapabilitySet, CredentialKind, GrantConstraints, Principal,
    RequestBindings, AUTHORIZATION_SCHEMA_VERSION,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// How long an unapproved pairing request stays claimable, in seconds. Long
/// enough for a human to walk to another device, short enough that an abandoned
/// code is not a standing invitation.
pub const PAIRING_CODE_TTL_SECS: u64 = 600;

/// The polling interval handed to clients, in seconds. Clients that poll faster
/// get `slow_down` (mirroring the device-grant contract in [`crate::auth`]).
pub const PAIRING_POLL_INTERVAL_SECS: u64 = 5;

/// Cap on simultaneously-pending requests. Without it, an unauthenticated caller
/// could mint unbounded state through a PUBLIC route — the codes are cheap, but
/// memory is not. Oldest pending requests are evicted first.
pub const MAX_PENDING_REQUESTS: usize = 32;

/// Version of new paired-client records. Missing/zero is the legacy full-access
/// format and is resolved through a restrictive compatibility profile.
pub const PAIRED_CLIENT_SCHEMA_VERSION: u16 = 2;

/// Unix seconds. Split out so tests can drive time without sleeping.
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Where a pairing request is in its lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PairingState {
    Pending,
    Approved,
    Denied,
}

/// One in-flight pairing request. Lives in memory only: a request that does not
/// survive a Core restart is correct behaviour, because the human who started it
/// is still standing there and can just ask again.
#[derive(Debug, Clone)]
pub struct PairingRequest {
    pub schema_version: u16,
    /// The secret the CLIENT polls with. Never displayed to the human.
    pub device_code: String,
    /// The short, human-readable code shown on both ends so the approver can
    /// confirm they are approving the request actually in front of them.
    pub user_code: String,
    /// Self-declared client label ("Ryu Web", "Chrome extension"). Display only,
    /// and therefore untrusted — it is shown to the approver, never trusted for
    /// an access decision.
    pub client_name: String,
    /// Capabilities the client asked the owner to grant. Approval can narrow
    /// this set but cannot widen it.
    pub requested_scopes: CapabilitySet,
    /// Exact identity/resource bindings requested for the credential.
    pub requested_constraints: GrantConstraints,
    /// Optional credential expiry requested by the client.
    pub requested_expires_at: Option<u64>,
    pub state: PairingState,
    pub created_at: u64,
    /// Set once approved: the plaintext token, held ONLY until the client polls
    /// for it, then dropped. This is the one moment the plaintext exists in
    /// memory; the store keeps just its hash.
    pub issued_token: Option<String>,
}

impl PairingRequest {
    pub fn is_expired(&self, now: u64) -> bool {
        now.saturating_sub(self.created_at) >= PAIRING_CODE_TTL_SECS
    }
}

/// A client that completed pairing and holds a live bearer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairedClient {
    /// Missing on historical records. `0` is treated as legacy rather than as a
    /// new empty-scope grant.
    #[serde(default)]
    pub schema_version: u16,
    pub id: String,
    pub name: String,
    /// SHA-256 hex of the issued token. The plaintext is never persisted, so a
    /// read of this file grants nothing.
    pub token_sha256: String,
    pub created_at: u64,
    /// Last time this token authenticated a request, for the revoke UI. Best
    /// effort: updated opportunistically, not on a write-per-request basis.
    #[serde(default)]
    pub last_seen: u64,
    /// Explicit grant vocabulary for versioned records.
    #[serde(default)]
    pub granted_scopes: CapabilitySet,
    #[serde(default)]
    pub constraints: GrantConstraints,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<u64>,
}

impl PairedClient {
    pub fn effective_scopes(&self) -> CapabilitySet {
        if self.schema_version < PAIRED_CLIENT_SCHEMA_VERSION {
            CapabilitySet::restrictive_legacy_profile()
        } else {
            self.granted_scopes.clone()
        }
    }

    pub fn is_active_at(&self, now: u64) -> bool {
        self.revoked_at.is_none() && self.expires_at.is_none_or(|expires_at| now < expires_at)
    }
}

/// The persisted set of paired clients.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PairedClients {
    #[serde(default)]
    pub clients: Vec<PairedClient>,
}

/// SHA-256 hex of a token.
pub fn hash_token(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Constant-time hex-digest comparison.
///
/// Both sides are digests, not secrets, so the leak here is small — but the
/// comparison still runs in constant time because `require_auth` performs it on
/// every request against an attacker-supplied bearer, and Core supports
/// non-loopback binds where a byte-by-byte early return is remotely observable.
/// Mirrors `server::ct_eq`.
fn ct_eq_hex(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// A 6-character code from an unambiguous alphabet, formatted `ABC-DEF`.
///
/// Excludes `O`/`0` and `I`/`1`/`L`: a human reads this aloud or retypes it, and
/// a code that is ambiguous on a screen produces failed pairings that look like
/// bugs. 29^6 ≈ 5.9e8 combinations, and a code is only guessable inside its
/// 10-minute window against a live pending request.
fn generate_user_code() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    let pick = |rng: &mut rand::rngs::ThreadRng| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char;
    let mut rng_ref = rng;
    let left: String = (0..3).map(|_| pick(&mut rng_ref)).collect();
    let right: String = (0..3).map(|_| pick(&mut rng_ref)).collect();
    format!("{left}-{right}")
}

/// A 256-bit random secret, hex-encoded. Used for both `device_code` and the
/// issued bearer.
fn generate_secret(prefix: &str) -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{prefix}{hex}")
}

/// The in-memory pending-request table, keyed by `device_code`.
static PENDING: Mutex<Option<HashMap<String, PairingRequest>>> = Mutex::new(None);

fn with_pending<T>(f: impl FnOnce(&mut HashMap<String, PairingRequest>) -> T) -> T {
    let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

/// Drop expired requests. Called on every mutation so the table cannot grow
/// without bound from abandoned codes.
fn prune(map: &mut HashMap<String, PairingRequest>, now: u64) {
    map.retain(|_, req| !req.is_expired(now));
}

/// Path to the paired-client store.
pub fn paired_clients_path() -> std::path::PathBuf {
    crate::paths::state_path("paired-clients.json")
}

fn load_paired_clients_from_disk() -> PairedClients {
    let Ok(bytes) = std::fs::read(paired_clients_path()) else {
        return PairedClients::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// Serialize a complete snapshot to a same-directory temporary file and rename
/// it over the destination. A crash can leave an old or new complete snapshot,
/// never a truncated JSON file.
fn save_paired_clients_atomic(clients: &PairedClients) -> std::io::Result<()> {
    let path = paired_clients_path();
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "paired-client path has no parent",
        )
    })?;
    std::fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(temporary.path(), std::fs::Permissions::from_mode(0o600))?;
    }

    serde_json::to_writer_pretty(temporary.as_file_mut(), clients)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    temporary.as_file_mut().write_all(b"\n")?;
    temporary.as_file_mut().sync_all()?;
    temporary.persist(&path).map_err(|error| error.error)?;
    Ok(())
}

/// Mutation lock plus in-memory snapshot of the paired-client store.
///
/// Keeping both concerns behind one mutex prevents two simultaneous approvals
/// or revocations from loading the same snapshot and losing one mutation.
static CLIENTS_STORE: Mutex<Option<PairedClients>> = Mutex::new(None);

pub fn load_paired_clients() -> PairedClients {
    let mut guard = CLIENTS_STORE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    guard
        .get_or_insert_with(load_paired_clients_from_disk)
        .clone()
}

pub fn save_paired_clients(clients: &PairedClients) -> std::io::Result<()> {
    let mut guard = CLIENTS_STORE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    save_paired_clients_atomic(clients)?;
    *guard = Some(clients.clone());
    Ok(())
}

fn mutate_paired_clients<T>(mutation: impl FnOnce(&mut PairedClients) -> T) -> std::io::Result<T> {
    let mut guard = CLIENTS_STORE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut clients = guard.clone().unwrap_or_else(load_paired_clients_from_disk);
    let output = mutation(&mut clients);
    save_paired_clients_atomic(&clients)?;
    *guard = Some(clients);
    Ok(output)
}

/// Drop the cached snapshot so the next read reloads from disk.
pub fn invalidate_cache() {
    let mut guard = CLIENTS_STORE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

fn resolve_from_clients(
    clients: &PairedClients,
    token: &str,
    bindings: &RequestBindings,
    now: u64,
) -> Option<AuthorizationContext> {
    let presented = hash_token(token);
    let mut resolved = None;
    for client in &clients.clients {
        // No early `break`: iterate the whole list so the time taken does not
        // reveal the matching client's position.
        let hash_matches = ct_eq_hex(&client.token_sha256, &presented);
        if hash_matches && client.is_active_at(now) && client.constraints.is_satisfied_by(bindings)
        {
            resolved = Some(AuthorizationContext {
                credential: CredentialKind::PairedCapability {
                    grant_id: client.id.clone(),
                },
                principal: Principal::PairedClient {
                    client_id: client
                        .constraints
                        .client_id
                        .clone()
                        .unwrap_or_else(|| client.id.clone()),
                    subject_id: client.constraints.subject_id.clone(),
                },
                capabilities: client.effective_scopes(),
                constraints: client.constraints.clone(),
                issued_at: client.created_at,
                expires_at: client.expires_at,
            });
        }
    }
    resolved
}

/// Resolve a paired bearer into its typed grant. Matching tokens whose grant is
/// expired, revoked, or violates an exact binding are indistinguishable from an
/// unknown token and therefore fail closed.
pub fn resolve_paired_token(
    token: &str,
    bindings: &RequestBindings,
) -> Option<AuthorizationContext> {
    let clients = load_paired_clients();
    resolve_from_clients(&clients, token, bindings, now_secs())
}

/// Temporary compatibility for callers that only need admission. New route
/// authorization must use [`resolve_paired_token`] and retain its context.
/// Constrained grants cannot pass through this compatibility path because the
/// required bindings are deliberately absent.
pub fn is_paired_token(token: &str) -> bool {
    resolve_paired_token(token, &RequestBindings::default()).is_some()
}

#[derive(Debug, Clone)]
pub struct PairingRequestOptions {
    pub client_name: String,
    pub requested_scopes: CapabilitySet,
    pub requested_constraints: GrantConstraints,
    pub requested_expires_at: Option<u64>,
}

impl PairingRequestOptions {
    pub fn read_only(client_name: impl Into<String>) -> Self {
        Self {
            client_name: client_name.into(),
            requested_scopes: CapabilitySet::paired_read_only(),
            requested_constraints: GrantConstraints::default(),
            requested_expires_at: None,
        }
    }
}

fn sanitize_client_name(value: &str) -> String {
    let sanitized: String = value
        .trim()
        .chars()
        .filter(|character| {
            !character.is_control()
                && !matches!(
                    character,
                    '\u{061c}'
                        | '\u{200e}'
                        | '\u{200f}'
                        | '\u{202a}'..='\u{202e}'
                        | '\u{2066}'..='\u{2069}'
                )
        })
        .take(64)
        .collect();
    if sanitized.trim().is_empty() {
        "Unknown client".to_owned()
    } else {
        sanitized
    }
}

/// Start a pairing request with a restrictive read-only profile. This wrapper
/// preserves the original local pairing call shape while ensuring new tokens
/// never inherit owner authority.
pub fn start_request(client_name: &str) -> PairingRequest {
    start_request_with_options(PairingRequestOptions::read_only(client_name))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartRequestError {
    CapacityExceeded,
}

/// Start a pairing request with explicit requested capabilities and bindings.
/// PUBLIC entry point; values remain requests until an owner approves them.
pub fn start_request_with_options(options: PairingRequestOptions) -> PairingRequest {
    try_start_request_with_options(options).expect("pairing request capacity exceeded")
}

/// Start a public pairing request without evicting an existing request. The HTTP
/// boundary uses this variant so an unauthenticated flood receives 429 instead
/// of deleting the legitimate code a human is trying to approve.
pub fn try_start_request_with_options(
    options: PairingRequestOptions,
) -> Result<PairingRequest, StartRequestError> {
    let now = now_secs();
    let req = PairingRequest {
        schema_version: AUTHORIZATION_SCHEMA_VERSION,
        device_code: generate_secret("pdc_"),
        user_code: generate_user_code(),
        // Cap the label: it is attacker-controlled and gets rendered in the
        // approval UI.
        client_name: sanitize_client_name(&options.client_name),
        requested_scopes: options.requested_scopes,
        requested_constraints: options.requested_constraints.normalized(),
        requested_expires_at: options.requested_expires_at,
        state: PairingState::Pending,
        created_at: now,
        issued_token: None,
    };

    with_pending(|map| {
        prune(map, now);
        if map.len() >= MAX_PENDING_REQUESTS {
            return Err(StartRequestError::CapacityExceeded);
        }
        map.insert(req.device_code.clone(), req.clone());
        Ok(req)
    })
}

/// Every request a human could approve right now.
pub fn pending_requests() -> Vec<PairingRequest> {
    let now = now_secs();
    with_pending(|map| {
        prune(map, now);
        let mut out: Vec<PairingRequest> = map
            .values()
            .filter(|r| r.state == PairingState::Pending)
            .cloned()
            .collect();
        out.sort_by_key(|r| r.created_at);
        out
    })
}

/// Outcome of an approve/deny decision.
#[derive(Debug, PartialEq, Eq)]
pub enum DecisionOutcome {
    /// Approved; the client will receive this token on its next poll.
    Approved,
    Denied,
    /// No pending request with that `user_code` (wrong code, or it expired).
    NotFound,
    /// The proposed grant widened the request or was already expired.
    InvalidGrant,
    /// The grant was not issued because durable persistence failed.
    PersistenceFailed,
}

#[derive(Debug, Clone, Default)]
pub struct PairingApproval {
    /// `None` grants exactly what was requested. An explicit set may only be a
    /// subset of the request.
    pub granted_scopes: Option<CapabilitySet>,
    /// `None` preserves the requested expiry. An explicit expiry may shorten,
    /// but never lengthen, a request that already specified one.
    pub expires_at: Option<u64>,
}

/// Approve by the HUMAN-visible `user_code`.
///
/// Keyed on `user_code` rather than `device_code` deliberately: the approver only
/// ever sees the short code, and requiring them to match it is what stops a
/// racing request from being approved by accident.
pub fn approve(user_code: &str) -> DecisionOutcome {
    approve_with_grant(user_code, PairingApproval::default())
}

pub fn approve_with_grant(user_code: &str, approval: PairingApproval) -> DecisionOutcome {
    let now = now_secs();
    let wanted = user_code.trim().to_ascii_uppercase();
    with_pending(|map| {
        prune(map, now);
        let Some(req) = map
            .values_mut()
            .find(|r| r.state == PairingState::Pending && r.user_code == wanted)
        else {
            return DecisionOutcome::NotFound;
        };

        let granted_scopes = approval
            .granted_scopes
            .clone()
            .unwrap_or_else(|| req.requested_scopes.clone());
        if !granted_scopes.is_subset_of(&req.requested_scopes) {
            return DecisionOutcome::InvalidGrant;
        }
        let expires_at = approval.expires_at.or(req.requested_expires_at);
        if expires_at.is_some_and(|expires_at| expires_at <= now)
            || req
                .requested_expires_at
                .is_some_and(|ceiling| expires_at.is_none_or(|expires_at| expires_at > ceiling))
        {
            return DecisionOutcome::InvalidGrant;
        }

        let token = generate_secret("ryup_");
        let client = PairedClient {
            schema_version: PAIRED_CLIENT_SCHEMA_VERSION,
            id: format!("pc_{}", &hash_token(&token)[..16]),
            name: req.client_name.clone(),
            token_sha256: hash_token(&token),
            created_at: now,
            last_seen: 0,
            granted_scopes,
            constraints: req.requested_constraints.clone(),
            expires_at,
            revoked_at: None,
        };
        if let Err(error) = mutate_paired_clients(|clients| clients.clients.push(client)) {
            tracing::error!(%error, "pairing: refused to issue a client after persistence failed");
            return DecisionOutcome::PersistenceFailed;
        }

        // Make the plaintext pollable only after its hash and grant are durable.
        req.state = PairingState::Approved;
        req.issued_token = Some(token);
        DecisionOutcome::Approved
    })
}

pub fn deny(user_code: &str) -> DecisionOutcome {
    let now = now_secs();
    let wanted = user_code.trim().to_ascii_uppercase();
    with_pending(|map| {
        prune(map, now);
        match map
            .values_mut()
            .find(|r| r.state == PairingState::Pending && r.user_code == wanted)
        {
            Some(req) => {
                req.state = PairingState::Denied;
                DecisionOutcome::Denied
            }
            None => DecisionOutcome::NotFound,
        }
    })
}

/// What a polling client learns. Mirrors the OAuth device-grant error vocabulary
/// so a client written against that spec behaves correctly here.
#[derive(Debug, PartialEq, Eq)]
pub enum PollOutcome {
    /// Approved. Repeated polls return the same token until the device request
    /// expires, making response loss and overlapping polls retry-safe.
    Token(String),
    AuthorizationPending,
    AccessDenied,
    ExpiredToken,
}

/// Poll with the `device_code`. PUBLIC entry point.
///
/// An approved token remains pollable only for the original short device-code
/// TTL. Returning the same credential during that window avoids creating an
/// active orphaned grant when an HTTP response is lost.
pub fn poll(device_code: &str) -> PollOutcome {
    let now = now_secs();
    with_pending(|map| {
        prune(map, now);
        let Some(req) = map.get(device_code) else {
            // Either it never existed or it expired and was pruned. Both are
            // `expired_token` to the client: distinguishing them would confirm
            // whether a guessed device_code was ever real.
            return PollOutcome::ExpiredToken;
        };
        match req.state {
            PairingState::Pending => PollOutcome::AuthorizationPending,
            PairingState::Denied => {
                map.remove(device_code);
                PollOutcome::AccessDenied
            }
            PairingState::Approved => req
                .issued_token
                .clone()
                .map(PollOutcome::Token)
                .unwrap_or(PollOutcome::ExpiredToken),
        }
    })
}

fn revoke_client(clients: &mut PairedClients, id: &str, now: u64) -> bool {
    let Some(client) = clients
        .clients
        .iter_mut()
        .find(|client| client.id == id && client.revoked_at.is_none())
    else {
        return false;
    };
    client.revoked_at = Some(now);
    true
}

/// Revoke a paired client by id. The in-memory decision is updated before the
/// durable write so a storage failure never leaves the bearer usable in the
/// running process. The caller still receives the persistence error and can
/// surface a retryable failure rather than a misleading not-found response.
pub fn revoke(id: &str) -> std::io::Result<bool> {
    let mut guard = CLIENTS_STORE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut clients = guard.clone().unwrap_or_else(load_paired_clients_from_disk);
    let revoked = revoke_client(&mut clients, id, now_secs());
    if !revoked {
        return Ok(false);
    }
    *guard = Some(clients.clone());
    save_paired_clients_atomic(&clients)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These tests all drive ONE process-global pending table, so they must not
    /// interleave. Bun-style per-test isolation is not available here; a mutex
    /// held for the body of each test is.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// Take the serialization lock and clear the global table.
    fn guard() -> std::sync::MutexGuard<'static, ()> {
        let g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        with_pending(|map| map.clear());
        invalidate_cache();
        g
    }

    #[test]
    fn user_codes_avoid_visually_ambiguous_characters() {
        // A human retypes this. `O` vs `0` and `I`/`1`/`L` produce failed
        // pairings that read as bugs, so the alphabet must exclude them.
        for _ in 0..200 {
            let code = generate_user_code();
            assert_eq!(code.len(), 7, "format is ABC-DEF");
            assert_eq!(code.chars().nth(3), Some('-'));
            for ch in code.chars().filter(|c| *c != '-') {
                assert!(
                    !"O0I1L".contains(ch),
                    "ambiguous character {ch} in user code {code}"
                );
                assert!(ch.is_ascii_uppercase() || ch.is_ascii_digit());
            }
        }
    }

    #[test]
    fn secrets_are_unique_and_prefixed() {
        let a = generate_secret("pdc_");
        let b = generate_secret("pdc_");
        assert_ne!(a, b);
        assert!(a.starts_with("pdc_"));
        // 32 bytes hex + prefix.
        assert_eq!(a.len(), 4 + 64);
    }

    #[test]
    fn hash_is_stable_and_distinguishing() {
        assert_eq!(hash_token("abc"), hash_token("abc"));
        assert_ne!(hash_token("abc"), hash_token("abd"));
        assert_eq!(hash_token("abc").len(), 64);
    }

    #[test]
    fn ct_eq_hex_matches_only_identical_digests() {
        assert!(ct_eq_hex("deadbeef", "deadbeef"));
        assert!(!ct_eq_hex("deadbeef", "deadbeee"));
        // Length mismatch is not a match (and short-circuits — length is public).
        assert!(!ct_eq_hex("dead", "deadbeef"));
    }

    #[test]
    fn approved_token_delivery_is_retry_safe() {
        let _g = guard();
        let req = start_request("Ryu Web");
        assert_eq!(poll(&req.device_code), PollOutcome::AuthorizationPending);

        assert_eq!(approve(&req.user_code), DecisionOutcome::Approved);
        let token = match poll(&req.device_code) {
            PollOutcome::Token(t) => t,
            other => panic!("expected a token, got {other:?}"),
        };
        assert!(token.starts_with("ryup_"));

        assert_eq!(poll(&req.device_code), PollOutcome::Token(token));
    }

    #[test]
    fn approval_is_keyed_on_the_human_visible_code_case_insensitively() {
        let _g = guard();
        let req = start_request("Extension");
        assert_eq!(
            approve(&req.user_code.to_ascii_lowercase()),
            DecisionOutcome::Approved
        );
    }

    #[test]
    fn denied_requests_report_access_denied_and_are_dropped() {
        let _g = guard();
        let req = start_request("Ryu Web");
        assert_eq!(deny(&req.user_code), DecisionOutcome::Denied);
        assert_eq!(poll(&req.device_code), PollOutcome::AccessDenied);
        // Dropped after reporting, so it cannot be polled forever.
        assert_eq!(poll(&req.device_code), PollOutcome::ExpiredToken);
    }

    #[test]
    fn an_unknown_device_code_is_indistinguishable_from_an_expired_one() {
        let _g = guard();
        // Confirming "this code was never real" would let an attacker probe for
        // live device codes.
        assert_eq!(poll("pdc_never_existed"), PollOutcome::ExpiredToken);
    }

    #[test]
    fn approving_an_unknown_code_finds_nothing() {
        let _g = guard();
        assert_eq!(approve("ZZZ-ZZZ"), DecisionOutcome::NotFound);
        assert_eq!(deny("ZZZ-ZZZ"), DecisionOutcome::NotFound);
    }

    #[test]
    fn expired_requests_are_pruned_and_never_approvable() {
        let _g = guard();
        let mut req = start_request("Stale");
        // Age it past the TTL in place.
        with_pending(|map| {
            let entry = map.get_mut(&req.device_code).unwrap();
            entry.created_at = now_secs().saturating_sub(PAIRING_CODE_TTL_SECS + 1);
            req.created_at = entry.created_at;
        });
        assert!(req.is_expired(now_secs()));
        assert_eq!(approve(&req.user_code), DecisionOutcome::NotFound);
        assert_eq!(poll(&req.device_code), PollOutcome::ExpiredToken);
        assert!(pending_requests().is_empty());
    }

    #[test]
    fn pending_table_rejects_overflow_without_evicting_existing_codes() {
        let _g = guard();
        // The start route is PUBLIC, so an unauthenticated caller must not be
        // able to grow this without bound.
        let base = now_secs().saturating_sub(60);
        let mut codes = Vec::new();
        for i in 0..MAX_PENDING_REQUESTS {
            let req = try_start_request_with_options(PairingRequestOptions::read_only(format!(
                "client-{i}"
            )))
            .unwrap();
            // Force a strictly increasing age ordering so "oldest" is well-defined
            // even when many requests land within the same second.
            // Strictly increasing but still WITHIN the TTL, or `prune` would drop
            // them as expired and the eviction path would never be exercised.
            with_pending(|map| {
                if let Some(entry) = map.get_mut(&req.device_code) {
                    entry.created_at = base + i as u64;
                }
            });
            codes.push(req.device_code);
        }
        assert!(matches!(
            try_start_request_with_options(PairingRequestOptions::read_only("overflow")),
            Err(StartRequestError::CapacityExceeded)
        ));
        let pending = pending_requests();
        assert_eq!(pending.len(), MAX_PENDING_REQUESTS);
        assert!(codes
            .iter()
            .all(|code| pending.iter().any(|request| &request.device_code == code)));
    }

    #[test]
    fn client_names_are_capped_and_defaulted() {
        let _g = guard();
        // Self-declared and rendered in the approval UI, so it is untrusted input.
        let long = "x".repeat(500);
        let req = start_request(&long);
        assert_eq!(req.client_name.chars().count(), 64);

        let blank = start_request("   ");
        assert_eq!(blank.client_name, "Unknown client");

        let spoofed = start_request("Trusted\n\u{202e}exe.test");
        assert_eq!(spoofed.client_name, "Trustedexe.test");
    }

    #[test]
    fn pending_requests_are_sorted_oldest_first() {
        let _g = guard();
        let a = start_request("first");
        let b = start_request("second");
        // Within the TTL, or both would be pruned before the sort is observed.
        let now = now_secs();
        with_pending(|map| {
            map.get_mut(&a.device_code).unwrap().created_at = now.saturating_sub(60);
            map.get_mut(&b.device_code).unwrap().created_at = now.saturating_sub(30);
        });
        let pending = pending_requests();
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].client_name, "first");
    }

    #[test]
    fn approval_cannot_widen_beyond_requested_scopes() {
        let _g = guard();
        let req = start_request_with_options(PairingRequestOptions {
            client_name: "reader".to_owned(),
            requested_scopes: CapabilitySet::new([crate::authorization::Capability::ToolsRead]),
            requested_constraints: GrantConstraints::default(),
            requested_expires_at: None,
        });

        assert_eq!(
            approve_with_grant(
                &req.user_code,
                PairingApproval {
                    granted_scopes: Some(CapabilitySet::new([
                        crate::authorization::Capability::ToolsRead,
                        crate::authorization::Capability::ToolsExec,
                    ])),
                    expires_at: None,
                },
            ),
            DecisionOutcome::InvalidGrant
        );
        assert_eq!(poll(&req.device_code), PollOutcome::AuthorizationPending);
    }

    fn paired_client(token: &str) -> PairedClient {
        PairedClient {
            schema_version: PAIRED_CLIENT_SCHEMA_VERSION,
            id: "pc_test".to_owned(),
            name: "test client".to_owned(),
            token_sha256: hash_token(token),
            created_at: 100,
            last_seen: 0,
            granted_scopes: CapabilitySet::new([crate::authorization::Capability::ToolsRead]),
            constraints: GrantConstraints::default(),
            expires_at: None,
            revoked_at: None,
        }
    }

    #[test]
    fn revocation_invalidates_a_grant_immediately() {
        let token = "ryup_secret";
        let mut clients = PairedClients {
            clients: vec![paired_client(token)],
        };
        assert!(resolve_from_clients(&clients, token, &RequestBindings::default(), 200).is_some());

        assert!(revoke_client(&mut clients, "pc_test", 201));
        assert!(resolve_from_clients(&clients, token, &RequestBindings::default(), 201).is_none());
        assert_eq!(clients.clients[0].revoked_at, Some(201));
    }

    #[test]
    fn a_subject_bound_token_requires_the_same_verified_subject() {
        let token = "ryup_subject_bound";
        let mut client = paired_client(token);
        client.constraints.subject_id = Some("user_expected".to_owned());
        let clients = PairedClients {
            clients: vec![client],
        };

        assert!(resolve_from_clients(&clients, token, &RequestBindings::default(), 200).is_none());
        assert!(resolve_from_clients(
            &clients,
            token,
            &RequestBindings {
                subject_id: Some("user_other".to_owned()),
                ..RequestBindings::default()
            },
            200
        )
        .is_none());
        assert!(resolve_from_clients(
            &clients,
            token,
            &RequestBindings {
                subject_id: Some("user_expected".to_owned()),
                ..RequestBindings::default()
            },
            200
        )
        .is_some());
    }

    #[test]
    fn expired_tokens_do_not_resolve() {
        let token = "ryup_expiring";
        let mut client = paired_client(token);
        client.expires_at = Some(200);
        let clients = PairedClients {
            clients: vec![client],
        };

        assert!(resolve_from_clients(&clients, token, &RequestBindings::default(), 199).is_some());
        assert!(resolve_from_clients(&clients, token, &RequestBindings::default(), 200).is_none());
    }

    #[test]
    fn unversioned_records_parse_into_a_restrictive_legacy_profile() {
        let token = "ryup_legacy";
        let json = format!(
            r#"{{"clients":[{{"id":"pc_old","name":"old","token_sha256":"{}","created_at":1}}]}}"#,
            hash_token(token)
        );
        let clients: PairedClients = serde_json::from_str(&json).expect("legacy record parses");
        let context = resolve_from_clients(&clients, token, &RequestBindings::default(), 200)
            .expect("legacy read grant resolves");

        assert!(context
            .capabilities
            .contains(crate::authorization::Capability::ToolsRead));
        assert!(!context
            .capabilities
            .contains(crate::authorization::Capability::ToolsExec));
        assert_eq!(clients.clients[0].schema_version, 0);
    }

    #[test]
    fn persisted_client_contains_only_the_token_hash() {
        let token = "ryup_plaintext_must_not_persist";
        let client = paired_client(token);
        let json = serde_json::to_string(&client).expect("client serializes");

        assert!(json.contains(&hash_token(token)));
        assert!(!json.contains(token));
    }
}
