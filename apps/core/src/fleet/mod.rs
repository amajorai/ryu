//! Node-local fleet state: explicit control-plane project mappings.
//!
//! Central project ids never carry machine paths. This store is the only bridge
//! between an org project and a checkout on this node; the control plane receives
//! ids/status only. Managed desired-state reconciliation builds on this module.

use std::{
    collections::{BTreeMap, HashSet},
    io::Write,
    path::{Path, PathBuf},
    sync::{OnceLock, RwLock},
    time::Duration,
};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::Context as _;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use base64::Engine;
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use x25519_dalek::{PublicKey as EncryptionPublicKey, StaticSecret};

use crate::server::ServerState;

mod host_status;
#[cfg(test)]
mod routes_test;

const MAX_POLL_SECONDS: u64 = 25;
const RETRY_SECONDS: u64 = 60;
const ENROLLMENT_CLAIM_DOMAIN: &str = "ryu:fleet-enrollment:v2\n";
const MAX_CONTROL_PLANE_URL_BYTES: usize = 2048;

static ENROLLMENT_OPERATION_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn enrollment_operation_lock() -> &'static tokio::sync::Mutex<()> {
    ENROLLMENT_OPERATION_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FleetIdentity {
    control_plane_url: String,
    credential: String,
    node_id: String,
    organization_id: String,
    signing_private_key: String,
    signing_public_key: String,
    encryption_private_key: String,
    encryption_public_key: String,
    snapshot_public_key: String,
    #[serde(default)]
    credential_updated_at: Option<DateTime<Utc>>,
    /// A successor credential this node generated and saved before asking the
    /// control plane to rotate to it. It survives a lost rotation reply, so the
    /// node can confirm the successor instead of being locked out once the
    /// control plane stops accepting the old bearer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_credential: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollBody {
    control_plane_url: String,
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollResponse {
    credential: String,
    node_id: String,
    organization_id: String,
    signing_public_key: String,
    #[serde(default)]
    organization_binding: Option<EnrollmentOrganizationBinding>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentOrganizationBinding {
    status: String,
    acknowledgement_required: bool,
    control_credential: String,
    relay_credential: String,
    managed_fleet_url: String,
    credential_set_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingEnrollmentAttempt {
    claim_id: String,
    control_plane_url: String,
    token: String,
    token_hash: String,
    signing_private_key: String,
    signing_public_key: String,
    encryption_private_key: String,
    encryption_public_key: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrolledNodeBundle {
    claim_id: String,
    token_hash: String,
    fleet_identity: FleetIdentity,
    organization_binding: EnrollmentOrganizationBinding,
    #[serde(default)]
    acknowledged: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentAcknowledgement {
    acknowledged: bool,
    status: String,
    node_id: String,
    organization_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignedSnapshot {
    payload: Value,
    public_key: String,
    signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealedNodeSecret {
    ciphertext: String,
    ephemeral_public_key: String,
    nonce: String,
    tag: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FleetLocalStatus {
    last_attempt_at: Option<String>,
    last_error: Option<String>,
    observed_revision: u64,
    stale: bool,
    status: String,
}

fn identity_path() -> PathBuf {
    crate::paths::state_path("fleet-identity.json")
}

fn pending_enrollment_path() -> PathBuf {
    crate::paths::state_path("fleet-enrollment-pending.json")
}

fn enrolled_bundle_path() -> PathBuf {
    crate::paths::state_path("fleet-enrolled-node.json")
}

fn snapshot_path() -> PathBuf {
    crate::paths::state_path("fleet-desired.json")
}

fn status_path() -> PathBuf {
    crate::paths::state_path("fleet-status.json")
}

fn enforcement_path() -> PathBuf {
    crate::paths::state_path("fleet-enforcement.json")
}

fn artifact_cache_dir() -> PathBuf {
    crate::paths::state_path("fleet-artifacts")
}

fn skill_blocks_path() -> PathBuf {
    crate::paths::state_path("fleet-skill-blocks.json")
}

const FLEET_SKILL_MARKER: &str = ".ryu-fleet-owner.json";

fn legacy_instance_id() -> anyhow::Result<String> {
    let path = crate::paths::state_path("fleet-instance-id.json");
    if let Ok(id) = load_json::<String>(&path) {
        if !id.trim().is_empty() {
            return Ok(id);
        }
    }
    let id = hex::encode(rand::random::<[u8; 16]>());
    atomic_json(&path, &id, true)?;
    Ok(id)
}

#[cfg(unix)]
fn restrict_file(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_file(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

/// Fleet state files that hold credentials or private keys (the node credential,
/// its Ed25519/X25519 private keys, the raw enrollment token, and the
/// organization control and relay credentials). Their whole JSON body is sealed
/// with the master key (`enc:v1:`); a plaintext file an older build wrote is
/// read and sealed in place on its next load.
const SEALED_STATE_FILES: [&str; 3] = [
    "fleet-identity.json",
    "fleet-enrollment-pending.json",
    "fleet-enrolled-node.json",
];

fn is_sealed_state_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| SEALED_STATE_FILES.contains(&name))
}

/// The master-key cipher for fleet secrets. Fails closed: without a key no
/// secret state is written and no sealed state is read.
fn state_cipher() -> anyhow::Result<ryu_crypto::FieldCipher> {
    crate::crypto_host::install();
    ryu_crypto::global_cipher().context("loading the key that seals fleet credentials")
}

/// Write `value` as JSON through an owner-only temp file and an atomic rename.
/// `secret` state is sealed before any byte reaches disk.
fn atomic_json<T: Serialize>(path: &Path, value: &T, secret: bool) -> anyhow::Result<()> {
    let mut body = serde_json::to_vec_pretty(value)?;
    if secret {
        let json = String::from_utf8(body).context("fleet state is not UTF-8")?;
        body = state_cipher()?.seal(&json)?.into_bytes();
    }
    write_state_body(path, &body, secret)
}

fn write_state_body(path: &Path, body: &[u8], secret: bool) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("state path has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".ryu-state-")
        .tempfile_in(parent)?;
    if secret {
        restrict_file(temporary.path())?;
    }
    temporary.as_file_mut().write_all(body)?;
    temporary.as_file_mut().write_all(b"\n")?;
    temporary.as_file_mut().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| anyhow::anyhow!(error.error))?;
    Ok(())
}

/// Read JSON state. A sealed body is opened with the master key (an error when
/// the key is missing or wrong, never a silent default); a legacy plaintext
/// body of a [`SEALED_STATE_FILES`] file is sealed in place once.
fn load_json<T: for<'de> Deserialize<'de>>(path: &Path) -> anyhow::Result<T> {
    let text = String::from_utf8(std::fs::read(path)?).context("fleet state is not UTF-8")?;
    let body = text.trim();
    if ryu_crypto::looks_sealed(body) {
        let json = ryu_crypto::SecretSealer::open(&state_cipher()?, body)
            .with_context(|| format!("opening sealed {}", path.display()))?;
        return Ok(serde_json::from_str(&json)?);
    }
    let value = serde_json::from_str(&text)?;
    if is_sealed_state_file(path) {
        let resealed = state_cipher()
            .and_then(|cipher| Ok(cipher.seal(body)?))
            .and_then(|sealed| write_state_body(path, sealed.as_bytes(), true));
        if let Err(error) = resealed {
            tracing::warn!(path = %path.display(), "fleet: could not seal legacy state in place: {error:#}");
        }
    }
    Ok(value)
}

fn load_fleet_identity_from(
    bundle_path: &Path,
    legacy_identity_path: &Path,
) -> anyhow::Result<FleetIdentity> {
    if bundle_path.exists() {
        let bundle: EnrolledNodeBundle = load_json(bundle_path)?;
        if !bundle.acknowledged {
            anyhow::bail!("organization enrollment is waiting for acknowledgement");
        }
        return Ok(bundle.fleet_identity);
    }
    load_json(legacy_identity_path)
}

fn load_fleet_identity() -> anyhow::Result<FleetIdentity> {
    load_fleet_identity_from(&enrolled_bundle_path(), &identity_path())
}

/// The enrolled node's Ed25519 identity key, for signing statements this node
/// publishes about itself (the A2A Agent Card). `None` when the node is not
/// enrolled, enrollment is unacknowledged, or the stored key pair is
/// inconsistent. Every other use of this key is domain-separated (enrollment
/// claims are prefixed with [`ENROLLMENT_CLAIM_DOMAIN`]), so a JWS signing
/// input, which is base64url text, can never collide with one.
pub(crate) fn node_identity_signing_key() -> Option<SigningKey> {
    node_identity_signing_key_from(&load_fleet_identity().ok()?)
}

fn node_identity_signing_key_from(identity: &FleetIdentity) -> Option<SigningKey> {
    let private = decode_32_bytes(&identity.signing_private_key, "signingPrivateKey").ok()?;
    let key = SigningKey::from_bytes(&private);
    let published =
        base64::engine::general_purpose::STANDARD.encode(key.verifying_key().as_bytes());
    (published == identity.signing_public_key).then_some(key)
}

fn save_fleet_identity(identity: &FleetIdentity) -> anyhow::Result<()> {
    let bundle_path = enrolled_bundle_path();
    if bundle_path.exists() {
        let mut bundle: EnrolledNodeBundle = load_json(&bundle_path)?;
        bundle.fleet_identity = identity.clone();
        return atomic_json(&bundle_path, &bundle, true);
    }
    atomic_json(&identity_path(), identity, true)
}

fn load_enrolled_bundle_from(path: &Path) -> Option<EnrolledNodeBundle> {
    read_enrolled_bundle_from(path).ok().flatten()
}

fn read_enrolled_bundle_from(path: &Path) -> anyhow::Result<Option<EnrolledNodeBundle>> {
    if !path.exists() {
        return Ok(None);
    }
    let bundle = load_json::<EnrolledNodeBundle>(path)?;
    validate_enrolled_bundle(&bundle)?;
    Ok(Some(bundle))
}

fn load_enrolled_bundle() -> Option<EnrolledNodeBundle> {
    load_enrolled_bundle_from(&enrolled_bundle_path())
}

/// Whether Core has persisted a v2 enrollment bundle, including one still
/// awaiting acknowledgement. Used only to protect the self-hosted local bearer
/// during startup; credential readers still validate the file contents.
pub fn has_enrolled_node_bundle() -> bool {
    enrolled_bundle_path().exists()
}

/// Whether startup should wait for the Fleet reconciler to finish a saved v2
/// enrollment before deciding this is an unbound local node.
pub fn enrollment_recovery_pending() -> bool {
    if pending_enrollment_path().exists() {
        return true;
    }
    read_enrolled_bundle_from(&enrolled_bundle_path())
        .map(|bundle| bundle.is_some_and(|bundle| !bundle.acknowledged))
        .unwrap_or_else(|_| enrolled_bundle_path().exists())
}

/// The organization-scoped node-control credential from a completed v2
/// enrollment. Environment overrides are applied by the control-plane reader,
/// not here, so this function can never mutate the local Gateway bearer.
pub fn enrolled_control_token() -> Option<String> {
    enrolled_control_token_from(&enrolled_bundle_path())
}

fn enrolled_control_token_from(path: &Path) -> Option<String> {
    load_enrolled_bundle_from(path)
        .filter(|bundle| bundle.acknowledged)
        .map(|bundle| bundle.organization_binding.control_credential)
}

/// The control-plane base URL saved with an acknowledged v2 enrollment.
pub fn enrolled_control_plane_url() -> Option<String> {
    enrolled_control_plane_url_from(&enrolled_bundle_path())
}

fn enrolled_control_plane_url_from(path: &Path) -> Option<String> {
    load_enrolled_bundle_from(path)
        .filter(|bundle| bundle.acknowledged)
        .map(|bundle| bundle.fleet_identity.control_plane_url)
}

/// The hosted managed-inference coordinates from a completed v2 enrollment.
/// The local Gateway continues to use its own URL and bearer.
pub fn enrolled_managed_fleet() -> Option<(String, String)> {
    enrolled_managed_fleet_from(&enrolled_bundle_path())
}

fn enrolled_managed_fleet_from(path: &Path) -> Option<(String, String)> {
    load_enrolled_bundle_from(path)
        .filter(|bundle| bundle.acknowledged)
        .map(|bundle| {
            (
                bundle.organization_binding.managed_fleet_url,
                bundle.organization_binding.relay_credential,
            )
        })
}

pub(crate) struct EnrolledDiagnosticsRelay {
    pub(crate) control_plane_url: String,
    pub(crate) relay_token: String,
}

/// The least-privilege relay credential and Ryu control-plane origin from an
/// acknowledged enrollment. Unbound local installs have no Ryu telemetry path.
pub(crate) fn enrolled_diagnostics_relay() -> Option<EnrolledDiagnosticsRelay> {
    enrolled_diagnostics_relay_from(&enrolled_bundle_path())
}

fn enrolled_diagnostics_relay_from(path: &Path) -> Option<EnrolledDiagnosticsRelay> {
    load_enrolled_bundle_from(path)
        .filter(|bundle| bundle.acknowledged)
        .map(|bundle| EnrolledDiagnosticsRelay {
            control_plane_url: bundle.fleet_identity.control_plane_url,
            relay_token: bundle.organization_binding.relay_credential,
        })
}

fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize_json).collect()),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), canonicalize_json(value)))
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn verify_snapshot(identity: &FleetIdentity, snapshot: &SignedSnapshot) -> anyhow::Result<u64> {
    use anyhow::{anyhow, bail};

    if snapshot.public_key != identity.snapshot_public_key {
        bail!("snapshot signing key does not match the enrolled key");
    }
    let public_bytes = base64::engine::general_purpose::STANDARD.decode(&snapshot.public_key)?;
    let public_bytes: [u8; 32] = public_bytes
        .try_into()
        .map_err(|_| anyhow!("snapshot public key must be 32 bytes"))?;
    let verifying_key = VerifyingKey::from_bytes(&public_bytes)?;
    let signature = Signature::from_slice(
        &base64::engine::general_purpose::STANDARD.decode(&snapshot.signature)?,
    )?;
    let canonical = serde_json::to_vec(&canonicalize_json(&snapshot.payload))?;
    verifying_key.verify(&canonical, &signature)?;

    if snapshot.payload.get("nodeId").and_then(Value::as_str) != Some(&identity.node_id) {
        bail!("snapshot was issued to a different node");
    }
    let expires_at = snapshot
        .payload
        .get("expiresAt")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("snapshot has no expiry"))?
        .parse::<DateTime<Utc>>()?;
    if expires_at <= Utc::now() {
        bail!("snapshot has expired");
    }
    snapshot
        .payload
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("snapshot revision is missing"))
}

