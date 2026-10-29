//! Node-admittance token resolution (`RYU_TOKEN`).
//!
//! Core's `require_auth` gate compares a caller's `Authorization: Bearer` against
//! ONE shared secret. Historically that secret came from the `RYU_TOKEN`
//! environment variable and nowhere else, which meant a default desktop install
//! ran with **no token at all** — and `require_auth` treats "no token configured"
//! as "let everything through". Every process on the machine could therefore drive
//! the full local API unauthenticated, and so could any page served from an
//! allowlisted CORS origin.
//!
//! This module closes that by minting a strong token on first boot and persisting
//! it at `<data dir>/secrets/node-auth.token` (0600), so a fresh install is authenticated by
//! default with no operator action.
//!
//! ## Startup export and live rotation
//!
//! [`resolve_and_export`] runs before threads exist and exports the initial token
//! for compatibility with startup-only consumers. Security-sensitive live callers
//! use [`active_token`] instead. Runtime rotation can therefore atomically replace
//! the in-memory verifier without mutating a multithreaded process environment or
//! leaving freshly spawned Core-owned children on the previous bearer.
//!
//! ## Provenance is load-bearing, not bookkeeping
//!
//! A file-minted token is per-node. The mesh's shared-fleet convention
//! (`ryu_mesh::resolve_mesh_bearer`) assumes every node runs the SAME operator-
//! provisioned `RYU_TOKEN`, and hands the desktop this node's token to use as the
//! bearer for its PEERS. Offering a locally-minted token there would advertise a
//! bearer every peer rejects. So [`TokenSource`] is tracked and callers that mean
//! "the shared fleet secret" ask for [`shared_fleet_token`], not just any token.

use std::sync::{
    atomic::{AtomicU64, Ordering},
    OnceLock, RwLock,
};

use tokio::sync::watch;

/// Where the active node token came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenSource {
    /// Operator-provisioned via the `RYU_TOKEN` environment variable. This is the
    /// only source that can be a SHARED fleet secret (the same value deliberately
    /// installed on several nodes).
    Env,
    /// Read from a `core.token` this machine minted on an earlier boot.
    File,
    /// Minted by this process on first boot.
    Minted,
}

/// The resolved token plus where it came from.
#[derive(Debug, Clone)]
pub struct ResolvedToken {
    pub token: String,
    pub source: TokenSource,
}

static RESOLVED: OnceLock<RwLock<Option<ResolvedToken>>> = OnceLock::new();
static GENERATION: AtomicU64 = AtomicU64::new(0);
static GENERATION_WATCH: OnceLock<watch::Sender<u64>> = OnceLock::new();

fn generation_sender() -> &'static watch::Sender<u64> {
    GENERATION_WATCH.get_or_init(|| watch::channel(GENERATION.load(Ordering::SeqCst)).0)
}

fn resolved_state() -> &'static RwLock<Option<ResolvedToken>> {
    RESOLVED.get_or_init(|| {
        let resolved = resolve_uncached();
        if let Some(token) = &resolved {
            // Startup happens before sidecar/server threads exist. Runtime rotation
            // deliberately does not mutate the process environment; live callers
            // read this state instead (see `active_token`).
            std::env::set_var("RYU_TOKEN", &token.token);
        }
        RwLock::new(resolved)
    })
}

/// The file the minted token is persisted to.
///
/// Deliberately NOT `core.token`: that name is already the node IDENTITY marker
/// minted once by `POST /api/node/init` / `ryu node init` with `create_new(true)`,
/// and `data_path` excludes it from profile copies for that reason. Minting the
/// AUTH token into the same path would make `node_init` answer 409
/// `already_initialized` forever and `ryu node init` refuse without `--force`.
pub fn token_path() -> std::path::PathBuf {
    crate::paths::secret_path("node-auth.token")
}

