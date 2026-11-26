//! Marketplace governance: grant validation + manifest signing (#468, ties #450).
//!
//! CLAUDE.md §1 places "what is allowed/shared/measured/paid for" in the
//! Gateway. Publishing an App to the Ryu Marketplace is a *governed* action, so
//! the two governance primitives it needs live here, reached over HTTP by the
//! control-plane server (publish) and by Core (verify-on-install):
//!
//!   - **Grant validation** (`validate_grants_for`): the manifest declares the
//!     permission grants it wants (tool/capability scopes). The Gateway checks
//!     them against its grant policy and returns `{ approved, denied }`. A
//!     non-empty `denied` blocks publish. This fills the seam Core's plugin
//!     lifecycle already calls (`POST /v1/grants/validate`,
//!     `apps/core/src/plugins/lifecycle.rs`), which until now only had a
//!     `RYU_STUB_GRANT_VALIDATION` allow-all stub on the Core side.
//!
//! **The capability grammar (replaces the per-app allowlist).** Grant policy
//! used to be a single hand-maintained list of every capability string any
//! first-party app declared — `monitors:crud`, `workflows:crud`,
//! `simulator:control`, … — matched by exact string. That list grew by one entry
//! per shipped app, and a **third-party** app declaring its own capability could
//! be installed but never enabled (Core aborts enable with `GrantsDenied`)
//! without an operator setting `RYU_MARKETPLACE_GRANT_ALLOWLIST`. Every new app
//! meant a Gateway Rust edit, which is exactly what `AGENTS.md` forbids.
//!
//! The policy is now two rules, evaluated per scope (see
//! [`ryu_gw_governance::validate_grants_for`]):
//!
//!   1. **Reviewed allowlist** — [`default_grant_allowlist`], or the
//!      `RYU_MARKETPLACE_GRANT_ALLOWLIST` operator override. This is now
//!      *host-primitive vocabulary* (`model.*`, `memory.*`, `mcp:*`,
//!      `tool:command:*`, `hook:*`, `widget:render`, …), not per-app strings, so
//!      it does not grow when an app ships.
//!   2. **Owner-scoped self-grant** — a plugin declaring a capability in its own
//!      namespace (the last dot-segment of its manifest id: `@ryu/monitors` ⇒
//!      `monitors:*`) is approved with no policy entry at all. This is what
//!      unblocks a third-party marketplace.
//!
//! [`reserved_namespaces`] is the fence between them: a namespace naming a host
//! primitive can never be claimed by rule 2, so `com.evil.memory` cannot
//! self-approve `memory.read` and `sidecar:process` (arbitrary code execution)
//! stays unapprovable by any rule. Nothing in the privileged set got more
//! permissive; only app-owned namespaces did.
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

use ryu_gw_governance::{signing_key_from_seed, verifying_key_from_b64, GrantPolicy};
pub use ryu_gw_governance::{GrantDecision, SIGNING_ALGORITHM};

use owner_exclusive::owner_exclusive_grants;
#[cfg(test)]
use owner_exclusive::*;
use reserved_namespaces::reserved_namespaces;
#[cfg(test)]
use signing::*;
pub use signing::{public_key_b64, sign_manifest, verify_manifest};

/// Env var holding the ed25519 signing seed (32-byte secret), base64-encoded.
/// The production source of truth: set it and every gateway replica signs with
/// the same key, so signatures survive restarts and horizontal scale. When
/// unset the Gateway falls back to a **dev-persisted** key on disk (see
/// [`signing_key`]) so signatures still survive a local restart. No secret is
/// ever in code.
const ENV_SIGNING_KEY: &str = "RYU_MARKETPLACE_SIGNING_KEY";

/// Optional override for the on-disk dev-persisted signing key path. When unset
/// the key lives in the gateway's `secrets/` slot (see `signing_key_path`).
/// Only consulted when `ENV_SIGNING_KEY` is
/// unset. No secret is ever in code.
const ENV_SIGNING_KEY_PATH: &str = "RYU_MARKETPLACE_SIGNING_KEY_PATH";

