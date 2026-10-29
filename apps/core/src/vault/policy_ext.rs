//! Policy extensions: templated rule paths, request-parameter constraints, and
//! control groups (approval-gated reads).
//!
//! **Templates.** A rule path (and a parameter-constraint value) may contain
//! `{{identity.user.id}}`, `{{identity.machine.id}}`, `{{identity.team.ids}}`,
//! or `{{identity.roles}}`. Placeholders are checked when the policy is written
//! (well-formed, known variable, inside one path segment). At evaluation each
//! placeholder expands to the caller's values; a value is only substituted when
//! it is a safe literal segment (no `/`, glob metacharacters, braces, control
//! characters, `.` or `..`), so identity data can never widen a glob. A rule
//! whose placeholders cannot be resolved is dropped when it allows, and when it
//! denies it is widened (each placeholder becomes `*`), so an unresolved
//! template always fails closed.
//!
//! **Parameters.** A rule granting `write` may carry `allowedParameters`,
//! `deniedParameters`, and `requiredParameters` (OpenBao semantics: `*` as a
//! key means every parameter; an empty value list means any value; values are
//! single-segment globs). Every matching granting rule's denied and required
//! constraints apply; allowed constraints are the union across matching rules
//! that set one.
//!
//! **Control groups.** A rule granting `read` may carry a `controlGroup`: a
//! reveal of a matching value then creates a pending request instead of
//! returning the value. Approvers named by each factor authorize it (never the
//! requester); once every factor has enough approvals, the requester redeems a
//! one-time token for the value. Tokens are stored as SHA-256 digests, compared
//! in constant time, and redeemed by a single conditional `UPDATE`, so a token
//! can be used at most once even under concurrent redemption.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::policy::{
    glob_matches, is_valid_subject, wildcard_matches, Capability, Policy, PolicyRule,
};
use super::VaultError;

/// Template variables a policy may reference.
pub const TEMPLATE_VARIABLES: [&str; 4] = [
    "identity.user.id",
    "identity.machine.id",
    "identity.team.ids",
    "identity.roles",
];
/// Maximum concrete paths one templated rule may expand to.
pub const MAX_TEMPLATE_EXPANSIONS: usize = 64;
/// Maximum length of one substituted identity value.
pub const MAX_TEMPLATE_VALUE_LEN: usize = 128;
/// Maximum parameter names per constraint map.
pub const MAX_PARAMETERS: usize = 64;
/// Maximum values per parameter.
pub const MAX_PARAMETER_VALUES: usize = 64;
const MAX_PARAMETER_TEXT_LEN: usize = 256;
/// Maximum factors per control group.
pub const MAX_CONTROL_GROUP_FACTORS: usize = 5;
/// Maximum approvers per factor.
pub const MAX_FACTOR_APPROVERS: usize = 32;
/// Control-group request lifetime bounds (seconds).
pub const MIN_CONTROL_GROUP_TTL_SECS: i64 = 60;
pub const MAX_CONTROL_GROUP_TTL_SECS: i64 = 7 * 24 * 3600;
pub const DEFAULT_CONTROL_GROUP_TTL_SECS: i64 = 24 * 3600;
const TOKEN_PREFIX: &str = "vcg_";
/// Open (pending or approved, unexpired) requests one requester may hold.
pub const MAX_OPEN_REQUESTS_PER_REQUESTER: i64 = 16;
/// Requests returned by one listing.
const MAX_LISTED_REQUESTS: usize = 100;

// ── Templates ─────────────────────────────────────────────────────────────

/// The caller identity templates expand against.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TemplateContext {
    values: BTreeMap<&'static str, Vec<String>>,
}

impl TemplateContext {
    /// Build from policy-binding subjects (`user:`, `machine:`, `team:`, `role:`).
    pub fn from_subjects(subjects: &[String]) -> Self {
        let mut values: BTreeMap<&'static str, Vec<String>> = BTreeMap::new();
        for subject in subjects {
            let Some((kind, id)) = subject.split_once(':') else {
                continue;
            };
            let variable = match kind {
                "user" => "identity.user.id",
                "machine" => "identity.machine.id",
                "team" => "identity.team.ids",
                "role" => "identity.roles",
                _ => continue,
            };
            let entry = values.entry(variable).or_default();
            if !entry.iter().any(|existing| existing == id) {
                entry.push(id.to_owned());
            }
        }
        Self { values }
    }

