//! Who a charge is attributed to, and recording it under every scope.

use super::OrgLimitContext;
use crate::budget::{BudgetScope, SpendStore};

/// Who a charge is attributed to for org limits: the org, the member (the
/// credential's bound owner, else the verified caller), each team scope, the
/// presenting `rgw_` credential, the service account that owns it, the
/// project, and the verified bot.
/// Carried on records that settle after the request context is gone (async
/// media jobs, external tool receipts) so those charges advance org caps too.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrgLimitSubject {
    pub org_id: String,
    pub user_id: Option<String>,
    pub team_ids: Vec<String>,
    pub credential_id: Option<String>,
    pub service_account_id: Option<String>,
    /// The caller's builder tags, carried onto the debit's attribution (the
    /// control plane's tag rollup reads them there).
    pub tags: Vec<String>,
    /// The tags among `tags` the org has a budget for; only these get a
    /// `tag` spend counter here. Counting every caller-chosen tag would let a
    /// caller grow the shared spend store without bound, and spend from
    /// before a budget existed comes from the control plane's rollup.
    pub budgeted_tags: Vec<String>,
    /// The request's project (see [`OrgLimitContext::project_id`]).
    pub project_id: Option<String>,
    /// The request's verified bot (see [`OrgLimitContext::bot_id`]).
    pub bot_id: Option<String>,
}

impl OrgLimitSubject {
    /// The subject of a request under `limit_ctx`, attributed to `user_id`.
    pub fn new(limit_ctx: &OrgLimitContext, user_id: Option<&str>) -> Self {
        Self {
            org_id: limit_ctx.org_id.clone(),
            user_id: limit_ctx.member(user_id).map(str::to_owned),
            team_ids: limit_ctx.team_ids.clone(),
            credential_id: limit_ctx.credential_id.clone(),
            service_account_id: limit_ctx.service_account_id.clone(),
            tags: limit_ctx.tags.clone(),
            budgeted_tags: limit_ctx
                .tags
                .iter()
                .filter(|tag| {
                    limit_ctx
                        .limits
                        .tags
                        .values()
                        .any(|limit| &limit.tag == *tag)
                })
                .cloned()
                .collect(),
            project_id: limit_ctx.project_id.clone(),
            bot_id: limit_ctx.bot_id.clone(),
        }
    }

    /// Every `(scope, store id)` this subject's spend is counted under. The
    /// store ids match [`OrgLimitContext::applicable`], so a cap configured
    /// later reads the same counters.
    fn scopes(&self) -> Vec<(BudgetScope, String)> {
        let mut scopes = vec![(BudgetScope::Org, self.org_id.clone())];
        if let Some(user) = self.user_id.as_deref() {
            scopes.push((BudgetScope::Member, format!("{}:{user}", self.org_id)));
        }
        for team in &self.team_ids {
            scopes.push((BudgetScope::Team, format!("{}:{team}", self.org_id)));
        }
        if let Some(key) = self.credential_id.as_deref() {
            scopes.push((BudgetScope::Key, key.to_owned()));
        }
        if let Some(account) = self.service_account_id.as_deref() {
            scopes.push((
                BudgetScope::ServiceAccount,
                format!("{}:{account}", self.org_id),
            ));
        }
        if let Some(project) = self.project_id.as_deref().filter(|id| !id.is_empty()) {
            scopes.push((BudgetScope::Project, format!("{}:{project}", self.org_id)));
        }
        if let Some(bot) = self.bot_id.as_deref().filter(|id| !id.is_empty()) {
            scopes.push((BudgetScope::Bot, format!("{}:{bot}", self.org_id)));
        }
        for tag in &self.budgeted_tags {
            scopes.push((BudgetScope::Tag, format!("{}:{tag}", self.org_id)));
        }
        scopes
    }
}

/// Add a charged amount to every attributable scope (org, member, each team,
/// key, service account, project, bot) in every window, whether or not a cap exists for it yet. Counting
/// continuously means a cap added mid-window sees the usage already spent in
/// that window instead of starting from zero.
pub fn record(
    store: &dyn SpendStore,
    limit_ctx: &OrgLimitContext,
    user_id: Option<&str>,
    amount: u64,
    now: i64,
) {
    record_subject(
        store,
        &OrgLimitSubject::new(limit_ctx, user_id),
        amount,
        now,
    );
}

/// [`record`] for a stored [`OrgLimitSubject`].
pub fn record_subject(store: &dyn SpendStore, subject: &OrgLimitSubject, amount: u64, now: i64) {
    if amount == 0 || subject.org_id.is_empty() {
        return;
    }
    for (scope, store_id) in subject.scopes() {
        store.add(scope.as_str(), &store_id, amount, now);
    }
}

/// Most team ids one debit carries (the control plane keeps at most 32).
const MAX_LEDGER_TEAM_IDS: usize = 32;

/// The scope ids a wallet debit carries so the control plane's ledger can
/// measure per-scope (and per-credit-source) spend (contract §3): the
/// presenting credential, the team scopes, the project and the verified bot.
/// Every field is optional on the wire and omitted when absent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LedgerScope {
    pub key_id: Option<String>,
    pub team_ids: Vec<String>,
    pub project_id: Option<String>,
    pub bot_id: Option<String>,
}

impl LedgerScope {
    /// The ledger ids of a stored subject (empty without one).
    pub fn of(subject: Option<&OrgLimitSubject>) -> Self {
        let Some(subject) = subject else {
            return Self::default();
        };
        Self {
            key_id: subject.credential_id.clone(),
            team_ids: subject
                .team_ids
                .iter()
                .take(MAX_LEDGER_TEAM_IDS)
                .cloned()
                .collect(),
            project_id: subject.project_id.clone(),
            bot_id: subject.bot_id.clone(),
        }
    }

    /// The ledger ids of a request context.
    pub fn for_request(ctx: &crate::pipeline::RequestContext) -> Self {
        Self::of(super::subject_for(ctx).as_ref())
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::context;
    use super::super::OrgLimits;
    use super::*;

    #[test]
    fn ledger_scope_carries_the_subject_ids_and_caps_teams() {
        assert_eq!(LedgerScope::of(None), LedgerScope::default());
        let teams: Vec<String> = (0..40).map(|n| format!("t{n}")).collect();
        let team_refs: Vec<&str> = teams.iter().map(String::as_str).collect();
        let mut limit_ctx = context(OrgLimits::default(), &team_refs);
        limit_ctx.project_id = Some("proj_1".to_owned());
        limit_ctx.bot_id = Some("ma:a1".to_owned());
        let subject = OrgLimitSubject::new(&limit_ctx, Some("u1"));
        let scope = LedgerScope::of(Some(&subject));
        assert_eq!(scope.key_id.as_deref(), Some("cred1"));
        assert_eq!(scope.team_ids.len(), MAX_LEDGER_TEAM_IDS);
        assert_eq!(scope.project_id.as_deref(), Some("proj_1"));
        assert_eq!(scope.bot_id.as_deref(), Some("ma:a1"));
    }
}