/// Env var holding a comma/whitespace-separated allowlist of permission grants
/// the marketplace will approve. When unset a sensible built-in default
/// allowlist is used (see [`default_grant_allowlist`]). A grant that is neither
/// on the allowlist nor an owner-scoped self-grant is denied, which blocks
/// publish (and, on Core's side, enable).
const ENV_GRANT_ALLOWLIST: &str = "RYU_MARKETPLACE_GRANT_ALLOWLIST";

/// Escape hatch back to the pre-grammar posture: set to `0`/`false`/`no` and the
/// owner-scoped self-grant rule is switched off entirely, so ONLY the allowlist
/// (built-in or `RYU_MARKETPLACE_GRANT_ALLOWLIST`) approves anything. For an
/// operator who wants a hand-curated, closed capability set on a locked-down
/// deployment. Default on.
const ENV_OWNER_SCOPED_GRANTS: &str = "RYU_MARKETPLACE_OWNER_SCOPED_GRANTS";

/// Built-in default grant allowlist: the **host-primitive vocabulary** a plugin
/// may hold. Every scope here is either in a [`reserved_namespaces`] family (so
/// the grammar refuses to self-approve it) or a cross-app capability a
/// first-party app legitimately holds. Anything outside this set is denied
/// unless it is an owner-scoped self-grant, so an over-privileged manifest
/// cannot publish.
///
/// **What is deliberately NOT here.** The per-app companion capabilities
/// (`monitors:crud`, `simulator:control`, `webhooks:crud`,
/// `activity:read`, `timeline:read`, `calendar:crud`, `learning:crud`,
/// `approvals:crud`, `meetings:crud`, `finetune:runs`) used to be
/// listed one-by-one, which meant every new App — including a third-party one —
/// needed a Gateway Rust edit before it could ever be enabled. They are now
/// approved by the owner-scoped rule in
/// [`ryu_gw_governance::validate_grants_for`] because each is declared by the
/// app whose id ends in the same namespace segment (`@ryu/monitors` ⇒
/// `monitors:*`). Do not re-add per-app strings here: if a first-party app's
/// capability is denied, either its namespace does not match its id (rename one
/// of them) or the capability is genuinely a host primitive and belongs in
/// [`reserved_namespaces`] plus this list.
fn default_grant_allowlist() -> Vec<String> {
    let mut grants = default_allowlist_tools::tool_and_data_scopes();
    grants.extend(default_allowlist_host::host_capability_scopes());
    grants
}

/// Parse the `RYU_MARKETPLACE_GRANT_ALLOWLIST` value into an allowlist.
/// `None` for an unset/blank value (the caller then uses the built-in default).
/// Split out of [`grant_allowlist`] so the override semantics are testable
/// without going through the process-wide `OnceLock`.
fn parse_grant_allowlist_env(raw: &str) -> Option<Vec<String>> {
    if raw.trim().is_empty() {
        return None;
    }
    Some(
        raw.split([',', ' ', '\n', '\t'])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

/// Resolve the active grant allowlist from env, falling back to the built-in
/// default. Cached for the process lifetime.
fn grant_allowlist() -> &'static Vec<String> {
    static ALLOWLIST: OnceLock<Vec<String>> = OnceLock::new();
    ALLOWLIST.get_or_init(|| {
        std::env::var(ENV_GRANT_ALLOWLIST)
            .ok()
            .and_then(|raw| parse_grant_allowlist_env(&raw))
            .unwrap_or_else(default_grant_allowlist)
    })
}

/// The reserved host-primitive namespace vocabulary, cached for the process
/// lifetime. Not env-configurable: loosening it is a code review, not an
/// operator toggle — an operator who needs a reserved scope approved adds the
/// exact scope to `RYU_MARKETPLACE_GRANT_ALLOWLIST`, which is explicit and
/// auditable, rather than un-reserving a whole family.
fn reserved_namespace_list() -> &'static Vec<String> {
    static RESERVED: OnceLock<Vec<String>> = OnceLock::new();
    RESERVED.get_or_init(reserved_namespaces)
}