/// Resolve the node token and export it to the process environment.
///
/// Precedence: an operator's `RYU_TOKEN` always wins (including on a machine that
/// also has a minted file, so provisioning a fleet secret is never fought by a
/// leftover local mint). Otherwise the persisted `node-auth.token` is reused, and only
/// when neither exists is a fresh one minted.
///
/// Returns `None` only when no token could be established AND none could be
/// minted (e.g. an unwritable data directory). The startup caller treats this
/// as fatal: credential failure must not start an unauthenticated local API.
pub fn resolve_and_export() -> Option<ResolvedToken> {
    resolved_state()
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

fn resolve_uncached() -> Option<ResolvedToken> {
    // 1. Operator-provisioned env var. A placeholder is treated as absent: it is
    //    not a secret, and `enforce_remote_auth` already refuses to expose a node
    //    running one, so silently minting over it is strictly better than honoring
    //    it. `is_insecure_auth_token_placeholder` is the SAME predicate the mesh
    //    and the startup gate use, so all three agree on what counts as unset.
    if let Ok(env_token) = std::env::var("RYU_TOKEN") {
        let trimmed = env_token.trim();
        if !trimmed.is_empty()
            && !ryu_mesh::is_insecure_auth_token_placeholder(trimmed)
            && !ryu_mesh::is_weak_auth_token(trimmed)
        {
            return Some(ResolvedToken {
                token: trimmed.to_owned(),
                source: TokenSource::Env,
            });
        }
    }

    let path = token_path();

    // 2. A token this machine minted earlier.
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if is_valid_minted_token(trimmed) {
            return Some(ResolvedToken {
                token: trimmed.to_owned(),
                source: TokenSource::File,
            });
        }
    }

    // 3. Mint one.
    let token = mint_token();
    match write_token_file(&path, &token) {
        Ok(()) => {
            tracing::info!(
                path = %path.display(),
                "minted a node auth token; local API is authenticated by default"
            );
            Some(ResolvedToken {
                token,
                source: TokenSource::Minted,
            })
        }
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "could not persist a node auth token; Core startup will be refused"
            );
            None
        }
    }
}

/// A 256-bit URL-safe random token. Mirrors the strength of `infra/install.sh`'s
/// `openssl rand -base64 32`.
fn mint_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    // Hex rather than base64: the token travels in an HTTP header and in shell
    // env assignments, and hex has no `+`/`/`/`=` to quote or percent-encode.
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("ryu_{hex}")
}

fn is_valid_minted_token(token: &str) -> bool {
    token.len() == 68
        && token.starts_with("ryu_")
        && token[4..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Atomically write the token 0600, creating `<data dir>/secrets` 0700. A crash can leave
/// either the old or the new complete token, never a truncated live credential.
fn write_token_file(path: &std::path::Path, token: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        }
    }

    use std::io::Write;
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "token path has no parent")
    })?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(temporary.path(), std::fs::Permissions::from_mode(0o600))?;
    }
    temporary.as_file_mut().write_all(token.as_bytes())?;
    temporary.as_file_mut().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }

    Ok(())
}

/// The active token, whatever its provenance. This is what `require_auth`
/// compares against.
pub fn active_token() -> Option<String> {
    active_from(resolved_state())
}

/// Monotonic generation for the live node bearer. WebSocket handlers capture
/// this at authentication time and terminate established sessions when token
/// rotation advances it.
pub fn active_generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

/// Subscribe to node-token rotations. The receiver is initialized with the
/// current generation, so a caller can compare it with the generation captured
/// during authentication before entering a long-lived session.
pub fn subscribe_generation() -> watch::Receiver<u64> {
    generation_sender().subscribe()
}

fn active_from(state: &RwLock<Option<ResolvedToken>>) -> Option<String> {
    state
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .map(|resolved| resolved.token.clone())
}

/// The active token ONLY when it can serve as a shared fleet secret — i.e. an
/// operator deliberately provisioned it via `RYU_TOKEN`.
///
/// A locally-minted token is unique to this machine, so handing it to a peer as
/// an enrollment bearer would advertise a credential that peer always rejects.
/// Callers wanting "the secret every node in this fleet shares" must use this,
/// not [`active_token`].
pub fn shared_fleet_token() -> Option<String> {
    resolve_and_export()
        .filter(|r| r.source == TokenSource::Env)
        .map(|r| r.token)
}

/// Rotate the node token: mint a fresh one, persist it atomically, then swap the
/// in-memory verifier before returning. Once this succeeds, the old bearer is dead
/// and the returned bearer works immediately on every live Core auth surface.
///
/// Errors when the active token came from the environment: `RYU_TOKEN` takes
/// precedence over the file, so rotating the file would be invisible — the
/// operator has to change their own env var.
pub fn rotate() -> std::io::Result<String> {
    rotate_at(resolved_state(), &token_path())
}

