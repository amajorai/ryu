//! Which account a task runs on, and whether its backend can run it now.

use super::super::accounts::{self, ProviderId};
use super::super::cli::{self, SignIn};
use super::super::routing::Availability;
use super::super::store::{self, EnvironmentLink, RoutingSettings};
use super::super::{runner, CloudTaskBackend, Provider};
use std::collections::BTreeMap;

/// The CLI's sign-in for `account`, or `None` when the CLI is not installed.
pub(in crate::server::subscription_cloud) async fn sign_in(
    provider: Provider,
    account: &str,
) -> Option<SignIn> {
    let runner = runner();
    if !runner.installed(provider) {
        return None;
    }
    match runner
        .run(cli::status_invocation(provider).as_account(account))
        .await
    {
        Ok(output) => Some(cli::parse_sign_in(provider, &output)),
        Err(_) => Some(SignIn::SignedOut),
    }
}

/// Sign-in answers for one routing pass, so each account's CLI is asked once.
#[derive(Default)]
pub(super) struct SignIns(BTreeMap<String, Option<SignIn>>);

impl SignIns {
    async fn get(&mut self, provider: Provider, account: &str) -> Option<SignIn> {
        let key = accounts::account_key(provider, account);
        if let Some(known) = self.0.get(&key) {
            return *known;
        }
        let answer = sign_in(provider, account).await;
        self.0.insert(key, answer);
        answer
    }
}

/// An account a task may run on, with the name the owner gave it.
#[derive(Clone, Debug)]
pub(crate) struct AccountChoice {
    pub(crate) id: String,
    pub(crate) label: String,
}

impl AccountChoice {
    pub(crate) fn key(&self, provider: Provider) -> String {
        accounts::account_key(provider, &self.id)
    }
}

pub(crate) fn account_label(owner: &str, provider: Provider, id: &str) -> String {
    if id == accounts::DEFAULT_ACCOUNT {
        return "this node's sign-in".into();
    }
    store::account(owner, provider.into(), id)
        .map_or_else(|| "a removed account".into(), |account| account.label)
}

/// The account a provider's task starts on: the session's pin, then the agent's
/// account, then the owner's default, then the CLI's own sign-in.
pub(super) fn chosen_account(
    owner: &str,
    settings: &RoutingSettings,
    provider: Provider,
    agent_id: Option<&str>,
    pin: Option<(ProviderId, &str)>,
) -> AccountChoice {
    let provider_id = ProviderId::from(provider);
    let id = pin
        .filter(|(pinned, _)| *pinned == provider_id)
        .map(|(_, id)| id.to_owned())
        .or_else(|| {
            agent_id
                .and_then(|agent| settings.agent_accounts.get(agent))
                .and_then(|choice| choice.get(&provider_id))
                .cloned()
        })
        .or_else(|| settings.default_accounts.get(&provider_id).cloned())
        .filter(|id| linked(owner, provider_id, id))
        .unwrap_or_else(|| accounts::DEFAULT_ACCOUNT.to_owned());
    AccountChoice {
        label: account_label(owner, provider, &id),
        id,
    }
}

/// Whether `id` is the default sign-in or one of the owner's linked accounts.
pub(crate) fn linked(owner: &str, provider: ProviderId, id: &str) -> bool {
    id == accounts::DEFAULT_ACCOUNT || store::account(owner, provider, id).is_some()
}

/// The owner's explicit fallback accounts for `provider`, after `primary`. Ryu tries
/// them only after a usage or rate limit, and only because the owner listed them.
pub(super) fn fallback_accounts(
    owner: &str,
    settings: &RoutingSettings,
    provider: Provider,
    primary: &str,
) -> Vec<AccountChoice> {
    let provider_id = ProviderId::from(provider);
    let mut seen = vec![primary.to_owned()];
    let mut out = Vec::new();
    for id in settings
        .account_fallbacks
        .get(&provider_id)
        .into_iter()
        .flatten()
    {
        if seen.contains(id) || !linked(owner, provider_id, id) {
            continue;
        }
        seen.push(id.clone());
        out.push(AccountChoice {
            id: id.clone(),
            label: account_label(owner, provider, id),
        });
    }
    out
}

fn configured(backend: CloudTaskBackend, link: Option<&EnvironmentLink>) -> bool {
    match backend {
        CloudTaskBackend::RyuBox => true,
        // Runs on this node use a worktree of the environment's local checkout.
        CloudTaskBackend::AnthropicSubscriptionCli
        | CloudTaskBackend::AnthropicSubscriptionSdk
        | CloudTaskBackend::OpenaiSubscriptionSdk => link
            .and_then(|link| link.claude_checkout.as_deref())
            .is_some_and(checkout_is_usable),
        CloudTaskBackend::OpenaiSubscriptionCli => link
            .and_then(|link| link.codex_environment_id.as_deref())
            .is_some_and(codex_environment_id_ok),
    }
}

pub(super) fn checkout_is_usable(path: &str) -> bool {
    let path = std::path::Path::new(path);
    path.is_absolute() && path.join(".git").exists()
}

pub(super) fn codex_environment_id_ok(id: &str) -> bool {
    id.len() <= 128
        && id
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_-".contains(character))
}

pub(super) async fn availability(
    backend: CloudTaskBackend,
    account: &AccountChoice,
    link: Option<&EnvironmentLink>,
    now: u64,
    sign_ins: &mut SignIns,
) -> Availability {
    let Some(provider) = backend.provider() else {
        return Availability::Ready;
    };
    if store::cooldown_remaining(&account.key(provider), now).is_some() {
        return Availability::CoolingDown;
    }
    if !configured(backend, link) {
        return Availability::NotConfigured;
    }
    match sign_ins.get(provider, &account.id).await {
        None => Availability::NotInstalled,
        Some(SignIn::Subscription) => Availability::Ready,
        Some(SignIn::OtherMethod) => Availability::WrongSignIn,
        Some(SignIn::SignedOut) => Availability::SignedOut,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_environment_ids_are_short_and_plain() {
        assert!(codex_environment_id_ok("env_abc-123"));
        assert!(codex_environment_id_ok(&"a".repeat(128)));
        assert!(!codex_environment_id_ok(&"a".repeat(129)));
        assert!(!codex_environment_id_ok(""));
        assert!(!codex_environment_id_ok("-leading-dash"));
        assert!(!codex_environment_id_ok("has space"));
        assert!(!codex_environment_id_ok("../escape"));
    }

    #[test]
    fn a_checkout_must_be_an_absolute_git_directory() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().to_str().expect("utf-8 path");
        assert!(!checkout_is_usable(path));
        std::fs::create_dir(dir.path().join(".git")).expect("create .git");
        assert!(checkout_is_usable(path));
        assert!(!checkout_is_usable("relative/checkout"));
    }

    #[test]
    fn only_a_ryu_box_runs_without_an_environment_link() {
        assert!(configured(CloudTaskBackend::RyuBox, None));
        for backend in CloudTaskBackend::PLANS {
            assert!(!configured(backend, None), "{backend:?}");
        }
    }
}
