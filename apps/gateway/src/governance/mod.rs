//! Marketplace governance: grant validation + manifest signing (#468, ties #450).
//!
//! CLAUDE.md §1 places "what is allowed/shared/measured/paid for" in the
//! Gateway. Publishing an App to the Ryu Marketplace is a *governed* action, so
//! the two governance primitives it needs live here, reached over HTTP by the
//! control-plane server (publish) and by Core (verify-on-install):
//!
//!   - **Grant validation** (`validate_grants`): the manifest declares the
//!     permission grants it wants (tool/capability scopes). The Gateway checks
//!     them against its grant policy and returns `{ approved, denied }`. A
//!     non-empty `denied` blocks publish. This fills the seam Core's plugin
//!     lifecycle already calls (`POST /v1/grants/validate`,
//!     `apps/core/src/plugins/lifecycle.rs`), which until now only had a
//!     `RYU_STUB_GRANT_VALIDATION` allow-all stub on the Core side.
//!
//!   - **Manifest signing** (`sign_manifest` / `verify_manifest`): the Gateway
//!     owns the signing key (ed25519). On publish it signs the manifest; on
//!     install Core asks the Gateway to verify the signature, so a manifest
//!     tampered with anywhere along TS -> Mongo -> Core is rejected.
//!
//! Both sign and verify canonicalize the manifest (recursively sorted object
//! keys) before hashing, so re-serialization across the stack (Mongo, JSON
//! round-trips) never changes the signed bytes. Doing both here keeps one
//! canonicalization code path.
//!
//! **Decomposition (W6): the pure crypto moved out.** The grant-allowlist
//! *matching*, the ed25519 sign / verify over the canonicalized encoding, the
//! canonicalization itself, and the seed / public-key parsers were extracted to
//! the [`ryu_gw_governance`] crate — everything that operates over caller data
//! and *explicit* keys / allowlists. What stays here is the **key custody + the
//! allowlist policy** (the marketplace trust root, kept where the secret lives):
//! the `RYU_MARKETPLACE_SIGNING_KEY` env source-of-truth, the dev-persisted
//! on-disk key, the process `OnceLock`, and the built-in default grant
//! allowlist. The `sign_manifest` / `verify_manifest` / `validate_grants` /
//! `public_key_b64` functions below are thin wrappers that resolve the
//! key/allowlist and delegate to the crate, so `crate::governance::…` call
//! sites are byte-unchanged. `GrantDecision` and `SIGNING_ALGORITHM` are
//! re-exported from the crate.

use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::SigningKey;
use serde_json::Value;

use ryu_gw_governance::{signing_key_from_seed, verifying_key_from_b64};
pub use ryu_gw_governance::{GrantDecision, SIGNING_ALGORITHM};

/// Env var holding the ed25519 signing seed (32-byte secret), base64-encoded.
/// The production source of truth: set it and every gateway replica signs with
/// the same key, so signatures survive restarts and horizontal scale. When
/// unset the Gateway falls back to a **dev-persisted** key on disk (see
/// [`signing_key`]) so signatures still survive a local restart. No secret is
/// ever in code.
const ENV_SIGNING_KEY: &str = "RYU_MARKETPLACE_SIGNING_KEY";

/// Optional override for the on-disk dev-persisted signing key path. When unset
/// the key lives at `$XDG_DATA_HOME/ryu/marketplace-signing-key` (mirrors the
/// audit db location in `config.rs`). Only consulted when `ENV_SIGNING_KEY` is
/// unset. No secret is ever in code.
const ENV_SIGNING_KEY_PATH: &str = "RYU_MARKETPLACE_SIGNING_KEY_PATH";

/// Env var holding a comma/whitespace-separated allowlist of permission grants
/// the marketplace will approve. When unset a sensible built-in default
/// allowlist is used (see [`default_grant_allowlist`]). A grant not on the
/// allowlist is denied, which blocks publish.
const ENV_GRANT_ALLOWLIST: &str = "RYU_MARKETPLACE_GRANT_ALLOWLIST";

