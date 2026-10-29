//! Where this Gateway process runs, and therefore whose credentials it holds.
//!
//! Custody is decided once at boot from process configuration and never from a
//! request. It is the Phase 0 stand-in for "this request spends a Ryu
//! credential": a hosted fleet replica holds Ryu's provider keys, so routes that
//! cannot be screened or attributed are refused or not mounted there.
//!
//! A managed node is a client of the fleet. It holds no Ryu provider keys and
//! reaches Ryu-owned supply through the hosted Gateway with an `rgw_` key, so
//! the fleet screens that traffic. On the node itself custody is recorded for
//! diagnostics only and no route behaves differently from a self-hosted node.

use serde::Serialize;

/// The fleet's control-plane URL. Paired with the vault secret it marks a
/// hosted replica (the same pair `own_supply_table::fleet_from_env` reads).
const ENV_CONTROL_PLANE_URL: &str = "CONTROL_PLANE_URL";
/// The private vault credential. Only its presence is read here, never its value.
const ENV_VAULT_SECRET: &str = "RYU_VAULT_INTERNAL_SECRET";
/// Set on a hosted fleet so a missing vault is a startup error.
const ENV_VAULT_REQUIRED: &str = "RYU_PROVIDER_VAULT_REQUIRED";
/// Set by Core on a Ryu Cloud managed node.
const ENV_MANAGED_NODE: &str = "RYU_MANAGED_NODE";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GatewayCustody {
    /// A hosted multi-tenant replica that holds Ryu's provider credentials.
    /// Only the vault signals mark it, and either one is enough so a partial
    /// deployment fails toward the stricter custody: `CONTROL_PLANE_URL` and
    /// `RYU_VAULT_INTERNAL_SECRET` both set, or `RYU_PROVIDER_VAULT_REQUIRED`
    /// truthy. The fleet flag (`fleet = true` / `RYU_GATEWAY_FLEET`) is not a
    /// custody signal: it only hardens exposure (see [`exposure_hardened`]),
    /// and a self-hosted stack behind its own proxy sets it too.
    Fleet,
    /// `RYU_MANAGED_NODE` truthy. A client of the fleet with no Ryu keys.
    ManagedNode,
    /// Everything else: a desktop, a self-hosted server, a developer machine.
    SelfHosted,
}

