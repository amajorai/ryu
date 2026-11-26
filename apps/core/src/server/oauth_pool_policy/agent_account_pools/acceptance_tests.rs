//! The owner's case on the selection side: ten saved Claude accounts, five of
//! them in the Security agent's pool. When a pool account runs out of usage
//! the next choice is one of the other four pool accounts, and when all five
//! are out the request gets no account at all, whatever is left outside.
use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use serde_json::json;

use super::tests::{account, preferences};
use super::{scope, store};
use crate::pi_config::accounts::{self, AccountVault};
use crate::server::oauth_pool_policy::{self, Policy, Strategy};
use crate::server::oauth_pool_usage::{self, Candidate, PoolCursor};
use crate::server::preferences::PreferencesStore;

const CLAUDE: &str = "claude-pro-max";
const REVISION: &[u8] = b"generation";
const STRATEGIES: [Strategy; 5] = [
    Strategy::Manual,
    Strategy::RoundRobin,
    Strategy::QuotaFirst,
    Strategy::FillFirst,
    Strategy::ResetFirst,
];

/// The account choice of a native provider proxy (`select_with_policy` in
/// `claude_api.rs` and its twins), step for step. A session keeps its account
/// while the policy allows it and it is not cooling. Otherwise the session is
/// released and the shared cursor chooses among the accounts not cooling.
#[derive(Default)]
struct Proxy {
    cursor: PoolCursor,
    sessions: BTreeMap<String, String>,
    cooling: BTreeSet<String>,
}

impl Proxy {
    fn select(
        &mut self,
        session: &str,
        saved: &[String],
        active: &str,
        policy: &Policy,
    ) -> Option<String> {
        if let Some(bound) = self.sessions.get(session) {
            if saved.contains(bound) && policy.allowed(bound) && !self.cooling.contains(bound) {
                return Some(bound.clone());
            }
        }
        self.sessions.remove(session);
        let ready: Vec<&str> = saved
            .iter()
            .map(String::as_str)
            .filter(|id| !self.cooling.contains(*id))
            .collect();
        let offered: Vec<Candidate<'_>> = ready
            .iter()
            .map(|id| Candidate {
                account_id: id,
                revision: REVISION,
            })
            .collect();
        let chosen = self
            .cursor
            .select(CLAUDE, &offered, active, policy)
            .map(|index| ready[index].to_owned())?;
        self.sessions.insert(session.to_owned(), chosen.clone());
        Some(chosen)
    }

    /// The account answered "out of usage": the proxy releases the session
    /// and leaves the account out until its limit resets.
    fn ran_out(&mut self, session: &str, account: &str) {
        self.sessions.remove(session);
        self.cooling.insert(account.to_owned());
    }
}

struct Setup {
    _directory: tempfile::TempDir,
    preferences: PreferencesStore,
    /// All ten saved accounts, in the order the vault lists them.
    saved: Vec<String>,
    /// The five accounts of the Security agent's pool.
    pool: Vec<String>,
    /// The five accounts no pool holds. The first is the active account.
    outside: Vec<String>,
}

async fn ten_accounts_five_in_the_security_pool(vault: &AccountVault) -> Setup {
    let prefix = uuid::Uuid::new_v4().simple().to_string();
    let saved: Vec<String> = (1..=10).map(|n| format!("{prefix}-{n:02}")).collect();
    let claude = crate::pi_config::provider_account_scope(CLAUDE).unwrap();
    for id in &saved {
        vault
            .upsert(
                &claude,
                id,
                id,
                accounts::KIND_OAUTH,
                Some(json!({"type": "oauth"})),
            )
            .unwrap();
    }
    // Interleaved, so an unlimited rotation would start outside the pool.
    let outside: Vec<String> = saved.iter().step_by(2).cloned().collect();
    let pool: Vec<String> = saved.iter().skip(1).step_by(2).cloned().collect();
    vault.set_active(&claude, &outside[0]).unwrap();
    let (directory, preferences) = preferences();
    let members: Vec<_> = pool.iter().map(|id| account(CLAUDE, id)).collect();
    store::edit(&preferences, |catalog| {
        let mythos = catalog.create("Mythos", members)?;
        catalog.assign("security", Some(&mythos.id))
    })
    .await
    .unwrap();
    Setup {
        _directory: directory,
        preferences,
        saved,
        pool,
        outside,
    }
}

/// The policy a Claude proxy request loads: the saved strategy, limited to
/// the pool of the agent whose bearer the request carried (`None` for a
/// caller that is no agent).
async fn policy_for(setup: &Setup, agent: Option<&str>, strategy: Strategy) -> Policy {
    let stored = serde_json::to_string(&Policy {
        strategy,
        ..Policy::default()
    })
    .unwrap();
    let key = format!("oauth-account-pool:{CLAUDE}");
    setup.preferences.set(&key, &stored).await.unwrap();
    let load = oauth_pool_policy::load(&setup.preferences, CLAUDE);
    let policy = match agent {
        Some(agent) => scope::as_agent(agent, load).await,
        None => load.await,
    };
    assert_eq!(policy.strategy, strategy);
    policy
}

/// Run `test` on one thread with its own account vault and preferences.
fn with_setup<F: std::future::Future<Output = ()>>(test: impl FnOnce(Setup) -> F) {
    accounts::with_test_vault(|vault| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let setup = ten_accounts_five_in_the_security_pool(vault).await;
            test(setup).await;
        });
    });
}

