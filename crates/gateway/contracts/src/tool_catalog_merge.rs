//! Merging Ryu's and Treg's catalog rows for one listing (Treg parity B8).
//!
//! Core's Integrations Store shows both catalogs side by side: every row keeps
//! its `source` label, and Treg stays the source for anything only Treg lists.
//! Where both catalogs list the same endpoint (the same provider and endpoint
//! id, see [`same_endpoint_key`]), the [`PricePrecedence`] switch the price and
//! catalog contracts already use picks one record:
//!
//! - `ryu_verified_first` (the default): Ryu's row when Ryu verified it, else
//!   Treg's. Listing order is verified Ryu rows, then Treg rows, then Ryu rows
//!   not verified yet.
//! - `treg_first`: Treg's row when Treg lists it, else Ryu's; Treg rows first.
//! - `ryu_only` / `treg_only`: one catalog only.
//!
//! The merge only selects and orders; it never rewrites a row, so whatever is
//! shown still carries its own source, price and availability.

use crate::tool_price::{PricePrecedence, PriceSource};
use std::collections::HashMap;

/// One row offered to the merge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MergeCandidate<'a> {
    pub source: PriceSource,
    /// The cross-catalog identity of the endpoint ([`same_endpoint_key`]);
    /// `None` for a row that can never match one in the other catalog (a
    /// platform summary, for instance).
    pub same_as: Option<&'a str>,
    /// Whether the row's own catalog verified it.
    pub verified: bool,
}

/// The identity two catalogs' rows share when they describe the same
/// endpoint: the provider and endpoint id, lower-cased, with the provider's
/// punctuation and spaces removed (`"Brave Search"` and `brave-search` match).
pub fn same_endpoint_key(provider: &str, endpoint: &str) -> String {
    let provider: String = provider
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|character| character.to_ascii_lowercase())
        .collect();
    format!("{provider}:{}", endpoint.trim().to_ascii_lowercase())
}

/// Read a precedence setting (`ryu_verified_first`, `treg_first`, `ryu_only`,
/// `treg_only`); `None` for anything else.
pub fn parse_precedence(raw: &str) -> Option<PricePrecedence> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "ryu_verified_first" => Some(PricePrecedence::RyuVerifiedFirst),
        "treg_first" => Some(PricePrecedence::TregFirst),
        "ryu_only" => Some(PricePrecedence::RyuOnly),
        "treg_only" => Some(PricePrecedence::TregOnly),
        _ => None,
    }
}

fn admitted(source: PriceSource, precedence: PricePrecedence) -> bool {
    !matches!(
        (precedence, source),
        (PricePrecedence::RyuOnly, PriceSource::Treg)
            | (PricePrecedence::TregOnly, PriceSource::Ryu)
    )
}

fn rank(candidate: &MergeCandidate<'_>, precedence: PricePrecedence) -> u8 {
    match (precedence, candidate.source) {
        (PricePrecedence::RyuVerifiedFirst, PriceSource::Ryu) if candidate.verified => 0,
        (PricePrecedence::RyuVerifiedFirst, PriceSource::Treg) => 1,
        (PricePrecedence::RyuVerifiedFirst, PriceSource::Ryu) => 2,
        (PricePrecedence::TregFirst, PriceSource::Treg) => 0,
        (PricePrecedence::TregFirst, PriceSource::Ryu) => 1,
        _ => 0,
    }
}

/// The source that wins an endpoint both catalogs list.
fn winner(ryu_verified: bool, precedence: PricePrecedence) -> PriceSource {
    match precedence {
        PricePrecedence::RyuVerifiedFirst if ryu_verified => PriceSource::Ryu,
        PricePrecedence::RyuOnly => PriceSource::Ryu,
        _ => PriceSource::Treg,
    }
}