/// Built-in default grant allowlist. These mirror the capability scopes a
/// first-party App declares in its `ryu.json` `permission_grants`. Anything
/// outside this set is denied so an over-privileged manifest cannot publish.
fn default_grant_allowlist() -> Vec<String> {
    [
        // tool / MCP capability scopes
        "mcp.tools",
        "tools.read",
        "tools.invoke",
        // Per-server MCP tool grants that the seeded system MCP-tool plugins
        // declare in their `permission_grants` (`spider`, `agentbrowser`,
        // `ghost`, `shadow`). `validate_grants` matches exact scope strings, so
        // each built-in MCP tool needs its own `mcp:<name>` on the allowlist:
        // without them a runtime disable→re-enable (which re-runs
        // `/v1/grants/validate` with the app's full declared grant set) is denied
        // with GrantsDenied. Swappable via the `RYU_MARKETPLACE_GRANT_ALLOWLIST`
        // env override. (Test-only `sample.manifest.json` is not seeded, so its
        // `mcp:web_search`/`mcp:file_read` are intentionally NOT here.)
        "mcp:spider",
        "mcp:agentbrowser",
        // `exa` is a declarative `http` plugin (fixtures/exa.manifest.json), so it
        // declares an egress grant, not an `mcp:<name>` server grant — its enable
        // path validates this exact scope instead.
        "tool:http-egress:api.exa.ai",
        // `spider` and `rtk` were decoupled from Core into declarative `command`
        // tool plugins, so each declares a `tool:command:<bin>` grant instead of
        // its old in-Core provider. Same re-enable rationale as the scopes above.
        "tool:command:spider",
        "tool:command:rtk",
        // `advisor` and `shadow` were decoupled into declarative `http` tools that
        // call Core-local bridges (/api/advisor/consult and the shadow proxy), so
        // both declare loopback egress rather than an `mcp:<name>` grant.
        "tool:http-egress:127.0.0.1",
        "mcp:ghost",
        "mcp:shadow",
        // data scopes
        "memory.read",
        "memory.write",
        "spaces.read",
        "spaces.write",
        "files.read",
        // The Monitors app (`com.ryu.monitors`) drives Core's `/api/monitors/*`
        // orchestration from its sandboxed companion frame via one bridge
        // capability. On the allowlist so the lifecycle enable path
        // (`/v1/grants/validate`) approves a runtime disable→re-enable instead of
        // denying it with GrantsDenied (fresh install seeds the grant directly, so
        // this only bites on the re-enable path). Swappable via the env override.
        "monitors:crud",
        // The Mail companion (`com.ryu.mail`) drives Core's `/api/mail/*` (inboxes/
        // messages/send, proxied to the ryu-mail sidecar) from its sandboxed frame
        // via the `mail.crud` bridge family. Same re-enable rationale as
        // `monitors:crud` above.
        "mail:crud",
        // The Skill-editor companion (`com.ryu.skill-editor`) drives Core's
        // `/api/skills` CRUD from its sandboxed frame via the `skills.crud` bridge
        // family. Same re-enable rationale as `monitors:crud`/`mail:crud` above.
        "skills:crud",
        // model / network scopes
        "model.chat",
        "model.embed",
        "network.fetch",
        // identity-vault scopes (#523): a connection-capture flow and a sealed
        // credential read. Like every scope here they stay swappable via the
        // `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override.
        "browser.connect",
        "identity.read",
        // Widget-render consent: a plugin (built-in Ryu App or third-party MCP
        // server) that declares a `contributes.widgets[]` binding must hold this
        // grant for its tool to auto-promote a sandboxed widget into chat. Gated
        // in Core at the single widget-emit choke point; on the allowlist here so
        // the lifecycle enable path (`/v1/grants/validate`) approves it instead of
        // denying a widget-bearing plugin at enable.
        "widget:render",
        // Companion-app capability scopes that first-party built-ins declare in their
        // `permission_grants` (whiteboard/canvas/meetings own Space documents; canvas
        // also bridges to media + agent-listing + side-model hooks; fine-tuning drives
        // Core's run orchestration). Like `monitors:crud`/`widget:render` above, a fresh
        // install seeds these directly, but the runtime disable→re-enable path re-runs
        // `/v1/grants/validate`; without them a re-enable of whiteboard/canvas/finetune
        // would be denied with GrantsDenied. Swappable via the env override.
        "spaces:docs",
        "core:list_agents",
        "media:generate",
        "media:transcribe",
        "hook:run-agent",
        "hook:side-model",
        "finetune:runs",
        // The Workflows app (`com.ryu.workflows`) drives Core's DAG workflow engine
        // (CRUD + versions + run/run-state/resume), the workflow-template catalog,
        // node-config catalog reads, and ghost record→replay from its sandboxed
        // companion frame via these four bridge capabilities. Same rationale as
        // `monitors:crud` above: a fresh install seeds them directly, but a runtime
        // disable→re-enable re-runs `/v1/grants/validate`; without them the re-enable
        // would be denied with GrantsDenied. Swappable via the env override.
        "workflows:crud",
        "workflows:runstate",
        "workflows:catalogs",
        "ghost:record",
        // The Simulator app (`com.ryu.simulator`) drives the local `simctl`/`adb`
        // device-control sidecar via one grant-gated capability. Same rationale as
        // `monitors:crud` above: a fresh install seeds the grant directly, but a
        // runtime disable→re-enable re-runs `/v1/grants/validate`; without it the
        // re-enable would be denied with GrantsDenied. Swappable via the
        // `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override.
        "simulator:control",
        // The Webhooks app (`com.ryu.webhooks`) renders Core's read-only webhook
        // endpoint registry from its sandboxed companion frame via one bridge
        // capability. Same rationale as `monitors:crud` above: a fresh install seeds the
        // grant directly, but a runtime disable→re-enable re-runs `/v1/grants/validate`;
        // without it the re-enable would be denied with GrantsDenied. Swappable via the
        // `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override.
        "webhooks:crud",
        // The Quests app (`com.ryu.quests`) drives Core's `/api/quests/*` auto-detecting-
        // todo orchestration from its sandboxed companion frame via one bridge capability.
        // Same rationale as `monitors:crud`/`webhooks:crud` above: a fresh install seeds the
        // grant directly, but a runtime disable→re-enable re-runs `/v1/grants/validate`;
        // without it the re-enable would be denied with GrantsDenied. Swappable via the
        // `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override.
        "quests:crud",
        // The Activity app (`com.ryu.activity`) renders Core's read-only unified activity
        // feed from its sandboxed companion frame via one bridge capability. Same
        // rationale as `monitors:crud`/`webhooks:crud`/`quests:crud` above: a fresh install
        // seeds the grant directly, but a runtime disable→re-enable re-runs
        // `/v1/grants/validate`; without it the re-enable would be denied with GrantsDenied.
        // Swappable via the `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override.
        "activity:read",
        // The Timeline app (`com.ryu.timeline`) renders the activity replay scrubber
        // (Shadow's captured lanes + keyframe preview + Dayflow work journal) from its
        // sandboxed companion frame via one bridge capability. Same rationale as
        // `monitors:crud`/`activity:read` above: a fresh install seeds the grant directly,
        // but a runtime disable→re-enable re-runs `/v1/grants/validate`; without it the
        // re-enable would be denied with GrantsDenied. Swappable via the
        // `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override.
        "timeline:read",
        // The Calendar app (`com.ryu.calendar`) renders the scheduled-runs calendar and
        // schedules an agent from its sandboxed companion frame via one bridge capability.
        // Same rationale as `monitors:crud`/`webhooks:crud`/`quests:crud`/`activity:read`
        // above: a fresh install seeds the grant directly, but a runtime disable→re-enable
        // re-runs `/v1/grants/validate`; without it the re-enable would be denied with
        // GrantsDenied. Swappable via the `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override.
        "calendar:crud",
        // The Learning app (`com.ryu.learning`) renders the read-only continual-learning
        // surface (opt-in levels + models, the experience buffer, the self-healing attempt
        // history) from its sandboxed companion frame via one bridge capability. Same
        // rationale as `monitors:crud`/`webhooks:crud`/`quests:crud`/`activity:read`/
        // `calendar:crud` above: a fresh install seeds the grant directly, but a runtime
        // disable→re-enable re-runs `/v1/grants/validate`; without it the re-enable would
        // be denied with GrantsDenied. Swappable via the `RYU_MARKETPLACE_GRANT_ALLOWLIST`
        // env override.
        "learning:crud",
        // The Inbox / Approvals app (`com.ryu.approvals`) renders the unified inbox
        // (pending HITL approvals + the per-user notification feed + quest task
        // check-offs + Shadow's proactive suggestions) from its sandboxed companion
        // frame via one bridge capability (its quest section reuses `quests:crud`, seeded
        // separately above). Same rationale as `monitors:crud`/`quests:crud`/`learning:crud`
        // above: a fresh install seeds the grant directly, but a runtime disable→re-enable
        // re-runs `/v1/grants/validate`; without it the re-enable would be denied with
        // GrantsDenied. Swappable via the `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override.
        "approvals:crud",
        // The Meetings app (`com.ryu.meetings`) drives Core's `/api/meetings/*`
        // orchestration (record → live transcript → AI notes + audio import) from its
        // sandboxed companion frame via one bridge capability. Same rationale as
        // `monitors:crud`/`learning:crud` above: a fresh install seeds the grant directly,
        // but a runtime disable→re-enable re-runs `/v1/grants/validate`; without it the
        // re-enable would be denied with GrantsDenied. Swappable via the
        // `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override.
        "meetings:crud",
        // Shell integration: a companion app that contributes a sidebar section /
        // navigation entry to the host shell declares this. Seeded by four built-in
        // fixtures (`activity`, `approvals`, `skill-editor`, `timeline`). Same
        // rationale as `monitors:crud` above — a fresh install seeds the grant
        // directly, but a runtime disable→re-enable re-runs `/v1/grants/validate`
        // and would be denied with GrantsDenied without it. This is what
        // `every_builtin_fixture_grant_is_allowlisted` caught. Swappable via the
        // `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override.
        "shell:integrate",
        // A durable key/value store scope declared by the seeded chat-hook
        // plugins (`goal`, `proof`) so they can persist run state. Same re-enable
        // rationale as the companion scopes above. Swappable via the env override.
        "storage:kv",
        // The follow-up-message scope declared by the seeded widget companion
        // plugins (`checklist`, `chart-studio`, `data-grid-explorer`,
        // `decision-wizard`, `worktree-diff-review`), which post a follow-up chat
        // turn from their sandboxed frame. On the allowlist so a runtime
        // disable→re-enable of a widget companion is approved, not denied with
        // GrantsDenied. Swappable via the env override.
        "chat.sendFollowUp",
        // The Browser app (`com.ryu.browser`) exposes a real-Chromium Electron
        // sidecar as the grant-gated `browser.control` capability (list/open/
        // navigate tabs, screenshot, read titles, evaluate JS), which the desktop
        // Browser panel drives through the ext-proxy. Same rationale as
        // `monitors:crud`/`meetings:crud` above: a fresh install seeds the grant
        // directly, but a runtime disable→re-enable re-runs `/v1/grants/validate`;
        // without it the re-enable would be denied with GrantsDenied. Swappable via
        // the `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override.
        "browser:control",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

/// Resolve the active grant allowlist from env, falling back to the built-in
/// default. Cached for the process lifetime.
fn grant_allowlist() -> &'static Vec<String> {
    static ALLOWLIST: OnceLock<Vec<String>> = OnceLock::new();
    ALLOWLIST.get_or_init(|| match std::env::var(ENV_GRANT_ALLOWLIST) {
        Ok(raw) if !raw.trim().is_empty() => raw
            .split([',', ' ', '\n', '\t'])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        _ => default_grant_allowlist(),
    })
}

/// Validate the requested grants against the gateway's active allowlist (env
/// override or built-in default). Delegates the matching to
/// [`ryu_gw_governance::validate_grants`].
pub fn validate_grants(grants: &[String]) -> GrantDecision {
    ryu_gw_governance::validate_grants(grants, grant_allowlist())
}

// ── Signing ─────────────────────────────────────────────────────────────────

/// Resolve the process signing key, in priority order:
///   1. `RYU_MARKETPLACE_SIGNING_KEY` env (base64 32-byte seed) — the production
///      source of truth. Stable across restarts and across replicas.
///   2. A dev-persisted key file (`$XDG_DATA_HOME/ryu/marketplace-signing-key`,
///      or `RYU_MARKETPLACE_SIGNING_KEY_PATH`): read it if present, else
///      generate a fresh key AND write it there so it is stable across local
///      restarts. This is what closes the "signatures die on every bounce" gap
///      for a managed local gateway where no env key is configured.
///   3. Only if disk persistence is impossible (no data dir / write fails) do we
///      fall back to an ephemeral key, and we say so loudly.
///
/// The public half is always discoverable via [`public_key_b64`] (same process
/// key), which is how the verify side (`POST /v1/manifests/verify` with no
/// pinned `public_key`) checks a signature — so a persistent private key gives a
/// persistent public key and prior signatures keep verifying.
fn signing_key() -> &'static SigningKey {
    static KEY: OnceLock<SigningKey> = OnceLock::new();
    KEY.get_or_init(|| {
        // 1. Configured production key (env).
        if let Ok(raw) = std::env::var(ENV_SIGNING_KEY) {
            if let Some(key) = signing_key_from_seed(raw.trim()) {
                tracing::info!(
                    "governance: marketplace signing key configured from {ENV_SIGNING_KEY} (production)"
                );
                return key;
            }
            tracing::warn!(
                "governance: {ENV_SIGNING_KEY} set but not a valid base64 32-byte seed; falling back to a dev-persisted key"
            );
        }

        // 2. Dev-persisted key on disk (read existing, else generate + persist).
        if let Some(path) = signing_key_path() {
            if let Some(key) = read_persisted_signing_key(&path) {
                tracing::info!(
                    path = %path.display(),
                    public_key = %B64.encode(key.verifying_key().to_bytes()),
                    "governance: loaded dev-persisted marketplace signing key (set {ENV_SIGNING_KEY} for production)"
                );
                return key;
            }
            let mut csprng = rand::rngs::OsRng;
            let key = SigningKey::generate(&mut csprng);
            if persist_signing_key(&path, &key) {
                tracing::warn!(
                    path = %path.display(),
                    public_key = %B64.encode(key.verifying_key().to_bytes()),
                    "governance: generated and PERSISTED a dev marketplace signing key (stable across restarts; set {ENV_SIGNING_KEY} for production)"
                );
                return key;
            }
            tracing::error!(
                path = %path.display(),
                "governance: could not persist a dev signing key; using EPHEMERAL key (signatures will NOT survive restart — set {ENV_SIGNING_KEY})"
            );
            return key;
        }

        // 3. No data dir at all — ephemeral, loudly.
        tracing::error!(
            "governance: no data dir for a persisted signing key; using EPHEMERAL key (signatures will NOT survive restart — set {ENV_SIGNING_KEY})"
        );
        let mut csprng = rand::rngs::OsRng;
        SigningKey::generate(&mut csprng)
    })
}