    fn safe_values(&self, variable: &str) -> Vec<&str> {
        self.values
            .get(variable)
            .map(|values| {
                values
                    .iter()
                    .map(String::as_str)
                    .filter(|value| is_safe_template_value(value))
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// Whether `value` may be substituted into a path segment.
pub fn is_safe_template_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TEMPLATE_VALUE_LEN
        && value != "."
        && value != ".."
        && !value.chars().any(|c| {
            matches!(c, '/' | '*' | '?' | '{' | '}') || c.is_control() || c.is_whitespace()
        })
}

#[derive(Debug, PartialEq, Eq)]
enum Part<'a> {
    Literal(&'a str),
    Variable(&'a str),
}

fn parse_template(text: &str) -> Result<Vec<Part<'_>>> {
    let mut parts = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let literal = &rest[..start];
        if literal.contains('{') || literal.contains('}') {
            bail!("`{text}` has a stray brace");
        }
        if !literal.is_empty() {
            parts.push(Part::Literal(literal));
        }
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            bail!("`{text}` has an unclosed `{{{{`");
        };
        let variable = after[..end].trim();
        if !TEMPLATE_VARIABLES.contains(&variable) {
            bail!(
                "`{text}` references unknown template variable `{variable}` (known: {})",
                TEMPLATE_VARIABLES.join(", ")
            );
        }
        parts.push(Part::Variable(variable));
        rest = &after[end + 2..];
    }
    if rest.contains('{') || rest.contains('}') {
        bail!("`{text}` has a stray brace");
    }
    if !rest.is_empty() {
        parts.push(Part::Literal(rest));
    }
    Ok(parts)
}

/// Whether `text` contains a template placeholder.
pub fn is_templated(text: &str) -> bool {
    text.contains("{{")
}

/// Check template syntax at policy write time.
pub fn validate_template(text: &str) -> Result<()> {
    parse_template(text).map(|_| ())
}

/// The result of expanding a template.
#[derive(Debug, PartialEq, Eq)]
pub enum Expansion {
    /// Every concrete text the template expands to (non-empty).
    Concrete(Vec<String>),
    /// Unresolvable; carries the template with each placeholder replaced by `*`.
    Unresolved(String),
}

/// Expand `text` for `context`.
pub fn expand(text: &str, context: &TemplateContext) -> Expansion {
    if !is_templated(text) {
        return Expansion::Concrete(vec![text.to_owned()]);
    }
    let Ok(parts) = parse_template(text) else {
        // Validation rejects malformed templates at write time; a stored one
        // that still fails to parse resolves to nothing (and widens denies).
        return Expansion::Unresolved(widen_raw(text));
    };
    let wildcard: String = parts
        .iter()
        .map(|part| match part {
            Part::Literal(literal) => *literal,
            Part::Variable(_) => "*",
        })
        .collect();
    let mut outputs = vec![String::new()];
    for part in &parts {
        match part {
            Part::Literal(literal) => outputs.iter_mut().for_each(|out| out.push_str(literal)),
            Part::Variable(variable) => {
                let values = context.safe_values(variable);
                if values.is_empty() || outputs.len() * values.len() > MAX_TEMPLATE_EXPANSIONS {
                    return Expansion::Unresolved(wildcard);
                }
                outputs = outputs
                    .iter()
                    .flat_map(|prefix| values.iter().map(move |value| format!("{prefix}{value}")))
                    .collect();
            }
        }
    }
    Expansion::Concrete(outputs)
}

fn widen_raw(text: &str) -> String {
    // Replace every brace-delimited run with `*`; used only for malformed input.
    let mut out = String::with_capacity(text.len());
    let mut depth = 0usize;
    for c in text.chars() {
        match c {
            '{' => {
                if depth == 0 {
                    out.push('*');
                }
                depth += 1;
            }
            '}' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

/// Whether `rule` applies to `path` for `context`. Unresolved allow rules never
/// apply; unresolved deny rules apply to their widened glob.
pub fn rule_matches(rule: &PolicyRule, path: &str, context: &TemplateContext) -> bool {
    match expand(&rule.path, context) {
        Expansion::Concrete(globs) => globs.iter().any(|glob| glob_matches(glob, path)),
        Expansion::Unresolved(widened) => rule.deny && glob_matches(&widened, path),
    }
}

// ── Parameter constraints ─────────────────────────────────────────────────

/// Parameter-value constraints: parameter name (or `*`) → allowed value globs.
pub type ParameterMap = BTreeMap<String, Vec<String>>;

fn validate_parameter_map(map: &ParameterMap, label: &str) -> Result<()> {
    if map.len() > MAX_PARAMETERS {
        bail!("{label} lists more than {MAX_PARAMETERS} parameters");
    }
    for (name, values) in map {
        if name.is_empty() || name.len() > MAX_PARAMETER_TEXT_LEN {
            bail!("{label} has an empty or too long parameter name");
        }
        if values.len() > MAX_PARAMETER_VALUES {
            bail!("{label}.{name} lists more than {MAX_PARAMETER_VALUES} values");
        }
        for value in values {
            if value.len() > MAX_PARAMETER_TEXT_LEN {
                bail!("{label}.{name} has a value that is too long");
            }
            validate_template(value).with_context(|| format!("{label}.{name}"))?;
        }
    }
    Ok(())
}

/// Validate a rule's extension fields at policy write time.
pub fn validate_rule(rule: &PolicyRule) -> Result<()> {
    validate_template(&rule.path).context("rule path")?;
    let has_parameters = rule.allowed_parameters.is_some()
        || rule.denied_parameters.is_some()
        || !rule.required_parameters.is_empty();
    if has_parameters {
        if rule.deny {
            bail!(
                "rule `{}`: parameter constraints cannot be set on a deny rule",
                rule.path
            );
        }
        if !rule.capabilities.contains(&Capability::Write) {
            bail!(
                "rule `{}`: parameter constraints need the `write` capability",
                rule.path
            );
        }
    }
    if let Some(map) = &rule.allowed_parameters {
        validate_parameter_map(map, "allowedParameters")?;
    }
    if let Some(map) = &rule.denied_parameters {
        validate_parameter_map(map, "deniedParameters")?;
    }
    if rule.required_parameters.len() > MAX_PARAMETERS {
        bail!("requiredParameters lists more than {MAX_PARAMETERS} parameters");
    }
    if rule
        .required_parameters
        .iter()
        .any(|name| name.is_empty() || name.len() > MAX_PARAMETER_TEXT_LEN || name == "*")
    {
        bail!("requiredParameters has an empty, too long, or wildcard name");
    }
    if let Some(group) = &rule.control_group {
        if rule.deny {
            bail!(
                "rule `{}`: a control group cannot be set on a deny rule",
                rule.path
            );
        }
        if !rule.capabilities.contains(&Capability::Read) {
            bail!(
                "rule `{}`: a control group needs the `read` capability",
                rule.path
            );
        }
        group.validate()?;
    }
    Ok(())
}

fn parameter_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn value_matches(globs: &[String], value: &str, context: &TemplateContext, deny: bool) -> bool {
    if globs.is_empty() {
        return true;
    }
    globs.iter().any(|glob| match expand(glob, context) {
        Expansion::Concrete(patterns) => patterns
            .iter()
            .any(|pattern| wildcard_matches(pattern, value)),
        Expansion::Unresolved(widened) => deny && wildcard_matches(&widened, value),
    })
}

fn lookup<'m>(map: &'m ParameterMap, name: &str) -> Option<&'m Vec<String>> {
    map.get(name).or_else(|| map.get("*"))
}

/// Whether any allow rule matching `path` that grants `capability` carries
/// parameter constraints.
pub fn has_parameter_constraints<'a>(
    policies: impl IntoIterator<Item = &'a Policy>,
    path: &str,
    capability: Capability,
    context: &TemplateContext,
) -> bool {
    policies.into_iter().any(|policy| {
        policy.rules.iter().any(|rule| {
            !rule.deny
                && rule.capabilities.contains(&capability)
                && (rule.allowed_parameters.is_some()
                    || rule.denied_parameters.is_some()
                    || !rule.required_parameters.is_empty())
                && rule_matches(rule, path, context)
        })
    })
}

/// Check request `parameters` against every rule matching `path` that grants
/// `capability`. Returns the first violation as a message.
pub fn check_parameters<'a>(
    policies: impl IntoIterator<Item = &'a Policy>,
    path: &str,
    capability: Capability,
    context: &TemplateContext,
    parameters: &BTreeMap<String, Value>,
) -> std::result::Result<(), String> {
    let mut allowed: Vec<&ParameterMap> = Vec::new();
    for policy in policies {
        for rule in &policy.rules {
            if rule.deny
                || !rule.capabilities.contains(&capability)
                || !rule_matches(rule, path, context)
            {
                continue;
            }
            for required in &rule.required_parameters {
                if !parameters.contains_key(required) {
                    return Err(format!(
                        "policy `{}` requires parameter `{required}`",
                        policy.name
                    ));
                }
            }
            if let Some(denied) = &rule.denied_parameters {
                for (name, value) in parameters {
                    if let Some(globs) = lookup(denied, name) {
                        if value_matches(globs, &parameter_text(value), context, true) {
                            return Err(format!(
                                "policy `{}` denies parameter `{name}`{}",
                                policy.name,
                                if globs.is_empty() {
                                    ""
                                } else {
                                    " with this value"
                                }
                            ));
                        }
                    }
                }
            }
            if let Some(map) = &rule.allowed_parameters {
                allowed.push(map);
            }
        }
    }
    if allowed.is_empty() {
        return Ok(());
    }
    for (name, value) in parameters {
        let text = parameter_text(value);
        let permitted = allowed.iter().any(|map| {
            lookup(map, name).is_some_and(|globs| value_matches(globs, &text, context, false))
        });
        if !permitted {
            return Err(format!("parameter `{name}` is not allowed by policy"));
        }
    }
    Ok(())
}

