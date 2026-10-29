//! Permission-specific deferred execution. An app can retain a principal attested
//! by Core, but every execution must pass current membership and resource ACLs.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::identity_verify::VerifiedCaller;
use crate::server::ServerState;
use crate::sidecar::control_plane;

pub const PRINCIPAL_HEADER: &str = "x-ryu-caller-principal-proof";
/// The agent a forwarded app request runs for, as a Core-signed grant. Only the
/// trusted proxy stamps it (caller copies are stripped); an app keeps it with
/// deferred work and hands it back on `providers.call`, where Core re-reads that
/// agent's current account access. It names an agent and nothing else, so a
/// replayed grant can only apply that agent's restrictions, never widen access.
pub const AGENT_GRANT_HEADER: &str = ryu_app_events::HDR_AGENT_GRANT;
const DOMAIN: &[u8] = b"ryu-deferred-authorization-v1\0";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    purpose: String,
    plugin: String,
    node: String,
    org: Option<String>,
    user: Option<String>,
    expires_at: Option<i64>,
    permission: Option<String>,
    resource: Option<String>,
    /// The agent an `agent` grant names. Skipped when absent, so the signed
    /// bytes of every principal and execution envelope are unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

fn node_binding() -> String {
    control_plane::registered_node()
        .map(|node| node.node_id)
        .unwrap_or_else(|| format!("local:{}", crate::paths::ryu_dir().display()))
}

fn sign(envelope: &Envelope, key: &str) -> Option<String> {
    let bytes = serde_json::to_vec(envelope).ok()?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).ok()?;
    mac.update(DOMAIN);
    mac.update(&bytes);
    Some(format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(bytes),
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}

fn verify(proof: &str, key: &str, plugin: &str, purpose: &str) -> Result<Envelope, &'static str> {
    if proof.len() > 8192 {
        return Err("invalid authorization proof");
    }
    let (payload, signature) = proof.split_once('.').ok_or("invalid authorization proof")?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| "invalid authorization proof")?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| "invalid authorization proof")?;
    let mut mac =
        Hmac::<Sha256>::new_from_slice(key.as_bytes()).map_err(|_| "authorization unavailable")?;
    mac.update(DOMAIN);
    mac.update(&bytes);
    mac.verify_slice(&signature)
        .map_err(|_| "invalid authorization proof")?;
    let envelope: Envelope =
        serde_json::from_slice(&bytes).map_err(|_| "invalid authorization proof")?;
    if envelope.plugin != plugin
        || envelope.purpose != purpose
        || envelope.node != node_binding()
        || envelope.org != control_plane::registered_org().map(|org| org.id)
        || envelope
            .expires_at
            .is_some_and(|expiry| expiry <= chrono::Utc::now().timestamp())
    {
        return Err("authorization binding changed or expired");
    }
    Ok(envelope)
}

/// Only the trusted proxy stamps this header; caller copies are stripped. The
/// short-lived identity attestation cannot itself authorize deferred execution.
pub fn principal_proof(
    plugin: &str,
    caller: Option<&VerifiedCaller>,
    owner_bearer: Option<&str>,
) -> Option<String> {
    let key = crate::node_token::active_token()?;
    let org = control_plane::registered_org().map(|org| org.id);
    let unbound_local = org.is_none() && !control_plane::is_managed_node();
    if (unbound_local || caller.is_none())
        && owner_bearer.is_none_or(|provided| !crate::server::ct_eq(provided, &key))
    {
        return None;
    }
    if caller.is_none() && (org.is_some() || control_plane::is_managed_node()) {
        return None;
    }
    if caller.is_some_and(|caller| org.is_some() && caller.org_id != org) {
        return None;
    }
    sign(
        &Envelope {
            purpose: "principal".to_owned(),
            plugin: plugin.to_owned(),
            node: node_binding(),
            org,
            user: caller.map(|caller| caller.user_id.clone()),
            expires_at: Some(chrono::Utc::now().timestamp() + 60),
            permission: None,
            resource: None,
            agent: None,
        },
        &key,
    )
}

fn agent_envelope(plugin: &str, agent_id: &str) -> Envelope {
    Envelope {
        purpose: "agent".to_owned(),
        plugin: plugin.to_owned(),
        node: node_binding(),
        org: control_plane::registered_org().map(|org| org.id),
        user: None,
        // No expiry: an app publishes deferred work long after the agent's
        // request ended, and the grant authorizes nothing by itself. Core reads
        // the agent's account access fresh on every use. Rotating the node
        // token invalidates every stored grant; Core then lets the work through
        // only for an agent that is now unrestricted (see
        // `unverified_agent_grant_hint`).
        expires_at: None,
        permission: None,
        resource: None,
        agent: Some(agent_id.to_owned()),
    }
}

