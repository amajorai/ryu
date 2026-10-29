//! Marketplace governance crypto core: grant-allowlist matching + ed25519
//! manifest signing / verification (#468, ties #450).
//!
//! This crate holds the **pure** governance primitives — everything that
//! operates over caller-supplied data and *explicit* keys / allowlists, with no
//! env, disk, or process-global state:
//!
//!   - **Grant validation** ([`validate_grants_for`]): decide a manifest's
//!     requested permission grants under the **capability grammar** — an
//!     owner-scoped self-grant rule plus an *explicit* allowlist — returning
//!     `{ approved, denied }`. The policy inputs (the built-in default
//!     allowlist, the `RYU_MARKETPLACE_GRANT_ALLOWLIST` env override, and the
//!     reserved host-primitive namespace vocabulary) are resolved by the gateway
//!     wiring and passed in as a [`GrantPolicy`].
//!
//!   - **Manifest signing** ([`sign_manifest`] / [`verify_manifest`]): sign and
//!     verify over a canonicalized (recursively key-sorted) JSON encoding, so a
//!     faithfully-preserved manifest verifies even after a Mongo / JSON
//!     round-trip. Both take an *explicit* `SigningKey` / `VerifyingKey`; the
//!     gateway owns the key custody (env source-of-truth + dev-persisted disk
//!     key) and passes the resolved key in.
//!
//! The signing-key custody path (`RYU_MARKETPLACE_SIGNING_KEY` resolution, the
//! dev-persisted on-disk key, the process `OnceLock`) and the default grant
//! allowlist stay in `apps/gateway/src/governance/mod.rs` — the marketplace
//! trust root, kept where the secret is custodied. This crate is the crypto it
//! calls. Behavior is identical: the gateway wrappers resolve the key/allowlist
//! and delegate here.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey, SECRET_KEY_LENGTH};
use serde_json::{Map, Value};

/// The signing algorithm advertised in responses and stored alongside a
/// signature. Stable identifier so clients/verifiers can branch on it.
pub const SIGNING_ALGORITHM: &str = "ed25519";

// ── grant validation ──────────────────────────────────────────────────────────

/// Outcome of validating a manifest's requested grants against gateway policy.
pub struct GrantDecision {
    pub approved: Vec<String>,
    pub denied: Vec<String>,
}

impl GrantDecision {
    pub fn all_approved(&self) -> bool {
        self.denied.is_empty()
    }
}

/// The policy inputs the capability grammar decides against. All four are
/// resolved by the gateway (env override + built-in defaults) and passed in, so
/// this crate stays a pure function of caller-supplied data.
pub struct GrantPolicy<'a> {
    /// Scopes approved unconditionally, whatever the requesting app is: the
    /// gateway's reviewed policy list (built-in default or the
    /// `RYU_MARKETPLACE_GRANT_ALLOWLIST` operator override). Matched
    /// case-insensitively against the whole trimmed scope string.
    pub allowlist: &'a [String],
    /// Namespaces that name a **host primitive** rather than an app's own
    /// surface (`model`, `memory`, `sidecar`, `tool`, `mcp`, …). A reserved
    /// namespace can never be claimed by the owner-scoped rule below, no matter
    /// what a manifest calls itself — so `com.evil.memory` cannot self-approve
    /// `memory.read`. Reserved scopes are approvable only via `allowlist`.
    pub reserved_namespaces: &'a [String],
    /// Whether the owner-scoped self-grant rule is active. Operators can turn it
    /// off for a pure-allowlist (pre-grammar) posture. `false` reduces this to
    /// exact allowlist membership.
    pub owner_scoped: bool,
    /// First-party manifest ids that own protected app capability namespaces.
    /// A plugin may self-grant an ordinary app namespace when its id ends in
    /// that namespace, but a protected namespace also requires an exact id
    /// match. This prevents `com.evil.monitors` from squatting on
    /// `@ryu/monitors`'s grants.
    pub protected_owner_ids: &'a [String],
}

