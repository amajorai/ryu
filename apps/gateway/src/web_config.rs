//! Typed authored web-service routing and monetary policy. No ambient credentials.

use std::collections::{BTreeMap, HashMap};

use ryu_gw_credentials::web::{
    WebAccountContext, WebContentFormat, WebEligibilityDiagnostic, WebOperation, WebProviderConfig,
    WebProviderKind, WEB_PROVIDERS,
};
use serde::{Deserialize, Serialize};

use crate::config::ProviderPoolStrategy;

pub type WebProviderConfigs = BTreeMap<WebProviderKind, WebProviderConfig>;
pub type WebServicePrices = BTreeMap<WebProviderKind, HashMap<WebOperation, WebServicePrice>>;

pub fn deserialize_web_providers<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<WebProviderConfigs, D::Error> {
    let providers = WebProviderConfigs::deserialize(deserializer)?;
    for (kind, config) in &providers {
        config
            .validate_for(*kind)
            .map_err(serde::de::Error::custom)?;
    }
    Ok(providers)
}

pub const fn operation_name(operation: WebOperation) -> &'static str {
    match operation {
        WebOperation::Search => "search",
        WebOperation::Fetch => "fetch",
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct WebRoutingConfig {
    pub search: Option<WebBinding>,
    pub fetch: Option<WebBinding>,
}

impl WebRoutingConfig {
    pub fn binding(&self, operation: WebOperation) -> Option<&WebBinding> {
        match operation {
            WebOperation::Search => self.search.as_ref(),
            WebOperation::Fetch => self.fetch.as_ref(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WebBinding {
    Provider { provider: WebProviderKind },
    Pool { name: String },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WebPoolConfig {
    pub operation: WebOperation,
    #[serde(default)]
    pub strategy: ProviderPoolStrategy,
    pub members: Vec<WebPoolMemberConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WebPoolMemberConfig {
    pub provider: WebProviderKind,
    #[serde(default)]
    pub priority: u8,
    #[serde(default = "default_weight")]
    pub weight: u16,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_weight() -> u16 {
    1
}
fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WebServicePrice {
    pub reservation_micro_usd_per_call: u64,
    pub max_reported_micro_usd_per_call: u64,
    pub fallback_micro_usd_per_call: u64,
}

/// Maximum debit accepted by the credits control-plane wire protocol.
pub const WEB_DEBIT_WIRE_LIMIT_MICRO_USD: u64 = 1_000_000_000_000;

impl WebServicePrice {
    pub fn validate(self, markup_bps: u64) -> Result<(), String> {
        if self.reservation_micro_usd_per_call < self.max_reported_micro_usd_per_call
            || self.max_reported_micro_usd_per_call < self.fallback_micro_usd_per_call
            || self
                .charged(self.reservation_micro_usd_per_call, markup_bps)
                .is_none()
        {
            return Err("Web prices require reservation >= maximum reported >= fallback within the charged budget range".to_owned());
        }
        Ok(())
    }

    pub fn charged(self, raw_micro_usd: u64, markup_bps: u64) -> Option<i64> {
        let charged = u128::from(raw_micro_usd)
            .checked_mul(u128::from(markup_bps).checked_add(10_000)?)?
            .checked_add(5_000)?
            / 10_000;
        if charged > u128::from(WEB_DEBIT_WIRE_LIMIT_MICRO_USD) {
            return None;
        }
        i64::try_from(charged).ok()
    }
}

pub fn validate_web_prices(
    prices: &WebServicePrices,
    credits: &crate::config::CreditsConfig,
) -> Result<(), String> {
    for (kind, operations) in prices {
        for (operation, price) in operations {
            if !kind.descriptor().operations.contains(operation) {
                return Err(
                    "Web price is configured for an unsupported provider operation".to_owned(),
                );
            }
            price.validate(
                if credits.is_pass_through_provider(kind.descriptor().provider_id) {
                    0
                } else {
                    credits.markup_bps
                },
            )?;
        }
    }
    Ok(())
}

/// Only web price rows publish live; global ledger markup keeps its boot owner.
#[derive(Debug, Clone)]
pub struct WebPricingSnapshot {
    prices: WebServicePrices,
    markup: BTreeMap<WebProviderKind, u64>,
}

#[derive(Debug, Clone, Copy)]
pub struct BoundWebPrice {
    pub price: WebServicePrice,
    pub markup_bps: u64,
}

impl BoundWebPrice {
    pub fn reservation(self) -> Option<i64> {
        self.price
            .charged(self.price.reservation_micro_usd_per_call, self.markup_bps)
    }
    pub fn charged_reported(self, raw: u64) -> Option<i64> {
        (raw <= self.price.max_reported_micro_usd_per_call)
            .then(|| self.price.charged(raw, self.markup_bps))
            .flatten()
    }
}

impl WebPricingSnapshot {
    pub fn new(
        prices: WebServicePrices,
        credits: &crate::config::CreditsConfig,
    ) -> Result<Self, String> {
        let markup = WEB_PROVIDERS
            .iter()
            .map(|descriptor| {
                (
                    descriptor.kind,
                    if credits.is_pass_through_provider(descriptor.provider_id) {
                        0
                    } else {
                        credits.markup_bps
                    },
                )
            })
            .collect();
        let snapshot = Self {
            prices: BTreeMap::new(),
            markup,
        };
        snapshot.with_prices(prices)
    }
    pub fn with_prices(&self, prices: WebServicePrices) -> Result<Self, String> {
        for (kind, operations) in &prices {
            for (operation, price) in operations {
                if !kind.descriptor().operations.contains(operation) {
                    return Err(
                        "Web price is configured for an unsupported provider operation".to_owned(),
                    );
                }
                price.validate(self.markup.get(kind).copied().unwrap_or_default())?;
            }
        }
        Ok(Self {
            prices,
            markup: self.markup.clone(),
        })
    }
    pub fn quote(&self, kind: WebProviderKind, operation: WebOperation) -> Option<BoundWebPrice> {
        self.prices
            .get(&kind)?
            .get(&operation)
            .copied()
            .map(|price| BoundWebPrice {
                price,
                markup_bps: self.markup.get(&kind).copied().unwrap_or_default(),
            })
    }
    pub fn prices(&self) -> &WebServicePrices {
        &self.prices
    }
}

#[derive(Serialize)]
pub(crate) struct WebProviderEditorView {
    pub provider_id: &'static str,
    pub label: &'static str,
    pub operations: &'static [WebOperation],
    pub formats: &'static [WebContentFormat],
    pub configured: bool,
    pub ready: bool,
    pub mode: Option<&'static str>,
    pub account_count: usize,
    pub accounts: Vec<WebAccountEditorView>,
}

#[derive(Serialize)]
pub(crate) struct WebAccountEditorView {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub priority: u16,
    pub source: &'static str,
    // Protected editor only; generic capability projection omits this context.
    pub context: WebAccountContext,
    pub diagnostic: Option<WebEligibilityDiagnostic>,
}

pub(crate) fn web_editor_views(
    config: &crate::config::ProvidersConfig,
    now: u64,
) -> BTreeMap<WebProviderKind, WebProviderEditorView> {
    WEB_PROVIDERS
        .iter()
        .map(|descriptor| {
            let connection = config.web.get(&descriptor.kind);
            let accounts: Vec<_> = connection
                .into_iter()
                .flat_map(WebProviderConfig::accounts)
                .enumerate()
                .filter_map(|(index, row)| {
                    let id = row.account_id(descriptor.kind).ok()?;
                    let policy = config
                        .account_policies
                        .get(descriptor.provider_id)
                        .and_then(|policies| policies.get(&id))
                        .cloned()
                        .unwrap_or_default();
                    Some(WebAccountEditorView {
                        id,
                        name: if policy.name.is_empty() {
                            format!("Account {}", index + 1)
                        } else {
                            policy.name
                        },
                        enabled: policy.enabled,
                        priority: policy.priority,
                        source: "stored",
                        context: row.context().clone(),
                        diagnostic: row.eligibility_diagnostic(now),
                    })
                })
                .collect();
            let anonymous = connection.is_some_and(WebProviderConfig::is_anonymous);
            let ready = anonymous
                || accounts
                    .iter()
                    .any(|row| row.enabled && row.diagnostic.is_none());
            (
                descriptor.kind,
                WebProviderEditorView {
                    provider_id: descriptor.provider_id,
                    label: descriptor.label,
                    operations: descriptor.operations,
                    formats: descriptor.formats,
                    configured: connection.is_some(),
                    ready,
                    mode: connection.map(|_| if anonymous { "anonymous" } else { "accounts" }),
                    account_count: accounts.len(),
                    accounts,
                },
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reservation_covers_all_allowed_cost_and_checked_markup() {
        let price = WebServicePrice {
            reservation_micro_usd_per_call: 1000,
            max_reported_micro_usd_per_call: 900,
            fallback_micro_usd_per_call: 700,
        };
        price.validate(2500).unwrap();
        assert_eq!(price.charged(900, 2500), Some(1125));
        assert!(WebServicePrice {
            reservation_micro_usd_per_call: 800,
            ..price
        }
        .validate(0)
        .is_err());
        assert!(WebServicePrice {
            fallback_micro_usd_per_call: 901,
            ..price
        }
        .validate(0)
        .is_err());
        assert!(WebServicePrice {
            reservation_micro_usd_per_call: i64::MAX as u64,
            ..price
        }
        .validate(1)
        .is_err());
        assert!(price.charged(u64::MAX, u64::MAX).is_none());
    }

    #[test]
    fn charged_prices_respect_exact_debit_wire_limit() {
        let limit = WEB_DEBIT_WIRE_LIMIT_MICRO_USD;
        let price = WebServicePrice {
            reservation_micro_usd_per_call: limit,
            max_reported_micro_usd_per_call: limit,
            fallback_micro_usd_per_call: limit,
        };
        price.validate(0).unwrap();
        assert_eq!(price.charged(limit, 0), Some(limit as i64));
        assert!(price.validate(1).is_err());
        for field in 0..3 {
            let mut excess = price;
            match field {
                0 => excess.reservation_micro_usd_per_call += 1,
                1 => excess.max_reported_micro_usd_per_call += 1,
                _ => excess.fallback_micro_usd_per_call += 1,
            }
            assert!(excess.validate(0).is_err());
        }
        assert!(price.charged(limit + 1, 0).is_none());
    }

    #[test]
    fn explicit_zero_is_distinct_from_missing_price_and_no_unknown_fields() {
        let zero = WebServicePrice {
            reservation_micro_usd_per_call: 0,
            max_reported_micro_usd_per_call: 0,
            fallback_micro_usd_per_call: 0,
        };
        zero.validate(0).unwrap();
        assert_eq!(zero.charged(0, 0), Some(0));
        assert!(serde_json::from_value::<WebServicePrice>(
            serde_json::json!({"fallback_micro_usd_per_call":0})
        )
        .is_err());
        assert!(serde_json::from_value::<WebBinding>(
            serde_json::json!({"kind":"provider","provider":"tavily","api_key":"hidden"})
        )
        .is_err());
        assert!(serde_json::from_value::<WebBinding>(
            serde_json::json!({"kind":"pool","name":"a","members":[]})
        )
        .is_err());
    }

    #[test]
    fn authored_web_accounts_round_trip_context_identity_and_mask_readback() {
        let config:crate::config::GatewayConfig=toml::from_str(r#"
            [providers.web.google-pse]
            mode="accounts"
            [[providers.web.google-pse.accounts]]
            api_key="private-shared-google-material"
            context={kind="google_pse",engine_id="first-engine",existing_customer_acknowledged=true}
            [[providers.web.google-pse.accounts]]
            api_key="private-shared-google-material"
            context={kind="google_pse",engine_id="second-engine",existing_customer_acknowledged=true}
            [providers.web.jina-reader]
            mode="anonymous"
            [routing.web.search]
            kind="provider"
            provider="google-pse"
        "#).unwrap();
        let rows = config.providers.web[&WebProviderKind::GooglePse].accounts();
        assert_ne!(
            rows[0].account_id(WebProviderKind::GooglePse).unwrap(),
            rows[1].account_id(WebProviderKind::GooglePse).unwrap()
        );
        let view = serde_json::to_value(web_editor_views(&config.providers, 0)).unwrap();
        assert_eq!(view["google-pse"]["account_count"], 2);
        assert_eq!(view["jina-reader"]["account_count"], 0);
        assert_eq!(view["jina-reader"]["mode"], "anonymous");
        assert!(!view.to_string().contains("private-shared-google-material"));
        let loaded: crate::config::GatewayConfig =
            toml::from_str(&toml::to_string(&config).unwrap()).unwrap();
        assert_eq!(loaded.providers.web, config.providers.web);
        assert!(toml::from_str::<crate::config::GatewayConfig>(
            "[providers.web.exa]\nmode='anonymous'"
        )
        .is_err());
        assert!(toml::from_str::<crate::config::GatewayConfig>("[providers.web.google-pse]\nmode='accounts'\n[[providers.web.google-pse.accounts]]\napi_key='hidden'\n").is_err());
    }
}