fn cache_artifacts(
    identity: &FleetIdentity,
    snapshot: &SignedSnapshot,
) -> anyhow::Result<Vec<Value>> {
    use anyhow::{anyhow, bail};

    let assignments = snapshot
        .payload
        .get("assignments")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("snapshot assignments are missing"))?;
    std::fs::create_dir_all(artifact_cache_dir())?;
    let mut observed = Vec::with_capacity(assignments.len());
    for assignment in assignments {
        let disposition = assignment
            .get("disposition")
            .and_then(Value::as_str)
            .unwrap_or("optional");
        let assignment_id = assignment.get("id").and_then(Value::as_str).unwrap_or("");
        if disposition == "blocked" {
            observed.push(json!({ "assignmentId": assignment_id, "status": "blocked" }));
            continue;
        }
        if disposition == "optional" {
            observed.push(json!({ "assignmentId": assignment_id, "status": "optional" }));
            continue;
        }
        let artifact = assignment
            .get("artifact")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("required assignment {assignment_id} has no artifact"))?;
        let descriptor = artifact
            .get("descriptor")
            .ok_or_else(|| anyhow!("required assignment {assignment_id} has no descriptor"))?;
        let expected = artifact
            .get("digest")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("required assignment {assignment_id} has no digest"))?;
        let actual = hex::encode(Sha256::digest(serde_json::to_vec(&canonicalize_json(
            descriptor,
        ))?));
        if actual != expected {
            bail!("artifact digest mismatch for assignment {assignment_id}");
        }
        let key_id = artifact.get("keyId").and_then(Value::as_str).unwrap_or("");
        if key_id.starts_with("fleet:") {
            let public_bytes =
                base64::engine::general_purpose::STANDARD.decode(&identity.snapshot_public_key)?;
            let public_bytes: [u8; 32] = public_bytes
                .try_into()
                .map_err(|_| anyhow!("artifact public key must be 32 bytes"))?;
            let signature = artifact
                .get("signature")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("artifact {assignment_id} has no signature"))?;
            let signature = Signature::from_slice(
                &base64::engine::general_purpose::STANDARD.decode(signature)?,
            )?;
            let signed = canonicalize_json(&json!({
                "descriptor": descriptor,
                "digest": expected,
            }));
            VerifyingKey::from_bytes(&public_bytes)?
                .verify(&serde_json::to_vec(&signed)?, &signature)?;
        } else {
            bail!("artifact {assignment_id} uses an untrusted signing key");
        }
        atomic_json(
            &artifact_cache_dir().join(format!("{expected}.json")),
            descriptor,
            false,
        )?;
        observed.push(json!({
            "activation": assignment.get("activation"),
            "assignmentId": assignment_id,
            "digest": expected,
            "status": "installing"
        }));
    }
    Ok(observed)
}

fn collect_secret_refs(value: &Value, output: &mut HashSet<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_secret_refs(item, output);
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                if key == "secretRef" {
                    if child.get("kind").and_then(Value::as_str) == Some("org_secret") {
                        if let Some(id) = child.get("id").and_then(Value::as_str) {
                            output.insert(id.to_owned());
                        }
                    }
                } else {
                    collect_secret_refs(child, output);
                }
            }
        }
        _ => {}
    }
}

async fn materialize_secrets(
    identity: &FleetIdentity,
    snapshot: &SignedSnapshot,
) -> anyhow::Result<HashSet<String>> {
    use anyhow::anyhow;

    let private_bytes =
        base64::engine::general_purpose::STANDARD.decode(&identity.encryption_private_key)?;
    let private_bytes: [u8; 32] = private_bytes
        .try_into()
        .map_err(|_| anyhow!("node encryption private key must be 32 bytes"))?;
    let private_key = StaticSecret::from(private_bytes);
    let mut delivered = HashSet::new();
    let Some(secrets) = snapshot.payload.get("secrets").and_then(Value::as_array) else {
        return Ok(delivered);
    };
    if secrets.is_empty() {
        return Ok(delivered);
    }
    let store = crate::plugin_secrets::global()
        .ok_or_else(|| anyhow!("node secret store is unavailable"))?;
    for entry in secrets {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("sealed secret has no id"))?;
        let sealed: SealedNodeSecret = serde_json::from_value(
            entry
                .get("sealed")
                .cloned()
                .ok_or_else(|| anyhow!("sealed secret has no envelope"))?,
        )?;
        let ephemeral_bytes =
            base64::engine::general_purpose::STANDARD.decode(sealed.ephemeral_public_key)?;
        let ephemeral_bytes: [u8; 32] = ephemeral_bytes
            .try_into()
            .map_err(|_| anyhow!("ephemeral public key must be 32 bytes"))?;
        let shared = private_key.diffie_hellman(&EncryptionPublicKey::from(ephemeral_bytes));
        let key = Sha256::digest(shared.as_bytes());
        let cipher = Aes256Gcm::new_from_slice(&key)?;
        let nonce_bytes = base64::engine::general_purpose::STANDARD.decode(sealed.nonce)?;
        if nonce_bytes.len() != 12 {
            return Err(anyhow!("sealed secret nonce must be 12 bytes"));
        }
        let mut ciphertext = base64::engine::general_purpose::STANDARD.decode(sealed.ciphertext)?;
        ciphertext.extend(base64::engine::general_purpose::STANDARD.decode(sealed.tag)?);
        let plaintext = cipher
            .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
            .map_err(|_| anyhow!("could not decrypt sealed secret '{id}'"))?;
        store
            .set("fleet", id, &String::from_utf8(plaintext)?)
            .await?;
        delivered.insert(id.to_owned());
    }
    Ok(delivered)
}

fn artifact_disposition(id: &str) -> Option<String> {
    let persisted_blocks = load_json::<Value>(&enforcement_path())
        .ok()
        .and_then(|enforcement| enforcement.get("assignments").cloned());
    if persisted_blocks.as_ref().is_some_and(|assignments| {
        assignments.as_array().is_some_and(|assignments| {
            assignments.iter().any(|assignment| {
                assignment
                    .get("artifact")
                    .and_then(|artifact| artifact.get("artifactId"))
                    .and_then(Value::as_str)
                    == Some(id)
            })
        })
    }) {
        return Some("blocked".to_owned());
    }
    let active = active_assignments_cache()
        .read()
        .ok()
        .and_then(|assignments| assignments.clone())
        .or_else(|| {
            load_json::<SignedSnapshot>(&snapshot_path())
                .ok()
                .and_then(|snapshot| snapshot.payload.get("assignments").cloned())
        })?;
    active
        .as_array()?
        .iter()
        .find(|assignment| {
            assignment
                .get("artifact")
                .and_then(|artifact| artifact.get("artifactId"))
                .and_then(Value::as_str)
                == Some(id)
        })?
        .get("disposition")?
        .as_str()
        .map(str::to_owned)
}

fn agent_allowed_by_assignments(agent_id: &str, assignments: &[Value]) -> bool {
    if agent_id.trim().is_empty() {
        return false;
    }

    let policies: Vec<&Value> = assignments
        .iter()
        .filter(|assignment| {
            assignment
                .get("artifact")
                .and_then(|artifact| artifact.get("kind"))
                .and_then(Value::as_str)
                == Some("agent")
        })
        .collect();
    if policies.is_empty() {
        return true;
    }

    policies.iter().any(|assignment| {
        assignment
            .get("artifact")
            .and_then(|artifact| artifact.get("artifactId"))
            .and_then(Value::as_str)
            == Some(agent_id)
            && assignment.get("disposition").and_then(Value::as_str) != Some("blocked")
    })
}

fn managed_agent_assignments() -> Option<Vec<Value>> {
    if let Ok(assignments) = active_assignments_cache().read() {
        if let Some(value) = assignments.as_ref() {
            return value.as_array().cloned();
        }
    }

    if let Ok(snapshot) = load_json::<SignedSnapshot>(&snapshot_path()) {
        if let Some(assignments) = snapshot
            .payload
            .get("assignments")
            .and_then(Value::as_array)
        {
            return Some(assignments.clone());
        }
    }

    load_json::<Value>(&enforcement_path())
        .ok()
        .and_then(|enforcement| enforcement.get("agentAssignments").cloned())
        .and_then(|assignments| assignments.as_array().cloned())
}

/// Whether an agent may be discovered or entered on this node.
///
/// Fleet agent assignments are an availability policy, not a replacement for
/// the agent's exact resource ACL. With no `agent` assignments, legacy/local
/// behavior remains unchanged. Once an administrator assigns one or more agent
/// artifacts, only assigned non-blocked ids are available; a blocked assignment
/// always wins because the control plane sends one effective assignment per
/// artifact. The same decision is used after a restart from the signed
/// last-known-good state and from the durable fail-closed enforcement record.
pub fn is_agent_available(agent_id: &str) -> bool {
    managed_agent_assignments()
        .as_deref()
        .map_or(true, |assignments| {
            agent_allowed_by_assignments(agent_id, assignments)
        })
}

static ACTIVE_ASSIGNMENTS: OnceLock<RwLock<Option<Value>>> = OnceLock::new();

fn active_assignments_cache() -> &'static RwLock<Option<Value>> {
    ACTIVE_ASSIGNMENTS.get_or_init(|| RwLock::new(None))
}

fn use_verified_assignments(snapshot: &SignedSnapshot) {
    if let Ok(mut assignments) = active_assignments_cache().write() {
        *assignments = snapshot.payload.get("assignments").cloned();
    }
}

fn persist_fail_closed_enforcement(snapshot: &SignedSnapshot) -> anyhow::Result<()> {
    let all_assignments: Vec<Value> = snapshot
        .payload
        .get("assignments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .cloned()
        .collect();
    let assignments: Vec<Value> = all_assignments
        .iter()
        .filter(|assignment| {
            assignment.get("disposition").and_then(Value::as_str) == Some("blocked")
        })
        .cloned()
        .collect();
    let agent_assignments: Vec<Value> = all_assignments
        .iter()
        .filter(|assignment| {
            assignment
                .get("artifact")
                .and_then(|artifact| artifact.get("kind"))
                .and_then(Value::as_str)
                == Some("agent")
        })
        .cloned()
        .collect();
    let rules: Vec<Value> = snapshot
        .payload
        .get("rules")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|rule| {
            rule.get("kind").and_then(Value::as_str) == Some("command")
                && rule
                    .get("definition")
                    .and_then(|definition| definition.get("decision"))
                    .and_then(Value::as_str)
                    == Some("deny")
        })
        .cloned()
        .collect();
    atomic_json(
        &enforcement_path(),
        &json!({
            "agentAssignments": agent_assignments,
            "assignments": assignments,
            "revision": snapshot.payload.get("revision"),
            "rules": rules,
        }),
        false,
    )
}

pub fn is_artifact_blocked(id: &str) -> bool {
    artifact_disposition(id).as_deref() == Some("blocked")
}

pub fn managed_mcp_configs() -> BTreeMap<String, crate::sidecar::mcp::McpServerConfig> {
    managed_mcp_cache()
        .read()
        .map(|configs| configs.clone())
        .unwrap_or_default()
}

static MANAGED_MCP_CONFIGS: OnceLock<
    RwLock<BTreeMap<String, crate::sidecar::mcp::McpServerConfig>>,
> = OnceLock::new();

fn managed_mcp_cache() -> &'static RwLock<BTreeMap<String, crate::sidecar::mcp::McpServerConfig>> {
    MANAGED_MCP_CONFIGS.get_or_init(|| RwLock::new(BTreeMap::new()))
}

async fn materialize_mcp_config(
    artifact_id: &str,
    descriptor: &Value,
    assignment: &Value,
) -> Result<crate::sidecar::mcp::McpServerConfig, String> {
    let mut config = descriptor.get("config").unwrap_or(descriptor).clone();
    let store = crate::plugin_secrets::global()
        .ok_or_else(|| "node secret store is unavailable".to_owned())?;
    for field in ["headers", "env"] {
        let Some(values) = config.get_mut(field).and_then(Value::as_object_mut) else {
            continue;
        };
        for value in values.values_mut() {
            let Some(reference) = value.get("secretRef") else {
                continue;
            };
            let Some(secret_id) = reference.get("id").and_then(Value::as_str) else {
                continue;
            };
            let owner = if reference.get("kind").and_then(Value::as_str) == Some("node_local") {
                artifact_id
            } else {
                "fleet"
            };
            let secret = store
                .get(owner, secret_id)
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("missing secret '{secret_id}'"))?;
            *value = Value::String(secret);
        }
    }
    let mut config = serde_json::from_value::<crate::sidecar::mcp::McpServerConfig>(config)
        .map_err(|error| error.to_string())?;
    config.enabled = assignment.get("activation").and_then(Value::as_str) == Some("enabled");
    Ok(config)
}