// ── Control groups ────────────────────────────────────────────────────────

/// One approval factor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlGroupFactor {
    pub name: String,
    /// Subjects (`user:`, `team:`, `role:`, `machine:`) allowed to approve.
    pub approvers: Vec<String>,
    /// Distinct approvals required.
    #[serde(default = "one")]
    pub approvals: u8,
}

fn one() -> u8 {
    1
}

/// A control group attached to a rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlGroupSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_secs: Option<i64>,
    pub factors: Vec<ControlGroupFactor>,
}

impl ControlGroupSpec {
    pub fn validate(&self) -> Result<()> {
        if let Some(ttl) = self.ttl_secs {
            if !(MIN_CONTROL_GROUP_TTL_SECS..=MAX_CONTROL_GROUP_TTL_SECS).contains(&ttl) {
                bail!(
                    "controlGroup.ttlSecs must be between {MIN_CONTROL_GROUP_TTL_SECS} and {MAX_CONTROL_GROUP_TTL_SECS}"
                );
            }
        }
        if self.factors.is_empty() || self.factors.len() > MAX_CONTROL_GROUP_FACTORS {
            bail!("a control group needs between 1 and {MAX_CONTROL_GROUP_FACTORS} factors");
        }
        let mut names = BTreeSet::new();
        for factor in &self.factors {
            if !super::policy::is_valid_policy_name(&factor.name) || !names.insert(&factor.name) {
                bail!("control-group factor names must be unique [a-z0-9_-]{{1,64}}");
            }
            if factor.approvers.is_empty() || factor.approvers.len() > MAX_FACTOR_APPROVERS {
                bail!(
                    "factor `{}` needs between 1 and {MAX_FACTOR_APPROVERS} approvers",
                    factor.name
                );
            }
            if let Some(bad) = factor.approvers.iter().find(|s| !is_valid_subject(s)) {
                bail!(
                    "factor `{}` approver `{bad}` is not a valid subject",
                    factor.name
                );
            }
            if factor.approvals == 0 || factor.approvals > 5 {
                bail!("factor `{}` approvals must be between 1 and 5", factor.name);
            }
        }
        Ok(())
    }

    fn ttl(&self) -> i64 {
        self.ttl_secs.unwrap_or(DEFAULT_CONTROL_GROUP_TTL_SECS)
    }
}