fn sign_agent_grant(plugin: &str, agent_id: &str, key: &str) -> Option<String> {
    let agent_id = agent_id.trim();
    if agent_id.is_empty() || agent_id.len() > 256 {
        return None;
    }
    sign(&agent_envelope(plugin, agent_id), key)
}

fn verify_agent_grant_with(proof: &str, key: &str, plugin: &str) -> Result<String, &'static str> {
    verify(proof, key, plugin, "agent")?
        .agent
        .filter(|agent| !agent.trim().is_empty())
        .ok_or("invalid authorization proof")
}

/// The agent a grant for `plugin` claims to name, read WITHOUT checking its
/// signature or bindings. Never an authorization by itself: Core uses it only
/// to tell a stale grant (the node token rotated, or the node joined an
/// organization) of an agent that is now unrestricted, whose call would pass
/// with no grant at all, from one of a limited agent, which stays refused.
pub fn unverified_agent_grant_hint(proof: &str, plugin: &str) -> Option<String> {
    if proof.len() > 8192 {
        return None;
    }
    let (payload, _) = proof.split_once('.')?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let envelope: Envelope = serde_json::from_slice(&bytes).ok()?;
    if envelope.purpose != "agent" || envelope.plugin != plugin {
        return None;
    }
    envelope
        .agent
        .map(|agent| agent.trim().to_owned())
        .filter(|agent| !agent.is_empty())
}

/// A grant naming the agent behind a request Core forwards to `plugin`. Only
/// the trusted proxy mints it, after verifying the agent lane.
pub fn agent_grant(plugin: &str, agent_id: &str) -> Option<String> {
    let key = crate::node_token::active_token()?;
    sign_agent_grant(plugin, agent_id, &key)
}

/// How many forwarded agent requests each app is serving right now.
static ACTIVE_AGENT_REQUESTS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, usize>>,
> = std::sync::LazyLock::new(Default::default);

fn active_agent_requests(
) -> std::sync::MutexGuard<'static, std::collections::HashMap<String, usize>> {
    // A poisoned map still holds correct counts: every update is one
    // increment or decrement, so the data is never left half-written.
    ACTIVE_AGENT_REQUESTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Marks one agent request Core forwarded to an app as in flight, for as long
/// as the guard lives. The proxy keeps it until the app's response body ends,
/// so the context covers the whole request.
#[must_use = "the context ends when the guard is dropped"]
pub struct AgentRequestContext {
    plugin: String,
}

impl Drop for AgentRequestContext {
    fn drop(&mut self) {
        let mut active = active_agent_requests();
        if let Some(count) = active.get_mut(&self.plugin) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                active.remove(&self.plugin);
            }
        }
    }
}

/// Start the context of an agent request forwarded to `plugin`. While any is
/// active, a `providers.call` from that app must carry an agent grant
/// ([`has_active_agent_request`]), so an app cannot drop the grant to run an
/// agent's work with the user's accounts.
pub fn enter_agent_request(plugin: &str) -> AgentRequestContext {
    *active_agent_requests()
        .entry(plugin.to_owned())
        .or_insert(0) += 1;
    AgentRequestContext {
        plugin: plugin.to_owned(),
    }
}

/// Whether Core is forwarding an agent's request to `plugin` right now.
pub fn has_active_agent_request(plugin: &str) -> bool {
    active_agent_requests()
        .get(plugin)
        .is_some_and(|count| *count > 0)
}

/// A grant signed with `key` instead of this node's token, as one stored
/// before the token rotated would be.
#[cfg(test)]
pub(crate) fn agent_grant_signed_with(plugin: &str, agent_id: &str, key: &str) -> Option<String> {
    sign_agent_grant(plugin, agent_id, key)
}

/// The agent an app-presented grant names. The grant must be signed with this
/// node's token for this plugin, node and organization.
pub fn verify_agent_grant(proof: &str, plugin: &str) -> Result<String, &'static str> {
    let key = crate::node_token::active_token().ok_or("authorization unavailable")?;
    verify_agent_grant_with(proof, &key, plugin)
}