async fn bind_plugin_secrets(plugin_id: &str, assignment: &Value) -> Result<(), String> {
    let store = crate::plugin_secrets::global()
        .ok_or_else(|| "node secret store is unavailable".to_owned())?;
    let Some(config) = assignment.get("config").and_then(Value::as_object) else {
        return Ok(());
    };
    for (key, value) in config {
        let Some(reference) = value.get("secretRef") else {
            continue;
        };
        let Some(secret_id) = reference.get("id").and_then(Value::as_str) else {
            continue;
        };
        let owner = if reference.get("kind").and_then(Value::as_str) == Some("node_local") {
            plugin_id
        } else {
            "fleet"
        };
        let secret = store
            .get(owner, secret_id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("missing secret '{secret_id}'"))?;
        store
            .set(plugin_id, key, &secret)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn retained_plugin_ids(snapshot: &SignedSnapshot) -> HashSet<String> {
    snapshot
        .payload
        .get("assignments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|assignment| {
            matches!(
                assignment.get("disposition").and_then(Value::as_str),
                Some("required" | "blocked")
            )
        })
        .filter(|assignment| {
            matches!(
                assignment
                    .get("artifact")
                    .and_then(|artifact| artifact.get("kind"))
                    .and_then(Value::as_str),
                Some("app" | "plugin")
            )
        })
        .filter_map(|assignment| {
            assignment
                .get("artifact")
                .and_then(|artifact| artifact.get("artifactId"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

fn assigned_skill_ids(snapshot: &SignedSnapshot) -> HashSet<String> {
    snapshot
        .payload
        .get("assignments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|assignment| {
            matches!(
                assignment.get("disposition").and_then(Value::as_str),
                Some("required" | "blocked")
            )
        })
        .filter(|assignment| {
            assignment
                .get("artifact")
                .and_then(|artifact| artifact.get("kind"))
                .and_then(Value::as_str)
                == Some("skill")
        })
        .filter_map(|assignment| {
            assignment
                .get("artifact")
                .and_then(|artifact| artifact.get("artifactId"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

fn fleet_skill_dir(artifact_id: &str) -> Result<PathBuf, String> {
    let path = Path::new(artifact_id);
    if artifact_id.is_empty()
        || matches!(artifact_id, "." | "..")
        || !artifact_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
        || path.components().count() != 1
        || !matches!(
            path.components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err(format!("unsafe managed skill id '{artifact_id}'"));
    }
    Ok(ryu_skills::SkillRegistry::skills_dir().join(artifact_id))
}

fn remove_stale_fleet_skills(
    previous: Option<&SignedSnapshot>,
    current: &SignedSnapshot,
) -> Vec<Value> {
    let Some(previous) = previous else {
        return Vec::new();
    };
    let retained = assigned_skill_ids(current);
    let mut removed = Vec::new();
    for artifact_id in assigned_skill_ids(previous).difference(&retained) {
        let result = fleet_skill_dir(artifact_id).and_then(|dir| {
            if !dir.join(FLEET_SKILL_MARKER).is_file() {
                return Ok(false);
            }
            std::fs::remove_dir_all(&dir)
                .map_err(|error| format!("removing managed skill {}: {error}", dir.display()))?;
            ryu_skills::set_active(artifact_id, false);
            Ok(true)
        });
        removed.push(match result {
            Ok(was_removed) => json!({
                "artifactId": artifact_id,
                "status": if was_removed { "removed" } else { "preserved_user_install" },
            }),
            Err(error) => json!({
                "artifactId": artifact_id,
                "error": error,
                "status": "error",
            }),
        });
    }
    removed
}

fn reconcile_skill_blocks(state: &ServerState, snapshot: &SignedSnapshot) -> Result<(), String> {
    let currently_blocked: HashSet<String> = snapshot
        .payload
        .get("assignments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|assignment| {
            assignment.get("disposition").and_then(Value::as_str) == Some("blocked")
        })
        .filter(|assignment| {
            assignment
                .get("artifact")
                .and_then(|artifact| artifact.get("kind"))
                .and_then(Value::as_str)
                == Some("skill")
        })
        .filter_map(|assignment| {
            assignment
                .get("artifact")
                .and_then(|artifact| artifact.get("artifactId"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    let mut prior: BTreeMap<String, bool> = load_json(&skill_blocks_path()).unwrap_or_default();
    let no_longer_blocked: Vec<String> = prior
        .keys()
        .filter(|id| !currently_blocked.contains(*id))
        .cloned()
        .collect();
    for artifact_id in no_longer_blocked {
        if prior.remove(&artifact_id).unwrap_or(false) {
            ryu_skills::set_active(&artifact_id, true);
        }
    }
    let enabled: HashSet<String> = state
        .skills
        .enabled()
        .into_iter()
        .map(|skill| skill.id)
        .collect();
    for artifact_id in currently_blocked {
        prior
            .entry(artifact_id.clone())
            .or_insert_with(|| enabled.contains(&artifact_id));
        ryu_skills::set_active(&artifact_id, false);
    }
    atomic_json(&skill_blocks_path(), &prior, false).map_err(|error| error.to_string())
}

async fn install_fleet_skill(
    artifact_id: &str,
    assignment_id: &str,
    digest: Option<&str>,
    markdown: &str,
    enabled: bool,
) -> Result<(), String> {
    let destination = fleet_skill_dir(artifact_id)?;
    let marker = destination.join(FLEET_SKILL_MARKER);
    if destination.exists() && !marker.is_file() {
        return Err(format!(
            "managed skill '{artifact_id}' conflicts with a user-owned install"
        ));
    }
    let installed =
        crate::skills_catalog::from_source::install_skill_md_text(artifact_id, markdown)
            .await
            .map_err(|error| error.to_string())?;
    let installed_dir = Path::new(&installed.path)
        .parent()
        .ok_or_else(|| "managed skill installer returned an invalid path".to_owned())?;
    atomic_json(
        &installed_dir.join(FLEET_SKILL_MARKER),
        &json!({
            "artifactId": artifact_id,
            "assignmentId": assignment_id,
            "digest": digest,
        }),
        false,
    )
    .map_err(|error| error.to_string())?;
    ryu_skills::set_active(artifact_id, enabled);
    Ok(())
}

async fn remove_stale_fleet_plugins(
    state: &ServerState,
    previous: Option<&SignedSnapshot>,
    current: &SignedSnapshot,
) -> Vec<Value> {
    let Some(previous) = previous else {
        return Vec::new();
    };
    let retained = retained_plugin_ids(current);
    let mut removed = Vec::new();
    for artifact_id in retained_plugin_ids(previous).difference(&retained) {
        match crate::server::remove_fleet_owned_plugin(state, artifact_id).await {
            Ok(was_removed) => removed.push(json!({
                "artifactId": artifact_id,
                "status": if was_removed { "removed" } else { "preserved_user_install" },
            })),
            Err(error) => removed.push(json!({
                "artifactId": artifact_id,
                "error": error,
                "status": "error",
            })),
        }
    }
    removed
}

async fn apply_artifacts(
    state: &ServerState,
    snapshot: &SignedSnapshot,
    delivered_secrets: &HashSet<String>,
    previous: Option<&SignedSnapshot>,
) -> Vec<Value> {
    let mut observed = Vec::new();
    if let Ok(mut configs) = managed_mcp_cache().write() {
        configs.clear();
    }
    let Some(assignments) = snapshot
        .payload
        .get("assignments")
        .and_then(Value::as_array)
    else {
        return observed;
    };
    // Denials are applied before removals, downloads, installs, or activation.
    if let Err(error) = reconcile_skill_blocks(state, snapshot) {
        observed.push(json!({ "error": error, "status": "error", "type": "skill_blocks" }));
    }
    for assignment in assignments {
        if assignment.get("disposition").and_then(Value::as_str) != Some("blocked") {
            continue;
        }
        let assignment_id = assignment.get("id").and_then(Value::as_str).unwrap_or("");
        let artifact_id = assignment
            .get("artifact")
            .and_then(|artifact| artifact.get("artifactId"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let kind = assignment
            .get("artifact")
            .and_then(|artifact| artifact.get("kind"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let error = if matches!(kind, "app" | "plugin") {
            crate::server::apply_fleet_plugin_block(state, artifact_id)
                .await
                .err()
        } else {
            None
        };
        observed.push(json!({
            "artifactId": artifact_id,
            "assignmentId": assignment_id,
            "error": error,
            "status": if error.is_some() { "error" } else { "blocked" },
        }));
    }
    observed.extend(remove_stale_fleet_plugins(state, previous, snapshot).await);
    observed.extend(remove_stale_fleet_skills(previous, snapshot));
    for assignment in assignments {
        let assignment_id = assignment.get("id").and_then(Value::as_str).unwrap_or("");
        let disposition = assignment
            .get("disposition")
            .and_then(Value::as_str)
            .unwrap_or("optional");
        let artifact = assignment.get("artifact");
        let artifact_id = artifact
            .and_then(|value| value.get("artifactId"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if disposition == "blocked" {
            continue;
        }
        if disposition == "optional" {
            observed.push(json!({
                "artifactId": artifact_id,
                "assignmentId": assignment_id,
                "status": "optional",
            }));
            continue;
        }
        let mut required_secrets = HashSet::new();
        if let Some(config) = assignment.get("config") {
            collect_secret_refs(config, &mut required_secrets);
        }
        if !required_secrets.is_subset(delivered_secrets) {
            observed.push(json!({
                "artifactId": artifact_id,
                "assignmentId": assignment_id,
                "missingSecretIds": required_secrets.difference(delivered_secrets).collect::<Vec<_>>(),
                "status": "needs_secret",
            }));
            continue;
        }
        let kind = artifact
            .and_then(|value| value.get("kind"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let descriptor = artifact.and_then(|value| value.get("descriptor"));
        let result = match (kind, descriptor) {
            ("app" | "plugin", Some(descriptor)) => {
                if let Err(error) = bind_plugin_secrets(artifact_id, assignment).await {
                    observed.push(json!({
                        "artifactId": artifact_id,
                        "assignmentId": assignment_id,
                        "error": error,
                        "status": "needs_secret",
                    }));
                    continue;
                }
                let manifest_value = descriptor
                    .get("manifest")
                    .or_else(|| descriptor.get("raw").and_then(|raw| raw.get("manifest")))
                    .unwrap_or(descriptor);
                match serde_json::from_value::<crate::plugin_manifest::PluginManifest>(
                    manifest_value.clone(),
                ) {
                    Ok(manifest) => {
                        let ui_code = descriptor
                            .get("uiCode")
                            .or_else(|| descriptor.get("ui_code"))
                            .or_else(|| {
                                descriptor.get("raw").and_then(|raw| {
                                    raw.get("ui_code").or_else(|| raw.get("uiCode"))
                                })
                            })
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        let enable =
                            assignment.get("activation").and_then(Value::as_str) == Some("enabled");
                        crate::server::install_fleet_plugin(state, manifest, ui_code, enable).await
                    }
                    Err(error) => Err(format!("invalid plugin descriptor: {error}")),
                }
            }
            ("skill", Some(descriptor)) => {
                let markdown = descriptor
                    .get("markdown")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "skill descriptor has no markdown".to_owned());
                match markdown {
                    Ok(markdown) => {
                        install_fleet_skill(
                            artifact_id,
                            assignment_id,
                            artifact
                                .and_then(|value| value.get("digest"))
                                .and_then(Value::as_str),
                            markdown,
                            assignment.get("activation").and_then(Value::as_str) == Some("enabled"),
                        )
                        .await
                    }
                    Err(error) => Err(error),
                }
            }
            ("mcp", Some(descriptor)) => {
                match materialize_mcp_config(artifact_id, descriptor, assignment).await {
                    Ok(config) => {
                        if let Ok(mut configs) = managed_mcp_cache().write() {
                            configs.insert(artifact_id.to_owned(), config);
                        }
                        Ok(())
                    }
                    Err(error) => Err(error),
                }
            }
            // Agent definitions remain Core-owned and versioned records. A Fleet
            // agent artifact is deliberately a policy reference to an existing
            // stable agent id; it controls discovery/entry without overwriting
            // the definition or its immutable history. Required references report
            // a setup error when the node does not have that agent yet.
            ("agent", _) => match state.agent_store.get(artifact_id).await {
                Ok(Some(_)) => Ok(()),
                Ok(None) => Err(format!(
                    "managed agent '{artifact_id}' is not installed on this node"
                )),
                Err(error) => Err(error.to_string()),
            },
            _ => Err(format!("unsupported managed artifact kind '{kind}'")),
        };
        observed.push(json!({
            "activation": assignment.get("activation"),
            "artifactId": artifact_id,
            "assignmentId": assignment_id,
            "digest": artifact.and_then(|value| value.get("digest")),
            "error": result.as_ref().err(),
            "status": if result.is_ok() { "converged" } else { "error" },
        }));
    }
    state.mcp.reload();
    observed
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMapping {
    pub organization_id: String,
    pub project_id: String,
    pub root: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PutMappingBody {
    organization_id: String,
    project_id: String,
    root: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteMappingQuery {
    organization_id: String,
    project_id: String,
    root: PathBuf,
}

fn mappings_path() -> PathBuf {
    crate::paths::state_path("org-project-mappings.json")
}

fn load_from(path: &Path) -> anyhow::Result<Vec<ProjectMapping>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

fn save_to(path: &Path, mappings: &[ProjectMapping]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(mappings)?)?;
    std::fs::rename(temporary, path)?;
    Ok(())
}

fn roots_overlap(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

fn validate_insert(mappings: &[ProjectMapping], incoming: &ProjectMapping) -> Result<(), String> {
    for existing in mappings {
        if existing.root == incoming.root
            && existing.organization_id == incoming.organization_id
            && existing.project_id == incoming.project_id
        {
            continue;
        }
        if roots_overlap(&existing.root, &incoming.root)
            && (existing.organization_id != incoming.organization_id
                || existing.project_id != incoming.project_id)
        {
            return Err(format!(
                "workspace root overlaps mapping for project '{}'",
                existing.project_id
            ));
        }
    }
    Ok(())
}

pub fn project_for_cwd<'a>(
    mappings: &'a [ProjectMapping],
    organization_id: &str,
    cwd: &Path,
) -> Option<&'a str> {
    mappings
        .iter()
        .filter(|mapping| {
            mapping.organization_id == organization_id && cwd.starts_with(&mapping.root)
        })
        .max_by_key(|mapping| mapping.root.components().count())
        .map(|mapping| mapping.project_id.as_str())
}

async fn list_mappings() -> (StatusCode, Json<Value>) {
    match load_from(&mappings_path()) {
        Ok(mappings) => (StatusCode::OK, Json(json!({ "mappings": mappings }))),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string() })),
        ),
    }
}

async fn put_mapping(Json(body): Json<PutMappingBody>) -> (StatusCode, Json<Value>) {
    if body.organization_id.trim().is_empty() || body.project_id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "organizationId and projectId are required" })),
        );
    }
    let root = match std::fs::canonicalize(&body.root) {
        Ok(root) if root.is_dir() => root,
        Ok(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "root must be an existing directory" })),
            );
        }
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("could not resolve root: {error}") })),
            );
        }
    };
    let path = mappings_path();
    let mut mappings = match load_from(&path) {
        Ok(mappings) => mappings,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": error.to_string() })),
            );
        }
    };
    let incoming = ProjectMapping {
        organization_id: body.organization_id,
        project_id: body.project_id,
        root,
    };
    if let Err(error) = validate_insert(&mappings, &incoming) {
        return (StatusCode::CONFLICT, Json(json!({ "error": error })));
    }
    mappings.retain(|mapping| mapping != &incoming);
    mappings.push(incoming.clone());
    mappings.sort_by(|left, right| left.root.cmp(&right.root));
    match save_to(&path, &mappings) {
        Ok(()) => (StatusCode::OK, Json(json!({ "mapping": incoming }))),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string() })),
        ),
    }
}

