//! Tool credential ladder (Treg parity B5): which key pays for one call to a
//! third-party tool vendor endpoint, and whether Ryu meters it.
//!
//! The rungs, most specific first:
//!
//! 1. **team**: the calling team's own key for the vendor (`tool:<vendor>`).
//! 2. **org**: the organization's own key for the vendor.
//! 3. **operator**: Ryu's operator key, metered, and only for an endpoint
//!    whose price is verified ([`RungPrice::Verified`]: a verified catalog
//!    entry whose reviewed price may route paid calls), or documented on the
//!    vendor's own page when the deployment allows it
//!    ([`LadderInput::allow_documented`]).
//! 4. **treg**: Treg's hosted relay, metered by the Gateway, only for an
//!    endpoint Ryu does not serve itself, or when the caller chose Treg.
//!
//! Rules this module fixes, so every surface applies them the same way:
//!
//! - A call on the tenant's own key (team or org rung) is **never metered**.
//! - The caller chooses the provider ([`ProviderChoice`]). Treg is never a
//!   silent failover for an endpoint Ryu serves; it answers only endpoints
//!   Ryu does not serve, or calls that named it.
//! - A tenant rung that holds a key which is not active (disabled, expired or
//!   revoked) never falls through to the operator key: the tenant meant to
//!   pay with its own key, so the call is refused with `credential_invalid`
//!   rather than billed. It may still fall through to the other tenant rung.
//! - An operator key whose price is not verified (or documented and allowed)
//!   is never used: the call is refused with `operator_price_unverified`.
//!
//! The function is pure (no clock, IO or secrets): callers pass what they
//! hold as [`CredentialRef`]s and fetch the value through their own sealed
//! custody. The shared cases in `fixtures/tool-credential-ladder-cases-v1.json`
//! are the source of truth for the TypeScript twin
//! (`@ryuhq/protocol/tool-credential-ladder`).

use serde::{Deserialize, Serialize};

use crate::credential_scope::{CandidateStatus, CredentialPurpose, CredentialRef, CredentialSlot};

/// Version of this contract and of its shared case file.
pub const LADDER_CONTRACT_VERSION: u32 = 1;

/// Refused: the slot is not a valid `tool:<vendor>` slot.
pub const REFUSED_INVALID_SLOT: &str = "invalid_slot";
/// Refused: no rung serves the endpoint (Ryu does not, and Treg does not or
/// was not allowed).
pub const REFUSED_ENDPOINT_NOT_SERVED: &str = "endpoint_not_served";
/// Refused: a tenant rung holds a key that is not active, and no tenant rung
/// holds an active one. The operator key is never used instead.
pub const REFUSED_CREDENTIAL_INVALID: &str = "credential_invalid";
/// Refused: only the operator key could serve, and the endpoint's price is not
/// verified (or documented and allowed).
pub const REFUSED_OPERATOR_PRICE_UNVERIFIED: &str = "operator_price_unverified";
/// Refused: no tenant key and no operator key.
pub const REFUSED_CREDENTIAL_REQUIRED: &str = "credential_required";

/// One rung of the ladder, in [`RUNGS`] order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rung {
    Team,
    Org,
    Operator,
    Treg,
}

/// The ladder, most specific first.
pub const RUNGS: [Rung; 4] = [Rung::Team, Rung::Org, Rung::Operator, Rung::Treg];

/// Which provider the caller asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProviderChoice {
    /// No provider named: Ryu's rungs for an endpoint Ryu serves, Treg only
    /// for an endpoint only Treg serves.
    #[default]
    Any,
    /// Ryu's rungs only; Treg is never used.
    Ryu,
    /// Treg only.
    Treg,
}

/// The standing of the endpoint's price, as the operator rung sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RungPrice {
    /// A verified catalog entry whose reviewed price may route paid calls.
    Verified,
    /// A reviewed price from the vendor's own page or API that may route paid
    /// calls, on a catalog entry not verified yet.
    Documented,
    /// The price, or the catalog entry, is unverified or drifted.
    Unverified,
    /// Ryu has no price for the endpoint.
    Missing,
}

/// A stored tenant key for the vendor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RungCandidate {
    pub credential_ref: CredentialRef,
    pub status: CandidateStatus,
}