/// The merged control group gating `capability` on `path`, if any. Factors are
/// namespaced `policy/factor`; the shortest TTL wins.
pub fn control_group_for<'a>(
    policies: impl IntoIterator<Item = &'a Policy>,
    path: &str,
    capability: Capability,
    context: &TemplateContext,
) -> Option<ControlGroupSpec> {
    let mut merged: Option<ControlGroupSpec> = None;
    for policy in policies {
        for (rule_index, rule) in policy.rules.iter().enumerate() {
            let Some(group) = &rule.control_group else {
                continue;
            };
            if rule.deny
                || !rule.capabilities.contains(&capability)
                || !rule_matches(rule, path, context)
            {
                continue;
            }
            let target = merged.get_or_insert_with(|| ControlGroupSpec {
                ttl_secs: Some(group.ttl()),
                factors: Vec::new(),
            });
            target.ttl_secs = Some(target.ttl().min(group.ttl()));
            // Namespace by rule too: factor names are unique only within one
            // rule, so two matching rules of one policy that reuse a name are
            // both enforced (ANDed). Only the same rule of the same policy
            // reached twice (e.g. via a user and a team binding) collapses.
            for factor in &group.factors {
                let name = format!("{}/{}/{}", policy.name, rule_index, factor.name);
                if target.factors.iter().any(|existing| existing.name == name) {
                    continue;
                }
                target.factors.push(ControlGroupFactor {
                    name,
                    ..factor.clone()
                });
            }
        }
    }
    merged
}

/// Whether a control group gates `read` on `path` for any caller: some allow
/// rule granting `read` with a `controlGroup` matches it, with a templated
/// path widened to `*`. Unattended paths that act for no single caller (an
/// external push) leave such values out rather than release them.
pub fn read_gated_for_anyone<'a>(
    policies: impl IntoIterator<Item = &'a Policy>,
    path: &str,
) -> bool {
    let context = TemplateContext::default();
    policies.into_iter().any(|policy| {
        policy.rules.iter().any(|rule| {
            !rule.deny
                && rule.control_group.is_some()
                && rule.capabilities.contains(&Capability::Read)
                && match expand(&rule.path, &context) {
                    Expansion::Concrete(globs) => globs.iter().any(|glob| glob_matches(glob, path)),
                    Expansion::Unresolved(widened) => glob_matches(&widened, path),
                }
        })
    })
}

/// One recorded approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlGroupApproval {
    pub factor: String,
    pub approver: String,
    pub approved_at: i64,
}

/// Request status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlGroupStatus {
    Pending,
    Approved,
    Redeemed,
    Expired,
}

impl ControlGroupStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Redeemed => "redeemed",
            Self::Expired => "expired",
        }
    }

    fn parse(text: &str) -> Self {
        match text {
            "approved" => Self::Approved,
            "redeemed" => Self::Redeemed,
            "expired" => Self::Expired,
            _ => Self::Pending,
        }
    }
}

/// A stored control-group request (never carries the token).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlGroupRequest {
    pub id: String,
    /// Subject of the requester (`user:<id>`).
    pub requester: String,
    /// The `ENV/folder/NAME` policy key being read.
    pub policy_key: String,
    /// What the redeemed token releases (handler-defined JSON).
    pub target: Value,
    pub factors: Vec<ControlGroupFactor>,
    pub approvals: Vec<ControlGroupApproval>,
    pub status: ControlGroupStatus,
    pub created_at: i64,
    pub expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redeemed_at: Option<i64>,
}

impl ControlGroupRequest {
    /// Whether every factor has its required distinct approvals.
    pub fn satisfied(&self) -> bool {
        self.factors.iter().all(|factor| {
            let approvers: BTreeSet<&str> = self
                .approvals
                .iter()
                .filter(|approval| approval.factor == factor.name)
                .map(|approval| approval.approver.as_str())
                .collect();
            approvers.len() >= usize::from(factor.approvals)
        })
    }

    /// Whether this request still matches `current`, the control group that
    /// gates its key now: the same factors (names, approver sets, counts),
    /// ignoring order. Approvals gathered under a since-changed group (a
    /// narrowed approver list, a raised count, an added factor) must not
    /// release the value; the requester opens a new request instead.
    pub fn matches_spec(&self, current: &ControlGroupSpec) -> bool {
        fn normalized(factors: &[ControlGroupFactor]) -> BTreeMap<&str, (BTreeSet<&str>, u8)> {
            factors
                .iter()
                .map(|factor| {
                    let approvers = factor.approvers.iter().map(String::as_str).collect();
                    (factor.name.as_str(), (approvers, factor.approvals))
                })
                .collect()
        }
        self.factors.len() == current.factors.len()
            && normalized(&self.factors) == normalized(&current.factors)
    }

    /// Whether any of `subjects` may approve some factor.
    pub fn is_approver(&self, subjects: &[String]) -> bool {
        self.factors
            .iter()
            .any(|factor| factor.approvers.iter().any(|a| subjects.contains(a)))
    }
}

/// Create the control-group table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_control_groups (
             id          TEXT PRIMARY KEY,
             token_hash  TEXT NOT NULL,
             requester   TEXT NOT NULL,
             policy_key  TEXT NOT NULL,
             target      TEXT NOT NULL,
             factors     TEXT NOT NULL,
             approvals   TEXT NOT NULL DEFAULT '[]',
             status      TEXT NOT NULL,
             created_at  INTEGER NOT NULL,
             expires_at  INTEGER NOT NULL,
             redeemed_at INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_vault_control_groups_requester
             ON vault_control_groups(requester);",
    )
    .context("initializing vault control-group schema")
}

