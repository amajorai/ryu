//! Vault path policies.
//!
//! A policy is a named list of rules. Each rule matches a path key
//! `ENV/folder/NAME` with a glob (`*` = exactly one segment, `**` = zero or
//! more segments, `?` = one character inside a segment) and grants or denies a
//! set of capabilities. Policies are attached to subjects (`user:<id>`,
//! `team:<id>`, `role:<name>`, `machine:<id>`) by bindings that may expire,
//! which is how temporary access works.
//!
//! Evaluation is `(baseline ∪ allowed) − denied`: an explicit deny from any
//! bound policy wins over every allow, including the built-in baseline grants
//! that preserve Ryu's pre-policy behavior. The TypeScript control plane runs
//! the same algorithm against `apps/core/tests/fixtures/vault-policy-cases.json`.
//!
//! Rules may also carry identity templates, request-parameter constraints, and
//! control groups; see [`super::policy_ext`]. A rule may require a wrapped
//! response on the vault HTTP API; see [`wrap_requirement`].

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::now_millis;
use super::policy_ext::{ControlGroupSpec, TemplateContext};

pub mod wrap_requirement;

/// Maximum rules per policy.
pub const MAX_RULES: usize = 64;
/// Maximum glob length.
pub const MAX_GLOB_LEN: usize = 256;

/// One vault capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    /// See that a value exists (metadata only).
    List,
    /// Resolve a value at tool-dispatch time.
    Use,
    /// Reveal or export a plaintext value.
    Read,
    /// Create, update, rollback, or restore a value.
    Write,
    /// Soft-delete or destroy a value.
    Delete,
    /// Manage policies, environments, imports, and engines.
    Admin,
    /// Approve change requests in protected environments.
    Approve,
}

impl Capability {
    pub const ALL: [Capability; 7] = [
        Self::List,
        Self::Use,
        Self::Read,
        Self::Write,
        Self::Delete,
        Self::Admin,
        Self::Approve,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Use => "use",
            Self::Read => "read",
            Self::Write => "write",
            Self::Delete => "delete",
            Self::Admin => "admin",
            Self::Approve => "approve",
        }
    }
}

/// A set of capabilities.
pub type CapabilitySet = BTreeSet<Capability>;

/// One policy rule.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRule {
    /// Glob over `ENV/folder/NAME`; may contain `{{identity.*}}` templates.
    pub path: String,
    pub capabilities: Vec<Capability>,
    #[serde(default)]
    pub deny: bool,
    /// Parameters a `write` may carry (name or `*` → allowed value globs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_parameters: Option<BTreeMap<String, Vec<String>>>,
    /// Parameters (or values) a `write` must not carry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub denied_parameters: Option<BTreeMap<String, Vec<String>>>,
    /// Parameters a `write` must carry.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_parameters: Vec<String>,
    /// Approvals required before a `read` releases a value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_group: Option<ControlGroupSpec>,
    /// Shortest response-wrapping TTL (seconds) a vault API request using
    /// this rule's capabilities must ask for; set means wrapping is required.
    #[serde(
        default,
        alias = "minWrappingTtl",
        alias = "min_wrapping_ttl",
        deserialize_with = "wrap_requirement::deserialize_ttl",
        skip_serializing_if = "Option::is_none"
    )]
    pub min_wrapping_ttl_secs: Option<i64>,
    /// Longest response-wrapping TTL (seconds) such a request may ask for.
    #[serde(
        default,
        alias = "maxWrappingTtl",
        alias = "max_wrapping_ttl",
        deserialize_with = "wrap_requirement::deserialize_ttl",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_wrapping_ttl_secs: Option<i64>,
}

/// A stored policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub rules: Vec<PolicyRule>,
}

/// A policy attachment to one subject.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyBinding {
    pub id: String,
    pub policy: String,
    /// `user:<id>`, `team:<id>`, `role:<name>`, or `machine:<id>`.
    pub subject: String,
    /// Epoch millis after which the binding is ignored (temporary access).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

/// Validate a subject string.
pub fn is_valid_subject(subject: &str) -> bool {
    let Some((kind, id)) = subject.split_once(':') else {
        return false;
    };
    matches!(kind, "user" | "team" | "role" | "machine")
        && crate::plugin_secrets::is_valid_scope_id(id)
}