/// What one tenant rung holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TenantRung {
    /// The caller has an owner at this level (a team, an organization), bound
    /// server-side; a level the caller only asserts is not in scope.
    pub in_scope: bool,
    pub candidate: Option<RungCandidate>,
}

/// What the operator rung holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorRung {
    /// Ryu holds an operator key for this vendor.
    pub has_key: bool,
    pub price: RungPrice,
}

/// What the Treg rung offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TregRung {
    /// Treg's catalog lists the endpoint.
    pub serves: bool,
}

/// Everything one resolution needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LadderInput {
    pub slot: CredentialSlot,
    #[serde(default)]
    pub provider: ProviderChoice,
    /// Ryu can call the endpoint itself (it knows its base URL and how the
    /// vendor's key is presented).
    pub ryu_serves: bool,
    pub team: TenantRung,
    pub org: TenantRung,
    pub operator: OperatorRung,
    /// The deployment admits documented (not yet verified) prices on the
    /// operator rung. Off by default.
    #[serde(default)]
    pub allow_documented: bool,
    pub treg: TregRung,
}

/// What happened at one rung.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RungStatus {
    /// The caller has no owner at this level.
    NotInScope,
    /// In scope, but no key is stored.
    Empty,
    /// A key is stored but is not active.
    Inactive,
    /// This rung pays for the call.
    Selected,
    /// Eligible, but a more specific rung was selected.
    Shadowed,
    /// Eligible, but a tenant rung holds a key that is not active, and the
    /// operator key never replaces a tenant's own key.
    Skipped,
    /// Ryu holds no operator key for the vendor.
    NoKey,
    /// Ryu has no price for the endpoint.
    PriceMissing,
    /// The endpoint's price or catalog entry is unverified.
    PriceUnverified,
    /// The price is documented but not verified, and the deployment does not
    /// admit documented prices.
    PriceDocumentedOnly,
    /// This rung cannot call the endpoint.
    NotServed,
    /// Ryu serves the endpoint, so Treg is not used without being named.
    RyuServes,
    /// The caller chose another provider.
    NotRequested,
}

/// One trace line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RungTrace {
    pub rung: Rung,
    pub status: RungStatus,
}

/// The decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LadderOutcome {
    Selected {
        rung: Rung,
        /// The tenant key used; absent for the operator and Treg rungs.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        credential_ref: Option<CredentialRef>,
        /// Whether Ryu meters the call. Always false on a tenant rung.
        metered: bool,
    },
    Refused {
        code: String,
    },
}

/// Outcome plus one trace line per rung, in [`RUNGS`] order (empty for an
/// invalid slot).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LadderResolution {
    pub outcome: LadderOutcome,
    pub trace: Vec<RungTrace>,
}

fn refused(code: &str) -> LadderOutcome {
    LadderOutcome::Refused {
        code: code.to_owned(),
    }
}