#[test]
fn when_a_pool_account_runs_out_the_next_choice_is_one_of_the_other_four() {
    with_setup(|setup: Setup| async move {
        let active = setup.outside[0].as_str();
        for strategy in STRATEGIES {
            let policy = policy_for(&setup, Some("security"), strategy).await;
            let mut proxy = Proxy::default();
            let first = proxy
                .select("security-chat", &setup.saved, active, &policy)
                .expect("a pool account");
            assert!(setup.pool.contains(&first), "{strategy:?}: {first}");
            // The conversation stays on its account while that account works.
            let kept = proxy.select("security-chat", &setup.saved, active, &policy);
            assert_eq!(kept.as_deref(), Some(first.as_str()), "{strategy:?}");

            proxy.ran_out("security-chat", &first);
            let next = proxy
                .select("security-chat", &setup.saved, active, &policy)
                .expect("another pool account");
            let other_four: Vec<&String> = setup.pool.iter().filter(|id| **id != first).collect();
            assert_eq!(other_four.len(), 4);
            assert!(
                other_four.contains(&&next),
                "{strategy:?}: {next} is not one of the other four pool accounts"
            );
            assert!(!setup.outside.contains(&next), "{strategy:?}: {next}");
        }
    });
}

#[test]
fn when_all_five_pool_accounts_are_out_no_account_outside_the_pool_is_used() {
    with_setup(|setup: Setup| async move {
        let active = setup.outside[0].as_str();
        for strategy in STRATEGIES {
            let policy = policy_for(&setup, Some("security"), strategy).await;
            let mut proxy = Proxy::default();
            let mut used = BTreeSet::new();
            while let Some(chosen) = proxy.select("security-chat", &setup.saved, active, &policy) {
                assert!(setup.pool.contains(&chosen), "{strategy:?}: {chosen}");
                assert!(used.insert(chosen.clone()), "{strategy:?}: {chosen} twice");
                proxy.ran_out("security-chat", &chosen);
            }
            let pool: BTreeSet<String> = setup.pool.iter().cloned().collect();
            assert_eq!(used, pool, "{strategy:?}: every pool account was tried");
            // Five working accounts are left, none in the pool: no account.
            let refused = proxy.select("security-chat", &setup.saved, active, &policy);
            assert_eq!(refused, None, "{strategy:?}");
            // Pool accounts still exist, so the proxies answer "all accounts
            // are cooling down" here, not "all accounts are disabled".
            assert!(setup.saved.iter().any(|id| policy.allowed(id)));

            // An agent with no pool, and a caller that is no agent, are
            // served by the accounts that are left, as before.
            for agent in [Some("writer"), None] {
                let open = policy_for(&setup, agent, strategy).await;
                assert!(open.pool.is_none(), "{strategy:?} {agent:?}");
                let chosen = proxy
                    .select("other-chat", &setup.saved, active, &open)
                    .expect("an account outside the pool");
                assert!(setup.outside.contains(&chosen), "{strategy:?} {agent:?}");
            }
        }
    });
}

fn record_usage(account: &str, used_percent: f64) {
    let snapshot = ryu_usage::UsageSnapshot {
        available: true,
        windows: vec![ryu_usage::UsageWindow {
            label: "Account window".into(),
            used_percent,
            resets_at: None,
            window_seconds: Some(3600),
            model: None,
        }],
        ..Default::default()
    };
    oauth_pool_usage::record(CLAUDE, account, REVISION, Instant::now(), &snapshot);
}

#[test]
fn a_spent_pool_account_gives_way_to_a_pool_account_not_to_an_emptier_outside_one() {
    with_setup(|setup: Setup| async move {
        let active = setup.outside[0].as_str();
        // Every account outside the pool has all of its usage left.
        for id in &setup.outside {
            record_usage(id, 0.0);
        }
        for (id, used) in setup.pool.iter().zip([100.0, 20.0, 30.0, 40.0, 50.0]) {
            record_usage(id, used);
        }
        let policy = policy_for(&setup, Some("security"), Strategy::QuotaFirst).await;
        let mut proxy = Proxy::default();
        for chat in ["one", "two", "three"] {
            let chosen = proxy.select(chat, &setup.saved, active, &policy).unwrap();
            assert_ne!(chosen, setup.pool[0], "the spent account");
            assert_eq!(chosen, setup.pool[1], "the pool account with most left");
        }
        // Without a pool the same strategy takes an outside account.
        let open = policy_for(&setup, Some("writer"), Strategy::QuotaFirst).await;
        let chosen = proxy.select("open", &setup.saved, active, &open).unwrap();
        assert!(setup.outside.contains(&chosen));
    });
}

#[test]
fn a_pool_member_counts_for_every_provider_id_that_reads_its_account_list() {
    assert!(scope::same_account_list(CLAUDE, CLAUDE));
    // The Anthropic API key provider and the Claude subscription share one
    // account list.
    assert!(scope::same_account_list("anthropic", CLAUDE));
    assert!(!scope::same_account_list("chatgpt", CLAUDE));
    assert!(!scope::same_account_list("chatgpt", "chatgpt-plan"));
    assert!(scope::same_account_list("not-a-provider", "not-a-provider"));
}