/// The indices of `candidates` to show, in display order.
pub fn merge_order(candidates: &[MergeCandidate<'_>], precedence: PricePrecedence) -> Vec<usize> {
    // Which sources list each shared endpoint, and whether Ryu verified it.
    let mut shared: HashMap<&str, (bool, bool, bool)> = HashMap::new();
    for candidate in candidates
        .iter()
        .filter(|candidate| admitted(candidate.source, precedence))
    {
        if let Some(key) = candidate.same_as {
            let entry = shared.entry(key).or_insert((false, false, false));
            match candidate.source {
                PriceSource::Ryu => {
                    entry.0 = true;
                    entry.2 |= candidate.verified;
                }
                PriceSource::Treg => entry.1 = true,
            }
        }
    }
    let mut kept: Vec<usize> = candidates
        .iter()
        .enumerate()
        .filter(|(_, candidate)| admitted(candidate.source, precedence))
        .filter(|(_, candidate)| {
            let Some(key) = candidate.same_as else {
                return true;
            };
            match shared.get(key) {
                Some(&(true, true, ryu_verified)) => {
                    candidate.source == winner(ryu_verified, precedence)
                }
                _ => true,
            }
        })
        .map(|(index, _)| index)
        .collect();
    kept.sort_by_key(|&index| (rank(&candidates[index], precedence), index));
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ryu<'a>(same_as: Option<&'a str>, verified: bool) -> MergeCandidate<'a> {
        MergeCandidate {
            source: PriceSource::Ryu,
            same_as,
            verified,
        }
    }

    fn treg(same_as: Option<&str>) -> MergeCandidate<'_> {
        MergeCandidate {
            source: PriceSource::Treg,
            same_as,
            verified: false,
        }
    }

    #[test]
    fn default_keeps_both_catalogs_and_prefers_verified_ryu_rows() {
        let rows = [
            treg(Some("brave:brave.web_search")),
            ryu(Some("brave:brave.web_search"), true),
            treg(Some("tikhub:x.user.profile")),
            ryu(Some("exa:exa.contents.text"), false),
            treg(None),
            ryu(None, true),
        ];
        // The shared Brave row is Ryu's (verified); Treg's only row stays.
        assert_eq!(
            merge_order(&rows, PricePrecedence::RyuVerifiedFirst),
            vec![1, 5, 2, 4, 3]
        );
    }

    #[test]
    fn an_unverified_ryu_row_yields_to_treg_by_default() {
        let rows = [
            ryu(Some("brave:brave.web_search"), false),
            treg(Some("brave:brave.web_search")),
        ];
        assert_eq!(
            merge_order(&rows, PricePrecedence::RyuVerifiedFirst),
            vec![1]
        );
        // With nothing from Treg, the unverified Ryu row is still listed.
        assert_eq!(
            merge_order(&rows[..1], PricePrecedence::RyuVerifiedFirst),
            vec![0]
        );
    }

    #[test]
    fn treg_first_and_single_catalog_modes() {
        let rows = [
            ryu(Some("brave:brave.web_search"), true),
            treg(Some("brave:brave.web_search")),
            ryu(Some("exa:exa.search.auto"), true),
            treg(Some("tikhub:x.user.profile")),
        ];
        assert_eq!(
            merge_order(&rows, PricePrecedence::TregFirst),
            vec![1, 3, 2]
        );
        assert_eq!(merge_order(&rows, PricePrecedence::RyuOnly), vec![0, 2]);
        assert_eq!(merge_order(&rows, PricePrecedence::TregOnly), vec![1, 3]);
    }

    #[test]
    fn endpoint_identity_ignores_case_and_provider_punctuation() {
        assert_eq!(
            same_endpoint_key("Brave Search", "Brave.Web_Search"),
            same_endpoint_key("brave-search", "brave.web_search")
        );
        assert_ne!(
            same_endpoint_key("exa", "exa.search.auto"),
            same_endpoint_key("exa", "exa.search.fast")
        );
    }

    #[test]
    fn precedence_settings() {
        assert_eq!(
            parse_precedence(" Treg_First "),
            Some(PricePrecedence::TregFirst)
        );
        assert_eq!(
            parse_precedence("ryu_verified_first"),
            Some(PricePrecedence::RyuVerifiedFirst)
        );
        assert_eq!(parse_precedence("both"), None);
    }
}