async fn delete_mapping(Query(query): Query<DeleteMappingQuery>) -> (StatusCode, Json<Value>) {
    let root = match std::fs::canonicalize(&query.root) {
        Ok(root) => root,
        Err(_) => query.root,
    };
    let path = mappings_path();
    let mut mappings = match load_from(&path) {
        Ok(mappings) => mappings,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": error.to_string() })),
            );
        }
    };
    let before = mappings.len();
    mappings.retain(|mapping| {
        !(mapping.organization_id == query.organization_id
            && mapping.project_id == query.project_id
            && mapping.root == root)
    });
    if mappings.len() == before {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "mapping not found" })),
        );
    }
    match save_to(&path, &mappings) {
        Ok(()) => (StatusCode::OK, Json(json!({ "success": true }))),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": error.to_string() })),
        ),
    }
}

async fn enroll_node(
    State(state): State<ServerState>,
    Json(body): Json<EnrollBody>,
) -> (StatusCode, Json<Value>) {
    let _enrollment_guard = enrollment_operation_lock().lock().await;
    let base_url = match normalized_service_url(&body.control_plane_url) {
        Ok(url) => url,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": error.to_string() })),
            );
        }
    };
    if !valid_enrollment_token(&body.token) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid enrollment token" })),
        );
    }

    let requested_token_hash = enrollment_token_hash(&body.token);
    let existing_bundle = match read_enrolled_bundle_from(&enrolled_bundle_path()) {
        Ok(bundle) => bundle,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("could not read enrolled node bundle: {error}") })),
            );
        }
    };
    if let Some(bundle) = existing_bundle {
        if bundle.fleet_identity.control_plane_url != base_url
            || bundle.token_hash != requested_token_hash
        {
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": "this node is already bound; revoke the current enrollment before binding another organization"
                })),
            );
        }
        if !bundle.acknowledged {
            if let Err(error) =
                acknowledge_enrollment(&state.client, &enrolled_bundle_path(), bundle.clone()).await
            {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({
                        "error": format!("enrollment was saved but acknowledgement failed: {error}")
                    })),
                );
            }
        }
        let active_bundle = match read_enrolled_bundle_from(&enrolled_bundle_path()) {
            Ok(Some(bundle)) => bundle,
            Ok(None) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(
                        json!({ "error": "enrolled node bundle disappeared after acknowledgement" }),
                    ),
                );
            }
            Err(error) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(
                        json!({ "error": format!("could not reload enrolled node bundle: {error}") }),
                    ),
                );
            }
        };
        if let Err(error) = refresh_enrolled_registration(&state.client, &active_bundle).await {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "error": format!("enrollment is active but organization registration failed: {error}")
                })),
            );
        }
        crate::ryu_analytics::sync_gateway_relay_config();
        return enrollment_success(&bundle.fleet_identity);
    }

    let pending_path = pending_enrollment_path();
    let pending = match pending_attempt_for_request(&pending_path, &base_url, &body.token) {
        Ok(pending) => pending,
        Err(error) => {
            let status = if error
                .downcast_ref::<PendingControlPlaneConflict>()
                .is_some()
            {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            return (
                status,
                Json(json!({ "error": format!("could not persist enrollment attempt: {error}") })),
            );
        }
    };
    let enrolled = match prepare_enrollment(&state.client, &pending).await {
        Ok(enrolled) => enrolled,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("enrollment request failed: {error}") })),
            );
        }
    };

    if let Ok(existing) = load_json::<FleetIdentity>(&identity_path()) {
        if existing.organization_id != enrolled.organization_id {
            let _ = std::fs::remove_file(&pending_path);
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": "this node is already bound to another organization; revoke it before rebinding"
                })),
            );
        }
    }

    let bundle = match prepared_identity_and_bundle(&pending, enrolled) {
        Ok(bundle) => bundle,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("invalid enrollment response: {error}") })),
            );
        }
    };
    let identity = bundle.fleet_identity.clone();

    if let Err(error) = atomic_json(&enrolled_bundle_path(), &bundle, true) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("could not persist enrolled node bundle: {error}") })),
        );
    }
    let _ = std::fs::remove_file(&pending_path);
    if let Err(error) = acknowledge_enrollment(&state.client, &enrolled_bundle_path(), bundle).await
    {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": format!("enrollment was saved but acknowledgement failed: {error}")
            })),
        );
    }
    let active_bundle = match read_enrolled_bundle_from(&enrolled_bundle_path()) {
        Ok(Some(bundle)) => bundle,
        Ok(None) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "enrolled node bundle disappeared after acknowledgement" })),
            );
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("could not reload enrolled node bundle: {error}") })),
            );
        }
    };
    if let Err(error) = refresh_enrolled_registration(&state.client, &active_bundle).await {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": format!("enrollment is active but organization registration failed: {error}")
            })),
        );
    }

    crate::ryu_analytics::sync_gateway_relay_config();
    enrollment_success(&identity)
}

fn enrollment_success(identity: &FleetIdentity) -> (StatusCode, Json<Value>) {
    (
        StatusCode::CREATED,
        Json(json!({
            "nodeId": identity.node_id,
            "organizationId": identity.organization_id,
        })),
    )
}

fn normalized_service_url(raw: &str) -> anyhow::Result<String> {
    if raw.len() > MAX_CONTROL_PLANE_URL_BYTES {
        anyhow::bail!("controlPlaneUrl must not exceed {MAX_CONTROL_PLANE_URL_BYTES} bytes");
    }
    let normalized = raw.trim().trim_end_matches('/');
    let parsed = url::Url::parse(normalized)
        .map_err(|_| anyhow::anyhow!("controlPlaneUrl must be an absolute URL"))?;
    let secure = parsed.scheme() == "https";
    let local_http = parsed.scheme() == "http" && parsed.host_str() == Some("127.0.0.1");
    if !secure || parsed.host_str().is_none() {
        if !local_http {
            anyhow::bail!("controlPlaneUrl must use HTTPS (localhost HTTP is allowed)");
        }
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        anyhow::bail!("controlPlaneUrl must not contain credentials, a query, or a fragment");
    }
    if normalized.is_empty() {
        anyhow::bail!("controlPlaneUrl must use HTTPS (localhost HTTP is allowed)")
    }
    Ok(normalized.to_owned())
}

fn valid_enrollment_token(token: &str) -> bool {
    token.len() == 68
        && token.starts_with("rfe_")
        && token[4..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn enrollment_token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn new_pending_attempt(control_plane_url: &str, token: &str) -> PendingEnrollmentAttempt {
    let signing_key = SigningKey::generate(&mut OsRng);
    let signing_public_key =
        base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().as_bytes());
    let encryption_secret = StaticSecret::random_from_rng(OsRng);
    let encryption_public_key = base64::engine::general_purpose::STANDARD
        .encode(EncryptionPublicKey::from(&encryption_secret).as_bytes());
    PendingEnrollmentAttempt {
        claim_id: Uuid::new_v4().to_string(),
        control_plane_url: control_plane_url.to_owned(),
        token: token.to_owned(),
        token_hash: enrollment_token_hash(token),
        signing_private_key: base64::engine::general_purpose::STANDARD
            .encode(signing_key.to_bytes()),
        signing_public_key,
        encryption_private_key: base64::engine::general_purpose::STANDARD
            .encode(encryption_secret.to_bytes()),
        encryption_public_key,
    }
}

fn pending_attempt_for_request(
    path: &Path,
    control_plane_url: &str,
    token: &str,
) -> anyhow::Result<PendingEnrollmentAttempt> {
    if path.exists() {
        let existing: PendingEnrollmentAttempt = load_json(path)?;
        validate_pending_attempt(&existing)?;
        if existing.control_plane_url == control_plane_url {
            return Ok(existing);
        }
        return Err(anyhow::Error::new(PendingControlPlaneConflict));
    }
    let pending = new_pending_attempt(control_plane_url, token);
    atomic_json(path, &pending, true)?;
    Ok(pending)
}

#[derive(Debug)]
struct PendingControlPlaneConflict;

impl std::fmt::Display for PendingControlPlaneConflict {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a pending enrollment already targets a different control-plane URL")
    }
}

impl std::error::Error for PendingControlPlaneConflict {}

fn decode_32_bytes(value: &str, field: &str) -> anyhow::Result<[u8; 32]> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|error| anyhow::anyhow!("{field} is not valid base64: {error}"))?;
    decoded
        .try_into()
        .map_err(|_| anyhow::anyhow!("{field} must contain 32 bytes"))
}

fn validate_pending_attempt(pending: &PendingEnrollmentAttempt) -> anyhow::Result<()> {
    let _ = Uuid::parse_str(&pending.claim_id)?;
    if normalized_service_url(&pending.control_plane_url)? != pending.control_plane_url {
        anyhow::bail!("pending control-plane URL is not canonical");
    }
    if !valid_enrollment_token(&pending.token)
        || enrollment_token_hash(&pending.token) != pending.token_hash
    {
        anyhow::bail!("pending enrollment token does not match its digest");
    }
    let signing_private = decode_32_bytes(&pending.signing_private_key, "signingPrivateKey")?;
    let signing_key = SigningKey::from_bytes(&signing_private);
    let derived_signing_public =
        base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().as_bytes());
    if derived_signing_public != pending.signing_public_key {
        anyhow::bail!("pending signing public key does not match its private key");
    }
    let encryption_private =
        decode_32_bytes(&pending.encryption_private_key, "encryptionPrivateKey")?;
    let encryption_secret = StaticSecret::from(encryption_private);
    let derived_encryption_public = base64::engine::general_purpose::STANDARD
        .encode(EncryptionPublicKey::from(&encryption_secret).as_bytes());
    if derived_encryption_public != pending.encryption_public_key {
        anyhow::bail!("pending encryption public key does not match its private key");
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentClaim<'a> {
    claim_id: &'a str,
    encryption_public_key: &'a str,
    public_key: &'a str,
    token_hash: &'a str,
}

fn enrollment_claim_bytes(pending: &PendingEnrollmentAttempt) -> anyhow::Result<Vec<u8>> {
    let payload = serde_json::to_vec(&EnrollmentClaim {
        claim_id: &pending.claim_id,
        encryption_public_key: &pending.encryption_public_key,
        public_key: &pending.signing_public_key,
        token_hash: &pending.token_hash,
    })?;
    let mut message = Vec::with_capacity(ENROLLMENT_CLAIM_DOMAIN.len() + payload.len());
    message.extend_from_slice(ENROLLMENT_CLAIM_DOMAIN.as_bytes());
    message.extend_from_slice(&payload);
    Ok(message)
}

fn enrollment_claim_proof(pending: &PendingEnrollmentAttempt) -> anyhow::Result<String> {
    validate_pending_attempt(pending)?;
    let private_key = decode_32_bytes(&pending.signing_private_key, "signingPrivateKey")?;
    let signature = SigningKey::from_bytes(&private_key).sign(&enrollment_claim_bytes(pending)?);
    Ok(base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()))
}

async fn prepare_enrollment(
    client: &reqwest::Client,
    pending: &PendingEnrollmentAttempt,
) -> anyhow::Result<EnrollResponse> {
    let claim_proof = enrollment_claim_proof(pending)?;
    let response = client
        .post(format!(
            "{}/api/control-plane/nodes/enroll",
            pending.control_plane_url
        ))
        .json(&json!({
            "architecture": std::env::consts::ARCH,
            "capabilities": ["fleet-v1", "project-mapping-v1"],
            "claimId": pending.claim_id,
            "claimProof": claim_proof,
            "coreVersion": env!("CARGO_PKG_VERSION"),
            "encryptionPublicKey": pending.encryption_public_key,
            "platform": std::env::consts::OS,
            "protocolVersion": 2,
            "publicKey": pending.signing_public_key,
            "token": pending.token,
        }))
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    if !response.status().is_success() {
        anyhow::bail!("control plane rejected enrollment: {}", response.status());
    }
    Ok(response.json().await?)
}

fn prepared_identity_and_bundle(
    pending: &PendingEnrollmentAttempt,
    enrolled: EnrollResponse,
) -> anyhow::Result<EnrolledNodeBundle> {
    if !enrolled.credential.starts_with("rfn_")
        || enrolled.node_id.trim().is_empty()
        || enrolled.organization_id.trim().is_empty()
    {
        anyhow::bail!("Fleet identity response is incomplete or has an invalid credential");
    }
    let snapshot_public_key = decode_32_bytes(&enrolled.signing_public_key, "signingPublicKey")?;
    let _ = VerifyingKey::from_bytes(&snapshot_public_key)?;
    let identity = FleetIdentity {
        control_plane_url: pending.control_plane_url.clone(),
        credential: enrolled.credential,
        node_id: enrolled.node_id,
        organization_id: enrolled.organization_id,
        signing_private_key: pending.signing_private_key.clone(),
        signing_public_key: pending.signing_public_key.clone(),
        encryption_private_key: pending.encryption_private_key.clone(),
        encryption_public_key: pending.encryption_public_key.clone(),
        snapshot_public_key: enrolled.signing_public_key,
        credential_updated_at: Some(Utc::now()),
        pending_credential: None,
    };
    let binding = enrolled
        .organization_binding
        .ok_or_else(|| anyhow::anyhow!("v2 enrollment response is missing organizationBinding"))?;
    validate_organization_binding(&binding)?;
    let bundle = EnrolledNodeBundle {
        claim_id: pending.claim_id.clone(),
        token_hash: pending.token_hash.clone(),
        fleet_identity: identity.clone(),
        organization_binding: binding,
        acknowledged: false,
    };
    validate_enrolled_bundle(&bundle)?;
    Ok(bundle)
}

