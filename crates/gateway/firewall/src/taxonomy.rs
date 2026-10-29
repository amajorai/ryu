//! The shared safety taxonomy (managed guardrails spec 00.4), Rust reader.
//!
//! `packages/safety-taxonomy/taxonomy.json` is the single source for every code
//! id, its plain-language label, default strike weight, decay bucket, evidence
//! rule and vendor mappings. This module embeds that file with `include_str!`
//! and parses it once; the TypeScript reader in the same package imports the
//! same bytes, so the two sides can never disagree on the id set (spec SC-2).
//!
//! `hazard.S4` is a hard block that no document, policy or overlay can lower.
//! That invariant is compiled here: [`is_hard_block`] and
//! [`evidence_excerpt_allowed`] answer for S4 without reading the data.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

const TAXONOMY_JSON: &str = include_str!("../../../../packages/safety-taxonomy/taxonomy.json");

/// One taxonomy code id, such as `hazard.S9` or `security.prompt_injection`.
///
/// It wraps a `&'static str` so it is `Copy` and cheap to compare. Values come
/// from [`TaxonomyId::parse`] (checked against the file) or from the compiled
/// constants below, which a unit test checks against the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TaxonomyId(&'static str);

impl TaxonomyId {
    pub const S1: TaxonomyId = TaxonomyId("hazard.S1");
    pub const S2: TaxonomyId = TaxonomyId("hazard.S2");
    pub const S3: TaxonomyId = TaxonomyId("hazard.S3");
    pub const S4: TaxonomyId = TaxonomyId("hazard.S4");
    pub const S5: TaxonomyId = TaxonomyId("hazard.S5");
    pub const S6: TaxonomyId = TaxonomyId("hazard.S6");
    pub const S7: TaxonomyId = TaxonomyId("hazard.S7");
    pub const S8: TaxonomyId = TaxonomyId("hazard.S8");
    pub const S9: TaxonomyId = TaxonomyId("hazard.S9");
    pub const S10: TaxonomyId = TaxonomyId("hazard.S10");
    pub const S11: TaxonomyId = TaxonomyId("hazard.S11");
    pub const S12: TaxonomyId = TaxonomyId("hazard.S12");
    pub const S13: TaxonomyId = TaxonomyId("hazard.S13");
    pub const S14: TaxonomyId = TaxonomyId("hazard.S14");
    pub const PROMPT_INJECTION: TaxonomyId = TaxonomyId("security.prompt_injection");
    pub const SECRET: TaxonomyId = TaxonomyId("security.secret");
    pub const PII: TaxonomyId = TaxonomyId("security.pii");
    pub const CODE_INJECTION: TaxonomyId = TaxonomyId("security.code_injection");
    pub const TOXICITY: TaxonomyId = TaxonomyId("content.toxicity");
    pub const UPSTREAM_IDENTIFIER_BLOCKED: TaxonomyId =
        TaxonomyId("abuse.upstream_identifier_blocked");
    pub const UPSTREAM_CONTENT_REFUSED: TaxonomyId = TaxonomyId("abuse.upstream_content_refused");
    pub const UPSTREAM_ACCOUNT_WARNING: TaxonomyId = TaxonomyId("abuse.upstream_account_warning");

    /// The fourteen MLCommons hazard codes, in numeric order.
    pub const HAZARDS: [TaxonomyId; 14] = [
        Self::S1,
        Self::S2,
        Self::S3,
        Self::S4,
        Self::S5,
        Self::S6,
        Self::S7,
        Self::S8,
        Self::S9,
        Self::S10,
        Self::S11,
        Self::S12,
        Self::S13,
        Self::S14,
    ];

    /// The id for `raw` when it is a code in the taxonomy file.
    pub fn parse(raw: &str) -> Option<TaxonomyId> {
        taxonomy().codes.get(raw).map(|code| TaxonomyId(code.id))
    }