/// The **namespace** of a capability scope: the token before the first `:` or
/// `.` separator. `"monitors:crud"` → `"monitors"`, `"model.chat"` → `"model"`.
///
/// Returns `None` for anything the grammar refuses to reason about structurally
/// — no separator, an empty namespace or an empty remainder, a namespace with
/// characters outside `[A-Za-z0-9_-]`, or any embedded whitespace/wildcard. A
/// `None` here never means "approve": it only means the scope cannot be
/// *owner-scoped*, so it falls through to explicit allowlist membership.
pub fn capability_namespace(scope: &str) -> Option<&str> {
    let scope = scope.trim();
    if scope.is_empty() || scope.contains('*') || scope.chars().any(char::is_whitespace) {
        return None;
    }
    let sep = scope.find([':', '.'])?;
    let (namespace, rest) = scope.split_at(sep);
    // `rest` still carries the separator; a scope like `monitors:` (empty
    // remainder) is malformed and must not owner-scope.
    if namespace.is_empty() || rest.len() < 2 {
        return None;
    }
    if !namespace.chars().all(is_ident_char) {
        return None;
    }
    Some(namespace)
}

/// The namespace a plugin **owns**, derived from its manifest id: the last
/// segment, splitting on either separator. `"@ryu/monitors"` → `"monitors"`,
/// `"com.ryu.monitors"` → `"monitors"`, `"rtk"` → `"rtk"`.
///
/// Both separators are honoured because ids come in two shapes: the scoped form
/// (`@scope/name`) and the legacy flat/dotted form that predates it and stays valid
/// forever via the alias map. Splitting on `.` alone would make a scoped id derive
/// its WHOLE string as the namespace (`@ryu/monitors`), which contains `/` and `@`
/// and so fails the ident check below — silently disabling owner-scoped approval for
/// every first-party app and failing their grants closed.
///
/// Returns `None` for a malformed id (empty, trailing dot, whitespace, or a
/// segment with characters outside `[A-Za-z0-9_-]`), which disables owner-scoped
/// approval for that caller — fail-closed.
///
pub fn owner_namespace(app_id: &str) -> Option<&str> {
    let id = app_id.trim();
    if id.is_empty() || id.chars().any(char::is_whitespace) {
        return None;
    }
    let segment = match id.rfind(['.', '/']) {
        Some(sep) => &id[sep + 1..],
        None => id,
    };
    if segment.is_empty() || !segment.chars().all(is_ident_char) {
        return None;
    }
    Some(segment)
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// Validate the requested grants against an explicit allowlist, with no
/// owner-scoped rule. Equivalent to [`validate_grants_for`] with an unknown
/// caller; retained as the crate's original entry point.
pub fn validate_grants(grants: &[String], allowlist: &[String]) -> GrantDecision {
    validate_grants_for(
        None,
        grants,
        &GrantPolicy {
            allowlist,
            reserved_namespaces: &[],
            owner_scoped: false,
            protected_owner_ids: &[],
        },
    )
}

/// Decide the requested grants for `app_id` under the capability grammar,
/// returning `{ approved, denied }`. An empty request approves trivially; empty
/// / whitespace-only scopes are skipped.
///
/// A scope is approved when **either**:
///
///   1. it is on the reviewed `allowlist` (exact, case-insensitive match on the
///      trimmed string) — the host-primitive vocabulary and any operator
///      override; **or**
///   2. it is an **owner-scoped self-grant**: its namespace equals the namespace
///      derived from the caller's own manifest id, and that namespace is not
///      reserved. `@ryu/monitors` declaring `monitors:crud` needs no policy
///      entry — which is what lets a third-party app ship a capability of its
///      own without a Gateway code change.
///
/// Everything else — a namespace belonging to another app, a reserved host
/// primitive that is not allowlisted, a structurally malformed scope, or any
/// scope at all when `app_id` is `None` — is denied. Deny-by-default is
/// unchanged; the grammar only adds rule 2.
pub fn validate_grants_for(
    app_id: Option<&str>,
    grants: &[String],
    policy: &GrantPolicy<'_>,
) -> GrantDecision {
    // Resolved once: the caller's owned namespace, or `None` when the caller is
    // unknown / its id is malformed (both fail closed to allowlist-only).
    let owner = if policy.owner_scoped {
        app_id.and_then(owner_namespace)
    } else {
        None
    };

    let mut approved = Vec::new();
    let mut denied = Vec::new();
    for g in grants {
        let scope = g.trim();
        if scope.is_empty() {
            continue;
        }
        if scope_allowed(scope, app_id, owner, policy) {
            approved.push(scope.to_string());
        } else {
            denied.push(scope.to_string());
        }
    }
    GrantDecision { approved, denied }
}

/// The single-scope decision. Split out so both the allowlist rule and the
/// owner-scoped rule are readable in isolation and testable through the public
/// entry point.
fn scope_allowed(
    scope: &str,
    app_id: Option<&str>,
    owner: Option<&str>,
    policy: &GrantPolicy<'_>,
) -> bool {
    // Rule 1 — reviewed policy. Checked first so an operator override can
    // approve a reserved scope the grammar would otherwise refuse.
    if policy
        .allowlist
        .iter()
        .any(|a| a.eq_ignore_ascii_case(scope))
    {
        return true;
    }
    // Rule 2 — owner-scoped self-grant.
    let Some(owner) = owner else {
        return false;
    };
    let Some(namespace) = capability_namespace(scope) else {
        return false;
    };
    if policy
        .reserved_namespaces
        .iter()
        .any(|r| r.eq_ignore_ascii_case(namespace))
    {
        // A host primitive is never self-granted, even by an app that named
        // itself after it. This is what keeps `sidecar:process`, `model.*`,
        // `memory.*` … exactly as gated as they are today.
        return false;
    }
    if policy.protected_owner_ids.iter().any(|protected_id| {
        owner_namespace(protected_id)
            .is_some_and(|protected| protected.eq_ignore_ascii_case(namespace))
    }) {
        // The caller must be an exact protected id that owns THIS namespace.
        // Membership in the protected list alone is not enough: `@ryu/mail` is
        // first-party, but it does not own `monitors:*`.
        return app_id.is_some_and(|id| {
            policy.protected_owner_ids.iter().any(|protected_id| {
                protected_id.trim().eq_ignore_ascii_case(id.trim())
                    && owner_namespace(protected_id)
                        .is_some_and(|protected| protected.eq_ignore_ascii_case(namespace))
            })
        });
    }
    namespace.eq_ignore_ascii_case(owner)
}

// ── signing ─────────────────────────────────────────────────────────────────

/// Parse a base64-encoded 32-byte ed25519 seed into a signing key.
pub fn signing_key_from_seed(b64: &str) -> Option<SigningKey> {
    let bytes = B64.decode(b64).ok()?;
    let seed: [u8; SECRET_KEY_LENGTH] = bytes.try_into().ok()?;
    Some(SigningKey::from_bytes(&seed))
}

/// Parse a base64-encoded 32-byte ed25519 public key into a verifying key.
/// Returns `None` on malformed base64, wrong length, or an invalid point — the
/// caller then treats a signature as unverifiable (`false`).
pub fn verifying_key_from_b64(b64: &str) -> Option<VerifyingKey> {
    let pk_bytes = B64.decode(b64).ok()?;
    let pk_arr = <[u8; 32]>::try_from(pk_bytes.as_slice()).ok()?;
    VerifyingKey::from_bytes(&pk_arr).ok()
}

/// The base64-encoded form of a verifying key, exposed so clients can pin it.
pub fn public_key_b64(key: &VerifyingKey) -> String {
    B64.encode(key.to_bytes())
}

/// Sign a manifest, returning the base64-encoded ed25519 signature over the
/// canonicalized manifest bytes. The signing key is supplied by the caller (the
/// gateway resolves it from env / dev-persisted disk custody).
pub fn sign_manifest(key: &SigningKey, manifest: &Value) -> String {
    let bytes = canonical_bytes(manifest);
    let sig = key.sign(&bytes);
    B64.encode(sig.to_bytes())
}

/// Verify a base64 signature against a manifest with an *explicit* verifying
/// key. A tampered manifest or a wrong key returns `false`. The gateway wrapper
/// resolves the verifying key (a caller-pinned public key, else the process
/// key) and passes it in.
pub fn verify_manifest(
    manifest: &Value,
    signature_b64: &str,
    verifying_key: &VerifyingKey,
) -> bool {
    let Ok(sig_bytes) = B64.decode(signature_b64) else {
        return false;
    };
    let Ok(sig_arr) = <[u8; 64]>::try_from(sig_bytes.as_slice()) else {
        return false;
    };
    let signature = Signature::from_bytes(&sig_arr);

    let bytes = canonical_bytes(manifest);
    verifying_key.verify(&bytes, &signature).is_ok()
}

/// Canonicalize a JSON value into deterministic bytes: object keys recursively
/// sorted, no insignificant whitespace. This makes the signed representation
/// independent of key ordering introduced by Mongo storage or JSON
/// re-serialization across stacks, so a faithfully-preserved manifest verifies
/// even after a round-trip.
pub fn canonical_bytes(value: &Value) -> Vec<u8> {
    let canonical = canonicalize(value);
    serde_json::to_vec(&canonical).unwrap_or_default()
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sorted: Vec<(&String, &Value)> = map.iter().collect();
            sorted.sort_by(|a, b| a.0.cmp(b.0));
            let mut out = Map::new();
            for (k, v) in sorted {
                out.insert(k.clone(), canonicalize(v));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn tailscale_control_traffic_requires_explicit_operator_grant() {
        let grants = vec!["network:vpn:tailscale".to_owned()];
        let reserved = vec!["network".to_owned()];
        let denied = validate_grants_for(
            Some("com.ryu.cloud-environments"),
            &grants,
            &GrantPolicy {
                allowlist: &[],
                reserved_namespaces: &reserved,
                owner_scoped: true,
                protected_owner_ids: &[],
            },
        );
        assert!(!denied.all_approved());
        let approved = validate_grants_for(
            Some("com.ryu.cloud-environments"),
            &grants,
            &GrantPolicy {
                allowlist: &grants,
                reserved_namespaces: &reserved,
                owner_scoped: true,
                protected_owner_ids: &[],
            },
        );
        assert!(approved.all_approved());
        let squatter = validate_grants_for(
            Some("com.evil.network"),
            &grants,
            &GrantPolicy {
                allowlist: &[],
                reserved_namespaces: &reserved,
                owner_scoped: true,
                protected_owner_ids: &[],
            },
        );
        assert!(!squatter.all_approved());
    }
    use super::*;
    use ed25519_dalek::SigningKey;
    use serde_json::json;

    fn test_key() -> SigningKey {
        // Deterministic in-test key (the gateway owns real key custody).
        SigningKey::from_bytes(&[7u8; 32])
    }

    #[test]
    fn validate_grants_approves_allowlisted() {
        let allow = vec!["mcp.tools".to_string(), "memory.read".to_string()];
        let d = validate_grants(
            &["mcp.tools".to_string(), "memory.read".to_string()],
            &allow,
        );
        assert!(d.all_approved());
        assert_eq!(d.approved.len(), 2);
        assert!(d.denied.is_empty());
    }

    #[test]
    fn validate_grants_denies_unlisted_and_is_case_insensitive() {
        let allow = vec!["mcp.tools".to_string()];
        let d = validate_grants(
            &["MCP.Tools".to_string(), "filesystem.write_all".to_string()],
            &allow,
        );
        assert!(!d.all_approved());
        assert_eq!(d.denied, vec!["filesystem.write_all".to_string()]);
        assert_eq!(d.approved, vec!["MCP.Tools".to_string()]);
    }

    #[test]
    fn validate_grants_skips_empty_scopes() {
        let allow = vec!["mcp.tools".to_string()];
        let d = validate_grants(&["".to_string(), "  ".to_string()], &allow);
        assert!(d.all_approved());
        assert!(d.approved.is_empty());
    }

    // ── capability grammar ───────────────────────────────────────────────────

    fn scopes(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    /// A test policy shaped like the gateway's: a small reviewed allowlist plus
    /// the reserved host-primitive namespaces, owner-scoping on.
    fn policy<'a>(allowlist: &'a [String], reserved: &'a [String]) -> GrantPolicy<'a> {
        GrantPolicy {
            allowlist,
            reserved_namespaces: reserved,
            owner_scoped: true,
            protected_owner_ids: &[],
        }
    }

    fn protected_policy<'a>(
        allowlist: &'a [String],
        reserved: &'a [String],
        protected_owner_ids: &'a [String],
    ) -> GrantPolicy<'a> {
        GrantPolicy {
            allowlist,
            reserved_namespaces: reserved,
            owner_scoped: true,
            protected_owner_ids,
        }
    }

    #[test]
    fn capability_namespace_splits_on_either_separator() {
        assert_eq!(capability_namespace("monitors:crud"), Some("monitors"));
        assert_eq!(capability_namespace("model.chat"), Some("model"));
        // The FIRST separator wins, so a multi-part scope keeps its head token.
        assert_eq!(capability_namespace("tool:command:rtk"), Some("tool"));
        assert_eq!(capability_namespace("chat.sendFollowUp"), Some("chat"));
    }

    #[test]
    fn capability_namespace_rejects_malformed_scopes() {
        assert_eq!(capability_namespace(""), None);
        assert_eq!(capability_namespace("   "), None);
        assert_eq!(capability_namespace("monitors"), None, "no separator");
        assert_eq!(capability_namespace("monitors:"), None, "empty remainder");
        assert_eq!(capability_namespace(":crud"), None, "empty namespace");
        assert_eq!(capability_namespace("moni tors:crud"), None, "whitespace");
        assert_eq!(capability_namespace("*:crud"), None, "wildcard");
        assert_eq!(capability_namespace("moni/tors:crud"), None, "bad char");
    }

    #[test]
    fn owner_namespace_takes_the_last_id_segment() {
        assert_eq!(owner_namespace("@ryu/monitors"), Some("monitors"));
        assert_eq!(owner_namespace("rtk"), Some("rtk"), "unqualified id");
        assert_eq!(owner_namespace("  @ryu/mail  "), Some("mail"), "trimmed");
        assert_eq!(owner_namespace("@ryu/skill-editor"), Some("skill-editor"));
    }

    #[test]
    fn owner_namespace_rejects_malformed_ids() {
        assert_eq!(owner_namespace(""), None);
        assert_eq!(owner_namespace("   "), None);
        assert_eq!(owner_namespace("com.ryu."), None, "trailing dot");
        assert_eq!(owner_namespace("com ryu"), None, "whitespace");
        assert_eq!(owner_namespace("com.ryu.mon:itors"), None, "bad char");
        assert_eq!(owner_namespace("@ryu/"), None, "trailing slash");
    }

    /// Both id shapes must derive the same owner namespace. Splitting on `.` alone
    /// made a scoped id yield its whole string, which fails the ident check and
    /// silently disabled owner-scoped approval for every first-party app.
    #[test]
    fn owner_namespace_handles_scoped_and_legacy_ids_alike() {
        assert_eq!(owner_namespace("@ryu/monitors"), Some("monitors"));
        assert_eq!(owner_namespace("com.ryu.monitors"), Some("monitors"));
        assert_eq!(owner_namespace("rtk"), Some("rtk"));
        assert_eq!(owner_namespace("@acme/weather-app"), Some("weather-app"));
    }

    #[test]
    fn owner_scoped_self_grant_is_approved_without_an_allowlist_entry() {
        // The whole point of the grammar: a third-party app declaring a
        // capability in its OWN namespace enables with no Gateway edit.
        let reserved = scopes(&["model", "memory", "sidecar"]);
        let d = validate_grants_for(
            Some("com.acme.notes"),
            &scopes(&["notes:crud", "notes:export"]),
            &policy(&[], &reserved),
        );
        assert!(d.all_approved(), "denied: {:?}", d.denied);
        assert_eq!(d.approved.len(), 2);
    }

    #[test]
    fn cross_app_namespace_is_denied() {
        let reserved = scopes(&["model"]);
        let d = validate_grants_for(
            Some("com.acme.notes"),
            &scopes(&["notes:crud", "monitors:crud"]),
            &policy(&[], &reserved),
        );
        assert_eq!(d.approved, vec!["notes:crud".to_string()]);
        assert_eq!(d.denied, vec!["monitors:crud".to_string()]);
    }

    #[test]
    fn spoofed_id_cannot_claim_another_apps_namespace() {
        // The named spoofing case: an app that is not `@ryu/monitors` must
        // not self-approve `monitors:crud`, however it dresses up its id.
        let reserved = scopes(&["model"]);
        for id in [
            "com.ryu.evil",
            "monitors.evil",
            "@ryu/monitors.evil",
            "evil-monitors",
            "@ryu/monitorsx",
        ] {
            let d = validate_grants_for(
                Some(id),
                &scopes(&["monitors:crud"]),
                &policy(&[], &reserved),
            );
            assert_eq!(
                d.denied,
                vec!["monitors:crud".to_string()],
                "'{id}' must not self-approve another app's namespace"
            );
        }
    }

    #[test]
    fn protected_owner_namespace_requires_exact_first_party_id() {
        let reserved = scopes(&["model"]);
        let protected = scopes(&["@ryu/monitors", "com.ryu.monitors"]);
        let policy = protected_policy(&[], &reserved, &protected);

        for id in ["@ryu/monitors", "com.ryu.monitors"] {
            let decision = validate_grants_for(Some(id), &scopes(&["monitors:crud"]), &policy);
            assert!(
                decision.all_approved(),
                "{id} should own the protected scope"
            );
        }

        for id in ["com.evil.monitors", "monitors", "@evil/monitors"] {
            let decision = validate_grants_for(Some(id), &scopes(&["monitors:crud"]), &policy);
            assert_eq!(
                decision.denied,
                vec!["monitors:crud".to_string()],
                "{id} must not squat on a protected namespace"
            );
        }

        let third_party =
            validate_grants_for(Some("com.acme.notes"), &scopes(&["notes:crud"]), &policy);
        assert!(third_party.all_approved());
    }

    #[test]
    fn protected_namespace_requires_its_own_owner_not_any_protected_id() {
        let reserved = scopes(&["model"]);
        let protected = scopes(&[
            "@ryu/monitors",
            "com.ryu.monitors",
            "@ryu/mail",
            "com.ryu.mail",
        ]);
        let policy = protected_policy(&[], &reserved, &protected);

        // Another first-party id is protected too, but it does not own `monitors`.
        for id in ["@ryu/mail", "com.ryu.mail"] {
            let decision = validate_grants_for(Some(id), &scopes(&["monitors:jobs"]), &policy);
            assert_eq!(
                decision.denied,
                vec!["monitors:jobs".to_string()],
                "{id} must not claim another protected owner's namespace"
            );
        }

        let owner = validate_grants_for(Some("@ryu/mail"), &scopes(&["mail:crud"]), &policy);
        assert!(owner.all_approved(), "denied: {:?}", owner.denied);
    }

    #[test]
    fn safe_actions_protected_namespace_requires_exact_first_party_id() {
        let reserved = scopes(&["model"]);
        let protected = scopes(&["@ryu/safe-actions", "com.ryu.safe-actions"]);
        let policy = protected_policy(&[], &reserved, &protected);

        for id in ["@ryu/safe-actions", "com.ryu.safe-actions"] {
            let decision =
                validate_grants_for(Some(id), &scopes(&["safe-actions:manage"]), &policy);
            assert!(
                decision.all_approved(),
                "{id} denied: {:?}",
                decision.denied
            );
        }

        for id in [
            "com.evil.safe-actions",
            "@evil/safe-actions",
            "safe-actions",
        ] {
            let decision =
                validate_grants_for(Some(id), &scopes(&["safe-actions:manage"]), &policy);
            assert_eq!(
                decision.denied,
                vec!["safe-actions:manage".to_string()],
                "{id} must not squat on Safe Actions' namespace"
            );
        }
    }

    #[test]
    fn reserved_namespace_is_never_owner_scoped() {
        // An app that names itself after a host primitive still cannot
        // self-grant it — `sidecar:process` above all (arbitrary code
        // execution), which is on no default allowlist.
        let reserved = scopes(&["sidecar", "memory", "model", "tool", "mcp"]);
        let d = validate_grants_for(
            Some("com.evil.sidecar"),
            &scopes(&["sidecar:process"]),
            &policy(&[], &reserved),
        );
        assert_eq!(d.denied, vec!["sidecar:process".to_string()]);

        let d = validate_grants_for(
            Some("com.evil.memory"),
            &scopes(&["memory.read"]),
            &policy(&[], &reserved),
        );
        assert_eq!(d.denied, vec!["memory.read".to_string()]);

        let d = validate_grants_for(
            Some("com.evil.tool"),
            &scopes(&["tool:command:rm"]),
            &policy(&[], &reserved),
        );
        assert_eq!(d.denied, vec!["tool:command:rm".to_string()]);
    }

    #[test]
    fn allowlist_still_approves_reserved_host_primitives() {
        // Rule 1 is unchanged: a reviewed host-primitive scope is approved for
        // any caller, which is how first-party apps hold `hook:*`, `mcp:*`, …
        let reserved = scopes(&["hook", "mcp"]);
        let allow = scopes(&["hook:side-model", "mcp:ghost"]);
        let d = validate_grants_for(
            Some("@ryu/advisor"),
            &scopes(&["hook:side-model"]),
            &policy(&allow, &reserved),
        );
        assert!(d.all_approved());
    }

    #[test]
    fn unknown_caller_falls_back_to_allowlist_only() {
        // No `app_id` ⇒ no owner namespace ⇒ pre-grammar behavior. Fail-closed.
        let reserved = scopes(&["model"]);
        let allow = scopes(&["model.chat"]);
        let d = validate_grants_for(
            None,
            &scopes(&["model.chat", "notes:crud"]),
            &policy(&allow, &reserved),
        );
        assert_eq!(d.approved, vec!["model.chat".to_string()]);
        assert_eq!(d.denied, vec!["notes:crud".to_string()]);
    }

    #[test]
    fn malformed_caller_id_disables_owner_scoping() {
        let reserved = scopes(&["model"]);
        for id in ["", "   ", "com.acme.", "com acme"] {
            let d = validate_grants_for(Some(id), &scopes(&["acme:crud"]), &policy(&[], &reserved));
            assert_eq!(
                d.denied,
                vec!["acme:crud".to_string()],
                "malformed id '{id}' must not owner-scope"
            );
        }
    }

    #[test]
    fn malformed_scope_is_denied_not_owner_scoped() {
        let reserved = scopes(&["model"]);
        // A bare namespace, an empty remainder, and a wildcard are all denied
        // for an app that owns the namespace — the grammar needs `<ns><sep><rest>`.
        let d = validate_grants_for(
            Some("com.acme.notes"),
            &scopes(&["notes", "notes:", "notes:*", "notes crud"]),
            &policy(&[], &reserved),
        );
        assert!(d.approved.is_empty(), "approved: {:?}", d.approved);
        assert_eq!(d.denied.len(), 4);
    }

    #[test]
    fn grammar_matching_is_case_insensitive_on_both_sides() {
        let reserved = scopes(&["Model"]);
        let allow = scopes(&["Model.Chat"]);
        let d = validate_grants_for(
            Some("COM.Acme.Notes"),
            &scopes(&["NOTES:crud", "model.chat"]),
            &policy(&allow, &reserved),
        );
        assert!(d.all_approved(), "denied: {:?}", d.denied);
        // The response echoes the requested spelling, not a normalized one.
        assert_eq!(
            d.approved,
            vec!["NOTES:crud".to_string(), "model.chat".to_string()]
        );

        // Case-folding does not open the reserved gate either.
        let d = validate_grants_for(
            Some("com.evil.MODEL"),
            &scopes(&["MODEL.embed"]),
            &policy(&[], &reserved),
        );
        assert_eq!(d.denied, vec!["MODEL.embed".to_string()]);
    }

    #[test]
    fn owner_scoping_can_be_turned_off_for_a_pure_allowlist_posture() {
        let reserved = scopes(&["model"]);
        let strict = GrantPolicy {
            allowlist: &[],
            reserved_namespaces: &reserved,
            owner_scoped: false,
            protected_owner_ids: &[],
        };
        let d = validate_grants_for(Some("com.acme.notes"), &scopes(&["notes:crud"]), &strict);
        assert_eq!(d.denied, vec!["notes:crud".to_string()]);
    }

    #[test]
    fn empty_and_whitespace_scopes_are_skipped_under_the_grammar() {
        let d = validate_grants_for(
            Some("com.acme.notes"),
            &scopes(&["", "   "]),
            &policy(&[], &[]),
        );
        assert!(d.all_approved());
        assert!(d.approved.is_empty());
    }

    #[test]
    fn sign_then_verify_roundtrips() {
        let key = test_key();
        let manifest = json!({"id": "acme/widget", "version": "1.0.0", "grants": ["mcp.tools"]});
        let sig = sign_manifest(&key, &manifest);
        assert!(verify_manifest(&manifest, &sig, &key.verifying_key()));
    }

    #[test]
    fn verify_is_order_independent() {
        // Same content, different key order — must still verify (canonicalized).
        let key = test_key();
        let a = json!({"id": "x", "version": "1.0.0", "nested": {"b": 2, "a": 1}});
        let b = json!({"version": "1.0.0", "nested": {"a": 1, "b": 2}, "id": "x"});
        let sig = sign_manifest(&key, &a);
        assert!(verify_manifest(&b, &sig, &key.verifying_key()));
    }

    #[test]
    fn tampered_manifest_fails_verify() {
        let key = test_key();
        let manifest = json!({"id": "acme/widget", "version": "1.0.0"});
        let sig = sign_manifest(&key, &manifest);
        let tampered = json!({"id": "acme/widget", "version": "9.9.9"});
        assert!(!verify_manifest(&tampered, &sig, &key.verifying_key()));
    }

    #[test]
    fn wrong_key_fails_verify() {
        let key = test_key();
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let manifest = json!({"id": "x"});
        let sig = sign_manifest(&key, &manifest);
        assert!(!verify_manifest(&manifest, &sig, &other.verifying_key()));
    }

    #[test]
    fn malformed_signature_fails_verify() {
        let key = test_key();
        let manifest = json!({"id": "x"});
        assert!(!verify_manifest(
            &manifest,
            "not-base64!!!",
            &key.verifying_key()
        ));
        assert!(!verify_manifest(
            &manifest,
            &B64.encode([0u8; 10]),
            &key.verifying_key()
        ));
    }

    #[test]
    fn seed_roundtrip_parses() {
        let seed = [7u8; 32];
        let b64 = B64.encode(seed);
        assert!(signing_key_from_seed(&b64).is_some());
        assert!(signing_key_from_seed("not-base64!!!").is_none());
        // Wrong length is rejected.
        assert!(signing_key_from_seed(&B64.encode([0u8; 16])).is_none());
    }

    #[test]
    fn verifying_key_from_b64_parses_and_rejects_malformed() {
        let key = test_key();
        let pk = public_key_b64(&key.verifying_key());
        assert!(verifying_key_from_b64(&pk).is_some());
        assert!(verifying_key_from_b64("not-base64!!!").is_none());
        assert!(verifying_key_from_b64(&B64.encode([0u8; 16])).is_none());
    }

    #[test]
    fn public_key_b64_roundtrips_through_verifying_key_from_b64() {
        let key = test_key();
        let pk = public_key_b64(&key.verifying_key());
        let parsed = verifying_key_from_b64(&pk).expect("parse pubkey");
        assert_eq!(parsed.to_bytes(), key.verifying_key().to_bytes());
    }
}