/// Resolve the on-disk path for the dev-persisted signing key: the
/// `RYU_MARKETPLACE_SIGNING_KEY_PATH` override, else
/// `$XDG_DATA_HOME/ryu/marketplace-signing-key` (mirrors the audit db location).
/// `None` when no data dir can be resolved.
fn signing_key_path() -> Option<std::path::PathBuf> {
    if let Ok(raw) = std::env::var(ENV_SIGNING_KEY_PATH) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(std::path::PathBuf::from(trimmed));
        }
    }
    dirs::data_local_dir().map(|d| d.join("ryu").join("marketplace-signing-key"))
}

/// Read a base64 32-byte seed from the persisted key file, if it exists and
/// parses. Any read/parse error returns `None` (the caller then regenerates).
fn read_persisted_signing_key(path: &std::path::Path) -> Option<SigningKey> {
    let raw = std::fs::read_to_string(path).ok()?;
    signing_key_from_seed(raw.trim())
}

/// Persist a signing key's 32-byte seed (base64) to `path`, creating parent
/// directories. Returns `true` on success. Never panics.
///
/// On Unix the file is created **atomically at mode `0600`** via an owner-only
/// `open` (not written-then-chmod'd), so the private seed is never observable at
/// a permissive umask, and the parent directory is tightened to `0700`. Closing
/// the write-then-chmod TOCTOU window matters because this is an ed25519 signing
/// key — a brief world-readable moment is a real disclosure.
fn persist_signing_key(path: &std::path::Path, key: &SigningKey) -> bool {
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Best-effort: the file itself is created 0600 below regardless, so a
            // failure to tighten the dir is not fatal — but do it so the key is
            // not readable via a permissive parent.
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let seed_b64 = B64.encode(key.to_bytes());

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = match opts.open(path) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "governance: could not create persisted signing key file");
            return false;
        }
    };
    use std::io::Write;
    if let Err(e) = file.write_all(seed_b64.as_bytes()) {
        tracing::warn!(path = %path.display(), error = %e, "governance: could not write persisted signing key");
        return false;
    }
    true
}