fn validate_organization_binding(binding: &EnrollmentOrganizationBinding) -> anyhow::Result<()> {
    if binding.status != "ready" || !binding.acknowledgement_required {
        anyhow::bail!("organization binding is not ready for acknowledgement");
    }
    if !binding.control_credential.starts_with("rgw_")
        || !binding.relay_credential.starts_with("rgw_")
        || binding.credential_set_id.trim().is_empty()
    {
        anyhow::bail!("organization binding credentials are incomplete");
    }
    if binding.control_credential == binding.relay_credential {
        anyhow::bail!("control and relay credentials must be purpose-separated");
    }
    let normalized_url = normalized_service_url(&binding.managed_fleet_url).map_err(|_| {
        anyhow::anyhow!("managedFleetUrl must use HTTPS (localhost HTTP is allowed)")
    })?;
    if normalized_url != binding.managed_fleet_url {
        anyhow::bail!("managedFleetUrl is not canonical");
    }
    Ok(())
}

fn validate_enrolled_bundle(bundle: &EnrolledNodeBundle) -> anyhow::Result<()> {
    let _ = Uuid::parse_str(&bundle.claim_id)?;
    if bundle.token_hash.len() != 64
        || !bundle
            .token_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        anyhow::bail!("enrolled token digest is invalid");
    }
    if bundle.fleet_identity.organization_id.trim().is_empty()
        || bundle.fleet_identity.node_id.trim().is_empty()
        || !bundle.fleet_identity.credential.starts_with("rfn_")
    {
        anyhow::bail!("enrolled Fleet identity is incomplete");
    }
    validate_organization_binding(&bundle.organization_binding)
}

async fn acknowledge_enrollment(
    client: &reqwest::Client,
    path: &Path,
    mut bundle: EnrolledNodeBundle,
) -> anyhow::Result<()> {
    if bundle.acknowledged {
        return Ok(());
    }
    let response = client
        .post(format!(
            "{}/api/control-plane/nodes/enroll/acknowledge",
            bundle.fleet_identity.control_plane_url
        ))
        .bearer_auth(&bundle.fleet_identity.credential)
        .json(&json!({ "claimId": bundle.claim_id }))
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    if !response.status().is_success() {
        anyhow::bail!(
            "control plane rejected acknowledgement: {}",
            response.status()
        );
    }
    let acknowledgement: EnrollmentAcknowledgement = response.json().await?;
    if !acknowledgement.acknowledged
        || acknowledgement.status != "active"
        || acknowledgement.node_id != bundle.fleet_identity.node_id
        || acknowledgement.organization_id != bundle.fleet_identity.organization_id
    {
        anyhow::bail!("acknowledgement did not match the persisted enrolled node");
    }
    bundle.acknowledged = true;
    atomic_json(path, &bundle, true)
}

fn registration_refresh_required(
    bundle: &EnrolledNodeBundle,
    registered: Option<&crate::sidecar::control_plane::RegisteredNode>,
) -> bool {
    !bundle.acknowledged
        || registered.is_none_or(|node| {
            node.org.id != bundle.fleet_identity.organization_id
                || node.node_id != bundle.fleet_identity.node_id
        })
}

async fn refresh_enrolled_registration(
    client: &reqwest::Client,
    bundle: &EnrolledNodeBundle,
) -> anyhow::Result<()> {
    if !bundle.acknowledged {
        anyhow::bail!("enrolled credentials cannot register before acknowledgement");
    }
    let registered = crate::sidecar::control_plane::registered_node();
    if !registration_refresh_required(bundle, registered.as_ref()) {
        return Ok(());
    }
    match crate::sidecar::control_plane::register_managed_node(client).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            crate::sidecar::control_plane::clear_registered_node();
            crate::entitlement::set_managed_inference_entitled("false");
            anyhow::bail!("acknowledged enrollment did not supply a control token");
        }
        Err(error) => {
            crate::sidecar::control_plane::clear_registered_node();
            crate::entitlement::set_managed_inference_entitled("false");
            return Err(error);
        }
    }
    let Some(registered) = crate::sidecar::control_plane::registered_node() else {
        crate::sidecar::control_plane::clear_registered_node();
        crate::entitlement::set_managed_inference_entitled("false");
        anyhow::bail!("control-plane registration returned no node binding");
    };
    if registration_refresh_required(bundle, Some(&registered)) {
        crate::sidecar::control_plane::clear_registered_node();
        crate::entitlement::set_managed_inference_entitled("false");
        anyhow::bail!(
            "control-plane registration resolved a different organization or node than the enrolled bundle"
        );
    }
    Ok(())
}

async fn recover_enrollment(client: &reqwest::Client) -> anyhow::Result<()> {
    let _enrollment_guard = enrollment_operation_lock().lock().await;
    let bundle_path = enrolled_bundle_path();
    if let Some(bundle) = read_enrolled_bundle_from(&bundle_path)? {
        if !bundle.acknowledged {
            acknowledge_enrollment(client, &bundle_path, bundle).await?;
        }
        let active_bundle = read_enrolled_bundle_from(&bundle_path)?
            .ok_or_else(|| anyhow::anyhow!("enrolled node bundle disappeared during recovery"))?;
        refresh_enrolled_registration(client, &active_bundle).await?;
        let _ = std::fs::remove_file(pending_enrollment_path());
        return Ok(());
    }

    let pending_path = pending_enrollment_path();
    if !pending_path.exists() {
        return Ok(());
    }
    let pending: PendingEnrollmentAttempt = load_json(&pending_path)?;
    validate_pending_attempt(&pending)?;
    let enrolled = prepare_enrollment(client, &pending).await?;
    if let Ok(existing) = load_json::<FleetIdentity>(&identity_path()) {
        if existing.organization_id != enrolled.organization_id {
            anyhow::bail!("pending enrollment would rebind this node to another organization");
        }
    }
    let bundle = prepared_identity_and_bundle(&pending, enrolled)?;
    atomic_json(&bundle_path, &bundle, true)?;
    let _ = std::fs::remove_file(&pending_path);
    acknowledge_enrollment(client, &bundle_path, bundle).await?;
    let active_bundle = read_enrolled_bundle_from(&bundle_path)?
        .ok_or_else(|| anyhow::anyhow!("enrolled node bundle disappeared during recovery"))?;
    refresh_enrolled_registration(client, &active_bundle).await?;
    Ok(())
}

async fn adopt_legacy_gateway(state: &ServerState) -> anyhow::Result<bool> {
    let Some(gateway_key) = crate::sidecar::control_plane::gateway_key() else {
        return Ok(false);
    };
    let base_url = std::env::var("RYU_CONTROL_PLANE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:3000".to_owned())
        .trim_end_matches('/')
        .to_owned();
    let signing_key = SigningKey::generate(&mut OsRng);
    let public_key =
        base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().as_bytes());
    let encryption_secret = StaticSecret::random_from_rng(OsRng);
    let encryption_public = EncryptionPublicKey::from(&encryption_secret);
    let encryption_public_key =
        base64::engine::general_purpose::STANDARD.encode(encryption_public.as_bytes());
    let legacy_instance_id = legacy_instance_id()?;
    let response = state
        .client
        .post(format!("{base_url}/api/control-plane/nodes/adopt-gateway"))
        .header("x-gateway-key", gateway_key)
        .json(&json!({
            "architecture": std::env::consts::ARCH,
            "capabilities": ["fleet-v1", "project-mapping-v1"],
            "coreVersion": env!("CARGO_PKG_VERSION"),
            "encryptionPublicKey": encryption_public_key,
            "legacyInstanceId": legacy_instance_id,
            "platform": std::env::consts::OS,
            "publicKey": public_key,
        }))
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    if !response.status().is_success() {
        anyhow::bail!("legacy node adoption returned {}", response.status());
    }
    let enrolled: EnrollResponse = response.json().await?;
    atomic_json(
        &identity_path(),
        &FleetIdentity {
            control_plane_url: base_url,
            credential: enrolled.credential,
            node_id: enrolled.node_id,
            organization_id: enrolled.organization_id,
            signing_private_key: base64::engine::general_purpose::STANDARD
                .encode(signing_key.to_bytes()),
            signing_public_key: public_key,
            encryption_private_key: base64::engine::general_purpose::STANDARD
                .encode(encryption_secret.to_bytes()),
            encryption_public_key,
            snapshot_public_key: enrolled.signing_public_key,
            credential_updated_at: Some(Utc::now()),
            pending_credential: None,
        },
        true,
    )?;
    Ok(true)
}

async fn report_observed(
    client: &reqwest::Client,
    identity: &FleetIdentity,
    revision: u64,
    status: &str,
    items: Vec<Value>,
) -> anyhow::Result<()> {
    let mappings = load_from(&mappings_path()).unwrap_or_default();
    let mapped_project_ids: Vec<&str> = mappings
        .iter()
        .filter(|mapping| mapping.organization_id == identity.organization_id)
        .map(|mapping| mapping.project_id.as_str())
        .collect();
    let response = client
        .post(format!(
            "{}/api/control-plane/nodes/me/observed",
            identity.control_plane_url
        ))
        .bearer_auth(&identity.credential)
        .json(&json!({
            "items": items,
            "mappedProjectIds": mapped_project_ids,
            "revision": revision,
            "status": status,
            "uptimeSeconds": sysinfo::System::uptime(),
        }))
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    if !response.status().is_success() {
        anyhow::bail!("observed-state report returned {}", response.status());
    }
    Ok(())
}

/// A node credential in the shape the control plane mints: `rfn_` and 32
/// random bytes as lowercase hex.
fn generate_node_credential() -> String {
    let mut bytes = [0_u8; 32];
    rand::RngCore::fill_bytes(&mut OsRng, &mut bytes);
    format!("rfn_{}", hex::encode(bytes))
}

async fn request_rotation(
    client: &reqwest::Client,
    control_plane_url: &str,
    bearer: &str,
    successor: &str,
) -> anyhow::Result<reqwest::Response> {
    Ok(client
        .post(format!(
            "{control_plane_url}/api/control-plane/nodes/me/rotate-credential"
        ))
        .bearer_auth(bearer)
        .json(&json!({ "credential": successor }))
        .timeout(Duration::from_secs(15))
        .send()
        .await?)
}

async fn rotate_credential_if_due(
    client: &reqwest::Client,
    identity: &mut FleetIdentity,
) -> anyhow::Result<()> {
    rotate_credential_with(client, identity, save_fleet_identity).await
}

/// Rotate the node credential once a day. Only the current bearer may rotate,
/// so the successor is generated and saved first: when the reply is lost after
/// the control plane commits, the next attempt confirms that same successor
/// (with the old bearer during its grace window, or with the successor itself
/// afterwards) instead of leaving the node with a bearer that no longer works.
async fn rotate_credential_with(
    client: &reqwest::Client,
    identity: &mut FleetIdentity,
    persist: impl Fn(&FleetIdentity) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let successor = match identity.pending_credential.clone() {
        Some(successor) => successor,
        None => {
            let age = identity
                .credential_updated_at
                .map(|updated| Utc::now().signed_duration_since(updated))
                .unwrap_or_else(|| chrono::Duration::days(2));
            if age < chrono::Duration::days(1) {
                return Ok(());
            }
            let successor = generate_node_credential();
            identity.pending_credential = Some(successor.clone());
            persist(identity)?;
            successor
        }
    };
    let mut response = request_rotation(
        client,
        &identity.control_plane_url,
        &identity.credential,
        &successor,
    )
    .await?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED && successor != identity.credential {
        response =
            request_rotation(client, &identity.control_plane_url, &successor, &successor).await?;
    }
    if !response.status().is_success() {
        anyhow::bail!("credential rotation returned {}", response.status());
    }
    let body: Value = response.json().await?;
    // A control plane that predates node-proposed successors ignores the
    // proposal and mints its own; whichever it returns is the live one.
    identity.credential = body
        .get("credential")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("credential rotation response is missing credential"))?
        .to_owned();
    identity.pending_credential = None;
    identity.credential_updated_at = Some(Utc::now());
    persist(identity)?;
    Ok(())
}

async fn reconcile_once(state: &ServerState) -> anyhow::Result<bool> {
    use anyhow::{anyhow, bail};

    let mut identity = load_fleet_identity()?;
    // A failed rotation is retried on the next pass. The credential this node
    // holds still decides whether the desired-state request below succeeds, and
    // a revoked one surfaces there as "node credential was revoked".
    if let Err(error) = rotate_credential_if_due(&state.client, &mut identity).await {
        tracing::warn!("fleet: credential rotation failed; retrying next pass: {error}");
    }
    let previous = load_json::<SignedSnapshot>(&snapshot_path()).ok();
    let previous_revision = previous
        .as_ref()
        .and_then(|snapshot| snapshot.payload.get("revision"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let refresh_before_expiry = previous
        .as_ref()
        .and_then(|snapshot| snapshot.payload.get("expiresAt"))
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<DateTime<Utc>>().ok())
        .is_some_and(|expiry| expiry <= Utc::now() + chrono::Duration::hours(1));
    let after_revision = if previous.is_none() || refresh_before_expiry {
        "-1".to_owned()
    } else {
        previous_revision.to_string()
    };
    let response = state
        .client
        .get(format!(
            "{}/api/control-plane/nodes/me/desired",
            identity.control_plane_url
        ))
        .bearer_auth(&identity.credential)
        .header(
            "x-ryu-node-uptime-seconds",
            sysinfo::System::uptime().to_string(),
        )
        .query(&[
            ("after", after_revision),
            ("wait", MAX_POLL_SECONDS.to_string()),
        ])
        .timeout(Duration::from_secs(MAX_POLL_SECONDS + 10))
        .send()
        .await?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(false);
    }
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        bail!("node credential was revoked");
    }
    if !response.status().is_success() {
        bail!("desired-state request returned {}", response.status());
    }
    let snapshot: SignedSnapshot = response.json().await?;
    let revision = verify_snapshot(&identity, &snapshot)?;
    if revision < previous_revision
        || (previous.is_some() && revision == previous_revision && !refresh_before_expiry)
    {
        bail!("desired-state replay or downgrade detected");
    }

    if snapshot.payload.get("assignments").is_none() {
        return Err(anyhow!("desired state has no assignments"));
    }
    // Make verified blocks effective before any artifact work. The durable LKG
    // pointer is promoted only after every required action converges.
    use_verified_assignments(&snapshot);
    persist_fail_closed_enforcement(&snapshot)?;
    cache_artifacts(&identity, &snapshot)?;
    let delivered_secrets = materialize_secrets(&identity, &snapshot).await?;
    let mut items = apply_artifacts(state, &snapshot, &delivered_secrets, previous.as_ref()).await;
    let mapped_project_ids: HashSet<String> = load_from(&mappings_path())
        .unwrap_or_default()
        .into_iter()
        .filter(|mapping| mapping.organization_id == identity.organization_id)
        .map(|mapping| mapping.project_id)
        .collect();
    let missing_project_ids: Vec<&str> = snapshot
        .payload
        .get("requiredProjectIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|project_id| !mapped_project_ids.contains(*project_id))
        .collect();
    if !missing_project_ids.is_empty() {
        items.push(json!({
            "missingProjectIds": missing_project_ids,
            "status": "needs_mapping",
        }));
    }
    let status = if items
        .iter()
        .any(|item| item.get("status").and_then(Value::as_str) == Some("error"))
    {
        "error"
    } else if items
        .iter()
        .any(|item| item.get("status").and_then(Value::as_str) == Some("needs_secret"))
    {
        "needs_secret"
    } else if items
        .iter()
        .any(|item| item.get("status").and_then(Value::as_str) == Some("needs_mapping"))
    {
        "needs_mapping"
    } else {
        "converged"
    };
    if status == "converged" {
        atomic_json(&snapshot_path(), &snapshot, false)?;
    }
    report_observed(&state.client, &identity, revision, status, items).await?;
    atomic_json(
        &status_path(),
        &FleetLocalStatus {
            last_attempt_at: Some(Utc::now().to_rfc3339()),
            last_error: None,
            observed_revision: revision,
            stale: false,
            status: status.to_owned(),
        },
        false,
    )?;
    if status != "converged" {
        tokio::time::sleep(Duration::from_secs(RETRY_SECONDS)).await;
    }
    Ok(true)
}