fn digest(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

/// Constant-time byte comparison (length is not secret).
pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

fn not_found() -> anyhow::Error {
    VaultError::NotFound("control-group request not found".to_owned()).into()
}

/// Open a request. Returns it with the one-time redemption token, which is
/// shown to the requester only now.
pub fn create_request(
    conn: &Connection,
    requester: &str,
    policy_key: &str,
    target: &Value,
    spec: &ControlGroupSpec,
    now: i64,
) -> Result<(ControlGroupRequest, String)> {
    use rand::RngCore;
    // Merged specs carry `policy/factor` names, so only the shape is rechecked;
    // every factor was validated when its policy was written.
    if spec.factors.is_empty() || spec.factors.iter().any(|f| f.approvals == 0) {
        bail!("control group has no satisfiable factors");
    }
    let open: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vault_control_groups
         WHERE requester = ?1 AND status IN ('pending', 'approved') AND expires_at > ?2",
        params![requester, now],
        |row| row.get(0),
    )?;
    if open >= MAX_OPEN_REQUESTS_PER_REQUESTER {
        return Err(VaultError::Conflict(format!(
            "too many open control-group requests (limit {MAX_OPEN_REQUESTS_PER_REQUESTER})"
        ))
        .into());
    }
    let mut secret = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut secret);
    let secret = hex::encode(secret);
    let id = uuid::Uuid::new_v4().simple().to_string();
    let request = ControlGroupRequest {
        id: id.clone(),
        requester: requester.to_owned(),
        policy_key: policy_key.to_owned(),
        target: target.clone(),
        factors: spec.factors.clone(),
        approvals: Vec::new(),
        status: ControlGroupStatus::Pending,
        created_at: now,
        expires_at: now + spec.ttl() * 1000,
        redeemed_at: None,
    };
    conn.execute(
        "INSERT INTO vault_control_groups
             (id, token_hash, requester, policy_key, target, factors, approvals, status,
              created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', 'pending', ?7, ?8)",
        params![
            request.id,
            digest(&secret),
            request.requester,
            request.policy_key,
            serde_json::to_string(&request.target)?,
            serde_json::to_string(&request.factors)?,
            request.created_at,
            request.expires_at,
        ],
    )
    .context("writing control-group request")?;
    Ok((request, format!("{TOKEN_PREFIX}{id}.{secret}")))
}

fn load_row(conn: &Connection, id: &str) -> Result<Option<(ControlGroupRequest, String)>> {
    conn.query_row(
        "SELECT id, token_hash, requester, policy_key, target, factors, approvals, status,
                created_at, expires_at, redeemed_at
         FROM vault_control_groups WHERE id = ?1",
        params![id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, Option<i64>>(10)?,
            ))
        },
    )
    .optional()?
    .map(
        |(
            id,
            hash,
            requester,
            policy_key,
            target,
            factors,
            approvals,
            status,
            created,
            expires,
            redeemed,
        )| {
            Ok((
                ControlGroupRequest {
                    id,
                    requester,
                    policy_key,
                    target: serde_json::from_str(&target).context("decoding target")?,
                    factors: serde_json::from_str(&factors).context("decoding factors")?,
                    approvals: serde_json::from_str(&approvals).context("decoding approvals")?,
                    status: ControlGroupStatus::parse(&status),
                    created_at: created,
                    expires_at: expires,
                    redeemed_at: redeemed,
                },
                hash,
            ))
        },
    )
    .transpose()
}

/// One request, with `expired` reported for a lapsed pending/approved one.
pub fn get_request(conn: &Connection, id: &str, now: i64) -> Result<Option<ControlGroupRequest>> {
    Ok(load_row(conn, id)?.map(|(mut request, _)| {
        if request.expires_at <= now
            && matches!(
                request.status,
                ControlGroupStatus::Pending | ControlGroupStatus::Approved
            )
        {
            request.status = ControlGroupStatus::Expired;
        }
        request
    }))
}

/// Record an approval by a caller holding `subjects`. The approver must be
/// named by a factor and must not be the requester. Idempotent per approver.
pub fn authorize(
    conn: &Connection,
    id: &str,
    approver: &str,
    subjects: &[String],
    now: i64,
) -> Result<ControlGroupRequest> {
    let tx = conn.unchecked_transaction()?;
    let Some(mut request) = get_request(&tx, id, now)? else {
        return Err(not_found());
    };
    if request.status != ControlGroupStatus::Pending
        && request.status != ControlGroupStatus::Approved
    {
        return Err(VaultError::Conflict(format!(
            "control-group request is {}",
            request.status.as_str()
        ))
        .into());
    }
    if approver == request.requester || subjects.iter().any(|s| s == &request.requester) {
        return Err(
            VaultError::Denied("requesters cannot approve their own request".into()).into(),
        );
    }
    let mut matched = false;
    for factor in &request.factors {
        if !factor.approvers.iter().any(|a| subjects.contains(a)) {
            continue;
        }
        matched = true;
        if !request
            .approvals
            .iter()
            .any(|a| a.factor == factor.name && a.approver == approver)
        {
            request.approvals.push(ControlGroupApproval {
                factor: factor.name.clone(),
                approver: approver.to_owned(),
                approved_at: now,
            });
        }
    }
    if !matched {
        return Err(VaultError::Denied("not an approver for this control group".into()).into());
    }
    if request.satisfied() {
        request.status = ControlGroupStatus::Approved;
    }
    let changed = tx.execute(
        "UPDATE vault_control_groups SET approvals = ?1, status = ?2
         WHERE id = ?3 AND status IN ('pending', 'approved') AND expires_at > ?4",
        params![
            serde_json::to_string(&request.approvals)?,
            request.status.as_str(),
            id,
            now
        ],
    )?;
    if changed != 1 {
        return Err(VaultError::Conflict("control-group request changed".into()).into());
    }
    tx.commit()?;
    Ok(request)
}