/// First-party app ids whose capability namespaces are protected from
/// same-segment squatting. Keep both the current scoped ids and the legacy ids
/// accepted by the marketplace alias map so either spelling remains an exact
/// owner, while `com.evil.<name>` is not.
fn protected_owner_id_list() -> &'static Vec<String> {
    static PROTECTED: OnceLock<Vec<String>> = OnceLock::new();
    PROTECTED.get_or_init(|| {
        [
            "monitors",
            "mail",
            "finetune",
            "activity",
            "timeline",
            "calendar",
            "learning",
            "approvals",
            "meetings",
            "simulator",
            "webhooks",
            "drafts",
            "social",
            "crm",
            "workflows",
            "safe-actions",
            // First-party capability providers (`provides[].grant` in
            // `apps-store/<name>/manifest.json`). Core's capability broker gates a
            // provided capability only on the caller holding the grant, so an
            // unprotected namespace would let `@evil/teams` self-grant
            // `teams:manage`. `every_first_party_provided_grant_namespace_is_protected`
            // fails when a new provider is not listed here.
            "teams",
            "dashboards",
            "news",
            "reasoning",
            "rlm",
            "tuition",
            "blueprint",
            // First-party owners of host-API grants (`host-api.json`) the
            // desktop forwards with the owner node token: `subtitles:crud`,
            // `background:control`, `voice:models:manage`. Guarded by
            // `every_host_api_grant_namespace_is_squat_proof`.
            "subtitles",
            "background",
            "voice",
        ]
        .into_iter()
        .flat_map(|name| [format!("@ryu/{name}"), format!("com.ryu.{name}")])
        .collect()
    })
}

/// Whether the owner-scoped self-grant rule is active (default `true`; see
/// [`ENV_OWNER_SCOPED_GRANTS`]). Cached for the process lifetime.
fn owner_scoped_grants_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var(ENV_OWNER_SCOPED_GRANTS)
            .map(|raw| parse_owner_scoped_env(&raw))
            .unwrap_or(true)
    })
}

/// Parse the `RYU_MARKETPLACE_OWNER_SCOPED_GRANTS` value. Anything that is not
/// an explicit off-word leaves owner-scoping on, so a typo cannot silently
/// disable app enablement across the fleet. Split out for the same
/// `OnceLock`-free testability reason as [`parse_grant_allowlist_env`].
fn parse_owner_scoped_env(raw: &str) -> bool {
    !matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "0" | "false" | "no" | "off"
    )
}

/// Resolve the gateway's active grant policy: the allowlist (env override or
/// built-in default), the reserved host-primitive vocabulary, and whether
/// owner-scoping is on.
fn grant_policy() -> GrantPolicy<'static> {
    GrantPolicy {
        allowlist: grant_allowlist(),
        reserved_namespaces: reserved_namespace_list(),
        owner_scoped: owner_scoped_grants_enabled(),
        protected_owner_ids: protected_owner_id_list(),
    }
}