impl GatewayCustody {
    /// Detect custody from the process environment.
    pub fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Pure detection over an injected variable lookup, so tests never touch
    /// the shared process environment. Fleet signals win over the managed-node
    /// marker because Fleet is the stricter custody.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let set = |name: &str| {
            lookup(name)
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| !value.is_empty())
        };
        let truthy = |name: &str| {
            lookup(name).is_some_and(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
        };
        let vault_pair = set(ENV_CONTROL_PLANE_URL) && set(ENV_VAULT_SECRET);
        if vault_pair || truthy(ENV_VAULT_REQUIRED) {
            Self::Fleet
        } else if truthy(ENV_MANAGED_NODE) {
            Self::ManagedNode
        } else {
            Self::SelfHosted
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fleet => "fleet",
            Self::ManagedNode => "managed_node",
            Self::SelfHosted => "self_hosted",
        }
    }

    /// Whether this process holds Ryu-owned provider credentials. Only the
    /// hosted fleet does; a managed node calls the fleet instead.
    pub const fn is_fleet(self) -> bool {
        matches!(self, Self::Fleet)
    }

    /// Whether an upstream refusal ends the attempt chain instead of moving
    /// the request to another provider. Until attempts carry their own origin,
    /// every attempt on the fleet or on a managed node (a client of the fleet)
    /// counts as floor-bound, so only a transport error, a 5xx, a 408 or a 429
    /// may fall back there. A self-hosted Gateway spends its owner's keys and
    /// keeps its configured fallback chain.
    pub const fn ends_chain_on_refusal(self) -> bool {
        matches!(self, Self::Fleet | Self::ManagedNode)
    }

    /// `/passthrough/*` forwards a caller's own subscription bearer. A hosted
    /// replica must never carry one, so the routes are not mounted there.
    pub const fn mounts_passthrough(self) -> bool {
        !self.is_fleet()
    }

    /// `POST /v1/batches` sends up to thousands of bodies upstream with no
    /// screening, org or budget, so the fleet refuses it.
    pub const fn allows_batch_create(self) -> bool {
        !self.is_fleet()
    }

    /// Whether a Gateway key may arrive in a URL query string. On the fleet a
    /// URL ends up in proxy and load-balancer logs, so keys must use a header.
    pub const fn accepts_query_credentials(self) -> bool {
        !self.is_fleet()
    }

    /// Whether a failed context compression refuses the request instead of
    /// sending the messages uncompressed. The fleet configures compression as
    /// part of what it shares upstream, so it never skips it silently; any
    /// other Gateway keeps chat working when the service is absent.
    pub const fn compression_fails_closed(self) -> bool {
        self.is_fleet()
    }

    /// Whether a chat request may only declare function tools and only the
    /// allowlisted `anthropic-beta` values. Server tools and other betas make
    /// the upstream fetch pages, run code or search the web from Ryu's account
    /// where the Gateway cannot screen what they reach, so the fleet refuses
    /// them. A managed node is a client of the fleet and gets the same refusal
    /// there, so only the fleet gates them.
    pub const fn restricts_upstream_features(self) -> bool {
        self.is_fleet()
    }

    /// Whether a media request has every vendor safety knob it names forced to
    /// the safe value (`disable_safety_checker`, `enable_safety_checker`,
    /// `safety_tolerance` and the like) and is refused when it references
    /// LoRA, adapter or model weights. Replicate, Fal and BFL forward the
    /// caller's body almost verbatim, so on the fleet those knobs would act on
    /// Ryu's provider account. A managed node is a client of the fleet, which
    /// applies the same rule there, so only the fleet enforces it.
    pub const fn screens_media_knobs(self) -> bool {
        self.is_fleet()
    }

    /// Whether an active egress posture item (multi-key rotation, quota-aware
    /// account pools, proxy pools, subscription transports) emits an
    /// `egress.posture_flag` event. Only the fleet spends Ryu's provider
    /// accounts, so only there could an upstream read such a feature as
    /// evasion. Every custody still lists the items in the posture report.
    pub const fn flags_egress_posture(self) -> bool {
        self.is_fleet()
    }
}

/// Whether this process runs with exposure hardening: auth may never be off,
/// and a loopback peer is never trusted as the local operator, because callers
/// behind a co-located load balancer or reverse proxy also arrive from
/// `127.0.0.1`. The fleet flag (`fleet = true` / `RYU_GATEWAY_FLEET`) turns it
/// on for any deployment, a self-hosted one included, and Fleet custody always
/// implies it because a hosted replica is publicly reachable. It never decides
/// custody, so it never binds Ryu's floor, identity secrets or route gates.
pub const fn exposure_hardened(fleet_flag: bool, custody: GatewayCustody) -> bool {
    fleet_flag || custody.is_fleet()
}

/// Whether a raw query string carries a hosted Gateway token (`rgw_` prefix)
/// anywhere in a parameter name or value, after percent and `+` decoding. A
/// token is refused whichever parameter carries it and however it is wrapped:
/// behind an auth scheme in any case, inside a stringified JSON value, after a
/// `;` or `,` separator, or behind a percent-encoded `=` in the name.
pub fn query_carries_gateway_token(raw_query: &str) -> bool {
    let uri = format!("/?{raw_query}");
    let parsed = uri.parse::<axum::http::Uri>().ok().and_then(|uri| {
        axum::extract::Query::<Vec<(String, String)>>::try_from_uri(&uri)
            .ok()
            .map(|axum::extract::Query(pairs)| pairs)
    });
    match parsed {
        Some(pairs) => pairs
            .iter()
            .any(|(name, value)| is_gateway_token(value) || is_gateway_token(name)),
        // Undecodable: fail toward refusal when the raw text names the prefix.
        None => raw_query.to_ascii_lowercase().contains("rgw_"),
    }
}

/// Whether `text` holds a token that starts at a boundary: the start of the
/// text or any character that cannot continue a token. A `rgw_` that merely
/// ends a longer word (`sk-test-rgw_`) is not a Gateway token.
fn is_gateway_token(text: &str) -> bool {
    const PREFIX: &str = "rgw_";
    text.match_indices(PREFIX).any(|(start, _)| {
        text[..start]
            .chars()
            .next_back()
            .is_none_or(|before| !is_token_char(before))
    })
}