/// The request `token` names, when the token and `requester` both match.
/// Every failure that could reveal whether a token exists returns the same
/// not-found error. Does not change the request.
pub fn verify_token(
    conn: &Connection,
    token: &str,
    requester: &str,
) -> Result<(ControlGroupRequest, String)> {
    let Some((id, secret)) = token
        .strip_prefix(TOKEN_PREFIX)
        .and_then(|rest| rest.split_once('.'))
    else {
        return Err(not_found());
    };
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(not_found());
    }
    let Some((request, stored_hash)) = load_row(conn, id)? else {
        return Err(not_found());
    };
    let presented = digest(secret);
    let token_ok = constant_time_eq(presented.as_bytes(), stored_hash.as_bytes());
    let requester_ok = constant_time_eq(requester.as_bytes(), request.requester.as_bytes());
    if !(token_ok && requester_ok) {
        return Err(not_found());
    }
    Ok((request, stored_hash))
}

/// Redeem `token` for `requester`. Single use: the status flips from
/// `approved` to `redeemed` in one conditional `UPDATE`, so concurrent or
/// repeated redemptions of the same token fail. Every failure that could
/// reveal whether a token exists returns the same not-found error.
pub fn redeem(
    conn: &Connection,
    token: &str,
    requester: &str,
    now: i64,
) -> Result<ControlGroupRequest> {
    let (mut request, stored_hash) = verify_token(conn, token, requester)?;
    let changed = conn.execute(
        "UPDATE vault_control_groups SET status = 'redeemed', redeemed_at = ?1
         WHERE id = ?2 AND token_hash = ?3 AND status = 'approved' AND expires_at > ?1",
        params![now, request.id, stored_hash],
    )?;
    if changed != 1 {
        let status = if request.expires_at <= now {
            "expired".to_owned()
        } else {
            request.status.as_str().to_owned()
        };
        return Err(VaultError::Conflict(format!(
            "control-group request is {status}, not approved"
        ))
        .into());
    }
    request.status = ControlGroupStatus::Redeemed;
    request.redeemed_at = Some(now);
    Ok(request)
}

/// Undo a redemption whose value could not be released, so the approved
/// token stays usable until it expires.
pub fn unredeem(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE vault_control_groups SET status = 'approved', redeemed_at = NULL
         WHERE id = ?1 AND status = 'redeemed'",
        params![id],
    )?;
    Ok(())
}

/// Requests opened by or awaiting `subjects` (newest first, at most 100).
/// Every stored row is considered (pruning and the per-requester cap keep the
/// table bounded), so a flood of newer requests cannot hide older ones.
pub fn list_requests(
    conn: &Connection,
    subjects: &[String],
    include_all: bool,
    now: i64,
) -> Result<Vec<ControlGroupRequest>> {
    let mut stmt = conn.prepare("SELECT id FROM vault_control_groups ORDER BY created_at DESC")?;
    let ids: Vec<String> = stmt
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for id in ids {
        let Some(request) = get_request(conn, &id, now)? else {
            continue;
        };
        if include_all || subjects.contains(&request.requester) || request.is_approver(subjects) {
            out.push(request);
            if out.len() == MAX_LISTED_REQUESTS {
                break;
            }
        }
    }
    Ok(out)
}

/// Delete requests whose lifetime ended more than a day ago.
pub fn prune(conn: &Connection, now: i64) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM vault_control_groups WHERE expires_at <= ?1",
        params![now - 24 * 3600 * 1000],
    )?)
}

#[cfg(test)]
mod tests {
    use super::super::policy::{evaluate_with, CapabilitySet};
    use super::*;
    use serde_json::json;

