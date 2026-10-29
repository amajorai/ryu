//! The ledger reasons the Gateway may put on a control-plane credit debit.
//!
//! `POST /api/credits/debit` checks `reason` against a closed enum and answers
//! 400 for anything else. A 400 is final (it is not retried), so a debit sent
//! with an unknown reason is never billed, and on a fail-closed managed node it
//! also marks the org's accounting unavailable. A typed enum is what stops a
//! call site from passing a free-form purpose label ("embedding",
//! "smart-routing") as the reason: describe the purpose in `taskLabel`.
//!
//! `fixtures/credit-debit-reasons.json` is the cross-surface copy of this list.
//! The control plane's test asserts every entry is accepted by its debit
//! reason enum, and the test below asserts the fixture matches this enum.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreditDebitReason {
    /// Model, embedding, rerank, media and auxiliary inference usage.
    GatewayUsage,
    /// Executed Composio tool calls.
    Composio,
    /// Treg transactions with a provider-reported raw cost.
    Treg,
    /// Metered sandbox runtime ticks.
    Sandbox,
    /// Hosted web search. Sent only when the control plane advertised that it
    /// accepts this reason (`webSearchDebitReason` on the resolve); otherwise
    /// a search debits as [`CreditDebitReason::GatewayUsage`].
    WebSearch,
}

impl CreditDebitReason {
    /// Every reason, in fixture order.
    pub const ALL: [Self; 5] = [
        Self::GatewayUsage,
        Self::Composio,
        Self::Treg,
        Self::Sandbox,
        Self::WebSearch,
    ];

    /// The wire value the control plane matches against.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::GatewayUsage => "gateway_usage",
            Self::Composio => "composio",
            Self::Treg => "treg",
            Self::Sandbox => "sandbox",
            Self::WebSearch => "web_search",
        }
    }
}

impl std::fmt::Display for CreditDebitReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_lists_exactly_the_reasons_the_gateway_can_send() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/credit-debit-reasons.json")).unwrap();
        let listed: Vec<&str> = fixture["gatewayDebitReasons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        let sent: Vec<&str> = CreditDebitReason::ALL
            .iter()
            .map(|reason| reason.as_str())
            .collect();
        assert_eq!(listed, sent);
    }

    #[test]
    fn serde_and_as_str_agree() {
        for reason in CreditDebitReason::ALL {
            assert_eq!(
                serde_json::to_value(reason).unwrap(),
                serde_json::Value::String(reason.as_str().to_owned())
            );
        }
    }
}
