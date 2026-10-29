//! Builder tags and per-tag budgets (Treg parity C6).
//!
//! A caller labels a metered call with up to eight tags in the `x-ryu-tags`
//! header. Tags ride on the call's ledger row, and an organization may set a
//! budget per tag and UTC window: `block` refuses a charged call carrying the
//! tag once the window's tagged spend reached the limit (or would pass it with
//! the call's estimate), `alert` only reports itself exceeded. An untagged
//! call is never counted against a tag, and a call that charges nothing is
//! never refused by one.
//!
//! This is the Rust twin of `@ryuhq/protocol/spend-tags`; both are held to
//! `fixtures/spend-tags-cases-v1.json`. Pure: no clock, IO or secrets.

use serde::{Deserialize, Serialize};

/// Version of this contract and of its shared case file.
pub const SPEND_TAGS_CONTRACT_VERSION: u32 = 1;
/// The request header that carries a call's tags.
pub const SPEND_TAGS_HEADER: &str = "x-ryu-tags";
pub const MAX_SPEND_TAGS: usize = 8;
pub const MAX_SPEND_TAG_LEN: usize = 64;
/// A header longer than this (in UTF-16 code units, as the TypeScript twin
/// measures; equal to bytes for the ASCII a valid header holds) is refused.
pub const MAX_SPEND_TAGS_HEADER_LEN: usize = 600;

/// Why a tags header is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpendTagsProblem {
    TooLong,
    EmptyTag,
    InvalidTag,
    TooMany,
}

impl SpendTagsProblem {
    pub fn as_str(self) -> &'static str {
        match self {
            SpendTagsProblem::TooLong => "too_long",
            SpendTagsProblem::EmptyTag => "empty_tag",
            SpendTagsProblem::InvalidTag => "invalid_tag",
            SpendTagsProblem::TooMany => "too_many",
        }
    }
}

/// Whether `tag` is a valid, already-normalized tag:
/// `[a-z0-9][a-z0-9._:-]{0,63}`.
pub fn is_spend_tag(tag: &str) -> bool {
    let bytes = tag.as_bytes();
    let Some(first) = bytes.first() else {
        return false;
    };
    bytes.len() <= MAX_SPEND_TAG_LEN
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b':' | b'-')
        })
}

/// Parse an `x-ryu-tags` value: `None` or blank is no tags. Items are
/// comma-separated, trimmed and lowercased; duplicates collapse and the
/// result is sorted.
pub fn parse_spend_tags(raw: Option<&str>) -> Result<Vec<String>, SpendTagsProblem> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    if raw.encode_utf16().count() > MAX_SPEND_TAGS_HEADER_LEN {
        return Err(SpendTagsProblem::TooLong);
    }
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut tags: Vec<String> = Vec::new();
    for item in raw.split(',') {
        let tag = item.trim().to_lowercase();
        if tag.is_empty() {
            return Err(SpendTagsProblem::EmptyTag);
        }
        if !is_spend_tag(&tag) {
            return Err(SpendTagsProblem::InvalidTag);
        }
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    if tags.len() > MAX_SPEND_TAGS {
        return Err(SpendTagsProblem::TooMany);
    }
    tags.sort();
    Ok(tags)
}

/// What an exhausted budget does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TagBudgetAction {
    Block,
    Alert,
}

/// One budget a decision looks at, with the tagged spend counted before the call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagBudgetUse {
    pub action: TagBudgetAction,
    pub id: String,
    pub limit_micro_usd: u64,
    pub tag: String,
    pub used_micro_usd: u64,
    /// `daily` or `monthly`.
    pub window: String,
}

/// The decision for one charged call.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TagBudgetDecision {
    /// `alert` budgets this call reaches or passes (never refused), by id.
    pub alerts: Vec<TagBudgetUse>,
    /// The `block` budget that refuses the call.
    pub blocked: Option<TagBudgetUse>,
}

/// Whether a budget is reached by a call with this estimate (zero when the
/// price is not known before the call).
pub fn tag_budget_reached(used: u64, estimate: u64, limit: u64) -> bool {
    used >= limit || used.saturating_add(estimate) > limit
}