async fn authorize(state: &ServerState, envelope: &Envelope) -> Result<(), &'static str> {
    let permission = envelope
        .permission
        .as_deref()
        .ok_or("permission is required")?;
    let resource = envelope.resource.as_deref().ok_or("resource is required")?;
    let manifests = state.app_manifests.read().await;
    let manifest = manifests
        .iter()
        .find(|manifest| manifest.id == envelope.plugin)
        .ok_or("app unavailable")?;
    if !manifest
        .permission_levels
        .iter()
        .any(|level| level.id == permission)
    {
        return Err("permission is not declared by this app");
    }
    drop(manifests);
    let (caller, permissions) = match (envelope.user.as_deref(), envelope.org.as_deref()) {
        (Some(user), Some(_)) => {
            let (caller, permissions) = control_plane::resolve_current_principal(user)
                .await
                .map_err(|_| "current authorization unavailable")?;
            (Some(caller), permissions)
        }
        (_, None) if !control_plane::is_managed_node() => (None, Default::default()),
        _ => return Err("authenticated execution principal required"),
    };
    crate::server::enforce_permission_on_resolved(
        &caller,
        permission,
        &envelope.plugin,
        resource,
        permissions,
    )
    .map_err(|_| "execution permission denied")
}

pub async fn invoke(
    state: &ServerState,
    plugin: &str,
    method: &str,
    args: Value,
) -> Result<Value, &'static str> {
    let key = crate::node_token::active_token().ok_or("authorization unavailable")?;
    let proof = args
        .get("proof")
        .and_then(Value::as_str)
        .ok_or("proof is required")?;
    let issue = method == "authorization_issue";
    let mut envelope = verify(
        proof,
        &key,
        plugin,
        if issue { "principal" } else { "execution" },
    )?;
    if issue {
        let permission = args
            .get("permission")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .ok_or("permission is required")?;
        let resource = args
            .get("resource")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .ok_or("resource is required")?;
        envelope.permission = Some(permission.to_owned());
        envelope.resource = Some(resource.to_owned());
    } else if args.get("permission").and_then(Value::as_str) != envelope.permission.as_deref()
        || args.get("resource").and_then(Value::as_str) != envelope.resource.as_deref()
    {
        return Err("execution operation binding mismatch");
    }
    authorize(state, &envelope).await?;
    if issue {
        envelope.purpose = "execution".to_owned();
        envelope.expires_at = None;
        Ok(
            json!({ "proof": sign(&envelope, &key).ok_or("authorization unavailable")?, "userId": envelope.user, "orgId": envelope.org }),
        )
    } else {
        Ok(json!({ "allowed": true, "userId": envelope.user, "orgId": envelope.org }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anonymous_public_requests_do_not_receive_owner_attestations() {
        assert!(principal_proof("example.app", None, None).is_none());
        assert!(principal_proof("example.app", None, Some("invalid-owner-bearer")).is_none());
        if !control_plane::is_managed_node() && control_plane::registered_org().is_none() {
            let owner_bearer =
                crate::node_token::active_token().expect("isolated test owner token");
            assert!(principal_proof("example.app", None, Some(&owner_bearer)).is_some());
            let caller = VerifiedCaller {
                user_id: "nonowner".to_owned(),
                email: None,
                email_verified: false,
                org_id: None,
                role: crate::identity_verify::OrgRole::Viewer,
                teams: Vec::new(),
            };
            assert!(principal_proof("example.app", Some(&caller), None).is_none());
            assert!(
                principal_proof("example.app", Some(&caller), Some("wrong-owner-bearer")).is_none()
            );
            assert!(principal_proof("example.app", Some(&caller), Some(&owner_bearer)).is_some());
        }
    }

    #[test]
    fn proof_cannot_change_subject_plugin_operation_or_signing_key() {
        let envelope = Envelope {
            purpose: "execution".to_owned(),
            plugin: "example.app".to_owned(),
            node: node_binding(),
            org: None,
            user: Some("alice".to_owned()),
            expires_at: None,
            permission: Some("example.run".to_owned()),
            resource: Some("project".to_owned()),
            agent: None,
        };
        let proof = sign(&envelope, "test-signing-key").expect("sign");
        assert!(verify(&proof, "test-signing-key", "example.app", "execution").is_ok());
        assert!(verify(&proof, "other-signing-key", "example.app", "execution").is_err());
        assert!(verify(&proof, "test-signing-key", "other.app", "execution").is_err());
        assert!(verify(&proof, "test-signing-key", "example.app", "principal").is_err());
        let mut altered = envelope;
        altered.user = Some("bob".to_owned());
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&altered).expect("serialize"));
        let tampered = format!("{payload}.{}", proof.split_once('.').expect("proof").1);
        assert!(verify(&tampered, "test-signing-key", "example.app", "execution").is_err());
    }

    #[test]
    fn agent_grant_round_trips_and_binds_plugin() {
        let grant = sign_agent_grant("@ryu/social", "agent-1", "test-signing-key").expect("sign");
        assert_eq!(
            verify_agent_grant_with(&grant, "test-signing-key", "@ryu/social"),
            Ok("agent-1".to_owned())
        );
        assert!(verify_agent_grant_with(&grant, "test-signing-key", "@ryu/ugc").is_err());
        assert!(verify_agent_grant_with(&grant, "other-signing-key", "@ryu/social").is_err());
        assert!(sign_agent_grant("@ryu/social", " ", "test-signing-key").is_none());
    }

    #[test]
    fn a_grant_hint_reads_the_agent_without_trusting_it() {
        let grant = sign_agent_grant("@ryu/social", "agent-1", "test-signing-key").expect("sign");
        assert_eq!(
            unverified_agent_grant_hint(&grant, "@ryu/social").as_deref(),
            Some("agent-1")
        );
        assert_eq!(unverified_agent_grant_hint(&grant, "@ryu/ugc"), None);
        assert_eq!(
            unverified_agent_grant_hint("not-a-grant", "@ryu/social"),
            None
        );
        // A signature from another key still yields the hint: it is a hint.
        let other = sign_agent_grant("@ryu/social", "agent-2", "rotated-key").expect("sign");
        assert!(verify_agent_grant_with(&other, "test-signing-key", "@ryu/social").is_err());
        assert_eq!(
            unverified_agent_grant_hint(&other, "@ryu/social").as_deref(),
            Some("agent-2")
        );
    }

    #[test]
    fn agent_grant_rejects_tampering() {
        let grant = sign_agent_grant("@ryu/social", "agent-1", "test-signing-key").expect("sign");
        let (payload, signature) = grant.split_once('.').expect("grant");
        let altered = agent_envelope("@ryu/social", "agent-2");
        let forged_payload =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&altered).expect("serialize"));
        assert!(verify_agent_grant_with(
            &format!("{forged_payload}.{signature}"),
            "test-signing-key",
            "@ryu/social"
        )
        .is_err());
        let mut bad_signature = URL_SAFE_NO_PAD.decode(signature).expect("signature");
        bad_signature[0] ^= 1;
        assert!(verify_agent_grant_with(
            &format!("{payload}.{}", URL_SAFE_NO_PAD.encode(bad_signature)),
            "test-signing-key",
            "@ryu/social"
        )
        .is_err());
    }

    #[test]
    fn principal_and_agent_proofs_are_not_interchangeable() {
        let principal = Envelope {
            purpose: "principal".to_owned(),
            plugin: "@ryu/social".to_owned(),
            node: node_binding(),
            org: control_plane::registered_org().map(|org| org.id),
            user: Some("alice".to_owned()),
            expires_at: Some(chrono::Utc::now().timestamp() + 60),
            permission: None,
            resource: None,
            agent: None,
        };
        let principal = sign(&principal, "test-signing-key").expect("sign");
        assert!(verify_agent_grant_with(&principal, "test-signing-key", "@ryu/social").is_err());
        let grant = sign_agent_grant("@ryu/social", "agent-1", "test-signing-key").expect("sign");
        for purpose in ["principal", "execution"] {
            assert_eq!(
                verify(&grant, "test-signing-key", "@ryu/social", purpose).err(),
                Some("authorization binding changed or expired")
            );
        }
    }

    #[test]
    fn existing_envelopes_keep_their_signed_bytes() {
        let envelope = Envelope {
            purpose: "execution".to_owned(),
            plugin: "example.app".to_owned(),
            node: "node-1".to_owned(),
            org: None,
            user: Some("alice".to_owned()),
            expires_at: None,
            permission: Some("example.run".to_owned()),
            resource: Some("project".to_owned()),
            agent: None,
        };
        assert_eq!(
            String::from_utf8(serde_json::to_vec(&envelope).expect("serialize")).expect("utf8"),
            r#"{"purpose":"execution","plugin":"example.app","node":"node-1","org":null,"user":"alice","expires_at":null,"permission":"example.run","resource":"project"}"#
        );
    }
}