/// Validate a policy definition.
pub fn validate(policy: &Policy) -> Result<()> {
    if !is_valid_policy_name(&policy.name) {
        bail!("policy name must be 1-64 characters of [a-z0-9_-]");
    }
    if policy.description.len() > 512 {
        bail!("policy description is too long");
    }
    if policy.rules.is_empty() || policy.rules.len() > MAX_RULES {
        bail!("a policy needs between 1 and {MAX_RULES} rules");
    }
    for rule in &policy.rules {
        if rule.path.is_empty() || rule.path.len() > MAX_GLOB_LEN {
            bail!("rule path is empty or too long");
        }
        if rule
            .path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "..")
        {
            bail!(
                "rule path `{}` has an empty or traversal segment",
                rule.path
            );
        }
        if rule.capabilities.is_empty() {
            bail!("rule `{}` grants no capabilities", rule.path);
        }
        super::policy_ext::validate_rule(rule)?;
        wrap_requirement::validate_rule(rule)?;
    }
    Ok(())
}

/// Policy names: `^[a-z0-9_-]{1,64}$`.
pub fn is_valid_policy_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn segment_matches(pattern: &[u8], text: &[u8]) -> bool {
    // Classic iterative wildcard match for `*` (any run) and `?` (one char)
    // inside a single path segment.
    let (mut p, mut t) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            mark = t;
            p += 1;
        } else if let Some(s) = star {
            p = s + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

/// Whether single-segment wildcard `pattern` (`*`, `?`) matches all of `text`.
pub fn wildcard_matches(pattern: &str, text: &str) -> bool {
    segment_matches(pattern.as_bytes(), text.as_bytes())
}

fn segments_match(pattern: &[&str], path: &[&str]) -> bool {
    match pattern.split_first() {
        None => path.is_empty(),
        Some((&"**", rest)) => (0..=path.len()).any(|skip| segments_match(rest, &path[skip..])),
        Some((head, rest)) => match path.split_first() {
            Some((segment, path_rest)) => {
                segment_matches(head.as_bytes(), segment.as_bytes())
                    && segments_match(rest, path_rest)
            }
            None => false,
        },
    }
}

/// Whether glob `pattern` matches path key `path`.
pub fn glob_matches(pattern: &str, path: &str) -> bool {
    let pattern: Vec<&str> = pattern.split('/').collect();
    let path: Vec<&str> = path.split('/').collect();
    segments_match(&pattern, &path)
}

/// Whether glob `pattern` matches `prefix/NAME` for at least one single
/// segment `NAME`: a folder-level pre-check used before the folder's keys are
/// looked up, so authorization never depends on what exists.
pub fn may_match_child(pattern: &str, prefix: &str) -> bool {
    fn walk(pattern: &[&str], path: &[&str], child: bool) -> bool {
        match pattern.split_first() {
            None => path.is_empty() && !child,
            Some((&"**", rest)) => {
                (0..=path.len()).any(|skip| walk(rest, &path[skip..], child))
                    || (child && walk(rest, &[], false))
            }
            Some((head, rest)) => match path.split_first() {
                Some((segment, path_rest)) => {
                    segment_matches(head.as_bytes(), segment.as_bytes())
                        && walk(rest, path_rest, child)
                }
                // The unknown child segment: any non-empty pattern segment
                // matches some name.
                None if child => !head.is_empty() && walk(rest, &[], false),
                None => false,
            },
        }
    }
    let pattern: Vec<&str> = pattern.split('/').collect();
    let path: Vec<&str> = prefix.split('/').collect();
    walk(&pattern, &path, true)
}

/// Evaluate `policies` for `path` on top of `baseline` with no identity:
/// templated allow rules do not apply and templated deny rules are widened.
pub fn evaluate<'a>(
    baseline: &CapabilitySet,
    policies: impl IntoIterator<Item = &'a Policy>,
    path: &str,
) -> CapabilitySet {
    evaluate_with(baseline, policies, path, &TemplateContext::default())
}

/// Evaluate `policies` for `path` on top of `baseline`, expanding identity
/// templates against `context`. Inside a vault API request
/// ([`wrap_requirement::scope`]), a capability that a matching rule requires a
/// wrapped response for is dropped unless the request's wrap TTL satisfies it.
pub fn evaluate_with<'a>(
    baseline: &CapabilitySet,
    policies: impl IntoIterator<Item = &'a Policy>,
    path: &str,
    context: &TemplateContext,
) -> CapabilitySet {
    let mut allowed = baseline.clone();
    let mut denied = CapabilitySet::new();
    let mut wrapping = wrap_requirement::Requirements::default();
    for policy in policies {
        for rule in &policy.rules {
            if !super::policy_ext::rule_matches(rule, path, context) {
                continue;
            }
            let target = if rule.deny { &mut denied } else { &mut allowed };
            target.extend(rule.capabilities.iter().copied());
            wrapping.add(rule);
        }
    }
    allowed.retain(|capability| !denied.contains(capability));
    wrapping.enforce(path, &mut allowed);
    allowed
}

// ── Storage ────────────────────────────────────────────────────────────────

