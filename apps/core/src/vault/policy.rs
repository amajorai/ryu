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
//! control groups; see [`super::policy_ext`].

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::now_millis;
use super::policy_ext::{ControlGroupSpec, TemplateContext};

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
/// templates against `context`.
pub fn evaluate_with<'a>(
    baseline: &CapabilitySet,
    policies: impl IntoIterator<Item = &'a Policy>,
    path: &str,
    context: &TemplateContext,
) -> CapabilitySet {
    let mut allowed = baseline.clone();
    let mut denied = CapabilitySet::new();
    for policy in policies {
        for rule in &policy.rules {
            if !super::policy_ext::rule_matches(rule, path, context) {
                continue;
            }
            let target = if rule.deny { &mut denied } else { &mut allowed };
            target.extend(rule.capabilities.iter().copied());
        }
    }
    allowed.retain(|capability| !denied.contains(capability));
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
mod tests {
    use super::*;

    fn caps(list: &[Capability]) -> CapabilitySet {
        list.iter().copied().collect()
    }

    #[test]
    fn globs_match_segments_and_recursive_wildcards() {
        assert!(glob_matches("prod/*", "prod/API_KEY"));
        assert!(!glob_matches("prod/*", "prod/db/API_KEY"));
        assert!(glob_matches("prod/**", "prod/db/main/API_KEY"));
        assert!(glob_matches("prod/**", "prod/API_KEY"));
        assert!(glob_matches("**/PASSWORD", "staging/db/PASSWORD"));
        assert!(glob_matches("*/db/DB_*", "prod/db/DB_PASSWORD"));
        assert!(!glob_matches("*/db/DB_*", "prod/db/API_KEY"));
        assert!(glob_matches("prod/STRIPE_?EY", "prod/STRIPE_KEY"));
        assert!(!glob_matches("prod", "prod/A"));
    }

    #[test]
    fn child_globs_match_some_name_under_a_folder() {
        assert!(may_match_child("default/app/**", "default/app/db"));
        assert!(may_match_child("default/**", "default/app/db"));
        assert!(may_match_child("**", "default/app/db"));
        assert!(may_match_child("default/app/db/*", "default/app/db"));
        assert!(may_match_child("default/app/db/PASSWORD", "default/app/db"));
        assert!(may_match_child("*/app/db/DB_*", "prod/app/db"));
        assert!(may_match_child("**/PASSWORD", "default/app/db"));
        assert!(!may_match_child("default/app/db", "default/app/db"));
        assert!(!may_match_child("default/app/db/x/*", "default/app/db"));
        assert!(!may_match_child("default/other/**", "default/app/db"));
        assert!(!may_match_child("default/app/*", "default/app/db"));
        assert!(may_match_child("default/*", "default"));
    }

    #[test]
    fn deny_wins_over_baseline_and_allow() {
        let policies = vec![
            Policy {
                name: "read-staging".into(),
                description: String::new(),
                rules: vec![PolicyRule {
                    path: "staging/**".into(),
                    capabilities: vec![Capability::Read],
                    deny: false,
                    ..PolicyRule::default()
                }],
            },
            Policy {
                name: "no-prod".into(),
                description: String::new(),
                rules: vec![PolicyRule {
                    path: "prod/**".into(),
                    capabilities: vec![Capability::Use, Capability::List],
                    deny: true,
                    ..PolicyRule::default()
                }],
            },
        ];
        let baseline = caps(&[Capability::List, Capability::Use]);
        assert_eq!(
            evaluate(&baseline, &policies, "staging/db/PASSWORD"),
            caps(&[Capability::List, Capability::Use, Capability::Read])
        );
        assert_eq!(evaluate(&baseline, &policies, "prod/API_KEY"), caps(&[]));
    }

    #[test]
    fn shared_fixture_cases_pass() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Case {
            name: String,
            baseline: Vec<Capability>,
            policies: Vec<Policy>,
            path: String,
            expected: Vec<Capability>,
            #[serde(default)]
            subjects: Vec<String>,
            #[serde(default)]
            parameters: Option<BTreeMap<String, serde_json::Value>>,
            #[serde(default)]
            expected_parameters_allowed: Option<bool>,
            #[serde(default)]
            expected_control_group: Option<bool>,
            #[serde(default)]
            expected_control_group_factors: Option<Vec<String>>,
        }
        let raw = include_str!("../../tests/fixtures/vault-policy-cases.json");
        let cases: Vec<Case> = serde_json::from_str(raw).unwrap();
        assert!(cases.len() >= 5);
        for case in cases {
            for policy in &case.policies {
                validate(policy).unwrap_or_else(|e| panic!("case `{}`: {e}", case.name));
            }
            let context = TemplateContext::from_subjects(&case.subjects);
            let got = evaluate_with(&caps(&case.baseline), &case.policies, &case.path, &context);
            assert_eq!(got, caps(&case.expected), "case `{}`", case.name);
            if let (Some(parameters), Some(expected)) =
                (&case.parameters, case.expected_parameters_allowed)
            {
                let result = super::super::policy_ext::check_parameters(
                    &case.policies,
                    &case.path,
                    Capability::Write,
                    &context,
                    parameters,
                );
                assert_eq!(result.is_ok(), expected, "case `{}`: {result:?}", case.name);
            }
            if let Some(expected) = case.expected_control_group {
                let group = super::super::policy_ext::control_group_for(
                    &case.policies,
                    &case.path,
                    Capability::Read,
                    &context,
                );
                assert_eq!(group.is_some(), expected, "case `{}`", case.name);
                if let Some(expected_factors) = &case.expected_control_group_factors {
                    let mut names: Vec<String> = group
                        .map(|group| group.factors.into_iter().map(|f| f.name).collect())
                        .unwrap_or_default();
                    names.sort();
                    let mut expected_factors = expected_factors.clone();
                    expected_factors.sort();
                    assert_eq!(names, expected_factors, "case `{}`", case.name);
                }
            }
        }
    }

    #[test]
    fn bindings_expire_and_attach_policies_to_subjects() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let policy = Policy {
            name: "ci".into(),
            description: "CI reads staging".into(),
            rules: vec![PolicyRule {
                path: "staging/**".into(),
                capabilities: vec![Capability::Read],
                deny: false,
                ..PolicyRule::default()
            }],
        };
        put_policy(&conn, &policy).unwrap();
        bind(&conn, "ci", "machine:m1", None, Some("admin")).unwrap();
        let temp = bind(
            &conn,
            "ci",
            "user:u1",
            Some(now_millis() + 60_000),
            Some("admin"),
        )
        .unwrap();
        assert_eq!(
            policies_for(&conn, &["machine:m1".into()]).unwrap().len(),
            1
        );
        assert_eq!(policies_for(&conn, &["user:u1".into()]).unwrap().len(), 1);
        assert!(policies_for(&conn, &["user:u2".into()]).unwrap().is_empty());

        conn.execute(
            "UPDATE vault_policy_bindings SET expires_at = 1 WHERE id = ?1",
            params![temp.id],
        )
        .unwrap();
        assert!(policies_for(&conn, &["user:u1".into()]).unwrap().is_empty());
        assert_eq!(prune_expired(&conn).unwrap(), 1);

        assert!(bind(&conn, "missing", "user:u1", None, None).is_err());
        assert!(bind(&conn, "ci", "group:x", None, None).is_err());
        assert!(delete_policy(&conn, "ci").unwrap());
        assert!(list_bindings(&conn).unwrap().is_empty());
    }

    #[test]
    fn invalid_policies_are_rejected() {
        let mut policy = Policy {
            name: "Bad Name".into(),
            description: String::new(),
            rules: vec![],
        };
        assert!(validate(&policy).is_err());
        policy.name = "ok".into();
        assert!(validate(&policy).is_err());
        policy.rules.push(PolicyRule {
            path: "prod/../x".into(),
            capabilities: vec![Capability::Read],
            deny: false,
            ..PolicyRule::default()
        });
        assert!(validate(&policy).is_err());
    }
}
