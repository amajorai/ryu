//! Network secrets in a fresh cloud box. The Box's processes see only a
//! placeholder; the Box's egress proxy puts the value in its place on HTTPS
//! requests to the secret's domains (`networkSecrets` on Box create), so the
//! managed agent can use the secret without being able to read it.

use super::script::box_network;
use super::validation::{host_allowed, valid_domain};
use super::*;
use ryu_sandbox::box_session::{BoxNetwork, BoxNetworkSecret, MAX_BOX_NETWORK_SECRETS};
use ryu_sandbox::box_types::SecretString;

/// The most domains one Box network secret may be bound to.
const MAX_BOX_SECRET_DOMAINS: usize = 16;

/// A fresh cloud box's network: its egress policy, and the network secrets
/// its egress proxy substitutes. `Debug` never prints a value.
#[derive(Clone, Debug)]
pub(in crate::server) struct BoxNetworkPlan {
    pub network: BoxNetwork,
    pub secrets: Vec<BoxNetworkSecret>,
}

impl BoxNetworkPlan {
    /// A plan with no network secrets.
    pub(in crate::server) fn plain(network: BoxNetwork) -> Self {
        Self {
            network,
            secrets: Vec::new(),
        }
    }
}

/// A domain a Box egress certificate can name: a DNS name with a dot and an
/// alphabetic top-level label, optionally `*.`-prefixed. Never an IP literal.
pub(super) fn box_secret_domain(domain: &str) -> bool {
    let host = domain.strip_prefix("*.").unwrap_or(domain);
    valid_domain(domain)
        && host.contains('.')
        && host
            .rsplit('.')
            .next()
            .is_some_and(|label| label.starts_with(|c: char| c.is_ascii_alphabetic()))
}

/// Why this environment's bound network secrets cannot be substituted in a
/// fresh cloud box, or `None` when they can. Names domains, never values.
pub(super) fn box_secret_issue(environment: &Environment, vault: &[VaultEntry]) -> Option<String> {
    let bound: Vec<&VaultEntry> = vault
        .iter()
        .filter(|entry| {
            entry.kind == "networkSecret" && environment.vault_keys.contains(&entry.key)
        })
        .collect();
    if bound.len() > MAX_BOX_NETWORK_SECRETS {
        return Some(format!(
            "A fresh cloud box accepts at most {MAX_BOX_NETWORK_SECRETS} network secrets. Unselect some or use the default backend."
        ));
    }
    let network = box_network(&environment.internet);
    for entry in bound {
        if entry.domains.len() > MAX_BOX_SECRET_DOMAINS {
            return Some(format!(
                "A network secret in a fresh cloud box may be bound to at most {MAX_BOX_SECRET_DOMAINS} domains. Narrow {}.",
                entry.key
            ));
        }
        if let Some(domain) = entry
            .domains
            .iter()
            .find(|domain| !box_secret_domain(domain))
        {
            return Some(format!(
                "A fresh cloud box substitutes network secrets only for DNS host names, and {domain} is not one. Bind {} to host names.",
                entry.key
            ));
        }
        if let BoxNetwork::Allowlist(hosts) = &network {
            if let Some(domain) = entry
                .domains
                .iter()
                .find(|domain| !host_allowed(hosts, domain))
            {
                return Some(format!(
                    "{} is bound to {domain}, which this box's internet allowlist does not include. Add it to the allowed domains.",
                    entry.key
                ));
            }
        }
    }
    None
}

/// The Box network secret for one bound value, with `placeholder` as the only
/// thing the Box sees.
pub(super) fn box_network_secret(
    placeholder: &str,
    domains: &[String],
    value: &str,
) -> BoxNetworkSecret {
    BoxNetworkSecret {
        placeholder: placeholder.to_owned(),
        hosts: domains
            .iter()
            .map(|domain| domain.to_ascii_lowercase())
            .collect(),
        value: SecretString::new(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret_environment(policy: &str, allowed: &[&str], domains: &[&str]) -> Snapshot {
        let mut state: Snapshot = serde_json::from_str(include_str!(
            "../../../../../packages/protocol/src/fixtures/cloud-environments.json"
        ))
        .unwrap();
        state.vault[0].kind = "networkSecret".into();
        state.vault[0].domains = domains.iter().map(|d| (*d).to_owned()).collect();
        let key = state.vault[0].key.clone();
        let environment = &mut state.environments[0];
        environment.vault_keys = vec![key];
        environment.internet.enabled = true;
        environment.internet.domain_policy = policy.into();
        environment.internet.allowed_domains = allowed.iter().map(|d| (*d).to_owned()).collect();
        state
    }

    fn issue(state: &Snapshot) -> Option<String> {
        box_secret_issue(&state.environments[0], &state.vault)
    }

    #[test]
    fn box_network_secrets_need_dns_domains_inside_the_allowlist() {
        assert_eq!(
            issue(&secret_environment("all", &[], &["api.example.com"])),
            None
        );
        assert_eq!(
            issue(&secret_environment(
                "custom",
                &["*.example.com"],
                &["api.example.com", "*.example.com"]
            )),
            None
        );
        let blocked = issue(&secret_environment(
            "custom",
            &["other.example.org"],
            &["api.example.com"],
        ))
        .unwrap();
        assert!(blocked.contains("api.example.com"), "{blocked}");
        assert!(blocked.contains("allowlist"), "{blocked}");
        for domain in ["10.0.0.7", "localhost", "*.10.0.0.7"] {
            let refused = issue(&secret_environment("all", &[], &[domain]));
            assert!(
                refused.is_some_and(|message| message.contains("DNS host names")),
                "{domain}"
            );
        }
        let many: Vec<String> = (0..17).map(|n| format!("h{n}.example.com")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert!(issue(&secret_environment("all", &[], &many)).is_some());
    }

    #[test]
    fn box_network_secret_issue_ignores_unbound_and_plain_variables() {
        let mut state = secret_environment("all", &[], &["10.0.0.7"]);
        state.environments[0].vault_keys.clear();
        assert_eq!(issue(&state), None);
        let mut state = secret_environment("all", &[], &["10.0.0.7"]);
        state.vault[0].kind = "variable".into();
        assert_eq!(issue(&state), None);
    }

    #[test]
    fn box_network_secret_carries_the_value_only_to_the_proxy_binding() {
        let secret = box_network_secret(
            "__RYU_SECRET_0123456789abcdef0123456789abcdef__",
            &["API.Example.com".to_owned()],
            "sk-live-9",
        );
        assert_eq!(secret.hosts, vec!["api.example.com".to_owned()]);
        assert_eq!(secret.value.expose_secret(), "sk-live-9");
        assert!(ryu_sandbox::box_session::is_network_secret_placeholder(
            &secret.placeholder
        ));
        let plan = BoxNetworkPlan {
            network: BoxNetwork::Egress,
            secrets: vec![secret],
        };
        assert!(!format!("{plan:?}").contains("sk-live-9"));
    }
}
