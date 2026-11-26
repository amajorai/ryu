//! Which reported transaction id may become a `/v1/budget/charge` ledger key.
//!
//! The control plane settles Connect and Composio receipts under
//! `composio:<transaction>` and treats an existing charge under that reference
//! as already settled. Only a charge the Gateway priced itself from
//! provider-verified `composioUsage` may therefore claim that namespace; a bare
//! caller-stated total would otherwise pre-claim a receipt at any price.
//!
//! The usage on this route is stated by the caller, and a tenant holds root
//! on its managed node, so the control plane also treats the Connect receipt
//! as the authority on price and debits any shortfall. Receipts that only
//! hosted Connect settlement charges never get the namespace here at all.

/// Receipt ids no Core reports: an operator-key vendor call (`rvx_`) and a
/// composed tool's maker fee (`rcx_`). Only hosted Connect settlement charges
/// them, at the price Connect recorded.
const SETTLEMENT_ONLY_PREFIXES: [&str; 2] = ["rvx_", "rcx_"];

fn settlement_only(transaction_id: &str) -> bool {
    let id = transaction_id.trim_start();
    SETTLEMENT_ONLY_PREFIXES.iter().any(|prefix| {
        id.get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
    })
}

/// The transaction id to key a reported external tool charge on, or `None` to
/// fall back to the request-scoped `<request>:<provider>` reference.
pub(crate) fn ledger_transaction_id<'a>(
    provider: &str,
    gateway_priced: bool,
    transaction_id: Option<&'a str>,
) -> Option<&'a str> {
    if provider != "composio" {
        return transaction_id;
    }
    if !gateway_priced {
        return None;
    }
    transaction_id.filter(|id| !settlement_only(id))
}

#[cfg(test)]
mod tests {
    use super::ledger_transaction_id;
    use crate::pipeline::external_tool_ref_id;

    fn ref_id(provider: &str, gateway_priced: bool, transaction: &str) -> String {
        external_tool_ref_id(
            provider,
            ledger_transaction_id(provider, gateway_priced, Some(transaction)),
            "req-1",
        )
    }

    #[test]
    fn an_unpriced_composio_total_cannot_claim_a_receipt_reference() {
        assert_eq!(ref_id("composio", false, "rnx_x"), "req-1:composio");
        assert!(!ref_id("composio", false, "rcx_run").starts_with("composio:"));
    }

    #[test]
    fn a_gateway_priced_composio_receipt_keeps_its_settlement_reference() {
        assert_eq!(ref_id("composio", true, "rnx_x"), "composio:rnx_x");
    }

    #[test]
    fn a_settlement_only_receipt_cannot_be_claimed_with_stated_usage() {
        assert_eq!(ref_id("composio", true, "rvx_call"), "req-1:composio");
        assert_eq!(ref_id("composio", true, "rcx_run"), "req-1:composio");
        assert_eq!(ref_id("composio", true, " RVX_call"), "req-1:composio");
        // Receipts a Core does report keep the settlement reference.
        assert_eq!(ref_id("composio", true, "log_1"), "composio:log_1");
        assert_eq!(ref_id("composio", true, "rv"), "composio:rv");
    }

    #[test]
    fn other_providers_keep_their_transaction_reference() {
        assert_eq!(ref_id("treg", false, "call-1"), "treg:call-1");
    }
}