/// Decide one charged call against the budgets of its tags. The refusing
/// budget is the reached `block` budget with the least room left, then the
/// lowest id (byte order).
pub fn decide_tag_budgets(
    budgets: &[TagBudgetUse],
    tags: &[String],
    estimate_micro_usd: u64,
) -> TagBudgetDecision {
    let room = |budget: &TagBudgetUse| -> i128 {
        i128::from(budget.limit_micro_usd) - i128::from(budget.used_micro_usd)
    };
    let mut decision = TagBudgetDecision::default();
    for budget in budgets {
        if !tags.iter().any(|tag| tag == &budget.tag)
            || !tag_budget_reached(
                budget.used_micro_usd,
                estimate_micro_usd,
                budget.limit_micro_usd,
            )
        {
            continue;
        }
        match budget.action {
            TagBudgetAction::Alert => decision.alerts.push(budget.clone()),
            TagBudgetAction::Block => {
                let replace = decision.blocked.as_ref().is_none_or(|current| {
                    room(budget) < room(current)
                        || (room(budget) == room(current) && budget.id < current.id)
                });
                if replace {
                    decision.blocked = Some(budget.clone());
                }
            }
        }
    }
    decision
        .alerts
        .sort_by(|left, right| left.id.cmp(&right.id));
    decision
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const CASES: &str = include_str!("../fixtures/spend-tags-cases-v1.json");

    fn cases() -> Value {
        serde_json::from_str(CASES).expect("spend tags cases parse")
    }

    #[test]
    fn case_file_matches_this_contract_version() {
        assert_eq!(
            cases()["version"].as_u64(),
            Some(u64::from(SPEND_TAGS_CONTRACT_VERSION))
        );
    }

    #[test]
    fn header_cases() {
        let cases = cases();
        for case in cases["headers"].as_array().expect("headers") {
            let name = case["name"].as_str().unwrap_or_default();
            let parsed = parse_spend_tags(case["raw"].as_str());
            let expected = &case["expected"];
            match parsed {
                Ok(tags) => {
                    assert_eq!(expected["ok"], Value::Bool(true), "{name}");
                    assert_eq!(
                        serde_json::to_value(tags).unwrap(),
                        expected["tags"],
                        "{name}"
                    );
                }
                Err(problem) => {
                    assert_eq!(expected["ok"], Value::Bool(false), "{name}");
                    assert_eq!(
                        expected["problem"].as_str(),
                        Some(problem.as_str()),
                        "{name}"
                    );
                }
            }
        }
        let length = cases["longHeader"]["length"].as_u64().unwrap() as usize;
        let long = "a".repeat(length);
        assert_eq!(
            parse_spend_tags(Some(&long)).unwrap_err().as_str(),
            cases["longHeader"]["expected"]["problem"].as_str().unwrap()
        );
    }

    #[test]
    fn decision_cases() {
        let cases = cases();
        for case in cases["decisions"].as_array().expect("decisions") {
            let name = case["name"].as_str().unwrap_or_default();
            let budgets: Vec<TagBudgetUse> =
                serde_json::from_value(case["budgets"].clone()).expect(name);
            let tags: Vec<String> = serde_json::from_value(case["tags"].clone()).expect(name);
            let estimate = case["estimateMicroUsd"].as_u64().unwrap();
            let decision = decide_tag_budgets(&budgets, &tags, estimate);
            assert_eq!(
                serde_json::to_value(&decision).unwrap(),
                case["expected"],
                "{name}"
            );
        }
    }

    #[test]
    fn a_budget_never_refuses_a_call_not_tagged_with_it() {
        let budget = TagBudgetUse {
            action: TagBudgetAction::Block,
            id: "tbg_aaaaaaaa".into(),
            limit_micro_usd: 0,
            tag: "eu".into(),
            used_micro_usd: 10,
            window: "daily".into(),
        };
        let decision = decide_tag_budgets(&[budget], &["us".into()], 5);
        assert!(decision.blocked.is_none());
    }
}