/// Create the policy tables. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_policies (
             name        TEXT PRIMARY KEY,
             description TEXT NOT NULL DEFAULT '',
             rules       TEXT NOT NULL,
             created_at  INTEGER NOT NULL,
             updated_at  INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS vault_policy_bindings (
             id          TEXT PRIMARY KEY,
             policy      TEXT NOT NULL REFERENCES vault_policies(name) ON DELETE CASCADE,
             subject     TEXT NOT NULL,
             expires_at  INTEGER,
             created_at  INTEGER NOT NULL,
             created_by  TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_vault_policy_bindings_subject
             ON vault_policy_bindings(subject);",
    )
    .context("initializing vault policy schema")?;
    super::policy_ext::init_schema(conn)
}

/// Insert or replace a policy.
pub fn put_policy(conn: &Connection, policy: &Policy) -> Result<()> {
    validate(policy)?;
    let now = now_millis();
    conn.execute(
        "INSERT INTO vault_policies (name, description, rules, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(name) DO UPDATE SET description = excluded.description,
             rules = excluded.rules, updated_at = excluded.updated_at",
        params![
            policy.name,
            policy.description,
            serde_json::to_string(&policy.rules)?,
            now
        ],
    )
    .context("writing vault policy")?;
    Ok(())
}

/// Delete a policy and its bindings.
pub fn delete_policy(conn: &Connection, name: &str) -> Result<bool> {
    conn.execute(
        "DELETE FROM vault_policy_bindings WHERE policy = ?1",
        params![name],
    )?;
    Ok(conn.execute("DELETE FROM vault_policies WHERE name = ?1", params![name])? > 0)
}

/// Every policy.
pub fn list_policies(conn: &Connection) -> Result<Vec<Policy>> {
    let mut stmt =
        conn.prepare("SELECT name, description, rules FROM vault_policies ORDER BY name")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (name, description, rules) = row?;
        out.push(Policy {
            name,
            description,
            rules: serde_json::from_str(&rules).context("decoding policy rules")?,
        });
    }
    Ok(out)
}

/// Attach a policy to a subject.
pub fn bind(
    conn: &Connection,
    policy: &str,
    subject: &str,
    expires_at: Option<i64>,
    created_by: Option<&str>,
) -> Result<PolicyBinding> {
    if !is_valid_subject(subject) {
        bail!("subject must be user:<id>, team:<id>, role:<name>, or machine:<id>");
    }
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vault_policies WHERE name = ?1",
        params![policy],
        |row| row.get(0),
    )?;
    if exists == 0 {
        bail!("policy `{policy}` does not exist");
    }
    if expires_at.is_some_and(|at| at <= now_millis()) {
        bail!("a binding cannot expire in the past");
    }
    let binding = PolicyBinding {
        id: format!("vpb_{}", uuid::Uuid::new_v4().simple()),
        policy: policy.to_owned(),
        subject: subject.to_owned(),
        expires_at,
    };
    conn.execute(
        "INSERT INTO vault_policy_bindings (id, policy, subject, expires_at, created_at, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            binding.id,
            binding.policy,
            binding.subject,
            binding.expires_at,
            now_millis(),
            created_by
        ],
    )?;
    Ok(binding)
}

/// Remove a binding.
pub fn unbind(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.execute(
        "DELETE FROM vault_policy_bindings WHERE id = ?1",
        params![id],
    )? > 0)
}

/// Every binding, including expired ones (marked by `expires_at`).
pub fn list_bindings(conn: &Connection) -> Result<Vec<PolicyBinding>> {
    let mut stmt = conn.prepare(
        "SELECT id, policy, subject, expires_at FROM vault_policy_bindings ORDER BY created_at",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(PolicyBinding {
            id: row.get(0)?,
            policy: row.get(1)?,
            subject: row.get(2)?,
            expires_at: row.get(3)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// The policies currently bound to any of `subjects` (expired bindings skipped).
pub fn policies_for(conn: &Connection, subjects: &[String]) -> Result<Vec<Policy>> {
    if subjects.is_empty() {
        return Ok(Vec::new());
    }
    let now = now_millis();
    let bound: BTreeSet<String> = list_bindings(conn)?
        .into_iter()
        .filter(|binding| binding.expires_at.is_none_or(|at| at > now))
        .filter(|binding| subjects.iter().any(|subject| subject == &binding.subject))
        .map(|binding| binding.policy)
        .collect();
    Ok(list_policies(conn)?
        .into_iter()
        .filter(|policy| bound.contains(&policy.name))
        .collect())
}

/// Delete expired bindings. Returns how many were removed.
pub fn prune_expired(conn: &Connection) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM vault_policy_bindings WHERE expires_at IS NOT NULL AND expires_at <= ?1",
        params![now_millis()],
    )?)
}

#[cfg(test)]
mod tests;