/// Resolve which rung pays for one vendor call. See the module docs.
pub fn resolve_tool_ladder(input: &LadderInput) -> LadderResolution {
    if input.slot.purpose != CredentialPurpose::ToolVendor || !input.slot.is_valid() {
        return LadderResolution {
            outcome: refused(REFUSED_INVALID_SLOT),
            trace: Vec::new(),
        };
    }
    let ryu_path = input.provider != ProviderChoice::Treg;
    let mut trace = Vec::with_capacity(RUNGS.len());
    let mut outcome: Option<LadderOutcome> = None;
    let mut inactive_seen = false;

    for (rung, tenant) in [(Rung::Team, &input.team), (Rung::Org, &input.org)] {
        let status = if !ryu_path {
            RungStatus::NotRequested
        } else if !input.ryu_serves {
            RungStatus::NotServed
        } else if !tenant.in_scope {
            RungStatus::NotInScope
        } else {
            match &tenant.candidate {
                None => RungStatus::Empty,
                Some(candidate) if candidate.status != CandidateStatus::Active => {
                    inactive_seen = true;
                    RungStatus::Inactive
                }
                Some(_) if outcome.is_some() => RungStatus::Shadowed,
                Some(candidate) => {
                    outcome = Some(LadderOutcome::Selected {
                        rung,
                        credential_ref: Some(candidate.credential_ref.clone()),
                        metered: false,
                    });
                    RungStatus::Selected
                }
            }
        };
        trace.push(RungTrace { rung, status });
    }

    let operator = input.operator;
    let operator_status = if !ryu_path {
        RungStatus::NotRequested
    } else if !input.ryu_serves {
        RungStatus::NotServed
    } else if !operator.has_key {
        RungStatus::NoKey
    } else {
        match operator.price {
            RungPrice::Missing => RungStatus::PriceMissing,
            RungPrice::Unverified => RungStatus::PriceUnverified,
            RungPrice::Documented if !input.allow_documented => RungStatus::PriceDocumentedOnly,
            RungPrice::Verified | RungPrice::Documented => {
                if outcome.is_some() {
                    RungStatus::Shadowed
                } else if inactive_seen {
                    RungStatus::Skipped
                } else {
                    outcome = Some(LadderOutcome::Selected {
                        rung: Rung::Operator,
                        credential_ref: None,
                        metered: true,
                    });
                    RungStatus::Selected
                }
            }
        }
    };
    trace.push(RungTrace {
        rung: Rung::Operator,
        status: operator_status,
    });

    let treg_status = match input.provider {
        ProviderChoice::Ryu => RungStatus::NotRequested,
        ProviderChoice::Any if input.ryu_serves => RungStatus::RyuServes,
        ProviderChoice::Any | ProviderChoice::Treg if !input.treg.serves => RungStatus::NotServed,
        ProviderChoice::Any | ProviderChoice::Treg => {
            outcome = Some(LadderOutcome::Selected {
                rung: Rung::Treg,
                credential_ref: None,
                metered: true,
            });
            RungStatus::Selected
        }
    };
    trace.push(RungTrace {
        rung: Rung::Treg,
        status: treg_status,
    });

    let outcome = outcome.unwrap_or_else(|| {
        if !ryu_path || !input.ryu_serves {
            refused(REFUSED_ENDPOINT_NOT_SERVED)
        } else if inactive_seen {
            refused(REFUSED_CREDENTIAL_INVALID)
        } else if operator.has_key {
            refused(REFUSED_OPERATOR_PRICE_UNVERIFIED)
        } else {
            refused(REFUSED_CREDENTIAL_REQUIRED)
        }
    });
    LadderResolution { outcome, trace }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(id: &str) -> CredentialRef {
        CredentialRef {
            id: id.to_owned(),
            version: 1,
            fingerprint: format!("fp_{id}"),
        }
    }

    fn rung(candidate: Option<(&str, CandidateStatus)>) -> TenantRung {
        TenantRung {
            in_scope: true,
            candidate: candidate.map(|(id, status)| RungCandidate {
                credential_ref: reference(id),
                status,
            }),
        }
    }

    fn input() -> LadderInput {
        LadderInput {
            slot: CredentialSlot::tool_vendor("exa"),
            provider: ProviderChoice::Any,
            ryu_serves: true,
            team: rung(None),
            org: rung(None),
            operator: OperatorRung {
                has_key: true,
                price: RungPrice::Verified,
            },
            allow_documented: false,
            treg: TregRung { serves: true },
        }
    }

    #[test]
    fn own_keys_are_never_metered() {
        let mut call = input();
        call.org = rung(Some(("org_key", CandidateStatus::Active)));
        let resolution = resolve_tool_ladder(&call);
        assert_eq!(
            resolution.outcome,
            LadderOutcome::Selected {
                rung: Rung::Org,
                credential_ref: Some(reference("org_key")),
                metered: false,
            }
        );
        assert_eq!(resolution.trace[2].status, RungStatus::Shadowed);
        assert_eq!(resolution.trace[3].status, RungStatus::RyuServes);
    }

    #[test]
    fn an_inactive_own_key_is_never_replaced_by_the_operator_key() {
        let mut call = input();
        call.team = rung(Some(("team_key", CandidateStatus::Revoked)));
        let resolution = resolve_tool_ladder(&call);
        assert_eq!(resolution.outcome, refused(REFUSED_CREDENTIAL_INVALID));
        assert_eq!(resolution.trace[2].status, RungStatus::Skipped);
    }

    #[test]
    fn a_non_tool_slot_is_refused_without_a_trace() {
        let mut call = input();
        call.slot = CredentialSlot::inference("openai");
        let resolution = resolve_tool_ladder(&call);
        assert_eq!(resolution.outcome, refused(REFUSED_INVALID_SLOT));
        assert!(resolution.trace.is_empty());
    }
}