fn cached_snapshot_is_stale() -> bool {
    load_json::<SignedSnapshot>(&snapshot_path())
        .ok()
        .and_then(|snapshot| {
            snapshot
                .payload
                .get("expiresAt")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<DateTime<Utc>>().ok())
        })
        .is_none_or(|expiry| expiry <= Utc::now())
}

/// Managed command rules and authenticated node context forwarded to Gateway.
/// Expired LKG snapshots retain only denies; managed allows/prompts disappear.
pub fn command_scan_context() -> (Option<String>, Option<String>, Vec<Value>) {
    let Ok(identity) = load_fleet_identity() else {
        return (None, None, Vec::new());
    };
    let snapshot = load_json::<SignedSnapshot>(&snapshot_path()).ok();
    let stale = snapshot.is_none() || cached_snapshot_is_stale();
    let revision = snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.payload.get("revision"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let project_id = std::env::current_dir().ok().and_then(|cwd| {
        load_from(&mappings_path()).ok().and_then(|mappings| {
            project_for_cwd(&mappings, &identity.organization_id, &cwd).map(str::to_owned)
        })
    });
    let enforcement = load_json::<Value>(&enforcement_path()).ok();
    let enforcement_revision = enforcement
        .as_ref()
        .and_then(|value| value.get("revision"))
        .and_then(Value::as_u64)
        .unwrap_or(revision);
    let mut candidates: Vec<(Value, u64)> = enforcement
        .as_ref()
        .and_then(|value| value.get("rules"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .cloned()
        .map(|rule| (rule, enforcement_revision))
        .collect();
    candidates.extend(
        snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.payload.get("rules"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .cloned()
            .map(|rule| (rule, revision)),
    );
    let mut seen = HashSet::new();
    let rules = candidates
        .into_iter()
        .filter(|(rule, _)| {
            let id = rule
                .get("ruleId")
                .or_else(|| rule.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("");
            seen.insert(id.to_owned())
        })
        .filter(|(rule, _)| rule.get("kind").and_then(Value::as_str) == Some("command"))
        .filter_map(|(rule, rule_revision)| {
            let definition = rule.get("definition")?;
            let decision = definition.get("decision")?.as_str()?;
            if stale && decision != "deny" {
                return None;
            }
            Some(json!({
                "argv_prefix": definition.get("argvPrefix")?,
                "backends": definition.get("backends").cloned().unwrap_or_else(|| json!([])),
                "decision": decision,
                "id": rule.get("ruleId").or_else(|| rule.get("id"))?,
                "justification": definition.get("justification")?,
                "project_ids": definition.get("projectIds").cloned().unwrap_or_else(|| json!([])),
                "revision": rule_revision,
                "scope": rule.get("level")?,
            }))
        })
        .collect();
    (Some(identity.organization_id), project_id, rules)
}

/// Resolved managed instruction rules for a turn, kept separate and labelled so
/// repository files remain untouched and their provenance stays visible.
pub fn managed_instruction_block(cwd: Option<&str>) -> Option<String> {
    let identity = load_fleet_identity().ok()?;
    let snapshot = load_json::<SignedSnapshot>(&snapshot_path()).ok()?;
    let project_id = cwd.and_then(|cwd| {
        load_from(&mappings_path()).ok().and_then(|mappings| {
            project_for_cwd(&mappings, &identity.organization_id, Path::new(cwd)).map(str::to_owned)
        })
    });
    let markdown: Vec<&str> = snapshot
        .payload
        .get("rules")?
        .as_array()?
        .iter()
        .filter(|rule| rule.get("kind").and_then(Value::as_str) == Some("instruction"))
        .filter(|rule| {
            rule.get("level").and_then(Value::as_str) != Some("project")
                || rule.get("projectId").and_then(Value::as_str) == project_id.as_deref()
        })
        .filter_map(|rule| {
            rule.get("definition")?
                .get("markdown")?
                .as_str()
                .filter(|value| !value.trim().is_empty())
        })
        .collect();
    (!markdown.is_empty()).then(|| {
        format!(
            "## Organization-managed instructions\n{}",
            markdown.join("\n\n")
        )
    })
}

pub fn spawn_reconciler(state: ServerState) {
    host_status::spawn_reporter(state.client.clone());
    tokio::spawn(async move {
        loop {
            if let Err(error) = recover_enrollment(&state.client).await {
                tracing::warn!("fleet: enrollment recovery failed: {error}");
                tokio::time::sleep(Duration::from_secs(RETRY_SECONDS)).await;
                continue;
            }
            if !enrolled_bundle_path().exists() && !identity_path().exists() {
                match adopt_legacy_gateway(&state).await {
                    Ok(true) => tracing::info!("fleet: adopted legacy managed-node credential"),
                    Ok(false) => {
                        tokio::time::sleep(Duration::from_secs(RETRY_SECONDS)).await;
                        continue;
                    }
                    Err(error) => {
                        tracing::warn!("fleet: legacy node adoption failed: {error}");
                        tokio::time::sleep(Duration::from_secs(RETRY_SECONDS)).await;
                        continue;
                    }
                }
            }
            // An identity file that exists but cannot be read or parsed (or an
            // enrollment still awaiting acknowledgement) must back off like every
            // other failure here, or this loop spins with no await that sleeps.
            if let Err(error) = load_fleet_identity() {
                tracing::warn!("fleet: node identity is unusable; retrying: {error}");
                tokio::time::sleep(Duration::from_secs(RETRY_SECONDS)).await;
                continue;
            }
            if let Err(error) = reconcile_once(&state).await {
                let stale = cached_snapshot_is_stale();
                if stale {
                    expire_managed_runtime(&state).await;
                }
                let status = if stale { "expired" } else { "offline-lkg" };
                let local = FleetLocalStatus {
                    last_attempt_at: Some(Utc::now().to_rfc3339()),
                    last_error: Some(error.to_string()),
                    observed_revision: load_json::<FleetLocalStatus>(&status_path())
                        .map(|item| item.observed_revision)
                        .unwrap_or(0),
                    stale,
                    status: status.to_owned(),
                };
                if let Err(write_error) = atomic_json(&status_path(), &local, false) {
                    tracing::warn!("fleet: could not persist failure status: {write_error}");
                }
                tracing::warn!("fleet: reconciliation failed: {error}");
                tokio::time::sleep(Duration::from_secs(RETRY_SECONDS)).await;
            }
        }
    });
}

async fn expire_managed_runtime(state: &ServerState) {
    if let Ok(snapshot) = load_json::<SignedSnapshot>(&snapshot_path()) {
        if let Some(assignments) = snapshot
            .payload
            .get("assignments")
            .and_then(Value::as_array)
        {
            for assignment in assignments {
                let executable = assignment
                    .get("artifact")
                    .and_then(|artifact| artifact.get("kind"))
                    .and_then(Value::as_str)
                    .is_some_and(|kind| matches!(kind, "app" | "plugin"));
                if executable {
                    if let Some(id) = assignment
                        .get("artifact")
                        .and_then(|artifact| artifact.get("artifactId"))
                        .and_then(Value::as_str)
                    {
                        if let Err(error) = crate::server::apply_fleet_plugin_block(state, id).await
                        {
                            tracing::warn!(
                                "fleet: failed to disable expired artifact {id}: {error}"
                            );
                        }
                    }
                }
                let managed_skill = assignment
                    .get("artifact")
                    .and_then(|artifact| artifact.get("kind"))
                    .and_then(Value::as_str)
                    == Some("skill");
                if managed_skill {
                    if let Some(id) = assignment
                        .get("artifact")
                        .and_then(|artifact| artifact.get("artifactId"))
                        .and_then(Value::as_str)
                    {
                        if fleet_skill_dir(id)
                            .is_ok_and(|dir| dir.join(FLEET_SKILL_MARKER).is_file())
                        {
                            ryu_skills::set_active(id, false);
                        }
                    }
                }
            }
        }
    }
    if let Ok(mut configs) = managed_mcp_cache().write() {
        for config in configs.values_mut() {
            config.enabled = false;
        }
    }
    state.mcp.reload();
}

async fn fleet_status() -> (StatusCode, Json<Value>) {
    let bundle = load_enrolled_bundle();
    let identity = bundle
        .as_ref()
        .map(|value| value.fleet_identity.clone())
        .or_else(|| load_json::<FleetIdentity>(&identity_path()).ok());
    let organization_name = identity.as_ref().and_then(|identity| {
        crate::sidecar::control_plane::registered_org()
            .filter(|organization| organization.id == identity.organization_id)
            .map(|organization| organization.name)
    });
    let managed_inference_ready = bundle.as_ref().is_some_and(|value| value.acknowledged)
        && crate::entitlement::managed_inference_entitled();
    let status = load_json::<FleetLocalStatus>(&status_path()).unwrap_or_default();
    (
        StatusCode::OK,
        Json(json!({
            "enrolled": identity.is_some(),
            "managedInferenceReady": managed_inference_ready,
            "nodeId": identity.as_ref().map(|value| &value.node_id),
            "organizationId": identity.as_ref().map(|value| &value.organization_id),
            "organizationName": organization_name,
            "status": status,
        })),
    )
}

async fn export_stack() -> (StatusCode, Json<Value>) {
    let snapshot = match load_json::<SignedSnapshot>(&snapshot_path()) {
        Ok(snapshot) => snapshot,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "no verified fleet snapshot is available" })),
            );
        }
    };
    (StatusCode::OK, Json(stack_template(&snapshot)))
}