fn rotate_at(
    state: &RwLock<Option<ResolvedToken>>,
    path: &std::path::Path,
) -> std::io::Result<String> {
    // Hold the exclusive guard across persistence and replacement. This makes
    // concurrent rotations linearizable: the file and live verifier can never
    // end up containing different successful rotations.
    let mut active = state
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(active) = active.as_ref() {
        if active.source == TokenSource::Env {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "this node's token is provisioned via the RYU_TOKEN environment \
                 variable, which takes precedence over the token file. Rotating the \
                 file would have no effect — change RYU_TOKEN instead.",
            ));
        }
    }
    let token = mint_token();
    write_token_file(path, &token)?;
    *active = Some(ResolvedToken {
        token: token.clone(),
        source: TokenSource::File,
    });
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = generation_sender().send(generation);
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minted_tokens_are_prefixed_unique_and_long_enough() {
        let a = mint_token();
        let b = mint_token();
        assert_ne!(a, b, "each mint must be independently random");
        assert!(a.starts_with("ryu_"));
        // 32 bytes hex = 64 chars, plus the 4-char prefix.
        assert_eq!(a.len(), 68);
        // The infra token-presence probe requires >= 24 chars; ours clears it.
        assert!(a.len() >= 24);
    }

    #[test]
    fn minted_tokens_are_not_treated_as_placeholders() {
        // A mint that the shared placeholder predicate rejected would be refused
        // by `enforce_remote_auth` on a non-loopback bind.
        assert!(!ryu_mesh::is_insecure_auth_token_placeholder(&mint_token()));
    }

    #[test]
    fn only_complete_minted_file_tokens_are_accepted() {
        assert!(is_valid_minted_token(&mint_token()));
        assert!(!is_valid_minted_token("r"));
        assert!(!is_valid_minted_token("ryu_abc"));
        assert!(!is_valid_minted_token(&format!("ryu_{}", "g".repeat(64))));
    }

    #[test]
    fn token_file_is_written_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("core.token");
        write_token_file(&path, "ryu_abc").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "ryu_abc");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "token file must be owner-only");
            let parent = std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(parent & 0o777, 0o700, "token dir must be owner-only");
        }
    }

    #[test]
    fn writing_over_an_existing_token_keeps_it_owner_only() {
        // Rotation path: the file already exists, so the mode must be re-asserted
        // rather than inherited from whatever was there.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.token");
        std::fs::write(&path, "old").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        write_token_file(&path, "ryu_new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "ryu_new");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn rotation_persists_and_swaps_the_live_token_before_returning() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node-auth.token");
        let state = RwLock::new(Some(ResolvedToken {
            token: mint_token(),
            source: TokenSource::File,
        }));
        let old = state.read().unwrap().as_ref().unwrap().token.clone();
        let generation_before = active_generation();

        let new = rotate_at(&state, &path).unwrap();

        assert_ne!(new, old);
        assert_eq!(active_from(&state).as_deref(), Some(new.as_str()));
        assert_eq!(std::fs::read_to_string(path).unwrap(), new);
        assert!(active_generation() > generation_before);
    }

    #[test]
    fn rotation_refuses_operator_owned_environment_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node-auth.token");
        let state = RwLock::new(Some(ResolvedToken {
            token: "operator-secret".to_owned(),
            source: TokenSource::Env,
        }));

        let error = rotate_at(&state, &path).unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(active_from(&state).as_deref(), Some("operator-secret"));
        assert!(!path.exists());
    }

    #[test]
    fn concurrent_rotations_keep_disk_and_live_verifier_identical() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node-auth.token");
        let state = std::sync::Arc::new(RwLock::new(Some(ResolvedToken {
            token: mint_token(),
            source: TokenSource::File,
        })));
        let rotate_once = |state: std::sync::Arc<RwLock<Option<ResolvedToken>>>| {
            let path = path.clone();
            std::thread::spawn(move || rotate_at(&state, &path).unwrap())
        };

        let first_handle = rotate_once(state.clone());
        let second_handle = rotate_once(state.clone());
        let first = first_handle.join().unwrap();
        let second = second_handle.join().unwrap();
        let live = active_from(&state).unwrap();

        assert_eq!(std::fs::read_to_string(path).unwrap(), live);
        assert!(live == first || live == second);
    }
}