/// Characters that continue a word or key, so a `rgw_` directly after one of
/// them is part of a longer value. Every other character, punctuation and
/// whitespace included, counts as a delimiter so a miss fails toward refusal.
fn is_token_char(character: char) -> bool {
    character.is_alphanumeric() || matches!(character, '_' | '-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn detect(vars: &[(&str, &str)]) -> GatewayCustody {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect();
        GatewayCustody::from_lookup(|name| vars.get(name).cloned())
    }

    /// The gateway service environment of the root self-host
    /// `docker-compose.yml`, with placeholder credentials and the identity
    /// secrets left empty as the compose defaults pass them.
    const SELF_HOST_COMPOSE_ENV: &[(&str, &str)] = &[
        ("GATEWAY_MASTER_KEY", "test-master-key-000000000000"),
        ("GATEWAY_RELAY_KEY", "test-relay-key-0000000000000"),
        ("GATEWAY_CORE_RELAY_KEY", "test-core-relay-key-00000000"),
        ("GATEWAY_CORE_PROOF_KEY", "test-core-proof-key-00000000"),
        ("RYU_IDENTITY_ROOT", ""),
        ("RYU_IDENTITY_PEPPER", ""),
        ("RYU_GATEWAY_FLEET", "1"),
    ];

    #[test]
    fn no_signal_is_self_hosted() {
        assert_eq!(detect(&[]), GatewayCustody::SelfHosted);
        // A control plane alone is a bound node, not a vault-holding replica.
        assert_eq!(
            detect(&[(ENV_CONTROL_PLANE_URL, "https://cp.example.test")]),
            GatewayCustody::SelfHosted
        );
        assert_eq!(
            detect(&[(ENV_VAULT_SECRET, "present")]),
            GatewayCustody::SelfHosted
        );
        assert_eq!(
            detect(&[(ENV_CONTROL_PLANE_URL, "  "), (ENV_VAULT_SECRET, "present")]),
            GatewayCustody::SelfHosted
        );
        assert_eq!(
            detect(&[(ENV_VAULT_REQUIRED, "0"), (ENV_MANAGED_NODE, "false")]),
            GatewayCustody::SelfHosted
        );
    }

    #[test]
    fn fleet_flag_alone_hardens_exposure_without_fleet_custody() {
        for value in ["1", "true"] {
            assert_eq!(
                detect(&[("RYU_GATEWAY_FLEET", value)]),
                GatewayCustody::SelfHosted,
                "{value}"
            );
        }
        assert!(exposure_hardened(true, GatewayCustody::SelfHosted));
        assert!(exposure_hardened(true, GatewayCustody::ManagedNode));
        assert!(exposure_hardened(false, GatewayCustody::Fleet));
        assert!(!exposure_hardened(false, GatewayCustody::SelfHosted));
        assert!(!exposure_hardened(false, GatewayCustody::ManagedNode));
    }

    #[test]
    fn self_host_compose_env_is_self_hosted_with_exposure_hardening() {
        let custody = detect(SELF_HOST_COMPOSE_ENV);
        assert_eq!(custody, GatewayCustody::SelfHosted);
        // The compose stack keeps `RYU_GATEWAY_FLEET=1`, which loads as the
        // fleet flag and still hardens exposure.
        assert!(exposure_hardened(true, custody));
        // None of Ryu's hosted rules bind it.
        assert!(!custody.is_fleet());
        assert!(!custody.ends_chain_on_refusal());
        assert!(custody.mounts_passthrough());
        assert!(custody.allows_batch_create());
        assert!(custody.accepts_query_credentials());
        assert!(!custody.compression_fails_closed());
        assert!(!custody.restricts_upstream_features());
        assert!(!custody.screens_media_knobs());
        assert!(!custody.flags_egress_posture());
        // It starts without the identity secrets the fleet requires.
        let vars: HashMap<&str, &str> = SELF_HOST_COMPOSE_ENV.iter().copied().collect();
        let identity = crate::identity::IdentityKeys::from_lookup(custody, |name| {
            vars.get(name).map(|value| (*value).to_owned())
        })
        .expect("self-host compose starts without identity secrets");
        assert!(!identity.has_pepper());
    }

    #[test]
    fn each_vault_signal_alone_is_fleet() {
        let vault_pair = [
            (ENV_CONTROL_PLANE_URL, "https://cp.example.test"),
            (ENV_VAULT_SECRET, "present"),
        ];
        assert_eq!(detect(&vault_pair), GatewayCustody::Fleet);
        // The same pair on top of the self-host compose env is still Fleet.
        let mut combined = SELF_HOST_COMPOSE_ENV.to_vec();
        combined.extend(vault_pair);
        assert_eq!(detect(&combined), GatewayCustody::Fleet);
        for value in ["1", "true", "YES", " on "] {
            assert_eq!(
                detect(&[(ENV_VAULT_REQUIRED, value)]),
                GatewayCustody::Fleet,
                "{value}"
            );
        }
    }

    #[test]
    fn managed_node_marker_is_managed_node_and_fleet_wins() {
        assert_eq!(
            detect(&[(ENV_MANAGED_NODE, "1")]),
            GatewayCustody::ManagedNode
        );
        // The fleet flag does not lift a managed node to Fleet custody.
        assert_eq!(
            detect(&[(ENV_MANAGED_NODE, "1"), ("RYU_GATEWAY_FLEET", "1")]),
            GatewayCustody::ManagedNode
        );
        assert_eq!(
            detect(&[(ENV_MANAGED_NODE, "true"), (ENV_VAULT_REQUIRED, "1")]),
            GatewayCustody::Fleet
        );
    }

    #[test]
    fn route_gates_apply_only_on_fleet() {
        assert!(!GatewayCustody::Fleet.mounts_passthrough());
        assert!(!GatewayCustody::Fleet.allows_batch_create());
        assert!(!GatewayCustody::Fleet.accepts_query_credentials());
        assert!(GatewayCustody::Fleet.restricts_upstream_features());
        assert!(GatewayCustody::Fleet.flags_egress_posture());
        for custody in [GatewayCustody::ManagedNode, GatewayCustody::SelfHosted] {
            assert!(custody.mounts_passthrough());
            assert!(custody.allows_batch_create());
            assert!(custody.accepts_query_credentials());
            assert!(!custody.restricts_upstream_features());
            assert!(!custody.flags_egress_posture());
        }
    }

    #[test]
    fn custody_serializes_snake_case() {
        assert_eq!(
            serde_json::to_value(GatewayCustody::ManagedNode).unwrap(),
            serde_json::json!("managed_node")
        );
        for custody in [
            GatewayCustody::Fleet,
            GatewayCustody::ManagedNode,
            GatewayCustody::SelfHosted,
        ] {
            assert_eq!(
                serde_json::to_value(custody).unwrap(),
                serde_json::json!(custody.as_str())
            );
        }
    }

    #[test]
    fn gateway_tokens_are_found_in_any_query_parameter() {
        for query in [
            "key=rgw_test_0001",
            "alt=sse&key=rgw_test_0001",
            "token=rgw_test_0001",
            "key=%72gw_test_0001",
            "key=Bearer+rgw_test_0001",
            "key=+rgw_test_0001",
            "rgw_test_0001",
            "key=BEARER+rgw_test_0001",
            "key=Basic%20rgw_test_0001",
            "filter=%7B%22key%22%3A%22rgw_test_0001%22%7D",
            "alt=json;key=rgw_test_0001",
            "keys=benign-value,rgw_test_0001",
            "key%3Drgw_test_0001",
            "q=a%26key%3Drgw_test_0001",
            "host=a.rgw_test_0001",
        ] {
            assert!(query_carries_gateway_token(query), "{query}");
        }
        for query in [
            "",
            "alt=sse",
            "key=gw_local_key",
            "key=sk-test-rgw_",
            "model=rgw",
            "model=xrgw_suffix",
            "note=snake_rgw_case",
            "list=a,b;c=d",
            "filter=%7B%22key%22%3A%22gw_local_key%22%7D",
        ] {
            assert!(!query_carries_gateway_token(query), "{query}");
        }
    }
}
