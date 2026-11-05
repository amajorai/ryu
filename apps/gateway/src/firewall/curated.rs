//! The curated pattern sets shared by every [`super::FirewallScanner`].

use regex::{Regex, RegexSet, RegexSetBuilder};
use ryu_gw_firewall::{
    build_bias_patterns, build_code_injection_patterns, build_injection_patterns,
    build_outbound_patterns_with_twins, build_pii_patterns_with_twins, build_secret_patterns,
    build_toxicity_patterns, Twinned,
};

/// The curated pattern sets, which are the same for every scanner. A scanner
/// built for a request that carries a node firewall overlay is never cached
/// (see `resolve::FirewallResolver::scanner_for_request`), so compiling these
/// per scanner recompiled every curated regex on each such request. Cloning a
/// compiled `Regex` shares its program instead of recompiling it.
pub(super) struct CuratedPatterns {
    pub(super) pii: Vec<(String, Regex)>,
    pub(super) secret: Vec<(String, Regex)>,
    pub(super) injection: Vec<(String, Regex)>,
    pub(super) outbound: Vec<(&'static str, Regex)>,
    pub(super) code_injection: Vec<(String, Regex)>,
    pub(super) toxicity: Vec<(String, Regex)>,
    pub(super) bias: Vec<(String, Regex)>,
    /// The ASCII-boundary twin of each `pii` entry, in the same order (see
    /// [`ryu_gw_firewall::Twinned`]). Only `sanitize` uses them.
    pub(super) pii_twins: Vec<Option<Regex>>,
    /// The ASCII-boundary twin of each `outbound` entry, in the same order.
    /// Only `redact_outbound` uses them.
    pub(super) outbound_twins: Vec<Option<Regex>>,
    /// Every `secret` then every `pii` pattern as one set. A set member
    /// matches exactly where its `Regex` does, so a miss on ASCII text (whose
    /// scan hay is the text itself) means `scan_outbound` finds nothing.
    pub(super) outbound_scan: Option<RegexSet>,
    /// Every `secret` pattern as one set, for the hays of non-ASCII text.
    pub(super) secret_set: Option<RegexSet>,
    /// Each `outbound` pattern as `redact_outbound` runs it on text that
    /// passes `ascii_boundaries_agree` before any rewrite: its twin when it
    /// has one, else the original, in the same order.
    pub(super) outbound_agree: Option<RegexSet>,
}

impl CuratedPatterns {
    /// `(outbound_scan, secret_set)` for a scanner whose lists have these
    /// lengths. Custom patterns follow the curated prefix, so an equal length
    /// means the list is exactly the curated one a set was built from.
    pub(super) fn sets(&self, secret: usize, pii: usize) -> (Option<&RegexSet>, Option<&RegexSet>) {
        let secret = secret == self.secret.len();
        let pii = pii == self.pii.len();
        let scan = self.outbound_scan.as_ref().filter(|_| secret && pii);
        (scan, self.secret_set.as_ref().filter(|_| secret))
    }
}

/// One set of `patterns`, or `None` when it does not compile (the callers
/// then run every pattern, as they did before the sets existed).
fn set_of<'a>(patterns: impl IntoIterator<Item = &'a Regex>) -> Option<RegexSet> {
    RegexSetBuilder::new(patterns.into_iter().map(Regex::as_str))
        .size_limit(64 << 20)
        .build()
        .ok()
}

/// Split twinned patterns into the `(name, regex)` set and its twins.
fn untwin<N>(set: Vec<Twinned<N>>) -> (Vec<(N, Regex)>, Vec<Option<Regex>>) {
    set.into_iter()
        .map(|(name, re, twin)| ((name, re), twin))
        .unzip()
}

pub(super) fn curated_patterns() -> &'static CuratedPatterns {
    static CURATED: std::sync::OnceLock<CuratedPatterns> = std::sync::OnceLock::new();
    CURATED.get_or_init(|| {
        let (pii, pii_twins) = untwin(build_pii_patterns_with_twins());
        let (outbound, outbound_twins) = untwin(build_outbound_patterns_with_twins());
        let secret = build_secret_patterns();
        let outbound_scan = set_of(secret.iter().chain(&pii).map(|(_, re)| re));
        let secret_set = set_of(secret.iter().map(|(_, re)| re));
        let agree = outbound.iter().zip(&outbound_twins);
        let outbound_agree = set_of(agree.map(|((_, re), twin)| twin.as_ref().unwrap_or(re)));
        CuratedPatterns {
            pii,
            secret,
            injection: build_injection_patterns(),
            outbound,
            code_injection: build_code_injection_patterns(),
            toxicity: build_toxicity_patterns(),
            bias: build_bias_patterns(),
            pii_twins,
            outbound_twins,
            outbound_scan,
            secret_set,
            outbound_agree,
        }
    })
}