    fn subjects(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    fn rule(path: &str, caps: &[Capability], deny: bool) -> PolicyRule {
        PolicyRule {
            path: path.into(),
            capabilities: caps.to_vec(),
            deny,
            ..PolicyRule::default()
        }
    }

    fn policy(name: &str, rules: Vec<PolicyRule>) -> Policy {
        Policy {
            name: name.into(),
            description: String::new(),
            rules,
        }
    }

    #[test]
    fn templates_validate_at_write_time() {
        assert!(validate_template("prod/{{identity.user.id}}/*").is_ok());
        assert!(validate_template("prod/u-{{ identity.user.id }}").is_ok());
        assert!(validate_template("prod/{{identity.secret}}").is_err());
        assert!(validate_template("prod/{{identity.user.id").is_err());
        assert!(validate_template("prod/{x}").is_err());
        assert!(validate_template("prod/}}").is_err());
        let mut bad = rule("prod/{{identity.nope}}", &[Capability::Read], false);
        assert!(super::super::policy::validate(&policy("p", vec![bad.clone()])).is_err());
        bad.path = "prod/{{identity.user.id}}".into();
        assert!(super::super::policy::validate(&policy("p", vec![bad])).is_ok());
    }

    #[test]
    fn templates_expand_only_safe_identity_values() {
        let ctx = TemplateContext::from_subjects(&subjects(&[
            "user:alice",
            "team:t1",
            "team:t2",
            "machine:../evil",
        ]));
        assert_eq!(
            expand("u/{{identity.user.id}}/*", &ctx),
            Expansion::Concrete(vec!["u/alice/*".into()])
        );
        assert_eq!(
            expand("t/{{identity.team.ids}}", &ctx),
            Expansion::Concrete(vec!["t/t1".into(), "t/t2".into()])
        );
        // Unsafe value is never substituted; the template is unresolved.
        assert_eq!(
            expand("m/{{identity.machine.id}}", &ctx),
            Expansion::Unresolved("m/*".into())
        );
        for value in ["*", "a/b", "..", "a?", "{x}", "", "a b"] {
            assert!(!is_safe_template_value(value), "{value}");
        }
    }

    #[test]
    fn unresolved_templates_fail_closed() {
        let policies = vec![
            policy(
                "own",
                vec![rule(
                    "users/{{identity.user.id}}/**",
                    &[Capability::Read],
                    false,
                )],
            ),
            policy(
                "block",
                vec![rule(
                    "prod/{{identity.machine.id}}",
                    &[Capability::Use],
                    true,
                )],
            ),
        ];
        let base: CapabilitySet = [Capability::Use].into_iter().collect();
        let alice = TemplateContext::from_subjects(&subjects(&["user:alice"]));
        assert!(
            evaluate_with(&base, &policies, "users/alice/KEY", &alice).contains(&Capability::Read)
        );
        assert!(
            !evaluate_with(&base, &policies, "users/bob/KEY", &alice).contains(&Capability::Read)
        );
        // No machine id: the deny widens to prod/* and removes `use`.
        assert!(!evaluate_with(&base, &policies, "prod/KEY", &alice).contains(&Capability::Use));
        let machine = TemplateContext::from_subjects(&subjects(&["machine:m1"]));
        assert!(evaluate_with(&base, &policies, "prod/KEY", &machine).contains(&Capability::Use));
        assert!(!evaluate_with(&base, &policies, "prod/m1", &machine).contains(&Capability::Use));
    }

    #[test]
    fn parameter_constraints_follow_openbao_semantics() {
        let mut writer = rule("prod/**", &[Capability::Write], false);
        writer.allowed_parameters = Some(BTreeMap::from([
            ("region".into(), vec!["eu-*".into(), "us-east".into()]),
            ("owner".into(), vec!["{{identity.user.id}}".into()]),
            ("note".into(), vec![]),
        ]));
        writer.denied_parameters = Some(BTreeMap::from([("region".into(), vec!["eu-dev".into()])]));
        writer.required_parameters = vec!["owner".into()];
        let policies = vec![policy("w", vec![writer])];
        super::super::policy::validate(&policies[0]).unwrap();
        let ctx = TemplateContext::from_subjects(&subjects(&["user:alice"]));
        let check = |params: Value| {
            let map: BTreeMap<String, Value> = serde_json::from_value(params).unwrap();
            check_parameters(&policies, "prod/KEY", Capability::Write, &ctx, &map)
        };
        assert!(check(json!({"owner": "alice", "region": "eu-west", "note": 1})).is_ok());
        assert!(check(json!({"owner": "alice", "region": "us-east"})).is_ok());
        assert!(check(json!({"owner": "bob"})).is_err());
        assert!(check(json!({"region": "eu-west"})).is_err());
        assert!(check(json!({"owner": "alice", "region": "eu-dev"})).is_err());
        assert!(check(json!({"owner": "alice", "region": "ap-south"})).is_err());
        assert!(check(json!({"owner": "alice", "extra": "x"})).is_err());
        // Other paths are unconstrained.
        let map = BTreeMap::from([("anything".to_owned(), json!("x"))]);
        assert!(check_parameters(&policies, "dev/KEY", Capability::Write, &ctx, &map).is_ok());

        let mut bad = rule("prod/**", &[Capability::Read], false);
        bad.required_parameters = vec!["x".into()];
        assert!(validate_rule(&bad).is_err());
    }

    fn gated_policies() -> Vec<Policy> {
        let mut gated = rule("prod/**", &[Capability::Read], false);
        gated.control_group = Some(ControlGroupSpec {
            ttl_secs: Some(3600),
            factors: vec![ControlGroupFactor {
                name: "security".into(),
                approvers: vec!["team:sec".into(), "user:carol".into()],
                approvals: 2,
            }],
        });
        vec![policy("prod-read", vec![gated])]
    }

    #[test]
    fn control_groups_require_distinct_non_requester_approvals_and_redeem_once() {
        let policies = gated_policies();
        super::super::policy::validate(&policies[0]).unwrap();
        let ctx = TemplateContext::default();
        let spec = control_group_for(&policies, "prod/KEY", Capability::Read, &ctx).unwrap();
        assert_eq!(spec.factors[0].name, "prod-read/0/security");
        assert!(control_group_for(&policies, "dev/KEY", Capability::Read, &ctx).is_none());
        assert!(read_gated_for_anyone(&policies, "prod/KEY"));
        assert!(!read_gated_for_anyone(&policies, "dev/KEY"));
        let mut templated = rule("dev/{{identity.user.id}}/**", &[Capability::Read], false);
        templated.control_group = policies[0].rules[0].control_group.clone();
        let templated = vec![policy("per-user", vec![templated])];
        assert!(read_gated_for_anyone(&templated, "dev/alice/KEY"));
        assert!(!read_gated_for_anyone(&templated, "prod/KEY"));

        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let now = 1_000_000;
        let (request, token) = create_request(
            &conn,
            "user:alice",
            "prod/KEY",
            &json!({"k": 1}),
            &spec,
            now,
        )
        .unwrap();
        // Not approved yet.
        assert!(redeem(&conn, &token, "user:alice", now + 1).is_err());
        // Requester cannot approve, even through a team.
        assert!(authorize(
            &conn,
            &request.id,
            "user:alice",
            &subjects(&["user:alice", "team:sec"]),
            now
        )
        .is_err());
        // Non-approver cannot approve.
        assert!(authorize(
            &conn,
            &request.id,
            "user:dave",
            &subjects(&["user:dave"]),
            now
        )
        .is_err());
        let one = authorize(
            &conn,
            &request.id,
            "user:bob",
            &subjects(&["user:bob", "team:sec"]),
            now,
        )
        .unwrap();
        assert_eq!(one.status, ControlGroupStatus::Pending);
        // The same approver twice does not count twice.
        let again = authorize(
            &conn,
            &request.id,
            "user:bob",
            &subjects(&["user:bob", "team:sec"]),
            now,
        )
        .unwrap();
        assert_eq!(again.status, ControlGroupStatus::Pending);
        let two = authorize(
            &conn,
            &request.id,
            "user:carol",
            &subjects(&["user:carol"]),
            now,
        )
        .unwrap();
        assert_eq!(two.status, ControlGroupStatus::Approved);

        // Wrong requester or tampered token: indistinguishable not-found.
        assert!(redeem(&conn, &token, "user:bob", now + 2).is_err());
        let tampered = format!("{}0", &token[..token.len() - 1]);
        assert!(redeem(&conn, &tampered, "user:alice", now + 2).is_err());
        assert!(redeem(&conn, "garbage", "user:alice", now + 2).is_err());

        let redeemed = redeem(&conn, &token, "user:alice", now + 3).unwrap();
        assert_eq!(redeemed.target, json!({"k": 1}));
        assert_eq!(redeemed.status, ControlGroupStatus::Redeemed);
        // Single use.
        assert!(redeem(&conn, &token, "user:alice", now + 4).is_err());
        assert!(authorize(
            &conn,
            &request.id,
            "user:carol",
            &subjects(&["user:carol"]),
            now + 4
        )
        .is_err());
    }

    #[test]
    fn control_groups_and_same_named_factors_across_rules_of_one_policy() {
        let factor = |approvers: &[&str], approvals: u8| ControlGroupSpec {
            ttl_secs: None,
            factors: vec![ControlGroupFactor {
                name: "approval".into(),
                approvers: approvers.iter().map(|s| (*s).to_owned()).collect(),
                approvals,
            }],
        };
        let mut broad = rule("prod/**", &[Capability::Read], false);
        broad.control_group = Some(factor(&["team:leads"], 1));
        let mut payments = rule("prod/payments/*", &[Capability::Read], false);
        payments.control_group = Some(factor(&["user:cfo", "user:ceo"], 2));
        let one = policy("prod-access", vec![broad, payments]);
        super::super::policy::validate(&one).unwrap();
        // The same policy reached twice (user + team binding) still collapses.
        let policies = vec![one.clone(), one];
        let ctx = TemplateContext::default();
        let spec = control_group_for(
            &policies,
            "prod/payments/STRIPE_KEY",
            Capability::Read,
            &ctx,
        )
        .unwrap();
        assert_eq!(spec.factors.len(), 2);

        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let now = 1_000_000;
        let (request, token) = create_request(
            &conn,
            "user:alice",
            "prod/payments/STRIPE_KEY",
            &json!({"k": 1}),
            &spec,
            now,
        )
        .unwrap();
        // One lead satisfies only the broad rule's factor.
        let lead = authorize(
            &conn,
            &request.id,
            "user:lee",
            &subjects(&["user:lee", "team:leads"]),
            now,
        )
        .unwrap();
        assert_eq!(lead.status, ControlGroupStatus::Pending);
        assert!(redeem(&conn, &token, "user:alice", now + 1).is_err());
        for approver in ["user:cfo", "user:ceo"] {
            authorize(&conn, &request.id, approver, &subjects(&[approver]), now).unwrap();
        }
        assert!(redeem(&conn, &token, "user:alice", now + 2).is_ok());
    }

    #[test]
    fn control_group_requests_expire() {
        let policies = gated_policies();
        let spec = control_group_for(
            &policies,
            "prod/KEY",
            Capability::Read,
            &TemplateContext::default(),
        )
        .unwrap();
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let (request, token) =
            create_request(&conn, "user:alice", "prod/KEY", &json!({}), &spec, 0).unwrap();
        authorize(&conn, &request.id, "user:bob", &subjects(&["team:sec"]), 1).unwrap();
        authorize(
            &conn,
            &request.id,
            "user:carol",
            &subjects(&["user:carol"]),
            2,
        )
        .unwrap();
        let after = 3600 * 1000 + 1;
        assert_eq!(
            get_request(&conn, &request.id, after)
                .unwrap()
                .unwrap()
                .status,
            ControlGroupStatus::Expired
        );
        assert!(redeem(&conn, &token, "user:alice", after).is_err());
        assert_eq!(prune(&conn, after + 24 * 3600 * 1000).unwrap(), 1);
    }

    #[test]
    fn control_group_specs_are_validated() {
        let mut gated = gated_policies().remove(0).rules.remove(0);
        gated.control_group.as_mut().unwrap().factors[0].approvers = vec!["group:x".into()];
        assert!(validate_rule(&gated).is_err());
        let mut no_read = gated_policies().remove(0).rules.remove(0);
        no_read.capabilities = vec![Capability::Use];
        assert!(validate_rule(&no_read).is_err());
        let mut short = gated_policies().remove(0).rules.remove(0);
        short.control_group.as_mut().unwrap().ttl_secs = Some(5);
        assert!(validate_rule(&short).is_err());
    }

    #[test]
    fn constant_time_compare() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