/// Validate the grants `app_id` requests, under the gateway's active policy.
/// Delegates the grammar to [`ryu_gw_governance::validate_grants_for`]: a scope
/// is approved when it is on the reviewed allowlist **or** it is an owner-scoped
/// self-grant (its namespace equals the last segment of the requesting app's id
/// and that namespace is not a reserved host primitive).
///
/// `app_id` is `None` when the caller did not identify itself, which disables
/// owner-scoping for the request — fail-closed to the pre-grammar behavior.
pub fn validate_grants_for(app_id: Option<&str>, grants: &[String]) -> GrantDecision {
    let decision = validate_general_grants_for(app_id, grants);
    // Per-target cross-app grants (`app:http:<target>`) are decided here, not by
    // the general grammar: a malformed target (wildcard, unscoped id, anything
    // but one concrete `@scope/name`) is denied even if an operator allowlist
    // names it, and a well-formed one is approved only by exact membership in the
    // operator allowlist or in the caller's own reviewed owner-exclusive rows.
    let reviewed_for_caller = app_id.map(owner_exclusive_grants).unwrap_or_default();
    let mut approved = Vec::new();
    let mut denied = Vec::new();
    for grant in grants {
        let scope = grant.trim();
        if scope.is_empty() {
            continue;
        }
        let allowed = if is_app_http_target_grant(scope) {
            app_http_target_grant_well_formed(scope)
                && (grant_allowlist().iter().any(|entry| entry.trim() == scope)
                    || reviewed_for_caller.iter().any(|held| *held == scope))
        } else {
            decision.approved.iter().any(|a| a == scope)
        };
        if allowed {
            approved.push(scope.to_owned());
        } else {
            denied.push(scope.to_owned());
        }
    }
    GrantDecision { approved, denied }
}

/// Prefix of a per-target cross-app request grant.
const APP_HTTP_TARGET_PREFIX: &str = "app:http:";

/// Whether `scope` is shaped as a per-target cross-app grant at all (any case),
/// so it is routed to [`app_http_target_grant_well_formed`] and never to the
/// general grammar.
fn is_app_http_target_grant(scope: &str) -> bool {
    scope
        .get(..APP_HTTP_TARGET_PREFIX.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(APP_HTTP_TARGET_PREFIX))
}

/// The accepted form of a per-target grant: `app:http:@scope/name`, lowercase,
/// one concrete scoped app id (`[a-z0-9][a-z0-9-]*` scope, `[a-z0-9][a-z0-9._-]*`
/// name). No wildcard, no flat or dotted legacy id, no extra segment.
fn app_http_target_grant_well_formed(scope: &str) -> bool {
    let Some(target) = scope.strip_prefix(APP_HTTP_TARGET_PREFIX) else {
        return false;
    };
    let Some((owner, name)) = target
        .strip_prefix('@')
        .and_then(|rest| rest.split_once('/'))
    else {
        return false;
    };
    let segment = |s: &str, extra: &[char]| {
        s.len() <= 214
            && s.chars()
                .next()
                .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            && s.chars().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || extra.contains(&c)
            })
    };
    segment(owner, &[]) && segment(name, &['.', '_'])
}

/// The general capability grammar (allowlist + owner-scoped + owner-exclusive).
fn validate_general_grants_for(app_id: Option<&str>, grants: &[String]) -> GrantDecision {
    let extra = app_id.map(owner_exclusive_grants).unwrap_or_default();
    if extra.is_empty() {
        return ryu_gw_governance::validate_grants_for(app_id, grants, &grant_policy());
    }
    let mut allowlist = grant_allowlist().clone();
    allowlist.extend(extra.iter().map(|grant| (*grant).to_owned()));
    let policy = GrantPolicy {
        allowlist: &allowlist,
        reserved_namespaces: reserved_namespace_list(),
        owner_scoped: owner_scoped_grants_enabled(),
        protected_owner_ids: protected_owner_id_list(),
    };
    ryu_gw_governance::validate_grants_for(app_id, grants, &policy)
}

mod crossapp_grants;
mod default_allowlist_host;
mod default_allowlist_tools;
mod loopback_egress;
mod mounted_app_grants;
mod owner_exclusive;
mod reserved_namespaces;
mod signing;

#[cfg(test)]
mod command_grant_tests;
#[cfg(test)]
mod crossapp_grant_tests;
#[cfg(test)]
mod host_grant_namespace_tests;
#[cfg(test)]
mod loopback_egress_tests;
#[cfg(test)]
mod module_layout_tests;
#[cfg(test)]
mod mounted_app_grants_tests;
#[cfg(test)]
mod skills_grant_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod workflow_grant_tests;
