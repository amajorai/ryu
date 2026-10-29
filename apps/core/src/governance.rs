use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// The four configuration layers shown in Gateway settings, ordered from the
/// node-wide fallback to the current user's most-specific override.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GovernanceScope {
    Node,
    Organization,
    Team,
    User,
}

/// One optional field value contributed by a governance layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopedValue<T> {
    pub scope: GovernanceScope,
    pub value: Option<T>,
}

impl<T> ScopedValue<T> {
    pub fn new(scope: GovernanceScope, value: Option<T>) -> Self {
        Self { scope, value }
    }
}

/// A resolved field together with the layer that supplied it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedValue<T> {
    pub source: GovernanceScope,
    pub value: T,
}

/// Resolve one field from broadest to most specific. `None` means inherit;
/// `Some(false)` remains a declared value and therefore wins normally.
pub fn resolve_field<T>(
    layers: impl IntoIterator<Item = ScopedValue<T>>,
) -> Option<ResolvedValue<T>> {
    layers.into_iter().fold(None, |resolved, layer| {
        layer.value.map_or(resolved, |value| {
            Some(ResolvedValue {
                source: layer.scope,
                value,
            })
        })
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitMergeMethod {
    Merge,
    Squash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDelivery {
    Inline,
    Detached,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookPolicyOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trusted: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_method: Option<GitMergeMethod>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub always_force_push: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_draft_pull_requests: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_delivery: Option<ReviewDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_merge_when_ready: Option<bool>,
    /// Start a turn in the linked chat when new review feedback lands on one
    /// of its pull requests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_address_pull_request_comments: Option<bool>,
    /// Archive a chat once every pull request linked to it is merged or closed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_archive_closed_pull_request_chats: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request_instructions: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetch_upstream: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_delete: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_delete_limit: Option<u16>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayGovernanceValues {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub hooks: BTreeMap<String, HookPolicyOverride>,
    #[serde(default)]
    pub git: GitSettings,
    #[serde(default)]
    pub worktrees: WorktreeSettings,
    /// Field paths this layer locks against every more specific layer, e.g.
    /// `git.branchPrefix`, `worktrees.autoDelete`, or `hooks.<hookKey>`.
    /// Mirrors the control-plane policy model's `lockedFields`: only the
    /// organization and team layers may lock, and a locked field keeps the
    /// value resolved at (or above) the locking layer.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locked_fields: Vec<String>,
}

/// Git fields an organization or team may lock (`git.<field>`).
pub const LOCKABLE_GIT_FIELDS: &[&str] = &[
    "branchPrefix",
    "mergeMethod",
    "alwaysForcePush",
    "createDraftPullRequests",
    "reviewDelivery",
    "autoMergeWhenReady",
    "autoAddressPullRequestComments",
    "autoArchiveClosedPullRequestChats",
    "watchInstructions",
    "commitInstructions",
    "pullRequestInstructions",
];

/// Worktree fields an organization or team may lock (`worktrees.<field>`).
/// The worktree root is node-only and therefore never lockable.
pub const LOCKABLE_WORKTREE_FIELDS: &[&str] = &["fetchUpstream", "autoDelete", "autoDeleteLimit"];

/// Whether `path` names a field a managed layer may lock.
pub fn is_lockable_field(path: &str) -> bool {
    if let Some(field) = path.strip_prefix("git.") {
        return LOCKABLE_GIT_FIELDS.contains(&field);
    }
    if let Some(field) = path.strip_prefix("worktrees.") {
        return LOCKABLE_WORKTREE_FIELDS.contains(&field);
    }
    path.strip_prefix("hooks.")
        .is_some_and(|hook| !hook.trim().is_empty() && hook.len() <= 512)
}

/// Paths that `values` sets, in the same vocabulary as `locked_fields`.
pub fn declared_field_paths(values: &GatewayGovernanceValues) -> Vec<String> {
    let mut paths = Vec::new();
    let git = &values.git;
    let git_fields = [
        ("branchPrefix", git.branch_prefix.is_some()),
        ("mergeMethod", git.merge_method.is_some()),
        ("alwaysForcePush", git.always_force_push.is_some()),
        (
            "createDraftPullRequests",
            git.create_draft_pull_requests.is_some(),
        ),
        ("reviewDelivery", git.review_delivery.is_some()),
        ("autoMergeWhenReady", git.auto_merge_when_ready.is_some()),
        (
            "autoAddressPullRequestComments",
            git.auto_address_pull_request_comments.is_some(),
        ),
        (
            "autoArchiveClosedPullRequestChats",
            git.auto_archive_closed_pull_request_chats.is_some(),
        ),
        ("watchInstructions", git.watch_instructions.is_some()),
        ("commitInstructions", git.commit_instructions.is_some()),
        (
            "pullRequestInstructions",
            git.pull_request_instructions.is_some(),
        ),
    ];
    paths.extend(
        git_fields
            .into_iter()
            .filter(|(_, set)| *set)
            .map(|(field, _)| format!("git.{field}")),
    );
    let worktrees = &values.worktrees;
    let worktree_fields = [
        ("fetchUpstream", worktrees.fetch_upstream.is_some()),
        ("autoDelete", worktrees.auto_delete.is_some()),
        ("autoDeleteLimit", worktrees.auto_delete_limit.is_some()),
    ];
    paths.extend(
        worktree_fields
            .into_iter()
            .filter(|(_, set)| *set)
            .map(|(field, _)| format!("worktrees.{field}")),
    );
    paths.extend(
        values
            .hooks
            .iter()
            .filter(|(_, hook)| hook.enabled.is_some() || hook.trusted.is_some())
            .map(|(key, _)| format!("hooks.{key}")),
    );
    paths
}

fn overlay_option<T: Clone>(
    target: &mut Option<T>,
    incoming: &Option<T>,
    locked: &BTreeSet<String>,
    path: &str,
) {
    if locked.contains(path) {
        return;
    }
    if let Some(value) = incoming {
        *target = Some(value.clone());
    }
}

fn overlay_values(
    target: &mut GatewayGovernanceValues,
    incoming: &GatewayGovernanceValues,
    locked: &BTreeSet<String>,
) {
    for (hook_key, hook_override) in &incoming.hooks {
        let path = format!("hooks.{hook_key}");
        if locked.contains(&path) {
            continue;
        }
        let target_override = target.hooks.entry(hook_key.clone()).or_default();
        overlay_option(
            &mut target_override.enabled,
            &hook_override.enabled,
            locked,
            &path,
        );
        overlay_option(
            &mut target_override.trusted,
            &hook_override.trusted,
            locked,
            &path,
        );
    }

    let incoming_git = &incoming.git;
    let target_git = &mut target.git;
    let git_pairs: [(&mut Option<String>, &Option<String>, &str); 4] = [
        (
            &mut target_git.branch_prefix,
            &incoming_git.branch_prefix,
            "git.branchPrefix",
        ),
        (
            &mut target_git.watch_instructions,
            &incoming_git.watch_instructions,
            "git.watchInstructions",
        ),
        (
            &mut target_git.commit_instructions,
            &incoming_git.commit_instructions,
            "git.commitInstructions",
        ),
        (
            &mut target_git.pull_request_instructions,
            &incoming_git.pull_request_instructions,
            "git.pullRequestInstructions",
        ),
    ];
    for (target_field, incoming_field, path) in git_pairs {
        overlay_option(target_field, incoming_field, locked, path);
    }
    overlay_option(
        &mut target_git.merge_method,
        &incoming_git.merge_method,
        locked,
        "git.mergeMethod",
    );
    overlay_option(
        &mut target_git.review_delivery,
        &incoming_git.review_delivery,
        locked,
        "git.reviewDelivery",
    );
    let git_flags: [(&mut Option<bool>, &Option<bool>, &str); 5] = [
        (
            &mut target_git.always_force_push,
            &incoming_git.always_force_push,
            "git.alwaysForcePush",
        ),
        (
            &mut target_git.create_draft_pull_requests,
            &incoming_git.create_draft_pull_requests,
            "git.createDraftPullRequests",
        ),
        (
            &mut target_git.auto_merge_when_ready,
            &incoming_git.auto_merge_when_ready,
            "git.autoMergeWhenReady",
        ),
        (
            &mut target_git.auto_address_pull_request_comments,
            &incoming_git.auto_address_pull_request_comments,
            "git.autoAddressPullRequestComments",
        ),
        (
            &mut target_git.auto_archive_closed_pull_request_chats,
            &incoming_git.auto_archive_closed_pull_request_chats,
            "git.autoArchiveClosedPullRequestChats",
        ),
    ];
    for (target_field, incoming_field, path) in git_flags {
        overlay_option(target_field, incoming_field, locked, path);
    }

    let worktrees = &incoming.worktrees;
    let target_worktrees = &mut target.worktrees;
    // The root is node-only and never lockable; managed layers cannot carry it.
    overlay_option(
        &mut target_worktrees.root,
        &worktrees.root,
        locked,
        "worktrees.root",
    );
    overlay_option(
        &mut target_worktrees.fetch_upstream,
        &worktrees.fetch_upstream,
        locked,
        "worktrees.fetchUpstream",
    );
    overlay_option(
        &mut target_worktrees.auto_delete,
        &worktrees.auto_delete,
        locked,
        "worktrees.autoDelete",
    );
    overlay_option(
        &mut target_worktrees.auto_delete_limit,
        &worktrees.auto_delete_limit,
        locked,
        "worktrees.autoDeleteLimit",
    );
}

fn lockable_set(values: Option<&GatewayGovernanceValues>) -> BTreeSet<String> {
    values
        .map(|values| {
            values
                .locked_fields
                .iter()
                .filter(|path| is_lockable_field(path))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// Fields the organization and team layers lock against the user layer.
pub fn managed_locks(
    organization: Option<&GatewayGovernanceValues>,
    team: Option<&GatewayGovernanceValues>,
) -> BTreeSet<String> {
    let mut locks = lockable_set(organization);
    locks.extend(lockable_set(team));
    locks
}

/// Merge the four layers from broadest to most specific. A more specific layer
/// overrides a less specific one field-by-field, except that a field locked by
/// the organization layer cannot be changed by the team or user layer, and a
/// field locked by the team layer cannot be changed by the user layer. The
/// node layer cannot lock (it is the fallback below the organization). The
/// result's `locked_fields` lists every lock that applied.
pub fn merge_governance_layers(
    node: &GatewayGovernanceValues,
    organization: Option<&GatewayGovernanceValues>,
    team: Option<&GatewayGovernanceValues>,
    user: Option<&GatewayGovernanceValues>,
) -> GatewayGovernanceValues {
    let mut effective = node.clone();
    effective.locked_fields.clear();
    let no_locks = BTreeSet::new();
    let organization_locks = lockable_set(organization);
    let all_locks = managed_locks(organization, team);
    if let Some(layer) = organization {
        overlay_values(&mut effective, layer, &no_locks);
    }
    if let Some(layer) = team {
        overlay_values(&mut effective, layer, &organization_locks);
    }
    if let Some(layer) = user {
        overlay_values(&mut effective, layer, &all_locks);
    }
    effective.locked_fields = all_locks.into_iter().collect();
    effective
}

/// Remove the value at `path` (a [`declared_field_paths`] entry) from `values`.
pub fn clear_field_path(values: &mut GatewayGovernanceValues, path: &str) {
    if let Some(hook) = path.strip_prefix("hooks.") {
        values.hooks.remove(hook);
        return;
    }
    let git = &mut values.git;
    let worktrees = &mut values.worktrees;
    match path {
        "git.branchPrefix" => git.branch_prefix = None,
        "git.mergeMethod" => git.merge_method = None,
        "git.alwaysForcePush" => git.always_force_push = None,
        "git.createDraftPullRequests" => git.create_draft_pull_requests = None,
        "git.reviewDelivery" => git.review_delivery = None,
        "git.autoMergeWhenReady" => git.auto_merge_when_ready = None,
        "git.autoAddressPullRequestComments" => git.auto_address_pull_request_comments = None,
        "git.autoArchiveClosedPullRequestChats" => {
            git.auto_archive_closed_pull_request_chats = None;
        }
        "git.watchInstructions" => git.watch_instructions = None,
        "git.commitInstructions" => git.commit_instructions = None,
        "git.pullRequestInstructions" => git.pull_request_instructions = None,
        "worktrees.fetchUpstream" => worktrees.fetch_upstream = None,
        "worktrees.autoDelete" => worktrees.auto_delete = None,
        "worktrees.autoDeleteLimit" => worktrees.auto_delete_limit = None,
        _ => {}
    }
}

/// Locks published by the last applied managed governance document:
/// (organization locks, team locks). Read by runtime resolvers that do not
/// go through [`merge_governance_layers`], such as plugin hook overrides.
static MANAGED_LOCKS: std::sync::RwLock<(BTreeSet<String>, BTreeSet<String>)> =
    std::sync::RwLock::new((BTreeSet::new(), BTreeSet::new()));

/// Publish the managed layers' locks for runtime resolvers.
pub fn set_managed_locks(organization: &GatewayGovernanceValues, team: &GatewayGovernanceValues) {
    if let Ok(mut locks) = MANAGED_LOCKS.write() {
        *locks = (lockable_set(Some(organization)), lockable_set(Some(team)));
    }
}

/// Whether a value declared at `scope` for `path` must be ignored because a
/// broader managed layer locked it.
pub fn locked_above(scope: GovernanceScope, path: &str) -> bool {
    let Ok(locks) = MANAGED_LOCKS.read() else {
        return false;
    };
    let (organization, team) = &*locks;
    match scope {
        GovernanceScope::Node | GovernanceScope::Organization => false,
        GovernanceScope::Team => organization.contains(path),
        GovernanceScope::User => organization.contains(path) || team.contains(path),
    }
}

pub fn validate_governance_values(
    scope: GovernanceScope,
    values: &GatewayGovernanceValues,
) -> Result<(), String> {
    if scope != GovernanceScope::Node && values.worktrees.root.is_some() {
        return Err("worktree root is node-only".to_owned());
    }
    if let Some(prefix) = values.git.branch_prefix.as_deref() {
        if prefix.len() > 80 || prefix.chars().any(char::is_whitespace) || prefix.contains("..") {
            return Err(
                "branch prefix must be at most 80 characters with no whitespace or '..'".to_owned(),
            );
        }
    }
    if let Some(limit) = values.worktrees.auto_delete_limit {
        if !(1..=100).contains(&limit) {
            return Err("worktree auto-delete limit must be between 1 and 100".to_owned());
        }
    }
    for hook_key in values.hooks.keys() {
        if hook_key.trim().is_empty() || hook_key.len() > 512 {
            return Err("hook keys must be between 1 and 512 characters".to_owned());
        }
    }
    if !values.locked_fields.is_empty() {
        if !matches!(scope, GovernanceScope::Organization | GovernanceScope::Team) {
            return Err("only organization and team policy can lock fields".to_owned());
        }
        if let Some(path) = values
            .locked_fields
            .iter()
            .find(|path| !is_lockable_field(path))
        {
            return Err(format!("'{path}' is not a lockable governance field"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        merge_governance_layers, resolve_field, validate_governance_values,
        GatewayGovernanceValues, GitSettings, GovernanceScope, ScopedValue, WorktreeSettings,
    };

    #[test]
    fn explicit_false_at_user_scope_beats_broader_true() {
        let resolved = resolve_field([
            ScopedValue::new(GovernanceScope::Node, Some(true)),
            ScopedValue::new(GovernanceScope::Organization, Some(true)),
            ScopedValue::new(GovernanceScope::Team, None),
            ScopedValue::new(GovernanceScope::User, Some(false)),
        ])
        .expect("a user override resolves");

        assert!(!resolved.value);
        assert_eq!(resolved.source, GovernanceScope::User);
    }

    #[test]
    fn absent_specific_values_inherit_the_broadest_declared_value() {
        let resolved = resolve_field([
            ScopedValue::new(GovernanceScope::Node, Some("node/")),
            ScopedValue::new(GovernanceScope::Organization, Some("org/")),
            ScopedValue::new(GovernanceScope::Team, None),
            ScopedValue::new(GovernanceScope::User, None),
        ])
        .expect("an organization value resolves");

        assert_eq!(resolved.value, "org/");
        assert_eq!(resolved.source, GovernanceScope::Organization);
    }

    #[test]
    fn field_level_merge_keeps_unrelated_team_and_user_choices() {
        let node = GatewayGovernanceValues {
            git: GitSettings {
                branch_prefix: Some("node/".to_owned()),
                create_draft_pull_requests: Some(false),
                ..GitSettings::default()
            },
            worktrees: WorktreeSettings {
                auto_delete: Some(false),
                auto_delete_limit: Some(15),
                ..WorktreeSettings::default()
            },
            ..GatewayGovernanceValues::default()
        };
        let organization = GatewayGovernanceValues {
            git: GitSettings {
                create_draft_pull_requests: Some(true),
                ..GitSettings::default()
            },
            ..GatewayGovernanceValues::default()
        };
        let team = GatewayGovernanceValues {
            git: GitSettings {
                branch_prefix: Some("team/".to_owned()),
                ..GitSettings::default()
            },
            worktrees: WorktreeSettings {
                auto_delete: Some(true),
                ..WorktreeSettings::default()
            },
            ..GatewayGovernanceValues::default()
        };
        let user = GatewayGovernanceValues {
            git: GitSettings {
                create_draft_pull_requests: Some(false),
                ..GitSettings::default()
            },
            ..GatewayGovernanceValues::default()
        };

        let effective =
            merge_governance_layers(&node, Some(&organization), Some(&team), Some(&user));

        assert_eq!(effective.git.branch_prefix.as_deref(), Some("team/"));
        assert_eq!(effective.git.create_draft_pull_requests, Some(false));
        assert_eq!(effective.worktrees.auto_delete, Some(true));
        assert_eq!(effective.worktrees.auto_delete_limit, Some(15));
    }

    #[test]
    fn organization_locks_beat_team_and_user_overrides() {
        let node = GatewayGovernanceValues::default();
        let organization = GatewayGovernanceValues {
            git: GitSettings {
                branch_prefix: Some("org/".to_owned()),
                ..GitSettings::default()
            },
            locked_fields: vec![
                "git.branchPrefix".to_owned(),
                "worktrees.autoDelete".to_owned(),
            ],
            ..GatewayGovernanceValues::default()
        };
        let team = GatewayGovernanceValues {
            git: GitSettings {
                branch_prefix: Some("team/".to_owned()),
                merge_method: Some(crate::governance::GitMergeMethod::Squash),
                ..GitSettings::default()
            },
            locked_fields: vec!["git.mergeMethod".to_owned()],
            ..GatewayGovernanceValues::default()
        };
        let user = GatewayGovernanceValues {
            git: GitSettings {
                branch_prefix: Some("me/".to_owned()),
                merge_method: Some(crate::governance::GitMergeMethod::Merge),
                create_draft_pull_requests: Some(false),
                ..GitSettings::default()
            },
            worktrees: WorktreeSettings {
                auto_delete: Some(false),
                ..WorktreeSettings::default()
            },
            ..GatewayGovernanceValues::default()
        };

        let effective =
            merge_governance_layers(&node, Some(&organization), Some(&team), Some(&user));

        assert_eq!(effective.git.branch_prefix.as_deref(), Some("org/"));
        assert_eq!(
            effective.git.merge_method,
            Some(crate::governance::GitMergeMethod::Squash)
        );
        assert_eq!(effective.git.create_draft_pull_requests, Some(false));
        // Locked without a value: the user cannot set it; it stays inherited.
        assert_eq!(effective.worktrees.auto_delete, None);
        assert_eq!(
            effective.locked_fields,
            vec![
                "git.branchPrefix".to_owned(),
                "git.mergeMethod".to_owned(),
                "worktrees.autoDelete".to_owned()
            ]
        );
    }

    #[test]
    fn only_managed_layers_may_lock_known_fields() {
        let values = GatewayGovernanceValues {
            locked_fields: vec!["git.branchPrefix".to_owned()],
            ..GatewayGovernanceValues::default()
        };
        assert!(validate_governance_values(GovernanceScope::Organization, &values).is_ok());
        assert!(validate_governance_values(GovernanceScope::User, &values).is_err());
        let unknown = GatewayGovernanceValues {
            locked_fields: vec!["worktrees.root".to_owned()],
            ..GatewayGovernanceValues::default()
        };
        assert!(validate_governance_values(GovernanceScope::Team, &unknown).is_err());
        assert!(
            crate::governance::declared_field_paths(&GatewayGovernanceValues {
                git: GitSettings {
                    branch_prefix: Some("x/".to_owned()),
                    ..GitSettings::default()
                },
                ..GatewayGovernanceValues::default()
            })
            .contains(&"git.branchPrefix".to_owned())
        );
    }

    #[test]
    fn managed_layers_cannot_distribute_a_worktree_root() {
        let values = GatewayGovernanceValues {
            worktrees: WorktreeSettings {
                root: Some("/srv/shared".to_owned()),
                ..WorktreeSettings::default()
            },
            ..GatewayGovernanceValues::default()
        };

        let error = validate_governance_values(GovernanceScope::Organization, &values)
            .expect_err("managed absolute roots are node-local");

        assert_eq!(error, "worktree root is node-only");
    }
}
