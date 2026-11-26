//! Custom account pools at selection time: the restriction on a provider's
//! policy and the shared rotation cursor under it.
use std::collections::BTreeSet;
use std::sync::Arc;

use super::model::Catalog;
use super::scope;
use super::tests::account;
use crate::pi_config::sdk_account_routing::AccountChooser;
use crate::server::oauth_pool_policy::{AccountRule, Policy, Strategy};
use crate::server::oauth_pool_usage::{Candidate, PoolCursor};

const CLAUDE: &str = "claude-pro-max";
const ALL: [&str; 4] = ["a", "b", "c", "d"];
const STRATEGIES: [Strategy; 5] = [
    Strategy::Manual,
    Strategy::RoundRobin,
    Strategy::QuotaFirst,
    Strategy::FillFirst,
    Strategy::ResetFirst,
];

fn pooled(strategy: Strategy, members: &[&str]) -> Policy {
    Policy {
        strategy,
        pool: Some(Arc::new(
            members
                .iter()
                .map(|id| (*id).to_owned())
                .collect::<BTreeSet<_>>(),
        )),
        ..Policy::default()
    }
}

fn candidates<'a>(ids: &'a [&'a str]) -> Vec<Candidate<'a>> {
    ids.iter()
        .map(|id| Candidate {
            account_id: id,
            revision: b"generation",
        })
        .collect()
}

/// What a native proxy does for a new or released session: offer the accounts
/// that are not cooling, and take the cursor's choice.
fn choose(
    cursor: &mut PoolCursor,
    ready: &[&str],
    active: &str,
    policy: &Policy,
) -> Option<String> {
    cursor
        .select("pool-test-provider", &candidates(ready), active, policy)
        .map(|index| ready[index].to_owned())
}

pub(super) fn mythos_catalog() -> Catalog {
    let mut catalog = Catalog::default();
    let pool = catalog
        .create(
            "Mythos",
            vec![
                account(CLAUDE, "b"),
                account(CLAUDE, "d"),
                account("kiro", "k"),
            ],
        )
        .unwrap();
    catalog.assign("security", Some(&pool.id)).unwrap();
    catalog
}

#[test]
fn every_strategy_chooses_only_accounts_of_the_pool() {
    for strategy in STRATEGIES {
        let policy = pooled(strategy, &["b", "d"]);
        let mut cursor = PoolCursor::default();
        for _ in 0..8 {
            let chosen = choose(&mut cursor, &ALL, "a", &policy).unwrap();
            assert!(
                ["b", "d"].contains(&chosen.as_str()),
                "{strategy:?}: {chosen}"
            );
        }
    }
    // Round robin walks the whole pool, and nothing but the pool.
    let policy = pooled(Strategy::RoundRobin, &["b", "d"]);
    let mut cursor = PoolCursor::default();
    let walked: Vec<_> = (0..4)
        .map(|_| choose(&mut cursor, &ALL, "a", &policy).unwrap())
        .collect();
    assert_eq!(walked, ["b", "d", "b", "d"]);
}

#[test]
fn nothing_is_chosen_when_every_pool_account_is_cooling_or_signed_out() {
    // The proxies leave cooling and signed-out accounts out of the offer.
    let ready = ["a", "c"];
    for strategy in STRATEGIES {
        let policy = pooled(strategy, &["b", "d"]);
        let mut cursor = PoolCursor::default();
        assert_eq!(
            choose(&mut cursor, &ready, "a", &policy),
            None,
            "{strategy:?}"
        );
        // Not "every account is disabled": two pool accounts exist, so the
        // proxy answers as it does today when all accounts are cooling.
        assert!(ALL.iter().any(|id| policy.allowed(id)));
    }
    let mut chooser = AccountChooser::default();
    let policy = pooled(Strategy::RoundRobin, &["b", "d"]);
    assert_eq!(
        chooser.select("openai", &ready, Some("a"), &policy),
        Ok(None)
    );
}

#[test]
fn an_account_outside_the_pool_is_not_allowed_so_its_binding_is_released() {
    // Every proxy keeps a session on its bound account only while
    // `policy.allowed` holds for it, then chooses again.
    let mut policy = pooled(Strategy::RoundRobin, &["b", "d"]);
    assert!(!policy.allowed("a"));
    assert!(policy.enabled("a"), "the account's own switch is untouched");
    assert!(!policy.in_pool("a"));
    assert!(policy.allowed("b"));
    let mut cursor = PoolCursor::default();
    assert_eq!(
        choose(&mut cursor, &ALL, "a", &policy).as_deref(),
        Some("b")
    );
    // The provider's own rules still apply inside the pool.
    policy.accounts.insert(
        "b".to_owned(),
        AccountRule {
            enabled: false,
            priority: 0,
            drain_threshold_percent: None,
        },
    );
    assert!(policy.in_pool("b") && !policy.allowed("b"));
    for _ in 0..3 {
        assert_eq!(
            choose(&mut cursor, &ALL, "a", &policy).as_deref(),
            Some("d")
        );
    }
}

#[test]
fn manual_uses_the_active_account_when_the_pool_holds_it() {
    let policy = pooled(Strategy::Manual, &["b", "d"]);
    let mut cursor = PoolCursor::default();
    assert_eq!(
        choose(&mut cursor, &ALL, "d", &policy).as_deref(),
        Some("d")
    );
    assert_eq!(
        choose(&mut cursor, &ALL, "a", &policy).as_deref(),
        Some("b")
    );
    let mut chooser = AccountChooser::default();
    assert_eq!(
        chooser.select("openai", &ALL, Some("d"), &policy),
        Ok(Some("d".to_owned()))
    );
    assert_eq!(
        chooser.select("openai", &ALL, Some("a"), &policy),
        Ok(Some("b".to_owned()))
    );
}

#[test]
fn an_agent_without_a_pool_chooses_as_before() {
    let catalog = mythos_catalog();
    let mut policy = Policy {
        strategy: Strategy::RoundRobin,
        ..Policy::default()
    };
    scope::restrict_with(
        &catalog,
        &mut policy,
        "writer",
        |p| p == CLAUDE,
        None,
        false,
    );
    assert!(policy.pool.is_none());
    let mut cursor = PoolCursor::default();
    let walked: Vec<_> = (0..4)
        .map(|_| choose(&mut cursor, &ALL, "a", &policy).unwrap())
        .collect();
    assert_eq!(walked, ALL);
}

#[test]
fn a_provider_the_pool_holds_no_account_of_is_left_as_it_was() {
    let catalog = mythos_catalog();
    let mut policy = Policy::default();
    scope::restrict_with(
        &catalog,
        &mut policy,
        "security",
        |p| p == "chatgpt",
        None,
        false,
    );
    assert!(policy.pool.is_none());
    assert_eq!(policy.strategy, Strategy::Manual);
    assert!(policy.allowed("anything"));

    scope::restrict_with(
        &catalog,
        &mut policy,
        "security",
        |p| p == CLAUDE,
        None,
        false,
    );
    let members: Vec<_> = policy.pool.as_deref().unwrap().iter().cloned().collect();
    assert_eq!(
        members,
        ["b", "d"],
        "the kiro member is not a Claude account"
    );
}

#[test]
fn a_member_that_is_no_longer_saved_does_not_count() {
    let catalog = mythos_catalog();
    let saved = |ids: &[&str]| -> Vec<(String, bool)> {
        ids.iter().map(|id| ((*id).to_owned(), false)).collect()
    };
    let mut policy = Policy::default();
    let listed = saved(&["a", "b"]);
    scope::restrict_with(
        &catalog,
        &mut policy,
        "security",
        |p| p == CLAUDE,
        Some(&listed),
        false,
    );
    let members: Vec<_> = policy.pool.as_deref().unwrap().iter().cloned().collect();
    assert_eq!(members, ["b"]);

    // Every Claude account of the pool was removed: the pool holds none.
    let mut policy = Policy::default();
    let listed = saved(&["a", "c"]);
    scope::restrict_with(
        &catalog,
        &mut policy,
        "security",
        |p| p == CLAUDE,
        Some(&listed),
        false,
    );
    assert!(policy.pool.is_none());
}

#[test]
fn a_manual_only_proxy_rotates_inside_the_pool_when_the_active_account_is_outside() {
    let catalog = mythos_catalog();
    let restrict = |strategy: Strategy, active: &str| {
        let listed: Vec<(String, bool)> = ALL
            .iter()
            .map(|id| ((*id).to_owned(), *id == active))
            .collect();
        let mut policy = Policy {
            strategy,
            ..Policy::default()
        };
        scope::restrict_with(
            &catalog,
            &mut policy,
            "security",
            |p| p == CLAUDE,
            Some(&listed),
            true,
        );
        policy.strategy
    };
    assert_eq!(restrict(Strategy::Manual, "a"), Strategy::RoundRobin);
    assert_eq!(restrict(Strategy::Manual, "d"), Strategy::Manual);
    assert_eq!(restrict(Strategy::RoundRobin, "a"), Strategy::RoundRobin);
}