/// The portable stack template (`ryu.dev/stack-template/v1`) for a verified
/// snapshot: its artifact assignments and rules, without node-local state.
fn stack_template(snapshot: &SignedSnapshot) -> Value {
    let items = snapshot
        .payload
        .get("assignments")
        .and_then(Value::as_array)
        .map(|assignments| {
            assignments
                .iter()
                .filter_map(|assignment| {
                    let artifact = assignment.get("artifact")?;
                    Some(json!({
                        "activation": assignment.get("activation"),
                        "artifactId": artifact.get("artifactId"),
                        "config": assignment.get("config").cloned().unwrap_or_else(|| json!({})),
                        "digest": artifact.get("digest"),
                        "disposition": assignment.get("disposition"),
                        "keyId": artifact.get("keyId"),
                        "kind": artifact.get("kind"),
                        "setupSlots": artifact.get("setupSlots").cloned().unwrap_or_else(|| json!([])),
                        "source": artifact.get("source"),
                        "version": artifact.get("version"),
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let rules = snapshot
        .payload
        .get("rules")
        .and_then(Value::as_array)
        .map(|rules| {
            rules
                .iter()
                .filter_map(|rule| {
                    Some(json!({
                        "definition": rule.get("definition")?,
                        "kind": rule.get("kind")?,
                        "locked": rule.get("locked").cloned().unwrap_or_else(|| json!(false)),
                        "ruleId": rule.get("ruleId").or_else(|| rule.get("id"))?,
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({
        "apiVersion": "ryu.dev/stack-template/v1",
        "items": items,
        "metadata": {
            "exportedAt": Utc::now().to_rfc3339(),
            "sourceRevision": snapshot.payload.get("revision"),
        },
        "projectAliases": [],
        "rules": rules,
    })
}

pub fn routes() -> Router<ServerState> {
    Router::new()
        .route("/api/fleet/enroll", axum::routing::post(enroll_node))
        .route("/api/fleet/stack/export", get(export_stack))
        .route("/api/fleet/status", get(fleet_status))
        .route(
            "/api/org-project-mappings",
            get(list_mappings).put(put_mapping).delete(delete_mapping),
        )
}

#[cfg(test)]
mod tests {
    use super::{
        agent_allowed_by_assignments, atomic_json, canonicalize_json,
        enrolled_control_plane_url_from, enrolled_control_token_from,
        enrolled_diagnostics_relay_from, enrolled_managed_fleet_from, enrollment_claim_bytes,
        enrollment_claim_proof, enrollment_operation_lock, enrollment_token_hash, fleet_skill_dir,
        load_enrolled_bundle_from, load_fleet_identity_from, node_identity_signing_key_from,
        normalized_service_url, pending_attempt_for_request, project_for_cwd,
        registration_refresh_required, valid_enrollment_token, validate_insert,
        validate_organization_binding, verify_snapshot, EnrollResponse, EnrolledNodeBundle,
        EnrollmentOrganizationBinding, FleetIdentity, ProjectMapping, SignedSnapshot,
        ENROLLMENT_CLAIM_DOMAIN,
    };
    use base64::Engine;
    use chrono::{Duration, Utc};
    use ed25519_dalek::{Signature, Signer, SigningKey, Verifier};
    use serde_json::json;
    use std::path::Path;
    use tempfile::tempdir;

    const TEST_ENROLLMENT_TOKEN: &str =
        "rfe_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER_ENROLLMENT_TOKEN: &str =
        "rfe_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn mapping(project: &str, root: &str) -> ProjectMapping {
        ProjectMapping {
            organization_id: "org".into(),
            project_id: project.into(),
            root: root.into(),
        }
    }

    #[test]
    fn longest_root_selects_project() {
        let mappings = vec![mapping("parent", "/repo"), mapping("child", "/repo/sub")];
        assert_eq!(
            project_for_cwd(&mappings, "org", Path::new("/repo/sub/src")),
            Some("child")
        );
    }

    #[test]
    fn overlapping_roots_for_different_projects_are_rejected() {
        let mappings = vec![mapping("one", "/repo")];
        assert!(validate_insert(&mappings, &mapping("two", "/repo/sub")).is_err());
    }

    #[test]
    fn same_mapping_is_idempotent() {
        let existing = mapping("one", "/repo");
        assert!(validate_insert(std::slice::from_ref(&existing), &existing).is_ok());
    }

    #[test]
    fn managed_skill_ids_cannot_escape_the_skills_directory() {
        assert!(fleet_skill_dir("portable-stack").is_ok());
        assert!(fleet_skill_dir("../escape").is_err());
        assert!(fleet_skill_dir("nested/skill").is_err());
        assert!(fleet_skill_dir("skill name").is_err());
    }

    #[test]
    fn agent_assignments_become_an_allowlist_and_blocked_ids_stay_denied() {
        let assignments = vec![
            json!({
                "disposition": "required",
                "artifact": { "artifactId": "agent-a", "kind": "agent" }
            }),
            json!({
                "disposition": "blocked",
                "artifact": { "artifactId": "agent-b", "kind": "agent" }
            }),
        ];
        assert!(agent_allowed_by_assignments("agent-a", &assignments));
        assert!(!agent_allowed_by_assignments("agent-b", &assignments));
        assert!(!agent_allowed_by_assignments("agent-c", &assignments));
    }

    #[test]
    fn no_agent_assignment_preserves_local_availability() {
        assert!(agent_allowed_by_assignments("agent-a", &[]));
    }

    fn signed_snapshot(node_id: &str, expires_at: String) -> (FleetIdentity, SignedSnapshot) {
        let signing_key = SigningKey::from_bytes(&[7; 32]);
        let public_key = base64::engine::general_purpose::STANDARD
            .encode(signing_key.verifying_key().as_bytes());
        let payload = json!({
            "expiresAt": expires_at,
            "nodeId": node_id,
            "revision": 4,
        });
        let signature = signing_key
            .sign(&serde_json::to_vec(&canonicalize_json(&payload)).expect("canonical payload"));
        let identity = FleetIdentity {
            control_plane_url: "https://control.example".into(),
            credential: "rfn_test".into(),
            node_id: "node-1".into(),
            organization_id: "org-1".into(),
            signing_private_key: String::new(),
            signing_public_key: String::new(),
            encryption_private_key: String::new(),
            encryption_public_key: String::new(),
            snapshot_public_key: public_key.clone(),
            credential_updated_at: None,
            pending_credential: None,
        };
        (
            identity,
            SignedSnapshot {
                payload,
                public_key,
                signature: base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()),
            },
        )
    }

    #[test]
    fn node_identity_signing_key_requires_a_consistent_key_pair() {
        // The fixture's public key does not belong to its private key.
        let mut stored = identity("org-1", "node-1");
        assert!(node_identity_signing_key_from(&stored).is_none());
        let key = SigningKey::from_bytes(&[1; 32]);
        stored.signing_public_key =
            base64::engine::general_purpose::STANDARD.encode(key.verifying_key().as_bytes());
        assert_eq!(
            node_identity_signing_key_from(&stored).map(|found| found.to_bytes()),
            Some(key.to_bytes())
        );
        stored.signing_private_key = String::new();
        assert!(node_identity_signing_key_from(&stored).is_none());
    }

    fn identity(organization_id: &str, node_id: &str) -> FleetIdentity {
        FleetIdentity {
            control_plane_url: "https://control.example".into(),
            credential: "rfn_test".into(),
            node_id: node_id.into(),
            organization_id: organization_id.into(),
            signing_private_key: base64::engine::general_purpose::STANDARD.encode([1; 32]),
            signing_public_key: base64::engine::general_purpose::STANDARD.encode([2; 32]),
            encryption_private_key: base64::engine::general_purpose::STANDARD.encode([3; 32]),
            encryption_public_key: base64::engine::general_purpose::STANDARD.encode([4; 32]),
            snapshot_public_key: base64::engine::general_purpose::STANDARD.encode([5; 32]),
            credential_updated_at: None,
            pending_credential: None,
        }
    }

    fn binding() -> EnrollmentOrganizationBinding {
        EnrollmentOrganizationBinding {
            status: "ready".into(),
            acknowledgement_required: true,
            control_credential: "rgw_control".into(),
            relay_credential: "rgw_relay".into(),
            managed_fleet_url: "https://fleet.example".into(),
            credential_set_id: "gcs_1".into(),
        }
    }

    fn bundle(acknowledged: bool, organization_id: &str, node_id: &str) -> EnrolledNodeBundle {
        EnrolledNodeBundle {
            claim_id: "ad469ef7-537c-44e8-aa14-a08f813eaad2".into(),
            token_hash: enrollment_token_hash(TEST_ENROLLMENT_TOKEN),
            fleet_identity: identity(organization_id, node_id),
            organization_binding: binding(),
            acknowledged,
        }
    }

    #[test]
    fn pending_attempt_is_persisted_once_and_reused_for_retry() {
        let directory = tempdir().expect("temporary state directory");
        let path = directory.path().join("pending.json");
        let first =
            pending_attempt_for_request(&path, "https://control.example", TEST_ENROLLMENT_TOKEN)
                .expect("first pending attempt");
        let first_proof = enrollment_claim_proof(&first).expect("first claim proof");
        let second =
            pending_attempt_for_request(&path, "https://control.example", TEST_ENROLLMENT_TOKEN)
                .expect("reloaded pending attempt");
        let second_proof = enrollment_claim_proof(&second).expect("second claim proof");

        assert_eq!(second.claim_id, first.claim_id);
        assert_eq!(second.signing_private_key, first.signing_private_key);
        assert_eq!(second.encryption_private_key, first.encryption_private_key);
        assert_eq!(second_proof, first_proof);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path)
                .expect("pending metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[tokio::test]
    async fn enrollment_operation_lock_is_exclusive() {
        let guard = enrollment_operation_lock().lock().await;
        assert!(enrollment_operation_lock().try_lock().is_err());
        drop(guard);
        assert!(enrollment_operation_lock().try_lock().is_ok());
    }

    #[test]
    fn same_control_plane_resumes_pending_claim_even_with_a_new_token() {
        let directory = tempdir().expect("temporary state directory");
        let path = directory.path().join("pending.json");
        let first =
            pending_attempt_for_request(&path, "https://control.example", TEST_ENROLLMENT_TOKEN)
                .expect("first pending attempt");
        let resumed =
            pending_attempt_for_request(&path, "https://control.example", OTHER_ENROLLMENT_TOKEN)
                .expect("saved pending attempt resumes");
        assert_eq!(resumed.claim_id, first.claim_id);
        assert_eq!(resumed.token, TEST_ENROLLMENT_TOKEN);
        assert_eq!(resumed.signing_private_key, first.signing_private_key);
    }

    #[test]
    fn different_control_plane_cannot_replace_pending_claim() {
        let directory = tempdir().expect("temporary state directory");
        let path = directory.path().join("pending.json");
        let first =
            pending_attempt_for_request(&path, "https://control.example", TEST_ENROLLMENT_TOKEN)
                .expect("first pending attempt");
        let error =
            pending_attempt_for_request(&path, "https://other.example", OTHER_ENROLLMENT_TOKEN)
                .expect_err("different control plane conflicts");
        assert!(error
            .downcast_ref::<super::PendingControlPlaneConflict>()
            .is_some());
        let persisted: super::PendingEnrollmentAttempt =
            super::load_json(&path).expect("original pending attempt remains");
        assert_eq!(persisted.claim_id, first.claim_id);
        assert_eq!(persisted.control_plane_url, "https://control.example");
    }

    #[test]
    fn enrollment_token_requires_exact_lowercase_sha256_shape() {
        assert!(valid_enrollment_token(TEST_ENROLLMENT_TOKEN));
        assert!(!valid_enrollment_token("rfe_short"));
        assert!(!valid_enrollment_token(
            "rfe_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        ));
        assert!(!valid_enrollment_token(
            "rfe_gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg"
        ));
        assert!(!valid_enrollment_token(
            "other_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
    }

    #[test]
    fn enrollment_claim_matches_the_v2_canonical_wire_and_signature() {
        let directory = tempdir().expect("temporary state directory");
        let pending = pending_attempt_for_request(
            &directory.path().join("pending.json"),
            "https://control.example",
            TEST_ENROLLMENT_TOKEN,
        )
        .expect("pending attempt");
        let expected = format!(
            "{ENROLLMENT_CLAIM_DOMAIN}{{\"claimId\":\"{}\",\"encryptionPublicKey\":\"{}\",\"publicKey\":\"{}\",\"tokenHash\":\"{}\"}}",
            pending.claim_id,
            pending.encryption_public_key,
            pending.signing_public_key,
            pending.token_hash,
        );
        let message = enrollment_claim_bytes(&pending).expect("canonical claim");
        assert_eq!(message, expected.as_bytes());

        let public_key: [u8; 32] = base64::engine::general_purpose::STANDARD
            .decode(&pending.signing_public_key)
            .expect("public key base64")
            .try_into()
            .expect("public key width");
        let signature = Signature::from_slice(
            &base64::engine::general_purpose::STANDARD
                .decode(enrollment_claim_proof(&pending).expect("claim proof"))
                .expect("proof base64"),
        )
        .expect("Ed25519 signature");
        SigningKey::from_bytes(
            &base64::engine::general_purpose::STANDARD
                .decode(&pending.signing_private_key)
                .expect("private key base64")
                .try_into()
                .expect("private key width"),
        )
        .verifying_key()
        .verify(&message, &signature)
        .expect("valid signed claim");
        assert_eq!(
            SigningKey::from_bytes(
                &base64::engine::general_purpose::STANDARD
                    .decode(&pending.signing_private_key)
                    .expect("private key base64")
                    .try_into()
                    .expect("private key width"),
            )
            .verifying_key()
            .as_bytes(),
            &public_key
        );
    }

    #[test]
    fn enrolled_bundle_overwrites_atomically_when_acknowledgement_arrives() {
        let directory = tempdir().expect("temporary state directory");
        let path = directory.path().join("bundle.json");
        let mut saved = bundle(false, "org-enrolled", "node-enrolled");
        atomic_json(&path, &saved, true).expect("prepared bundle persisted");
        assert!(
            !load_enrolled_bundle_from(&path)
                .expect("prepared bundle")
                .acknowledged
        );

        saved.acknowledged = true;
        atomic_json(&path, &saved, true).expect("active bundle replaced atomically");
        let active = load_enrolled_bundle_from(&path).expect("active bundle");
        assert!(active.acknowledged);
        assert_eq!(
            active.organization_binding.control_credential,
            "rgw_control"
        );
        assert_eq!(active.organization_binding.relay_credential, "rgw_relay");
    }

    #[test]
    fn enrolled_credentials_remain_hidden_until_acknowledgement_is_durable() {
        let directory = tempdir().expect("temporary state directory");
        let path = directory.path().join("bundle.json");
        atomic_json(&path, &bundle(false, "org-enrolled", "node-enrolled"), true)
            .expect("prepared bundle");
        assert_eq!(enrolled_control_token_from(&path), None);
        assert_eq!(enrolled_managed_fleet_from(&path), None);

        atomic_json(&path, &bundle(true, "org-enrolled", "node-enrolled"), true)
            .expect("acknowledged bundle");
        assert_eq!(
            enrolled_control_token_from(&path),
            Some("rgw_control".into())
        );
        assert_eq!(
            enrolled_managed_fleet_from(&path),
            Some(("https://fleet.example".into(), "rgw_relay".into()))
        );
        assert_eq!(
            enrolled_control_plane_url_from(&path),
            Some("https://control.example".into())
        );
    }

    #[test]
    fn diagnostics_relay_is_available_only_after_self_hosted_enrollment_acknowledges() {
        let directory = tempdir().expect("temporary state directory");
        let path = directory.path().join("bundle.json");
        atomic_json(&path, &bundle(false, "org-enrolled", "node-enrolled"), true)
            .expect("prepared bundle");
        assert!(enrolled_diagnostics_relay_from(&path).is_none());

        atomic_json(&path, &bundle(true, "org-enrolled", "node-enrolled"), true)
            .expect("acknowledged bundle");
        let relay = enrolled_diagnostics_relay_from(&path).expect("acknowledged relay");
        assert_eq!(relay.control_plane_url, "https://control.example");
        assert_eq!(relay.relay_token, "rgw_relay");
    }

    #[test]
    fn unacknowledged_bundle_cannot_supply_control_plane_url() {
        let directory = tempdir().expect("temporary state directory");
        let path = directory.path().join("bundle.json");
        atomic_json(&path, &bundle(false, "org-enrolled", "node-enrolled"), true)
            .expect("prepared bundle");
        assert_eq!(enrolled_control_plane_url_from(&path), None);
    }

    #[test]
    fn acknowledged_bundle_retries_registration_until_org_and_node_match() {
        use crate::sidecar::control_plane::{NodeScope, RegisteredNode, RegisteredOrg};

        let enrolled = bundle(true, "org-enrolled", "node-enrolled");
        assert!(registration_refresh_required(&enrolled, None));
        let matching = RegisteredNode {
            org: RegisteredOrg {
                id: "org-enrolled".into(),
                name: "Acme".into(),
                slug: Some("acme".into()),
            },
            node_id: "node-enrolled".into(),
            scope: NodeScope::Org,
            team_id: None,
            owner_user_id: None,
        };
        assert!(!registration_refresh_required(&enrolled, Some(&matching)));
        let wrong_node = RegisteredNode {
            node_id: "node-other".into(),
            ..matching
        };
        assert!(registration_refresh_required(&enrolled, Some(&wrong_node)));
    }

    #[test]
    fn v2_prepare_rejects_missing_organization_binding() {
        let directory = tempdir().expect("temporary state directory");
        let pending_path = directory.path().join("pending.json");
        let pending = pending_attempt_for_request(
            &pending_path,
            "https://control.example",
            TEST_ENROLLMENT_TOKEN,
        )
        .expect("pending attempt");
        let response = EnrollResponse {
            credential: "rfn_test".into(),
            node_id: "node-enrolled".into(),
            organization_id: "org-enrolled".into(),
            signing_public_key: base64::engine::general_purpose::STANDARD.encode([5; 32]),
            organization_binding: None,
        };
        assert!(super::prepared_identity_and_bundle(&pending, response).is_err());
        assert!(pending_path.exists());
        assert!(!directory.path().join("fleet-identity.json").exists());
    }

    #[test]
    fn secret_fleet_state_is_sealed_on_disk_and_opens_on_load() {
        let directory = tempdir().expect("temporary state directory");
        let path = directory.path().join("fleet-enrolled-node.json");
        atomic_json(&path, &bundle(true, "org-enrolled", "node-enrolled"), true)
            .expect("sealed bundle");
        let raw = std::fs::read_to_string(&path).expect("bundle bytes");
        assert!(raw.trim().starts_with("enc:v1:"), "{raw}");
        for secret in [
            "rgw_control",
            "rgw_relay",
            "signingPrivateKey",
            "credential",
        ] {
            assert!(!raw.contains(secret), "{secret} leaked: {raw}");
        }
        let loaded = load_enrolled_bundle_from(&path).expect("sealed bundle opens");
        assert_eq!(
            loaded.organization_binding.control_credential,
            "rgw_control"
        );
        assert_eq!(loaded.organization_binding.relay_credential, "rgw_relay");
    }

    #[test]
    fn legacy_plaintext_fleet_identity_loads_and_is_sealed_in_place() {
        let directory = tempdir().expect("temporary state directory");
        let path = directory.path().join("fleet-identity.json");
        let legacy = identity("org-legacy", "node-legacy");
        std::fs::write(&path, serde_json::to_vec_pretty(&legacy).unwrap()).expect("legacy file");
        let loaded: FleetIdentity = super::load_json(&path).expect("legacy plaintext loads");
        assert_eq!(loaded.credential, legacy.credential);
        let raw = std::fs::read_to_string(&path).expect("identity bytes");
        assert!(raw.trim().starts_with("enc:v1:"), "{raw}");
        assert!(!raw.contains(&legacy.signing_private_key));
        assert!(!raw.contains(&legacy.encryption_private_key));
        let reloaded: FleetIdentity = super::load_json(&path).expect("sealed identity loads");
        assert_eq!(reloaded.signing_private_key, legacy.signing_private_key);
        // A sealed body that does not open is an error, never a default.
        std::fs::write(&path, "enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap();
        assert!(super::load_json::<FleetIdentity>(&path).is_err());
    }

    #[test]
    fn acknowledged_bundle_precedes_legacy_identity_without_breaking_legacy_loading() {
        let directory = tempdir().expect("temporary state directory");
        let bundle_path = directory.path().join("bundle.json");
        let legacy_path = directory.path().join("identity.json");
        atomic_json(&legacy_path, &identity("org-legacy", "node-legacy"), true)
            .expect("legacy identity");

        let legacy = load_fleet_identity_from(&bundle_path, &legacy_path)
            .expect("legacy identity remains loadable");
        assert_eq!(legacy.organization_id, "org-legacy");

        atomic_json(
            &bundle_path,
            &bundle(true, "org-enrolled", "node-enrolled"),
            true,
        )
        .expect("enrolled bundle");
        let enrolled =
            load_fleet_identity_from(&bundle_path, &legacy_path).expect("acknowledged bundle");
        assert_eq!(enrolled.organization_id, "org-enrolled");
        assert_eq!(enrolled.node_id, "node-enrolled");

        atomic_json(
            &bundle_path,
            &bundle(false, "org-enrolled", "node-enrolled"),
            true,
        )
        .expect("unacknowledged bundle");
        assert!(load_fleet_identity_from(&bundle_path, &legacy_path).is_err());
    }

    /// The states that make the reconciler take its back-off branch: a legacy
    /// identity file exists (so legacy adoption is skipped) but cannot be
    /// loaded, and there is no acknowledged bundle to take precedence.
    #[test]
    fn unusable_legacy_identity_without_a_bundle_fails_to_load() {
        let directory = tempdir().expect("temporary state directory");
        let bundle_path = directory.path().join("bundle.json");
        let legacy_path = directory.path().join("identity.json");
        for corrupt in [&b"{not json"[..], &b"{\"nodeId\":\"partial\"}"[..]] {
            std::fs::write(&legacy_path, corrupt).expect("corrupt legacy identity");
            assert!(legacy_path.exists() && !bundle_path.exists());
            assert!(load_fleet_identity_from(&bundle_path, &legacy_path).is_err());
        }
        // An acknowledged bundle still wins over the corrupt legacy file.
        atomic_json(
            &bundle_path,
            &bundle(true, "org-enrolled", "node-enrolled"),
            true,
        )
        .expect("enrolled bundle");
        assert!(load_fleet_identity_from(&bundle_path, &legacy_path).is_ok());
    }

    #[test]
    fn organization_binding_rejects_shared_control_and_relay_credentials() {
        let mut invalid = binding();
        invalid.relay_credential = invalid.control_credential.clone();
        assert!(validate_organization_binding(&invalid).is_err());
    }

    #[test]
    fn enrollment_url_allows_only_https_or_exact_loopback_http() {
        assert!(normalized_service_url("https://control.example/").is_ok());
        assert!(normalized_service_url("http://127.0.0.1:3000").is_ok());
        assert!(normalized_service_url("http://127.0.0.1.evil.example").is_err());
        assert!(normalized_service_url("https://user:secret@control.example").is_err());
        assert!(normalized_service_url(&format!("https://{}", "a".repeat(2048))).is_err());
    }

    #[test]
    fn snapshot_signature_is_bound_to_node() {
        let (identity, snapshot) =
            signed_snapshot("other-node", (Utc::now() + Duration::hours(1)).to_rfc3339());
        assert!(verify_snapshot(&identity, &snapshot).is_err());
    }

    #[test]
    fn expired_snapshot_is_rejected() {
        let (identity, snapshot) =
            signed_snapshot("node-1", (Utc::now() - Duration::seconds(1)).to_rfc3339());
        assert!(verify_snapshot(&identity, &snapshot).is_err());
    }

    #[test]
    fn valid_snapshot_returns_revision() {
        let (identity, snapshot) =
            signed_snapshot("node-1", (Utc::now() + Duration::hours(1)).to_rfc3339());
        assert_eq!(verify_snapshot(&identity, &snapshot).expect("verified"), 4);
    }
}

#[cfg(test)]
mod credential_rotation_tests {
    use super::{generate_node_credential, rotate_credential_with, FleetIdentity};
    use axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
        routing::post,
        Json, Router,
    };
    use base64::Engine;
    use chrono::{Duration, Utc};
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    const ORIGINAL: &str = "rfn_original";

    /// The control plane's stored rotation state, with the same rules as
    /// `POST /nodes/me/rotate-credential`: the current bearer, or the previous
    /// one inside its grace window, authenticates; a proposal equal to the
    /// current credential is confirmed unchanged; only the current bearer can
    /// replace it.
    #[derive(Default)]
    struct ControlPlane {
        current: String,
        previous: Option<String>,
        grace_open: bool,
        lose_next_reply: bool,
        requests: Vec<(String, String)>,
    }

    type Shared = Arc<Mutex<ControlPlane>>;

    async fn rotate(
        State(state): State<Shared>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> (StatusCode, Json<Value>) {
        let bearer = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .unwrap_or_default()
            .to_owned();
        let proposed = body
            .get("credential")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let mut plane = state.lock().unwrap();
        plane.requests.push((bearer.clone(), proposed.clone()));
        let authenticated = bearer == plane.current
            || (plane.grace_open && plane.previous.as_deref() == Some(bearer.as_str()));
        if !authenticated {
            return (StatusCode::UNAUTHORIZED, Json(json!({})));
        }
        if proposed == plane.current {
            return (StatusCode::OK, Json(json!({ "credential": proposed })));
        }
        if bearer != plane.current {
            return (StatusCode::UNAUTHORIZED, Json(json!({})));
        }
        plane.previous = Some(std::mem::replace(&mut plane.current, proposed.clone()));
        plane.grace_open = true;
        if plane.lose_next_reply {
            plane.lose_next_reply = false;
            return (StatusCode::BAD_GATEWAY, Json(json!({})));
        }
        (StatusCode::OK, Json(json!({ "credential": proposed })))
    }

    async fn control_plane(plane: ControlPlane) -> (Shared, String) {
        let state: Shared = Arc::new(Mutex::new(plane));
        let app = Router::new()
            .route(
                "/api/control-plane/nodes/me/rotate-credential",
                post(rotate),
            )
            .with_state(state.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (state, format!("http://{address}"))
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    fn due_identity(control_plane_url: String) -> FleetIdentity {
        let key = |byte: u8| base64::engine::general_purpose::STANDARD.encode([byte; 32]);
        FleetIdentity {
            control_plane_url,
            credential: ORIGINAL.into(),
            node_id: "node-1".into(),
            organization_id: "org".into(),
            signing_private_key: key(1),
            signing_public_key: key(2),
            encryption_private_key: key(3),
            encryption_public_key: key(4),
            snapshot_public_key: key(5),
            credential_updated_at: Some(Utc::now() - Duration::days(2)),
            pending_credential: None,
        }
    }

    fn recorder() -> (
        Arc<Mutex<Vec<FleetIdentity>>>,
        impl Fn(&FleetIdentity) -> anyhow::Result<()>,
    ) {
        let saved = Arc::new(Mutex::new(Vec::new()));
        let sink = saved.clone();
        (saved, move |identity: &FleetIdentity| {
            sink.lock().unwrap().push(identity.clone());
            Ok(())
        })
    }

    #[test]
    fn generated_successor_matches_the_control_plane_shape() {
        let first = generate_node_credential();
        let hex = first.strip_prefix("rfn_").expect("rfn_ prefix");
        assert_eq!(hex.len(), 64);
        assert!(hex
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        assert_ne!(first, generate_node_credential());
    }

    #[tokio::test]
    async fn a_lost_reply_is_recovered_after_the_grace_window_closes() {
        let (plane, url) = control_plane(ControlPlane {
            current: ORIGINAL.into(),
            lose_next_reply: true,
            ..ControlPlane::default()
        })
        .await;
        let (saved, persist) = recorder();
        let mut identity = due_identity(url);

        let lost = rotate_credential_with(&client(), &mut identity, &persist).await;
        assert!(lost.is_err(), "a lost reply is reported");
        let successor = identity
            .pending_credential
            .clone()
            .expect("successor is kept for the retry");
        assert_eq!(identity.credential, ORIGINAL);
        assert_eq!(plane.lock().unwrap().current, successor);
        // The successor reached disk before the request was sent.
        {
            let saved = saved.lock().unwrap();
            assert_eq!(saved.len(), 1);
            assert_eq!(saved[0].credential, ORIGINAL);
            assert_eq!(
                saved[0].pending_credential.as_deref(),
                Some(successor.as_str())
            );
        }

        // The old bearer stops working before the node retries.
        plane.lock().unwrap().grace_open = false;
        rotate_credential_with(&client(), &mut identity, &persist)
            .await
            .expect("the saved successor confirms itself");
        assert_eq!(identity.credential, successor);
        assert_eq!(identity.pending_credential, None);
        let last = saved
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("saved identity");
        assert_eq!(last.credential, successor);
        assert_eq!(last.pending_credential, None);
        let plane = plane.lock().unwrap();
        assert_eq!(plane.current, successor);
        assert_eq!(plane.previous.as_deref(), Some(ORIGINAL));
        assert_eq!(
            plane.requests[1..],
            [
                (ORIGINAL.to_owned(), successor.clone()),
                (successor.clone(), successor.clone()),
            ]
        );
    }

    #[tokio::test]
    async fn a_failed_save_after_commit_is_confirmed_on_the_next_pass() {
        let (plane, url) = control_plane(ControlPlane {
            current: ORIGINAL.into(),
            ..ControlPlane::default()
        })
        .await;
        let saved: Arc<Mutex<Vec<FleetIdentity>>> = Arc::default();
        let sink = saved.clone();
        // The pending successor saves; writing the promoted identity fails.
        let flaky = move |identity: &FleetIdentity| {
            let mut saved = sink.lock().unwrap();
            if !saved.is_empty() {
                anyhow::bail!("disk full");
            }
            saved.push(identity.clone());
            Ok(())
        };
        let mut identity = due_identity(url);
        assert!(rotate_credential_with(&client(), &mut identity, &flaky)
            .await
            .is_err());

        // What a restarted node loads: the old bearer plus the saved successor.
        let mut reloaded = saved.lock().unwrap()[0].clone();
        let successor = reloaded
            .pending_credential
            .clone()
            .expect("saved successor");
        assert_eq!(plane.lock().unwrap().current, successor);
        let (_, persist) = recorder();
        rotate_credential_with(&client(), &mut reloaded, &persist)
            .await
            .expect("the old bearer confirms the committed successor in its grace window");
        assert_eq!(reloaded.credential, successor);
        assert_eq!(reloaded.pending_credential, None);
        let plane = plane.lock().unwrap();
        assert_eq!(plane.current, successor);
        assert_eq!(plane.previous.as_deref(), Some(ORIGINAL));
        assert_eq!(plane.requests.len(), 2);
    }

    #[tokio::test]
    async fn rotation_is_skipped_until_the_credential_is_a_day_old() {
        let (plane, url) = control_plane(ControlPlane {
            current: ORIGINAL.into(),
            ..ControlPlane::default()
        })
        .await;
        let (saved, persist) = recorder();
        let mut identity = due_identity(url);
        identity.credential_updated_at = Some(Utc::now() - Duration::hours(1));
        rotate_credential_with(&client(), &mut identity, &persist)
            .await
            .expect("nothing to do");
        assert!(saved.lock().unwrap().is_empty());
        assert!(plane.lock().unwrap().requests.is_empty());
        assert_eq!(identity.credential, ORIGINAL);
    }
}