/// The base64-encoded public verifying key, exposed so clients can pin it.
pub fn public_key_b64() -> String {
    ryu_gw_governance::public_key_b64(&signing_key().verifying_key())
}

/// Sign a manifest with the gateway's process signing key, returning the
/// base64-encoded ed25519 signature over the canonicalized manifest bytes.
pub fn sign_manifest(manifest: &Value) -> String {
    ryu_gw_governance::sign_manifest(signing_key(), manifest)
}

/// Verify a base64 signature against a manifest. When `public_key_b64` is
/// `None` the process key is used (the common case: same Gateway signed and
/// verifies). A malformed pinned public key, a tampered manifest, or a wrong
/// key returns `false`.
pub fn verify_manifest(
    manifest: &Value,
    signature_b64: &str,
    public_key_b64: Option<&str>,
) -> bool {
    let verifying_key = match public_key_b64 {
        Some(pk) => match verifying_key_from_b64(pk) {
            Some(k) => k,
            None => return false,
        },
        None => signing_key().verifying_key(),
    };
    ryu_gw_governance::verify_manifest(manifest, signature_b64, &verifying_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer;
    use serde_json::json;

    #[test]
    fn default_allowlist_approves_known_grant() {
        let d = validate_grants(&["mcp.tools".to_string(), "memory.read".to_string()]);
        assert!(d.all_approved());
        assert_eq!(d.approved.len(), 2);
        assert!(d.denied.is_empty());
    }

    #[test]
    fn unknown_grant_is_denied_and_blocks() {
        let d = validate_grants(&["mcp.tools".to_string(), "filesystem.write_all".to_string()]);
        assert!(!d.all_approved());
        assert_eq!(d.denied, vec!["filesystem.write_all".to_string()]);
        assert_eq!(d.approved, vec!["mcp.tools".to_string()]);
    }

    #[test]
    fn empty_grants_approve() {
        let d = validate_grants(&[]);
        assert!(d.all_approved());
    }

    #[test]
    fn identity_vault_scopes_are_approved() {
        // #523: the identity-vault grant scopes must be on the built-in allowlist
        // so a credential-read/connect flow is governed, not denied.
        let d = validate_grants(&["browser.connect".to_string(), "identity.read".to_string()]);
        assert!(d.all_approved());
        assert_eq!(d.approved.len(), 2);
        assert!(d.denied.is_empty());
    }

    #[test]
    fn workflows_companion_grants_are_approved() {
        // Crux #2: the Workflows companion's four bridge grants must be on the
        // built-in allowlist so a runtime disable→re-enable (which re-runs
        // `/v1/grants/validate`) approves them instead of dropping them with
        // GrantsDenied — which would leave the canvas unable to call anything.
        let d = validate_grants(&[
            "workflows:crud".to_string(),
            "workflows:runstate".to_string(),
            "workflows:catalogs".to_string(),
            "ghost:record".to_string(),
        ]);
        assert!(d.all_approved());
        assert_eq!(d.approved.len(), 4);
        assert!(d.denied.is_empty());
    }

    /// Drift tripwire: every grant a **seeded built-in** fixture declares must be
    /// on the allowlist. Core's enable path (`plugins/lifecycle.rs`) sends an
    /// app's full `permission_grants` set through `/v1/grants/validate` on every
    /// enable — including a runtime disable→re-enable — so a declared grant that
    /// is not allowlisted is denied with GrantsDenied and the app cannot re-enable.
    ///
    /// Rather than restate the grant set (which would silently pass when a NEW
    /// fixture adds an unlisted grant — the exact drift this guards), the test
    /// READS the fixtures Core compiles in (`apps/core/src/plugin_manifest/
    /// fixtures/*.manifest.json`) and asserts `validate_grants` approves each
    /// declared grant. This also enforces handoff §8 automatically: a fixture that
    /// declared `sidecar:process` (or any other unlisted scope) would fail here.
    ///
    /// `sample.manifest.json` is excluded: it is a test-only demo, not in
    /// `SEED_MANIFESTS`, so it is never enabled at runtime and its file-read/
    /// web-search scopes must NOT loosen the marketplace-publish allowlist.
    ///
    /// Read at runtime (not `include_str!`, which can't cross crates cleanly) and
    /// skipped when the fixtures dir is absent, so a separately-vendored gateway
    /// (no sibling `apps/core`) still tests green — mirrors the core companion-pair
    /// test's skip-if-absent posture.
    #[test]
    fn every_builtin_fixture_grant_is_allowlisted() {
        let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("core")
            .join("src")
            .join("plugin_manifest")
            .join("fixtures");
        let Ok(entries) = std::fs::read_dir(&fixtures) else {
            // Vendored gateway without sibling `apps/core` — nothing to check.
            return;
        };

        let mut checked_files = 0;
        let mut checked_grants = 0;
        let mut failures: Vec<String> = Vec::new();

        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".manifest.json") {
                continue; // skip .ui.html and anything else
            }
            if name == "sample.manifest.json" {
                continue; // test-only demo, not seeded (see doc comment)
            }
            let raw = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("fixture {} unreadable: {e}", path.display()));
            let manifest: Value = serde_json::from_str(&raw)
                .unwrap_or_else(|e| panic!("fixture {name} is not valid JSON: {e}"));
            let Some(grants) = manifest.get("permission_grants").and_then(Value::as_array) else {
                continue; // no declared grants
            };
            checked_files += 1;
            let declared: Vec<String> = grants
                .iter()
                .filter_map(|g| g.as_str().map(str::to_string))
                .collect();
            let decision = validate_grants(&declared);
            for denied in decision.denied {
                failures.push(format!("{name}: '{denied}'"));
            }
            checked_grants += declared.len();
        }

        assert!(
            failures.is_empty(),
            "seeded built-in fixtures declare grants missing from default_grant_allowlist() \
             (a runtime disable→re-enable would fail with GrantsDenied). Add each to the \
             allowlist (or, for `sidecar:process`, remove it from the fixture per handoff §8): {}",
            failures.join(", ")
        );
        // Guard against a vacuous pass: the dir existed, so we must have parsed at
        // least a few grant-bearing fixtures.
        assert!(
            checked_files > 0 && checked_grants > 0,
            "fixtures dir resolved but no grant-bearing fixtures were read \
             (checked_files={checked_files}, checked_grants={checked_grants})"
        );
    }

    #[test]
    fn sign_then_verify_roundtrips() {
        let manifest = json!({"id": "acme/widget", "version": "1.0.0", "grants": ["mcp.tools"]});
        let sig = sign_manifest(&manifest);
        assert!(verify_manifest(&manifest, &sig, None));
    }

    #[test]
    fn explicit_public_key_verifies() {
        let manifest = json!({"id": "x"});
        let sig = sign_manifest(&manifest);
        let pk = public_key_b64();
        assert!(verify_manifest(&manifest, &sig, Some(&pk)));
    }

    #[test]
    fn malformed_pinned_public_key_fails_verify() {
        // The gateway wrapper resolves a caller-pinned public key; a malformed one
        // must return false (unverifiable), not fall through to the process key.
        let manifest = json!({"id": "x"});
        let sig = sign_manifest(&manifest);
        assert!(!verify_manifest(&manifest, &sig, Some("not-base64!!!")));
    }

    #[test]
    fn persist_then_read_signing_key_roundtrips() {
        // A generated key persisted to disk must read back as the SAME key, so a
        // signature made before a restart still verifies after (the dev-persist
        // path that closes the "ephemeral key dies on bounce" gap). We exercise
        // the helpers directly since `signing_key()` is a process-wide OnceLock.
        let mut csprng = rand::rngs::OsRng;
        let key = SigningKey::generate(&mut csprng);
        let dir = std::env::temp_dir().join(format!("ryu-govtest-{}", std::process::id()));
        let path = dir.join("marketplace-signing-key");

        assert!(persist_signing_key(&path, &key), "persist should succeed");
        let loaded = read_persisted_signing_key(&path).expect("read back the key");

        // Same public key ⇒ same verifying identity across a simulated restart.
        assert_eq!(
            loaded.verifying_key().to_bytes(),
            key.verifying_key().to_bytes()
        );
        // A signature made with the original verifies against the reloaded key.
        let manifest = json!({"id": "acme/widget", "version": "1.0.0"});
        let sig = B64.encode(
            key.sign(&ryu_gw_governance::canonical_bytes(&manifest))
                .to_bytes(),
        );
        assert!(verify_manifest(
            &manifest,
            &sig,
            Some(&B64.encode(loaded.verifying_key().to_bytes()))
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