    /// The hazard id for an MLCommons short code (`S1` to `S14`).
    pub fn from_short(short: &str) -> Option<TaxonomyId> {
        let n: usize = short.strip_prefix('S')?.parse().ok()?;
        if (1..=14).contains(&n) && short == format!("S{n}") {
            Some(Self::HAZARDS[n - 1])
        } else {
            None
        }
    }

    /// The full id string, for example `hazard.S9`.
    pub const fn as_str(self) -> &'static str {
        self.0
    }

    /// The MLCommons short code (`S9`) for a hazard id, or `None` for other branches.
    pub fn short(self) -> Option<&'static str> {
        self.0.strip_prefix("hazard.")
    }

    /// The branch prefix: `hazard`, `security`, `content` or `abuse`.
    pub fn branch(self) -> &'static str {
        self.0.split_once('.').map_or(self.0, |(branch, _)| branch)
    }
}

impl std::fmt::Display for TaxonomyId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

/// How evidence for a code may be kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceRule {
    /// Never as text: a keyed hash only (S4).
    HashOnly,
    RedactedExcerpt,
}

/// Strike decay bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decay {
    Fast,
    Slow,
    Permanent,
}

/// One code row of the taxonomy file.
#[derive(Debug, Clone)]
pub struct TaxonomyCode {
    pub id: &'static str,
    pub short: Option<&'static str>,
    pub label: &'static str,
    pub branch: &'static str,
    pub strike_weight: f64,
    pub decay: Option<Decay>,
    pub hard_block: bool,
    pub tenant_configurable: bool,
    pub evidence: EvidenceRule,
}

/// The parsed taxonomy document.
#[derive(Debug)]
pub struct Taxonomy {
    pub version: u32,
    /// Codes in file order.
    pub ordered: Vec<TaxonomyId>,
    codes: BTreeMap<&'static str, TaxonomyCode>,
    /// vendor -> label -> codes.
    vendor_mappings: BTreeMap<&'static str, BTreeMap<&'static str, Vec<TaxonomyId>>>,
}

impl Taxonomy {
    pub fn code(&self, id: TaxonomyId) -> Option<&TaxonomyCode> {
        self.codes.get(id.as_str())
    }

    /// The codes a vendor label maps to, or `None` for an unknown vendor or label.
    pub fn vendor_codes(&self, vendor: &str, label: &str) -> Option<&[TaxonomyId]> {
        self.vendor_mappings
            .get(vendor)?
            .get(label)
            .map(Vec::as_slice)
    }

    /// Every label of one vendor's mapping, with its codes.
    pub fn vendor_mapping(
        &self,
        vendor: &str,
    ) -> Option<impl Iterator<Item = (&'static str, &[TaxonomyId])>> {
        self.vendor_mappings.get(vendor).map(|labels| {
            labels
                .iter()
                .map(|(label, codes)| (*label, codes.as_slice()))
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCode {
    id: String,
    #[serde(default)]
    short: Option<String>,
    label: String,
    branch: String,
    strike_weight: f64,
    #[serde(default)]
    decay: Option<Decay>,
    #[serde(default)]
    hard_block: bool,
    #[serde(default)]
    tenant_configurable: bool,
    evidence: EvidenceRule,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTaxonomy {
    version: u32,
    codes: Vec<RawCode>,
    #[serde(default)]
    vendor_mappings: BTreeMap<String, BTreeMap<String, Vec<String>>>,
}

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn build(raw: &str) -> Result<Taxonomy, String> {
    let doc: RawTaxonomy =
        serde_json::from_str(raw).map_err(|e| format!("taxonomy.json does not parse: {e}"))?;
    let mut codes = BTreeMap::new();
    let mut ordered = Vec::with_capacity(doc.codes.len());
    for code in doc.codes {
        let id = leak(code.id);
        if !id.starts_with(&format!("{}.", code.branch)) {
            return Err(format!("code {id} is not under its branch {}", code.branch));
        }
        let row = TaxonomyCode {
            id,
            short: code.short.map(leak),
            label: leak(code.label),
            branch: leak(code.branch),
            strike_weight: code.strike_weight,
            decay: code.decay,
            hard_block: code.hard_block,
            tenant_configurable: code.tenant_configurable,
            evidence: code.evidence,
        };
        if codes.insert(id, row).is_some() {
            return Err(format!("duplicate code {id}"));
        }
        ordered.push(TaxonomyId(id));
    }
    let mut vendor_mappings = BTreeMap::new();
    for (vendor, labels) in doc.vendor_mappings {
        let mut mapped = BTreeMap::new();
        for (label, targets) in labels {
            let mut ids = Vec::with_capacity(targets.len());
            for target in targets {
                let Some(code) = codes.get(target.as_str()) else {
                    return Err(format!("{vendor}/{label} maps to unknown code {target}"));
                };
                ids.push(TaxonomyId(code.id));
            }
            if ids.is_empty() {
                return Err(format!("{vendor}/{label} maps to no code"));
            }
            mapped.insert(leak(label), ids);
        }
        vendor_mappings.insert(leak(vendor), mapped);
    }
    Ok(Taxonomy {
        version: doc.version,
        ordered,
        codes,
        vendor_mappings,
    })
}

/// The taxonomy embedded at compile time. Panics only if the committed file is
/// invalid, which the unit tests below catch before release.
pub fn taxonomy() -> &'static Taxonomy {
    static TAXONOMY: OnceLock<Taxonomy> = OnceLock::new();
    TAXONOMY.get_or_init(|| build(TAXONOMY_JSON).expect("embedded taxonomy.json is valid"))
}

/// Whether a code is a hard block. S4 always is, whatever the file says.
pub fn is_hard_block(id: TaxonomyId) -> bool {
    id == TaxonomyId::S4 || taxonomy().code(id).is_some_and(|code| code.hard_block)
}

/// Whether an excerpt may be stored for this code. Never for S4, whatever the
/// file says.
pub fn evidence_excerpt_allowed(id: TaxonomyId) -> bool {
    id != TaxonomyId::S4
        && taxonomy()
            .code(id)
            .is_some_and(|code| code.evidence == EvidenceRule::RedactedExcerpt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_file_parses() {
        let t = taxonomy();
        assert_eq!(t.version, 1);
        assert!(!t.ordered.is_empty());
    }

    #[test]
    fn compiled_constants_exist_in_the_file() {
        let consts = [
            TaxonomyId::PROMPT_INJECTION,
            TaxonomyId::SECRET,
            TaxonomyId::PII,
            TaxonomyId::CODE_INJECTION,
            TaxonomyId::TOXICITY,
            TaxonomyId::UPSTREAM_IDENTIFIER_BLOCKED,
            TaxonomyId::UPSTREAM_CONTENT_REFUSED,
            TaxonomyId::UPSTREAM_ACCOUNT_WARNING,
        ];
        for id in TaxonomyId::HAZARDS.iter().chain(consts.iter()) {
            assert_eq!(TaxonomyId::parse(id.as_str()), Some(*id), "{id}");
        }
    }

    /// Spec SC-2: the id set matches the spec 00.4 branches exactly. The
    /// TypeScript reader in `packages/safety-taxonomy` loads the same file.
    #[test]
    fn id_set_matches_spec_branches() {
        let ids: Vec<&str> = taxonomy().ordered.iter().map(|id| id.as_str()).collect();
        let mut expected: Vec<String> = (1..=14).map(|n| format!("hazard.S{n}")).collect();
        for id in [
            "security.prompt_injection",
            "security.secret",
            "security.pii",
            "security.code_injection",
            "content.toxicity",
            "content.bias",
            "content.sensitive_image",
            "content.custom_pattern",
            "content.custom_policy",
            "abuse.platform",
            "abuse.velocity",
            "abuse.upstream_identifier_blocked",
            "abuse.upstream_content_refused",
            "abuse.upstream_account_warning",
            "abuse.ban_evasion",
            "abuse.local_upstream_block",
            "abuse.identifier_cardinality",
        ] {
            expected.push(id.to_string());
        }
        assert_eq!(ids, expected);
    }

    #[test]
    fn s4_is_a_hard_block_with_hash_only_evidence() {
        let s4 = taxonomy().code(TaxonomyId::S4).unwrap();
        assert!(s4.hard_block);
        assert!(!s4.tenant_configurable);
        assert_eq!(s4.evidence, EvidenceRule::HashOnly);
        assert!(is_hard_block(TaxonomyId::S4));
        assert!(!evidence_excerpt_allowed(TaxonomyId::S4));
        assert!(!is_hard_block(TaxonomyId::S9));
        assert!(evidence_excerpt_allowed(TaxonomyId::S9));
    }

    #[test]
    fn short_codes_round_trip() {
        for (n, id) in TaxonomyId::HAZARDS.iter().enumerate() {
            let short = format!("S{}", n + 1);
            assert_eq!(TaxonomyId::from_short(&short), Some(*id));
            assert_eq!(id.short(), Some(short.as_str()));
            assert_eq!(taxonomy().code(*id).unwrap().short, Some(short.as_str()));
        }
        for bad in ["S0", "S15", "S01", "s1", "S", "X1", "S1 "] {
            assert_eq!(TaxonomyId::from_short(bad), None, "{bad}");
        }
        assert_eq!(TaxonomyId::PII.short(), None);
        assert_eq!(TaxonomyId::PII.branch(), "security");
    }

    #[test]
    fn vendor_mappings_cover_every_dialect() {
        let t = taxonomy();
        for vendor in [
            "llama_guard",
            "qwen3guard",
            "shieldgemma",
            "openai_moderation",
            "inspector",
        ] {
            assert!(t.vendor_mapping(vendor).is_some(), "{vendor}");
        }
        for n in 1..=14 {
            let short = format!("S{n}");
            assert_eq!(
                t.vendor_codes("llama_guard", &short),
                Some(&[TaxonomyId::from_short(&short).unwrap()][..])
            );
        }
        assert_eq!(
            t.vendor_codes("openai_moderation", "sexual/minors"),
            Some(&[TaxonomyId::S4][..])
        );
        assert_eq!(
            t.vendor_codes("qwen3guard", "Jailbreak"),
            Some(&[TaxonomyId::PROMPT_INJECTION][..])
        );
        // Spec 02.6.2: Qwen3Guard has no child-specific category, so no label
        // of its mapping may reach S4.
        let qwen = t.vendor_mapping("qwen3guard").unwrap();
        for (label, codes) in qwen {
            assert!(!codes.contains(&TaxonomyId::S4), "{label}");
        }
        assert_eq!(t.vendor_codes("qwen3guard", "Unknown label"), None);
    }

    #[test]
    fn rejects_mappings_to_unknown_codes() {
        let raw = r#"{"version":1,"codes":[{"id":"hazard.S1","short":"S1","label":"x","branch":"hazard","strikeWeight":1,"evidence":"redacted_excerpt"}],
            "vendorMappings":{"v":{"a":["hazard.S99"]}}}"#;
        assert!(build(raw).is_err());
        let empty = r#"{"version":1,"codes":[{"id":"hazard.S1","short":"S1","label":"x","branch":"hazard","strikeWeight":1,"evidence":"redacted_excerpt"}],
            "vendorMappings":{"v":{"a":[]}}}"#;
        assert!(build(empty).is_err());
    }

    #[test]
    fn data_file_carries_no_test_sentinel() {
        assert!(!TAXONOMY_JSON.contains("RYU_TEST"));
    }
}
